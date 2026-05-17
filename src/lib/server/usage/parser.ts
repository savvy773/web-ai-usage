import {
	createEmptyWindow,
	type ProviderId,
	type ProviderUsage,
	PROVIDERS,
	type UsageWindow
} from '$lib/usage';

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function stripTerminalOutput(value: string) {
	return value.replace(ANSI_PATTERN, '').replace(CONTROL_PATTERN, '').replace(/\r/g, '\n');
}

export function parseProviderUsage(
	providerId: ProviderId,
	rawOutput: string,
	errorMessage?: string
): ProviderUsage {
	const provider = PROVIDERS.find((item) => item.id === providerId);
	if (!provider) {
		throw new Error(`Unknown provider: ${providerId}`);
	}

	const output = stripTerminalOutput(rawOutput).trim();
	const lines = output
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);

	const fiveHour = parseWindow(lines, 'fiveHour');
	const week = parseWindow(lines, 'week');
	const hasUsage =
		fiveHour.percent !== null ||
		week.percent !== null ||
		fiveHour.used !== null ||
		week.used !== null;
	const hasOutput = output.length > 0;
	const looksLikeCliProblem =
		/not recognized|command not found|not found|enoent|login|auth|permission denied/i.test(
			`${output}\n${errorMessage ?? ''}`
		);

	return {
		provider: provider.id,
		name: provider.name,
		command: provider.command,
		slashCommand: provider.slashCommand,
		usageUrl: provider.usageUrl,
		status:
			errorMessage || looksLikeCliProblem
				? 'unavailable'
				: hasUsage
					? 'ok'
					: hasOutput
						? 'partial'
						: 'unavailable',
		message: buildMessage(hasUsage, hasOutput, errorMessage),
		collectedAt: new Date().toISOString(),
		windows: { fiveHour, week },
		rawPreview: output.slice(-2000) || null
	};
}

function parseWindow(lines: string[], windowId: 'fiveHour' | 'week'): UsageWindow {
	const window = createEmptyWindow(windowId);
	const candidates = lines.filter((line) =>
		windowId === 'fiveHour'
			? /\b(5\s*h|5\s*hour|five\s*hour|session)\b/i.test(line)
			: /\b(week|weekly|7\s*d|7\s*day)\b/i.test(line)
	);

	const targetLines = candidates.length > 0 ? candidates : lines;
	for (const line of targetLines) {
		const percent = parsePercent(line);
		if (window.percent === null && percent !== null) {
			window.percent = percent;
		}

		const ratio = parseRatio(line);
		if (ratio && window.used === null && window.limit === null) {
			window.used = ratio.used;
			window.limit = ratio.limit;
			window.percent ??=
				ratio.limit > 0 ? Math.min(100, Math.round((ratio.used / ratio.limit) * 1000) / 10) : null;
		}

		const remaining = parseRemainingText(line);
		if (!window.remainingText && remaining) {
			window.remainingText = remaining;
		}
	}

	return window;
}

function parsePercent(line: string) {
	const match = line.match(/(\d+(?:\.\d+)?)\s*%/);
	return match ? clampPercent(Number(match[1])) : null;
}

function parseRatio(line: string) {
	const match = line.match(/(\d+(?:[.,]\d+)?\s*[kKmM]?)\s*(?:\/|of)\s*(\d+(?:[.,]\d+)?\s*[kKmM]?)/);
	if (!match) return null;

	const used = parseCompactNumber(match[1]);
	const limit = parseCompactNumber(match[2]);
	if (used === null || limit === null) return null;

	return { used, limit };
}

function parseCompactNumber(value: string) {
	const normalized = value.trim().replace(',', '');
	const match = normalized.match(/^(\d+(?:\.\d+)?)\s*([kKmM])?$/);
	if (!match) return null;

	const number = Number(match[1]);
	const suffix = match[2]?.toLowerCase();
	if (suffix === 'm') return number * 1_000_000;
	if (suffix === 'k') return number * 1_000;
	return number;
}

function parseRemainingText(line: string) {
	if (!/\b(reset|resets|renews|remaining|left|until|available)\b/i.test(line)) return null;

	const duration = line.match(
		/(?:(\d+)\s*d(?:ays?)?)?\s*(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?/i
	);
	if (duration?.[0]?.trim()) return duration[0].trim();

	return line.replace(/\s+/g, ' ').slice(0, 80);
}

function clampPercent(value: number) {
	if (!Number.isFinite(value)) return null;
	return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function buildMessage(hasUsage: boolean, hasOutput: boolean, errorMessage?: string) {
	if (errorMessage) return errorMessage;
	if (hasUsage) return 'Usage data parsed from CLI output.';
	if (hasOutput) return 'CLI responded, but usage values were not found.';
	return 'CLI returned no output.';
}
