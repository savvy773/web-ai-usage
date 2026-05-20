import { spawn } from 'node:child_process';
import { parseProviderUsage, stripTerminalOutput } from './parser';
import { CLI_COLLECTION_CONFIG, PROVIDERS, type ProviderId, type ProviderUsage } from '$lib/usage';

type PtyModule = typeof import('node-pty');

const USAGE_OUTPUT_SETTLE_MS = 1200;
const MAX_CAPTURE_CHARS = 20_000;

export async function collectAllUsage(): Promise<ProviderUsage[]> {
	const results = await Promise.all(PROVIDERS.map((provider) => collectProvider(provider.id)));
	return results;
}

async function collectProvider(providerId: ProviderId): Promise<ProviderUsage> {
	const provider = PROVIDERS.find((item) => item.id === providerId);
	if (!provider) {
		throw new Error(`Unknown provider: ${providerId}`);
	}

	const startedAt = performance.now();

	try {
		const output = await runSlashCommand(provider.id, provider.command, provider.slashCommand);
		return withCollectionDuration(parseProviderUsage(provider.id, output), startedAt);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown collection error';
		return withCollectionDuration(parseProviderUsage(provider.id, '', message), startedAt);
	}
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
	} catch {
		return await runPipeSlashCommand(command, slashCommand);
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
				schedule(() => {
					const tail = output.slice(-3000);
					if (
						new RegExp(`>\\s*${escapeRegExp(slashCommand)}`).test(tail) &&
						!/Select Model|Model usage/i.test(tail)
					) {
						safeWrite('\r', 'Failed to confirm slash command.');
					}
				}, 800);
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
		if (providerId !== 'gemini') {
			schedule(
				writeSlashCommand,
				CLI_COLLECTION_CONFIG.shellCommandDelayMs + slashDelayMs(providerId)
			);
		}

		schedule(() => finish(output), CLI_COLLECTION_CONFIG.captureTimeoutMs);
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

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function runPipeSlashCommand(command: string, slashCommand: string) {
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

		const timeoutTimer = setTimeout(finish, CLI_COLLECTION_CONFIG.captureTimeoutMs);
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
