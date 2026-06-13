# AI Usage Dashboard Fix Checklist

Use this checklist when refresh output looks wrong. Start from runtime state and raw evidence before changing regex or UI code.

## Fast Health Check

```powershell
cd D:\Code\_toolkit\aI_usage
pnpm check
.\scripts\start-server.ps1 -Status
```

Then verify a live refresh:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri 'http://127.0.0.1:5173/api/usage/refresh' `
  -ContentType 'application/json' `
  -Headers @{ Origin = 'http://127.0.0.1:5173' } `
  -Body '{}'

Invoke-RestMethod 'http://127.0.0.1:5173/api/usage'
```

Expected result:

- Server is running on `127.0.0.1:5173`.
- Refresh starts without CSRF errors.
- `refreshState.refreshing` eventually becomes `false`.
- Claude, Codex, and Antigravity are `ok` unless the CLI itself is unavailable.

## Debug Order

Check in this order:

1. `data\raw\{provider}-latest.parsed.json`
2. `data\raw\{provider}-latest.txt`
3. `data\raw\{provider}-last-failure.parsed.json`
4. `data\raw\{provider}-last-failure.txt`
5. `data\usage-latest.json`
6. `data\usage-history.json`
7. `data\logs\collector.log`
8. `data\logs\server-error.log`

Inside parsed snapshots, read:

- `phase`
- `workingDirectory`
- `workingDirectoryCandidates`
- `markers`
- `parseDiagnostics`
- `status`
- `message`
- `windows` or `modelUsages`

If raw output does not contain usage rows, the issue is collector timing/readiness. If raw output contains usage rows but parsed JSON misses them, the issue is parser normalization or provider parsing.

## Follow-up Log Review

After a successful live refresh, do not treat older `partial` lines as current failures by themselves. First compare the log timestamp with `data\usage-latest.json`:

- `collector.log` timestamps are UTC.
- The local dashboard clock is usually KST.
- A later `usage-output-complete` snapshot supersedes an older `partial` attempt for the same provider.
- During refresh, providers are collected independently and each completed provider snapshot is recorded before the slowest provider finishes.
- If served JSON says `Previous data kept`, inspect the raw snapshot for the latest failure, but the browser should still show the previous usable values.
- On a cold PC boot, the browser may open before the preview server and CLIs are fully warm. The page should keep the cached/previous usable values and show `Cached` instead of `Unavailable`.
- Auto-refresh defaults to 3 minutes and can be set to 1, 3, 5, or 10 minutes. The server scheduler continues collection while the dashboard is hidden.
- At `00s`, Auto must show collection in progress. `nextRunAt` stays empty during collection and is set to a new full interval only after `refreshState.refreshing` becomes `false` and provider `collectedAt` advances.
- A visible dashboard must recheck cached usage and scheduler state every 10 seconds regardless of browser focus. Minimizing or switching tabs pauses only browser display polling; returning to the page loads the newest stored result.
- `POST /api/usage/auto-refresh` must return `enabled: true`, the selected interval, and a future `nextRunAt` while Auto is on.
- Manual and visible-page completion polling allows up to 6 minutes so Claude's 50-second request spacing and a retry cannot leave the page on the previous payload after server collection finishes.
- If the latest `data\usage-latest.json` has all providers `ok`, watch the next scheduled refresh before changing code.

For follow-up monitoring, check only lines after the latest successful `generatedAt` time unless the user is asking about an older incident.

Escalate to collector/runtime investigation when new lines repeat:

- `node-pty path failed; trying pipe fallback`
- a Microsoft Visual C++ Runtime assertion dialog mentioning `node-pty` or `conpty.node`
- repeated `markers=none` entries after the final attempt
- `claude-trust-prompt` or `codex-update-prompt`
- startup/redraw phases such as `claude-startup-or-redraw`, `codex-startup-or-redraw`, or `gemini-startup-or-redraw` (for Antigravity)
- final-attempt `partial` warnings for all providers in the same refresh bucket

Escalate to parser investigation only when the raw or latest parsed snapshot clearly contains usage rows but the parsed provider result is still `partial`.

`DEP0205` / `module.register()` warnings are non-blocking Vite/SvelteKit/Node deprecation warnings unless they are paired with request failures or server startup errors. They are filtered from the dashboard log; track them as dependency maintenance, not as usage parsing failures.

Windows `node-pty` assertion dialogs are native process failures, so the browser cannot catch the dialog after it is created. Foreground auto and manual refresh drive persistent winpty sessions without per-refresh spawning. Only set `AI_USAGE_USE_PIPE=1`, `AI_USAGE_USE_CONPTY=1`, or `AI_USAGE_USE_CONPTY_DLL=1` temporarily when investigating collection behavior.

## Persistent CLI Sessions

Manual and scheduled PTY collection reuse one hidden background terminal per provider instead of spawning a new one on every refresh. The first refresh after a server start spawns the terminals once; later refreshes type the slash command into the existing session, so no new `winpty-agent`/`conhost` should appear and refreshes complete in a few seconds per provider.

- Sessions are parked at the CLI main prompt between refreshes. Claude must not be left on the `/usage` panel: an idle open panel makes the CLI stop reading input entirely (captured as 0 bytes for the whole timeout), which is why each capture ends with Esc.
- Claude can first render cached percentages, show `Refreshing...`, and later repaint only the changed cells. The collector must wait for output to become quiet and force a final full repaint before accepting the parsed session/week values.
- Claude `/usage` writes must remain at least 50 seconds apart across retries and adjacent refreshes. Claude must not use the generic 5-second lost-slash reissue path.
- The 50-second wait is silent by default; its informational countdown is logged only with `AI_USAGE_DEBUG_LOGS=1`.
- A reused session that stays completely silent fails fast after 10s and is respawned on the next attempt at the requested working directory.
- Set `AI_USAGE_DISABLE_PERSISTENT_SESSION=1` to fall back to per-refresh PTY spawning when investigating session-related problems.
- Restarting the server (`scripts\start-server.ps1`) disposes and recreates the sessions.

## Flicker Narrowing

Use this when the screen briefly flashes or focus is stolen only while the dashboard server is running.

First record the exact local time of the flicker, then compare it with the latest dashboard refresh:

```powershell
Get-Content .\data\usage-latest.json -Raw |
  ConvertFrom-Json |
  Select-Object generatedAt,nextRefreshAt,
    @{Name='providers';Expression={$_.providers | ForEach-Object { "$($_.provider):$($_.status):$($_.collectedAt)" }}}
```

If `generatedAt` or provider `collectedAt` matches the flicker time, inspect the process shape around the incident:

```powershell
Get-Process OpenConsole,winpty-agent,conhost,pwsh,powershell,cmd,node -ErrorAction SilentlyContinue |
  Select-Object Id,ProcessName,StartTime,MainWindowTitle |
  Sort-Object StartTime -Descending |
  Select-Object -First 25 |
  Format-Table -AutoSize
```

Then resolve the parent process for any new `OpenConsole`, `conhost`, `pwsh`, or `cmd` entries:

```powershell
$ids = @(1234,5678) # replace with the new process IDs
$parents = Get-CimInstance Win32_Process |
  Where-Object { $ids -contains $_.ProcessId } |
  Select-Object -ExpandProperty ParentProcessId
Get-CimInstance Win32_Process |
  Where-Object { ($ids + $parents) -contains $_.ProcessId } |
  Select-Object ProcessId,ParentProcessId,Name,CreationDate,CommandLine |
  Sort-Object CreationDate |
  Format-List
```

Interpretation:

- Dashboard-linked collection usually has `node.exe ... vite ... --port 5173` as the server process and provider CLI children close to the refresh time.
- `OpenConsole.exe` near the refresh time is a likely foreground-flash suspect.
- Three long-lived `winpty-agent.exe` processes (one per provider session) are the expected steady state while the server runs; they are hidden and not a flicker source by themselves.
- A `winpty-agent.exe` with a `StartTime` near a refresh (other than the first refresh after server start) means a persistent session was respawned — check `collector.log` for the failed attempt that caused it.
- `conhost.exe` can exist for hidden console hosts; check its parent before assuming it is user-visible.
- A command line such as `D:\Code\_scripts\clean-user.ps1`, VS Code PowerShell services, or manually opened `claude` / `codex` / `agy` terminals points outside the dashboard collector.
- Scheduled auto refresh must come from the server timer. The browser only configures `/api/usage/auto-refresh` and reads cached `/api/usage` data.

## Phase Meanings

| Phase                                | Meaning                                                          | Next check                                                                               |
| ------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `usage-output-complete`              | Parser found enough usage data                                   | Check `usage-latest.json` and UI rendering                                               |
| `claude-ready-without-usage-output`  | Claude opened, but `/usage` has not produced complete rows yet   | Retry same working directory; do not switch unless a trust prompt appears                |
| `claude-trust-prompt`                | Claude is blocked by workspace trust                             | Next retry should move to another trusted candidate quickly                              |
| `codex-update-prompt`                | Codex's interactive update prompt is currently active            | The collector skips it with option `2`; if the phase persists, diff the raw prompt shape |
| `codex-loading`                      | Codex is still starting, or `/status` is buffered during startup | The collector retries confirmation; inspect only if the final attempt stays partial      |
| `codex-status-refresh-pending`       | Codex asked to rerun `/status` shortly                           | Same-session `/status` retry should clear the prompt, wait briefly, and resend `/status` |
| `codex-status-output-without-limits` | Codex answered, but limit rows are missing                       | Inspect raw text for changed output shape                                                |
| `gemini-auth-wait`                   | Antigravity is waiting for auth/trust flow                       | Do not spend `/usage` fallback during auth wait                                          |
| `gemini-slash-buffer-waiting`        | `/usage` is still in the input buffer                            | Check confirmation Enter and settle timing                                               |
| `gemini-ready-without-model-screen`  | Antigravity prompt returned, but no model panel opened           | Check slash reissue guard                                                                |
| `gemini-model-screen-incomplete`     | Antigravity model panel opened, but rows/resets are incomplete   | Check `\r` handling and panel boundary parsing                                           |
| startup/redraw with `markers=none`   | Raw has boot/progress output only                                | Treat as collector readiness/timing first                                                |

## Provider Checks

Claude:

- Raw should include `Current session` and `Current week`.
- Parsed output should include current/week percent and reset text.
- If the raw tail contains newer standalone `% used` cell updates after an older complete screen, the parsed snapshot must match the final forced full repaint, not the first cached percentages.
- Consecutive `/usage` writes must be at least 50 seconds apart; a shorter interval is a collector regression.
- If reset is `Unknown`, the collector may have captured percent before reset text settled.

Codex:

- Raw should include `5h limit` and `Weekly limit`.
- `left` values must be converted to used percent.
- `100% context left` is not a usage row.
- `Limits: refresh requested; run /status again shortly.` should trigger same-session `/status` retries.
- After the update prompt is skipped with option `2`, a static `Update available!` banner stays in the captured scrollback. It is informational; only an interactive option list (`Update now`, `Skip until next version`, `Press enter to continue`) newer than the latest ready footer counts as an active prompt.
- If raw output shows `u/status`, or repeated `/status` prompt text without `5h limit` / `Weekly limit` rows, the retry was appended to stale input instead of being submitted cleanly. Codex can render `›/statusgpt-...` without a newline; the collector should still treat that as a visible slash buffer. `/statusline` completion text is harmless when the phase is `usage-output-complete`.

Antigravity:

- Raw should include `Models & Quota`, `Model Quota`, or `Model usage`.
- The current grouped screen should parse 4 quota rows: `Gemini · 5h`, `Gemini · Week`, `Claude/GPT · 5h`, and `Claude/GPT · Week`.
- Long reset countdowns should be normalized to days, hours, and minutes, for example `136h 30m` -> `5d 16h 30m`.
- Older per-model screens should still show at least 1 whitelisted model row.
- `quota-percent` without `model-screen` usually means `/usage` did not open the panel yet.
- A grouped screen with fewer than `parsed-models=4/4` points to redraw or panel-boundary parsing.

## Common Symptoms

| Symptom                                             | Likely cause                                              | Fix direction                                                        |
| --------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------- |
| `Cross-site POST form submissions are forbidden`    | Missing JSON body or Origin header                        | Send `{}` with `Origin: http://127.0.0.1:5173`                       |
| Source changes seem ignored                         | Preview server was not restarted                          | Run `.\scripts\start-server.ps1` again                               |
| All providers become partial in one bucket          | CLI startup/auth timing or `node-pty` path issue          | Inspect latest and last-failure raw snapshots                        |
| Latest UI still shows usable values after partial   | Storage carried forward previous usable snapshot          | Check provider status/message for latest failure                     |
| UI stays one refresh behind current CLI usage       | Foreground refresh stopped polling before completion      | Keep polling until `refreshState` settles and `collectedAt` advances |
| Claude raw tail has newer percentages than JSON     | Initial cached `/usage` screen completed too early        | Wait for quiet output, force a full repaint, then parse final rows   |
| Cold boot shows Claude `Unavailable` / `Unknown`    | Startup refresh ran before Claude accepted `/usage`       | Keep previous usable history and delay startup auto-refresh          |
| Hidden page keeps rewriting its local display cache | Browser visibility guard failed                           | Stop browser polling while hidden; keep the server scheduler enabled |
| Antigravity shows only `GPT-OSS 120B 0%`            | Parser read the old per-model shape from a grouped screen | Parse `Models & Quota` as four group/window rows                     |
| Antigravity has status rows but no models           | `/usage` panel was not opened or not settled              | Check slash buffer, auth wait, and reissue guard                     |
| Codex shows `Unknown` or `100%`                     | Parser read a status line instead of limit rows           | Narrow Codex parser to limit rows                                    |
| Visual C++ assertion dialog mentions `conpty.node`  | Bundled ConPTY DLL or PTY cleanup path crashed            | Keep `AI_USAGE_USE_CONPTY_DLL` unset; restart server                 |
| `collector.log` looks quiet during success          | Successful raw snapshots are the stronger evidence        | Check `data\raw\*-latest.parsed.json`                                |
| Tracked process shows `Recognized: False`           | Date format mismatch during JSON serialization            | Fixed by comparing process creation dates with 2s margin             |
| `AttachConsole failed` in startup log               | node-pty / Windows console API compatibility issue        | Non-blocking warning unless Vite server fails to start               |
| `Cannot find name 'ModelUsage'` on build            | Missing export/import of ModelUsage type in UI            | Fixed by importing ModelUsage from `$lib/usage`                      |

## When To Change Code

Change collector timing/readiness when:

- raw output lacks usage rows;
- raw shows `/usage` at a PowerShell prompt before the Claude command is ready;
- `phase` shows auth wait, loading, slash buffer, refresh pending, or ready-without-screen;
- retries expire before the provider reaches the usage screen.

Change parser logic when:

- raw output clearly contains usage rows;
- `markers` or `parseDiagnostics` show missing labels/percent/resets;
- normalized text splits one visible row into multiple fragments.

Change UI code when:

- `data\usage-latest.json` is correct;
- `/api/usage` is correct;
- only the browser display is stale, unknown, or visually wrong.

## Validation After Fixes

Run:

```powershell
pnpm check
pnpm lint
.\scripts\start-server.ps1
```

Then confirm:

- `POST /api/usage/refresh` succeeds.
- `GET /api/usage` returns current provider statuses.
- Latest parsed snapshots match the displayed values.
- `data\usage-history.json` has a new bucket or updated latest bucket.
- Browser first paint includes server-rendered provider data.
