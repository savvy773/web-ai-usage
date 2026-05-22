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
};

const g = globalThis as G;
g.__aiLogBuffer ??= [];
g.__aiLogSubscribers ??= new Set();

const MAX_ENTRIES = 500;
const buffer = g.__aiLogBuffer;
const subscribers = g.__aiLogSubscribers;

export function pushLog(level: LogEntry['level'], ...args: unknown[]) {
	const entry: LogEntry = {
		level,
		message: args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
		timestamp: new Date().toISOString()
	};
	buffer.push(entry);
	if (buffer.length > MAX_ENTRIES) buffer.shift();
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
