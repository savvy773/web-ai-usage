import { json } from '@sveltejs/kit';
import { refreshUsagePayload } from '$lib/server/usage/refresh-manager';

const NO_STORE_HEADERS = {
	'cache-control': 'no-store'
};

export async function POST() {
	const { payload, pending } = await refreshUsagePayload();
	return json(payload, { status: pending ? 202 : 200, headers: NO_STORE_HEADERS });
}
