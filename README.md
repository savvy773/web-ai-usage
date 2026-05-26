<div align="center">
  <br />
  <img src="docs/ai_dash.png" alt="AI Usage Dashboard" width="860" style="border-radius:12px" />
  <br /><br />

  <h1>AI Usage Dashboard</h1>
  <p><strong>Monitor Claude, Codex, and Gemini CLI usage in one local dashboard.</strong></p>

  <p>
    <a href="https://savvy773.github.io/ai_usage/"><img src="https://img.shields.io/badge/Landing_Page-4B5563?style=flat-square&logo=vercel&logoColor=white" alt="Landing Page" /></a>
    &nbsp;
    <a href="https://github.com/savvy773/ai_usage/releases/tag/v1.0.0"><img src="https://img.shields.io/github/v/release/savvy773/ai_usage?style=flat-square&color=7c6aff&label=release" alt="Release" /></a>
    &nbsp;
    <img src="https://img.shields.io/badge/SvelteKit-2-FF3E00?style=flat-square&logo=svelte&logoColor=white" />
    &nbsp;
    <img src="https://img.shields.io/badge/TypeScript-6-3178C6?style=flat-square&logo=typescript&logoColor=white" />
    &nbsp;
    <img src="https://img.shields.io/badge/Tailwind_CSS-v4-38BDF8?style=flat-square&logo=tailwindcss&logoColor=white" />
    &nbsp;
    <img src="https://img.shields.io/badge/license-MIT-a855f7?style=flat-square" />
  </p>

  <p>
    <a href="#-quick-start">Quick Start</a> ·
    <a href="docs/architecture.md">Architecture</a> ·
    <a href="docs/fix_check.md">Fix Checklist</a> ·
    <a href="https://savvy773.github.io/ai_usage/">Landing Page</a>
  </p>
  <br />
</div>

---

The browser never executes CLIs directly. A **SvelteKit server API** runs each CLI in a virtual terminal via **node-pty**, collects usage data, and writes results to `data/usage-history.json`. The UI renders from cached JSON first, then refreshes in the background.

<br />

## ✨ Features

| | Feature | Description |
|:---:|---|---|
| ⚡ | **Multi-provider** | Claude `/usage` · Codex `/status` · Gemini CLI `/model` via virtual terminals |
| ↻ | **Smart retry** | Up to 5 attempts per provider with phase diagnostics and slash-command recovery |
| 📊 | **Weekly Pace card** | Actual usage bar vs. 20% minimum threshold marker |
| ⏱ | **Reset countdown** | Live per-provider countdown to next usage reset |
| 📡 | **Live server logs** | SSE-based real-time panel — streams directly to the browser |
| 💾 | **Dual cache** | Server-side JSON history (10-min buckets) + browser `localStorage` fallback |

<br />

## 🚀 Quick Start

**One-liner (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/savvy773/ai_usage/main/scripts/install.ps1 | iex
```

**Manual:**

```powershell
git clone https://github.com/savvy773/ai_usage.git
cd ai_usage
pnpm install
.\scripts\start-server.ps1 -Open   # opens http://127.0.0.1:5173
```

<details>
<summary>All <code>start-server.ps1</code> options</summary>

```powershell
.\scripts\start-server.ps1 -Open          # open browser automatically
.\scripts\start-server.ps1 -Port 5173     # custom port (default: 5173)
.\scripts\start-server.ps1 -Mode preview  # production preview build
.\scripts\start-server.ps1 -NoRestart     # skip server restart
.\scripts\start-server.ps1 -Status        # show server status
.\scripts\start-server.ps1 -Help          # show all options
```

> Uses `--strictPort`. Only restarts a server it previously started — won't kill unrelated processes on the same port.

</details>

<br />

## 🖥 CLI Targets

Working directory: `D:\Code\_temp`

| Provider | Command | Slash | Display |
|:---|:---|:---|:---|
| Claude | `claude` | `/usage` | current & weekly usage |
| Codex | `codex` | `/status` | current & weekly usage |
| Gemini CLI | `gemini --skip-trust` | `/model` | per-model usage rates |

> Gemini uses `--skip-trust` to bypass workspace prompts. Claude/Codex omit similar flags — they affect auth policy and can cause collection failures.

<br />

## 🔧 Development

```powershell
pnpm install
pnpm dev        # dev server
pnpm check      # type check
pnpm build      # production build
```

Enable verbose collector output:

```powershell
$env:AI_USAGE_DEBUG_LOGS=1; .\scripts\start-server.ps1
```

<br />

## 📂 Data Files

| Path | Description |
|:---|:---|
| `data/usage-history.json` | Full history — 10-min buckets, last 12 kept |
| `data/usage-latest.json` | Latest payload + last 6 buckets |
| `data/raw/{provider}-latest.txt` | Raw CLI output tail |
| `data/raw/{provider}-last-failure.txt` | Last failed attempt raw |
| `.server/ai-usage-dashboard.json` | Server state |
| `data/logs/server.log` | Server log |
| `data/logs/collector.log` | Collector log |

`data/` and `.server/` are git-ignored.

<br />

## 🛠 Tech Stack

<table>
<tr>
  <td><a href="https://kit.svelte.dev/"><img src="https://img.shields.io/badge/SvelteKit_2-FF3E00?style=flat-square&logo=svelte&logoColor=white" /></a></td>
  <td>Full-stack framework</td>
</tr>
<tr>
  <td><a href="https://tailwindcss.com/"><img src="https://img.shields.io/badge/Tailwind_v4-38BDF8?style=flat-square&logo=tailwindcss&logoColor=white" /></a></td>
  <td>Styling</td>
</tr>
<tr>
  <td><a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" /></a></td>
  <td>Type safety</td>
</tr>
<tr>
  <td><a href="https://www.shadcn-svelte.com/"><img src="https://img.shields.io/badge/shadcn--svelte-18181B?style=flat-square" /></a></td>
  <td>UI components</td>
</tr>
<tr>
  <td><a href="https://github.com/microsoft/node-pty"><img src="https://img.shields.io/badge/node--pty-22D3EE?style=flat-square" /></a></td>
  <td>Virtual terminal for CLI execution</td>
</tr>
<tr>
  <td><a href="https://vitejs.dev/"><img src="https://img.shields.io/badge/Vite_8-646CFF?style=flat-square&logo=vite&logoColor=white" /></a></td>
  <td>Build tool</td>
</tr>
</table>

<br />

## 📖 Docs

- **[Architecture](docs/architecture.md)** — implementation structure, API contract, refresh/cache flow
- **[Fix Checklist](docs/fix_check.md)** — step-by-step diagnostics for collection errors
- **[Landing Page](https://savvy773.github.io/ai_usage/)** — project overview

<br />

---

<div align="center">
  <sub>MIT License · Local. Private. Yours.</sub>
</div>
