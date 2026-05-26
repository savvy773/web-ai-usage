# AI Usage Dashboard — Architecture

Project root: `D:\Code\_toolkit\aI_usage`  
Start script: `D:\Code\_toolkit\aI_usage\scripts\start-server.ps1`  
Dashboard URL: `http://127.0.0.1:5173/`

## Purpose

AI Usage Dashboard is a SvelteKit app for quickly checking local CLI usage.

The core design separates the **read path** from the **refresh path**. The UI reads stored JSON fast; slow CLI collection runs as a server background task.

## Module Map

| Area | File | Responsibility |
|---|---|---|
| UI | `src/routes/+page.svelte` | Dashboard UI, refresh, cache, logs, stop server |
| usage read API | `src/routes/api/usage/+server.ts` | Return stored usage payload, schedule prefetch |
| usage refresh API | `src/routes/api/usage/refresh/+server.ts` | Trigger new CLI collection |
| server logs API | `src/routes/api/server/logs/+server.ts` | Stream server logs via SSE |
| server stop API | `src/routes/api/server/stop/+server.ts` | Terminate current Node process |
| refresh manager | `src/lib/server/usage/refresh-manager.ts` | Deduplicate refreshes, quick response, prefetch |
| collector | `src/lib/server/usage/collector.ts` | `node-pty`-based CLI execution, child process fallback |
| parser | `src/lib/server/usage/parser.ts` | Parse CLI output |
| storage | `src/lib/server/usage/storage.ts` | Read/write JSON history, manage buckets |
| shared config/types | `src/lib/usage.ts` | Provider config, payload types, CLI collection config |
| console log capture | `src/hooks.server.ts` | Copy console logs to in-memory buffer |
| server runner | `scripts/start-server.ps1` | Run dev/preview server, state file, safe restart |

## Data Flow

1. Browser calls `GET /api/usage`.
2. Server reads `data/usage-history.json` and returns a `UsagePayload`.
3. UI renders the payload and also writes it to `localStorage`.
4. On first load, auto-refresh, or manual refresh: `POST /api/usage/refresh`.
5. Refresh manager reuses an in-progress refresh if one exists.
6. If collection finishes quickly, refresh API returns `200` with the fresh payload.
7. If collection takes too long, it returns `202` with the cached payload first.
8. Browser polls `GET /api/usage` until the refresh completes.

The critical recovery path:

```text
local CLI TUI output
  -> raw terminal text capture
  -> strip terminal escape/control sequences
  -> normalize TUI decoration and carriage returns
  -> parse provider-specific usage values
  -> ProviderUsage JSON
  -> data/usage-history.json
  -> GET /api/usage
  -> Svelte card/bar/countdown rendering
```

The browser never executes CLIs directly. It only reads server-generated JSON. CLI execution and parsing are entirely on the SvelteKit server side.

## What the Human Sees vs. What the Parser Targets

The parser reconstructs as text the usage screen a person would read in a terminal. It does not trust the graph bar itself — only the label, percent, and reset text around it.

### Gemini `/model`

Human-visible screen shows per-model rows under a `Model usage` section:

```text
Model usage

Flash       ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬  0%   Resets: 1:47 PM (22h 12m)
Flash Lite  ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬  0%   Resets: 1:47 PM (22h 12m)
Pro         ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬  7%   Resets: 7:26 AM (15h 51m)
gemini-3.1-…▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬  0%   Resets: 1:47 PM (22h 12m)
```

Parse targets:
- `label`: `Flash`, `Flash Lite`, `Pro`, `gemini-*`
- `percent`: the `%` number on each row
- `resetAt`: time string after `Resets:`, converted to ISO timestamp when possible
- `remainingText`: remaining time in parentheses, e.g. `22h 12m`

The Gemini TUI redraws the same screen multiple times. Use the **last** `Model usage` section that contains `%` values, not the first.

### Codex `/status`

Human-visible screen typically contains a bracket bar with a `left` expression:

```text
5h limit:     [██████████████████░░] 92% left (resets 18:27)
Weekly limit: [████████████████░░░░] 82% left (resets 19:42 on 27 May)
```

Parse targets:
- `fiveHour.percent`: used percent from the `5h limit` row
- `week.percent`: used percent from the `Weekly limit` row
- `resetAt`: time after `resets`
- `remainingText`: original reset expression

**Important:** Codex's `left` is the remaining amount. The dashboard shows used percent for all providers, so `92% left` converts to `8% used`.  
Codex requires both `5h limit` and `Weekly limit` rows to be considered successful. A general status line like `100% context left` is not a usage row.  
The first pty attempt sometimes captures only the Codex MCP boot redraw and ends without usage rows. The collector treats this as a startup transient, skips the regular retry log and `last-failure` write, and proceeds to the next attempt.  
When Codex responds to `/status` with `Limits: refresh requested; run /status again shortly.`, the collector retries `/status` in the same session up to 4 times at 3-second intervals.

### Claude `/usage`

Human-visible screen is divided into session/week blocks:

```text
Current session
█████▌                                             11% used
Resets 4:30pm (Asia/Seoul)

Current week (all models)
██████▌                                            13% used
Resets May 28, 1pm (Asia/Seoul)
```

Parse targets:
- `fiveHour.percent`: `% used` near `Current session`
- `week.percent`: `% used` near `Current week`
- `resetAt`: time after `Resets`. Timezones other than `Asia/Seoul` are ignored to avoid incorrect conversion.

## Refresh Model

Provider CLI collection runs sequentially. Each provider retries up to 5 times on failure; a failing provider does not block subsequent providers. Attempts 1–2 use shorter timeouts for quick recovery; attempts 3+ use longer capture timeouts and slower retry cadence for cases where CLI startup or redraw is slow.

| Provider | Command | Slash command |
|---|---|---|
| Claude | `claude` | `/usage` |
| Codex | `codex` | `/status` |
| Gemini CLI | `gemini --skip-trust` | `/model` |

Total refresh time is roughly the sum of per-provider collection times. The refresh API returns `202` with the cached payload if collection does not finish within the quick wait window; actual collection continues in the background.

Current key settings:

| Setting | Value |
|---|---|
| CLI working directory | `D:\Code\_temp` |
| Shell | `pwsh.exe` |
| Capture timeout (attempts 1–2) | 45s · Codex 90s · Gemini 105s |
| Capture timeout (attempts 3–5) | 60s · Codex 120s · Gemini 135s |
| Collector retry delays | 1.5s, 5s, 5s, 10s |
| Retry recovery log | Only logged after a reportable failure |
| Codex same-session retry | Up to 4× at 3s intervals after "refresh requested" |
| Slash reissue guard | Up to 3× at 5s intervals after ready prompt returns |
| History bucket interval | 10 minutes |
| Prefetch lead time | 30 seconds |
| Quick refresh wait | 2 seconds |
| Frontend polling interval | 1.5 seconds |
| Frontend polling attempts | 24 |
| Manual refresh cooldown | 10 seconds |

## CLI Execution

The default execution path uses `node-pty`:

1. Open a `pwsh.exe -NoLogo -NoProfile` virtual terminal.
2. Write the provider command.
3. Wait for the CLI ready prompt.
4. Write the slash command.
5. Wait briefly for usage output to stabilize.
6. Pass the output text to the parser.

`node-pty` execution details:

- Terminal name: `xterm-256color`
- Cols: 120 default; 160 for Gemini (Gemini's `Resets:` text is long — narrow columns break the row)
- Rows: 36
- cwd: `CLI_COLLECTION_CONFIG.workingDirectory`
- env: process env merged with `CLI_COLLECTION_CONFIG.env`
- Windows: `useConptyDll: true`
- Capture buffer retains only the last 20,000 chars. TUI redraws are frequent; preserving the latest complete screen matters more than the full log.

Ready detection:

- **PowerShell ready**: tail matches `PS D:\...\>` → write provider command
- **Claude ready**: any of `? for shortcuts`, `Advisor Tool`, `Try "..."`, `Welcome back` visible → ready for `/usage`
- **Codex ready**: `Use /skills` or `gpt-* · D:\...` prompt visible. If `Booting MCP server` is still in tail but a newer `gpt-* · D:\...` prompt follows it, Codex is considered ready.
- **Gemini ready**: `Type your message` or `workspace (/directory)` visible → ready for `/model`

Input timing:

- Shell command: written 500ms after PowerShell prompt appears.
- Slash command: written after provider ready — Claude 500ms, Codex 1000ms, Gemini 800ms.
- Claude uses a base command delay of 6 seconds.
- Codex and Gemini schedule a slash command fallback at minimum 10 seconds, in case ready detection is slow or the prompt string changes. For Codex, if only `Booting MCP server` or `model: loading` is visible at fallback time, `/status` input is delayed 1 second at a time until capture timeout.
- Codex sends an extra Enter 400ms after `/status` to confirm command selection.
- When Codex returns `refresh requested` after `/status`, the collector retries `/status` in the same session after 3 seconds.
- Gemini's fallback does not consume `/model` during `Waiting for authentication...`; it delays 1 second at a time until the ready prompt appears.
- If Codex/Gemini already sent the slash command but the ready prompt returned without a usage screen, the collector treats it as a lost command and reissues the slash command in the same session up to 3 times at 5-second intervals.
- Gemini: if `/model` is still in the input line and neither `Select Model` nor `Model usage` is visible, Enter is sent repeatedly — first check at 800ms, then every 2 seconds until 10 seconds before Gemini's capture timeout.

Completion detection:

- **Codex**: both `fiveHour.percent` and `week.percent` parsed → usage output accepted.
- **Claude**: both fiveHour/week percent and reset text parsed → accepted. (Saving on a percent-only redraw would show Reset as `Unknown`.)
- **Gemini**: at least 3 model rows with `resetAt` or `remainingText` → accepted.
- After output is detected, a settle delay is applied before ending: 1.2s default, 3s for Gemini.

If `node-pty` fails, the collector falls back to a plain child process pipe.

Gemini CLI receives both `--skip-trust` and `GEMINI_CLI_TRUST_WORKSPACE=true`. In the dashboard's hidden `node-pty` session the Gemini ready prompt can appear late, so `/model` input is scheduled independently of ready detection.

Claude and Codex use their default commands. Flag equivalents like `--permission-mode bypassPermissions` (Claude) or `--ask-for-approval never` (Codex) change auth/approval policy, not workspace trust — they offer no speed benefit for usage collection and can break Codex `/status` collection.

## Parser Normalization

CLI output can differ between the human-visible screen and raw text due to TUI redraws and graph characters. The parser normalizes terminal output to safe text first, then extracts provider-specific values.

- Remove ANSI escapes, OSC sequences, bare ESC commands, and control codes.
- Replace cursor movement sequences with spaces (not deletion) to approximate the spacing shown by `Get-Content`.
- Remove orphaned CSI fragments missing their leading ESC byte — e.g. `[38;2;...m`, `[39;49m`, `[K`, `[3G`.
- Keep `\r\n` as a newline; replace bare `\r` with a space. This prevents Gemini TUI output from splitting a single on-screen line like `Flash ... 0% Resets: ...` across two lines when `\r` is treated as a newline.
- Replace box characters, brackets, and block/bar graph characters with spaces. The patterns are managed in `BOX_DECORATION_PATTERN` and `BAR_DECORATION_PATTERN` in `parser.ts`; the same constants are reused for collector marker detection.
- Convert Codex `left`-style remaining-amount expressions (e.g. `92% left`) to used percent.
- Claude redraws can leave cursor movements between characters, resulting in `Curre t session` or `Rese s`. Current/reset matching allows these common damage forms.

Normalization order:

1. `stripTerminalOutput(raw)` — remove OSC, ANSI, orphaned CSI, terminal escapes, control codes
2. Keep `\r\n` as `\n`
3. Replace bare `\r` with a space
4. Apply per-provider line normalization
5. Replace box/bar/bracket characters with spaces
6. Collapse whitespace and trim

Treating bare `\r` as a newline would split Gemini rows differently from the screen. For example, `Flash ... 0%\r Resets: ...` in raw should be read as one line — the `\r` is a same-line redraw artifact, not a line break.

Common percent rules:

- A bare `%` is treated as used percent.
- If the same line contains `left`, `remaining`, or `available` and not `used`, compute `100 - value` for used percent.
- Percent is clamped to `0..100` and rounded to one decimal.

Because Gemini `/model` may redraw multiple times, the parser uses the **last** `Model usage` section containing percent values, not the first. Inside the panel, rows with `label + bar + percent + Resets` structure are trusted, including new model names. Outside the panel fallback, only narrow labels (`Flash`, `Flash Lite`, `Pro`, `gemini-*`) are accepted; percent values attached to status/remaining-amount context lines are not treated as Gemini model usage.

Claude and Codex current/week sections are also searched from the end to prioritize the latest redraw.

Parse results are normalized into `ProviderUsage` objects. Claude/Codex store percent/reset info in `windows.fiveHour` and `windows.week`; Gemini stores per-model percent/reset in `modelUsages`. This data is written to `data/usage-history.json`, served via `/api/usage`, and rendered in the Svelte UI.

### Per-Provider Parser Algorithms

#### Claude/Codex Shared Window Parser

1. Normalize raw output and split into lines.
2. Parse `fiveHour` and `week` windows separately.
3. Codex: look for special rows first.
   - `5h limit:` → `fiveHour`
   - `Weekly limit:` or `Week limit:` → `week`
   - Search is performed back-to-front to prioritize the latest redraw.
4. Fall back to section parser if no special rows found:
   - `fiveHour`: `Current session`, `5h`, `5 hour`, `five hour`
   - `week`: `Current week`, `week`, `weekly`, `7d`, `7 day`
5. Section start is found back-to-front.
6. Section reads up to 8 lines from the start point, stopping at the opposite section.
7. Within the section, fill percent, ratio, remaining text, and reset time in order.
8. If a ratio in `used / limit` or `used of limit` form is present, compute `used`, `limit`, and `percent`.

#### Gemini Model Parser

Gemini rows frequently break from TUI redraws, so multiple parsers are combined and results are merged by label.

1. Find the last complete `Model usage` section.
   - Candidates span from `Model usage` to `(Press Esc to close)`, the bottom border, or end of output.
   - If multiple candidates exist, use the last one containing `%`.
2. If the bar row parser recovers at least 3 model rows with reset info, it takes priority.
3. Otherwise, build fallback candidate lines:
   - Normalized line array
   - Lines from raw output with `│┃║` replaced by newlines
   - Entire raw output joined into one line
4. Run these parsers:
   - **Bar row parser**: combine bar-containing rows; parse label/percent/reset. Inside the `Model usage` panel, new model names are accepted as labels when the structure is clear.
   - **Known model scan**: find first `%` and `Resets:` in the span after `Flash Lite|Flash|Pro|gemini-*`
   - **Split/direct-line parser**: parse label + percent within one line, or combine a label-only line with a following percent line
   - **Ordered fallback**: pair the latest model labels with the latest percent values in order
5. Clean labels:
   - Remove leading prompt/bullet characters
   - Remove text after percent
   - Remove text after `Resets:`
   - Outside-panel fallback: only `Flash`, `Flash Lite`, `Pro`, `gemini-*` are kept
   - Model screen navigation text, prompts, and status rows are not accepted as labels
6. Merge by label:
   - If the same label appears multiple times, prefer the result with `resetAt`.
   - If `resetAt` is equal, prefer the result with `remainingText`.
7. Gemini provider can be `ok` only when at least 3 model usage labels have reset info.

Duplicate fallbacks and fabricated labels are avoided. A `% Resets:` row without a model name is not stored as `Gemini model 1`; it is only used when a known model scan or split-line parser can pair it with a real label.

### Reset Time Parsing

Supported reset text formats:

- Time only: `4:30pm`, `4:30 PM`, `18:27`
- Month date time: `May 28, 1pm`
- Codex date: `19:42 on 27 May`
- Timezone suffix: `(Asia/Seoul)` is accepted; other timezones are not converted to ISO to avoid misinterpretation

Time-only values in the past roll over to the next day. Month/date values in the past roll over to the next year.

### Status and Message

Provider status:

- `ok`: usage values successfully parsed
- `partial`: CLI output received but insufficient usage values
- `unavailable`: no CLI output, or a command/auth/permission issue

Message rules:

- If an error message is present, use it as-is
- If usage was parsed: `Usage data parsed from CLI output.`
- If output exists but no usage found: `CLI responded, but usage values were not found.`
- If no output: `CLI returned no output.`

## UI Behavior

The UI is centered on provider cards:

- **Claude/Codex**: current and weekly usage windows
- **Gemini CLI**: per-model (Flash, Flash Lite, Pro) usage rates
- Each usage bar shows an 80% threshold line
- Week usage shows a Pace card
- The Pace card renders the current week usage as a fill bar and the target pace as a vertical threshold marker line. The target marker starts at minimum 20% even early in the week. Slightly ahead usage shows `On pace` or soft pastel green; significantly ahead shows pastel yellow; excessively ahead shows pastel rose warning.
- Reset time is shown broken down into remaining days/hours/minutes
- Provider card header shows status and collection duration

Rendering rules:

- Percent text: `null` → `Unknown`; integer → `24%`; decimal → `24.5%`
- Usage bar width: clamp percent to `0..100`, use as `%` width
- Usage bar color via `heatColor(percent)`:
  - `null`: slate
  - `>= 90`: red
  - `>= 80`: orange
  - `>= 60`: amber
  - `>= 35`: green
  - otherwise: cyan
- Claude/Codex window cards render `windows.fiveHour` and `windows.week`
- Gemini model cards render `modelUsages[]`; Gemini does not use `fiveHour/week` windows
- Reset countdown: if `resetAt` is present, compute the diff from now; otherwise display `remainingText` as-is
- Provider status badge: `ok → Live`, `partial → Partial`, `unavailable → Unavailable`

Pace card:

- Only shown when `windows.week` has both percent and resetAt
- Target percent is computed from time remaining until the week resets

| Time until week reset | Target |
|---|---|
| > 6 days | 20% |
| > 5 days | 20% |
| > 4 days | 35% |
| > 3 days | 50% |
| > 2 days | 65% |
| > 1 day  | 80% |
| > 0.5 days | 90% |
| otherwise | 95% |

- `diff = week.percent - target`
- `diff >= 35`: `Very high pace`, pastel rose
- `diff >= 24`: `High pace`, pastel yellow
- `diff >= 14`: `Ahead`, pastel green
- `diff <= -25`: `Plenty left`, cyan
- `diff <= -10`: `Room to use`, sky
- `diff <= -4`: `Slightly under`, teal
- otherwise: `On pace`, emerald

Top controls:

- **Auto**: auto-refresh based on `nextRefreshAt`
- **Refresh**: manual refresh with 10-second cooldown
- **Browser reload/F5**: render SSR payload first, then call `/api/usage/refresh`. Reload bypasses the UI cooldown because it is an explicit user action.
- **Stop**: call the server stop API

Bottom logs:

- Receive server console logs via SSE and display them
- Maintain up to 500 client-side entries
- Provide auto-scroll toggle and clear button

## Cache and History

Files to check during operation:

| File | Purpose |
|---|---|
| `data/usage-history.json` | Persistent history — the primary JSON the dashboard reads and writes |
| `data/usage-latest.json` | Latest UI/API payload with only the last 6 buckets in `history` |
| `data/raw/{provider}-latest.txt` | Last raw CLI output tail per provider |
| `data/raw/{provider}-latest.parsed.json` | Parse result snapshot for the same attempt |
| `data/raw/{provider}-last-failure.txt` | Last failed/partial attempt raw — preserved even after a successful attempt overwrites `latest` |
| `data/raw/{provider}-last-failure.parsed.json` | Parse snapshot including markers and diagnostics for the failure |
| `data/logs/server.log` | Full server console log (append) |
| `data/logs/server-error.log` | `warn`/`error` level only (append) |
| `data/logs/collector.log` | CLI collection/parse diagnostics with `[collector]` prefix (append) |
| `data/logs/server-process.log` | Node/Vite process stdout from `start-server.ps1` |
| `data/logs/server-startup-error.log` | Node/Vite process stderr for low-level startup errors |
| `.server/ai-usage-dashboard.json` | Server state managed by `start-server.ps1`: port, host, mode, root PID, process creation date |

`data/usage-history.json`:

- Bucket interval: 10 minutes
- Retention: last 12 buckets, minimum 5
- Re-collecting within the same bucket updates that bucket
- Written atomically: write to `data/usage-history.<pid>.<timestamp>.tmp` then rename to `usage-history.json`

`data/usage-latest.json`:

- Same shape as the `UsagePayload` returned by `/api/usage`
- `providers[]` is the latest provider data shown in the top cards
- `history[]` contains only the last 6 buckets for easy inspection
- Updated whenever `recordUsageSnapshot` runs after a successful refresh

`data/raw/`:

- `{provider}-latest.txt` and `{provider}-latest.parsed.json` are overwritten after each collector attempt
- Failed/partial attempts are also preserved in `{provider}-last-failure.txt` and `.parsed.json`
- `*-latest.txt` contains raw terminal output before escape stripping — useful for seeing actual TUI redraws, `\r`, and box characters
- `*-latest.parsed.json` contains the parser result from the same attempt, for side-by-side comparison
- `phase` narrows where the collector failed. CLI output seen on screen is a mix of auth spinner, prompt redraws, slash command buffer, usage panel, and status row in the raw stream. Check in order: `phase → markers → rawPreview/raw tail`
- Raw files may be sensitive and are git-ignored

Storage notes:

- `rawPreview` is not stored in history. Raw terminal output can be large and sensitive; it is compacted to `null` when saving provider snapshots.
- If a provider is not `ok` in a new refresh but the previous history has usable data, the previous values are retained.
- In that case, status/message reflect the latest failure; actual usage values come from the last usable snapshot.
- Usable data: has `modelUsages`, or `fiveHour`/`week` has a `percent` or `used` value.
- Even when a provider is `ok`, if a specific window's reset is missing, the previous snapshot's future `resetAt` is reused — this reduces `Unknown` reset display when Claude redraws send percent before reset.

Stored JSON shape:

```json
{
  "history": [
    {
      "bucketStart": "2026-05-22T09:10:00.000Z",
      "collectedAt": "2026-05-22T09:15:48.000Z",
      "providers": {
        "claude": {
          "status": "ok",
          "message": "Usage data parsed from CLI output.",
          "collectedAt": "2026-05-22T09:14:10.000Z",
          "collectionDurationMs": 8000,
          "windows": {
            "fiveHour": {
              "percent": 35,
              "resetAt": "2026-05-22T16:30:00.000Z",
              "remainingText": "4:30pm Asia/Seoul"
            },
            "week": {
              "percent": 20,
              "resetAt": "2026-05-28T13:00:00.000Z",
              "remainingText": "May 28, 1pm Asia/Seoul"
            }
          }
        },
        "codex": {
          "status": "ok",
          "windows": {
            "fiveHour": { "percent": 45, "resetAt": "2026-05-22T18:27:00.000Z" },
            "week": { "percent": 24, "resetAt": "2026-05-27T19:42:00.000Z" }
          }
        },
        "gemini": {
          "status": "ok",
          "modelUsages": [
            { "label": "Flash",      "percent": 0, "resetAt": "2026-05-23T13:47:00.000Z", "remainingText": "22h 12m" },
            { "label": "Flash Lite", "percent": 0, "resetAt": "2026-05-23T13:47:00.000Z", "remainingText": "22h 12m" },
            { "label": "Pro",        "percent": 7, "resetAt": "2026-05-23T07:26:00.000Z", "remainingText": "15h 51m" }
          ]
        }
      }
    }
  ]
}
```

JSON inspection checklist:

- Top level is `{ "history": [...] }`. The latest bucket is typically the last entry.
- For Claude/Codex: check `windows.fiveHour` and `windows.week` for `percent`, `resetAt`, `remainingText`.
- For Gemini: check `modelUsages[]` for `label`, `percent`, `resetAt`, `remainingText`.
- If `status` is `partial` or `unavailable` but values are present, the latest refresh failed but storage is carrying the last usable snapshot. Check `message` for the failure reason.

Browser cache:

- Key: `ai-usage-payload-cache`
- On first load, render cached payload immediately if present
- On `/api/usage` failure, keep the last cached payload

## API Contract

### `GET /api/usage`

Returns the stored usage payload.

Key fields:

- `generatedAt`: when the API response was generated
- `nextRefreshAt`: next target refresh time
- `providers`: latest per-provider usage array
- `history`: recent usage bucket list
- `refreshState`: current background refresh state

Runtime shape of `providers[]`:

```ts
type ProviderUsage = {
  provider: 'claude' | 'codex' | 'gemini';
  name: string;
  command: string;
  slashCommand: string;
  usageUrl: string | null;
  status: 'ok' | 'partial' | 'unavailable';
  message: string;
  collectedAt: string | null;
  collectionDurationMs: number | null;
  windows: {
    fiveHour: UsageWindow;
    week: UsageWindow;
  };
  modelUsages: ModelUsage[];
  rawPreview: string | null;
};

type UsageWindow = {
  id: 'fiveHour' | 'week';
  label: 'Current' | 'Week';
  used: number | null;
  limit: number | null;
  percent: number | null;
  resetAt: string | null;
  remainingText: string | null;
};

type ModelUsage = {
  label: string;
  percent: number;
  resetAt: string | null;
  remainingText: string | null;
};
```

### `POST /api/usage/refresh`

Request new usage collection.

Responses:

- `200`: collection completed within the quick wait window
- `202`: collection is still in progress; returns cached payload

### `GET /api/server/logs`

Returns an SSE stream.

Event payload:

- `init`: full current log buffer
- `entry`: one new log entry

### `POST /api/server/stop`

Terminates the current server process after a short delay.

## Error Handling

- A single provider failure does not stop the dashboard from rendering.
- Failed providers show as `partial` or `unavailable`.
- The refresh API can return a cached payload first to avoid blocking the browser during long collection.
- If the parser finds no values, the provider message includes the reason.
- The frontend falls back to `localStorage` cache on server request failure.

For the diagnostic checklist and fix notes, see [fix_check.md](fix_check.md).

Collector log marker meanings:

- `phase=usage-output-complete`: usage values are complete; the parser can produce `ok`.
- `phase=codex-loading`: Codex is still in `Booting MCP server` or `model: loading`. Force-sending `/status` now would lose or partial the command.
- `phase=codex-ready-without-status-command`: Codex prompt returned but no `/status` result. The same-session slash reissue guard should re-send `/status`.
- `phase=codex-status-refresh-pending`: `/status` ran but Codex returned only `refresh requested`. Re-send `/status` in the same session.
- `phase=codex-status-output-without-limits`: `/status` panel visible but no `5h limit`/`Weekly limit` rows. Check for provider response shape changes or a still-pending screen.
- `phase=gemini-auth-wait`: Gemini authentication spinner. `/model` fallback must not be consumed in this state.
- `phase=gemini-ready-without-model-command`: Gemini prompt ready but no `/model` input trace. Slash reissue guard should re-send `/model`.
- `phase=gemini-ready-without-model-screen`: Bottom quota/status visible but no `Model usage` screen. This is a command/confirmation/timing issue, not a parser issue.
- `phase=gemini-slash-buffer-waiting`: `/model` is still in the input line. Check Enter confirmation and settle timing.
- `phase=gemini-model-screen-incomplete`: `Model usage` screen visible but not enough row/reset combinations. Check parser row combining and redraw normalization.
- `Gemini markers=model-screen,model-name,bar-row,percent,reset-word,percent-reset`: usage screen, model name, bar row, percent, and reset text are all present. A failure here points to parser row combining or label normalization.
- `Gemini markers=slash-buffer,quota-percent`: `/model` is in the input line and only quota percent is visible. Check collection timing — the model usage screen has not opened yet.
- `Gemini markers=model-name,bar-row,percent`: model usage row model name and bar/percent visible but reset text may not have been recovered into the same row.
- `Gemini markers=model-name,percent`: section boundary likely broken or mid-redraw. Check `\r` handling, bar row parser, and latest-redraw selection logic.
- `Gemini markers=quota-percent` only, no `model-screen`: the parser did not miss model rows — the `/model` screen has not appeared yet.
- `Gemini parsed-models=1/3`: number of model rows the parser accepted. Gemini needs at least 3 model usages with reset info to be `ok`.
- `Gemini parsed-labels=Flash|Flash Lite|Pro`: model labels recovered by the parser.
- `Gemini parse-failure=missing ...`: candidate failure reason. `missing percent-reset-same-row,3 model rows` means percent/reset pairs are incomplete or fewer than 3 model rows were found.
- `Codex markers=5h-limit,week-limit`: both limit rows visible. Percent must be parsed from both rows for `ok`.
- `Claude markers=usage-word,percent`: usage-related text and percent are visible. Check current/week section matching.

Recovery priority order:

1. `stripTerminalOutput` `\r` handling and escape/orphaned CSI removal
2. Gemini last `Model usage` redraw selection
3. Codex `left → used` conversion
4. `ProviderUsage` JSON shape
5. Storage previous-usable-snapshot carry-forward logic
6. UI — once the JSON shape is correct, this is the easiest layer to fix

## Development

Dev server:

```powershell
pnpm dev
```

Type check and build:

```powershell
pnpm check
pnpm build
```

Recommended start script:

```powershell
.\scripts\start-server.ps1
```

Status check:

```powershell
.\scripts\start-server.ps1 -Status
```

Help:

```powershell
.\scripts\start-server.ps1 -Help
```

`start-server.ps1` stores server state in `.server/ai-usage-dashboard.json`. On re-run it checks this state file and the process command line to ensure it only stops the dashboard server that it started. Process creation date is also stored to reduce PID-reuse false positives.
