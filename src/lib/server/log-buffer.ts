import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { LOG_DIR } from '$lib/server/file-paths';

export interface LogEntry {
	level: 'log' | 'info' | 'warn' | 'error';
	message: string;
	timestamp: string;
}

// Use globalThis so all module instances in the same Node.js process share
// the same buffer and subscriber set (Vite dev server loads modules in isolation).
type G = typeof globalThis & {
	__aiLogBuffer?: LogEntry[];
	__aiLogSubscribers?: Set<(entry: LogEntry) => void>;
	__aiLogFileQueues?: Map<string, Promise<void>>;
};

const g = globalThis as G;
g.__aiLogBuffer ??= [];
g.__aiLogSubscribers ??= new Set();
g.__aiLogFileQueues ??= new Map();

const MAX_ENTRIES = 500;
const buffer = g.__aiLogBuffer;
const subscribers = g.__aiLogSubscribers;
const fileQueues = g.__aiLogFileQueues;

export function pushLog(level: LogEntry['level'], ...args: unknown[]) {
	const entry: LogEntry = {
		level,
		message: args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
		timestamp: new Date().toISOString()
	};
	buffer.push(entry);
	if (buffer.length > MAX_ENTRIES) buffer.shift();
	writeLogFiles(entry);
	subscribers.forEach((sub) => sub(entry));
}

export function getBuffer(): LogEntry[] {
	return [...buffer];
}

export function clearBuffer() {
	buffer.length = 0;
}

export function subscribe(fn: (entry: LogEntry) => void): () => void {
	subscribers.add(fn);
	return () => subscribers.delete(fn);
}

function writeLogFiles(entry: LogEntry) {
	const line = formatLogEntry(entry);
	appendManagedLog('server.log', line);

	if (entry.level === 'warn' || entry.level === 'error') {
		appendManagedLog('server-error.log', line);
	}

	if (entry.message.startsWith('[collector]')) {
		appendManagedLog('collector.log', line);
	}
}

function appendManagedLog(fileName: string, line: string) {
	const filePath = path.join(LOG_DIR, fileName);
	const previous = fileQueues.get(filePath) ?? Promise.resolve();
	const next = previous
		.catch(() => undefined)
		.then(async () => {
			await mkdir(LOG_DIR, { recursive: true });
			await appendFile(filePath, line, 'utf8');
		})
		.catch(() => undefined);

	fileQueues.set(filePath, next);
}

function formatLogEntry(entry: LogEntry) {
	return `[${entry.timestamp}] [${entry.level}] ${entry.message}\n`;
}
