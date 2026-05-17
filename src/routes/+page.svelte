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

	const REFRESH_MS = 10 * 60 * 1000;
	const WINDOW_ORDER: UsageWindowId[] = ['fiveHour', 'week'];

	let payload = $state<UsagePayload | null>(null);
	let loading = $state(true);
	let refreshing = $state(false);
	let error = $state<string | null>(null);
	let now = $state(new Date());
	let autoRefresh = $state(true);

	const providers = $derived(payload?.providers ?? []);

	onMount(() => {
		void loadUsage();
		const refreshTimer = window.setInterval(() => {
			if (autoRefresh && !refreshing) void refreshUsage();
		}, REFRESH_MS);
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
			if (diff <= 0) return '0d 0h 0m';

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

				<div
					class="flex flex-wrap items-center gap-2 rounded-md border bg-background/70 p-1.5 shadow-sm"
				>
					<div class="px-3 py-1.5 text-sm text-muted-foreground">
						<span class="text-muted-foreground/70">Updated</span>
						<span class="ml-2 text-foreground">{formatDateTime(payload?.generatedAt ?? null)}</span>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={autoRefresh}
						class="inline-flex h-9 items-center gap-2 rounded-md border border-border/70 bg-muted/40 px-3 text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
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
						<span>10m auto</span>
					</button>
					<button
						type="button"
						class="inline-flex h-9 items-center gap-2 rounded-md bg-foreground px-4 text-sm font-semibold text-background shadow-sm transition hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-60"
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
							{#if provider.provider !== 'gemini'}
								{#each WINDOW_ORDER as windowId (windowId)}
									{@const usageWindow = provider.windows[windowId]}
									<div class="rounded-md border bg-background p-4">
										<div class="flex items-center justify-between gap-3">
											<div>
												<div class="text-sm font-medium">{usageWindow.label}</div>
												<div class="mt-1 text-xs text-muted-foreground">
													{usageText(usageWindow)}
												</div>
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
							{/if}

							{#if (provider.modelUsages ?? []).length > 0}
								<div class="rounded-md border bg-background p-4">
									<div class="mb-3 text-sm font-medium">Model usage</div>
									<div class="grid gap-3">
										{#each provider.modelUsages ?? [] as model (model.label)}
											<div>
												<div class="flex items-center justify-between gap-3 text-sm">
													<span class="font-medium">{model.label}</span>
													<span style={`color: ${heatColor(model.percent)}`}>
														{percentLabel(model.percent)}
													</span>
												</div>
												<div class="relative mt-2 h-2 overflow-hidden rounded-full bg-muted">
													<div
														class="absolute top-0 left-[80%] z-10 h-full w-px bg-foreground/70"
													></div>
													<div
														class="h-full rounded-full transition-all"
														style={`width: ${barWidth(model.percent)}; background: linear-gradient(90deg, #06b6d4, ${heatColor(model.percent)});`}
													></div>
												</div>
												<div
													class="mt-1 flex items-center justify-between text-xs text-muted-foreground"
												>
													<span>Reset</span>
													<span>{model.remainingText ?? formatDateTime(model.resetAt)}</span>
												</div>
											</div>
										{/each}
									</div>
								</div>
							{/if}
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
		{/if}
	</section>
</main>
