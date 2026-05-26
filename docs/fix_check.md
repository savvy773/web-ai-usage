# AI Usage Dashboard Fix Checklist

이 문서는 과거 작업 기록이 아니라, 다음 오류가 났을 때 문제를 밑단부터 좁히기 위한 기준입니다. 과거 조치는 짧게만 남기고, 새 증상이 나오면 아래 순서대로 확인합니다.

## 목표

- 터미널이 실제로 준비된 뒤 command를 입력하는지 확인합니다.
- slash command 뒤 usage 화면이 충분히 출력될 때까지 기다리는지 확인합니다.
- raw terminal output이 파일에 제대로 남는지 확인합니다.
- raw에는 값이 있는데 parser가 놓친 것인지, raw 자체에 값이 없는 collector timing 문제인지 구분합니다.
- JSON은 정상인데 화면만 이상한 UI 문제인지 마지막에 확인합니다.

## 왜 반복적으로 헷갈리는가

- 사람은 최종 TUI 화면 한 장을 봅니다.
- collector는 PTY raw stream을 봅니다. 여기에는 auth spinner, cursor movement, 화면 지우기, prompt redraw, slash command 입력줄, usage panel, 하단 quota/status row가 시간순으로 섞입니다.
- 따라서 사람이 보기에는 같은 화면이어도 raw에서는 `command가 아직 안 들어감`, `command가 입력줄에 남음`, `command가 소실됨`, `usage panel이 열렸지만 row가 덜 그려짐`, `provider가 refresh requested만 반환함`이 서로 다른 상태입니다.
- 재발 시 regex부터 고치지 말고 `phase -> markers -> parseDiagnostics -> rawPreview/raw tail` 순서로 원인을 좁힙니다.

## 밑단부터 좁히는 순서

1. Terminal readiness
   - PowerShell prompt가 `PS D:\...\>` 형태로 뜬 뒤 provider command가 입력되는지 봅니다.
   - prompt가 보이기 전 command가 들어간 흔적이 있으면 collector 입력 타이밍 문제입니다.

2. CLI readiness
   - Claude/Codex/Gemini CLI prompt가 뜬 뒤 slash command가 입력되는지 봅니다.
   - Codex는 `Booting MCP server` 또는 `model: loading`만 계속 보이면 `/status`를 강제로 넣지 말고 더 기다려야 합니다.
   - Gemini는 `/model`이 입력줄에 남아 있고 `Model usage` 화면이 안 뜨면 confirmation/settle 쪽을 먼저 봅니다.

3. Output completion
   - slash command 뒤 usage row가 완성됐는지 확인합니다.
   - Codex는 `5h limit`와 `Weekly limit`가 둘 다 있어야 합니다.
   - Claude는 current/week percent와 reset text가 둘 다 있어야 합니다.
   - Gemini는 reset 정보가 있는 model row가 3개 이상 있어야 합니다.

4. Raw capture
   - `data/raw/{provider}-latest.txt`에서 실제 terminal output이 충분히 남았는지 봅니다.
   - `data/raw/{provider}-latest.parsed.json`에서 `rawOutputChars`, `rawTailChars`, `attempt`, `phase`, `markers`, `parseDiagnostics`를 확인합니다.
   - 실패 attempt는 `data/raw/{provider}-last-failure.txt`와 `.parsed.json`을 봅니다.

5. Parser boundary
   - raw에 usage row가 있는데 `markers`가 없으면 marker 정규화 또는 parser 진입 조건 문제입니다.
   - raw에 usage row가 없으면 parser가 아니라 collector timing/readiness 문제입니다.

6. Stored JSON
   - `data/usage-latest.json`에서 provider `status`, `windows`, `modelUsages`, `refreshState`를 확인합니다.
   - 여기 값이 맞으면 화면 문제로 좁힙니다.

7. UI rendering
   - JSON은 정상인데 화면만 `Unknown`, `100%`, stale 값이면 `src/routes/+page.svelte` 표시 로직을 봅니다.

## 증상별 다음 확인

- `phase=codex-loading`
  - Codex startup/readiness 문제입니다. `/status`를 더 빨리 넣지 말고 ready prompt 판별을 봅니다.

- `phase=codex-ready-without-status-command`
  - prompt는 돌아왔지만 `/status` 결과가 없습니다. slash command가 TUI redraw 중 소실된 케이스로 보고 same-session slash reissue guard를 봅니다.

- `phase=codex-status-refresh-pending`
  - `/status`가 실행됐지만 `refresh requested`만 받은 상태입니다. 같은 세션에서 `/status`를 재입력해야 합니다.

- `phase=codex-status-output-without-limits`
  - `/status` panel은 보이지만 limit row가 없습니다. provider 응답 형상 변경인지, 아직 refresh pending인지 raw를 봅니다.

- `phase=gemini-auth-wait`
  - Gemini auth spinner 상태입니다. 이때 `/model` fallback이 소모되면 안 됩니다.

- `phase=gemini-ready-without-model-command`
  - Gemini prompt가 준비됐지만 `/model` 입력 흔적이 없습니다. same-session slash reissue guard를 봅니다.

- `phase=gemini-ready-without-model-screen`
  - 하단 quota/status만 보이고 `Model usage` 화면이 없습니다. parser 문제가 아니라 `/model` 입력/confirmation/timing 문제입니다.

- `phase=gemini-slash-buffer-waiting`
  - `/model`이 입력줄에 남아 있습니다. Enter confirmation 반복과 settle timing을 봅니다.

- `phase=gemini-model-screen-incomplete`
  - `Model usage` 화면은 열렸지만 row/reset 결합이 부족합니다. parser normalization과 panel boundary를 봅니다.

- `markers=none`
  - raw에 usage 화면이 없는지 먼저 확인합니다.
  - raw가 boot/progress redraw뿐이면 collector readiness/timing 문제입니다.
  - raw에 usage row가 있는데도 `markers=none`이면 marker 정규화 문제입니다.

- Codex first-attempt partial
  - raw가 크고 정규화 후 line 수가 거의 없으며 `Booting MCP server` redraw만 있으면 startup transient입니다.
  - raw에 `Limits: refresh requested; run /status again shortly.`가 있으면 같은 세션에서 `/status`를 다시 입력해야 합니다.
  - 이 경우 먼저 terminal/CLI readiness 대기 시간을 봅니다.
  - 기본 로그에 반복 노출되면 transient 분류가 새 raw shape를 놓친 것입니다.

- Codex `Current Unknown` 또는 `Week 100%`
  - `data/raw/codex-latest.txt`에 `5h limit`와 `Weekly limit`가 실제로 있는지 봅니다.
  - `100% context left` 같은 상태줄을 usage로 읽고 있으면 Codex parser 범위를 더 좁힙니다.

- Gemini `quota-percent`
  - `model-screen` 없이 `quota-percent`만 있으면 `/model` 화면이 아직 안 열린 상태입니다.
  - raw tail에 `Waiting for authentication...` 뒤 ready prompt가 보이면 `/model` fallback이 auth 중에 소모된 케이스입니다.
  - parser regex보다 `/model` confirmation, wait, settle 조건을 먼저 봅니다.

- Gemini `parsed-models=1/3` 또는 `missing reset-word`
  - `Model usage` panel boundary가 잡혔는지 확인합니다.
  - bar row와 reset text가 같은 row로 복구되는지 봅니다.
  - `\r` 처리나 redraw normalization을 의심합니다.

- Claude reset `Unknown`
  - percent만 먼저 캡처되고 reset이 늦게 나온 케이스인지 봅니다.
  - `hasUsageOutput()` reset gate와 previous usable snapshot carry-forward를 확인합니다.

## 짧은 조치 기록

### 2026-05-24: Codex terminal readiness 우선

- 조치: PowerShell prompt 확인 후 provider command 입력.
- 조치: Codex ready 후 `/status` 입력 전 1000ms settle.
- 조치: Codex가 `Booting MCP server` 또는 `model: loading`이면 `/status` fallback을 강제하지 않고 capture timeout까지 대기.
- 조치: Codex capture timeout을 60초에서 90초로 증가.
- 다음에 볼 것: 여전히 first-attempt partial이 반복되면 raw가 boot-only인지, usage row가 있는데 marker가 없는지 먼저 분리합니다.

### 2026-05-24: Patient retries from attempt 3

- 조치: Collector retry를 provider별 최대 5회로 증가.
- 조치: 3회차부터 capture timeout을 더 길게 적용. Codex는 120초, Gemini는 135초까지 대기.
- 조치: retry delay를 1.5초, 5초, 5초, 10초 cadence로 변경.
- 다음에 볼 것: `attempt 3/5` 이후에도 실패하면 `last-failure` raw에서 usage row 부재와 parser miss를 먼저 분리합니다.

### 2026-05-24: Same-session slash retry fixes

- 원인: Codex `/status`가 `Limits: refresh requested; run /status again shortly.`를 반환하면 기존 코드는 같은 세션에서 다시 요청하지 않고 timeout까지 기다렸습니다.
- 조치: Codex refresh requested 응답 뒤 3초 간격으로 같은 세션에서 `/status`를 최대 4번 재입력.
- 원인: Gemini auth 대기 화면에서 `/model` fallback이 먼저 소모되면 prompt가 늦게 떠도 다시 입력하지 않았습니다.
- 조치: Gemini `Waiting for authentication...` 중에는 fallback `/model` 입력을 1초씩 늦춤.

### 2026-05-24: Phase diagnostics and slash reissue guard

- 원인: 사람은 최종 화면을 보지만 collector는 중간 redraw stream을 보므로, 실패 로그가 `missing ...`만 말하면 command 소실과 parser miss를 구분하기 어렵습니다.
- 조치: collector snapshot/log에 `phase`를 추가해 readiness, slash-buffer, refresh-pending, model-screen-incomplete를 먼저 분리.
- 조치: Codex/Gemini가 ready prompt로 돌아왔는데 usage 화면과 slash buffer가 없으면 slash command가 소실된 것으로 보고 같은 세션에서 5초 간격으로 최대 3번 재입력.

### 2026-05-26: Codex startup retry log noise

- 증상: `collector.log`에 Codex `recovered on attempt 2/5 in 18.xs`만 반복되고 앞선 실패 라인이 없습니다.
- 원인: 1회차가 Codex MCP startup redraw만 캡처한 transient attempt라 일반 실패 로그와 `last-failure`를 남기지 않았지만, 2회차 성공은 `recovered`로 기록했습니다.
- 조치: 숨김 startup retry만 거친 성공은 일반 `recovered` 로그를 남기지 않습니다. 실제 reportable failure 뒤 성공한 경우에만 `recovered on attempt ...`를 기록합니다.
- 필요 시: 숨김 startup retry까지 확인하려면 `AI_USAGE_DEBUG_LOGS=1`로 서버를 시작하고 `startup redraw only` 로그를 봅니다.

## 수정 후 검증

- [ ] `pnpm check`
- [ ] 필요 시 `pnpm lint`
- [ ] `scripts/start-server.ps1`로 preview server 재시작
- [ ] same-origin `POST /api/usage/refresh`
- [ ] `GET /api/usage`
- [ ] `data/raw/{provider}-latest.parsed.json`에서 latest attempt 확인
- [ ] `data/usage-latest.json`에서 화면에 들어갈 값 확인
