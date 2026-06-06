# AI Usage Dashboard Architecture

Project root: `D:\Code\_toolkit\aI_usage`
Local URL: `http://127.0.0.1:5173/`
Server script: `scripts\start-server.ps1`

This document is the short implementation reference. Use `fix_check.md` when a refresh or parser issue needs step-by-step diagnosis.

## What It Does

AI Usage Dashboard is a local SvelteKit app that reads usage from three CLI tools:

| Provider        | Command                              | Usage command | Dashboard view           |
| --------------- | ------------------------------------ | ------------- | ------------------------ |
| Claude          | `claude`                             | `/usage`      | current session and week |
| Codex           | `codex`                              | `/status`     | 5h and weekly limits     |
| Antigravity CLI | `agy --dangerously-skip-permissions` | `/usage`      | per-model usage          |

The browser never runs CLIs. It reads JSON from the SvelteKit server. The server owns CLI execution, parsing, retries, history, and debug files.

## Runtime Flow

```text
browser
  -> GET /api/usage
  -> render cached JSON
  -> POST /api/usage/refresh when refresh is needed
  -> poll GET /api/usage while refreshState.refreshing is true

server refresh
  -> run provider CLI in node-pty
  -> send slash command after CLI readiness
  -> capture raw terminal output
  -> normalize ANSI/control/redraw text
  -> parse provider usage
  -> write data/usage-history.json and data/usage-latest.json
```

If a refresh takes longer than the short wait window, the API returns the last usable payload first and keeps collection running in the background.

## Main Files

| Path                                      | Role                                              |
| ----------------------------------------- | ------------------------------------------------- |
| `src/routes/+page.svelte`                 | Dashboard UI, refresh controls, logs, stop button |
| `src/routes/+page.server.ts`              | SSR preload for first paint                       |
| `src/routes/api/usage/+server.ts`         | Reads stored usage payload                        |
| `src/routes/api/usage/refresh/+server.ts` | Starts or joins a refresh                         |
| `src/routes/api/server/logs/+server.ts`   | Streams server logs over SSE                      |
| `src/routes/api/server/stop/+server.ts`   | Stops the current server process                  |
| `src/lib/server/usage/refresh-manager.ts` | Refresh locking, cached response, history write   |
| `src/lib/server/usage/collector.ts`       | CLI startup, readiness, retries, raw capture      |
| `src/lib/server/usage/parser.ts`          | Provider-specific parsing                         |
| `src/lib/server/usage/storage.ts`         | JSON history persistence                          |
| `src/lib/usage.ts`                        | Shared provider config and payload types          |
| `src/hooks.server.ts`                     | Console log mirroring                             |
| `scripts/start-server.ps1`                | Fixed-address dev/preview launcher                |

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

## Refresh Rules

Provider collection is sequential. Each provider can retry up to 5 times. A failed provider does not stop the next provider.

Key timings:

| Setting                 | Value                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------- |
| CLI working directories | shared env, workspace `..\..\_temp`, `%TEMP%`, `%TMP%`, optional provider-specific env |
| shell                   | `pwsh.exe -NoLogo -NoProfile -NoExit`                                                  |
| retry delays            | `1.5s`, `5s`, `5s`, `10s`                                                              |
| history bucket          | `10 minutes`                                                                           |
| quick refresh wait      | about `2s`                                                                             |
| manual refresh cooldown | `10s`                                                                                  |
| frontend polling        | until refresh finishes or polling attempts expire                                      |

Collector readiness matters more than speed. The collector should wait for the shell prompt, then the provider prompt, then send the slash command. When `.env` sets `AI_USAGE_CWD` or `AI_USAGE_CWD_CANDIDATES`, those shared candidates are used directly, up to three paths total. If both are unset, defaults come from the workspace-level `_temp` directory when installed under `_toolkit\aI_usage`, then OS temp variables. Relative `.env` paths are resolved from the dashboard project root, and `%TEMP%`, `%TMP%`, `$env:TEMP`, and `$env:TMP` are expanded at runtime for multi-PC setups. The working directory should stay outside the dashboard Git repo to avoid repo-root trust prompts. The collector creates a missing working directory before launching a CLI, but does not create persistent files inside it. Codex may show a ready prompt while MCP startup is still redrawing, so `/status` confirmation is repeated while the slash command remains in the input buffer. If Codex says `Limits: refresh requested`, the collector clears any stale prompt text before resending `/status`, and only the latest Codex status signal decides whether the capture is still pending. If Codex still returns `codex-loading` with no usage markers, the attempt is treated as a startup miss instead of a reportable recovery. Claude can take longer to fill the `/usage` panel; incomplete usage output retries in the same working directory, while trust prompts are detected quickly and move to the next candidate. If a provider is blocked by trust/auth/update/startup state in one directory, the next retry can move to the next working-directory candidate. When a provider returns `partial` but previous usable data exists, storage keeps the previous values as the served JSON and records the latest partial in the message and raw snapshots.

Provider-specific variables (`AI_USAGE_CWD_CLAUDE`, `AI_USAGE_CWD_CODEX`, `AI_USAGE_CWD_GEMINI` for Antigravity, plus matching `AI_USAGE_CWD_CANDIDATES_*`) are only needed for unusual setups and are merged before shared candidates. Each provider uses at most three working-directory candidates per refresh.

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

- Starts collection or joins the active collection.
- Send JSON `{}` with same-origin headers during manual testing:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri 'http://127.0.0.1:5173/api/usage/refresh' `
  -ContentType 'application/json' `
  -Headers @{ Origin = 'http://127.0.0.1:5173' } `
  -Body '{}'
```

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
