import { readManagedUsagePayload } from '$lib/server/usage/refresh-manager';

export async function load() {
	return {
		initialPayload: await readManagedUsagePayload()
	};
}
