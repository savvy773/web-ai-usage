import { spawn } from 'node:child_process';
import {
	BAR_DECORATION_PATTERN,
	BOX_DECORATION_PATTERN,
	parseProviderUsage,
	stripTerminalOutput
} from './parser';
import { writeCollectorDebugSnapshot } from './debug-files';
import { CLI_COLLECTION_CONFIG, PROVIDERS, type ProviderId, type ProviderUsage } from '$lib/usage';

type PtyModule = typeof import('node-pty');

const USAGE_OUTPUT_SETTLE_MS = 1200;
const MAX_CAPTURE_CHARS = 20_000;
const MAX_COLLECTION_ATTEMPTS = 3;
const COLLECTION_RETRY_DELAY_MS = 1500;
const SHELL_READY_POLL_MS = 500;
const DEBUG_COLLECTOR_LOGS = process.env.AI_USAGE_DEBUG_LOGS === '1';
const GEMINI_BAR_RUN_PATTERN = /[▬━─═╌╍▔▁▂▃▄▅▆▇█▏▎▍▌▋▊▉▐░▒▓■□▱▰▯▮▭]{3,}/;
const GEMINI_USAGE_ROW_LABEL_PATTERN = /^(?:Flash(?:\s+Lite)?|Pro|gemini-[A-Za-z0-9._\-…]+)\b/i;
const GEMINI_SLASH_CONFIRM_INTERVAL_MS = 2000;
const GEMINI_SLASH_CONFIRM_TIMEOUT_BUFFER_MS = 10_000;

export async function collectAllUsage(): Promise<ProviderUsage[]> {
	const results: ProviderUsage[] = [];
	for (const provider of PROVIDERS) {
		results.push(await collectProvider(provider.id));
	}
	return results;
}

async function collectProvider(providerId: ProviderId): Promise<ProviderUsage> {
	const provider = PROVIDERS.find((item) => item.id === providerId);
	if (!provider) {
		throw new Error(`Unknown provider: ${providerId}`);
	}

	const startedAt = performance.now();
	let latestResult: ProviderUsage | null = null;

	for (let attempt = 1; attempt <= MAX_COLLECTION_ATTEMPTS; attempt += 1) {
		let output = '';
		try {
			output = await runSlashCommand(provider.id, provider.command, provider.slashCommand);
			latestResult = parseProviderUsage(provider.id, output);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown collection error';
			latestResult = parseProviderUsage(provider.id, '', message);
		}

		const diagnostics = buildCollectionDiagnostics(provider.id, output, latestResult);
		const transientStartupMiss = isTransientStartupMiss(provider.id, diagnostics);
		await writeCollectorDebugSnapshot(provider.id, output, latestResult, {
			attempt,
			maxAttempts: MAX_COLLECTION_ATTEMPTS,
			markers: diagnostics.markers,
			parseDiagnostics: diagnostics.parseDetails,
			writeFailureCopy: latestResult.status !== 'ok' && !transientStartupMiss
		}).catch(() => undefined);

		if (latestResult.status === 'ok') {
			if (attempt > 1) {
				console.info(
					`[collector] ${provider.name} recovered on attempt ${attempt}/${MAX_COLLECTION_ATTEMPTS} in ${formatDuration(performance.now() - startedAt)}.`
				);
			}
			return withCollectionDuration(latestResult, startedAt);
		}

		const details = describeCollectionResult(diagnostics);

		if (attempt < MAX_COLLECTION_ATTEMPTS) {
			if (transientStartupMiss) {
				if (DEBUG_COLLECTOR_LOGS) {
					console.info(
						`[collector] ${provider.name} startup redraw only on attempt ${attempt}/${MAX_COLLECTION_ATTEMPTS}; retrying in ${formatDuration(COLLECTION_RETRY_DELAY_MS)}. ${details}`
					);
				}
			} else {
				console.info(
					`[collector] ${provider.name} attempt ${attempt}/${MAX_COLLECTION_ATTEMPTS}: ${latestResult.status} - ${latestResult.message}; retrying in ${formatDuration(COLLECTION_RETRY_DELAY_MS)}. ${details}`
				);
			}
			await delay(COLLECTION_RETRY_DELAY_MS);
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

async function runSlashCommand(providerId: ProviderId, command: string, slashCommand: string) {
	try {
		return await runPtySlashCommand(providerId, command, slashCommand);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown node-pty error';
		console.info(
			`[collector] ${providerId} node-pty path failed; trying pipe fallback. ${message}`
		);
		return await runPipeSlashCommand(providerId, command, slashCommand);
	}
}

async function runPtySlashCommand(providerId: ProviderId, command: string, slashCommand: string) {
	const pty = (await import('node-pty')) as PtyModule;

	return await new Promise<string>((resolve, reject) => {
		let output = '';
		let settled = false;
		let wroteCommand = false;
		let wroteSlashCommand = false;
		let slashReadyTimer: NodeJS.Timeout | undefined;
		let usageSettleTimer: NodeJS.Timeout | undefined;
		const timers = new Set<NodeJS.Timeout>();

		const schedule = (callback: () => void, ms: number) => {
			const timer = setTimeout(() => {
				timers.delete(timer);
				callback();
			}, ms);
			timers.add(timer);
			return timer;
		};

		const terminal = pty.spawn(
			CLI_COLLECTION_CONFIG.shell.command,
			[...CLI_COLLECTION_CONFIG.shell.args],
			{
				name: 'xterm-256color',
				cols: providerId === 'gemini' ? 160 : 120,
				rows: 36,
				cwd: CLI_COLLECTION_CONFIG.workingDirectory,
				env: { ...process.env, ...CLI_COLLECTION_CONFIG.env },
				useConptyDll: true
			}
		);

		const cleanup = () => {
			for (const timer of timers) {
				clearTimeout(timer);
			}
			timers.clear();
			try {
				terminal.kill();
			} catch {
				// The process may already be closed.
			}
		};

		const finish = (value: string) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(value);
		};

		const fail = (message: string) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(new Error(message));
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
			safeWrite(`${slashCommand}\r`, 'Failed to write slash command.');
			if (providerId === 'codex') {
				schedule(() => safeWrite('\r', 'Failed to confirm slash command.'), 400);
			}
			if (providerId === 'gemini') {
				const startedAt = performance.now();
				const confirmUntilMs = Math.max(
					10_000,
					captureTimeoutMs(providerId) - GEMINI_SLASH_CONFIRM_TIMEOUT_BUFFER_MS
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
			if (providerId === 'codex' && shouldWaitForCodexReady(output)) {
				schedule(writeSlashCommandFallback, 1000);
				return;
			}
			writeSlashCommand();
		};

		terminal.onData((chunk) => {
			output = appendCapturedOutput(output, chunk);

			if (!wroteCommand && isShellReady(output)) {
				writeCommand();
			}

			if (wroteCommand && !wroteSlashCommand && isCliReady(providerId, output)) {
				slashReadyTimer ??= schedule(writeSlashCommand, slashReadySettleMs(providerId));
			}

			if (wroteSlashCommand && hasUsageOutput(providerId, output)) {
				if (usageSettleTimer) {
					clearTimeout(usageSettleTimer);
					timers.delete(usageSettleTimer);
				}
				usageSettleTimer = schedule(() => finish(output), usageOutputSettleMs(providerId));
			}
		});

		terminal.onExit(() => finish(output));

		writeCommandWhenShellReady();
		schedule(
			writeSlashCommandFallback,
			CLI_COLLECTION_CONFIG.shellCommandDelayMs + slashDelayMs(providerId)
		);

		schedule(() => finish(output), captureTimeoutMs(providerId));
	});
}

function isShellReady(output: string) {
	return /PS\s+[A-Z]:\\[^>]*>\s*$/i.test(output.slice(-500));
}

function isCliReady(providerId: ProviderId, output: string) {
	const tail = stripTerminalOutput(output.slice(-8000));
	if (providerId === 'claude') {
		return /\? for shortcuts|Advisor Tool|Try ["“]|Welcome back/i.test(tail);
	}
	if (providerId === 'codex') {
		return isCodexReadyTail(tail);
	}
	return /Type your message|workspace\s+\(\/directory\)/i.test(tail);
}

function shouldConfirmGeminiSlashCommand(output: string, slashCommand: string) {
	const tail = stripTerminalOutput(output.slice(-8000));
	if (hasGeminiModelScreenText(tail)) return false;

	return new RegExp(`(?:^|\\n)[^\\n]*>\\s*${escapeRegExp(slashCommand)}\\b`, 'i').test(tail);
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

	return /booting\s+mcp\s+server|model:\s*loading|Use \/skills/i.test(tail);
}

function latestCodexLoadingIndex(tail: string) {
	const loadingMatches = [...tail.matchAll(/booting\s+mcp\s+server|model:\s*loading/gi)];
	return loadingMatches.at(-1)?.index ?? -1;
}

function slashDelayMs(providerId: ProviderId) {
	if (providerId === 'claude') return CLI_COLLECTION_CONFIG.commandDelayMs;
	return Math.max(CLI_COLLECTION_CONFIG.commandDelayMs, 10_000);
}

function captureTimeoutMs(providerId: ProviderId) {
	return (
		CLI_COLLECTION_CONFIG.providerCaptureTimeoutMs[
			providerId as keyof typeof CLI_COLLECTION_CONFIG.providerCaptureTimeoutMs
		] ?? CLI_COLLECTION_CONFIG.captureTimeoutMs
	);
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

async function runPipeSlashCommand(providerId: ProviderId, command: string, slashCommand: string) {
	return await new Promise<string>((resolve, reject) => {
		let output = '';
		let settled = false;

		const child = spawn(command, [], {
			cwd: CLI_COLLECTION_CONFIG.workingDirectory,
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

		const timeoutTimer = setTimeout(finish, captureTimeoutMs(providerId));
	});
}

function hasUsageOutput(providerId: ProviderId, output: string) {
	const parsed = parseProviderUsage(providerId, output);
	if (providerId === 'codex') {
		return parsed.windows.fiveHour.percent !== null && parsed.windows.week.percent !== null;
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

	return { output, rawOutputLength: rawOutput.length, lines, markers, parseDetails, result };
}

function describeCollectionResult(diagnostics: ReturnType<typeof buildCollectionDiagnostics>) {
	const detail = [
		`output=${diagnostics.output.length} chars/${diagnostics.lines.length} lines`,
		`raw=${diagnostics.rawOutputLength} chars`,
		`markers=${diagnostics.markers.length > 0 ? diagnostics.markers.join(',') : 'none'}`
	];
	detail.push(...diagnostics.parseDetails);

	if (DEBUG_COLLECTOR_LOGS && diagnostics.result.rawPreview) {
		detail.push(`tail=${JSON.stringify(diagnostics.result.rawPreview.slice(-500))}`);
	}

	return `(${detail.join('; ')})`;
}

function parseDiagnostics(providerId: ProviderId, markers: string[], result: ProviderUsage) {
	if (providerId === 'codex') {
		if (result.status === 'ok') return [];
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
	if (diagnostics.rawOutputLength < 10_000) return false;
	if (diagnostics.lines.length > 2) return false;
	if (/\/status|5h\s+limit|weekly\s+limit|gpt-[^\r\n]+ · [A-Z]:\\/i.test(diagnostics.output)) {
		return false;
	}

	return true;
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

function delay(ms: number) {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});
}
