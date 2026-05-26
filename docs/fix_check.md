# Fix Checklist

When collection fails, narrow down the cause in this order. Do not jump straight to fixing regex — most issues are timing or readiness, not parsing.

## Step-by-Step

**1. Terminal readiness**
Confirm the provider command was sent only after the PowerShell prompt appeared.

**2. CLI readiness**
Confirm the slash command was sent only after the CLI prompt was ready.
- Codex: do not force `/status` while `Booting MCP server` is still showing.
- Gemini: if `/model` is stuck in the input line, check Enter confirmation timing.

**3. Output completeness**
- Codex: needs both `5h limit` and `Weekly limit` rows.
- Claude: needs both current/week percent and reset text.
- Gemini: needs at least 3 model rows with reset info.

**4. Raw capture**
Check `data/raw/{provider}-latest.txt` for actual terminal output.
Check `data/raw/{provider}-latest.parsed.json` for `phase`, `markers`, `parseDiagnostics`.
For failures, check `data/raw/{provider}-last-failure.txt`.

**5. Parser boundary**
- Raw has usage rows but `markers` is empty → normalization or parser entry issue.
- Raw has no usage rows → collector timing issue, not a parser issue.

**6. Stored JSON**
Check `data/usage-latest.json` for `status`, `windows`, `modelUsages`.
If values look correct, narrow to UI rendering.

**7. UI rendering**
If JSON is correct but screen shows `Unknown` or stale values, check `src/routes/+page.svelte`.

## Common Symptoms

| Symptom | First thing to check |
|---|---|
| `phase=codex-loading` | Codex not ready yet — wait longer before sending `/status` |
| `phase=codex-status-refresh-pending` | Re-send `/status` in the same session |
| `phase=gemini-auth-wait` | Gemini authenticating — do not consume `/model` fallback yet |
| `phase=gemini-slash-buffer-waiting` | `/model` stuck in input — check Enter confirmation |
| `phase=gemini-model-screen-incomplete` | `Model usage` opened but rows incomplete — check parser normalization |
| `markers=none` | Check if raw actually contains a usage screen |
| Codex `Week 100%` | Check if `100% context left` status line is being misread as usage |
| Gemini `parsed-models=1/3` | Check `Model usage` panel boundary and row combining |
| Claude reset `Unknown` | Percent captured before reset — check snapshot carry-forward logic |

## Post-Fix Verification

- [ ] `pnpm check`
- [ ] Restart server via `scripts/start-server.ps1`
- [ ] `POST /api/usage/refresh`
- [ ] Check `data/raw/{provider}-latest.parsed.json`
- [ ] Check `data/usage-latest.json`
