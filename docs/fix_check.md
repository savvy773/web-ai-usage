# AI Usage Dashboard — Fix Checklist

This document is a diagnostic reference for narrowing down the next failure from the ground up — not a historical log. Past fixes are kept brief. When a new symptom appears, work through the steps below in order.

## Goals

- Confirm the terminal is actually ready before a command is sent.
- Confirm the collector waits long enough after a slash command for the usage screen to fully render.
- Confirm raw terminal output is being written to the expected files.
- Distinguish between "raw has the value but the parser missed it" vs. "raw never had the value — this is a collector timing issue."
- Check UI rendering issues last, only after confirming the JSON is correct.

## Why This Keeps Getting Confusing

- A human sees the final TUI screen — one frame.
- The collector sees a raw PTY stream. This stream is a time-ordered mix of auth spinners, cursor movements, screen clears, prompt redraws, slash command input lines, the usage panel, and the bottom quota/status row.
- So what looks like the same screen to a human can be any of these distinct states in raw: "command not sent yet", "command is sitting in the input line", "command was lost", "usage panel opened but rows aren't fully drawn", "provider returned refresh requested only".
- When something breaks, do not jump straight to fixing a regex. Narrow it down in order: `phase → markers → parseDiagnostics → rawPreview/raw tail`.

## Narrowing Down — Step by Step

**1. Terminal readiness**
- Check that the provider command is sent only after the PowerShell prompt (`PS D:\...\>`) appears.
- If the command was sent before the prompt appeared, this is a collector input timing issue.

**2. CLI readiness**
- Check that the slash command is sent only after the Claude/Codex/Gemini CLI prompt appears.
- For Codex: if `Booting MCP server` or `model: loading` is all that's showing, do not force `/status` — wait longer.
- For Gemini: if `/model` is sitting in the input line and the `Model usage` screen hasn't opened, look at the confirmation/settle side first.

**3. Output completion**
- Check that the usage rows are complete after the slash command.
- Codex: both `5h limit` and `Weekly limit` must be present.
- Claude: both current/week percent and reset text must be present.
- Gemini: at least 3 model rows with reset info must be present.

**4. Raw capture**
- In `data/raw/{provider}-latest.txt`, check that enough terminal output was captured.
- In `data/raw/{provider}-latest.parsed.json`, check `rawOutputChars`, `rawTailChars`, `attempt`, `phase`, `markers`, `parseDiagnostics`.
- For failed attempts, look at `data/raw/{provider}-last-failure.txt` and `.parsed.json`.

**5. Parser boundary**
- If raw has the usage rows but `markers` is empty, this is a marker normalization or parser entry condition issue.
- If raw does not have the usage rows, this is a collector timing/readiness issue, not a parser issue.

**6. Stored JSON**
- In `data/usage-latest.json`, check the provider's `status`, `windows`, `modelUsages`, and `refreshState`.
- If those values look correct, narrow the problem to UI rendering.

**7. UI rendering**
- If JSON is correct but the screen shows `Unknown`, `100%`, or stale values, check the display logic in `src/routes/+page.svelte`.

## Symptom → Next Step

**`phase=codex-loading`**  
Codex startup/readiness issue. Do not send `/status` sooner — review the ready prompt detection logic.

**`phase=codex-ready-without-status-command`**  
Codex prompt returned but no `/status` result. The slash command was likely lost during a TUI redraw. Check the same-session slash reissue guard.

**`phase=codex-status-refresh-pending`**  
`/status` ran but Codex returned only `refresh requested`. Re-send `/status` in the same session.

**`phase=codex-status-output-without-limits`**  
`/status` panel visible but no limit rows. Check the raw to determine whether the provider response shape changed or the screen is still pending.

**`phase=gemini-auth-wait`**  
Gemini authentication spinner. The `/model` fallback must not be consumed in this state.

**`phase=gemini-ready-without-model-command`**  
Gemini prompt ready but no `/model` input trace. Check the same-session slash reissue guard.

**`phase=gemini-ready-without-model-screen`**  
Bottom quota/status visible but no `Model usage` screen. This is a `/model` input, confirmation, or timing issue — not a parser issue.

**`phase=gemini-slash-buffer-waiting`**  
`/model` is still in the input line. Check Enter confirmation repetition and settle timing.

**`phase=gemini-model-screen-incomplete`**  
`Model usage` screen opened but not enough row/reset combinations recovered. Check parser normalization and panel boundary.

**`markers=none`**  
First check whether the raw output actually contains a usage screen.  
- Raw is only boot/progress redraws → collector readiness/timing issue.  
- Raw has usage rows but `markers=none` → marker normalization issue.

**Codex first-attempt partial**  
- Raw is large but has almost no lines after normalization, with only `Booting MCP server` redraws → startup transient. Check terminal/CLI readiness wait time.
- Raw contains `Limits: refresh requested; run /status again shortly.` → re-send `/status` in the same session.
- If this keeps showing up in normal logs, the transient classifier is missing a new raw shape.

**Codex `Current Unknown` or `Week 100%`**  
Check whether `5h limit` and `Weekly limit` actually appear in `data/raw/codex-latest.txt`. If a status line like `100% context left` is being read as usage, narrow the Codex parser scope.

**Gemini `quota-percent` only**  
`model-screen` not present means the `/model` screen hasn't opened yet — not a parser miss.  
If the raw tail shows `Waiting for authentication...` followed by a ready prompt, `/model` fallback was consumed during auth. Look at `/model` confirmation, wait, and settle conditions before touching parser regex.

**Gemini `parsed-models=1/3` or `missing reset-word`**  
Check whether the `Model usage` panel boundary was captured correctly. Check whether the bar row and reset text are being recovered onto the same row. Suspect `\r` handling or redraw normalization.

**Claude reset `Unknown`**  
Check whether percent was captured first and reset came in late. Review `hasUsageOutput()` reset gate and previous-usable-snapshot carry-forward logic.

## Fix Log

### 2026-05-24: Codex terminal readiness

- Write provider command only after PowerShell prompt is confirmed.
- 1000ms settle after Codex ready, before sending `/status`.
- Do not force `/status` fallback while `Booting MCP server` or `model: loading` is visible; wait until capture timeout.
- Increase Codex capture timeout from 60s to 90s.
- **Next:** if first-attempt partials still repeat, first check whether raw is boot-only vs. having usage rows with no markers.

### 2026-05-24: Patient retries from attempt 3

- Increase collector retry to maximum 5 attempts per provider.
- Apply longer capture timeouts from attempt 3: Codex 120s, Gemini 135s.
- Change retry delay cadence: 1.5s, 5s, 5s, 10s.
- **Next:** if failures continue after attempt 3/5, separate "usage row absent in raw" from "parser miss" using `last-failure` raw.

### 2026-05-24: Same-session slash retry fixes

- **Root cause:** when Codex returned `Limits: refresh requested`, the old code waited until timeout instead of retrying in the same session.
- Fix: retry `/status` in the same session up to 4 times at 3-second intervals after a `refresh requested` response.
- **Root cause:** when the Gemini auth screen was showing, `/model` fallback was consumed before the prompt was ready.
- Fix: delay `/model` fallback 1 second at a time during `Waiting for authentication...`.

### 2026-05-24: Phase diagnostics and slash reissue guard

- **Root cause:** a `missing ...` failure log alone could not distinguish command loss from a parser miss, because humans see the final screen but the collector sees the mid-redraw stream.
- Fix: add `phase` to collector snapshots/logs to separate readiness, slash-buffer, refresh-pending, and model-screen-incomplete states.
- Fix: if Codex/Gemini's ready prompt returns without a usage screen or slash buffer, treat the slash command as lost and reissue it in the same session up to 3 times at 5-second intervals.

### 2026-05-26: Codex startup retry log noise

- **Symptom:** `collector.log` shows only `recovered on attempt 2/5 in 18.xs` with no preceding failure line.
- **Root cause:** attempt 1 was a startup transient (captured only MCP boot redraw) so it skipped the regular failure log and `last-failure` write. But attempt 2's success still logged `recovered`.
- Fix: do not log `recovered on attempt ...` for successes that followed only silent startup retries. Log it only when there was at least one reportable failure before the success.
- **To investigate startup retries:** start the server with `AI_USAGE_DEBUG_LOGS=1` and look for `startup redraw only` log lines.

## Post-Fix Verification

- [ ] `pnpm check`
- [ ] `pnpm lint` if needed
- [ ] Restart preview server via `scripts/start-server.ps1`
- [ ] `POST /api/usage/refresh` from same origin
- [ ] `GET /api/usage`
- [ ] Check `data/raw/{provider}-latest.parsed.json` for the latest attempt
- [ ] Check `data/usage-latest.json` for values that will be rendered on screen
