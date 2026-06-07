function envValue(name: string) {
	return typeof process === 'undefined' ? undefined : process.env[name];
}

function runtimeWorkingDirectory() {
	try {
		return typeof process !== 'undefined' && typeof process.cwd === 'function'
			? process.cwd()
			: '.';
	} catch {
		return '.';
	}
}

function defaultTempWorkingDirectories() {
	return [envValue('TEMP'), envValue('TMP')].filter((value): value is string => Boolean(value));
}

function parentWorkingDirectory(value: string) {
	const normalized = value.replace(/[\\/]+$/, '');
	const index = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'));
	return index > 0 ? normalized.slice(0, index) : '';
}

function baseWorkingDirectoryName(value: string) {
	const normalized = value.replace(/[\\/]+$/, '');
	const index = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'));
	return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function workspaceTempWorkingDirectory() {
	const projectRoot = runtimeWorkingDirectory();
	const parent = parentWorkingDirectory(projectRoot);
	const grandparent = parentWorkingDirectory(parent);
	if (baseWorkingDirectoryName(parent).toLowerCase() !== '_toolkit') return '';
	return grandparent ? `${grandparent}\\_temp` : '';
}

function isAbsoluteWorkingDirectory(value: string) {
	return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) || value.startsWith('/');
}

function resolveWorkingDirectory(value: string) {
	if (!value) return value;
	if (isAbsoluteWorkingDirectory(value)) return value;
	return `${runtimeWorkingDirectory()}\\${value.replace(/^[\\/]+/, '')}`;
}

function expandWorkingDirectory(value: string) {
	return value
		.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_, name: string) => envValue(name) ?? '')
		.replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, name: string) => envValue(name) ?? '')
		.trim();
}

function splitWorkingDirectories(value: string | undefined) {
	if (!value) return [];
	return value
		.split(';')
		.map((item) => expandWorkingDirectory(item.trim().replace(/^["']|["']$/g, '')))
		.map(resolveWorkingDirectory)
		.filter(Boolean);
}

function uniqueWorkingDirectories(values: string[]) {
	const seen = new Set<string>();
	return values.filter((value) => {
		const key = value.toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function configuredWorkingDirectories() {
	return uniqueWorkingDirectories([
		...splitWorkingDirectories(envValue('AI_USAGE_CWD')),
		...splitWorkingDirectories(envValue('AI_USAGE_CWD_CANDIDATES'))
	]).filter(Boolean);
}

function defaultWorkingDirectories() {
	return uniqueWorkingDirectories([
		workspaceTempWorkingDirectory(),
		...defaultTempWorkingDirectories()
	]).filter(Boolean);
}

function limitWorkingDirectories(values: string[]) {
	return values.slice(0, 3);
}

const CONFIGURED_WORKING_DIRECTORIES = configuredWorkingDirectories();

export const CLI_WORKING_DIRECTORIES = (
	CONFIGURED_WORKING_DIRECTORIES.length > 0
		? CONFIGURED_WORKING_DIRECTORIES
		: defaultWorkingDirectories()
).filter(Boolean);

export const CLI_COLLECTION_CONFIG = {
	workingDirectory: CLI_WORKING_DIRECTORIES[0] ?? '.',
	workingDirectories:
		CLI_WORKING_DIRECTORIES.length > 0 ? CLI_WORKING_DIRECTORIES : [runtimeWorkingDirectory()],
	shellCommandDelayMs: 500,
	commandDelayMs: 6000,
	captureTimeoutMs: 45_000,
	providerCaptureTimeoutMs: {
		codex: 90_000,
		gemini: 105_000
	},
	shell: {
		command: 'pwsh.exe',
		args: [
			'-NoLogo',
			'-NoProfile',
			'-NoExit',
			'-WindowStyle',
			'Hidden',
			'-Command',
			'try { Set-PSReadLineOption -PredictionSource None -ErrorAction SilentlyContinue } catch {}'
		]
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
		name: 'Antigravity',
		command: 'agy --dangerously-skip-permissions',
		slashCommand: '/usage',
		usageUrl: null
	}
] as const;

export type ProviderId = (typeof PROVIDERS)[number]['id'];

export function providerWorkingDirectories(providerId: ProviderId) {
	const suffix = providerId.toUpperCase();
	const providerDirectories = uniqueWorkingDirectories([
		...splitWorkingDirectories(envValue(`AI_USAGE_CWD_${suffix}`)),
		...splitWorkingDirectories(envValue(`AI_USAGE_CWD_CANDIDATES_${suffix}`)),
		...CLI_COLLECTION_CONFIG.workingDirectories
	]).filter(Boolean);

	return limitWorkingDirectories(
		providerDirectories.length > 0 ? providerDirectories : CLI_COLLECTION_CONFIG.workingDirectories
	);
}

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
		label: id === 'fiveHour' ? '5h Current' : 'Week',
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
