<script lang="ts">
	import { onMount } from 'svelte';
	import {
		Activity,
		AlertTriangle,
		Clock3,
		ExternalLink,
		RefreshCcw,
		Terminal
	} from '@lucide/svelte';
	import type { ProviderUsage, UsagePayload, UsageWindow, UsageWindowId } from '$lib/usage';

	const AUTO_REFRESH_SETTLE_MS = 1000;
	const MANUAL_REFRESH_COOLDOWN_MS = 10_000;
	const WINDOW_ORDER: UsageWindowId[] = ['fiveHour', 'week'];

	let payload = $state<UsagePayload | null>(null);
	let loading = $state(true);
	let refreshing = $state(false);
	let error = $state<string | null>(null);
	let now = $state(new Date());
	let autoRefresh = $state(true);
	let refreshCooldownUntil = $state<number | null>(null);
	let refreshMode = $state<'idle' | 'manual' | 'auto'>('idle');

	const providers = $derived(payload?.providers ?? []);
	const nextRefreshCountdown = $derived(formatRefreshCountdown(payload?.nextRefreshAt ?? null));
	const refreshCooldownCountdown = $derived(formatCountdown(refreshCooldownUntil));
	const refreshLocked = $derived(refreshing || isRefreshCoolingDown(refreshCooldownUntil));
	let initialRefreshStarted = false;

	$effect(() => {
		if (!autoRefresh || refreshing || refreshLocked || !payload?.nextRefreshAt) return;

		const delay = Math.max(
			0,
			Date.parse(payload.nextRefreshAt) - Date.now() + AUTO_REFRESH_SETTLE_MS
		);
		const timer = window.setTimeout(() => void refreshUsage(), delay);

		return () => {
			window.clearTimeout(timer);
		};
	});

	onMount(() => {
		restoreRefreshCooldown();
		void loadUsage({ refreshAfterLoad: true });
		const clockTimer = window.setInterval(() => {
			now = new Date();
		}, 1000);

		return () => {
			window.clearInterval(clockTimer);
		};
	});

	async function loadUsage(options: { refreshAfterLoad?: boolean } = {}) {
		loading = true;
		error = null;

		try {
			const response = await fetch('/api/usage');
			if (!response.ok) throw new Error(`Usage request failed: ${response.status}`);
			payload = (await response.json()) as UsagePayload;
			if (options.refreshAfterLoad && !initialRefreshStarted) {
				if (isRefreshCoolingDown(refreshCooldownUntil)) {
					return;
				}
				initialRefreshStarted = true;
				window.setTimeout(() => void refreshUsage('auto'), 250);
			}
		} catch (requestError) {
			error = requestError instanceof Error ? requestError.message : 'Failed to load usage data.';
		} finally {
			loading = false;
		}
	}

	async function refreshUsage(mode: 'manual' | 'auto' = 'manual') {
		if (refreshing || isRefreshCoolingDown(refreshCooldownUntil)) {
			return;
		}

		refreshMode = mode;
		refreshing = true;
		error = null;
		setRefreshCooldown(Date.now() + MANUAL_REFRESH_COOLDOWN_MS);

		try {
			const response = await fetch('/api/usage/refresh', { method: 'POST' });
			if (!response.ok) throw new Error(`Refresh failed: ${response.status}`);
			payload = (await response.json()) as UsagePayload;
		} catch (requestError) {
			error =
				requestError instanceof Error ? requestError.message : 'Failed to refresh usage data.';
		} finally {
			refreshing = false;
			loading = false;
			refreshMode = 'idle';
		}
	}

	function formatDateTime(value: string | null) {
		if (!value) return 'Not collected';
		return new Intl.DateTimeFormat('en', {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			month: 'short',
			day: 'numeric'
		}).format(new Date(value));
	}

	function formatClock(value: Date) {
		return new Intl.DateTimeFormat('en', {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hour12: false
		}).format(value);
	}

	function formatClockDate(value: Date) {
		return new Intl.DateTimeFormat('en', {
			weekday: 'short',
			month: 'short',
			day: 'numeric'
		}).format(value);
	}

	function formatTimeOnly(value: string | null) {
		if (!value) return '--:--:--';
		return new Intl.DateTimeFormat('en', {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hour12: false
		}).format(new Date(value));
	}

	function formatRefreshCountdown(value: string | null) {
		if (!value) return '--m --s';
		const diff = Math.max(0, Date.parse(value) - now.getTime());
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
		return resetPartsFromText(countdownText(window));
	}

	function resetPartsFromText(text: string) {
		const match = text.match(/(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/i);

		if (!match || !match[0].trim()) {
			return [{ value: text, unit: '', tone: 'text-muted-foreground' }];
		}

		const days = Number(match[1] ?? 0);
		const parts = [
			{ value: match[1] ?? '0', unit: 'd', tone: 'text-violet-400', visible: days > 0 },
			{ value: match[2] ?? '0', unit: 'h', tone: 'text-cyan-400', visible: true },
			{ value: match[3] ?? '0', unit: 'm', tone: 'text-amber-300', visible: true }
		];

		return parts.filter((part) => part.visible);
	}

	function countdownText(window: UsageWindow) {
		if (window.resetAt) {
			const diff = Date.parse(window.resetAt) - now.getTime();
			if (diff <= 0) return '0h 0m';

			const minutes = Math.floor(diff / 60_000);
			const days = Math.floor(minutes / 1440);
			const hours = Math.floor((minutes % 1440) / 60);
			const remainingMinutes = minutes % 60;
			return days > 0
				? `${days}d ${hours}h ${remainingMinutes}m`
				: `${hours}h ${remainingMinutes}m`;
		}

		return window.remainingText ?? 'Unknown';
	}

	function statusTone(provider: ProviderUsage) {
		if (provider.status === 'ok') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700';
		if (provider.status === 'partial') return 'border-amber-500/30 bg-amber-500/10 text-amber-700';
		return 'border-rose-500/30 bg-rose-500/10 text-rose-700';
	}

	function statusLabel(provider: ProviderUsage) {
		if (provider.status === 'ok') return 'Live';
		if (provider.status === 'partial') return 'Partial';
		return 'Unavailable';
	}

	function openUsageUrl(url: string) {
		window.open(url, '_blank', 'noopener,noreferrer');
	}

	function formatCountdown(timestamp: number | null) {
		if (!timestamp) return null;
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
</script>

<svelte:head>
	<title>AI Usage Dashboard</title>
</svelte:head>

<main class="min-h-screen bg-background text-foreground">
	<section class="border-b">
		<div class="mx-auto flex max-w-7xl flex-col gap-5 px-5 py-6 sm:px-8 lg:px-10">
			<div class="grid w-full gap-4 lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-center">
				<div class="flex items-center gap-3 justify-self-start">
					<div class="flex size-11 items-center justify-center rounded-md text-cyan-200">
						<Activity class="size-5" />
					</div>
					<div>
						<h1 class="text-xl font-semibold text-foreground sm:text-2xl">AI Usage</h1>
					</div>
				</div>

				<div class="flex flex-wrap items-center justify-center gap-4 justify-self-center">
					<div
						class="flex min-h-20 min-w-64 flex-col items-center justify-center px-5 py-2 text-center"
					>
						<div class="text-xs font-medium text-cyan-200/70">{formatClockDate(now)}</div>
						<div
							class="w-full text-center font-mono text-4xl leading-none font-semibold text-cyan-100 tabular-nums drop-shadow-sm sm:text-5xl"
						>
							{formatClock(now)}
						</div>
						<div class="mt-1 text-[11px] text-muted-foreground">
							Updated
							<span class="font-mono text-cyan-200/80 tabular-nums">
								{formatTimeOnly(payload?.generatedAt ?? null)}
							</span>
						</div>
					</div>
				</div>

				<div class="flex items-center justify-center gap-2 justify-self-end">
					<div class="flex items-center gap-2">
						<button
							type="button"
							role="switch"
							aria-checked={autoRefresh}
							class="inline-flex h-10 w-40 shrink-0 cursor-pointer items-center gap-2 overflow-hidden rounded-md border border-cyan-300/15 px-3 text-sm font-medium text-cyan-50/80 transition hover:border-cyan-300/30 hover:text-cyan-50 active:scale-[0.98]"
							onclick={() => {
								autoRefresh = !autoRefresh;
							}}
						>
							<span
								class={`relative inline-flex h-5 w-9 items-center rounded-full transition ${autoRefresh ? 'bg-cyan-500/90' : 'bg-muted-foreground/30'}`}
							>
								<span
									class={`size-4 rounded-full bg-background shadow-sm transition ${autoRefresh ? 'translate-x-4' : 'translate-x-0.5'}`}
								></span>
							</span>
							<span class="w-8 text-xs">Auto</span>
							<span class="w-16 font-mono text-xs text-cyan-300 tabular-nums">
								{refreshing && refreshMode === 'auto' ? 'Refreshing' : nextRefreshCountdown}
							</span>
						</button>
						<button
							type="button"
							class="inline-flex h-10 w-36 shrink-0 cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-md border border-violet-300/20 px-3.5 text-xs font-semibold text-violet-100 transition hover:border-violet-300/40 hover:bg-violet-500/10 hover:text-violet-50 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
							disabled={refreshLocked}
							onclick={() => void refreshUsage('manual')}
						>
							<RefreshCcw
								class={`size-3.5 text-violet-200 ${refreshing ? 'animate-spin motion-safe:animate-spin' : ''}`}
							/>
							<span class="min-w-12 text-center whitespace-nowrap">
								{refreshing ? 'Working' : 'Refresh'}
							</span>
							<span
								class="min-w-12 text-right font-mono text-[11px] text-violet-200/70 tabular-nums"
							>
								{#if !refreshing && refreshCooldownCountdown}
									{refreshCooldownCountdown}
								{:else}
									&nbsp;
								{/if}
							</span>
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
			<div class="rounded-md border bg-card p-6 text-sm text-muted-foreground">
				Loading usage data...
			</div>
		{:else}
			<div class="grid gap-4 lg:grid-cols-3">
				{#each providers as provider (provider.provider)}
					<article class="flex h-full flex-col rounded-md border bg-card p-5 shadow-sm">
						<div class="flex items-start justify-between gap-3">
							<div>
								<div class="flex items-center gap-2 text-sm text-muted-foreground">
									<Terminal class="size-4" />
									<span>{provider.command} {provider.slashCommand}</span>
								</div>
								<h2 class="mt-2 text-2xl font-semibold tracking-normal">{provider.name}</h2>
							</div>

							<span
								class={`rounded-md border px-2 py-1 text-xs font-medium ${statusTone(provider)}`}
							>
								{statusLabel(provider)}
							</span>
						</div>

						<div class="mt-5 grid gap-3">
							{#if provider.provider !== 'gemini'}
								{#each WINDOW_ORDER as windowId (windowId)}
									{@const usageWindow = provider.windows[windowId]}
									<div
										class="flex min-h-32 flex-col justify-between rounded-md border bg-background p-4"
									>
										<div class="flex items-center justify-between gap-3">
											<div>
												<div class="text-sm font-medium">{usageWindow.label}</div>
												{#if usageText(usageWindow)}
													<div class="mt-1 text-xs text-muted-foreground">
														{usageText(usageWindow)}
													</div>
												{/if}
											</div>
											<div class="text-right">
												<div
													class="text-2xl font-semibold"
													style={`color: ${heatColor(usageWindow.percent)}`}
												>
													{percentLabel(usageWindow.percent)}
												</div>
											</div>
										</div>

										<div class="relative mt-4 h-3 overflow-hidden rounded-full bg-muted">
											<div
												class="absolute top-0 left-[80%] z-10 h-full w-px bg-foreground/70"
											></div>
											<div
												class="h-full rounded-full transition-all"
												style={`width: ${barWidth(usageWindow.percent)}; background: linear-gradient(90deg, #06b6d4, ${heatColor(usageWindow.percent)});`}
											></div>
										</div>

										<div class="mt-3 flex items-center justify-between gap-3 text-[11px]">
											<div class="flex items-center gap-1.5 text-foreground/60">
												<Clock3 class="size-3" />
												<span class="font-medium tracking-[0.14em] uppercase">Reset</span>
											</div>
											<div
												class="flex items-center gap-1 font-mono text-[12px] font-semibold text-foreground/85"
											>
												{#each resetParts(usageWindow) as part (`${usageWindow.id}-${part.unit || part.value}`)}
													<span class={part.tone}>{part.value}{part.unit}</span>
												{/each}
											</div>
										</div>
									</div>
								{/each}
								<div aria-hidden="true" class="min-h-32"></div>
							{/if}

							{#if (provider.modelUsages ?? []).length > 0}
								{#each provider.modelUsages ?? [] as model (model.label)}
									<div
										class="flex min-h-32 flex-col justify-between rounded-md border bg-background p-4"
									>
										<div class="flex items-center justify-between gap-3">
											<div>
												<div class="text-sm font-medium">{model.label}</div>
												<div class="mt-1 text-xs text-muted-foreground">Model usage</div>
											</div>
											<div class="text-right">
												<div
													class="text-2xl font-semibold"
													style={`color: ${heatColor(model.percent)}`}
												>
													{percentLabel(model.percent)}
												</div>
											</div>
										</div>

										<div class="relative mt-4 h-3 overflow-hidden rounded-full bg-muted">
											<div
												class="absolute top-0 left-[80%] z-10 h-full w-px bg-foreground/70"
											></div>
											<div
												class="h-full rounded-full transition-all"
												style={`width: ${barWidth(model.percent)}; background: linear-gradient(90deg, #06b6d4, ${heatColor(model.percent)});`}
											></div>
										</div>

										<div class="mt-3 flex items-center justify-between gap-3 text-[11px]">
											<div class="flex items-center gap-1.5 text-foreground/60">
												<Clock3 class="size-3" />
												<span class="font-medium tracking-[0.14em] uppercase">Reset</span>
											</div>
											<div
												class="flex items-center gap-1 font-mono text-[12px] font-semibold text-foreground/85"
											>
												{#each resetPartsFromText(model.remainingText ?? formatDateTime(model.resetAt)) as part (`${model.label}-${part.unit || part.value}`)}
													<span class={part.tone}>{part.value}{part.unit}</span>
												{/each}
											</div>
										</div>
									</div>
								{/each}
							{/if}
						</div>

						<div
							class="mt-auto flex items-center justify-between gap-3 pt-4 text-xs text-muted-foreground"
						>
							<span>{provider.message}</span>
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
</main>
