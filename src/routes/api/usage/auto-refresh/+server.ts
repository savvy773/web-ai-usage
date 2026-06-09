import { json } from '@sveltejs/kit';
import type { RequestEvent } from './$types';
import { autoRefreshState, configureAutoRefresh } from '$lib/server/usage/auto-refresh';

const NO_STORE_HEADERS = {
	'cache-control': 'no-store'
};

export function GET() {
	return json(autoRefreshState(), { headers: NO_STORE_HEADERS });
}

export async function POST({ request }: RequestEvent) {
	const body = (await request.json().catch(() => null)) as {
		enabled?: unknown;
		intervalMs?: unknown;
	} | null;

	return json(
		configureAutoRefresh({
			enabled: body?.enabled === true,
			intervalMs: Number(body?.intervalMs)
		}),
		{ headers: NO_STORE_HEADERS }
	);
}
