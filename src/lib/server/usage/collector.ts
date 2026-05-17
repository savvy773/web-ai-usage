import { spawn } from 'node:child_process';
import { parseProviderUsage } from './parser';
import { CLI_COLLECTION_CONFIG, PROVIDERS, type ProviderId, type ProviderUsage } from '$lib/usage';

type PtyModule = typeof import('node-pty');

export async function collectAllUsage(): Promise<ProviderUsage[]> {
	const results = await Promise.all(PROVIDERS.map((provider) => collectProvider(provider.id)));
	return results;
}

async function collectProvider(providerId: ProviderId): Promise<ProviderUsage> {
	const provider = PROVIDERS.find((item) => item.id === providerId);
	if (!provider) {
		throw new Error(`Unknown provider: ${providerId}`);
	}

	try {
		const output = await runSlashCommand(provider.id, provider.command, provider.slashCommand);
		return parseProviderUsage(provider.id, output);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown collection error';
		return parseProviderUsage(provider.id, '', message);
	}
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
			clearTimeout(shellCommandTimer);
			if (slashCommandTimer) clearTimeout(slashCommandTimer);
			clearTimeout(timeoutTimer);
			if (slashReadyTimer) clearTimeout(slashReadyTimer);
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

		const writeCommand = () => {
			if (wroteCommand) return;
			wroteCommand = true;
			try {
				terminal.write(`${command}\r`);
			} catch (error) {
				fail(error instanceof Error ? error.message : 'Failed to write CLI command.');
			}
		};

		const writeSlashCommand = () => {
			if (wroteSlashCommand) return;
			wroteSlashCommand = true;
			try {
				terminal.write(`${slashCommand}\r`);
				if (providerId === 'codex') {
					setTimeout(() => terminal.write('\r'), 400);
				}
				if (providerId === 'gemini') {
					setTimeout(() => {
						const tail = output.slice(-3000);
						if (
							new RegExp(`>\\s*${escapeRegExp(slashCommand)}`).test(tail) &&
							!/Select Model|Model usage/i.test(tail)
						) {
							terminal.write('\r');
						}
					}, 800);
				}
			} catch (error) {
				fail(error instanceof Error ? error.message : 'Failed to write slash command.');
			}
		};

		terminal.onData((chunk) => {
			output += chunk;
			if (output.length > 20_000) {
				output = output.slice(-20_000);
			}

			if (!wroteCommand && isShellReady(output)) {
				writeCommand();
			}

			if (wroteCommand && !wroteSlashCommand && isCliReady(providerId, output)) {
				slashReadyTimer ??= setTimeout(writeSlashCommand, 350);
			}
		});

		terminal.onExit(() => finish(output));

		const shellCommandTimer = setTimeout(writeCommand, CLI_COLLECTION_CONFIG.shellCommandDelayMs);
		const slashCommandTimer =
			providerId === 'gemini'
				? undefined
				: setTimeout(
						writeSlashCommand,
						CLI_COLLECTION_CONFIG.shellCommandDelayMs + slashDelayMs(providerId)
					);

		const timeoutTimer = setTimeout(() => finish(output), CLI_COLLECTION_CONFIG.captureTimeoutMs);
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
			output += chunk.toString('utf8');
			if (output.length > 20_000) output = output.slice(-20_000);
		});

		child.stderr.on('data', (chunk: Buffer) => {
			output += chunk.toString('utf8');
			if (output.length > 20_000) output = output.slice(-20_000);
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
