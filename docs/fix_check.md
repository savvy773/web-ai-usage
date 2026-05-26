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
- `markers`
- `parseDiagnostics`
- `status`
- `message`
- `windows` or `modelUsages`

If raw output does not contain usage rows, the issue is collector timing/readiness. If raw output contains usage rows but parsed JSON misses them, the issue is parser normalization or provider parsing.

## Phase Meanings

| Phase                                | Meaning                                            | Next check                                          |
| ------------------------------------ | -------------------------------------------------- | --------------------------------------------------- |
| `usage-output-complete`              | Parser found enough usage data                     | Check `usage-latest.json` and UI rendering          |
| `codex-loading`                      | Codex is still starting                            | Wait for readiness; do not send `/status` too early |
| `codex-status-refresh-pending`       | Codex asked to rerun `/status` shortly             | Same-session `/status` retry should happen          |
| `codex-status-output-without-limits` | Codex answered, but limit rows are missing         | Inspect raw text for changed output shape           |
| `gemini-auth-wait`                   | Gemini is waiting for auth/trust flow              | Do not spend `/model` fallback during auth wait     |
| `gemini-slash-buffer-waiting`        | `/model` is still in the input buffer              | Check confirmation Enter and settle timing          |
| `gemini-ready-without-model-screen`  | Gemini prompt returned, but no model panel opened  | Check slash reissue guard                           |
| `gemini-model-screen-incomplete`     | Model panel opened, but rows/resets are incomplete | Check `\r` handling and panel boundary parsing      |
| startup/redraw with `markers=none`   | Raw has boot/progress output only                  | Treat as collector readiness/timing first           |

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

Gemini:

- Raw should include `Model usage`.
- Parsed output should show at least 3 model rows.
- `quota-percent` without `model-screen` usually means `/model` did not open the panel yet.
- `parsed-models=1/3` or `missing reset-word` usually points to redraw or panel-boundary parsing.

## Common Symptoms

| Symptom                                           | Likely cause                                       | Fix direction                                    |
| ------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------ |
| `Cross-site POST form submissions are forbidden`  | Missing JSON body or Origin header                 | Send `{}` with `Origin: http://127.0.0.1:5173`   |
| Source changes seem ignored                       | Preview server was not restarted                   | Run `.\scripts\start-server.ps1` again           |
| All providers become partial in one bucket        | CLI startup/auth timing or `node-pty` path issue   | Inspect latest and last-failure raw snapshots    |
| Latest UI still shows usable values after partial | Storage carried forward previous usable snapshot   | Check provider status/message for latest failure |
| Gemini has status rows but no models              | `/model` panel was not opened or not settled       | Check slash buffer, auth wait, and reissue guard |
| Codex shows `Unknown` or `100%`                   | Parser read a status line instead of limit rows    | Narrow Codex parser to limit rows                |
| `collector.log` looks quiet during success        | Successful raw snapshots are the stronger evidence | Check `data\raw\*-latest.parsed.json`            |

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
