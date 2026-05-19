import { json } from '@sveltejs/kit';
import { refreshUsagePayload } from '$lib/server/usage/refresh-manager';

export async function POST() {
	const { payload, pending } = await refreshUsagePayload();
	return json(payload, { status: pending ? 202 : 200 });
}
