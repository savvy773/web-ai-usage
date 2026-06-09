import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, USAGE_HISTORY_PATH, USAGE_LATEST_PATH } from '$lib/server/file-paths';
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

const BUCKET_MS = 10 * 60 * 1000;
const MAX_BUCKETS = 12;
const MIN_BUCKETS = 5;
const LATEST_BUCKETS = 6;

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
	collectionDurationMs?: number | null;
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
		providers.map((provider) => [
			provider.provider,
			compactProviderUsage(resolveProviderSnapshot(provider, history))
		])
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
		.slice(-Math.max(MIN_BUCKETS, MAX_BUCKETS))
		.map(compactBucket);

	await writeHistory(trimmed);
	const payload = buildPayload(trimmed);
	await writeLatestPayload(payload);
	return payload;
}

function compactProviderUsage(provider: ProviderUsage): ProviderUsage {
	return {
		...provider,
		rawPreview: null
	};
}

function resolveProviderSnapshot(provider: ProviderUsage, history: UsageBucket[]): ProviderUsage {
	const previous = findLatestUsableProvider(history, provider.provider);
	if (provider.status === 'ok') {
		return previous ? fillMissingWindowResets(provider, previous) : provider;
	}

	if (!previous) return provider;

	console.warn(
		`[storage] Keeping previous ${provider.provider} usage after ${provider.status}: ${provider.message}`
	);

	return {
		...previous,
		status: 'ok',
		message: `Previous data kept; latest refresh ${provider.status}: ${provider.message}`,
		collectionDurationMs: provider.collectionDurationMs,
		rawPreview: provider.rawPreview
	};
}

function fillMissingWindowResets(provider: ProviderUsage, previous: ProviderUsage): ProviderUsage {
	return {
		...provider,
		windows: {
			fiveHour: fillMissingWindowReset(provider.windows.fiveHour, previous.windows.fiveHour),
			week: fillMissingWindowReset(provider.windows.week, previous.windows.week)
		}
	};
}

function fillMissingWindowReset(
	window: ProviderUsage['windows']['fiveHour'],
	previous: ProviderUsage['windows']['fiveHour']
): ProviderUsage['windows']['fiveHour'] {
	if (window.resetAt || window.percent === null || !isFutureReset(previous.resetAt)) return window;

	return {
		...window,
		resetAt: previous.resetAt,
		remainingText: window.remainingText ?? previous.remainingText
	};
}

function isFutureReset(value: string | null) {
	if (!value) return false;
	const resetTime = Date.parse(value);
	return Number.isFinite(resetTime) && resetTime > Date.now();
}

function findLatestUsableProvider(
	history: UsageBucket[],
	providerId: ProviderId
): ProviderUsage | null {
	for (let index = history.length - 1; index >= 0; index -= 1) {
		const provider = history[index].providers[providerId];
		if (provider && isUsableProvider(provider)) return provider;
	}
	return null;
}

function isUsableProvider(provider: ProviderUsage) {
	return (
		provider.modelUsages.length > 0 ||
		provider.windows.fiveHour.percent !== null ||
		provider.windows.week.percent !== null ||
		provider.windows.fiveHour.used !== null ||
		provider.windows.week.used !== null
	);
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
		const content = await readFile(USAGE_HISTORY_PATH, 'utf8');
		const parsed = JSON.parse(content) as HistoryFile;
		if (Array.isArray(parsed.history)) {
			return parsed.history.map((bucket) => {
				const providers = bucket.providers as unknown as Record<string, unknown>;
				if (providers && 'gemini' in providers && !('agy' in providers)) {
					providers.agy = providers.gemini;
					delete providers.gemini;
				}
				return inflateBucket(bucket);
			});
		}
		return [];
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
		return [];
	}
}

async function writeHistory(history: UsageBucket[]) {
	await mkdir(DATA_DIR, { recursive: true });
	const tempPath = path.join(DATA_DIR, `usage-history.${process.pid}.${Date.now()}.tmp`);
	try {
		await writeFile(
			tempPath,
			`${JSON.stringify({ history: history.map(toStoredBucket) }, null, 2)}\n`,
			'utf8'
		);
		await rename(tempPath, USAGE_HISTORY_PATH);
	} catch (error) {
		await unlink(tempPath).catch(() => undefined);
		throw error;
	}
}

async function writeLatestPayload(payload: UsagePayload) {
	await mkdir(DATA_DIR, { recursive: true });
	const tempPath = path.join(DATA_DIR, `usage-latest.${process.pid}.${Date.now()}.tmp`);
	const latestPayload: UsagePayload = {
		...payload,
		history: payload.history.slice(-LATEST_BUCKETS)
	};

	try {
		await writeFile(tempPath, `${JSON.stringify(latestPayload, null, 2)}\n`, 'utf8');
		await rename(tempPath, USAGE_LATEST_PATH);
	} catch (error) {
		await unlink(tempPath).catch(() => undefined);
		throw error;
	}
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
		collectionDurationMs: stored?.collectionDurationMs ?? fallback.collectionDurationMs,
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
		collectionDurationMs: provider.collectionDurationMs,
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
	const latestProviders = PROVIDERS.map((provider) =>
		restoreLatestProviderFromHistory(provider.id, history)
	);

	const latestCollectedAt = history
		.map((bucket) => Date.parse(bucket.collectedAt))
		.filter(Number.isFinite)
		.sort((left, right) => right - left)[0];
	const refreshBaseMs = latestCollectedAt ?? generatedAt.getTime() - BUCKET_MS;

	return {
		generatedAt: generatedAt.toISOString(),
		nextRefreshAt: new Date(refreshBaseMs + BUCKET_MS).toISOString(),
		providers: latestProviders,
		history
	};
}

function restoreLatestProviderFromHistory(
	providerId: ProviderId,
	history: UsageBucket[]
): ProviderUsage {
	let latest: ProviderUsage | null = null;
	for (let index = history.length - 1; index >= 0; index -= 1) {
		const usage = history[index].providers[providerId];
		if (usage) {
			latest = usage;
			break;
		}
	}

	if (!latest) {
		const provider = PROVIDERS.find((item) => item.id === providerId);
		if (!provider) throw new Error(`Unknown provider: ${providerId}`);
		return createUnavailableUsage(provider);
	}

	if (isUsableProvider(latest)) return latest;

	const previous = findLatestUsableProvider(history, providerId);
	if (!previous) return latest;

	return {
		...previous,
		status: 'ok' as const,
		message: `Previous data kept; latest stored ${latest.status}: ${latest.message}`,
		collectionDurationMs: latest.collectionDurationMs,
		rawPreview: latest.rawPreview
	};
}
