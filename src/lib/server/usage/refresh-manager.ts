import { collectAllUsage } from './collector';
import { readUsagePayload, recordUsageSnapshot } from './storage';
import type { UsagePayload, UsageRefreshState } from '$lib/usage';

const PREFETCH_LEAD_MS = 30_000;
const QUICK_REFRESH_WAIT_MS = 2_000;
// Delay the first scheduled refresh after a cold server start so node-pty and
// the CLI subprocesses have time to settle before PTY sessions are opened.
const STARTUP_WARMUP_MS = 10_000;
const serverStartedAt = Date.now();

let activeRefresh: Promise<UsagePayload> | null = null;
let scheduledPrefetch: NodeJS.Timeout | null = null;
let lastStatuses: string | null = null;
let refreshState: UsageRefreshState = {
	refreshing: false,
	startedAt: null,
	finishedAt: null,
	error: null
};

export async function readManagedUsagePayload() {
	const payload = attachRefreshState(await readUsagePayload());
	schedulePrefetch(payload);
	return payload;
}

export async function refreshUsagePayload() {
	const refresh = startRefresh();
	const quickPayload = await Promise.race([refresh, delay(QUICK_REFRESH_WAIT_MS).then(() => null)]);

	if (quickPayload) {
		schedulePrefetch(quickPayload);
		return { payload: attachRefreshState(quickPayload), pending: false };
	}

	const cachedPayload = attachRefreshState(await readUsagePayload());
	return { payload: cachedPayload, pending: true };
}

function startRefresh() {
	if (activeRefresh) return activeRefresh;

	if (scheduledPrefetch) {
		clearTimeout(scheduledPrefetch);
		scheduledPrefetch = null;
	}

	refreshState = {
		refreshing: true,
		startedAt: new Date().toISOString(),
		finishedAt: refreshState.finishedAt,
		error: null
	};

	let snapshotWrite = Promise.resolve<UsagePayload | null>(null);
	const recordProviderResult = (provider: Awaited<ReturnType<typeof collectAllUsage>>[number]) => {
		snapshotWrite = snapshotWrite
			.catch(() => null)
			.then(() => recordUsageSnapshot([provider]))
			.catch((error) => {
				const msg = error instanceof Error ? error.message : 'Failed to record provider snapshot.';
				console.error('[refresh] Provider snapshot error:', msg);
				return null;
			});
	};

	activeRefresh = collectAllUsage(recordProviderResult)
		.then((providers) => {
			const statuses = providers.map((p) => `${p.provider}:${p.status}`).join(' ');
			return snapshotWrite
				.then(() => recordUsageSnapshot(providers))
				.then((payload) => {
					refreshState = {
						refreshing: false,
						startedAt: refreshState.startedAt,
						finishedAt: new Date().toISOString(),
						error: null
					};
					if (statuses !== lastStatuses) {
						const hasError = providers.some((p) => p.status !== 'ok');
						if (hasError) {
							console.warn(`[refresh] ${statuses}`);
						} else if (lastStatuses !== null) {
							console.info(`[refresh] recovered: ${statuses}`);
						}
						lastStatuses = statuses;
					}
					return payload;
				});
		})
		.catch(async (error) => {
			const msg = error instanceof Error ? error.message : 'Failed to refresh usage data.';
			refreshState = {
				refreshing: false,
				startedAt: refreshState.startedAt,
				finishedAt: new Date().toISOString(),
				error: msg
			};
			console.error('[refresh] Error:', msg);
			return await readUsagePayload();
		})
		.finally(() => {
			activeRefresh = null;
			void readUsagePayload()
				.then(schedulePrefetch)
				.catch(() => undefined);
		});

	return activeRefresh;
}

function startupWarmupMs() {
	return Math.max(0, STARTUP_WARMUP_MS - (Date.now() - serverStartedAt));
}

function schedulePrefetch(payload: UsagePayload) {
	if (activeRefresh || scheduledPrefetch) return;

	const nextRefreshAt = Date.parse(payload.nextRefreshAt);
	if (!Number.isFinite(nextRefreshAt)) return;

	const scheduleDelayMs = Math.max(0, nextRefreshAt - Date.now() - PREFETCH_LEAD_MS);
	const delayMs = Math.max(scheduleDelayMs, startupWarmupMs());
	scheduledPrefetch = setTimeout(() => {
		scheduledPrefetch = null;
		void startRefresh();
	}, delayMs);

	if (typeof scheduledPrefetch.unref === 'function') {
		scheduledPrefetch.unref();
	}
}

function attachRefreshState(payload: UsagePayload): UsagePayload {
	return {
		...payload,
		refreshState
	};
}

function delay(ms: number) {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});
}
