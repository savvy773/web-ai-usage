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
- On a cold PC boot, the browser may open before the preview server and CLIs are fully warm. The page should keep the cached/previous usable values, show `Cached` instead of `Unavailable`, and delay its startup auto-refresh briefly before trying the CLIs.
- The server should not start scheduled CLI prefetches by itself. Browser auto-refresh and manual refresh both send an explicit refresh-mode header; stale-tab or headerless refresh requests should return cached data without opening provider CLIs.
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

Windows `node-pty` assertion dialogs are native process failures, so the browser cannot catch the dialog after it is created. The collector uses winpty by default to avoid foreground ConPTY/OpenConsole flashes while keeping interactive CLI output reliable. Only set `AI_USAGE_USE_PIPE=1`, `AI_USAGE_USE_CONPTY=1`, or `AI_USAGE_USE_CONPTY_DLL=1` temporarily when investigating collection behavior.

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
- `winpty-agent.exe` without `OpenConsole.exe` is expected for node-pty winpty collection and should not be treated as a visible terminal by itself.
- `conhost.exe` can exist for hidden console hosts; check its parent before assuming it is user-visible.
- A command line such as `D:\Code\_scripts\clean-user.ps1`, VS Code PowerShell services, or manually opened `claude` / `codex` / `agy` terminals points outside the dashboard collector.
- Headerless or stale-tab `POST /api/usage/refresh` should return cached data only. Browser auto-refresh and manual refresh must include `x-ai-usage-refresh-mode`.

## Phase Meanings

| Phase                                | Meaning                                                          | Next check                                                                               |
| ------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `usage-output-complete`              | Parser found enough usage data                                   | Check `usage-latest.json` and UI rendering                                               |
| `claude-ready-without-usage-output`  | Claude opened, but `/usage` has not produced complete rows yet   | Retry same working directory; do not switch unless a trust prompt appears                |
| `claude-trust-prompt`                | Claude is blocked by workspace trust                             | Next retry should move to another trusted candidate quickly                              |
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
- If reset is `Unknown`, the collector may have captured percent before reset text settled.

Codex:

- Raw should include `5h limit` and `Weekly limit`.
- `left` values must be converted to used percent.
- `100% context left` is not a usage row.
- `Limits: refresh requested; run /status again shortly.` should trigger same-session `/status` retries.
- If raw output shows `u/status`, or repeated `/status` prompt text without `5h limit` / `Weekly limit` rows, the retry was appended to stale input instead of being submitted cleanly. Codex can render `›/statusgpt-...` without a newline; the collector should still treat that as a visible slash buffer. `/statusline` completion text is harmless when the phase is `usage-output-complete`.

Antigravity:

- Raw should include `Model Quota` or `Model usage`.
- Parsed output should show at least 1 whitelisted model row.
- `quota-percent` without `model-screen` usually means `/usage` did not open the panel yet.
- `parsed-models=1/1` points to redraw or panel-boundary parsing.

## Common Symptoms

| Symptom                                            | Likely cause                                                     | Fix direction                                                                  |
| -------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `Cross-site POST form submissions are forbidden`   | Missing JSON body or Origin header                               | Send `{}` with `Origin: http://127.0.0.1:5173`                                 |
| Source changes seem ignored                        | Preview server was not restarted                                 | Run `.\scripts\start-server.ps1` again                                         |
| All providers become partial in one bucket         | CLI startup/auth timing or `node-pty` path issue                 | Inspect latest and last-failure raw snapshots                                  |
| Latest UI still shows usable values after partial  | Storage carried forward previous usable snapshot                 | Check provider status/message for latest failure                               |
| Cold boot shows Claude `Unavailable` / `Unknown`   | Startup refresh ran before Claude accepted `/usage`              | Keep previous usable history and delay startup auto-refresh                    |
| Terminal window briefly steals focus on a timer    | ConPTY/OpenConsole or stale-tab collection started provider CLIs | Use winpty by default; require a refresh-mode header before the API opens CLIs |
| Antigravity has status rows but no models          | `/usage` panel was not opened or not settled                     | Check slash buffer, auth wait, and reissue guard                               |
| Codex shows `Unknown` or `100%`                    | Parser read a status line instead of limit rows                  | Narrow Codex parser to limit rows                                              |
| Visual C++ assertion dialog mentions `conpty.node` | Bundled ConPTY DLL or PTY cleanup path crashed                   | Keep `AI_USAGE_USE_CONPTY_DLL` unset; restart server                           |
| `collector.log` looks quiet during success         | Successful raw snapshots are the stronger evidence               | Check `data\raw\*-latest.parsed.json`                                          |
| Tracked process shows `Recognized: False`          | Date format mismatch during JSON serialization                   | Fixed by comparing process creation dates with 2s margin                       |
| `AttachConsole failed` in startup log              | node-pty / Windows console API compatibility issue               | Non-blocking warning unless Vite server fails to start                         |
| `Cannot find name 'ModelUsage'` on build           | Missing export/import of ModelUsage type in UI                   | Fixed by importing ModelUsage from `$lib/usage`                                |

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
