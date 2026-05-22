import {
	createEmptyWindow,
	type ModelUsage,
	type ProviderId,
	type ProviderUsage,
	PROVIDERS,
	type UsageWindow
} from '$lib/usage';

// eslint-disable-next-line no-control-regex
const OSC_PATTERN = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function stripTerminalOutput(value: string) {
	return value
		.replace(OSC_PATTERN, '')
		.replace(ANSI_PATTERN, '')
		.replace(CONTROL_PATTERN, '')
		.replace(/\r/g, '\n');
}

function normalizeProviderUsageLine(providerId: ProviderId, line: string) {
	if (providerId === 'gemini') return normalizeGeminiUsageLine(line);
	if (providerId === 'codex') return normalizeCodexUsageLine(line);
	if (providerId === 'claude') return normalizeClaudeUsageLine(line);
	return line.trim();
}

function normalizeDecoratedUsageLine(line: string) {
	return line
		.replace(/[│╭╮╰╯]/g, ' ')
		.replace(/[▬━─█▌▐░▒▓■□▱▰▯▮▭]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function normalizeCodexUsageLine(line: string) {
	return normalizeDecoratedUsageLine(line);
}

function normalizeClaudeUsageLine(line: string) {
	return normalizeDecoratedUsageLine(line);
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
		.map((line) => normalizeProviderUsageLine(providerId, line))
		.filter(Boolean);

	const fiveHour =
		providerId === 'gemini' ? createEmptyWindow('fiveHour') : parseWindow(lines, 'fiveHour');
	const week = providerId === 'gemini' ? createEmptyWindow('week') : parseWindow(lines, 'week');
	const modelUsages = providerId === 'gemini' ? parseGeminiModelUsages(output, lines) : [];
	const hasUsage =
		fiveHour.percent !== null ||
		week.percent !== null ||
		fiveHour.used !== null ||
		week.used !== null ||
		modelUsages.length > 0;
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
			errorMessage || (looksLikeCliProblem && !hasUsage)
				? 'unavailable'
				: hasUsage
					? 'ok'
					: hasOutput
						? 'partial'
						: 'unavailable',
		message: buildMessage(hasUsage, hasOutput, errorMessage),
		collectedAt: new Date().toISOString(),
		collectionDurationMs: null,
		windows: { fiveHour, week },
		modelUsages,
		rawPreview: output.slice(-2000) || null
	};
}

function parseWindow(lines: string[], windowId: 'fiveHour' | 'week'): UsageWindow {
	const window = createEmptyWindow(windowId);
	const limitLine = findCodexLimitLine(lines, windowId);
	if (limitLine) {
		applyCodexLimitLine(window, limitLine);
		return window;
	}

	const section = findUsageSection(lines, windowId);
	const candidates =
		section.length > 0
			? section
			: lines.filter((line) =>
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

		const resetAt = parseResetAt(line);
		if (!window.resetAt && resetAt) {
			window.resetAt = resetAt;
		}
	}

	return window;
}

function findCodexLimitLine(lines: string[], windowId: 'fiveHour' | 'week') {
	const pattern =
		windowId === 'fiveHour'
			? /(?:^|[│\s])5h\s+limit\s*:/i
			: /(?:^|[│\s])(weekly|week)\s+limit\s*:/i;
	return lines.find((line) => pattern.test(line)) ?? null;
}

function applyCodexLimitLine(window: UsageWindow, line: string) {
	const percent = parsePercent(line);
	if (percent !== null) {
		window.percent = /\bleft\b/i.test(line) ? clampPercent(100 - percent) : percent;
	}

	const resetAt = parseResetAt(line);
	if (resetAt) {
		window.resetAt = resetAt;
	}

	const remaining = parseRemainingText(line);
	if (remaining) {
		window.remainingText = remaining;
	}
}

function parseGeminiModelUsages(output: string, lines: string[]): ModelUsage[] {
	const usages = [
		...parseGeminiModelUsageScreen(output),
		...parseGeminiLooseModelUsageSpans(output),
		...parseGeminiPercentResetRows(lines),
		...parseGeminiSplitModelUsageLines(lines),
		...lines
			.map(parseGeminiModelUsageLine)
			.filter((usage): usage is ModelUsage => usage !== null)
	];
	const seen = new Set<string>();

	return usages.filter((usage) => {
		const key = `${usage.label}:${usage.percent}:${usage.remainingText ?? ''}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function parseGeminiModelUsageScreen(output: string): ModelUsage[] {
	const usageSection = output.match(/Model usage([\s\S]*?)(?:\(Press Esc|\n\s*╰|$)/i)?.[1] ?? output;
	const usages: ModelUsage[] = [];
	const pattern =
		/(?:^|\n|│)\s*([A-Za-z][A-Za-z0-9 ._\-…]*?)\s*[▬━─█▌▐░▒▓■□▱▰▯▮▭ ]{8,}\s+(\d+(?:\.\d+)?)\s*%\s*(?:Resets?\s*:?\s*([^\n│]+))?/gi;

	for (const match of usageSection.matchAll(pattern)) {
		const label = cleanGeminiModelLabel(match[1]);
		if (!label) continue;

		const resetText = match[3]?.trim() ?? null;
		usages.push({
			label,
			percent: clampPercent(Number(match[2])) ?? 0,
			resetAt: resetText ? parseGeminiResetAt(resetText) : null,
			remainingText: resetText ? parseGeminiRemainingText(resetText) : null
		});
	}

	return usages;
}

function parseGeminiPercentResetRows(lines: string[]): ModelUsage[] {
	let fallbackIndex = 0;

	return lines
		.map((line): ModelUsage | null => {
			const normalized = normalizeGeminiUsageLine(line);
			const percentMatch = normalized.match(/(\d+(?:\.\d+)?)\s*%\s+Resets?\s*:?\s*(.+)$/i);
			if (!percentMatch || percentMatch.index === undefined) return null;

			const resetText = percentMatch[2].trim();
			const label = cleanGeminiModelLabel(normalized.slice(0, percentMatch.index));
			const usableLabel =
				label && !/model usage|select model/i.test(label)
					? label
					: `Gemini model ${++fallbackIndex}`;

			return {
				label: usableLabel,
				percent: clampPercent(Number(percentMatch[1])) ?? 0,
				resetAt: parseGeminiResetAt(resetText),
				remainingText: parseGeminiRemainingText(resetText)
			};
		})
		.filter((usage): usage is ModelUsage => usage !== null);
}

function parseGeminiLooseModelUsageSpans(output: string): ModelUsage[] {
	const usages: ModelUsage[] = [];
	const pattern =
		/\b(Flash Lite|Flash|Pro|gemini-[^\s│]+)[\s\S]{0,250}?(\d+(?:\.\d+)?)\s*%\s*(?:Resets?\s*:?\s*([^\n│]+))?/gi;

	for (const match of output.matchAll(pattern)) {
		const label = cleanGeminiModelLabel(match[1]);
		const resetText = match[3]?.trim() ?? null;
		usages.push({
			label,
			percent: clampPercent(Number(match[2])) ?? 0,
			resetAt: resetText ? parseGeminiResetAt(resetText) : null,
			remainingText: resetText ? parseGeminiRemainingText(resetText) : null
		});
	}

	return usages;
}

function parseGeminiSplitModelUsageLines(lines: string[]): ModelUsage[] {
	const pairs: ModelUsage[] = [];
	let pendingLabel: string | null = null;

	for (const line of lines) {
		const directUsage = parseGeminiModelUsageLine(line);
		if (directUsage) {
			pairs.push(directUsage);
			pendingLabel = null;
			continue;
		}

		const label = parseGeminiModelLabelOnly(line);
		if (label) {
			pendingLabel = label;
			continue;
		}

		const percentMatch = line.match(/(\d+(?:\.\d+)?)\s*%/);
		if (!pendingLabel || !percentMatch) continue;

		const resetMatch = line
			.slice((percentMatch.index ?? 0) + percentMatch[0].length)
			.match(/\bresets?\s*:?\s*(.+)$/i);
		const resetText = resetMatch?.[1]?.trim() ?? null;
		pairs.push({
			label: pendingLabel,
			percent: clampPercent(Number(percentMatch[1])) ?? 0,
			resetAt: resetText ? parseGeminiResetAt(resetText) : null,
			remainingText: resetText ? parseGeminiRemainingText(resetText) : null
		});
		pendingLabel = null;
	}

	return pairs;
}

function parseGeminiModelUsageLine(line: string): ModelUsage | null {
	const normalized = normalizeGeminiUsageLine(line);
	if (
		!/\b(?:flash|pro)\b|^gemini-/i.test(normalized) ||
		/model usage|select model/i.test(normalized)
	) {
		return null;
	}

	const percentMatch = normalized.match(/(\d+(?:\.\d+)?)\s*%/);
	if (!percentMatch || percentMatch.index === undefined) return null;

	const label = cleanGeminiModelLabel(normalized.slice(0, percentMatch.index));
	if (!label || /model usage/i.test(label)) return null;

	const resetMatch = normalized
		.slice(percentMatch.index + percentMatch[0].length)
		.match(/\bresets?\s*:?\s*(.+)$/i);
	const resetText = resetMatch?.[1]?.trim() ?? null;

	return {
		label,
		percent: clampPercent(Number(percentMatch[1])) ?? 0,
		resetAt: resetText ? parseGeminiResetAt(resetText) : null,
		remainingText: resetText ? parseGeminiRemainingText(resetText) : null
	};
}

function parseGeminiModelLabelOnly(line: string) {
	const normalized = normalizeGeminiUsageLine(line);
	if (
		/\d+(?:\.\d+)?\s*%|model usage|select model|let gemini|remember model|press esc|startup|manual|auto/i.test(
			normalized
		)
	) {
		return null;
	}

	const label = cleanGeminiModelLabel(normalized);
	if (!/\b(?:flash|pro)\b|^gemini-/i.test(label)) return null;
	if (label.length > 40) return null;

	return label;
}

function normalizeGeminiUsageLine(value: string) {
	return normalizeDecoratedUsageLine(value);
}

function cleanGeminiModelLabel(value: string) {
	return normalizeGeminiUsageLine(value);
}

function findUsageSection(lines: string[], windowId: 'fiveHour' | 'week') {
	const startPattern =
		windowId === 'fiveHour'
			? /\b(current\s*session|5\s*h|5\s*hour|five\s*hour)\b/i
			: /\b(current\s*week|week|weekly|7\s*d|7\s*day)\b/i;
	const otherPattern =
		windowId === 'fiveHour'
			? /\b(current\s*week|week|weekly|7\s*d|7\s*day)\b/i
			: /\b(current\s*session|5\s*h|5\s*hour|five\s*hour)\b/i;
	const startIndex = lines.findIndex((line) => startPattern.test(line));
	if (startIndex < 0) return [];

	const section = [];
	for (const line of lines.slice(startIndex, startIndex + 8)) {
		if (section.length > 0 && otherPattern.test(line)) break;
		section.push(line);
	}

	return section;
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
	const resetMatch = line.match(/\bresets?\s*:?\s*(.+)/i);
	if (resetMatch) return cleanResetText(resetMatch[1]);

	if (!/\b(reset|resets|renews|remaining|left|until)\b/i.test(line)) return null;

	const duration = line.match(
		/(?:(\d+)\s*d(?:ays?)?)?\s*(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?/i
	);
	if (duration?.[0]?.trim()) return duration[0].trim();

	return line.replace(/\s+/g, ' ').slice(0, 80);
}

function parseResetAt(line: string) {
	const resetMatch = line.match(/\bresets?\s*:?\s*(.+?)(?:\s*\(([^)]+)\)|\))?$/i);
	if (!resetMatch) return null;

	const rawDate = cleanResetText(resetMatch[1]);
	const timezone = resetMatch[2]?.trim();
	if (timezone && timezone !== 'Asia/Seoul') return null;

	const now = new Date();
	const timeOnly = rawDate.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
	if (timeOnly) {
		const date = new Date(now);
		const hour = to24Hour(Number(timeOnly[1]), timeOnly[3]);
		date.setHours(hour, Number(timeOnly[2] ?? 0), 0, 0);
		if (date.getTime() <= now.getTime()) {
			date.setDate(date.getDate() + 1);
		}
		return date.toISOString();
	}

	const timeOnly24 = rawDate.match(/^(\d{1,2}):(\d{2})$/);
	if (timeOnly24) {
		const date = new Date(now);
		date.setHours(Number(timeOnly24[1]), Number(timeOnly24[2]), 0, 0);
		if (date.getTime() <= now.getTime()) {
			date.setDate(date.getDate() + 1);
		}
		return date.toISOString();
	}

	const dateMatch = rawDate.match(/^([a-z]+)\s*(\d{1,2}),\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
	if (dateMatch) {
		const month = monthIndex(dateMatch[1]);
		if (month === null) return null;

		const hour = to24Hour(Number(dateMatch[3]), dateMatch[5]);
		const date = new Date(
			now.getFullYear(),
			month,
			Number(dateMatch[2]),
			hour,
			Number(dateMatch[4] ?? 0),
			0,
			0
		);
		if (date.getTime() <= now.getTime()) {
			date.setFullYear(date.getFullYear() + 1);
		}
		return date.toISOString();
	}

	const codexDateMatch = rawDate.match(/^(\d{1,2}):(\d{2})\s+on\s+(\d{1,2})\s+([a-z]+)$/i);
	if (codexDateMatch) {
		const month = monthIndex(codexDateMatch[4]);
		if (month === null) return null;

		const date = new Date(
			now.getFullYear(),
			month,
			Number(codexDateMatch[3]),
			Number(codexDateMatch[1]),
			Number(codexDateMatch[2]),
			0,
			0
		);
		if (date.getTime() <= now.getTime()) {
			date.setFullYear(date.getFullYear() + 1);
		}
		return date.toISOString();
	}

	return null;
}

function parseGeminiResetAt(value: string) {
	const timeMatch = value.match(/^(\d{1,2}):(\d{2})\s*(am|pm)\b/i);
	if (!timeMatch) return null;

	const now = new Date();
	const date = new Date(now);
	date.setHours(to24Hour(Number(timeMatch[1]), timeMatch[3]), Number(timeMatch[2]), 0, 0);
	if (date.getTime() <= now.getTime()) {
		date.setDate(date.getDate() + 1);
	}
	return date.toISOString();
}

function parseGeminiRemainingText(value: string) {
	const durationMatch = value.match(/\(([^)]+)\)/);
	return durationMatch?.[1]?.trim() ?? value;
}

function cleanResetText(value: string) {
	return value.replace(/[│]/g, '').replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
}

function to24Hour(hour: number, meridiem: string) {
	const normalized = hour % 12;
	return meridiem.toLowerCase() === 'pm' ? normalized + 12 : normalized;
}

function monthIndex(month: string) {
	const index = [
		'jan',
		'feb',
		'mar',
		'apr',
		'may',
		'jun',
		'jul',
		'aug',
		'sep',
		'oct',
		'nov',
		'dec'
	].indexOf(month.slice(0, 3).toLowerCase());
	return index >= 0 ? index : null;
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
