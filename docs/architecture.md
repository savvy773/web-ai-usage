# AI Usage Dashboard Architecture

Project root: `D:\Code\_toolkit\aI_usage`
Local URL: `http://127.0.0.1:5173/`
Server script: `scripts\start-server.ps1`

This document is the short implementation reference. Use `fix_check.md` when a refresh or parser issue needs step-by-step diagnosis.

## What It Does

AI Usage Dashboard is a local SvelteKit app that reads usage from three CLI tools:

| Provider    | Command  | Usage command | Dashboard view           |
| ----------- | -------- | ------------- | ------------------------ |
| Claude      | `claude` | `/usage`      | current session and week |
| Codex       | `codex`  | `/status`     | 5h and weekly limits     |
| Antigravity | `agy`    | `/usage`      | per-model usage          |

The browser never runs CLIs. It reads JSON from the SvelteKit server. The server owns CLI execution, parsing, retries, history, and debug files.

## Runtime Flow

```text
browser
  -> GET /api/usage
  -> render cached JSON
  -> configure the server auto-refresh interval
  -> poll cached JSON and scheduler state every 10 seconds while the page is visible
  -> stop display polling while hidden or minimized; browser focus is irrelevant

server auto scheduler or manual refresh
  -> type the slash command into one persistent hidden node-pty session per provider
  -> (first refresh after server start spawns the sessions once; later refreshes reuse them)
  -> capture raw terminal output
  -> normalize ANSI/control/redraw text
  -> parse provider usage
  -> write data/usage-history.json and data/usage-latest.json
```

If a refresh takes longer than the short wait window, the API returns the last usable payload first and keeps collection running in the background.

## Main Files

| Path                                           | Role                                              |
| ---------------------------------------------- | ------------------------------------------------- |
| `src/routes/+page.svelte`                      | Dashboard UI, refresh controls, logs, stop button |
| `src/routes/+page.server.ts`                   | SSR preload for first paint                       |
| `src/routes/api/usage/+server.ts`              | Reads stored usage payload                        |
| `src/routes/api/usage/auto-refresh/+server.ts` | Configures and reports the server scheduler       |
| `src/routes/api/usage/refresh/+server.ts`      | Starts or joins manual collection                 |
| `src/routes/api/server/logs/+server.ts`        | Streams server logs over SSE                      |
| `src/routes/api/server/stop/+server.ts`        | Stops the current server process                  |
| `src/lib/server/usage/refresh-manager.ts`      | Refresh locking, cached response, history write   |
| `src/lib/server/usage/auto-refresh.ts`         | Server-side scheduled collection                  |
| `src/lib/server/usage/collector.ts`            | CLI startup, readiness, retries, raw capture      |
| `src/lib/server/usage/parser.ts`               | Provider-specific parsing                         |
| `src/lib/server/usage/storage.ts`              | JSON history persistence                          |
| `src/lib/usage.ts`                             | Shared provider config and payload types          |
| `src/hooks.server.ts`                          | Console log mirroring                             |
| `scripts/start-server.ps1`                     | Fixed-address dev/preview launcher                |

## Server Launcher

`scripts\start-server.ps1` is the supported launcher.

```powershell
.\scripts\start-server.ps1
.\scripts\start-server.ps1 -Open
.\scripts\start-server.ps1 -Status
```

Default behavior:

- Starts preview mode on `http://127.0.0.1:5173/`.
- Loads `.env` before build/preview startup.
- Uses `--strictPort`.
- Writes process state to `.server\ai-usage-dashboard.json`.
- Restarts only a tracked dashboard process from this project.
- Refuses to stop an unrelated process on the same port.

Preview mode does not hot-reload server code reliably. Restart with the script before judging parser, collector, or API behavior.

## Persistent CLI Sessions

The collector keeps one hidden terminal per provider alive for the lifetime of the server instead of spawning a new terminal on every refresh. This removes the per-refresh console flash and cuts collection time from 10-20s to a few seconds per provider.

- The first refresh after a server start spawns three hidden `cmd.exe` sessions (one per provider) and launches each CLI once. Later refreshes clear the input and type the slash command into the existing session.
- Sessions are parked at the CLI main prompt between refreshes. Each capture ends with Esc to close the usage panel — Claude stops reading input entirely if its `/usage` panel idles open.
- Claude may initially paint cached percentages and then update only individual terminal cells while `Refreshing...` is visible. After the output becomes quiet, the collector forces one full repaint so the parser receives complete rows with the final percentages.
- On reuse, a TUI may repaint only changed cells, so a resize jiggle forces a full redraw when usage rows have not appeared yet.
- A reused session that stays completely silent fails fast after 10s and is respawned on the next retry at the requested working directory.
- Three long-lived `winpty-agent.exe` processes are the expected steady state while the server runs. Server restart disposes and recreates them.
- `AI_USAGE_DISABLE_PERSISTENT_SESSION=1` falls back to per-refresh PTY spawning for debugging.

## Refresh Rules

Provider collection runs in parallel. Each provider can retry up to 5 times. A failed provider does not stop the other providers, and each completed provider snapshot is recorded before the slowest provider finishes. A Claude snapshot is not finalized from the first complete-looking screen when the TUI is still asynchronously refreshing.

Auto-refresh is owned by the server scheduler. The dashboard defaults to a 3-minute interval and supports 1, 3, 5, and 10 minutes from the top control. Scheduled collection continues while the page is hidden or minimized. The browser polls cached JSON and scheduler state every 10 seconds only while `document.visibilityState` is `visible`; keyboard focus is not required. A hidden page displays `Hidden` and immediately loads the newest stored result when it becomes visible again.

Key timings:

| Setting                  | Value                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------- |
| CLI working directories  | shared env, workspace `..\..\_temp`, `%TEMP%`, `%TMP%`, optional provider-specific env |
| shell                    | `cmd.exe /q /k echo off` inside a hidden node-pty (winpty) session                     |
| collector backend        | persistent node-pty sessions for auto and manual; pipe only as fallback or via env     |
| auto interval            | `1m`, `3m` default, `5m`, or `10m`; stored in browser localStorage                     |
| retry delays             | `1.5s`, `5s`, `5s`, `10s`                                                              |
| Claude `/usage` interval | at least `50s`, including retries and adjacent manual/automatic refreshes              |
| history bucket           | `10 minutes` for stored history grouping                                               |
| quick refresh wait       | about `2s`                                                                             |
| manual refresh cooldown  | `10s`                                                                                  |
| frontend polling         | up to `6 minutes`, covering Claude's 50s limit and collector retries                   |

Collector readiness matters more than speed. The collector should wait for the shell prompt, then the provider prompt, then send the slash command. When `.env` sets `AI_USAGE_CWD` or `AI_USAGE_CWD_CANDIDATES`, those shared candidates are used directly, up to three paths total. If both are unset, defaults come from the workspace-level `_temp` directory when installed under `_toolkit\aI_usage`, then OS temp variables. Relative `.env` paths are resolved from the dashboard project root, and `%TEMP%`, `%TMP%`, `$env:TEMP`, and `$env:TMP` are expanded at runtime for multi-PC setups. The working directory should stay outside the dashboard Git repo to avoid repo-root trust prompts. The collector creates a missing working directory before launching a CLI, but does not create persistent files inside it. Codex may show a ready prompt while MCP startup is still redrawing, so `/status` confirmation is repeated while the slash command remains in the input buffer. If Codex says `Limits: refresh requested`, the collector clears any stale prompt text before resending `/status`, and only the latest Codex status signal decides whether the capture is still pending. If Codex still returns `codex-loading` with no usage markers, the attempt is treated as a startup miss instead of a reportable recovery. Claude can take longer to fill the `/usage` panel; incomplete usage output retries in the same working directory, while trust prompts are detected quickly and move to the next candidate. Every Claude `/usage` write is separated by at least 50 seconds, and Claude does not use the generic 5-second lost-slash reissue path. If a provider is blocked by trust/auth/update/startup state in one directory, the next retry can move to the next working-directory candidate. When a provider returns `partial` but previous usable data exists, storage keeps the previous values as the served JSON and records the latest partial in the message and raw snapshots.

Provider-specific variables (`AI_USAGE_CWD_CLAUDE`, `AI_USAGE_CWD_CODEX`, `AI_USAGE_CWD_GEMINI` for Antigravity, plus matching `AI_USAGE_CWD_CANDIDATES_*`) are only needed for unusual setups and are merged before shared candidates. Each provider uses at most three working-directory candidates per refresh.

The pipe backend (`runPipeSlashCommand`) only runs when `AI_USAGE_USE_PIPE=1` is set or node-pty itself fails. It cannot drive an interactive TUI, so a CLI that refuses non-TTY collection yields a partial snapshot; storage then keeps the previous usable values.

Codex trust is user-scoped in `%USERPROFILE%\.codex\config.toml`, not project-scoped in this repository.

## Provider Parsing

Claude:

- Reads `Current session` and `Current week`.
- Requires percent and reset text for a complete result.
- Uses `Asia/Seoul` reset text when present.

Codex:

- Reads `5h limit` and `Weekly limit`.
- Converts `left` values into used percent for the dashboard.
- Ignores status lines such as `100% context left`.
- Skips the CLI update prompt with option `2`; the static `Update available!` banner that stays in scrollback afterwards is not treated as an active prompt (only an option list newer than the latest ready footer counts).
- Reissues `/status` in the same session when Codex says refresh was requested, clearing the prompt first so retries do not append to stale input.

Antigravity:

- Reads the latest complete `Model Quota` or `Model usage` panel.
- Accepts whitelisted model rows: `Gemini 3.5 Flash (High)`, `Claude Sonnet 4.6 (Thinking)`, `Claude Opus 4.6 (Thinking)`, and `GPT-OSS 120B (Medium)`.
- Requires at least 1 model row with reset or remaining-time data.
- Treats auth wait, slash-buffer wait, and incomplete model screens as collector timing states before assuming parser failure.

## Normalization

The parser first turns terminal output into stable text:

- Remove ANSI, OSC, cursor, and control sequences.
- Preserve `\r\n` as line breaks.
- Treat standalone `\r` as redraw noise, not a new line.
- Replace box, bar, and bracket drawing characters with spaces.
- Collapse whitespace before provider-specific parsing.

This is why raw files are more reliable than what PowerShell visually renders with `Get-Content`.

## Stored Data

Runtime files are under `data/` and are git-ignored.

| Path                                           | Use                                   |
| ---------------------------------------------- | ------------------------------------- |
| `data\usage-history.json`                      | Durable history, 10-minute buckets    |
| `data\usage-latest.json`                       | Latest API-shaped payload             |
| `data\raw\{provider}-latest.txt`               | Last raw terminal capture             |
| `data\raw\{provider}-latest.parsed.json`       | Last parsed snapshot with diagnostics |
| `data\raw\{provider}-last-failure.txt`         | Last failed or partial raw capture    |
| `data\raw\{provider}-last-failure.parsed.json` | Last failed or partial diagnostics    |
| `data\logs\server.log`                         | Server log                            |
| `data\logs\server-error.log`                   | Warnings and errors                   |
| `data\logs\collector.log`                      | Collector-focused diagnostics         |
| `data\logs\server-process.log`                 | Vite stdout from the launcher         |
| `data\logs\server-startup-error.log`           | Vite stderr from the launcher         |

`usage-history.json` is the source of truth. `usage-latest.json` mirrors the payload shape returned by `/api/usage`.

If a new refresh is weaker than the latest usable history, storage keeps the usable values and records the latest status/message. This prevents one bad refresh from blanking the dashboard.

## API Contract

`GET /api/usage`

- Returns the latest `UsagePayload`.
- Includes `providers`, recent `history`, `generatedAt`, `nextRefreshAt`, and optional `refreshState`.

`POST /api/usage/refresh`

- Starts collection or joins the active collection only for manual refresh.
- Auto-refresh requests are compatibility-only: they configure the server scheduler and return cached data.
- Manual refresh sends `x-ai-usage-refresh-mode: manual`.
- Send JSON `{}` with same-origin headers during manual testing:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri 'http://127.0.0.1:5173/api/usage/refresh' `
  -ContentType 'application/json' `
  -Headers @{
    Origin = 'http://127.0.0.1:5173'
    'x-ai-usage-refresh-mode' = 'manual'
  } `
  -Body '{}'
```

`POST /api/usage/auto-refresh`

- Enables or disables the server-side collection timer.
- Body: `{ "enabled": true, "intervalMs": 180000 }`.
- Accepted intervals: `60000`, `180000`, `300000`, `600000`.
- Returns `{ enabled, intervalMs, nextRunAt }`.

## Validation

Use this sequence after docs, parser, collector, or UI changes:

```powershell
pnpm check
pnpm lint
.\scripts\start-server.ps1
```

Then call:

1. `POST /api/usage/refresh`
2. `GET /api/usage`
3. `data\raw\{provider}-latest.parsed.json`
4. `data\usage-latest.json`

Healthy refresh criteria:

- Server is recognized by `.\scripts\start-server.ps1 -Status`.
- All providers are `ok`, or a provider has a clear partial/unavailable reason.
- Parsed snapshots show `phase=usage-output-complete` for successful providers.
- Antigravity has at least 1 parsed model row.
- SSR HTML contains the initial payload and provider names.
