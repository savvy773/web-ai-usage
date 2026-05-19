import { pushLog } from '$lib/server/log-buffer';
import type { Handle } from '@sveltejs/kit';

const _log = console.log.bind(console);
const _warn = console.warn.bind(console);
const _error = console.error.bind(console);
const _info = console.info.bind(console);

// Skip Vite internal logs that contain ANSI escape codes
const isInternal = (...args: unknown[]) =>
	args.some((a) => typeof a === 'string' && /\x1b\[/.test(a));

console.log = (...args) => { _log(...args); if (!isInternal(...args)) pushLog('log', ...args); };
console.warn = (...args) => { _warn(...args); if (!isInternal(...args)) pushLog('warn', ...args); };
console.error = (...args) => { _error(...args); if (!isInternal(...args)) pushLog('error', ...args); };
console.info = (...args) => { _info(...args); if (!isInternal(...args)) pushLog('info', ...args); };

console.info('[server] Started.');

export const handle: Handle = ({ event, resolve }) => resolve(event);
