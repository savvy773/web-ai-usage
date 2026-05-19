import { json } from '@sveltejs/kit';
import { readManagedUsagePayload } from '$lib/server/usage/refresh-manager';

export async function GET() {
	return json(await readManagedUsagePayload());
}
