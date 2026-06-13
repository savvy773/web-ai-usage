<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import {
		Activity,
		AlertTriangle,
		Clock3,
		Copy,
		ExternalLink,
		Power,
		RefreshCcw,
		ScrollText,
		Terminal
	} from '@lucide/svelte';

	interface LogEntry {
		level: 'log' | 'info' | 'warn' | 'error';
		message: string;
		timestamp: string;
	}
	interface AutoRefreshState {
		enabled: boolean;
		intervalMs: number;
		nextRunAt: string | null;
	}
	import type { ProviderUsage, UsagePayload, UsageWindow, UsageWindowId } from '$lib/usage';
	import type { PageData } from './$types';

	const AUTO_REFRESH_SETTLE_MS = 1000;
	const MANUAL_REFRESH_COOLDOWN_MS = 10_000;
	const USAGE_CACHE_KEY = 'ai-usage-payload-cache';
	const AUTO_REFRESH_INTERVAL_KEY = 'ai-usage-auto-refresh-interval-ms-v2';
	const USAGE_REQUEST_TIMEOUT_MS = 10_000;
	const USAGE_REQUEST_RETRIES = 2;
	const REFRESH_REQUEST_TIMEOUT_MS = 15_000;
	const REFRESH_POLL_INTERVAL_MS = 1500;
	const REFRESH_POLL_ATTEMPTS = 240;
	const VISIBLE_SYNC_INTERVAL_MS = 10_000;
	const DEFAULT_AUTO_REFRESH_INTERVAL_MS = 3 * 60 * 1000;
	const AUTO_REFRESH_INTERVAL_OPTIONS = [
		{ label: '1m', value: 1 * 60 * 1000 },
		{ label: '3m', value: 3 * 60 * 1000 },
		{ label: '5m', value: 5 * 60 * 1000 },
		{ label: '10m', value: 10 * 60 * 1000 }
	] as const;
	const WINDOW_ORDER: UsageWindowId[] = ['fiveHour', 'week'];
	const DAY_MS = 24 * 60 * 60 * 1000;
	const MIN_WEEKLY_PACE_TARGET = 20;

	const CLOCK_FORMATTER = new Intl.DateTimeFormat('en', {
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false
	});
	const CLOCK_DATE_FORMATTER = new Intl.DateTimeFormat('en', {
		weekday: 'short',
		month: 'short',
		day: 'numeric'
	});

	let { data }: { data: PageData } = $props();
	const initialPayload = untrack(() => data.initialPayload);

	let payload = $state<UsagePayload | null>(initialPayload ?? null);
	let loading = $state(!initialPayload);
	let refreshing = $state(false);
	let error = $state<string | null>(null);
	let now = $state(new Date());
	let autoRefresh = $state(true);
	let autoRefreshIntervalMs = $state(DEFAULT_AUTO_REFRESH_INTERVAL_MS);
	let refreshCooldownUntil = $state<number | null>(null);
	let nextAutoRefreshAtMs = $state<number | null>(null);
	let autoRefreshConfigReady = $state(false);
	let pageIsForeground = $state(false);
	let visibleSyncInFlight = false;
	let stopping = $state(false);
	let showLogs = $state(true);
	let logs = $state<LogEntry[]>([]);
	let logContainer = $state<HTMLElement | null>(null);
	let autoScrollLogs = $state(true);
	let logsCopied = $state(false);
	let logTab = $state<'logs' | 'checks'>('logs');

	$effect(() => {
		if (logs.length > 0 && logContainer && autoScrollLogs && showLogs) {
			logContainer.scrollTop = logContainer.scrollHeight;
		}
	});

	const providers = $derived(payload?.providers ?? []);
	const serverRefreshing = $derived(payload?.refreshState?.refreshing ?? false);
	const working = $derived(loading || refreshing || serverRefreshing);
	const nextAutoRefreshAt = $derived(
		nextAutoRefreshAtMs === null ? null : new Date(nextAutoRefreshAtMs).toISOString()
	);
	const nextRefreshCountdown = $derived(formatRefreshCountdown(nextAutoRefreshAt));
	const refreshCooldownCountdown = $derived(formatCountdown(refreshCooldownUntil));
	const refreshLocked = $derived(working || isRefreshCoolingDown(refreshCooldownUntil));

	$effect(() => {
		if (!autoRefreshConfigReady) {
			return;
		}

		void configureServerAutoRefresh();
	});

	$effect(() => {
		if (!autoRefresh || !pageIsForeground || nextAutoRefreshAtMs === null || refreshing) {
			return;
		}

		const delay = Math.max(AUTO_REFRESH_SETTLE_MS, nextAutoRefreshAtMs - Date.now());
		const timer = window.setTimeout(() => {
			void syncAfterScheduledRefresh();
		}, delay);

		return () => {
			window.clearTimeout(timer);
		};
	});

	onMount(() => {
		restoreRefreshCooldown();
		restoreAutoRefreshInterval();
		autoRefreshConfigReady = true;
		const cachedPayload = readCachedPayload();
		if (payload) {
			cachePayload(payload);
			loading = false;
		} else if (cachedPayload) {
			payload = cachedPayload;
			loading = false;
		}
		if (!payload) {
			void loadUsage();
		}
		const updateForegroundState = () => {
			pageIsForeground = document.visibilityState === 'visible';
			if (pageIsForeground) {
				void loadUsage().finally(() => syncServerAutoRefreshState());
			} else {
				nextAutoRefreshAtMs = null;
			}
		};
		document.addEventListener('visibilitychange', updateForegroundState);
		updateForegroundState();
		const clockTimer = window.setInterval(() => {
			now = new Date();
		}, 1000);
		const visibleSyncTimer = window.setInterval(() => {
			void syncVisibleDashboard();
		}, VISIBLE_SYNC_INTERVAL_MS);

		const es = new EventSource('/api/server/logs');
		es.onmessage = (e) => {
			const data = JSON.parse(e.data as string);
			if (data.type === 'init') {
				logs = data.entries as LogEntry[];
			} else if (data.type === 'entry') {
				logs = [...logs, data.entry as LogEntry].slice(-500);
			}
		};

		return () => {
			window.clearInterval(clockTimer);
			window.clearInterval(visibleSyncTimer);
			document.removeEventListener('visibilitychange', updateForegroundState);
			es.close();
		};
	});

	async function loadUsage() {
		loading = true;
		error = null;

		try {
			applyPayload(await fetchUsagePayload('/api/usage'));
		} catch (requestError) {
			const cachedPayload = readCachedPayload();
			if (cachedPayload) {
				payload = cachedPayload;
			}
			error = requestError instanceof Error ? requestError.message : 'Failed to load usage data.';
		} finally {
			loading = false;
		}
	}

	async function refreshUsage(
		mode: 'manual' | 'auto' = 'manual',
		options: { force?: boolean } = {}
	) {
		if (refreshing || (!options.force && isRefreshCoolingDown(refreshCooldownUntil))) {
			return;
		}

		refreshing = true;
		error = null;
		setRefreshCooldown(Date.now() + MANUAL_REFRESH_COOLDOWN_MS);
		const previousCollectedAt = latestCollectedAt(payload);

		try {
			const { payload: refreshedPayload, status } = await fetchUsageResponse('/api/usage/refresh', {
				method: 'POST',
				headers: refreshHeaders(mode),
				timeoutMs: REFRESH_REQUEST_TIMEOUT_MS,
				retries: 0,
				errorPrefix: 'Refresh failed'
			});
			applyPayload(refreshedPayload);

			if (status === 202 || refreshedPayload.refreshState?.refreshing) {
				await pollUsageUntilSettled(previousCollectedAt);
			}
		} catch (requestError) {
			error =
				requestError instanceof Error ? requestError.message : 'Failed to refresh usage data.';
			await pollUsageUntilSettled(previousCollectedAt);
		} finally {
			refreshing = false;
			loading = false;
			void syncServerAutoRefreshState();
		}
	}

	async function pollUsageUntilSettled(previousCollectedAt: string | null) {
		for (let attempt = 0; attempt < REFRESH_POLL_ATTEMPTS; attempt += 1) {
			await delay(REFRESH_POLL_INTERVAL_MS);

			const polledPayload = await fetchUsagePayload('/api/usage').catch(() => null);
			if (!polledPayload) continue;
			applyPayload(polledPayload);

			const collectedAt = latestCollectedAt(polledPayload);
			if (!polledPayload.refreshState?.refreshing && collectedAt !== previousCollectedAt) {
				return;
			}
		}
	}

	function applyPayload(nextPayload: UsagePayload) {
		payload = nextPayload;
		cachePayload(nextPayload);
	}

	function refreshHeaders(mode: 'manual' | 'auto') {
		return { 'x-ai-usage-refresh-mode': mode };
	}

	function cachePayload(nextPayload: UsagePayload) {
		try {
			localStorage.setItem(USAGE_CACHE_KEY, JSON.stringify(nextPayload));
		} catch {
			// Local storage can be unavailable in private or restricted contexts.
		}
	}

	function readCachedPayload() {
		try {
			const cached = localStorage.getItem(USAGE_CACHE_KEY);
			if (!cached) return null;
			return JSON.parse(cached) as UsagePayload;
		} catch {
			localStorage.removeItem(USAGE_CACHE_KEY);
			return null;
		}
	}

	async function fetchUsagePayload(url: string) {
		const result = await fetchUsageResponse(url, {
			timeoutMs: USAGE_REQUEST_TIMEOUT_MS,
			retries: USAGE_REQUEST_RETRIES,
			errorPrefix: 'Usage request failed'
		});
		return result.payload;
	}

	async function fetchUsageResponse(
		url: string,
		options: {
			method?: 'GET' | 'POST';
			headers?: Record<string, string>;
			timeoutMs: number;
			retries: number;
			errorPrefix: string;
		}
	) {
		let lastError: unknown;
		for (let attempt = 0; attempt <= options.retries; attempt += 1) {
			const controller = new AbortController();
			const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs);
			try {
				const response = await fetch(url, {
					method: options.method ?? 'GET',
					headers: options.headers,
					signal: controller.signal
				});
				if (!response.ok) throw new Error(`${options.errorPrefix}: ${response.status}`);
				return {
					payload: (await response.json()) as UsagePayload,
					status: response.status
				};
			} catch (error) {
				lastError = error;
				if (attempt < options.retries) {
					await delay(350 * (attempt + 1));
				}
			} finally {
				window.clearTimeout(timeout);
			}
		}

		if (lastError instanceof DOMException && lastError.name === 'AbortError') {
			throw new Error(`${options.errorPrefix}: timeout`);
		}
		throw lastError instanceof Error ? lastError : new Error(options.errorPrefix);
	}

	function latestCollectedAt(nextPayload: UsagePayload | null) {
		return nextPayload?.history.at(-1)?.collectedAt ?? null;
	}

	function delay(ms: number) {
		return new Promise<void>((resolve) => {
			window.setTimeout(resolve, ms);
		});
	}

	async function configureServerAutoRefresh() {
		try {
			const response = await fetch('/api/usage/auto-refresh', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					enabled: autoRefresh,
					intervalMs: autoRefreshIntervalMs
				})
			});
			if (!response.ok) throw new Error(`Auto refresh setup failed: ${response.status}`);
			applyAutoRefreshState((await response.json()) as AutoRefreshState);
		} catch (requestError) {
			if (autoRefresh) {
				error =
					requestError instanceof Error
						? requestError.message
						: 'Failed to configure auto refresh.';
			}
		}
	}

	async function syncServerAutoRefreshState() {
		try {
			const response = await fetch('/api/usage/auto-refresh', { cache: 'no-store' });
			if (!response.ok) throw new Error(`Auto refresh status failed: ${response.status}`);
			applyAutoRefreshState((await response.json()) as AutoRefreshState);
		} catch {
			nextAutoRefreshAtMs = null;
		}
	}

	async function syncVisibleDashboard() {
		if (document.visibilityState !== 'visible' || visibleSyncInFlight) return;
		visibleSyncInFlight = true;

		try {
			const nextPayload = await fetchUsagePayload('/api/usage');
			applyPayload(nextPayload);
			await syncServerAutoRefreshState();
		} catch {
			// The next visible sync retries without replacing usable cached data.
		} finally {
			visibleSyncInFlight = false;
		}
	}

	function applyAutoRefreshState(state: AutoRefreshState) {
		if (!autoRefresh || !pageIsForeground) {
			nextAutoRefreshAtMs = null;
			return;
		}

		const nextRunTime = state.nextRunAt ? Date.parse(state.nextRunAt) : Number.NaN;
		nextAutoRefreshAtMs = Number.isFinite(nextRunTime) ? nextRunTime : null;
	}

	async function syncAfterScheduledRefresh() {
		if (!pageIsForeground) return;
		const previousCollectedAt = latestCollectedAt(payload);
		await pollVisibleUsageUntilAdvanced(previousCollectedAt);
		await syncServerAutoRefreshState();
	}

	async function pollVisibleUsageUntilAdvanced(previousCollectedAt: string | null) {
		for (let attempt = 0; attempt < REFRESH_POLL_ATTEMPTS; attempt += 1) {
			if (document.visibilityState !== 'visible') return;
			await delay(REFRESH_POLL_INTERVAL_MS);

			const polledPayload = await fetchUsagePayload('/api/usage').catch(() => null);
			if (!polledPayload) continue;
			applyPayload(polledPayload);

			const collectedAt = latestCollectedAt(polledPayload);
			if (!polledPayload.refreshState?.refreshing && collectedAt !== previousCollectedAt) {
				return;
			}
		}
	}

	async function copyActivePanel() {
		const text =
			logTab === 'checks'
				? checkItems()
						.map((item) => `${item.provider} [${item.tone}] ${item.message}`)
						.join('\n')
				: logs
						.map((entry) => `${formatLogTime(entry.timestamp)} [${entry.level}] ${entry.message}`)
						.join('\n');
		await navigator.clipboard.writeText(text);
		logsCopied = true;
		window.setTimeout(() => {
			logsCopied = false;
		}, 1200);
	}

	async function clearLogs() {
		logs = [];
		logsCopied = false;

		try {
			const response = await fetch('/api/server/logs', { method: 'DELETE' });
			if (!response.ok) throw new Error(`Failed to clear server logs: ${response.status}`);
		} catch (requestError) {
			error = requestError instanceof Error ? requestError.message : 'Failed to clear server logs.';
		}
	}

	function formatClock(value: Date) {
		return CLOCK_FORMATTER.format(value);
	}

	function formatClockDate(value: Date) {
		return CLOCK_DATE_FORMATTER.format(value);
	}

	function formatTimeOnly(value: string | null) {
		if (!value) return '--:--:--';
		return CLOCK_FORMATTER.format(new Date(value));
	}

	function formatDuration(value: number | null) {
		if (value === null) return null;
		return `${(value / 1000).toFixed(1)}s`;
	}

	function formatRefreshCountdown(value: string | null) {
		if (!value) return '--m --s';
		const parsed = Date.parse(value);
		if (Number.isNaN(parsed)) return '--m --s';

		const diff = Math.max(0, parsed - now.getTime());
		const totalSeconds = Math.floor(diff / 1000);
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
	}

	function percentLabel(value: number | null) {
		return value === null ? 'Unknown' : `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;
	}

	function heatColor(value: number | null) {
		if (value === null) return '#94a3b8';
		if (value >= 90) return '#ef4444';
		if (value >= 80) return '#f97316';
		if (value >= 60) return '#f59e0b';
		if (value >= 35) return '#22c55e';
		return '#06b6d4';
	}

	function barWidth(value: number | null) {
		return `${Math.max(0, Math.min(100, value ?? 0))}%`;
	}

	function formatAmount(value: number | null) {
		if (value === null) return 'Unknown';
		if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
		if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
		return value.toLocaleString('en');
	}

	function usageText(window: UsageWindow) {
		if (window.used === null || window.limit === null) return null;
		return `${formatAmount(window.used)} / ${formatAmount(window.limit)}`;
	}

	function resetParts(window: UsageWindow) {
		return resetPartsFromText(countdownText(window.resetAt, window.remainingText));
	}

	function resetPartsFromText(text: string) {
		const match = text.match(/(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/i);

		if (!match || !match[0].trim()) {
			return [{ value: text, unit: '', tone: 'text-muted-foreground' }];
		}

		const days = Number(match[1] ?? 0);
		const hours = Number(match[2] ?? 0);
		const parts = [
			{ value: match[1] ?? '0', unit: 'd', tone: 'text-violet-400', visible: days > 0 },
			{
				value: match[2] ?? '0',
				unit: 'h',
				tone: 'text-cyan-400',
				visible: hours > 0
			},
			{ value: match[3] ?? '0', unit: 'm', tone: 'text-amber-300', visible: true }
		];

		return parts.filter((part) => part.visible);
	}

	function countdownText(resetAt: string | null, remainingText: string | null = null) {
		if (resetAt) {
			const parsed = Date.parse(resetAt);
			if (Number.isNaN(parsed)) {
				return remainingText ?? 'Unknown';
			}
			const diff = parsed - now.getTime();
			if (diff <= 0) return '0m';

			const minutes = Math.floor(diff / 60_000);
			const days = Math.floor(minutes / 1440);
			const hours = Math.floor((minutes % 1440) / 60);
			const remainingMinutes = minutes % 60;
			if (days > 0) return `${days}d ${hours}h ${remainingMinutes}m`;
			if (hours > 0) return `${hours}h ${remainingMinutes}m`;
			return `${remainingMinutes}m`;
		}

		return remainingText ?? 'Unknown';
	}

	function weeklyPace(window: UsageWindow) {
		if (window.id !== 'week' || window.percent === null || !window.resetAt) return null;

		const remainingMs = Date.parse(window.resetAt) - now.getTime();
		if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;

		const target = weeklyTargetPercent(remainingMs);
		const diff = window.percent - target;

		if (diff >= 35) {
			return {
				label: 'Very high pace',
				detail: `used ${percentLabel(window.percent)} / target ${target}%`,
				tone: 'text-rose-100',
				surface: 'border-rose-200/25 bg-rose-100/10',
				dot: 'bg-rose-100 shadow-[0_0_10px_rgba(255,228,230,0.38)]',
				bar: '#fecdd3',
				used: window.percent,
				target
			};
		}

		if (diff >= 24) {
			return {
				label: 'High pace',
				detail: `used ${percentLabel(window.percent)} / target ${target}%`,
				tone: 'text-yellow-100',
				surface: 'border-yellow-200/30 bg-yellow-100/10',
				dot: 'bg-yellow-100 shadow-[0_0_10px_rgba(254,249,195,0.42)]',
				bar: '#fde68a',
				used: window.percent,
				target
			};
		}

		if (diff >= 14) {
			return {
				label: 'Ahead',
				detail: `used ${percentLabel(window.percent)} / target ${target}%`,
				tone: 'text-emerald-100',
				surface: 'border-emerald-200/20 bg-emerald-100/8',
				dot: 'bg-emerald-100 shadow-[0_0_10px_rgba(209,250,229,0.3)]',
				bar: '#a7f3d0',
				used: window.percent,
				target
			};
		}

		if (diff <= -25) {
			return {
				label: 'Plenty left',
				detail: `used ${percentLabel(window.percent)} / target ${target}%`,
				tone: 'text-cyan-300',
				surface: 'border-cyan-400/25 bg-cyan-500/10',
				dot: 'bg-cyan-300 shadow-[0_0_10px_rgba(103,232,249,0.4)]',
				bar: '#22d3ee',
				used: window.percent,
				target
			};
		}

		if (diff <= -10) {
			return {
				label: 'Room to use',
				detail: `used ${percentLabel(window.percent)} / target ${target}%`,
				tone: 'text-sky-300',
				surface: 'border-sky-400/25 bg-sky-500/10',
				dot: 'bg-sky-300 shadow-[0_0_10px_rgba(125,211,252,0.4)]',
				bar: '#38bdf8',
				used: window.percent,
				target
			};
		}

		if (diff <= -4) {
			return {
				label: 'Slightly under',
				detail: `used ${percentLabel(window.percent)} / target ${target}%`,
				tone: 'text-teal-300',
				surface: 'border-teal-400/25 bg-teal-500/10',
				dot: 'bg-teal-300 shadow-[0_0_10px_rgba(94,234,212,0.4)]',
				bar: '#2dd4bf',
				used: window.percent,
				target
			};
		}

		return {
			label: 'On pace',
			detail: `used ${percentLabel(window.percent)} / target ${target}%`,
			tone: 'text-emerald-300',
			surface: 'border-emerald-400/30 bg-emerald-500/10',
			dot: 'bg-emerald-300 shadow-[0_0_10px_rgba(110,231,183,0.45)]',
			bar: '#34d399',
			used: window.percent,
			target
		};
	}

	function weeklyTargetPercent(remainingMs: number) {
		const remainingDays = remainingMs / DAY_MS;
		let target = 95;
		if (remainingDays > 6) target = MIN_WEEKLY_PACE_TARGET;
		else if (remainingDays > 5) target = 20;
		else if (remainingDays > 4) target = 35;
		else if (remainingDays > 3) target = 50;
		else if (remainingDays > 2) target = 65;
		else if (remainingDays > 1) target = 80;
		else if (remainingDays > 0.5) target = 90;
		return Math.max(MIN_WEEKLY_PACE_TARGET, target);
	}

	function statusTone(provider: ProviderUsage) {
		if (needsProviderCheck(provider)) {
			return 'border-cyan-500/30 bg-cyan-500/10 text-cyan-700';
		}
		if (provider.status === 'ok') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700';
		if (provider.status === 'partial') return 'border-amber-500/30 bg-amber-500/10 text-amber-700';
		return 'border-rose-500/30 bg-rose-500/10 text-rose-700';
	}

	function statusLabel(provider: ProviderUsage) {
		if (needsProviderCheck(provider)) return 'Cached';
		if (provider.status === 'ok') return 'Live';
		if (provider.status === 'partial') return 'Partial';
		return 'Unavailable';
	}

	function needsProviderCheck(provider: ProviderUsage) {
		return provider.message.startsWith('Previous data kept;');
	}

	function providerFootnote(provider: ProviderUsage) {
		return needsProviderCheck(provider) ? null : provider.message;
	}

	function checkItems() {
		const items = providers.flatMap((provider) => {
			if (needsProviderCheck(provider)) {
				return [
					{
						provider: provider.name,
						tone: 'warn',
						message: provider.message.replace(/^Previous data kept;\s*/i, '')
					}
				];
			}

			if (provider.status !== 'ok') {
				return [
					{
						provider: provider.name,
						tone: provider.status === 'partial' ? 'warn' : 'error',
						message: provider.message
					}
				];
			}

			return [];
		});

		if (payload?.refreshState?.error) {
			items.push({
				provider: 'Refresh',
				tone: 'error',
				message: payload.refreshState.error
			});
		}

		return items;
	}

	function checkToneClass(tone: string) {
		if (tone === 'error') return 'text-rose-300';
		if (tone === 'warn') return 'text-amber-300';
		return 'text-muted-foreground';
	}

	function activePanelHasContent() {
		return logTab === 'checks' ? checkItems().length > 0 : logs.length > 0;
	}

	function openUsageUrl(url: string) {
		window.open(url, '_blank', 'noopener,noreferrer');
	}

	async function stopServer() {
		if (!confirm('Stop server? The browser connection will be lost.')) return;
		stopping = true;
		try {
			await fetch('/api/server/stop', { method: 'POST' });
		} catch {
			// Expected: server shutdown drops the connection
		}
	}

	function logLevelClass(level: LogEntry['level']) {
		if (level === 'warn') return 'text-amber-400';
		if (level === 'error') return 'text-rose-400';
		if (level === 'info') return 'text-cyan-400';
		return 'text-foreground/70';
	}

	function formatLogTime(iso: string) {
		return new Date(iso).toLocaleTimeString('en', { hour12: false });
	}

	function formatCountdown(timestamp: number | null) {
		if (!timestamp || !Number.isFinite(timestamp)) return null;
		const diff = Math.max(0, timestamp - now.getTime());
		const totalSeconds = Math.floor(diff / 1000);
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
	}

	function isRefreshCoolingDown(timestamp: number | null) {
		return timestamp !== null && timestamp > now.getTime();
	}

	function setRefreshCooldown(timestamp: number) {
		refreshCooldownUntil = timestamp;
		localStorage.setItem('usage-refresh-cooldown-until', String(timestamp));
	}

	function setAutoRefreshInterval(value: number) {
		const allowed = AUTO_REFRESH_INTERVAL_OPTIONS.some((option) => option.value === value);
		if (!allowed) return;
		autoRefreshIntervalMs = value;
		localStorage.setItem(AUTO_REFRESH_INTERVAL_KEY, String(value));
	}

	function restoreRefreshCooldown() {
		const stored = localStorage.getItem('usage-refresh-cooldown-until');
		if (!stored) return;

		const parsed = Number(stored);
		if (Number.isFinite(parsed) && parsed > Date.now()) {
			refreshCooldownUntil = parsed;
		} else {
			localStorage.removeItem('usage-refresh-cooldown-until');
		}
	}

	function restoreAutoRefreshInterval() {
		const stored = Number(localStorage.getItem(AUTO_REFRESH_INTERVAL_KEY));
		if (AUTO_REFRESH_INTERVAL_OPTIONS.some((option) => option.value === stored)) {
			autoRefreshIntervalMs = stored;
		}
	}
</script>

<svelte:head>
	<title>AI Usage Dashboard</title>
</svelte:head>

<main class="min-h-screen bg-background text-foreground">
	<section class="border-b">
		<div class="mx-auto flex max-w-7xl flex-col gap-5 px-5 py-6 sm:px-8 lg:px-10">
			<div class="relative flex w-full items-center py-2">
				<div class="flex items-center gap-3">
					<div
						class="flex size-11 items-center justify-center rounded-md text-cyan-300 shadow-[0_0_18px_rgba(34,211,238,0.35)] ring-1 ring-cyan-400/20"
					>
						<Activity class="size-5 drop-shadow-[0_0_6px_rgba(34,211,238,0.8)]" />
					</div>
					<div>
						<h1
							class="text-xl font-semibold text-foreground drop-shadow-[0_0_8px_rgba(34,211,238,0.15)] sm:text-2xl"
						>
							AI Usage
						</h1>
					</div>
				</div>

				<div class="pointer-events-none absolute inset-0 flex items-center justify-center">
					<div class="flex min-h-20 w-64 flex-col items-center justify-center text-center">
						<div class="text-xs font-medium text-cyan-200/70">{formatClockDate(now)}</div>
						<div
							class="w-full text-center font-mono text-4xl leading-none font-semibold text-cyan-100 tabular-nums drop-shadow-[0_0_20px_rgba(34,211,238,0.4)] sm:text-5xl"
						>
							{formatClock(now)}
						</div>
						<div class="mt-1 text-[11px] text-muted-foreground">
							Updated
							<span class="font-mono text-cyan-200/80 tabular-nums">
								{formatTimeOnly(latestCollectedAt(payload))}
							</span>
						</div>
					</div>
				</div>

				<div class="ml-auto flex shrink-0 items-center">
					<div
						class="flex items-stretch overflow-hidden rounded-xl border border-slate-700/60 bg-slate-900/70 shadow-[0_2px_20px_rgba(0,0,0,0.4)] backdrop-blur-sm"
					>
						<button
							type="button"
							role="switch"
							aria-checked={autoRefresh}
							class={`flex w-20 cursor-pointer flex-col items-center justify-center gap-1.5 px-4 py-2.5 transition-colors duration-150 ${autoRefresh ? 'bg-cyan-500/12' : 'hover:bg-white/5'}`}
							onclick={() => {
								autoRefresh = !autoRefresh;
							}}
						>
							<div class="flex items-center gap-2">
								<span
									class={`relative h-4 w-7 shrink-0 rounded-full transition-all duration-200 ${autoRefresh ? 'bg-cyan-400/85 shadow-[0_0_10px_rgba(34,211,238,0.35)]' : 'bg-slate-700'}`}
								>
									<span
										class={`absolute top-0.5 left-0.5 size-3 rounded-full bg-white shadow-sm transition-transform duration-200 ease-out will-change-transform ${autoRefresh ? 'translate-x-3' : 'translate-x-0'}`}
									></span>
								</span>
								<span
									class={`text-xs font-semibold tracking-wide ${autoRefresh ? 'text-cyan-200' : 'text-slate-400'}`}
									>Auto</span
								>
							</div>
							<span class="font-mono text-[10px] font-medium text-cyan-200/90 tabular-nums">
								{serverRefreshing
									? '···'
									: autoRefresh && !pageIsForeground
										? 'Hidden'
										: nextRefreshCountdown}
							</span>
						</button>

						<div class="my-2 w-px bg-slate-700/70"></div>

						<div class="flex w-16 items-center justify-center px-2">
							<select
								aria-label="Auto refresh interval"
								title="Auto refresh interval"
								class="h-8 w-full cursor-pointer rounded-md border border-slate-700/70 bg-slate-950/70 px-1.5 text-center font-mono text-[11px] font-semibold text-cyan-100 outline-none transition-colors hover:border-cyan-500/40 focus:border-cyan-400/70"
								value={autoRefreshIntervalMs}
								onchange={(event) => setAutoRefreshInterval(Number(event.currentTarget.value))}
							>
								{#each AUTO_REFRESH_INTERVAL_OPTIONS as option (option.value)}
									<option value={option.value}>{option.label}</option>
								{/each}
							</select>
						</div>

						<div class="my-2 w-px bg-slate-700/70"></div>

						<button
							type="button"
							class="flex w-24 cursor-pointer flex-col items-center justify-center gap-1.5 px-4 py-2.5 transition-colors duration-150 hover:bg-violet-500/10 disabled:cursor-not-allowed disabled:opacity-50"
							disabled={refreshLocked}
							onclick={() => void refreshUsage('manual')}
						>
							<div class="flex items-center gap-2">
								{#if working}
									<span
										aria-hidden="true"
										class="size-3 rounded-full border-[1.5px] border-violet-400/30 border-t-violet-300 motion-safe:animate-spin"
									></span>
								{:else}
									<RefreshCcw class="size-3 text-violet-400" />
								{/if}
								<span class="text-xs font-semibold tracking-wide text-slate-300"
									>{working ? 'Working' : 'Refresh'}</span
								>
							</div>
							<span class="font-mono text-[10px] font-medium text-violet-200/90 tabular-nums">
								{refreshCooldownCountdown ?? (working ? '···' : ' ')}
							</span>
						</button>

						<div class="my-2 w-px bg-slate-700/70"></div>

						<button
							type="button"
							class="flex cursor-pointer items-center justify-center px-4 py-2.5 text-rose-400/70 transition-colors duration-150 hover:bg-rose-500/12 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-40"
							title="Stop Server"
							disabled={stopping}
							onclick={() => void stopServer()}
						>
							<Power class="size-4" />
						</button>
					</div>
				</div>
			</div>

			{#if error}
				<div
					class="flex items-center gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-700"
				>
					<AlertTriangle class="size-4" />
					<span>{error}</span>
				</div>
			{/if}
		</div>
	</section>

	<section class="mx-auto grid max-w-7xl gap-5 px-5 py-6 sm:px-8 lg:px-10">
		{#if loading}
			<div
				class="flex items-center gap-2 rounded-md border bg-card p-6 text-sm text-muted-foreground"
			>
				<span
					aria-hidden="true"
					class="size-3.5 rounded-full border-2 border-cyan-300/25 border-t-cyan-200 motion-safe:animate-spin"
				></span>
				Loading usage data...
			</div>
		{:else}
			<div class="grid gap-5 grid-cols-1 lg:grid-cols-2 xl:grid-cols-3">
				{#each providers as provider (provider.provider)}
					<article class="flex h-full flex-col rounded-md border bg-card p-5 shadow-sm">
						<div class="flex items-center justify-between gap-3">
							<div class="flex min-w-0 items-center gap-3">
								<h2 class="flex min-w-0 items-center gap-2 text-2xl font-semibold tracking-normal">
									<Terminal class="size-4" />
									<span class="truncate">{provider.name}</span>
								</h2>
							</div>

							<div class="flex shrink-0 items-center gap-1.5">
								<span
									class={`w-24 text-center rounded-md border px-2 py-1 text-xs font-medium ${statusTone(provider)}`}
								>
									{statusLabel(provider)}
								</span>
								<span
									class="w-14 text-center rounded-md border border-cyan-300/15 bg-cyan-500/10 px-2 py-1 font-mono text-xs text-cyan-200 tabular-nums"
								>
									{formatDuration(provider.collectionDurationMs) ?? '--'}
								</span>
							</div>
						</div>

						<div class="mt-5">
							{#if provider.provider !== 'agy' && (provider.provider as string) !== 'gemini'}
								<div class="grid gap-2.5 grid-cols-1">
									{#each WINDOW_ORDER as windowId (windowId)}
										{@const usageWindow = provider.windows[windowId]}
										<div
											class="flex min-h-[7.25rem] flex-col justify-between gap-2.5 rounded-lg border border-border/40 bg-slate-900/40 p-3.5 backdrop-blur-sm transition-all duration-300 hover:border-cyan-500/25 hover:bg-slate-900/60 hover:shadow-sm"
										>
											<div class="flex items-center justify-between gap-3">
												<div class="min-w-0">
													<div class="truncate text-[13px] font-semibold text-foreground/95">
														{usageWindow.label}
													</div>
													{#if usageText(usageWindow)}
														<div class="mt-0.5 truncate text-[11px] text-muted-foreground">
															{usageText(usageWindow)}
														</div>
													{/if}
												</div>
												<div class="w-20 shrink-0 text-right">
													<div
														class="text-xl font-bold tracking-tight"
														style={`color: ${heatColor(usageWindow.percent)}`}
													>
														{percentLabel(usageWindow.percent)}
													</div>
												</div>
											</div>

											<div class="relative h-1.5 overflow-hidden rounded-full bg-slate-950/60">
												<div class="absolute top-0 left-[80%] z-10 h-full w-px bg-slate-800"></div>
												<div
													class="h-full rounded-full transition-all"
													style={`width: ${barWidth(usageWindow.percent)}; background: linear-gradient(90deg, #06b6d4, ${heatColor(usageWindow.percent)});`}
												></div>
											</div>

											<div class="flex items-center justify-between gap-3 text-[11px]">
												<div class="flex items-center gap-1.5 text-foreground/50">
													<Clock3 class="size-3" />
													<span class="font-medium tracking-[0.12em] uppercase">Reset</span>
												</div>
												<div class="w-28 shrink-0 text-right">
													<div
														class="flex items-center justify-end gap-0.5 font-mono text-xs font-semibold text-foreground/85"
													>
														{#each resetParts(usageWindow) as part (`${usageWindow.id}-${part.unit || part.value}`)}
															<span class={part.tone}>{part.value}{part.unit}</span>
														{/each}
													</div>
												</div>
											</div>
										</div>
									{/each}
								</div>
							{/if}

							{#if (provider.modelUsages ?? []).length > 0}
								<div class="grid gap-2.5 grid-cols-1">
									{#each (provider.modelUsages ?? []).filter((m) => m.label === 'Flash 3.5 (High)' || m.label === 'Sonnet 4.6' || /^(Gemini|Claude\/GPT) · (5h|Week)$/.test(m.label)) as model (model.label)}
										<div
											class="flex min-h-[7.25rem] flex-col justify-between gap-2.5 rounded-lg border border-border/40 bg-slate-900/40 p-3.5 backdrop-blur-sm transition-all duration-300 hover:border-cyan-500/25 hover:bg-slate-900/60 hover:shadow-sm"
										>
											<div class="flex items-center justify-between gap-3">
												<div class="min-w-0">
													<div
														class="text-[13px] font-semibold text-foreground/95 leading-snug"
														title={model.label}
													>
														{model.label}
													</div>
												</div>
												<div class="w-20 shrink-0 text-right">
													<div
														class="text-xl font-bold tracking-tight"
														style={`color: ${heatColor(model.percent)}`}
													>
														{percentLabel(model.percent)}
													</div>
												</div>
											</div>

											<div class="relative h-1.5 overflow-hidden rounded-full bg-slate-950/60">
												<div class="absolute top-0 left-[80%] z-10 h-full w-px bg-slate-800"></div>
												<div
													class="h-full rounded-full transition-all"
													style={`width: ${barWidth(model.percent)}; background: linear-gradient(90deg, #06b6d4, ${heatColor(model.percent)});`}
												></div>
											</div>

											<div class="flex items-center justify-between gap-3 text-[11px]">
												<div class="flex items-center gap-1.5 text-foreground/50">
													<Clock3 class="size-3" />
													<span class="font-medium tracking-[0.12em] uppercase">Reset</span>
												</div>
												<div class="w-28 shrink-0 text-right">
													<div
														class="flex items-center justify-end gap-0.5 font-mono text-xs font-semibold text-foreground/85"
													>
														{#each resetPartsFromText(countdownText(model.resetAt, model.remainingText)) as part (`${model.label}-sub-${part.unit || part.value}`)}
															<span class={part.tone}>{part.value}{part.unit}</span>
														{/each}
													</div>
												</div>
											</div>
										</div>
									{/each}
								</div>
							{/if}
						</div>

						{#if provider.provider !== 'agy' && (provider.provider as string) !== 'gemini'}
							{@const pace = weeklyPace(provider.windows.week)}
							{#if pace}
								<div class={`mt-3 rounded-md border px-3 py-3 text-xs ${pace.surface}`}>
									<div class="flex items-center justify-between gap-3">
										<div class="flex items-center gap-2">
											<span class={`size-2 rounded-full ${pace.dot}`}></span>
											<span class="font-medium tracking-[0.14em] text-foreground/60 uppercase"
												>Pace</span
											>
										</div>
										<div class="text-right">
											<span class={`font-semibold ${pace.tone}`}>{pace.label}</span>
											<span class="ml-2 font-mono text-muted-foreground">{pace.detail}</span>
										</div>
									</div>
									<div class="relative mt-3 h-3 overflow-hidden rounded-full bg-background/70">
										<div
											class="h-full rounded-full transition-all"
											style={`width: ${barWidth(pace.used)}; background: ${pace.bar};`}
										></div>
										<div
											class="absolute top-0 h-full w-px bg-foreground/80"
											style={`left: ${barWidth(pace.target)};`}
										></div>
									</div>
								</div>
							{/if}
						{/if}

						<div
							class="mt-auto flex items-center justify-between gap-3 pt-4 text-xs text-muted-foreground"
						>
							{#if providerFootnote(provider)}
								<span>{providerFootnote(provider)}</span>
							{/if}
							{#if provider.usageUrl}
								<button
									type="button"
									class="inline-flex cursor-pointer items-center gap-1 text-cyan-300/80 transition hover:text-cyan-200 active:scale-[0.98]"
									onclick={() => provider.usageUrl && openUsageUrl(provider.usageUrl)}
								>
									Web
									<ExternalLink class="size-3" />
								</button>
							{/if}
						</div>
					</article>
				{/each}
			</div>
		{/if}
	</section>

	{#if showLogs}
		<section class="mx-auto max-w-7xl px-5 pb-6 sm:px-8 lg:px-10">
			<div class="overflow-hidden rounded-md border bg-card">
				<div class="flex items-center justify-between gap-3 border-b px-3 py-2">
					<div class="flex items-center gap-1">
						<button
							type="button"
							class={`flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors ${
								logTab === 'logs'
									? 'border-cyan-300/30 bg-cyan-500/10 text-cyan-200'
									: 'border-transparent text-muted-foreground hover:border-border hover:bg-muted/70 hover:text-foreground'
							}`}
							onclick={() => (logTab = 'logs')}
						>
							<ScrollText class="size-3.5" />
							Logs
							<span class="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] tabular-nums"
								>{logs.length}</span
							>
						</button>
						<button
							type="button"
							class={`flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors ${
								logTab === 'checks'
									? 'border-amber-300/30 bg-amber-500/10 text-amber-200'
									: 'border-transparent text-muted-foreground hover:border-border hover:bg-muted/70 hover:text-foreground'
							}`}
							onclick={() => (logTab = 'checks')}
						>
							<AlertTriangle class="size-3.5" />
							Checks
							<span class="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] tabular-nums"
								>{checkItems().length}</span
							>
						</button>
					</div>
					<div class="flex items-center gap-1.5">
						<label
							class="flex h-6 cursor-pointer items-center gap-1 rounded border border-transparent px-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase transition-colors hover:border-border hover:bg-muted/70 hover:text-foreground hover:shadow-sm"
							title="Auto scroll logs"
						>
							<input
								type="checkbox"
								bind:checked={autoScrollLogs}
								class="size-2.5 accent-cyan-400"
							/>
							Auto
						</label>
						<button
							type="button"
							class="flex h-6 cursor-pointer items-center gap-1 rounded border border-transparent px-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase transition-colors hover:border-border hover:bg-muted/70 hover:text-foreground hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-transparent disabled:hover:bg-transparent disabled:hover:shadow-none"
							disabled={!activePanelHasContent()}
							title={logTab === 'checks' ? 'Copy checks' : 'Copy logs'}
							onclick={() => void copyActivePanel()}
						>
							<Copy class="size-3" />
							{logsCopied ? 'Copied' : 'Copy'}
						</button>
						<button
							type="button"
							class="h-6 cursor-pointer rounded border border-transparent px-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase transition-colors hover:border-border hover:bg-muted/70 hover:text-foreground hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-transparent disabled:hover:bg-transparent disabled:hover:shadow-none"
							disabled={logs.length === 0}
							title="Clear logs"
							onclick={() => void clearLogs()}
						>
							Clear
						</button>
					</div>
				</div>
				<div
					bind:this={logContainer}
					class="log-scroll h-72 overflow-y-auto bg-background p-3 font-mono text-[10px] leading-4"
				>
					{#if logTab === 'checks'}
						{@const checks = checkItems()}
						{#if checks.length === 0}
							<span class="text-muted-foreground/50">No checks needed</span>
						{:else}
							{#each checks as item (`${item.provider}-${item.message}`)}
								<div class="flex gap-2 leading-5">
									<span class={`w-24 shrink-0 ${checkToneClass(item.tone)}`}>{item.provider}</span>
									<span class={checkToneClass(item.tone)}>{item.message}</span>
								</div>
							{/each}
						{/if}
					{:else if logs.length === 0}
						<span class="text-muted-foreground/50">No logs yet</span>
					{:else}
						{#each logs as entry (entry.timestamp + entry.message)}
							<div class="flex gap-2 leading-5">
								<span class="shrink-0 text-muted-foreground/50"
									>{formatLogTime(entry.timestamp)}</span
								>
								<span class="w-10 shrink-0 {logLevelClass(entry.level)}">[{entry.level}]</span>
								<span class="{logLevelClass(entry.level)} break-all">{entry.message}</span>
							</div>
						{/each}
					{/if}
				</div>
			</div>
		</section>
	{/if}
</main>

<style>
	.log-scroll::-webkit-scrollbar {
		width: 4px;
	}
	.log-scroll::-webkit-scrollbar-track {
		background: transparent;
	}
	.log-scroll::-webkit-scrollbar-thumb {
		background: oklch(0.4 0 0 / 0.35);
		border-radius: 99px;
	}
	.log-scroll::-webkit-scrollbar-thumb:hover {
		background: oklch(0.55 0 0 / 0.6);
	}
</style>
