import { json } from '@sveltejs/kit';
import type { RequestEvent } from './$types';
import {
	configureAutoRefresh,
	normalizeAutoRefreshIntervalMs
} from '$lib/server/usage/auto-refresh';
import { readManagedUsagePayload, refreshUsagePayload } from '$lib/server/usage/refresh-manager';

const NO_STORE_HEADERS = {
	'cache-control': 'no-store'
};

export async function POST({ request }: RequestEvent) {
	const refreshMode = request.headers.get('x-ai-usage-refresh-mode');
	if (refreshMode === 'auto') {
		configureAutoRefresh({
			enabled: true,
			intervalMs: normalizeAutoRefreshIntervalMs(
				Number(request.headers.get('x-ai-usage-auto-interval-ms'))
			)
		});
		return json(await readManagedUsagePayload(), { headers: NO_STORE_HEADERS });
	}

	if (refreshMode !== 'manual') {
		return json(await readManagedUsagePayload(), { headers: NO_STORE_HEADERS });
	}

	const { payload, pending } = await refreshUsagePayload();
	return json(payload, { status: pending ? 202 : 200, headers: NO_STORE_HEADERS });
}
