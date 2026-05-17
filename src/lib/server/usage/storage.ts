import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
	createEmptyWindow,
	createUnavailableUsage,
	type ModelUsage,
	PROVIDERS,
	type ProviderId,
	type ProviderUsage,
	type UsageBucket,
	type UsagePayload
} from '$lib/usage';

const DATA_DIR = path.join(process.cwd(), 'data');
const HISTORY_PATH = path.join(DATA_DIR, 'usage-history.json');
const BUCKET_MS = 10 * 60 * 1000;
const MAX_BUCKETS = 5;

type HistoryFile = {
	history: StoredUsageBucket[];
};

type StoredUsageWindow = {
	used?: number | null;
	limit?: number | null;
	percent?: number | null;
	resetAt?: string | null;
	remainingText?: string | null;
};

type StoredProviderUsage = {
	status?: ProviderUsage['status'];
	message?: string;
	collectedAt?: string | null;
	windows?: {
		fiveHour?: StoredUsageWindow;
		week?: StoredUsageWindow;
	};
	modelUsages?: ModelUsage[];
};

type StoredUsageBucket = {
	bucketStart: string;
	collectedAt: string;
	providers: Partial<Record<ProviderId, StoredProviderUsage | ProviderUsage>>;
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
		providers.map((provider) => [provider.provider, compactProviderUsage(provider)])
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
		.slice(-MAX_BUCKETS)
		.map(compactBucket);

	await writeHistory(trimmed);
	return buildPayload(trimmed);
}

function compactProviderUsage(provider: ProviderUsage): ProviderUsage {
	return {
		...provider,
		rawPreview: null
	};
}

function compactBucket(bucket: UsageBucket): UsageBucket {
	return {
		...bucket,
		providers: Object.fromEntries(
			Object.entries(bucket.providers).map(([providerId, provider]) => [
				providerId,
				compactProviderUsage(provider)
			])
		) as Record<ProviderId, ProviderUsage>
	};
}

async function readHistory(): Promise<UsageBucket[]> {
	try {
		const content = await readFile(HISTORY_PATH, 'utf8');
		const parsed = JSON.parse(content) as HistoryFile;
		return Array.isArray(parsed.history) ? parsed.history.map(inflateBucket) : [];
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
		return [];
	}
}

async function writeHistory(history: UsageBucket[]) {
	await mkdir(DATA_DIR, { recursive: true });
	const tempPath = `${HISTORY_PATH}.tmp`;
	await writeFile(
		tempPath,
		`${JSON.stringify({ history: history.map(toStoredBucket) }, null, 2)}\n`,
		'utf8'
	);
	await rename(tempPath, HISTORY_PATH);
}

function inflateBucket(bucket: StoredUsageBucket): UsageBucket {
	return {
		bucketStart: bucket.bucketStart,
		collectedAt: bucket.collectedAt,
		providers: Object.fromEntries(
			PROVIDERS.map((provider) => [
				provider.id,
				inflateProviderUsage(provider.id, bucket.providers[provider.id])
			])
		) as Record<ProviderId, ProviderUsage>
	};
}

function inflateProviderUsage(
	providerId: ProviderId,
	stored: StoredProviderUsage | ProviderUsage | undefined
): ProviderUsage {
	const provider = PROVIDERS.find((item) => item.id === providerId);
	if (!provider) {
		throw new Error(`Unknown provider: ${providerId}`);
	}

	const fallback = createUnavailableUsage(provider);
	const windows = stored?.windows ?? {};

	return {
		...fallback,
		status: stored?.status ?? fallback.status,
		message: stored?.message ?? fallback.message,
		collectedAt: stored?.collectedAt ?? fallback.collectedAt,
		windows: {
			fiveHour: { ...createEmptyWindow('fiveHour'), ...windows.fiveHour },
			week: { ...createEmptyWindow('week'), ...windows.week }
		},
		modelUsages: stored?.modelUsages ?? [],
		rawPreview: null
	};
}

function toStoredBucket(bucket: UsageBucket): StoredUsageBucket {
	return {
		bucketStart: bucket.bucketStart,
		collectedAt: bucket.collectedAt,
		providers: Object.fromEntries(
			Object.entries(bucket.providers).map(([providerId, provider]) => [
				providerId,
				toStoredProviderUsage(provider)
			])
		) as Partial<Record<ProviderId, StoredProviderUsage>>
	};
}

function toStoredProviderUsage(provider: ProviderUsage): StoredProviderUsage {
	const fiveHour = toStoredWindow(provider.windows.fiveHour);
	const week = toStoredWindow(provider.windows.week);
	const hasFiveHour = Object.keys(fiveHour).length > 0;
	const hasWeek = Object.keys(week).length > 0;

	return {
		status: provider.status,
		message: provider.message,
		collectedAt: provider.collectedAt,
		windows:
			hasFiveHour || hasWeek
				? {
						...(hasFiveHour ? { fiveHour } : {}),
						...(hasWeek ? { week } : {})
					}
				: undefined,
		modelUsages: provider.modelUsages.length > 0 ? provider.modelUsages : undefined
	};
}

function toStoredWindow(window: ProviderUsage['windows']['fiveHour']): StoredUsageWindow {
	return Object.fromEntries(
		Object.entries({
			used: window.used,
			limit: window.limit,
			percent: window.percent,
			resetAt: window.resetAt,
			remainingText: window.remainingText
		}).filter(([, value]) => value !== null && value !== undefined)
	) as StoredUsageWindow;
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
