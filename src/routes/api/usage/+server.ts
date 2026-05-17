import { json } from '@sveltejs/kit';
import { readUsagePayload } from '$lib/server/usage/storage';

export async function GET() {
	return json(await readUsagePayload());
}
