# Architecture

## Overview

AI Usage Dashboard is a SvelteKit app that collects Claude, Codex, and Gemini CLI usage locally and displays it in a browser dashboard.

The browser never executes CLIs directly. A **SvelteKit server API** runs each CLI in a virtual terminal via **node-pty**, parses the output, and writes results to `data/usage-history.json`. The UI reads from that file — fast reads, slow collection stay separate.

## Module Map

| File | Role |
|---|---|
| `src/routes/+page.svelte` | Dashboard UI |
| `src/routes/api/usage/+server.ts` | Return stored usage payload |
| `src/routes/api/usage/refresh/+server.ts` | Trigger new CLI collection |
| `src/routes/api/server/logs/+server.ts` | Stream server logs via SSE |
| `src/routes/api/server/stop/+server.ts` | Stop the server |
| `src/lib/server/usage/refresh-manager.ts` | Deduplicate refreshes, quick response |
| `src/lib/server/usage/collector.ts` | Run CLIs in virtual terminal |
| `src/lib/server/usage/parser.ts` | Parse CLI output text |
| `src/lib/server/usage/storage.ts` | Read/write JSON history |
| `src/lib/usage.ts` | Provider config and shared types |
| `src/hooks.server.ts` | Capture console logs to in-memory buffer |
| `scripts/start-server.ps1` | Start dev/preview server |

## Data Flow

```
Browser → GET /api/usage → reads data/usage-history.json → renders UI
Browser → POST /api/usage/refresh → collector runs CLIs → parser → storage → updated JSON
```

- If collection finishes quickly → `200` with fresh data
- If collection takes too long → `202` with cached data, browser polls until done
- UI also caches to `localStorage` as fallback

## CLI Targets

Working directory: `D:\Code\_temp`

| Provider | Command | Slash | Output |
|---|---|---|---|
| Claude | `claude` | `/usage` | Current & weekly usage |
| Codex | `codex` | `/status` | Current & weekly usage |
| Gemini CLI | `gemini --skip-trust` | `/model` | Per-model usage rates |

## Key Settings

| Setting | Value |
|---|---|
| Shell | `pwsh.exe` |
| Capture timeout | 45–135s depending on provider and attempt |
| Max retries per provider | 5 |
| History bucket interval | 10 minutes |
| History retention | Last 12 buckets |
| Manual refresh cooldown | 10 seconds |
| Quick refresh wait | 2 seconds |

## API

| Endpoint | Method | Description |
|---|---|---|
| `/api/usage` | GET | Return stored usage payload |
| `/api/usage/refresh` | POST | Trigger new collection (`200` done / `202` in-progress) |
| `/api/server/logs` | GET | SSE stream of server logs |
| `/api/server/stop` | POST | Stop the server |

## Data Files

| Path | Description |
|---|---|
| `data/usage-history.json` | Full history — source of truth |
| `data/usage-latest.json` | Latest payload + last 6 buckets |
| `data/raw/{provider}-latest.txt` | Last raw CLI output |
| `data/raw/{provider}-last-failure.txt` | Last failed attempt raw |
| `data/logs/server.log` | Server log |
| `data/logs/collector.log` | Collection diagnostics |
| `.server/ai-usage-dashboard.json` | Server state (port, PID, mode) |

`data/` and `.server/` are git-ignored.

## UI

- **Claude / Codex** — current and weekly usage bars with reset countdown
- **Gemini** — Flash, Flash Lite, Pro model usage rates
- **Pace card** — weekly usage bar vs. target threshold marker
- **Server log panel** — live SSE log stream
- **Controls** — Auto refresh toggle · Manual refresh · Stop server
