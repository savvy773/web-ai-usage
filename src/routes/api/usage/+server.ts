import { json } from '@sveltejs/kit';
import { readManagedUsagePayload } from '$lib/server/usage/refresh-manager';

const NO_STORE_HEADERS = {
	'cache-control': 'no-store'
};

export async function GET() {
	return json(await readManagedUsagePayload(), { headers: NO_STORE_HEADERS });
}
