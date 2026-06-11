import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import {
	BAR_DECORATION_PATTERN,
	BOX_DECORATION_PATTERN,
	parseProviderUsage,
	stripTerminalOutput
} from './parser';
import { writeCollectorDebugSnapshot } from './debug-files';
import {
	CLI_COLLECTION_CONFIG,
	PROVIDERS,
	providerWorkingDirectories,
	type ProviderId,
	type ProviderUsage
} from '$lib/usage';

type PtyModule = typeof import('node-pty');
export type CollectionBackend = 'pty' | 'pipe';

const USAGE_OUTPUT_SETTLE_MS = 1200;
const MAX_CAPTURE_CHARS = 20_000;
const MAX_COLLECTION_ATTEMPTS = 5;
const SHELL_READY_POLL_MS = 500;
// Safety net: if the shell prompt is never detected as ready (e.g. an unforeseen prompt
// format change), force-write the CLI command anyway rather than wedging the whole capture.
const SHELL_READY_FORCE_WRITE_MS = 8000;
const STANDARD_RETRY_DELAY_MS = 1500;
const PATIENT_RETRY_DELAY_MS = 5000;
const FINAL_RETRY_DELAY_MS = 10_000;
const DEBUG_COLLECTOR_LOGS = process.env.AI_USAGE_DEBUG_LOGS === '1';
const CODEX_STATUS_REFRESH_RETRY_DELAY_MS = 6000;
const MAX_CODEX_STATUS_REFRESH_RETRIES = 2;
const CODEX_SLASH_CONFIRM_INTERVAL_MS = 2000;
const CODEX_SLASH_CONFIRM_TIMEOUT_BUFFER_MS = 10_000;
const TERMINAL_INPUT_CLEAR = '\u0001\u000b';
const TERMINAL_INPUT_CLEAR_SETTLE_MS = 80;
const CLAUDE_TRUST_PROMPT_SETTLE_MS = 1200;
const CLAUDE_FINAL_REPAINT_QUIET_MS = 1500;
const CLAUDE_FINAL_REPAINT_FALLBACK_MS = 3000;
const CLAUDE_USAGE_MIN_INTERVAL_MS = 50_000;
const SLASH_REISSUE_DELAY_MS = 5000;
const MAX_SLASH_REISSUES = 3;
const CODEX_UPDATE_SKIP_OPTION = '2';
const TERMINAL_GRACEFUL_CLOSE_MS = 5000;
const USE_PIPE_COLLECTION = process.env.AI_USAGE_USE_PIPE === '1';
const PERSISTENT_SESSION_DISABLED = process.env.AI_USAGE_DISABLE_PERSISTENT_SESSION === '1';
const PERSISTENT_SESSION_START_TIMEOUT_MS = 60_000;
const PERSISTENT_SESSION_POLL_MS = 250;
const PERSISTENT_REQUEST_RESET_DELAY_MS = 300;
// A live CLI echoes the typed slash command almost immediately; a reused session that
// stays completely silent is wedged (Claude hangs when /usage idles open), so fail fast
// and let the retry loop respawn it instead of burning the full capture timeout.
const PERSISTENT_NO_OUTPUT_FAIL_MS = 10_000;
// Esc: closes a provider usage panel without other side effects at the main prompt.
const PERSISTENT_PANEL_CLOSE = String.fromCharCode(27);
const GEMINI_BAR_RUN_PATTERN = /[▬━─═╌╍▔▁▂▃▄▅▆▇█▏▎▍▌▋▊▉▐░▒▓■□▱▰▯▮▭]{3,}/;
const GEMINI_USAGE_ROW_LABEL_PATTERN =
	/^(?:Gemini|Claude|GPT-OSS|Flash(?:\s+Lite)?|Pro|gemini-[A-Za-z0-9._\-…]+)\b/i;
const GEMINI_SLASH_CONFIRM_INTERVAL_MS = 2000;
const GEMINI_SLASH_CONFIRM_TIMEOUT_BUFFER_MS = 10_000;

export async function collectAllUsage(
	onProviderResult?: (provider: ProviderUsage) => void | Promise<void>,
	options: { backend?: CollectionBackend } = {}
): Promise<ProviderUsage[]> {
	return await Promise.all(
		PROVIDERS.map(async (provider) => {
			const result = await collectProvider(provider.id, options);
			await onProviderResult?.(result);
			return result;
		})
	);
}

async function collectProvider(
	providerId: ProviderId,
	options: { backend?: CollectionBackend } = {}
): Promise<ProviderUsage> {
	const provider = PROVIDERS.find((item) => item.id === providerId);
	if (!provider) {
		throw new Error(`Unknown provider: ${providerId}`);
	}

	const startedAt = performance.now();
	let latestResult: ProviderUsage | null = null;
	let hadReportableFailure = false;
	let transientStartupMisses = 0;
	let workingDirectoryIndex = 0;
	const workingDirectories = providerWorkingDirectories(provider.id);

	for (let attempt = 1; attempt <= MAX_COLLECTION_ATTEMPTS; attempt += 1) {
		let output = '';
		const workingDirectory =
			workingDirectories[Math.min(workingDirectoryIndex, workingDirectories.length - 1)];
		try {
			output = await runSlashCommand(
				provider.id,
				provider.command,
				provider.slashCommand,
				attempt,
				workingDirectory,
				options
			);
			latestResult = parseProviderUsage(provider.id, output);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown collection error';
			latestResult = parseProviderUsage(provider.id, '', message);
		}

		let diagnostics = buildCollectionDiagnostics(provider.id, output, latestResult);
		if (isPendingProviderRefresh(provider.id, diagnostics)) {
			latestResult = {
				...latestResult,
				status: 'partial',
				message: 'Codex limits may be stale; /status should be retried.'
			};
			diagnostics = buildCollectionDiagnostics(provider.id, output, latestResult);
		}
		const transientStartupMiss = isTransientStartupMiss(provider.id, diagnostics);
		await writeCollectorDebugSnapshot(provider.id, output, latestResult, {
			attempt,
			maxAttempts: MAX_COLLECTION_ATTEMPTS,
			workingDirectory,
			workingDirectoryCandidates: [...workingDirectories],
			phase: diagnostics.phase,
			markers: diagnostics.markers,
			parseDiagnostics: diagnostics.parseDetails,
			writeFailureCopy:
				latestResult.status !== 'ok' &&
				(!transientStartupMiss || attempt === MAX_COLLECTION_ATTEMPTS)
		}).catch(() => undefined);

		if (latestResult.status === 'ok') {
			if (attempt > 1 && hadReportableFailure) {
				console.info(
					`[collector] ${provider.name} recovered on attempt ${attempt}/${MAX_COLLECTION_ATTEMPTS} in ${formatDuration(performance.now() - startedAt)}.`
				);
			} else if (attempt > 1 && transientStartupMisses > 0 && DEBUG_COLLECTOR_LOGS) {
				console.info(
					`[collector] ${provider.name} completed after ${transientStartupMisses} startup redraw retry in ${formatDuration(performance.now() - startedAt)}.`
				);
			}
			return withCollectionDuration(latestResult, startedAt);
		}

		const details = describeCollectionResult(diagnostics);
		const shouldTryNextWorkingDirectory =
			workingDirectoryIndex < workingDirectories.length - 1 &&
			shouldAdvanceWorkingDirectory(provider.id, diagnostics);

		if (attempt < MAX_COLLECTION_ATTEMPTS) {
			const retryDelayMs = collectionRetryDelayMs(attempt);
			const nextWorkingDirectory = shouldTryNextWorkingDirectory
				? workingDirectories[workingDirectoryIndex + 1]
				: null;
			if (nextWorkingDirectory) {
				workingDirectoryIndex += 1;
			}
			if (transientStartupMiss) {
				transientStartupMisses += 1;
				if (DEBUG_COLLECTOR_LOGS) {
					console.info(
						`[collector] ${provider.name} startup redraw only on attempt ${attempt}/${MAX_COLLECTION_ATTEMPTS}; retrying in ${formatDuration(retryDelayMs)}${formatWorkingDirectorySwitch(nextWorkingDirectory)}. ${details}`
					);
				}
			} else {
				hadReportableFailure = true;
				console.info(
					`[collector] ${provider.name} attempt ${attempt}/${MAX_COLLECTION_ATTEMPTS}: ${latestResult.status} - ${latestResult.message}; retrying in ${formatDuration(retryDelayMs)}${formatWorkingDirectorySwitch(nextWorkingDirectory)}. ${details}`
				);
			}
			await delay(retryDelayMs);
		} else {
			console.warn(
				`[collector] ${provider.name} attempt ${attempt}/${MAX_COLLECTION_ATTEMPTS}: ${latestResult.status} - ${latestResult.message}. ${details}`
			);
			const truncatedOutput = output.length > 1000 ? `... ${output.slice(-1000)}` : output;
			console.warn(
				`[collector-error-diagnostics] ${provider.name} raw output tail (length=${output.length}):\n${truncatedOutput}\n[collector-error-diagnostics] Diagnostics details: phase=${diagnostics.phase}, markers=${diagnostics.markers.join(',')}`
			);
		}
	}

	latestResult ??= parseProviderUsage(provider.id, '', 'Collection did not run.');
	return withCollectionDuration(latestResult, startedAt);
}

function withCollectionDuration(provider: ProviderUsage, startedAt: number): ProviderUsage {
	return {
		...provider,
		collectionDurationMs: Math.round(performance.now() - startedAt)
	};
}

async function runSlashCommand(
	providerId: ProviderId,
	command: string,
	slashCommand: string,
	attempt: number,
	workingDirectory: string,
	options: { backend?: CollectionBackend } = {}
) {
	await ensureWorkingDirectory(workingDirectory);
	if (USE_PIPE_COLLECTION || options.backend === 'pipe') {
		await waitForProviderCommandInterval(providerId);
		return await runPipeSlashCommand(providerId, command, slashCommand, attempt, workingDirectory);
	}

	if (!PERSISTENT_SESSION_DISABLED && options.backend !== 'pty') {
		try {
			await waitForProviderCommandInterval(providerId);
			return await runPersistentSlashCommand(
				providerId,
				command,
				slashCommand,
				attempt,
				workingDirectory
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Persistent session error';
			console.info(
				`[collector] ${providerId} persistent session failed; falling back to per-spawn PTY. ${message}`
			);
		}
	}

	try {
		await waitForProviderCommandInterval(providerId);
		return await runPtySlashCommand(providerId, command, slashCommand, attempt, workingDirectory);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown node-pty error';
		console.info(
			`[collector] ${providerId} node-pty path failed; trying pipe fallback. ${message}`
		);
		await waitForProviderCommandInterval(providerId);
		return await runPipeSlashCommand(providerId, command, slashCommand, attempt, workingDirectory);
	}
}

type ProviderCommandIntervalGlobal = typeof globalThis & {
	__aiUsageLastClaudeUsageAt?: number;
};

async function waitForProviderCommandInterval(providerId: ProviderId) {
	if (providerId !== 'claude') return;

	const holder = globalThis as ProviderCommandIntervalGlobal;
	const lastUsageAt = holder.__aiUsageLastClaudeUsageAt ?? 0;
	const waitMs = Math.max(0, lastUsageAt + CLAUDE_USAGE_MIN_INTERVAL_MS - Date.now());
	if (waitMs > 0) {
		if (DEBUG_COLLECTOR_LOGS) {
			console.info(
				`[collector] Claude /usage rate limit: waiting ${formatDuration(waitMs)} before the next request.`
			);
		}
		await delay(waitMs);
	}
}

function markProviderCommandSent(providerId: ProviderId) {
	if (providerId !== 'claude') return;
	const holder = globalThis as ProviderCommandIntervalGlobal;
	holder.__aiUsageLastClaudeUsageAt = Date.now();
}

async function ensureWorkingDirectory(workingDirectory: string) {
	await mkdir(workingDirectory, { recursive: true });
}

async function runPtySlashCommand(
	providerId: ProviderId,
	command: string,
	slashCommand: string,
	attempt: number,
	workingDirectory: string
) {
	const pty = (await import('node-pty')) as PtyModule;

	return await new Promise<string>((resolve, reject) => {
		let output = '';
		let settled = false;
		let wroteCommand = false;
		let wroteSlashCommand = false;
		let codexStatusRefreshRetryCount = 0;
		let slashReissueCount = 0;
		let codexUpdatePromptSkipped = false;
		let terminalExited = false;
		let terminalClosing = false;
		let slashReadyTimer: NodeJS.Timeout | undefined;
		let usageSettleTimer: NodeJS.Timeout | undefined;
		let claudeFinalRepaintTimer: NodeJS.Timeout | undefined;
		let claudeFinalRepaintDone = false;
		let codexStatusRefreshRetryTimer: NodeJS.Timeout | undefined;
		let slashReissueTimer: NodeJS.Timeout | undefined;
		let claudeTrustPromptTimer: NodeJS.Timeout | undefined;
		const timers = new Set<NodeJS.Timeout>();

		const schedule = (callback: () => void, ms: number) => {
			const timer = setTimeout(() => {
				timers.delete(timer);
				callback();
			}, ms);
			timers.add(timer);
			return timer;
		};

		const clearScheduledTimers = () => {
			for (const timer of timers) {
				clearTimeout(timer);
			}
			timers.clear();
		};

		const cancelTimer = (timer: NodeJS.Timeout | undefined) => {
			if (!timer) return undefined;
			clearTimeout(timer);
			timers.delete(timer);
			return undefined;
		};

		const terminal = pty.spawn(
			CLI_COLLECTION_CONFIG.shell.command,
			[...CLI_COLLECTION_CONFIG.shell.args],
			{
				name: 'xterm-256color',
				cols: providerId === 'agy' ? 160 : 120,
				rows: providerId === 'agy' ? 64 : 36,
				cwd: workingDirectory,
				env: { ...process.env, ...CLI_COLLECTION_CONFIG.env },
				useConpty: process.env.AI_USAGE_USE_CONPTY !== '0',
				useConptyDll: process.env.AI_USAGE_USE_CONPTY_DLL === '1'
			}
		);

		const cleanup = (options: { killTerminal?: boolean } = {}) => {
			clearScheduledTimers();
			if (options.killTerminal === false || terminalExited) return;
			try {
				terminal.kill();
			} catch {
				// The process may already be closed.
			}
		};

		const finish = (value: string, options: { killTerminal?: boolean } = {}) => {
			if (settled) return;
			settled = true;
			cleanup(options);
			resolve(value);
		};

		const fail = (message: string) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(new Error(message));
		};

		const bestEffortWrite = (value: string) => {
			if (settled || terminalExited) return;
			try {
				terminal.write(value);
			} catch {
				// The PTY may already be closing.
			}
		};

		const finishAfterTerminalClose = (value: string) => {
			if (settled) return;
			if (terminalClosing) return;
			terminalClosing = true;
			clearScheduledTimers();
			bestEffortWrite('\u0003');
			schedule(() => bestEffortWrite('exit\r'), 250);
			schedule(() => bestEffortWrite('exit\r'), 1000);
			schedule(() => finish(value), TERMINAL_GRACEFUL_CLOSE_MS);
		};

		const safeWrite = (value: string, failureMessage: string) => {
			if (settled) return;
			try {
				terminal.write(value);
			} catch (error) {
				fail(error instanceof Error ? error.message : failureMessage);
			}
		};

		const forceClaudeFinalRepaint = () => {
			if (settled || terminalExited || providerId !== 'claude') return;
			claudeFinalRepaintTimer = undefined;
			claudeFinalRepaintDone = true;
			try {
				const { cols, rows } = terminal;
				terminal.resize(cols, rows - 1);
				terminal.resize(cols, rows);
			} catch {
				// The PTY may already be closing.
			}
			usageSettleTimer = schedule(
				() => finishAfterTerminalClose(output),
				CLAUDE_FINAL_REPAINT_FALLBACK_MS
			);
		};

		const writeCommand = () => {
			if (wroteCommand) return;
			wroteCommand = true;
			safeWrite(`${command}\r`, 'Failed to write CLI command.');
		};

		const shellReadyDeadline = performance.now() + SHELL_READY_FORCE_WRITE_MS;
		const writeCommandWhenShellReady = () => {
			if (wroteCommand) return;
			if (!isShellReady(output) && performance.now() < shellReadyDeadline) {
				schedule(writeCommandWhenShellReady, SHELL_READY_POLL_MS);
				return;
			}
			schedule(writeCommand, CLI_COLLECTION_CONFIG.shellCommandDelayMs);
		};

		const writeSlashCommand = () => {
			if (wroteSlashCommand) return;
			wroteSlashCommand = true;
			writeSlashCommandNow({ clearInput: providerId === 'codex' });
		};

		const writeSlashCommandNow = (options: { clearInput?: boolean } = {}) => {
			const writeSlashCommandInput = () => {
				markProviderCommandSent(providerId);
				safeWrite(`${slashCommand}\r`, 'Failed to write slash command.');
			};

			if (options.clearInput) {
				safeWrite(TERMINAL_INPUT_CLEAR, 'Failed to clear slash command input.');
				schedule(writeSlashCommandInput, TERMINAL_INPUT_CLEAR_SETTLE_MS);
			} else {
				writeSlashCommandInput();
			}

			if (providerId === 'codex') {
				const startedAt = performance.now();
				const confirmUntilMs = Math.max(
					10_000,
					captureTimeoutMs(providerId, attempt) - CODEX_SLASH_CONFIRM_TIMEOUT_BUFFER_MS
				);

				const confirmSlashCommand = () => {
					if (settled || hasUsageOutput(providerId, output)) return;
					const shouldConfirm = shouldConfirmCodexSlashCommand(output, slashCommand);
					if (shouldConfirm) {
						safeWrite('\r', 'Failed to confirm slash command.');
					}
					if (performance.now() - startedAt < confirmUntilMs && shouldConfirm) {
						schedule(confirmSlashCommand, CODEX_SLASH_CONFIRM_INTERVAL_MS);
					}
				};

				schedule(confirmSlashCommand, 800);
			}
			if (providerId === 'agy') {
				const startedAt = performance.now();
				const confirmUntilMs = Math.max(
					10_000,
					captureTimeoutMs(providerId, attempt) - GEMINI_SLASH_CONFIRM_TIMEOUT_BUFFER_MS
				);

				const confirmSlashCommand = () => {
					if (settled) return;
					if (shouldConfirmGeminiSlashCommand(output, slashCommand)) {
						safeWrite('\r', 'Failed to confirm slash command.');
					}
					if (performance.now() - startedAt < confirmUntilMs && !hasGeminiModelScreen(output)) {
						schedule(confirmSlashCommand, GEMINI_SLASH_CONFIRM_INTERVAL_MS);
					}
				};

				schedule(confirmSlashCommand, 800);
			}
		};

		const writeSlashCommandFallback = () => {
			if (wroteSlashCommand) return;
			if (!wroteCommand) {
				schedule(writeSlashCommandFallback, 1000);
				return;
			}
			if (providerId === 'codex' && shouldWaitForCodexReady(output)) {
				schedule(writeSlashCommandFallback, 1000);
				return;
			}
			if (providerId === 'claude' && shouldWaitForClaudeReady(output)) {
				schedule(writeSlashCommandFallback, 1000);
				return;
			}
			if (providerId === 'agy' && shouldWaitForGeminiReady(output)) {
				schedule(writeSlashCommandFallback, 1000);
				return;
			}
			writeSlashCommand();
		};

		const retryCodexStatusAfterRefresh = () => {
			if (settled || providerId !== 'codex') return;
			if (!wroteSlashCommand) return;
			const statusRefreshRequested = hasCodexStatusRefreshRequested(output);
			if (hasUsageOutput(providerId, output) && !statusRefreshRequested) return;
			if (!statusRefreshRequested) return;
			if (codexStatusRefreshRetryTimer) return;
			if (codexStatusRefreshRetryCount >= MAX_CODEX_STATUS_REFRESH_RETRIES) return;

			codexStatusRefreshRetryTimer = schedule(() => {
				codexStatusRefreshRetryTimer = undefined;
				if (settled || hasUsageOutput(providerId, output)) return;
				if (!hasCodexStatusRefreshRequested(output)) return;
				codexStatusRefreshRetryCount += 1;
				writeSlashCommandNow({ clearInput: true });
			}, CODEX_STATUS_REFRESH_RETRY_DELAY_MS);
		};

		const reissueSlashCommandIfLost = () => {
			if (settled || !wroteSlashCommand || hasUsageOutput(providerId, output)) return;
			if (providerId === 'claude') return;
			if (slashReissueTimer) return;
			if (slashReissueCount >= MAX_SLASH_REISSUES) return;
			if (!shouldReissueSlashCommand(providerId, output, slashCommand)) return;

			slashReissueTimer = schedule(() => {
				slashReissueTimer = undefined;
				if (settled || hasUsageOutput(providerId, output)) return;
				if (!shouldReissueSlashCommand(providerId, output, slashCommand)) return;

				slashReissueCount += 1;
				writeSlashCommandNow({ clearInput: providerId === 'codex' });
			}, SLASH_REISSUE_DELAY_MS);
		};

		terminal.onData((chunk) => {
			output = appendCapturedOutput(output, chunk);

			if (providerId === 'codex' && !codexUpdatePromptSkipped && hasCodexUpdatePrompt(output)) {
				codexUpdatePromptSkipped = true;
				schedule(
					() => safeWrite(`${CODEX_UPDATE_SKIP_OPTION}\r`, 'Failed to skip Codex update prompt.'),
					250
				);
			}
			if (providerId === 'claude' && hasClaudeTrustPrompt(output)) {
				claudeTrustPromptTimer ??= schedule(
					() => finishAfterTerminalClose(output),
					CLAUDE_TRUST_PROMPT_SETTLE_MS
				);
			}

			if (!wroteCommand && isShellReady(output)) {
				writeCommand();
			}

			if (wroteCommand && !wroteSlashCommand && isCliReady(providerId, output)) {
				slashReadyTimer ??= schedule(writeSlashCommand, slashReadySettleMs(providerId));
			}

			if (wroteSlashCommand && hasUsageOutput(providerId, output)) {
				codexStatusRefreshRetryTimer = cancelTimer(codexStatusRefreshRetryTimer);
				slashReissueTimer = cancelTimer(slashReissueTimer);
				if (usageSettleTimer) {
					clearTimeout(usageSettleTimer);
					timers.delete(usageSettleTimer);
				}
				if (providerId === 'claude' && !claudeFinalRepaintDone) {
					claudeFinalRepaintTimer = cancelTimer(claudeFinalRepaintTimer);
					claudeFinalRepaintTimer = schedule(
						forceClaudeFinalRepaint,
						CLAUDE_FINAL_REPAINT_QUIET_MS
					);
					return;
				}
				usageSettleTimer = schedule(
					() => finishAfterTerminalClose(output),
					usageOutputSettleMs(providerId)
				);
			}

			retryCodexStatusAfterRefresh();
			reissueSlashCommandIfLost();
		});

		terminal.onExit(() => {
			terminalExited = true;
			finish(output, { killTerminal: false });
		});

		writeCommandWhenShellReady();
		schedule(
			writeSlashCommandFallback,
			CLI_COLLECTION_CONFIG.shellCommandDelayMs + slashDelayMs(providerId)
		);

		schedule(() => finishAfterTerminalClose(output), captureTimeoutMs(providerId, attempt));
	});
}

function isShellReady(output: string) {
	// Strip terminal escapes before matching: pwsh/cmd renders the prompt followed by a
	// cursor-move + OSC window-title + show-cursor sequence.
	const tail = stripTerminalOutput(output.slice(-2000));
	return /(?:PS\s+)?[A-Z]:\\[^>\n]*>\s*$/i.test(tail);
}

function isCliReady(providerId: ProviderId, output: string) {
	const tail = stripTerminalOutput(output.slice(-8000));
	if (providerId === 'claude') {
		if (hasClaudeTrustPrompt(tail)) return false;
		return /\? for shortcuts|Advisor Tool|Try ["“]|Welcome back/i.test(tail);
	}
	if (providerId === 'codex') {
		if (hasCodexUpdatePromptText(tail)) return false;
		return isCodexReadyTail(tail);
	}
	if (providerId === 'agy') {
		return /\? for shortcuts|Antigravity CLI/i.test(tail);
	}
	const hasModelPrompt =
		/(?:gemini|gpt|claude|opus|sonnet|flash|pro|oss|agy)[^\r\n]+ · [A-Z]:\\/i.test(tail);
	return hasModelPrompt || /Type your message|workspace\s+\(\/directory\)/i.test(tail);
}

function shouldConfirmCodexSlashCommand(output: string, slashCommand: string) {
	const tail = stripTerminalOutput(output.slice(-8000));
	if (hasCodexUpdatePromptText(tail)) return false;
	return hasVisibleSlashBuffer(tail, slashCommand);
}

function shouldConfirmGeminiSlashCommand(output: string, slashCommand: string) {
	const tail = stripTerminalOutput(output.slice(-8000));
	if (hasGeminiModelScreenText(tail)) return false;

	return hasVisibleSlashBuffer(tail, slashCommand);
}

function hasGeminiModelScreen(output: string) {
	return hasGeminiModelScreenText(stripTerminalOutput(output.slice(-8000)));
}

function hasGeminiModelScreenText(value: string) {
	return /Select Model|Model usage|Model Quota/i.test(value);
}

function isCodexReadyTail(tail: string) {
	const bootIndex = latestCodexLoadingIndex(tail);

	const readyMatches = [...tail.matchAll(/gpt-[^\r\n]+ · [A-Z]:\\/gi)];
	const readyIndex = readyMatches.at(-1)?.index ?? -1;
	if (readyIndex >= 0) return readyIndex > bootIndex;

	const skillsMatches = [...tail.matchAll(/Use \/skills/gi)];
	const skillsIndex = skillsMatches.at(-1)?.index ?? -1;
	return skillsIndex >= 0 && skillsIndex > bootIndex;
}

function shouldWaitForCodexReady(output: string) {
	const tail = stripTerminalOutput(output.slice(-8000));
	if (isCodexReadyTail(tail)) return false;

	return (
		hasCodexUpdatePromptText(tail) ||
		/booting\s+mcp\s+server|model:\s*loading|Use \/skills/i.test(tail)
	);
}

function shouldWaitForClaudeReady(output: string) {
	const tail = stripTerminalOutput(output.slice(-8000));
	if (isCliReady('claude', output)) return false;

	return hasClaudeTrustPrompt(tail) || /Accessing\s+workspace|Quick\s+safety\s+check/i.test(tail);
}

function shouldWaitForGeminiReady(output: string) {
	const tail = stripTerminalOutput(output.slice(-8000));
	if (isCliReady('agy', output)) return false;

	return /waiting for authentication/i.test(tail);
}

function shouldReissueSlashCommand(providerId: ProviderId, output: string, slashCommand: string) {
	if (!isCliReady(providerId, output)) return false;
	return slashCommandLooksLost(providerId, output, slashCommand);
}

// Same lost-slash checks without the isCliReady gate: persistent sessions are known ready,
// and their per-request capture starts empty so the ready banner may never reappear in it.
function slashCommandLooksLost(providerId: ProviderId, output: string, slashCommand: string) {
	const tail = stripTerminalOutput(output.slice(-8000));
	if (hasVisibleSlashBuffer(tail, slashCommand)) return false;

	if (providerId === 'codex') {
		return (
			!hasCodexStatusRefreshRequested(output) &&
			!/5h\s+limit|weekly\s+limit|visit\s+https:\/\/chatgpt\.com\/codex\/settings\/usage/i.test(
				tail
			)
		);
	}

	if (providerId === 'agy') {
		return !hasGeminiModelScreenText(tail);
	}

	if (providerId === 'claude') {
		return !/\bCurrent\s+session\b|\bCurrent\s+week\b|\d+(?:\.\d+)?\s*%\s+used/i.test(tail);
	}

	return false;
}

function hasVisibleSlashBuffer(value: string, slashCommand: string) {
	const escapedSlashCommand = escapeRegExp(slashCommand);
	const commandEndPattern = String.raw`(?=\s|$|gpt-|gemini-|Auto\s|[A-Z]:\\)`;
	return new RegExp(
		`(?:^|\\n)[^\\n]*>\\s*${escapedSlashCommand}${commandEndPattern}|\\u203a\\s*${escapedSlashCommand}${commandEndPattern}`,
		'i'
	).test(value);
}

function hasCodexStatusRefreshRequested(output: string) {
	const tail = stripTerminalOutput(output.slice(-8000));
	const lines = tail
		.split('\n')
		.map((line) => normalizeCollectorMarkerLine(line))
		.filter(Boolean);
	return latestCodexStatusSignal(lines) === 'status-refresh-requested';
}

function isCodexStatusRefreshRequestedLine(line: string) {
	return (
		/Limits:\s*refresh requested;\s*run \/status again shortly/i.test(line) ||
		/limits\s+may\s+be\s+stale\s*-\s*run\s+\/status\s+again\s+shortly/i.test(line)
	);
}

function isCodexLimitLine(line: string) {
	return (
		/(?:^|[│\s])5h\s+limit\s*:/i.test(line) || /(?:^|[│\s])(weekly|week)\s+limit\s*:/i.test(line)
	);
}

function latestCodexStatusSignal(lines: string[]) {
	let latest: 'usage-limit' | 'status-refresh-requested' | null = null;
	for (const line of lines) {
		if (isCodexStatusRefreshRequestedLine(line)) {
			latest = 'status-refresh-requested';
		}
		if (isCodexLimitLine(line)) {
			latest = 'usage-limit';
		}
	}
	return latest;
}

function hasCodexUpdatePrompt(output: string) {
	return hasCodexUpdatePromptText(stripTerminalOutput(output.slice(-8000)));
}

function hasCodexUpdatePromptText(value: string) {
	// After the prompt is skipped, a static "Update available!" banner stays in the captured
	// scrollback, so the prompt only counts as active while its interactive option list is
	// newer than the latest ready footer.
	const optionMatches = [
		...value.matchAll(/Update now|Skip until next version|Press enter to continue/gi)
	];
	const optionIndex = optionMatches.at(-1)?.index ?? -1;
	if (optionIndex < 0) return false;
	const readyMatches = [...value.matchAll(/gpt-[^\r\n]+ · [A-Z]:\\|Use \/skills/gi)];
	const readyIndex = readyMatches.at(-1)?.index ?? -1;
	return optionIndex > readyIndex;
}

function hasClaudeTrustPrompt(value: string) {
	return /Quick\s+safety\s+check|Yes,\s+I\s+trust\s+this\s+folder|Accessing\s+workspace/i.test(
		value
	);
}

function latestCodexLoadingIndex(tail: string) {
	const loadingMatches = [...tail.matchAll(/booting\s+mcp\s+server|model:\s*loading/gi)];
	return loadingMatches.at(-1)?.index ?? -1;
}

function slashDelayMs(providerId: ProviderId) {
	if (providerId === 'claude') return CLI_COLLECTION_CONFIG.commandDelayMs;
	return Math.max(CLI_COLLECTION_CONFIG.commandDelayMs, 10_000);
}

function captureTimeoutMs(providerId: ProviderId, attempt = 1) {
	const baseTimeoutMs =
		CLI_COLLECTION_CONFIG.providerCaptureTimeoutMs[
			providerId as keyof typeof CLI_COLLECTION_CONFIG.providerCaptureTimeoutMs
		] ?? CLI_COLLECTION_CONFIG.captureTimeoutMs;

	if (attempt < 3) return baseTimeoutMs;
	if (providerId === 'codex' || providerId === 'agy') return baseTimeoutMs + 30_000;
	return baseTimeoutMs + 15_000;
}

function collectionRetryDelayMs(attempt: number) {
	const nextAttempt = attempt + 1;
	if (nextAttempt >= MAX_COLLECTION_ATTEMPTS) return FINAL_RETRY_DELAY_MS;
	if (nextAttempt >= 3) return PATIENT_RETRY_DELAY_MS;
	return STANDARD_RETRY_DELAY_MS;
}

function usageOutputSettleMs(providerId: ProviderId) {
	if (providerId === 'agy') return 3000;
	return USAGE_OUTPUT_SETTLE_MS;
}

function slashReadySettleMs(providerId: ProviderId) {
	if (providerId === 'claude') return 1500;
	if (providerId === 'codex') return 1000;
	if (providerId === 'agy') return 800;
	return 500;
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function runPipeSlashCommand(
	providerId: ProviderId,
	command: string,
	slashCommand: string,
	attempt: number,
	workingDirectory: string
) {
	return await new Promise<string>((resolve, reject) => {
		let output = '';
		let settled = false;

		const child = spawn(command, [], {
			cwd: workingDirectory,
			env: { ...process.env, ...CLI_COLLECTION_CONFIG.env },
			shell: true,
			windowsHide: true
		});

		const cleanup = () => {
			clearTimeout(commandTimer);
			clearTimeout(timeoutTimer);
			if (!child.killed) child.kill();
		};

		const finish = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(output);
		};

		const fail = (message: string) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(new Error(message));
		};

		child.stdout.on('data', (chunk: Buffer) => {
			output = appendCapturedOutput(output, chunk.toString('utf8'));
		});

		child.stderr.on('data', (chunk: Buffer) => {
			output = appendCapturedOutput(output, chunk.toString('utf8'));
		});

		child.on('error', (error) => fail(error.message));
		child.on('exit', finish);

		const commandTimer = setTimeout(() => {
			if (!child.stdin.writable) return;
			markProviderCommandSent(providerId);
			child.stdin.write(`${slashCommand}\n`);
			child.stdin.end();
		}, CLI_COLLECTION_CONFIG.commandDelayMs);

		const timeoutTimer = setTimeout(finish, captureTimeoutMs(providerId, attempt));
	});
}

type PersistentSession = {
	providerId: ProviderId;
	workingDirectory: string;
	terminal: ReturnType<PtyModule['spawn']>;
	output: string;
	alive: boolean;
	lastRequestSawUsage: boolean;
	busy: Promise<unknown>;
	dataListeners: Set<(chunk: string) => void>;
	exitListeners: Set<() => void>;
};

type PersistentSessionGlobal = typeof globalThis & {
	__aiUsagePersistentSessions?: Map<ProviderId, PersistentSession>;
	__aiUsagePersistentCleanup?: boolean;
};

// Sessions live on globalThis so dev-mode module reloads do not leak hidden terminals.
function persistentSessionRegistry() {
	const holder = globalThis as PersistentSessionGlobal;
	holder.__aiUsagePersistentSessions ??= new Map();
	return holder.__aiUsagePersistentSessions;
}

async function runPersistentSlashCommand(
	providerId: ProviderId,
	command: string,
	slashCommand: string,
	attempt: number,
	workingDirectory: string
) {
	const registry = persistentSessionRegistry();
	const existing = registry.get(providerId);
	// Reuse a proven session even when the requested working directory differs: the
	// candidates only exist to satisfy trust prompts, and respawning a terminal on every
	// refresh is what makes console windows flash.
	if (existing?.alive && existing.lastRequestSawUsage) {
		return await queuePersistentRequest(existing, slashCommand, attempt);
	}
	if (existing) {
		disposePersistentSession(existing);
	}

	const session = await createPersistentSession(providerId, workingDirectory);
	let startResult: 'ready' | 'trust-prompt';
	try {
		startResult = await startPersistentCli(session, command);
	} catch (error) {
		disposePersistentSession(session);
		throw error;
	}
	if (startResult === 'trust-prompt') {
		// Return the captured prompt so diagnostics report claude-trust-prompt and the
		// retry loop advances to the next working-directory candidate.
		const output = session.output;
		disposePersistentSession(session);
		return output;
	}
	registry.set(providerId, session);
	registerPersistentSessionCleanup();
	return await queuePersistentRequest(session, slashCommand, attempt);
}

function queuePersistentRequest(session: PersistentSession, slashCommand: string, attempt: number) {
	const request = session.busy
		.catch(() => undefined)
		.then(() => runPersistentRequest(session, slashCommand, attempt));
	session.busy = request.catch(() => undefined);
	return request;
}

async function createPersistentSession(
	providerId: ProviderId,
	workingDirectory: string
): Promise<PersistentSession> {
	const pty = (await import('node-pty')) as PtyModule;
	const terminal = pty.spawn(
		CLI_COLLECTION_CONFIG.shell.command,
		[...CLI_COLLECTION_CONFIG.shell.args],
		{
			name: 'xterm-256color',
			cols: providerId === 'agy' ? 160 : 120,
			rows: providerId === 'agy' ? 64 : 36,
			cwd: workingDirectory,
			env: { ...process.env, ...CLI_COLLECTION_CONFIG.env },
			useConpty: process.env.AI_USAGE_USE_CONPTY !== '0',
			useConptyDll: process.env.AI_USAGE_USE_CONPTY_DLL === '1'
		}
	);

	const session: PersistentSession = {
		providerId,
		workingDirectory,
		terminal,
		output: '',
		alive: true,
		lastRequestSawUsage: true,
		busy: Promise.resolve(),
		dataListeners: new Set(),
		exitListeners: new Set()
	};

	terminal.onData((chunk) => {
		session.output = appendCapturedOutput(session.output, chunk);
		for (const listener of [...session.dataListeners]) listener(chunk);
	});
	terminal.onExit(() => {
		session.alive = false;
		const registry = persistentSessionRegistry();
		if (registry.get(providerId) === session) registry.delete(providerId);
		for (const listener of [...session.exitListeners]) listener();
	});

	return session;
}

async function startPersistentCli(
	session: PersistentSession,
	command: string
): Promise<'ready' | 'trust-prompt'> {
	const { providerId } = session;
	const startupDeadline = performance.now() + PERSISTENT_SESSION_START_TIMEOUT_MS;
	const shellReadyDeadline = performance.now() + SHELL_READY_FORCE_WRITE_MS;
	while (!isShellReady(session.output) && performance.now() < shellReadyDeadline) {
		if (!session.alive) throw new Error('Persistent session shell exited during startup.');
		await delay(PERSISTENT_SESSION_POLL_MS);
	}
	await delay(CLI_COLLECTION_CONFIG.shellCommandDelayMs);
	persistentWrite(session, `${command}\r`);

	let codexUpdatePromptSkipped = false;
	while (performance.now() < startupDeadline) {
		if (!session.alive) throw new Error('Persistent session terminal exited during startup.');
		if (
			providerId === 'claude' &&
			hasClaudeTrustPrompt(stripTerminalOutput(session.output.slice(-8000)))
		) {
			await delay(CLAUDE_TRUST_PROMPT_SETTLE_MS);
			return 'trust-prompt';
		}
		if (
			providerId === 'codex' &&
			!codexUpdatePromptSkipped &&
			hasCodexUpdatePrompt(session.output)
		) {
			codexUpdatePromptSkipped = true;
			await delay(250);
			persistentWrite(session, `${CODEX_UPDATE_SKIP_OPTION}\r`);
		}
		if (isCliReady(providerId, session.output)) {
			await delay(slashReadySettleMs(providerId));
			return 'ready';
		}
		await delay(PERSISTENT_SESSION_POLL_MS);
	}
	throw new Error('Persistent session CLI did not become ready in time.');
}

async function runPersistentRequest(
	session: PersistentSession,
	slashCommand: string,
	attempt: number
) {
	const { providerId } = session;
	if (!session.alive) throw new Error('Persistent session terminal already exited.');

	return await new Promise<string>((resolve) => {
		let output = '';
		let settled = false;
		let wroteSlashCommand = false;
		let codexStatusRefreshRetryCount = 0;
		let slashReissueCount = 0;
		let usageSettleTimer: NodeJS.Timeout | undefined;
		let claudeFinalRepaintTimer: NodeJS.Timeout | undefined;
		let claudeFinalRepaintDone = false;
		let codexStatusRefreshRetryTimer: NodeJS.Timeout | undefined;
		let slashReissueTimer: NodeJS.Timeout | undefined;
		let claudeTrustPromptTimer: NodeJS.Timeout | undefined;
		const timers = new Set<NodeJS.Timeout>();

		const schedule = (callback: () => void, ms: number) => {
			const timer = setTimeout(() => {
				timers.delete(timer);
				callback();
			}, ms);
			timers.add(timer);
			return timer;
		};

		const cancelTimer = (timer: NodeJS.Timeout | undefined) => {
			if (!timer) return undefined;
			clearTimeout(timer);
			timers.delete(timer);
			return undefined;
		};

		const finish = () => {
			if (settled) return;
			settled = true;
			for (const timer of timers) clearTimeout(timer);
			timers.clear();
			session.dataListeners.delete(onChunk);
			session.exitListeners.delete(onSessionExit);
			// A request that never reached usage output marks the session unproven, so the
			// next attempt respawns it at the requested working directory.
			session.lastRequestSawUsage = hasUsageOutput(providerId, output);
			// Park the session at the main prompt: Claude wedges (stops reading input
			// entirely) when its /usage panel is left open across the idle gap.
			if (session.lastRequestSawUsage && providerId !== 'codex') {
				persistentWrite(session, PERSISTENT_PANEL_CLOSE);
			}
			resolve(output);
		};

		const onSessionExit = () => finish();

		const writeSlashCommandNow = (options: { clearInput?: boolean } = {}) => {
			wroteSlashCommand = true;
			const writeSlashCommandInput = () => {
				markProviderCommandSent(providerId);
				persistentWrite(session, `${slashCommand}\r`);
			};
			if (options.clearInput) {
				persistentWrite(session, TERMINAL_INPUT_CLEAR);
				schedule(writeSlashCommandInput, TERMINAL_INPUT_CLEAR_SETTLE_MS);
			} else {
				writeSlashCommandInput();
			}

			if (providerId === 'codex') {
				const startedAt = performance.now();
				const confirmUntilMs = Math.max(
					10_000,
					captureTimeoutMs(providerId, attempt) - CODEX_SLASH_CONFIRM_TIMEOUT_BUFFER_MS
				);
				const confirmSlashCommand = () => {
					if (settled || hasUsageOutput(providerId, output)) return;
					const shouldConfirm = shouldConfirmCodexSlashCommand(output, slashCommand);
					if (shouldConfirm) persistentWrite(session, '\r');
					if (performance.now() - startedAt < confirmUntilMs && shouldConfirm) {
						schedule(confirmSlashCommand, CODEX_SLASH_CONFIRM_INTERVAL_MS);
					}
				};
				schedule(confirmSlashCommand, 800);
			}
			if (providerId === 'agy') {
				const startedAt = performance.now();
				const confirmUntilMs = Math.max(
					10_000,
					captureTimeoutMs(providerId, attempt) - GEMINI_SLASH_CONFIRM_TIMEOUT_BUFFER_MS
				);
				const confirmSlashCommand = () => {
					if (settled) return;
					if (shouldConfirmGeminiSlashCommand(output, slashCommand)) {
						persistentWrite(session, '\r');
					}
					if (performance.now() - startedAt < confirmUntilMs && !hasGeminiModelScreen(output)) {
						schedule(confirmSlashCommand, GEMINI_SLASH_CONFIRM_INTERVAL_MS);
					}
				};
				schedule(confirmSlashCommand, 800);
			}
		};

		const retryCodexStatusAfterRefresh = () => {
			if (settled || providerId !== 'codex' || !wroteSlashCommand) return;
			const statusRefreshRequested = hasCodexStatusRefreshRequested(output);
			if (hasUsageOutput(providerId, output) && !statusRefreshRequested) return;
			if (!statusRefreshRequested) return;
			if (codexStatusRefreshRetryTimer) return;
			if (codexStatusRefreshRetryCount >= MAX_CODEX_STATUS_REFRESH_RETRIES) return;

			codexStatusRefreshRetryTimer = schedule(() => {
				codexStatusRefreshRetryTimer = undefined;
				if (settled || hasUsageOutput(providerId, output)) return;
				if (!hasCodexStatusRefreshRequested(output)) return;
				codexStatusRefreshRetryCount += 1;
				writeSlashCommandNow({ clearInput: true });
			}, CODEX_STATUS_REFRESH_RETRY_DELAY_MS);
		};

		const reissueSlashCommandIfLost = () => {
			if (settled || !wroteSlashCommand || hasUsageOutput(providerId, output)) return;
			if (providerId === 'claude') return;
			if (slashReissueTimer) return;
			if (slashReissueCount >= MAX_SLASH_REISSUES) return;
			if (!slashCommandLooksLost(providerId, output, slashCommand)) return;

			slashReissueTimer = schedule(() => {
				slashReissueTimer = undefined;
				if (settled || hasUsageOutput(providerId, output)) return;
				if (!slashCommandLooksLost(providerId, output, slashCommand)) return;

				slashReissueCount += 1;
				writeSlashCommandNow({ clearInput: providerId === 'codex' });
			}, SLASH_REISSUE_DELAY_MS);
		};

		const forceFullRepaint = (allowComplete = false) => {
			if (settled || !session.alive || (!allowComplete && hasUsageOutput(providerId, output))) {
				return;
			}
			try {
				const { cols, rows } = session.terminal;
				session.terminal.resize(cols, rows - 1);
				session.terminal.resize(cols, rows);
			} catch {
				// The PTY may already be closing.
			}
		};

		const forceClaudeFinalRepaint = () => {
			if (settled || providerId !== 'claude') return;
			claudeFinalRepaintTimer = undefined;
			claudeFinalRepaintDone = true;
			forceFullRepaint(true);
			usageSettleTimer = schedule(finish, CLAUDE_FINAL_REPAINT_FALLBACK_MS);
		};

		const onChunk = (chunk: string) => {
			output = appendCapturedOutput(output, chunk);

			if (
				providerId === 'claude' &&
				hasClaudeTrustPrompt(stripTerminalOutput(output.slice(-8000)))
			) {
				claudeTrustPromptTimer ??= schedule(finish, CLAUDE_TRUST_PROMPT_SETTLE_MS);
			}

			if (wroteSlashCommand && hasUsageOutput(providerId, output)) {
				codexStatusRefreshRetryTimer = cancelTimer(codexStatusRefreshRetryTimer);
				slashReissueTimer = cancelTimer(slashReissueTimer);
				if (usageSettleTimer) {
					clearTimeout(usageSettleTimer);
					timers.delete(usageSettleTimer);
				}
				if (providerId === 'claude' && !claudeFinalRepaintDone) {
					claudeFinalRepaintTimer = cancelTimer(claudeFinalRepaintTimer);
					claudeFinalRepaintTimer = schedule(
						forceClaudeFinalRepaint,
						CLAUDE_FINAL_REPAINT_QUIET_MS
					);
					return;
				}
				usageSettleTimer = schedule(finish, usageOutputSettleMs(providerId));
			}

			retryCodexStatusAfterRefresh();
			reissueSlashCommandIfLost();
		};

		session.dataListeners.add(onChunk);
		session.exitListeners.add(onSessionExit);

		// On a reused session the TUI may repaint only changed cells, so the reopened usage
		// panel never lands as full rows in this request's capture. A resize jiggle forces a
		// complete redraw of the current screen.
		// Reset leftover TUI state from the previous request. Esc closes a still-open usage
		// panel (Claude /usage, Antigravity model screen); Codex skips Esc because its
		// transcript could repaint stale limit rows into the fresh capture.
		if (providerId === 'codex') {
			schedule(() => writeSlashCommandNow({ clearInput: true }), PERSISTENT_REQUEST_RESET_DELAY_MS);
		} else {
			persistentWrite(session, PERSISTENT_PANEL_CLOSE);
			schedule(
				() => persistentWrite(session, TERMINAL_INPUT_CLEAR),
				PERSISTENT_REQUEST_RESET_DELAY_MS
			);
			schedule(
				() => writeSlashCommandNow(),
				PERSISTENT_REQUEST_RESET_DELAY_MS + TERMINAL_INPUT_CLEAR_SETTLE_MS
			);
			for (const repaintDelayMs of [4000, 9000, 16_000]) {
				schedule(forceFullRepaint, repaintDelayMs);
			}
		}

		schedule(() => {
			if (output.length === 0) finish();
		}, PERSISTENT_NO_OUTPUT_FAIL_MS);
		schedule(finish, captureTimeoutMs(providerId, attempt));
	});
}

function persistentWrite(session: PersistentSession, value: string) {
	if (!session.alive) return;
	try {
		session.terminal.write(value);
	} catch {
		// The PTY may already be closing.
	}
}

function disposePersistentSession(session: PersistentSession) {
	const registry = persistentSessionRegistry();
	if (registry.get(session.providerId) === session) registry.delete(session.providerId);
	const wasAlive = session.alive;
	session.alive = false;
	for (const listener of [...session.exitListeners]) listener();
	if (!wasAlive) return;
	try {
		session.terminal.kill();
	} catch {
		// The process may already be closed.
	}
}

function registerPersistentSessionCleanup() {
	const holder = globalThis as PersistentSessionGlobal;
	if (holder.__aiUsagePersistentCleanup) return;
	holder.__aiUsagePersistentCleanup = true;
	process.once('exit', () => {
		for (const session of persistentSessionRegistry().values()) {
			disposePersistentSession(session);
		}
	});
}

export async function initPersistentSessions() {
	if (PERSISTENT_SESSION_DISABLED) return;
	const registry = persistentSessionRegistry();
	for (const provider of PROVIDERS) {
		const existing = registry.get(provider.id);
		if (existing?.alive && existing.lastRequestSawUsage) continue;
		if (existing) {
			disposePersistentSession(existing);
		}
		const workingDirectory = providerWorkingDirectories(provider.id)[0] ?? '.';
		try {
			const session = await createPersistentSession(provider.id, workingDirectory);
			const startResult = await startPersistentCli(session, provider.command);
			if (startResult === 'trust-prompt') {
				disposePersistentSession(session);
				continue;
			}
			registry.set(provider.id, session);
			registerPersistentSessionCleanup();
			console.info(`[collector] Pre-initialized persistent session for ${provider.id}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown pre-init error';
			console.warn(`[collector] Pre-initialized session failed for ${provider.id}: ${message}`);
		}
	}
}

function hasUsageOutput(providerId: ProviderId, output: string) {
	const parsed = parseProviderUsage(providerId, output);
	if (providerId === 'codex') {
		return (
			parsed.windows.fiveHour.percent !== null &&
			parsed.windows.week.percent !== null &&
			!hasCodexStatusRefreshRequested(output)
		);
	}

	if (providerId === 'agy') {
		return (
			parsed.modelUsages.length >= 1 &&
			parsed.modelUsages.filter((usage) => usage.resetAt !== null || usage.remainingText !== null)
				.length >= 1
		);
	}

	if (providerId === 'claude') {
		return (
			parsed.windows.fiveHour.percent !== null &&
			parsed.windows.week.percent !== null &&
			(parsed.windows.fiveHour.percent === 0 || hasResetText(parsed.windows.fiveHour)) &&
			(parsed.windows.week.percent === 0 || hasResetText(parsed.windows.week))
		);
	}

	return parsed.status === 'ok';
}

function hasResetText(window: ProviderUsage['windows']['fiveHour']) {
	return window.resetAt !== null || window.remainingText !== null;
}

function appendCapturedOutput(output: string, chunk: string) {
	const nextOutput = output + chunk;
	return nextOutput.length > MAX_CAPTURE_CHARS ? nextOutput.slice(-MAX_CAPTURE_CHARS) : nextOutput;
}

function buildCollectionDiagnostics(
	providerId: ProviderId,
	rawOutput: string,
	result: ProviderUsage
) {
	const output = stripTerminalOutput(rawOutput);
	const lines = output
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);
	const markers = usageMarkers(providerId, lines);
	const parseDetails = parseDiagnostics(providerId, markers, result);
	const phase = collectionPhase(providerId, output, markers, result);

	return { output, rawOutputLength: rawOutput.length, lines, markers, parseDetails, phase, result };
}

function describeCollectionResult(diagnostics: ReturnType<typeof buildCollectionDiagnostics>) {
	const detail = [
		`output=${diagnostics.output.length} chars/${diagnostics.lines.length} lines`,
		`raw=${diagnostics.rawOutputLength} chars`,
		`phase=${diagnostics.phase}`,
		`markers=${diagnostics.markers.length > 0 ? diagnostics.markers.join(',') : 'none'}`
	];
	detail.push(...diagnostics.parseDetails);

	if (DEBUG_COLLECTOR_LOGS && diagnostics.result.rawPreview) {
		detail.push(`tail=${JSON.stringify(diagnostics.result.rawPreview.slice(-500))}`);
	}

	return `(${detail.join('; ')})`;
}

function isPendingProviderRefresh(
	providerId: ProviderId,
	diagnostics: ReturnType<typeof buildCollectionDiagnostics>
) {
	return providerId === 'codex' && diagnostics.markers.includes('status-refresh-requested');
}

function collectionPhase(
	providerId: ProviderId,
	output: string,
	markers: string[],
	result: ProviderUsage
) {
	if (result.status === 'ok') return 'usage-output-complete';

	if (providerId === 'codex') {
		if (hasCodexUpdatePromptText(output)) return 'codex-update-prompt';
		if (markers.includes('status-refresh-requested')) return 'codex-status-refresh-pending';
		if (shouldWaitForCodexReady(output)) return 'codex-loading';
		if (/\/status/i.test(output)) return 'codex-status-output-without-limits';
		if (isCliReady('codex', output)) return 'codex-ready-without-status-command';
		return 'codex-startup-or-redraw';
	}

	if (providerId === 'agy') {
		if (/waiting for authentication/i.test(output)) return 'gemini-auth-wait';
		if (markers.includes('model-screen')) return 'gemini-model-screen-incomplete';
		if (markers.includes('slash-buffer')) return 'gemini-slash-buffer-waiting';
		if (isCliReady('agy', output) && markers.includes('quota-percent')) {
			return 'gemini-ready-without-model-screen';
		}
		if (isCliReady('agy', output)) return 'gemini-ready-without-model-command';
		return 'gemini-startup-or-redraw';
	}

	if (providerId === 'claude' && hasClaudeTrustPrompt(output)) return 'claude-trust-prompt';
	if (isCliReady(providerId, output)) return `${providerId}-ready-without-usage-output`;
	return `${providerId}-startup-or-redraw`;
}

function parseDiagnostics(providerId: ProviderId, markers: string[], result: ProviderUsage) {
	if (providerId === 'codex') {
		if (result.status === 'ok') return [];
		if (markers.includes('status-refresh-requested')) {
			return ['parse-failure=status refresh requested; /status should be retried'];
		}
		const missing = [];
		if (!markers.includes('5h-limit')) missing.push('5h-limit');
		if (!markers.includes('week-limit')) missing.push('week-limit');
		return missing.length > 0 ? [`parse-failure=missing ${missing.join(',')}`] : [];
	}

	if (providerId !== 'agy') return [];

	const parsedLabels = result.modelUsages.map((usage) => usage.label);
	const detail = [`parsed-models=${result.modelUsages.length}/3`];
	if (parsedLabels.length > 0) {
		detail.push(`parsed-labels=${parsedLabels.join('|')}`);
	}
	if (result.status === 'ok') return detail;

	if (
		markers.includes('quota-percent') &&
		!markers.includes('model-screen') &&
		!markers.includes('model-name')
	) {
		return [...detail, 'parse-failure=waiting for Model usage screen; saw quota/status percent'];
	}

	const missing = [];
	if (!markers.includes('model-screen')) missing.push('model-screen');
	if (!markers.includes('model-name')) missing.push('model-name');
	if (!markers.includes('bar-row')) missing.push('bar-row');
	if (!markers.includes('percent')) missing.push('percent');
	if (!markers.includes('reset-word')) missing.push('reset-word');
	if (
		markers.includes('percent') &&
		markers.includes('reset-word') &&
		!markers.includes('percent-reset')
	) {
		missing.push('percent-reset-same-row');
	}
	if (result.modelUsages.length < 3) missing.push('3 model rows');

	return [
		...detail,
		`parse-failure=${missing.length > 0 ? `missing ${missing.join(',')}` : 'parsed output did not meet ok criteria'}`
	];
}

function usageMarkers(providerId: ProviderId, lines: string[]) {
	const normalizedLines = lines.map(normalizeCollectorMarkerLine);

	if (providerId === 'codex') {
		return [
			normalizedLines.some((line) => /(?:^|[│\s])5h\s+limit\s*:/i.test(line)) ? '5h-limit' : null,
			normalizedLines.some((line) => /(?:^|[│\s])(weekly|week)\s+limit\s*:/i.test(line))
				? 'week-limit'
				: null,
			latestCodexStatusSignal(normalizedLines) === 'status-refresh-requested'
				? 'status-refresh-requested'
				: null
		].filter((marker): marker is string => marker !== null);
	}

	if (providerId === 'agy') {
		const usageRows = lines
			.map((line, index) => ({ raw: line, normalized: normalizedLines[index] }))
			.filter((line, index) =>
				isGeminiUsageRowCandidate(line.raw, line.normalized, index, lines, normalizedLines)
			);
		return [
			normalizedLines.some((line) => /model usage|select model|model quota/i.test(line))
				? 'model-screen'
				: null,
			normalizedLines.some((line) => />\s*\/(?:model|usage)\b/i.test(line)) ? 'slash-buffer' : null,
			usageRows.length > 0 ? 'model-name' : null,
			usageRows.some((line) => GEMINI_BAR_RUN_PATTERN.test(line.raw)) ? 'bar-row' : null,
			usageRows.some((line) => /\d+(?:\.\d+)?\s*%/.test(line.normalized)) ? 'percent' : null,
			usageRows.some((line) => /\bResets?\s*:/i.test(line.normalized)) ? 'reset-word' : null,
			usageRows.some((line) => /\d+(?:\.\d+)?\s*%\s+Resets?\s*:/i.test(line.normalized))
				? 'percent-reset'
				: null,
			normalizedLines.some((line) =>
				/\bquota\b.*\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*%\s+used/i.test(line)
			)
				? 'quota-percent'
				: null
		].filter((marker): marker is string => marker !== null);
	}

	return [
		normalizedLines.some((line) => /\busage\b/i.test(line)) ? 'usage-word' : null,
		normalizedLines.some((line) => /\d+(?:\.\d+)?\s*%/.test(line)) ? 'percent' : null
	].filter((marker): marker is string => marker !== null);
}

function isGeminiUsageRowCandidate(
	rawLine: string,
	normalizedLine: string,
	index: number,
	rawLines: string[],
	normalizedLines: string[]
) {
	const prevNormalized = normalizedLines[index - 1] ?? '';
	const nextNormalized = normalizedLines[index + 1] ?? '';

	const hasLabel =
		GEMINI_USAGE_ROW_LABEL_PATTERN.test(normalizedLine) ||
		GEMINI_USAGE_ROW_LABEL_PATTERN.test(prevNormalized) ||
		isStructuredGeminiBarUsageRow(rawLine, normalizedLine) ||
		(prevNormalized && isStructuredGeminiBarUsageRow(rawLines[index - 1], prevNormalized));

	const hasBarOrPercent =
		GEMINI_BAR_RUN_PATTERN.test(rawLine) ||
		/\d+(?:\.\d+)?\s*%/.test(normalizedLine) ||
		/\d+(?:\.\d+)?\s*%/.test(nextNormalized);

	return hasLabel && hasBarOrPercent;
}

function isTransientStartupMiss(
	providerId: ProviderId,
	diagnostics: ReturnType<typeof buildCollectionDiagnostics>
) {
	if (providerId !== 'codex') return false;
	if (diagnostics.result.status === 'ok') return false;
	if (diagnostics.markers.length > 0) return false;

	return diagnostics.phase === 'codex-loading' || diagnostics.phase === 'codex-startup-or-redraw';
}

function shouldAdvanceWorkingDirectory(
	providerId: ProviderId,
	diagnostics: ReturnType<typeof buildCollectionDiagnostics>
) {
	if (diagnostics.result.status === 'ok') return false;

	if (providerId === 'claude') {
		return diagnostics.phase === 'claude-trust-prompt';
	}

	if (providerId === 'codex') {
		return (
			diagnostics.phase === 'codex-update-prompt' ||
			diagnostics.phase === 'codex-ready-without-status-command' ||
			(diagnostics.phase === 'codex-startup-or-redraw' && diagnostics.markers.length === 0)
		);
	}

	if (providerId === 'agy') {
		return (
			diagnostics.phase === 'gemini-auth-wait' || diagnostics.phase === 'gemini-startup-or-redraw'
		);
	}

	return false;
}

function isStructuredGeminiBarUsageRow(rawLine: string, normalizedLine: string) {
	const barMatch = rawLine.match(GEMINI_BAR_RUN_PATTERN);
	if (!barMatch || barMatch.index === undefined) return false;
	if (!/\d+(?:\.\d+)?\s*%/.test(normalizedLine)) return false;

	const label = normalizeCollectorMarkerLine(rawLine.slice(0, barMatch.index));
	return (
		label.length > 0 &&
		label.length <= 48 &&
		/[A-Za-z0-9]/.test(label) &&
		!/\b(model usage|select model|press esc|type your message|quota|limit|used|left|remaining|resets?)\b/i.test(
			label
		) &&
		!/[/\\<>|]/.test(label)
	);
}

function normalizeCollectorMarkerLine(line: string) {
	return line
		.replace(BOX_DECORATION_PATTERN, ' ')
		.replace(BAR_DECORATION_PATTERN, ' ')
		.replace(/\s*(\d+(?:\.\d+)?)\s*%\s*/g, ' $1% ')
		.replace(/\bResets?\s*:?\s*/gi, ' Resets: ')
		.replace(/\s+/g, ' ')
		.trim();
}

function formatDuration(ms: number) {
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatWorkingDirectorySwitch(nextWorkingDirectory: string | null) {
	return nextWorkingDirectory ? ` using ${nextWorkingDirectory}` : '';
}

function delay(ms: number) {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});
}
