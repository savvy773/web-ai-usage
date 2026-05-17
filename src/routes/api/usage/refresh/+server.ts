import { json } from '@sveltejs/kit';
import { collectAllUsage } from '$lib/server/usage/collector';
import { recordUsageSnapshot } from '$lib/server/usage/storage';

let activeRefresh: Promise<Response> | null = null;

export async function POST() {
	activeRefresh ??= collectAllUsage()
		.then((providers) => recordUsageSnapshot(providers))
		.then((payload) => json(payload))
		.finally(() => {
			activeRefresh = null;
		});

	return activeRefresh;
}
