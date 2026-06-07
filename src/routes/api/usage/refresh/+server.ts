import { json } from '@sveltejs/kit';
import type { RequestEvent } from './$types';
import { readManagedUsagePayload, refreshUsagePayload } from '$lib/server/usage/refresh-manager';
import type { UsagePayload } from '$lib/usage';

const NO_STORE_HEADERS = {
	'cache-control': 'no-store'
};
const DEFAULT_AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const AUTO_REFRESH_INTERVAL_OPTIONS = new Set([
	1 * 60 * 1000,
	3 * 60 * 1000,
	5 * 60 * 1000,
	10 * 60 * 1000
]);

export async function POST({ request }: RequestEvent) {
	const refreshMode = request.headers.get('x-ai-usage-refresh-mode');
	const pageActive = request.headers.get('x-ai-usage-page-active') === '1';
	if (refreshMode === 'auto' && !pageActive) {
		return json(deferNextRefresh(await readManagedUsagePayload(), autoRefreshIntervalMs(request)), {
			headers: NO_STORE_HEADERS
		});
	}

	if (refreshMode !== 'manual' && refreshMode !== 'auto') {
		return json(await readManagedUsagePayload(), { headers: NO_STORE_HEADERS });
	}

	const { payload, pending } = await refreshUsagePayload();
	return json(payload, { status: pending ? 202 : 200, headers: NO_STORE_HEADERS });
}

function deferNextRefresh(payload: UsagePayload, intervalMs: number): UsagePayload {
	return {
		...payload,
		nextRefreshAt: new Date(Date.now() + intervalMs).toISOString()
	};
}

function autoRefreshIntervalMs(request: Request) {
	const value = Number(request.headers.get('x-ai-usage-auto-interval-ms'));
	return AUTO_REFRESH_INTERVAL_OPTIONS.has(value) ? value : DEFAULT_AUTO_REFRESH_INTERVAL_MS;
}
