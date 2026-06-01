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
- Claude, Codex, and Gemini are `ok` unless the CLI itself is unavailable.

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
- If the latest `data\usage-latest.json` has all providers `ok`, watch the next scheduled refresh before changing code.

For follow-up monitoring, check only lines after the latest successful `generatedAt` time unless the user is asking about an older incident.

Escalate to collector/runtime investigation when new lines repeat:

- `node-pty path failed; trying pipe fallback`
- a Microsoft Visual C++ Runtime assertion dialog mentioning `node-pty` or `conpty.node`
- repeated `markers=none` entries after the final attempt
- `claude-trust-prompt` or `codex-update-prompt`
- startup/redraw phases such as `claude-startup-or-redraw`, `codex-startup-or-redraw`, or `gemini-startup-or-redraw`
- final-attempt `partial` warnings for all providers in the same refresh bucket

Escalate to parser investigation only when the raw or latest parsed snapshot clearly contains usage rows but the parsed provider result is still `partial`.

`DEP0205` / `module.register()` warnings are non-blocking Vite/SvelteKit/Node deprecation warnings unless they are paired with request failures or server startup errors. They are filtered from the dashboard log; track them as dependency maintenance, not as usage parsing failures.

Windows `node-pty` assertion dialogs are native process failures, so the browser cannot catch the dialog after it is created. The collector keeps the bundled ConPTY DLL disabled by default; only set `AI_USAGE_USE_CONPTY_DLL=1` temporarily when investigating PTY behavior.

## Phase Meanings

| Phase                                | Meaning                                                          | Next check                                                                               |
| ------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `usage-output-complete`              | Parser found enough usage data                                   | Check `usage-latest.json` and UI rendering                                               |
| `claude-ready-without-usage-output`  | Claude opened, but `/usage` has not produced complete rows yet   | Retry same working directory; do not switch unless a trust prompt appears                |
| `claude-trust-prompt`                | Claude is blocked by workspace trust                             | Next retry should move to another trusted candidate quickly                              |
| `codex-loading`                      | Codex is still starting, or `/status` is buffered during startup | The collector retries confirmation; inspect only if the final attempt stays partial      |
| `codex-status-refresh-pending`       | Codex asked to rerun `/status` shortly                           | Same-session `/status` retry should clear the prompt, wait briefly, and resend `/status` |
| `codex-status-output-without-limits` | Codex answered, but limit rows are missing                       | Inspect raw text for changed output shape                                                |
| `gemini-auth-wait`                   | Gemini is waiting for auth/trust flow                            | Do not spend `/model` fallback during auth wait                                          |
| `gemini-slash-buffer-waiting`        | `/model` is still in the input buffer                            | Check confirmation Enter and settle timing                                               |
| `gemini-ready-without-model-screen`  | Gemini prompt returned, but no model panel opened                | Check slash reissue guard                                                                |
| `gemini-model-screen-incomplete`     | Model panel opened, but rows/resets are incomplete               | Check `\r` handling and panel boundary parsing                                           |
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

Gemini:

- Raw should include `Model usage`.
- Parsed output should show at least 3 model rows.
- `quota-percent` without `model-screen` usually means `/model` did not open the panel yet.
- `parsed-models=1/3` or `missing reset-word` usually points to redraw or panel-boundary parsing.

## Common Symptoms

| Symptom                                            | Likely cause                                       | Fix direction                                        |
| -------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| `Cross-site POST form submissions are forbidden`   | Missing JSON body or Origin header                 | Send `{}` with `Origin: http://127.0.0.1:5173`       |
| Source changes seem ignored                        | Preview server was not restarted                   | Run `.\scripts\start-server.ps1` again               |
| All providers become partial in one bucket         | CLI startup/auth timing or `node-pty` path issue   | Inspect latest and last-failure raw snapshots        |
| Latest UI still shows usable values after partial  | Storage carried forward previous usable snapshot   | Check provider status/message for latest failure     |
| Gemini has status rows but no models               | `/model` panel was not opened or not settled       | Check slash buffer, auth wait, and reissue guard     |
| Codex shows `Unknown` or `100%`                    | Parser read a status line instead of limit rows    | Narrow Codex parser to limit rows                    |
| Visual C++ assertion dialog mentions `conpty.node` | Bundled ConPTY DLL or PTY cleanup path crashed     | Keep `AI_USAGE_USE_CONPTY_DLL` unset; restart server |
| `collector.log` looks quiet during success         | Successful raw snapshots are the stronger evidence | Check `data\raw\*-latest.parsed.json`                |

## When To Change Code

Change collector timing/readiness when:

- raw output lacks usage rows;
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
