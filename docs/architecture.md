# AI Usage Dashboard Architecture

`D:\Code\_toolkit\aI_usage`

`D:\Code\_toolkit\aI_usage\scripts\start-server.ps1`
`http://127.0.0.1:5173/`

## 목적

AI Usage Dashboard는 로컬 CLI 사용량을 빠르게 확인하기 위한 SvelteKit 앱입니다.

핵심 설계는 read path와 refresh path를 분리하는 것입니다. 화면은 저장된 JSON을 빠르게 읽고, 오래 걸리는 CLI 수집은 서버 백그라운드 작업으로 처리합니다.

## 구성

| 영역                 | 파일                                      | 역할                                                 |
| -------------------- | ----------------------------------------- | ---------------------------------------------------- |
| 화면                 | `src/routes/+page.svelte`                 | dashboard UI, refresh, cache, logs, stop server      |
| usage read API       | `src/routes/api/usage/+server.ts`         | 저장된 usage payload 반환, prefetch 예약             |
| usage refresh API    | `src/routes/api/usage/refresh/+server.ts` | 새 CLI 수집 트리거                                   |
| server logs API      | `src/routes/api/server/logs/+server.ts`   | SSE로 서버 로그 전송                                 |
| server stop API      | `src/routes/api/server/stop/+server.ts`   | 현재 Node 프로세스 종료                              |
| refresh manager      | `src/lib/server/usage/refresh-manager.ts` | 중복 refresh 방지, quick response, prefetch          |
| collector            | `src/lib/server/usage/collector.ts`       | `node-pty` 기반 CLI 실행, child process fallback     |
| parser               | `src/lib/server/usage/parser.ts`          | CLI 출력 파싱                                        |
| storage              | `src/lib/server/usage/storage.ts`         | JSON history 읽기/쓰기, bucket 관리                  |
| shared config/types  | `src/lib/usage.ts`                        | provider 설정, payload 타입, CLI collection config   |
| console log capture  | `src/hooks.server.ts`                     | console 로그를 in-memory buffer로 복사               |
| server runner script | `scripts/start-server.ps1`                | dev/preview 서버 실행, 상태 파일, 안전한 재시작 처리 |

## 데이터 흐름

1. 브라우저가 `GET /api/usage`를 호출합니다.
2. 서버가 `data/usage-history.json`을 읽어 `UsagePayload`를 반환합니다.
3. 화면은 payload를 렌더링하고 같은 데이터를 `localStorage`에도 저장합니다.
4. 최초 진입, 자동 refresh, 수동 refresh 시 `POST /api/usage/refresh`를 호출합니다.
5. refresh manager가 이미 진행 중인 refresh가 있으면 같은 작업을 재사용합니다.
6. CLI 수집이 빠르게 끝나면 refresh API는 `200`과 최신 payload를 반환합니다.
7. 수집이 오래 걸리면 `202`와 기존 cached payload를 먼저 반환합니다.
8. 브라우저는 refresh가 끝날 때까지 `GET /api/usage`를 polling합니다.

복구 관점에서 가장 중요한 흐름은 다음 순서입니다.

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

브라우저는 CLI를 직접 실행하지 않습니다. 브라우저는 서버가 만든 JSON만 읽고, CLI 실행 권한과 파싱 책임은 모두 SvelteKit 서버 쪽에 있습니다.

## 사람이 보는 CLI 화면과 파싱 목표

파서는 사람이 터미널에서 눈으로 확인하는 usage 화면을 text로 재구성하는 역할을 합니다. 그래프 bar 자체는 신뢰하지 않고, bar 앞뒤에 있는 label, percent, reset 문구만 신뢰합니다.

### Gemini `/model`

사람이 보는 화면은 `Model usage` 섹션 아래에 모델별 row가 표시됩니다.

```text
Model usage

Flash       ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬  0%   Resets: 1:47 PM (22h 12m)
Flash Lite  ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬  0%   Resets: 1:47 PM (22h 12m)
Pro         ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬  7%   Resets: 7:26 AM (15h 51m)
gemini-3.1-…▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬  0%   Resets: 1:47 PM (22h 12m)
```

파싱 목표:

- `label`: `Flash`, `Flash Lite`, `Pro`, `gemini-*`
- `percent`: row의 `%` 숫자
- `resetAt`: `Resets:` 뒤의 시간 문자열을 가능한 ISO timestamp로 변환
- `remainingText`: 괄호 안의 남은 시간, 예: `22h 12m`

Gemini TUI는 같은 화면을 여러 번 redraw합니다. 따라서 첫 `Model usage`가 아니라 `%` 값이 들어 있는 마지막 `Model usage` 섹션을 사용해야 합니다.

### Codex `/status`

사람이 보는 화면은 보통 bracket bar와 `left` 표현을 포함합니다.

```text
5h limit:     [██████████████████░░] 92% left (resets 18:27)
Weekly limit: [████████████████░░░░] 82% left (resets 19:42 on 27 May)
```

파싱 목표:

- `fiveHour.percent`: `5h limit` row에서 dashboard 기준 used percent
- `week.percent`: `Weekly limit` row에서 dashboard 기준 used percent
- `resetAt`: `resets` 뒤 시간
- `remainingText`: 원래 reset 표현

중요: Codex의 `left`는 남은 양입니다. Dashboard는 모든 provider를 used percent로 표시하므로 `92% left`는 `8% used`로 변환합니다.

### Claude `/usage`

사람이 보는 화면은 session/week 블록으로 나뉩니다.

```text
Current session
█████▌                                             11% used
Resets 4:30pm (Asia/Seoul)

Current week (all models)
██████▌                                            13% used
Resets May 28, 1pm (Asia/Seoul)
```

파싱 목표:

- `fiveHour.percent`: `Current session` 근처의 `% used`
- `week.percent`: `Current week` 근처의 `% used`
- `resetAt`: `Resets` 뒤 시간. `Asia/Seoul` 외 timezone이면 잘못된 시간으로 변환하지 않도록 무시합니다.

## Refresh 모델

provider별 CLI 수집은 순차로 실행됩니다. 각 provider는 실패 시 최대 3회 재시도하며, 실패한 provider가 있어도 다음 provider 수집은 계속 진행합니다.

| Provider   | Command               | Slash command |
| ---------- | --------------------- | ------------- |
| Claude     | `claude`              | `/usage`      |
| Codex      | `codex`               | `/status`     |
| Gemini CLI | `gemini --skip-trust` | `/model`      |

전체 refresh 시간은 provider별 수집 시간의 합에 가깝습니다. refresh API는 quick wait 안에 끝나지 않으면 `202`와 기존 payload를 먼저 반환하고, 실제 수집은 백그라운드에서 계속 진행합니다.

현재 주요 설정:

| 항목                      | 값                             |
| ------------------------- | ------------------------------ |
| CLI working directory     | `D:\Code\_temp`                |
| shell                     | `pwsh.exe`                     |
| capture timeout           | 45초, Codex 60초, Gemini 105초 |
| history bucket interval   | 10분                           |
| prefetch lead time        | 30초 전                        |
| quick refresh wait        | 2초                            |
| frontend polling interval | 1.5초                          |
| frontend polling attempts | 24회                           |
| manual refresh cooldown   | 10초                           |

## CLI 실행 방식

기본 실행 경로는 `node-pty`입니다.

1. `pwsh.exe -NoLogo -NoProfile` 가상 터미널을 엽니다.
2. provider command를 입력합니다.
3. CLI ready prompt를 기다립니다.
4. slash command를 입력합니다.
5. usage 출력이 안정될 때까지 짧게 대기합니다.
6. 출력 text를 parser에 넘깁니다.

`node-pty` 실행 세부 조건:

- terminal name: `xterm-256color`
- cols: 기본 120, Gemini는 160. Gemini는 오른쪽 `Resets:` 텍스트가 길어 좁은 폭에서 row가 깨질 수 있기 때문입니다.
- rows: 36
- cwd: `CLI_COLLECTION_CONFIG.workingDirectory`
- env: process env에 `CLI_COLLECTION_CONFIG.env` 병합
- Windows에서는 `useConptyDll: true`
- capture buffer는 tail 20,000 chars만 유지합니다. TUI redraw가 많기 때문에 전체 로그보다 마지막 완성 화면을 보존하는 것이 중요합니다.

ready 감지:

- PowerShell ready: tail이 `PS D:\...\>` 형태이면 provider command를 입력합니다.
- Claude ready: `? for shortcuts`, `Advisor Tool`, `Try "..."`, `Welcome back` 중 하나가 보이면 `/usage` 입력 준비로 봅니다.
- Codex ready: `Use /skills` 또는 `gpt-* · D:\...` prompt가 보이면 `/status` 입력 준비로 봅니다. `Booting MCP server`가 tail에 남아 있어도 그 뒤에 더 최신 `gpt-* · D:\...` prompt가 있으면 준비 완료로 봅니다.
- Gemini ready: `Type your message` 또는 `workspace (/directory)`가 보이면 `/model` 입력 준비로 봅니다.

입력 타이밍:

- shell command는 shell 시작 후 500ms fallback timer로도 입력합니다.
- slash command는 provider ready 감지 후 350ms 뒤 입력합니다.
- Claude는 기본 command delay 6초를 사용합니다.
- Codex와 Gemini는 최소 10초 뒤 slash command fallback 입력을 예약합니다. ready 감지가 느리거나 prompt 문자열이 바뀌어도 수집을 시도하기 위한 장치입니다. Codex는 fallback 시점에도 `Booting MCP server` 또는 `model: loading`만 보이면 `/status` 입력을 1초씩 늦춥니다.
- Codex는 `/status` 입력 후 400ms 뒤 Enter를 한 번 더 보내 command 선택/확정을 보완합니다.
- Gemini는 `/model`이 prompt에 남아 있고 `Select Model`/`Model usage` 화면이 아직 안 보이면 Enter를 반복 확인합니다. 첫 확인은 800ms 뒤이고, 이후 2초 간격으로 Gemini capture timeout 10초 전까지 계속합니다. 첫 startup/auth redraw가 길 때 `/model`이 입력줄에 남은 채 멈추는 케이스를 줄이기 위한 처리입니다.

완료 판단:

- Codex: `fiveHour.percent`와 `week.percent`가 모두 파싱되면 usage 출력으로 인정합니다.
- Claude: `fiveHour/week` percent와 reset text가 모두 파싱되면 usage 출력으로 인정합니다. percent만 먼저 들어온 redraw를 너무 일찍 저장하면 Reset이 `Unknown`으로 보일 수 있기 때문입니다.
- Gemini: reset/remaining이 있는 모델 row가 3개 이상이면 인정합니다. 또는 `Model usage`/`Select Model` 화면이 보이고 모델 row가 3개 이상 파싱되면 인정합니다.
- output이 감지된 뒤 바로 끝내지 않고 settle delay를 둡니다. 기본 1.2초, Gemini는 3초입니다.

`node-pty` 실행이 실패하면 일반 child process pipe 방식으로 fallback합니다.

Gemini CLI에는 `--skip-trust`와 `GEMINI_CLI_TRUST_WORKSPACE=true`를 함께 전달합니다. 대시보드의 숨은 `node-pty` 세션에서는 Gemini ready prompt가 늦게 뜰 수 있어 `/model` 입력을 ready 감지와 별도로 예약합니다.

Claude/Codex는 기본 command를 유지합니다. Claude의 `--permission-mode bypassPermissions`, Codex의 `--ask-for-approval never`/`--sandbox` 계열 옵션은 workspace trust skip이 아니라 권한/승인 정책 변경이며, usage 조회 수집에서 속도 이득이 없거나 Codex `/status` 수집을 깨뜨릴 수 있습니다.

## Parser 정규화

CLI 출력은 TUI redraw와 그래프 문자 때문에 화면에서 보이는 형태와 raw text가 다를 수 있습니다. parser는 먼저 터미널 출력을 안전한 text로 정규화한 뒤 provider별 값을 추출합니다.

- ANSI escape, OSC sequence, 단일 ESC command, control code를 제거합니다.
- Cursor movement sequence는 삭제하지 않고 공백으로 바꿉니다. `Get-Content`가 화면에 렌더링해 보여주는 간격에 가깝게 raw text를 복구하기 위한 처리입니다.
- 복사/로그 표시 과정에서 ESC byte만 빠진 CSI 조각도 제거합니다. 예: `[38;2;...m`, `[39;49m`, `[K`, `[3G`.
- `\r\n`은 줄바꿈으로 유지하고, 단독 `\r`은 공백으로 바꿉니다. Gemini처럼 같은 줄 우측을 다시 그리는 TUI 출력이 `0%` 줄과 `Resets:` 줄로 쪼개지는 문제를 피하기 위한 처리입니다.
- box 문자, bracket, block/bar 그래프 문자는 공백으로 치환합니다. 이 정규식은 `parser.ts`의 `BOX_DECORATION_PATTERN`, `BAR_DECORATION_PATTERN`에서 관리하며 collector marker 판별도 같은 상수를 재사용합니다.
- Codex의 `92% left` 같은 남은 사용량 표현은 dashboard 공통 기준인 used percent로 변환합니다.
- Claude redraw에서 cursor movement가 글자 사이에 끼면 `Current session`이 `Curre t session`, `Resets`가 `Rese s`처럼 남을 수 있어 current/reset 매칭은 이 흔한 손상 형태를 허용합니다.

정규화 순서:

1. `stripTerminalOutput(raw)`로 OSC, ANSI, orphaned CSI, terminal escape, control code 제거
2. `\r\n`을 `\n`으로 유지
3. 단독 `\r`을 공백으로 변환
4. provider별 line normalize 적용
5. box/bar/bracket 문자를 공백으로 변환
6. 공백을 하나로 축약하고 trim

단독 `\r`을 줄바꿈으로 바꾸면 Gemini row가 사람이 보는 한 줄과 다르게 쪼개집니다. 예를 들어 화면상 `Flash ... 0% Resets: ...`가 raw text에서는 `Flash ... 0%\r Resets: ...`처럼 올 수 있습니다. 이 경우 `\r`은 줄바꿈이 아니라 같은 줄 redraw의 흔적으로 보고 공백 처리해야 합니다.

공통 percent 규칙:

- 기본 `%`는 used percent로 봅니다.
- 같은 line에 `left`, `remaining`, `available`이 있고 `used`가 없으면 `100 - value`로 used percent를 계산합니다.
- percent는 `0..100`으로 clamp하고 소수 1자리까지 반올림합니다.

Gemini는 `/model` 화면이 여러 번 redraw될 수 있으므로, 처음 발견된 `Model usage` 섹션이 아니라 퍼센트 값이 들어 있는 마지막 렌더링 섹션을 우선 사용합니다. 모델 row가 그래프 문자나 carriage return 때문에 깨져도 `Flash`, `Flash Lite`, `Pro`, `gemini-*` 모델명 뒤의 다음 퍼센트 값을 fallback으로 매칭합니다. 단, 최종 label은 이 네 가지 형태만 인정하고 `37% used`, `left`, `limit`, `quota`처럼 하단 상태줄/잔여량 문맥에 붙은 percent는 Gemini model usage로 쓰지 않습니다.

Claude와 Codex의 current/week section도 최신 redraw를 우선하기 위해 뒤에서부터 section 시작점을 찾습니다.

파싱 결과는 `ProviderUsage` 객체로 정규화됩니다. Claude/Codex는 `windows.fiveHour`, `windows.week`에 percent/reset 정보를 넣고, Gemini는 `modelUsages`에 모델별 percent/reset 정보를 넣습니다. 이 데이터가 `data/usage-history.json`에 저장되고 `/api/usage` JSON으로 전달되어 Svelte 화면에 렌더링됩니다.

### Provider별 parser 알고리즘

#### Claude/Codex 공통 window parser

1. raw output을 정규화하고 line 배열로 분리합니다.
2. `fiveHour`와 `week` window를 각각 파싱합니다.
3. Codex는 먼저 특수 row를 찾습니다.
   - `5h limit:`가 있으면 `fiveHour`
   - `Weekly limit:` 또는 `Week limit:`가 있으면 `week`
   - 이 검색은 뒤에서 앞으로 수행해 최신 redraw를 우선합니다.
4. Codex 특수 row가 없으면 section parser로 fallback합니다.
   - `fiveHour`: `Current session`, `5h`, `5 hour`, `five hour`
   - `week`: `Current week`, `week`, `weekly`, `7d`, `7 day`
5. section 시작점은 뒤에서 앞으로 찾습니다.
6. section은 시작점부터 최대 8줄을 읽고, 반대 section이 나오면 멈춥니다.
7. section 안에서 순서대로 percent, ratio, remaining text, reset time을 채웁니다.
8. ratio가 `used / limit` 또는 `used of limit` 형태로 있으면 `used`, `limit`, `percent`를 계산합니다.

#### Gemini model parser

Gemini는 row가 TUI redraw로 깨지는 경우가 많아서 여러 parser를 합친 뒤 label별로 merge합니다.

1. 마지막 완성 `Model usage` section을 찾습니다.
   - `Model usage`부터 `(Press Esc to close)`, 하단 border, 또는 output 끝까지를 section 후보로 봅니다.
   - 후보가 여러 개면 `%`가 있는 마지막 후보를 선택합니다.
2. bar row parser가 모델 row 3개 이상을 회수하면 우선 사용합니다.
3. 부족하면 fallback 후보 line을 만듭니다.
   - 정규화된 line 배열
   - raw output에서 `│┃║`를 줄바꿈으로 바꾼 line
   - raw output 전체를 한 줄로 붙인 line
4. 다음 parser들을 실행합니다.
   - bar row parser: bar가 포함된 row를 결합하고 label/percent/reset을 파싱
   - known model scan: `Flash Lite|Flash|Pro|gemini-*` 뒤쪽 span에서 첫 `%`와 `Resets:`를 찾음
   - split/direct-line parser: 한 line 안의 label + percent를 파싱하거나 label-only line 다음 percent line을 결합
   - ordered fallback: 최신 화면의 마지막 모델 label들과 마지막 percent들을 순서대로 결합
5. label을 clean합니다.
   - leading prompt/bullet 제거
   - percent 이후 text 제거
   - `Resets:` 이후 text 제거
   - `Flash`, `Flash Lite`, `Pro`, `gemini-*` 외 label은 저장하지 않음
   - model screen 안내 문구, prompt, status row는 label로 인정하지 않음
6. label별로 merge합니다.
   - 같은 label이 여러 번 나오면 resetAt이 있는 결과를 우선합니다.
   - resetAt이 같으면 remainingText가 있는 결과를 우선합니다.
7. 최종적으로 model usage label이 3개 이상이면 Gemini provider는 `ok`가 될 수 있습니다.

중복 fallback과 임의 label 생성은 피합니다. 모델명이 없는 `% Resets:` row는 `Gemini model 1` 같은 가짜 label로 저장하지 않고, known model scan이나 split-line parser가 실제 label과 결합할 때만 사용합니다.

### Reset 시간 파싱

지원하는 reset text:

- time only: `4:30pm`, `4:30 PM`, `18:27`
- month date time: `May 28, 1pm`
- Codex date: `19:42 on 27 May`
- timezone suffix: `(Asia/Seoul)`은 허용, 다른 timezone은 오해를 피하기 위해 ISO 변환하지 않음

time only 값이 현재 시각보다 과거면 다음 날로 계산합니다. month/date 값이 현재 시각보다 과거면 다음 해로 계산합니다.

### Status와 message

Provider status 판단:

- `ok`: usage 값이 파싱됨
- `partial`: CLI output은 있지만 usage 값이 충분히 없음
- `unavailable`: CLI output이 없거나 command/auth/permission 문제로 보임

message 규칙:

- error message가 있으면 그대로 사용
- usage가 있으면 `Usage data parsed from CLI output.`
- output은 있으나 usage가 없으면 `CLI responded, but usage values were not found.`
- output이 없으면 `CLI returned no output.`

## UI 동작

화면은 provider card 중심입니다.

- Claude/Codex: current, week usage window 표시
- Gemini CLI: Flash, Flash Lite, Pro 모델별 사용률 표시
- 각 usage bar에는 80% 기준선이 표시됩니다.
- Week usage에는 Pace 카드가 표시됩니다.
- Pace 카드는 현재 week 사용률을 fill bar로 표시하고 목표 pace를 vertical threshold marker line으로 표시합니다. 목표 marker는 주 초반에도 최소 20%에서 시작합니다. 살짝 앞서는 사용량은 독려 성격으로 `On pace` 또는 부드러운 pastel green을 유지하고, 크게 앞설 때는 pastel yellow, 과도하게 앞설 때만 pastel rose warning을 표시합니다.
- reset 시간은 남은 day/hour/minute 단위로 분리해 보여줍니다.
- provider 우측 상단에는 상태와 수집 소요 시간이 표시됩니다.

렌더링 규칙:

- percent text: `null`이면 `Unknown`, 정수면 `24%`, 소수면 `24.5%`
- usage bar width: percent를 `0..100`으로 clamp한 뒤 width `%`로 사용
- usage bar color: `heatColor(percent)`로 결정
  - `null`: slate
  - `>= 90`: red
  - `>= 80`: orange
  - `>= 60`: amber
  - `>= 35`: green
  - 그 외: cyan
- Claude/Codex window card는 `windows.fiveHour`, `windows.week`를 렌더링합니다.
- Gemini model card는 `modelUsages[]`를 렌더링합니다. Gemini는 `fiveHour/week` window를 사용하지 않습니다.
- reset countdown은 `resetAt`이 있으면 현재 시각과의 차이를 계산합니다. `resetAt`이 없으면 `remainingText`를 그대로 표시합니다.
- provider status badge는 `ok -> Live`, `partial -> Partial`, `unavailable -> Unavailable`로 표시합니다.

Pace card:

- `windows.week`에 percent와 resetAt이 모두 있을 때만 표시합니다.
- week reset까지 남은 시간을 기준으로 목표 target percent를 계산합니다.
- target table:

| week reset까지 남은 시간 | target |
| ------------------------ | ------ |
| 6일 초과                 | 10%    |
| 5일 초과                 | 20%    |
| 4일 초과                 | 35%    |
| 3일 초과                 | 50%    |
| 2일 초과                 | 65%    |
| 1일 초과                 | 80%    |
| 0.5일 초과               | 90%    |
| 그 외                    | 95%    |

- `diff = week.percent - target`
- `diff >= 35`: `Very high pace`, pastel rose
- `diff >= 24`: `High pace`, pastel yellow
- `diff >= 14`: `Ahead`, pastel green
- `diff <= -25`: `Plenty left`, cyan
- `diff <= -10`: `Room to use`, sky
- `diff <= -4`: `Slightly under`, teal
- 그 외: `On pace`, emerald

상단 control:

- Auto: `nextRefreshAt` 기준 자동 refresh
- Refresh: 수동 refresh, 10초 cooldown
- Stop: 현재 서버 종료 API 호출

하단 logs:

- 서버 console 로그를 SSE로 받아 표시합니다.
- 최대 500개 client-side entry를 유지합니다.
- auto scroll toggle과 clear 버튼을 제공합니다.

## Cache와 History

운영 중 확인할 파일:

- `data/usage-history.json`: usage history의 영구 저장 파일입니다. dashboard가 실제로 읽고 쓰는 핵심 JSON입니다.
- `data/usage-latest.json`: 화면/API payload 형태를 그대로 저장하되 `history`는 최근 6개 bucket만 포함합니다. UI에 뿌려지는 데이터 확인용 파일입니다.
- `data/raw/{provider}-latest.txt`: provider별 마지막 CLI raw output tail입니다. 파싱 오류가 나면 이 파일에서 실제 TUI 출력이 어떻게 들어왔는지 먼저 확인합니다.
- `data/raw/{provider}-latest.parsed.json`: raw tail과 함께 저장되는 provider별 파싱 결과 snapshot입니다. `status`, `message`, `windows`, `modelUsages`, `rawOutputChars`를 확인합니다.
- `data/logs/server.log`: 서버 console log 전체를 append합니다.
- `data/logs/server-error.log`: `warn`/`error` level만 append합니다.
- `data/logs/collector.log`: `[collector]` prefix가 붙은 CLI 수집/파싱 진단 로그만 append합니다.
- `data/logs/server-process.log`: `start-server.ps1`로 시작한 Node/Vite process stdout입니다.
- `data/logs/server-startup-error.log`: `start-server.ps1`로 시작한 Node/Vite process stderr입니다. 서버 구동 중 낮은 레벨 오류를 확인할 때 봅니다.
- `.server/ai-usage-dashboard.json`: `scripts/start-server.ps1`이 관리하는 실행 상태 파일입니다. port, host, mode, root PID, process creation date를 저장해 재시작 시 같은 dashboard 서버인지 확인합니다.
- 화면 하단 Logs 패널: `src/hooks.server.ts`가 `console.log/info/warn/error`를 가로채 현재 Node 프로세스의 in-memory buffer에도 복사합니다. `GET /api/server/logs` SSE가 이 buffer를 읽습니다. 프로세스를 재시작하면 화면용 buffer는 사라지지만 `data/logs/*.log` 파일은 남습니다.

`data/usage-history.json`:

- bucket 단위: 10분
- 보관: 최근 12개 bucket, 최소 5개 이상
- 같은 bucket 안에서 다시 수집하면 기존 bucket을 갱신합니다.
- 파일 쓰기는 `data/usage-history.<pid>.<timestamp>.tmp` 임시 파일 작성 후 `usage-history.json`으로 rename하는 방식으로 처리합니다.
- 기능 동작 확인은 이 파일의 최신 `history[]` bucket을 보면 됩니다.

`data/usage-latest.json`:

- `/api/usage`가 반환하는 `UsagePayload`와 같은 형태입니다.
- `providers[]`는 화면 상단 카드가 쓰는 최신 provider 데이터입니다.
- `history[]`는 관리 편의를 위해 최근 6개 bucket만 포함합니다.
- refresh가 성공해 `recordUsageSnapshot`이 실행될 때 함께 갱신됩니다.

`data/raw/`:

- 각 collector attempt 뒤에 `{provider}-latest.txt`와 `{provider}-latest.parsed.json`을 덮어씁니다.
- `*-latest.txt`는 terminal escape가 제거되지 않은 raw tail입니다. TUI redraw, `\r`, box/bar 문자가 실제로 어떻게 들어왔는지 확인할 때 씁니다.
- `*-latest.parsed.json`은 같은 attempt에서 parser가 만든 결과입니다. raw와 파싱 결과를 나란히 비교할 수 있습니다.
- raw 파일은 민감할 수 있으므로 Git에 올리지 않습니다.

저장 시 주의점:

- `rawPreview`는 history 파일에 저장하지 않습니다. raw terminal output은 크고 민감할 수 있으므로 provider snapshot 저장 시 `null`로 compact합니다.
- 새 refresh에서 provider가 `ok`가 아니어도, 이전 history에 usable data가 있으면 이전 값을 유지합니다.
- 이때 status/message는 최신 실패 상태를 반영하되, 실제 usage 값은 마지막 usable snapshot을 사용합니다.
- usable data 기준은 modelUsages가 있거나, fiveHour/week에 percent 또는 used 값이 있는 경우입니다.
- provider가 `ok`여도 특정 window의 reset만 누락되면, 이전 snapshot의 future resetAt을 재사용합니다. Claude처럼 redraw 중 percent가 reset보다 먼저 들어오는 경우 Reset `Unknown` 표시를 줄이기 위한 보정입니다.

저장 JSON의 형태:

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
						{
							"label": "Flash",
							"percent": 0,
							"resetAt": "2026-05-23T13:47:00.000Z",
							"remainingText": "22h 12m"
						},
						{
							"label": "Flash Lite",
							"percent": 0,
							"resetAt": "2026-05-23T13:47:00.000Z",
							"remainingText": "22h 12m"
						},
						{
							"label": "Pro",
							"percent": 7,
							"resetAt": "2026-05-23T07:26:00.000Z",
							"remainingText": "15h 51m"
						}
					]
				}
			}
		}
	]
}
```

JSON 확인 포인트:

- 최상위는 `{ "history": [...] }`입니다.
- 최신 bucket은 보통 `history` 배열의 마지막 항목입니다.
- 각 bucket의 `providers.claude`, `providers.codex`, `providers.gemini`가 수집 결과입니다.
- Claude/Codex는 `windows.fiveHour`, `windows.week`의 `percent`, `resetAt`, `remainingText`를 봅니다.
- Gemini는 `modelUsages[]`의 `label`, `percent`, `resetAt`, `remainingText`를 봅니다.
- `status`가 `partial` 또는 `unavailable`인데 값이 남아 있으면, 최신 refresh는 실패했지만 storage가 마지막 usable snapshot을 유지한 상태입니다. 이 경우 `message`에 최신 실패 이유가 들어갑니다.

브라우저 캐시:

- key: `ai-usage-payload-cache`
- 최초 진입 시 cached payload가 있으면 먼저 렌더링합니다.
- `/api/usage` 실패 시 마지막 cached payload를 유지합니다.

## API Contract

### `GET /api/usage`

저장된 usage payload를 반환합니다.

주요 필드:

- `generatedAt`: API 응답 생성 시각
- `nextRefreshAt`: 다음 refresh 목표 시각
- `providers`: 최신 provider별 usage 배열
- `history`: 최근 usage bucket 목록
- `refreshState`: 현재 백그라운드 refresh 상태

`providers[]`의 runtime shape:

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

새 usage 수집을 요청합니다.

응답:

- `200`: 새 수집이 quick wait 안에 완료됨
- `202`: 수집이 계속 진행 중이며 기존 cached payload를 먼저 반환함

### `GET /api/server/logs`

SSE stream을 반환합니다.

event payload:

- `init`: 현재 log buffer 전체
- `entry`: 새 log entry 1개

### `POST /api/server/stop`

현재 서버 프로세스를 약간의 지연 후 종료합니다.

## 실패 처리

- provider 하나가 실패해도 전체 dashboard는 계속 렌더링됩니다.
- 실패한 provider는 `partial` 또는 `unavailable` 상태로 표시됩니다.
- refresh API는 장시간 수집 때문에 브라우저 요청이 막히지 않도록 cached payload를 먼저 반환할 수 있습니다.
- parser가 값을 찾지 못하면 provider message에 원인을 담습니다.
- 프론트엔드는 서버 요청 실패 시 `localStorage` cache를 fallback으로 사용합니다.

collector 로그의 marker 의미:

- Gemini `markers=model-screen,model-name,bar-row,percent,reset-word,percent-reset`: usage 화면, 모델명, bar row, percent, reset text가 모두 보입니다. 이 상태에서 실패하면 parser row 결합이나 label 정규화 문제를 먼저 봅니다.
- Gemini `markers=slash-buffer,quota-percent`: `/model`이 입력줄에 남아 있고 하단 quota percent만 보이는 상태입니다. 모델 usage 화면이 아직 열리지 않은 수집 타이밍 문제를 먼저 봅니다.
- Gemini `markers=model-name,bar-row,percent`: 모델 usage row의 모델명과 bar/percent는 보이지만 reset text가 같은 row로 복구되지 않았을 수 있습니다.
- Gemini `markers=model-name,percent`: section 경계가 깨졌거나 redraw 중간일 가능성이 큽니다. 이 경우 `\r` 처리, bar row parser, 마지막 redraw 선택 로직이 핵심입니다.
- Gemini `parsed-models=1/3`: parser가 인정한 모델 row 수입니다. Gemini provider는 모델 usage가 3개 이상이어야 `ok`가 될 수 있습니다.
- Gemini `parsed-labels=Flash|Flash Lite|Pro`: parser가 회수한 모델 label 목록입니다.
- Gemini `parse-failure=missing ...`: 실패 원인 후보입니다. 예를 들어 `missing percent-reset-same-row,3 model rows`는 percent/reset 조합이 완성되지 않았거나 모델 row가 3개 미만이라는 뜻입니다.
- Codex `markers=5h-limit,week-limit`: 두 limit row가 모두 보입니다. 두 row에서 percent가 파싱되어야 `ok`입니다.
- Claude `markers=usage-word,percent`: usage 관련 문구와 percent는 보입니다. current/week section 매칭을 확인해야 합니다.

복구 시 우선순위:

1. `stripTerminalOutput`의 `\r` 처리와 escape/orphaned CSI 제거를 먼저 복구합니다.
2. Gemini의 마지막 `Model usage` redraw 선택을 복구합니다.
3. Codex `left -> used` 변환을 복구합니다.
4. `ProviderUsage` JSON shape를 복구합니다.
5. storage의 이전 usable snapshot 유지 로직을 복구합니다.
6. UI는 JSON shape만 맞으면 비교적 쉽게 복구할 수 있습니다.

## 개발과 운영

개발 서버:

```powershell
pnpm dev
```

검사:

```powershell
pnpm check
pnpm build
```

권장 실행 스크립트:

```powershell
.\scripts\start-server.ps1
```

상태 확인:

```powershell
.\scripts\start-server.ps1 -Status
```

도움말:

```powershell
.\scripts\start-server.ps1 -Help
```

`start-server.ps1`은 `.server/ai-usage-dashboard.json`에 서버 상태를 저장합니다. 재실행 시 이 상태 파일과 process command line을 확인해 이 프로젝트에서 시작한 dashboard 서버만 중지합니다. PID 재사용 오탐을 줄이기 위해 process creation date도 함께 저장합니다.

## 문서 배포 메모

`docs/ai_dash.html`은 Markdown renderer 없이 브라우저에서 바로 열 수 있는 개요 문서입니다. Git 저장소에서 문서 미리보기나 GitHub Pages 같은 정적 문서 entry로 사용할 수 있습니다.
