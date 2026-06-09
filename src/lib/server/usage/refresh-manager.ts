import { collectAllUsage, type CollectionBackend } from './collector';
import { readUsagePayload, recordUsageSnapshot } from './storage';
import type { UsagePayload, UsageRefreshState } from '$lib/usage';

const QUICK_REFRESH_WAIT_MS = 2_000;

let activeRefresh: Promise<UsagePayload> | null = null;
let lastStatuses: string | null = null;
let refreshState: UsageRefreshState = {
	refreshing: false,
	startedAt: null,
	finishedAt: null,
	error: null
};

export async function readManagedUsagePayload() {
	return attachRefreshState(await readUsagePayload());
}

export async function refreshUsagePayload(options: { backend?: CollectionBackend } = {}) {
	const refresh = startRefresh(options);
	const quickPayload = await Promise.race([refresh, delay(QUICK_REFRESH_WAIT_MS).then(() => null)]);

	if (quickPayload) {
		return { payload: attachRefreshState(quickPayload), pending: false };
	}

	const cachedPayload = attachRefreshState(await readUsagePayload());
	return { payload: cachedPayload, pending: true };
}

function startRefresh(options: { backend?: CollectionBackend } = {}) {
	if (activeRefresh) return activeRefresh;

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

	activeRefresh = collectAllUsage(recordProviderResult, options)
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
		});

	return activeRefresh;
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
