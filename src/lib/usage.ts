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
		command: 'gemini',
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

export type ProviderUsage = {
	provider: ProviderId;
	name: string;
	command: string;
	slashCommand: string;
	usageUrl: string | null;
	status: UsageStatus;
	message: string;
	collectedAt: string | null;
	windows: Record<UsageWindowId, UsageWindow>;
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
};

export function createEmptyWindow(id: UsageWindowId): UsageWindow {
	return {
		id,
		label: id === 'fiveHour' ? '5h' : 'Week',
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
		windows: {
			fiveHour: createEmptyWindow('fiveHour'),
			week: createEmptyWindow('week')
		},
		rawPreview: null
	};
}
