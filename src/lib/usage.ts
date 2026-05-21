export const CLI_COLLECTION_CONFIG = {
	workingDirectory: 'D:\\Code\\_temp',
	shellCommandDelayMs: 500,
	commandDelayMs: 6000,
	captureTimeoutMs: 45_000,
	providerCaptureTimeoutMs: {
		codex: 60_000,
		gemini: 90_000
	},
	shell: {
		command: 'pwsh.exe',
		args: ['-NoLogo', '-NoProfile']
	},
	env: {
		GEMINI_CLI_TRUST_WORKSPACE: 'true'
	}
} as const;

export const PROVIDERS = [
	{
		id: 'claude',
		name: 'Claude',
		command: 'claude',
		slashCommand: '/usage',
		usageUrl: 'https://claude.ai/settings/usage'
	},
	{
		id: 'codex',
		name: 'Codex',
		command: 'codex',
		slashCommand: '/status',
		usageUrl: 'https://chatgpt.com/codex/cloud/settings/analytics#usage'
	},
	{
		id: 'gemini',
		name: 'Gemini CLI',
		command: 'gemini --skip-trust',
		slashCommand: '/model',
		usageUrl: null
	}
] as const;

export type ProviderId = (typeof PROVIDERS)[number]['id'];
export type UsageStatus = 'ok' | 'partial' | 'unavailable';
export type UsageWindowId = 'fiveHour' | 'week';

export type UsageWindow = {
	id: UsageWindowId;
	label: string;
	used: number | null;
	limit: number | null;
	percent: number | null;
	resetAt: string | null;
	remainingText: string | null;
};

export type ModelUsage = {
	label: string;
	percent: number;
	resetAt: string | null;
	remainingText: string | null;
};

export type ProviderUsage = {
	provider: ProviderId;
	name: string;
	command: string;
	slashCommand: string;
	usageUrl: string | null;
	status: UsageStatus;
	message: string;
	collectedAt: string | null;
	collectionDurationMs: number | null;
	windows: Record<UsageWindowId, UsageWindow>;
	modelUsages: ModelUsage[];
	rawPreview: string | null;
};

export type UsageBucket = {
	bucketStart: string;
	collectedAt: string;
	providers: Record<ProviderId, ProviderUsage>;
};

export type UsagePayload = {
	generatedAt: string;
	nextRefreshAt: string;
	providers: ProviderUsage[];
	history: UsageBucket[];
	refreshState?: UsageRefreshState;
};

export type UsageRefreshState = {
	refreshing: boolean;
	startedAt: string | null;
	finishedAt: string | null;
	error: string | null;
};

export function createEmptyWindow(id: UsageWindowId): UsageWindow {
	return {
		id,
		label: id === 'fiveHour' ? 'Current' : 'Week',
		used: null,
		limit: null,
		percent: null,
		resetAt: null,
		remainingText: null
	};
}

export function createUnavailableUsage(
	provider: (typeof PROVIDERS)[number],
	message = 'No data yet'
): ProviderUsage {
	return {
		provider: provider.id,
		name: provider.name,
		command: provider.command,
		slashCommand: provider.slashCommand,
		usageUrl: provider.usageUrl,
		status: 'unavailable',
		message,
		collectedAt: null,
		collectionDurationMs: null,
		windows: {
			fiveHour: createEmptyWindow('fiveHour'),
			week: createEmptyWindow('week')
		},
		modelUsages: [],
		rawPreview: null
	};
}
