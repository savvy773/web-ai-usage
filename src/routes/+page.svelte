<script lang="ts">
	import { onMount } from 'svelte';
	import {
		Activity,
		AlertTriangle,
		Clock3,
		ExternalLink,
		RefreshCcw,
		Terminal,
		Zap
	} from '@lucide/svelte';
	import type { ProviderUsage, UsagePayload, UsageWindow, UsageWindowId } from '$lib/usage';

	const REFRESH_MS = 10 * 60 * 1000;
	const WINDOW_ORDER: UsageWindowId[] = ['fiveHour', 'week'];

	let payload = $state<UsagePayload | null>(null);
	let loading = $state(true);
	let refreshing = $state(false);
	let error = $state<string | null>(null);
	let now = $state(new Date());

	const providers = $derived(payload?.providers ?? []);
	const history = $derived(payload?.history ?? []);

	onMount(() => {
		void loadUsage();
		const refreshTimer = window.setInterval(() => void refreshUsage(), REFRESH_MS);
		const clockTimer = window.setInterval(() => {
			now = new Date();
		}, 30_000);

		return () => {
			window.clearInterval(refreshTimer);
			window.clearInterval(clockTimer);
		};
	});

	async function loadUsage() {
		loading = true;
		error = null;

		try {
			const response = await fetch('/api/usage');
			if (!response.ok) throw new Error(`Usage request failed: ${response.status}`);
			payload = (await response.json()) as UsagePayload;
		} catch (requestError) {
			error = requestError instanceof Error ? requestError.message : 'Failed to load usage data.';
		} finally {
			loading = false;
		}
	}

	async function refreshUsage() {
		refreshing = true;
		error = null;

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

	function formatBucket(value: string) {
		return new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit' }).format(
			new Date(value)
		);
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
		if (window.used === null || window.limit === null) return 'Limit unavailable';
		return `${formatAmount(window.used)} / ${formatAmount(window.limit)}`;
	}

	function resetParts(window: UsageWindow) {
		const text = countdownText(window);
		const match = text.match(/(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/i);

		if (!match || !match[0].trim()) {
			return [{ value: text, unit: '', tone: 'text-muted-foreground' }];
		}

		return [
			{ value: match[1] ?? '0', unit: 'd', tone: 'text-sky-500' },
			{ value: match[2] ?? '0', unit: 'h', tone: 'text-emerald-500' },
			{ value: match[3] ?? '0', unit: 'm', tone: 'text-orange-500' }
		];
	}

	function countdownText(window: UsageWindow) {
		if (window.resetAt) {
			const diff = Date.parse(window.resetAt) - now.getTime();
			if (diff <= 0) return '0d 0h 0m';

			const minutes = Math.floor(diff / 60_000);
			const days = Math.floor(minutes / 1440);
			const hours = Math.floor((minutes % 1440) / 60);
			const remainingMinutes = minutes % 60;
			return `${days}d ${hours}h ${remainingMinutes}m`;
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

	function historyValue(provider: ProviderUsage, windowId: UsageWindowId, bucketIndex: number) {
		const bucket = history[bucketIndex];
		return bucket?.providers[provider.provider]?.windows[windowId]?.percent ?? null;
	}

	function openUsageUrl(url: string) {
		window.open(url, '_blank', 'noopener,noreferrer');
	}
</script>

<svelte:head>
	<title>AI Usage Dashboard</title>
</svelte:head>

<main class="min-h-screen bg-background text-foreground">
	<section class="border-b bg-muted/30">
		<div class="mx-auto flex max-w-7xl flex-col gap-5 px-5 py-6 sm:px-8 lg:px-10">
			<div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
				<div>
					<div class="flex items-center gap-2 text-sm font-medium text-muted-foreground">
						<Activity class="size-4" />
						<span>Local CLI telemetry</span>
					</div>
					<h1 class="mt-2 text-3xl font-semibold tracking-normal sm:text-4xl">
						AI Usage Dashboard
					</h1>
				</div>

				<div class="flex flex-wrap items-center gap-2">
					<div class="rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">
						Last update: {formatDateTime(payload?.generatedAt ?? null)}
					</div>
					<button
						type="button"
						class="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
						disabled={refreshing}
						onclick={() => void refreshUsage()}
					>
						<RefreshCcw class={`size-4 ${refreshing ? 'animate-spin' : ''}`} />
						Refresh
					</button>
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
					<article class="rounded-md border bg-card p-5 shadow-sm">
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

						<div class="mt-5 grid gap-4">
							{#each WINDOW_ORDER as windowId (windowId)}
								{@const usageWindow = provider.windows[windowId]}
								<div class="rounded-md border bg-background p-4">
									<div class="flex items-center justify-between gap-3">
										<div>
											<div class="text-sm font-medium">{usageWindow.label}</div>
											<div class="mt-1 text-xs text-muted-foreground">{usageText(usageWindow)}</div>
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
										<div class="absolute top-0 left-[80%] z-10 h-full w-px bg-foreground/70"></div>
										<div
											class="h-full rounded-full transition-all"
											style={`width: ${barWidth(usageWindow.percent)}; background: linear-gradient(90deg, #06b6d4, ${heatColor(usageWindow.percent)});`}
										></div>
									</div>

									<div class="mt-3 flex items-center justify-between gap-3 text-xs">
										<div class="flex items-center gap-1 text-muted-foreground">
											<Clock3 class="size-3.5" />
											<span>Reset</span>
										</div>
										<div class="flex items-center gap-1 font-medium">
											{#each resetParts(usageWindow) as part (`${usageWindow.id}-${part.unit || part.value}`)}
												<span class={part.tone}>{part.value}{part.unit}</span>
											{/each}
										</div>
									</div>
								</div>
							{/each}
						</div>

						<div class="mt-4 flex items-center justify-between gap-3 text-xs text-muted-foreground">
							<span>{provider.message}</span>
							{#if provider.usageUrl}
								<button
									type="button"
									class="inline-flex items-center gap-1 hover:text-foreground"
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

			<div class="rounded-md border bg-card p-5 shadow-sm">
				<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
					<div>
						<div class="flex items-center gap-2 text-sm font-medium text-muted-foreground">
							<Zap class="size-4" />
							<span>Recent hour</span>
						</div>
						<h2 class="mt-1 text-xl font-semibold tracking-normal">10-minute usage trend</h2>
					</div>
					<div class="text-sm text-muted-foreground">
						Next auto refresh: {formatDateTime(payload?.nextRefreshAt ?? null)}
					</div>
				</div>

				<div class="mt-5 grid gap-5">
					{#each providers as provider (provider.provider)}
						<div class="grid gap-3">
							<div class="flex items-center justify-between gap-3">
								<div class="font-medium">{provider.name}</div>
								<div class="text-xs text-muted-foreground">80% line shown on every column</div>
							</div>

							<div class="grid gap-4 md:grid-cols-2">
								{#each WINDOW_ORDER as windowId (windowId)}
									<div class="rounded-md border bg-background p-4">
										<div class="mb-3 flex items-center justify-between text-sm">
											<span class="font-medium">{provider.windows[windowId].label}</span>
											<span class="text-muted-foreground">{history.length} buckets</span>
										</div>

										<div class="flex h-40 items-end gap-2 border-b border-l px-2 pb-2">
											{#each history as bucket, bucketIndex (bucket.bucketStart)}
												{@const value = historyValue(provider, windowId, bucketIndex)}
												<div class="group relative flex min-w-9 flex-1 items-end justify-center">
													<div
														class="absolute right-0 bottom-[80%] left-0 h-px bg-foreground/50"
													></div>
													<div
														class="w-full rounded-t-sm transition-all"
														style={`height: ${barWidth(value)}; min-height: ${value === null ? '3px' : '8px'}; background: ${heatColor(value)}; opacity: ${value === null ? 0.35 : 1};`}
														aria-label={`${provider.name} ${provider.windows[windowId].label} ${percentLabel(value)}`}
													></div>
													<div
														class="pointer-events-none absolute bottom-full mb-2 hidden rounded-md border bg-popover px-2 py-1 text-xs shadow-sm group-hover:block"
													>
														{formatBucket(bucket.bucketStart)} · {percentLabel(value)}
													</div>
												</div>
											{/each}
										</div>

										<div class="mt-2 flex justify-between gap-2 text-xs text-muted-foreground">
											{#each history as bucket (bucket.bucketStart)}
												<span>{formatBucket(bucket.bucketStart)}</span>
											{/each}
										</div>
									</div>
								{/each}
							</div>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	</section>
</main>
