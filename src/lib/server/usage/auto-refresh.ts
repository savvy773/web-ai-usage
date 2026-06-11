import { refreshUsagePayload } from './refresh-manager';

const DEFAULT_AUTO_REFRESH_INTERVAL_MS = 3 * 60 * 1000;
const AUTO_REFRESH_INTERVAL_OPTIONS = new Set([
	1 * 60 * 1000,
	3 * 60 * 1000,
	5 * 60 * 1000,
	10 * 60 * 1000
]);

let enabled = false;
let intervalMs = DEFAULT_AUTO_REFRESH_INTERVAL_MS;
let timer: NodeJS.Timeout | null = null;
let nextRunAt: string | null = null;

export type AutoRefreshConfig = {
	enabled: boolean;
	intervalMs: number;
};

export function configureAutoRefresh(config: AutoRefreshConfig) {
	enabled = config.enabled;
	intervalMs = normalizeAutoRefreshIntervalMs(config.intervalMs);
	scheduleNextAutoRefresh();
	return autoRefreshState();
}

export function autoRefreshState() {
	return {
		enabled,
		intervalMs,
		nextRunAt
	};
}

export function normalizeAutoRefreshIntervalMs(value: number) {
	return AUTO_REFRESH_INTERVAL_OPTIONS.has(value) ? value : DEFAULT_AUTO_REFRESH_INTERVAL_MS;
}

function scheduleNextAutoRefresh() {
	if (timer) {
		clearTimeout(timer);
		timer = null;
	}

	if (!enabled) {
		nextRunAt = null;
		return;
	}

	const nextRunTime = Date.now() + intervalMs;
	nextRunAt = new Date(nextRunTime).toISOString();
	timer = setTimeout(() => {
		timer = null;
		void runAutoRefresh();
	}, intervalMs);
}

async function runAutoRefresh() {
	if (!enabled) return;
	try {
		await refreshUsagePayload();
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Auto refresh failed.';
		console.warn('[auto-refresh] Error:', message);
	} finally {
		scheduleNextAutoRefresh();
	}
}
