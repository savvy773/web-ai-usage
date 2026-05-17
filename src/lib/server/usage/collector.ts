import { spawn } from 'node:child_process';
import { parseProviderUsage } from './parser';
import { PROVIDERS, type ProviderId, type ProviderUsage } from '$lib/usage';

type PtyModule = typeof import('@homebridge/node-pty-prebuilt-multiarch');

const COMMAND_DELAY_MS = 1200;
const CAPTURE_TIMEOUT_MS = 14_000;

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
		const output = await runSlashCommand(provider.command, provider.slashCommand);
		return parseProviderUsage(provider.id, output);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown collection error';
		return parseProviderUsage(provider.id, '', message);
	}
}

async function runSlashCommand(command: string, slashCommand: string) {
	try {
		return await runPtySlashCommand(command, slashCommand);
	} catch {
		return await runPipeSlashCommand(command, slashCommand);
	}
}

async function runPtySlashCommand(command: string, slashCommand: string) {
	const pty = (await import('@homebridge/node-pty-prebuilt-multiarch')) as PtyModule;

	return await new Promise<string>((resolve, reject) => {
		let output = '';
		let settled = false;

		const terminal = pty.spawn(command, [], {
			name: 'xterm-256color',
			cols: 120,
			rows: 36,
			cwd: process.cwd(),
			env: process.env
		});

		const cleanup = () => {
			clearTimeout(commandTimer);
			clearTimeout(timeoutTimer);
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

		terminal.onData((chunk) => {
			output += chunk;
			if (output.length > 20_000) {
				output = output.slice(-20_000);
			}
		});

		terminal.onExit(() => finish(output));

		const commandTimer = setTimeout(() => {
			try {
				terminal.write(`${slashCommand}\r`);
			} catch (error) {
				fail(error instanceof Error ? error.message : 'Failed to write slash command.');
			}
		}, COMMAND_DELAY_MS);

		const timeoutTimer = setTimeout(() => finish(output), CAPTURE_TIMEOUT_MS);
	});
}

async function runPipeSlashCommand(command: string, slashCommand: string) {
	return await new Promise<string>((resolve, reject) => {
		let output = '';
		let settled = false;

		const child = spawn(command, [], {
			cwd: process.cwd(),
			env: process.env,
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
		}, COMMAND_DELAY_MS);

		const timeoutTimer = setTimeout(finish, CAPTURE_TIMEOUT_MS);
	});
}
