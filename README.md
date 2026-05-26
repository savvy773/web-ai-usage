<div align="center">

# AI Usage Dashboard

**Monitor Claude, Codex, and Gemini CLI usage in one local dashboard.**

[![SvelteKit](https://img.shields.io/badge/SvelteKit-2-FF3E00?style=flat-square&logo=svelte&logoColor=white)](https://kit.svelte.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-v4-38BDF8?style=flat-square&logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![pnpm](https://img.shields.io/badge/pnpm-required-F69220?style=flat-square&logo=pnpm&logoColor=white)](https://pnpm.io)
[![License](https://img.shields.io/badge/license-MIT-A855F7?style=flat-square)](LICENSE)

[Landing Page](https://savvy773.github.io/ai_usage/) · [Architecture](docs/architecture.md) · [Fix Checklist](docs/fix_check.md)

</div>

---

The browser does not execute CLIs directly. A SvelteKit server API runs each CLI in a virtual terminal via **node-pty**, collects usage data, and persists results to `data/usage-history.json`. The UI renders from cached JSON first, then refreshes in the background.

## Quick Start

**One-liner install (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/savvy773/ai_usage/main/scripts/install.ps1 | iex
```

Clones the repo, installs dependencies, and optionally launches the dashboard.

**Manual:**

```powershell
pnpm install
.\scripts\start-server.ps1 -Open
```

Open in browser → `http://127.0.0.1:5173`

<details>
<summary>All start-server options</summary>

```powershell
.\scripts\start-server.ps1 -Open          # open browser automatically
.\scripts\start-server.ps1 -Port 5173     # specify port (default: 5173)
.\scripts\start-server.ps1 -Mode preview  # production preview build
.\scripts\start-server.ps1 -NoRestart     # skip server restart
.\scripts\start-server.ps1 -Status        # show server status
.\scripts\start-server.ps1 -Help          # show all options
```

`start-server.ps1` uses `--strictPort`. It only restarts a server it previously started and will fail (without killing) if another process owns the port.

</details>

## Features

| | Feature | Description |
|---|---|---|
| ⚡ | Multi-provider collection | Claude `/usage`, Codex `/status`, Gemini CLI `/model` via virtual terminals |
| ↻ | Smart retry | Up to 5 attempts per provider; re-enters slash commands on loss |
| 📊 | Weekly Pace card | Actual usage bar vs. minimum 20% threshold marker |
| ⏱ | Reset countdown | Live countdown to next reset per provider |
| 📡 | Live server logs | SSE-based real-time log panel — no polling |
| 💾 | Dual cache | Server-side JSON history + browser `localStorage` fallback |

## CLI Targets

Working directory: `D:\Code\_temp`

| Provider | Command | Slash | Display |
|---|---|---|---|
| Claude | `claude` | `/usage` | current & weekly usage |
| Codex | `codex` | `/status` | current & weekly usage |
| Gemini CLI | `gemini --skip-trust` | `/model` | per-model usage rates |

> Gemini uses `--skip-trust` to bypass workspace prompts. Claude/Codex omit similar flags as they affect auth policy and can cause collection failures.

## Development

```powershell
pnpm install
pnpm dev       # dev server
pnpm check     # type check
pnpm build     # production build
```

Enable verbose collector output:

```powershell
$env:AI_USAGE_DEBUG_LOGS=1; .\scripts\start-server.ps1
```

## Data Files

| Path | Description |
|---|---|
| `data/usage-history.json` | Full history — 10-min buckets, last 12 kept |
| `data/usage-latest.json` | Latest payload + last 6 buckets |
| `data/raw/{provider}-latest.txt` | Raw CLI tail |
| `data/raw/{provider}-last-failure.txt` | Last failed attempt raw |
| `.server/ai-usage-dashboard.json` | Server state |
| `data/logs/server.log` | Server log |
| `data/logs/collector.log` | Collector log |

`data/` and `.server/` are git-ignored.

## Tech Stack

- **[SvelteKit 2](https://kit.svelte.dev/)** — full-stack framework
- **[Tailwind CSS v4](https://tailwindcss.com/)** — styling
- **[shadcn-svelte](https://shadcn-svelte.com/)** — UI components
- **[node-pty](https://github.com/microsoft/node-pty)** — virtual terminal for CLI execution
- **[Geist](https://vercel.com/font)** — font

## Docs

- **[Architecture](docs/architecture.md)** — implementation structure, API contract, refresh/cache flow
- **[Fix Checklist](docs/fix_check.md)** — step-by-step diagnostics for collection errors
- **[Landing Page](https://savvy773.github.io/ai_usage/)** — project overview
