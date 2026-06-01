import { pushLog, type LogEntry } from '$lib/server/log-buffer';
import type { Handle } from '@sveltejs/kit';

const ESC = String.fromCharCode(27);

// Skip Vite internal logs that contain ANSI escape codes
const isInternal = (...args: unknown[]) =>
	args.some((a) => typeof a === 'string' && a.includes(`${ESC}[`));

function captureConsole(level: LogEntry['level'], original: (...args: unknown[]) => void) {
	return (...args: unknown[]) => {
		original(...args);
		if (!isInternal(...args)) pushLog(level, ...args);
	};
}

type G = typeof globalThis & {
	__aiConsoleCaptured?: boolean;
	__aiProcessEventsCaptured?: boolean;
	__aiServerStartedLogged?: boolean;
};

const g = globalThis as G;

if (!g.__aiConsoleCaptured) {
	g.__aiConsoleCaptured = true;
	console.log = captureConsole('log', console.log.bind(console));
	console.warn = captureConsole('warn', console.warn.bind(console));
	console.error = captureConsole('error', console.error.bind(console));
	console.info = captureConsole('info', console.info.bind(console));
}

function formatProcessError(value: unknown) {
	if (value instanceof Error) return value.stack ?? value.message;
	if (typeof value === 'string') return value;
	return JSON.stringify(value);
}

if (!g.__aiProcessEventsCaptured) {
	g.__aiProcessEventsCaptured = true;
	process.on('warning', (warning) => {
		pushLog('warn', `[process] ${warning.stack ?? `${warning.name}: ${warning.message}`}`);
	});
	process.on('unhandledRejection', (reason) => {
		pushLog('error', `[process] Unhandled rejection: ${formatProcessError(reason)}`);
	});
	process.on('uncaughtExceptionMonitor', (error) => {
		pushLog('error', `[process] Uncaught exception: ${formatProcessError(error)}`);
	});
}

if (!g.__aiServerStartedLogged) {
	g.__aiServerStartedLogged = true;
	console.info('[server] Started.');
}

export const handle: Handle = ({ event, resolve }) => resolve(event);
