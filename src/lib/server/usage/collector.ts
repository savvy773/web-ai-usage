import { spawn } from 'node:child_process';
import { parseProviderUsage, stripTerminalOutput } from './parser';
import { CLI_COLLECTION_CONFIG, PROVIDERS, type ProviderId, type ProviderUsage } from '$lib/usage';

type PtyModule = typeof import('node-pty');

const USAGE_OUTPUT_SETTLE_MS = 1200;
const MAX_CAPTURE_CHARS = 20_000;
const MAX_COLLECTION_ATTEMPTS = 3;
const COLLECTION_RETRY_DELAY_MS = 1500;
const DEBUG_COLLECTOR_LOGS = process.env.AI_USAGE_DEBUG_LOGS === '1';

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

		if (latestResult.status === 'ok') {
			if (attempt > 1) {
				console.info(
					`[collector] ${provider.name} recovered on attempt ${attempt}/${MAX_COLLECTION_ATTEMPTS} in ${formatDuration(performance.now() - startedAt)}.`
				);
			}
			return withCollectionDuration(latestResult, startedAt);
		}

		const details = describeCollectionResult(provider.id, output, latestResult);

		if (attempt < MAX_COLLECTION_ATTEMPTS) {
			console.info(
				`[collector] ${provider.name} attempt ${attempt}/${MAX_COLLECTION_ATTEMPTS}: ${latestResult.status} - ${latestResult.message}; retrying in ${formatDuration(COLLECTION_RETRY_DELAY_MS)}. ${details}`
			);
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
				cols: 120,
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

		const writeSlashCommand = () => {
			if (wroteSlashCommand) return;
			wroteSlashCommand = true;
			safeWrite(`${slashCommand}\r`, 'Failed to write slash command.');
			if (providerId === 'codex') {
				schedule(() => safeWrite('\r', 'Failed to confirm slash command.'), 400);
			}
			if (providerId === 'gemini') {
				for (const delayMs of [800, 2000, 5000]) {
					schedule(() => {
						const tail = output.slice(-3000);
						if (
							new RegExp(`>\\s*${escapeRegExp(slashCommand)}`).test(tail) &&
							!/Select Model|Model usage/i.test(tail)
						) {
							safeWrite('\r', 'Failed to confirm slash command.');
						}
					}, delayMs);
				}
			}
		};

		terminal.onData((chunk) => {
			output = appendCapturedOutput(output, chunk);

			if (!wroteCommand && isShellReady(output)) {
				writeCommand();
			}

			if (wroteCommand && !wroteSlashCommand && isCliReady(providerId, output)) {
				slashReadyTimer ??= schedule(writeSlashCommand, 350);
			}

			if (wroteSlashCommand && !usageSettleTimer && hasUsageOutput(providerId, output)) {
				usageSettleTimer = schedule(() => finish(output), USAGE_OUTPUT_SETTLE_MS);
			}
		});

		terminal.onExit(() => finish(output));

		schedule(writeCommand, CLI_COLLECTION_CONFIG.shellCommandDelayMs);
		schedule(
			writeSlashCommand,
			CLI_COLLECTION_CONFIG.shellCommandDelayMs + slashDelayMs(providerId)
		);

		schedule(() => finish(output), captureTimeoutMs(providerId));
	});
}

function isShellReady(output: string) {
	return /PS\s+[A-Z]:\\[^>]*>\s*$/i.test(output.slice(-500));
}

function isCliReady(providerId: ProviderId, output: string) {
	const tail = output.slice(-4000);
	if (providerId === 'claude') {
		return /\? for shortcuts|Advisor Tool|Try ["“]|Welcome back/i.test(tail);
	}
	if (providerId === 'codex') {
		return (
			/Use \/skills/i.test(tail) ||
			(/gpt-[^\r\n]+ · [A-Z]:\\/i.test(tail) && !/Booting MCP server/i.test(tail))
		);
	}
	return /Type your message|workspace\s+\(\/directory\)/i.test(tail);
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
	if (providerId === 'codex') {
		return hasCodexLimitLines(output);
	}

	const parsed = parseProviderUsage(providerId, output);
	return parsed.status === 'ok';
}

function hasCodexLimitLines(output: string) {
	const lines = stripTerminalOutput(output)
		.split('\n')
		.map((line) => line.trim());

	return (
		lines.some((line) => /(?:^|[│\s])5h\s+limit\s*:/i.test(line)) &&
		lines.some((line) => /(?:^|[│\s])(weekly|week)\s+limit\s*:/i.test(line))
	);
}

function appendCapturedOutput(output: string, chunk: string) {
	const nextOutput = output + chunk;
	return nextOutput.length > MAX_CAPTURE_CHARS ? nextOutput.slice(-MAX_CAPTURE_CHARS) : nextOutput;
}

function describeCollectionResult(
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
	const detail = [
		`output=${output.length} chars/${lines.length} lines`,
		`markers=${markers.length > 0 ? markers.join(',') : 'none'}`
	];

	if (DEBUG_COLLECTOR_LOGS && result.rawPreview) {
		detail.push(`tail=${JSON.stringify(result.rawPreview.slice(-500))}`);
	}

	return `(${detail.join('; ')})`;
}

function usageMarkers(providerId: ProviderId, lines: string[]) {
	if (providerId === 'codex') {
		return [
			lines.some((line) => /(?:^|[│\s])5h\s+limit\s*:/i.test(line)) ? '5h-limit' : null,
			lines.some((line) => /(?:^|[│\s])(weekly|week)\s+limit\s*:/i.test(line)) ? 'week-limit' : null
		].filter((marker): marker is string => marker !== null);
	}

	if (providerId === 'gemini') {
		return [
			lines.some((line) => /model usage|select model/i.test(line)) ? 'model-screen' : null,
			lines.some((line) => /\b(?:flash|pro)\b/i.test(line)) ? 'model-name' : null,
			lines.some((line) => /\d+(?:\.\d+)?\s*%/.test(line)) ? 'percent' : null,
			lines.some((line) => /\d+(?:\.\d+)?\s*%\s+Resets?\s*:/i.test(line)) ? 'percent-reset' : null
		].filter((marker): marker is string => marker !== null);
	}

	return [
		lines.some((line) => /\busage\b/i.test(line)) ? 'usage-word' : null,
		lines.some((line) => /\d+(?:\.\d+)?\s*%/.test(line)) ? 'percent' : null
	].filter((marker): marker is string => marker !== null);
}

function formatDuration(ms: number) {
	return `${(ms / 1000).toFixed(1)}s`;
}

function delay(ms: number) {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});
}
