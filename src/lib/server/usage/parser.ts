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
const CURSOR_MOVE_PATTERN = /\x1b\[[0-9;?]*[ABCDG]/g;
const ORPHANED_CURSOR_MOVE_PATTERN = /\[(?:\??\d+(?:;\d+)*)[ABCDG]/g;
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// Handles copied/debug output where the ESC byte was dropped but the CSI body remains.
const ORPHANED_CSI_PATTERN =
	/\[(?:(?:\??\d+(?:;\d+)*)[ABCDGJKSTfm]|\?\d+(?:;\d+)*[hl]|[GJKSTfm])/g;
// eslint-disable-next-line no-control-regex
const TERMINAL_ESCAPE_PATTERN = /\x1b(?:[()#%][0-~]|[78=>])/g;
// eslint-disable-next-line no-control-regex
const SINGLE_CHARACTER_ESCAPE_PATTERN = /\x1b[@-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const GEMINI_MODEL_NAME_PATTERN = /\b(Flash Lite|Flash|Pro|gemini-[A-Za-z0-9._\-…]+)/gi;
const GEMINI_BAR_RUN_PATTERN = /[▬━─═╌╍▔▁▂▃▄▅▆▇█▏▎▍▌▋▊▉▐░▒▓■□▱▰▯▮▭]{3,}/;
const RESET_WORD_PATTERN = /\brese\s*(?:ts?|s)\s*:?\s*/i;
export const BOX_DECORATION_PATTERN = /[│┃║┆┊╎╏╭╮╰╯┌┐└┘├┤[\]]/g;
export const BAR_DECORATION_PATTERN = /[▬━─═╌╍▔▁▂▃▄▅▆▇█▏▎▍▌▋▊▉▐░▒▓■□▱▰▯▮▭]+/g;

export function stripTerminalOutput(value: string) {
	return value
		.replace(OSC_PATTERN, '')
		.replace(CURSOR_MOVE_PATTERN, ' ')
		.replace(ANSI_PATTERN, '')
		.replace(ORPHANED_CURSOR_MOVE_PATTERN, ' ')
		.replace(ORPHANED_CSI_PATTERN, '')
		.replace(TERMINAL_ESCAPE_PATTERN, '')
		.replace(SINGLE_CHARACTER_ESCAPE_PATTERN, '')
		.replace(CONTROL_PATTERN, '')
		.replace(/\r\n/g, '\n')
		.replace(/\r/g, ' ');
}

function normalizeProviderUsageLine(providerId: ProviderId, line: string) {
	if (providerId === 'gemini') return normalizeGeminiUsageLine(line);
	if (providerId === 'codex') return normalizeCodexUsageLine(line);
	if (providerId === 'claude') return normalizeClaudeUsageLine(line);
	return line.trim();
}

function normalizeDecoratedUsageLine(line: string) {
	return line
		.replace(BOX_DECORATION_PATTERN, ' ')
		.replace(BAR_DECORATION_PATTERN, ' ')
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
		providerId === 'gemini'
			? modelUsages.length >= 3
			: fiveHour.percent !== null ||
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
		const percent = parseUsagePercent(line);
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
	return findLastMatchingLine(lines, pattern);
}

function applyCodexLimitLine(window: UsageWindow, line: string) {
	const percent = parseUsagePercent(line);
	if (percent !== null) {
		window.percent = percent;
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
	const barUsages = parseGeminiBarModelRows(output);
	if (barUsages.length >= 3) {
		return mergeGeminiModelUsages(barUsages);
	}

	const candidateLines = buildGeminiCandidateLines(output, lines);
	const usages = [
		...barUsages,
		...parseGeminiKnownModelRows(output, candidateLines),
		...parseGeminiSplitModelUsageLines(candidateLines),
		...parseGeminiOrderedModelPercentFallback(output, candidateLines)
	];

	return mergeGeminiModelUsages(usages);
}

function extractGeminiModelUsageSection(output: string) {
	const matches = [
		...stripTerminalOutput(output).matchAll(
			/Model usage([\s\S]*?)(?:\(\s*Press Esc\s+to\s+close\s*\)|\n\s*╰|$)/gi
		)
	];
	const lastComplete = [...matches].reverse().find((match) => /\d+(?:\.\d+)?\s*%/.test(match[1]));

	return (lastComplete ?? matches.at(-1))?.[1] ?? null;
}

function findLastMatchingLine(lines: string[], pattern: RegExp) {
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		if (pattern.test(lines[index])) return lines[index];
	}

	return null;
}

function findLastMatchingIndex(lines: string[], pattern: RegExp) {
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		if (pattern.test(lines[index])) return index;
	}

	return -1;
}

function mergeGeminiModelUsages(usages: ModelUsage[]) {
	const byLabel = new Map<string, ModelUsage>();

	for (const usage of usages) {
		const label = cleanGeminiModelLabel(usage.label);
		if (!isGeminiModelUsageLabel(label)) continue;

		const normalized = { ...usage, label };
		const previous = byLabel.get(label);
		if (!previous || geminiUsageCompleteness(normalized) >= geminiUsageCompleteness(previous)) {
			byLabel.set(label, normalized);
		}
	}

	return [...byLabel.values()].sort(
		(left, right) =>
			geminiModelSortIndex(left.label) - geminiModelSortIndex(right.label) ||
			left.label.localeCompare(right.label)
	);
}

function buildGeminiCandidateLines(output: string, lines: string[]) {
	const rawCandidates = stripTerminalOutput(output)
		.replace(/[│┃║]/g, '\n')
		.split('\n')
		.map((line) => normalizeGeminiUsageLine(line))
		.filter(Boolean);
	const seen = new Set<string>();

	return [...lines, ...rawCandidates].filter((line) => {
		const normalized = normalizeGeminiUsageLine(line);
		if (!normalized || seen.has(normalized)) return false;
		seen.add(normalized);
		return true;
	});
}

function geminiUsageCompleteness(usage: ModelUsage) {
	return (usage.resetAt ? 2 : 0) + (usage.remainingText ? 1 : 0);
}

function geminiModelSortIndex(label: string) {
	if (/^Flash$/i.test(label)) return 0;
	if (/^Flash Lite$/i.test(label)) return 1;
	if (/^Pro$/i.test(label)) return 2;
	if (/^gemini-/i.test(label)) return 3;
	return 4;
}

function parseGeminiBarModelRows(output: string): ModelUsage[] {
	const usages: ModelUsage[] = [];
	const seen = new Set<string>();

	for (const row of buildGeminiBarModelRows(output)) {
		const barMatch = row.match(GEMINI_BAR_RUN_PATTERN);
		if (!barMatch || barMatch.index === undefined) continue;

		const label = cleanGeminiModelLabel(row.slice(0, barMatch.index));
		if (!isGeminiModelUsageLabel(label)) continue;

		const value = row.slice(barMatch.index + barMatch[0].length);
		const usage = parseGeminiUsageAfterLabel(label, normalizeGeminiUsageLine(value));
		if (!usage) continue;

		const key = `${usage.label}\0${usage.percent}\0${usage.remainingText ?? ''}`;
		if (seen.has(key)) continue;
		seen.add(key);
		usages.push(usage);
	}

	return usages;
}

function buildGeminiBarModelRows(output: string) {
	const texts = [extractGeminiModelUsageSection(output), stripTerminalOutput(output)].filter(
		(text): text is string => Boolean(text)
	);
	const rows: string[] = [];
	const seen = new Set<string>();

	for (const text of texts) {
		const rawLines = text
			.replace(/[│┃║]/g, '\n')
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean);

		for (let index = 0; index < rawLines.length; index += 1) {
			const line = rawLines[index];
			if (!GEMINI_BAR_RUN_PATTERN.test(line)) continue;

			const nextLine = rawLines[index + 1] ?? '';
			const lineHasPercent = /\d+(?:\.\d+)?\s*%/.test(line);
			const nextLineStartsWithPercent = /^\s*\d+(?:\.\d+)?\s*%/i.test(
				normalizeGeminiUsageLine(nextLine)
			);
			let row = line;

			if (!lineHasPercent && nextLineStartsWithPercent) {
				row = `${row} ${nextLine}`;
			}

			const rowHasReset = /\bResets?\s*:?\s*/i.test(row);
			const followingLine = rawLines[index + (row === line ? 1 : 2)] ?? '';
			if (!rowHasReset && /\bResets?\s*:?\s*/i.test(followingLine)) {
				row = `${row} ${followingLine}`;
			}

			const normalized = row.replace(/\s+/g, ' ').trim();
			if (seen.has(normalized)) continue;
			seen.add(normalized);
			rows.push(normalized);
		}
	}

	return rows;
}

function parseGeminiKnownModelRows(output: string, lines: string[]): ModelUsage[] {
	const chunks = [
		...lines,
		...stripTerminalOutput(output)
			.replace(/[│┃║]/g, '\n')
			.split('\n')
			.map((line) => normalizeGeminiUsageLine(line)),
		normalizeGeminiUsageLine(stripTerminalOutput(output).replace(/[\r\n│┃║]+/g, ' '))
	].filter(Boolean);
	const usages: ModelUsage[] = [];
	const seen = new Set<string>();

	for (const chunk of chunks) {
		const matches = [...chunk.matchAll(GEMINI_MODEL_NAME_PATTERN)];
		for (let index = 0; index < matches.length; index += 1) {
			const match = matches[index];
			if (match.index === undefined) continue;

			const label = cleanGeminiModelLabel(match[1]);
			if (!isGeminiModelUsageLabel(label)) continue;

			const nextMatchIndex = matches[index + 1]?.index ?? chunk.length;
			const span = chunk.slice(match.index + match[0].length, nextMatchIndex);
			const usage = parseGeminiUsageAfterLabel(label, span);
			if (!usage) continue;

			const key = `${usage.label}\0${usage.percent}\0${usage.remainingText ?? ''}`;
			if (seen.has(key)) continue;
			seen.add(key);
			usages.push(usage);
		}
	}

	return usages;
}

function parseGeminiUsageAfterLabel(label: string, value: string): ModelUsage | null {
	const percentMatch = value.match(/(\d+(?:\.\d+)?)\s*%/);
	if (!percentMatch || percentMatch.index === undefined) return null;

	const afterPercent = value.slice(percentMatch.index + percentMatch[0].length);
	const resetText = afterPercent.match(/\bResets?\s*:?\s*(.+)$/i)?.[1]?.trim() ?? null;

	return {
		label,
		percent: clampPercent(Number(percentMatch[1])) ?? 0,
		resetAt: resetText ? parseGeminiResetAt(resetText) : null,
		remainingText: resetText ? parseGeminiRemainingText(resetText) : null
	};
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

function parseGeminiOrderedModelPercentFallback(output: string, lines: string[]): ModelUsage[] {
	const chunks = buildGeminiOrderedFallbackChunks(output, lines);
	const candidates: ModelUsage[][] = [];

	for (const chunk of chunks) {
		const labels = [...chunk.matchAll(GEMINI_MODEL_NAME_PATTERN)]
			.map((match) => cleanGeminiModelLabel(match[1]))
			.filter(isGeminiModelUsageLabel);
		const percents = [...chunk.matchAll(/(\d+(?:\.\d+)?)\s*%/g)];
		if (labels.length < 3 || percents.length < 3) continue;

		const modelLabels = takeLastDistinctGeminiLabels(labels);
		if (modelLabels.length < 3) continue;

		const usablePercents = percents.slice(-modelLabels.length);
		if (usablePercents.length < modelLabels.length) continue;

		candidates.push(
			modelLabels.map((label, index) => {
				const percentMatch = usablePercents[index];
				const resetText = resetTextAfterPercent(chunk, percentMatch);

				return {
					label,
					percent: clampPercent(Number(percentMatch[1])) ?? 0,
					resetAt: resetText ? parseGeminiResetAt(resetText) : null,
					remainingText: resetText ? parseGeminiRemainingText(resetText) : null
				};
			})
		);
	}

	return candidates.at(-1) ?? [];
}

function buildGeminiOrderedFallbackChunks(output: string, lines: string[]) {
	const stripped = stripTerminalOutput(output);
	const flattened = normalizeGeminiUsageLine(stripped.replace(/[\r\n│┃║]+/g, ' '));
	const chunks = [
		extractGeminiModelUsageSection(output),
		...stripped.split(/Model usage|Select Model/i),
		lines.join(' '),
		flattened
	]
		.filter((chunk): chunk is string => Boolean(chunk))
		.map((chunk) => normalizeGeminiUsageLine(chunk))
		.filter(Boolean);
	const seen = new Set<string>();

	return chunks.filter((chunk) => {
		if (seen.has(chunk)) return false;
		seen.add(chunk);
		return true;
	});
}

function takeLastDistinctGeminiLabels(labels: string[]) {
	const result: string[] = [];
	const seen = new Set<string>();

	for (let index = labels.length - 1; index >= 0; index -= 1) {
		const label = labels[index];
		if (seen.has(label)) continue;
		seen.add(label);
		result.unshift(label);
		if (result.length >= 4) break;
	}

	return result;
}

function resetTextAfterPercent(chunk: string, percentMatch: RegExpMatchArray) {
	if (percentMatch.index === undefined) return null;

	const afterPercent = chunk.slice(percentMatch.index + percentMatch[0].length);
	const nextPercentIndex = afterPercent.search(/\d+(?:\.\d+)?\s*%/);
	const span = nextPercentIndex >= 0 ? afterPercent.slice(0, nextPercentIndex) : afterPercent;
	return span.match(/\bResets?\s*:?\s*(.+)$/i)?.[1]?.trim() ?? null;
}

function parseGeminiModelUsageLine(line: string): ModelUsage | null {
	const normalized = normalizeGeminiUsageLine(line);
	if (/model usage|select model/i.test(normalized)) {
		return null;
	}

	const percentMatch = normalized.match(/(\d+(?:\.\d+)?)\s*%/);
	if (!percentMatch || percentMatch.index === undefined) return null;

	const label = cleanGeminiModelLabel(normalized.slice(0, percentMatch.index));
	if (!isGeminiModelUsageLabel(label)) return null;

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
		/\d+(?:\.\d+)?\s*%|model usage|select model|let gemini|remember model|press esc|startup|manual|auto|type your message|\//i.test(
			normalized
		)
	) {
		return null;
	}

	const label = cleanGeminiModelLabel(normalized);
	if (!isGeminiModelUsageLabel(label)) return null;
	if (label.length > 40) return null;

	return label;
}

function normalizeGeminiUsageLine(value: string) {
	return normalizeDecoratedUsageLine(value)
		.replace(/\s*(\d+(?:\.\d+)?)\s*%\s*/g, ' $1% ')
		.replace(/\bResets?\s*:?\s*/gi, ' Resets: ')
		.replace(/\s+/g, ' ')
		.trim();
}

function cleanGeminiModelLabel(value: string) {
	return normalizeGeminiUsageLine(value)
		.replace(/^[>*•●○◉◆◇▶▷❯›\-\s]+/, '')
		.replace(/\s+\d+(?:\.\d+)?\s*%.*$/i, '')
		.replace(/\s+Resets?:.*$/i, '')
		.replace(/[,\s]+$/g, '')
		.trim();
}

function isGeminiModelUsageLabel(value: string) {
	return (
		value.length > 0 &&
		value.length <= 80 &&
		/[a-z0-9]/i.test(value) &&
		!/model usage|select model|let gemini|remember model|press esc|startup|manual|auto|resets?|type your message|\//i.test(
			value
		)
	);
}

function findUsageSection(lines: string[], windowId: 'fiveHour' | 'week') {
	const startPattern =
		windowId === 'fiveHour'
			? /\b(current\s*session|curre\s*t\s*session|curret\s*session|5\s*h|5\s*hour|five\s*hour)\b/i
			: /\b(current\s*week|week\s+limit|weekly\s+limit|7\s*d|7\s*day)\b/i;
	const otherPattern =
		windowId === 'fiveHour'
			? /\b(current\s*week|week\s+limit|weekly\s+limit|7\s*d|7\s*day)\b/i
			: /\b(current\s*session|curre\s*t\s*session|curret\s*session|5\s*h|5\s*hour|five\s*hour)\b/i;
	const startIndex = findLastMatchingIndex(lines, startPattern);
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

function parseUsagePercent(line: string) {
	const percent = parsePercent(line);
	if (percent === null) return null;

	if (/\b(left|remaining|available)\b/i.test(line) && !/\bused\b/i.test(line)) {
		return clampPercent(100 - percent);
	}

	return percent;
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
	const resetMatch = line.match(new RegExp(`${RESET_WORD_PATTERN.source}(.+)`, 'i'));
	if (resetMatch) return cleanResetText(resetMatch[1]);

	if (!/\b(reset|resets|renews|remaining|left|until)\b/i.test(line)) return null;

	const duration = line.match(
		/(?:(\d+)\s*d(?:ays?)?)?\s*(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?/i
	);
	if (duration?.[0]?.trim()) return duration[0].trim();

	return line.replace(/\s+/g, ' ').slice(0, 80);
}

function parseResetAt(line: string) {
	const resetMatch = line.match(
		new RegExp(`${RESET_WORD_PATTERN.source}(.+?)(?:\\s*\\(([^)]+)\\)|\\))?$`, 'i')
	);
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
	return value
		.replace(BOX_DECORATION_PATTERN, ' ')
		.replace(/[()]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
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
