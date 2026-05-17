import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
	createUnavailableUsage,
	PROVIDERS,
	type ProviderId,
	type ProviderUsage,
	type UsageBucket,
	type UsagePayload
} from '$lib/usage';

const DATA_DIR = path.join(process.cwd(), 'data');
const HISTORY_PATH = path.join(DATA_DIR, 'usage-history.json');
const BUCKET_MS = 10 * 60 * 1000;
const MAX_BUCKETS = 6;

type HistoryFile = {
	history: UsageBucket[];
};

export async function readUsagePayload(): Promise<UsagePayload> {
	const history = await readHistory();
	return buildPayload(history);
}

export async function recordUsageSnapshot(providers: ProviderUsage[]): Promise<UsagePayload> {
	const now = new Date();
	const history = await readHistory();
	const bucketStart = new Date(Math.floor(now.getTime() / BUCKET_MS) * BUCKET_MS).toISOString();
	const providerMap = Object.fromEntries(
		providers.map((provider) => [provider.provider, provider])
	) as Record<ProviderId, ProviderUsage>;
	const existingIndex = history.findIndex((bucket) => bucket.bucketStart === bucketStart);

	if (existingIndex >= 0) {
		history[existingIndex] = {
			bucketStart,
			collectedAt: now.toISOString(),
			providers: { ...history[existingIndex].providers, ...providerMap }
		};
	} else {
		history.push({
			bucketStart,
			collectedAt: now.toISOString(),
			providers: providerMap
		});
	}

	const trimmed = history
		.sort((left, right) => Date.parse(left.bucketStart) - Date.parse(right.bucketStart))
		.slice(-MAX_BUCKETS);

	await writeHistory(trimmed);
	return buildPayload(trimmed);
}

async function readHistory(): Promise<UsageBucket[]> {
	try {
		const content = await readFile(HISTORY_PATH, 'utf8');
		const parsed = JSON.parse(content) as HistoryFile;
		return Array.isArray(parsed.history) ? parsed.history : [];
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
		return [];
	}
}

async function writeHistory(history: UsageBucket[]) {
	await mkdir(DATA_DIR, { recursive: true });
	const tempPath = `${HISTORY_PATH}.tmp`;
	await writeFile(tempPath, `${JSON.stringify({ history }, null, 2)}\n`, 'utf8');
	await rename(tempPath, HISTORY_PATH);
}

function buildPayload(history: UsageBucket[]): UsagePayload {
	const generatedAt = new Date();
	const latestProviders = PROVIDERS.map((provider) => {
		for (const bucket of [...history].reverse()) {
			const usage = bucket.providers[provider.id];
			if (usage) return usage;
		}
		return createUnavailableUsage(provider);
	});

	return {
		generatedAt: generatedAt.toISOString(),
		nextRefreshAt: new Date(Math.ceil(generatedAt.getTime() / BUCKET_MS) * BUCKET_MS).toISOString(),
		providers: latestProviders,
		history
	};
}
