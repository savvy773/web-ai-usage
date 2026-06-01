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

const USAGE_OUTPUT_SETTLE_MS = 1200;
const MAX_CAPTURE_CHARS = 20_000;
const MAX_COLLECTION_ATTEMPTS = 5;
const SHELL_READY_POLL_MS = 500;
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
const SLASH_REISSUE_DELAY_MS = 5000;
const MAX_SLASH_REISSUES = 3;
const CODEX_UPDATE_SKIP_OPTION = '2';
const TERMINAL_GRACEFUL_CLOSE_MS = 5000;
const GEMINI_BAR_RUN_PATTERN = /[▬━─═╌╍▔▁▂▃▄▅▆▇█▏▎▍▌▋▊▉▐░▒▓■□▱▰▯▮▭]{3,}/;
const GEMINI_USAGE_ROW_LABEL_PATTERN = /^(?:Flash(?:\s+Lite)?|Pro|gemini-[A-Za-z0-9._\-…]+)\b/i;
const GEMINI_SLASH_CONFIRM_INTERVAL_MS = 2000;
const GEMINI_SLASH_CONFIRM_TIMEOUT_BUFFER_MS = 10_000;

export async function collectAllUsage(
	onProviderResult?: (provider: ProviderUsage) => void | Promise<void>
): Promise<ProviderUsage[]> {
	return await Promise.all(
		PROVIDERS.map(async (provider) => {
			const result = await collectProvider(provider.id);
			await onProviderResult?.(result);
			return result;
		})
	);
}

async function collectProvider(providerId: ProviderId): Promise<ProviderUsage> {
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
				workingDirectory
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
	workingDirectory: string
) {
	await ensureWorkingDirectory(workingDirectory);
	try {
		return await runPtySlashCommand(providerId, command, slashCommand, attempt, workingDirectory);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown node-pty error';
		console.info(
			`[collector] ${providerId} node-pty path failed; trying pipe fallback. ${message}`
		);
		return await runPipeSlashCommand(providerId, command, slashCommand, attempt, workingDirectory);
	}
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
				cols: providerId === 'gemini' ? 160 : 120,
				rows: 36,
				cwd: workingDirectory,
				env: { ...process.env, ...CLI_COLLECTION_CONFIG.env },
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

		const writeCommand = () => {
			if (wroteCommand) return;
			wroteCommand = true;
			safeWrite(`${command}\r`, 'Failed to write CLI command.');
		};

		const writeCommandWhenShellReady = () => {
			if (wroteCommand) return;
			if (!isShellReady(output)) {
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
			if (providerId === 'gemini') {
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
			if (providerId === 'gemini' && shouldWaitForGeminiReady(output)) {
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
	return /PS\s+[A-Z]:\\[^>]*>\s*$/i.test(output.slice(-500));
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
	return /Type your message|workspace\s+\(\/directory\)/i.test(tail);
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
	return /Select Model|Model usage/i.test(value);
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
	if (isCliReady('gemini', output)) return false;

	return /waiting for authentication/i.test(tail);
}

function shouldReissueSlashCommand(providerId: ProviderId, output: string, slashCommand: string) {
	const tail = stripTerminalOutput(output.slice(-8000));
	if (!isCliReady(providerId, output)) return false;
	if (hasVisibleSlashBuffer(tail, slashCommand)) return false;

	if (providerId === 'codex') {
		return (
			!hasCodexStatusRefreshRequested(output) &&
			!/5h\s+limit|weekly\s+limit|visit\s+https:\/\/chatgpt\.com\/codex\/settings\/usage/i.test(
				tail
			)
		);
	}

	if (providerId === 'gemini') {
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
	return /Update available|Update now|Skip until next version/i.test(value);
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
	if (providerId === 'codex' || providerId === 'gemini') return baseTimeoutMs + 30_000;
	return baseTimeoutMs + 15_000;
}

function collectionRetryDelayMs(attempt: number) {
	const nextAttempt = attempt + 1;
	if (nextAttempt >= MAX_COLLECTION_ATTEMPTS) return FINAL_RETRY_DELAY_MS;
	if (nextAttempt >= 3) return PATIENT_RETRY_DELAY_MS;
	return STANDARD_RETRY_DELAY_MS;
}

function usageOutputSettleMs(providerId: ProviderId) {
	if (providerId === 'gemini') return 3000;
	return USAGE_OUTPUT_SETTLE_MS;
}

function slashReadySettleMs(providerId: ProviderId) {
	if (providerId === 'codex') return 1000;
	if (providerId === 'gemini') return 800;
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
			child.stdin.write(`${slashCommand}\n`);
			child.stdin.end();
		}, CLI_COLLECTION_CONFIG.commandDelayMs);

		const timeoutTimer = setTimeout(finish, captureTimeoutMs(providerId, attempt));
	});
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

	if (providerId === 'gemini') {
		return (
			parsed.modelUsages.length >= 3 &&
			parsed.modelUsages.filter((usage) => usage.resetAt !== null || usage.remainingText !== null)
				.length >= 3
		);
	}

	if (providerId === 'claude') {
		return (
			parsed.windows.fiveHour.percent !== null &&
			parsed.windows.week.percent !== null &&
			hasResetText(parsed.windows.fiveHour) &&
			hasResetText(parsed.windows.week)
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

	if (providerId === 'gemini') {
		if (/waiting for authentication/i.test(output)) return 'gemini-auth-wait';
		if (markers.includes('model-screen')) return 'gemini-model-screen-incomplete';
		if (markers.includes('slash-buffer')) return 'gemini-slash-buffer-waiting';
		if (isCliReady('gemini', output) && markers.includes('quota-percent')) {
			return 'gemini-ready-without-model-screen';
		}
		if (isCliReady('gemini', output)) return 'gemini-ready-without-model-command';
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

	if (providerId !== 'gemini') return [];

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

	if (providerId === 'gemini') {
		const usageRows = lines
			.map((line, index) => ({ raw: line, normalized: normalizedLines[index] }))
			.filter((line) => isGeminiUsageRowCandidate(line.raw, line.normalized));
		return [
			normalizedLines.some((line) => /model usage|select model/i.test(line))
				? 'model-screen'
				: null,
			normalizedLines.some((line) => />\s*\/model\b/i.test(line)) ? 'slash-buffer' : null,
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

function isGeminiUsageRowCandidate(rawLine: string, normalizedLine: string) {
	return (
		(GEMINI_USAGE_ROW_LABEL_PATTERN.test(normalizedLine) ||
			isStructuredGeminiBarUsageRow(rawLine, normalizedLine)) &&
		(GEMINI_BAR_RUN_PATTERN.test(rawLine) || /\d+(?:\.\d+)?\s*%/.test(normalizedLine))
	);
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

	if (providerId === 'gemini') {
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
