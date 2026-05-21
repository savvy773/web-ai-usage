# AI Usage Dashboard Architecture

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

## Refresh 모델

provider별 CLI 수집은 병렬로 실행됩니다.

| Provider   | Command                | Slash command |
| ---------- | ---------------------- | ------------- |
| Claude     | `claude`               | `/usage`      |
| Codex      | `codex`                | `/status`     |
| Gemini CLI | `gemini --skip-trust`  | `/model`      |

전체 refresh 시간은 세 provider 시간의 합이 아니라 가장 느린 provider에 의해 결정됩니다.

현재 주요 설정:

| 항목                      | 값              |
| ------------------------- | --------------- |
| CLI working directory     | `D:\Code\_temp` |
| shell                     | `pwsh.exe`      |
| capture timeout           | 45초, Gemini 90초 |
| history bucket interval   | 10분            |
| prefetch lead time        | 30초 전         |
| quick refresh wait        | 2초             |
| frontend polling interval | 1.5초           |
| frontend polling attempts | 24회            |
| manual refresh cooldown   | 10초            |

## CLI 실행 방식

기본 실행 경로는 `node-pty`입니다.

1. `pwsh.exe -NoLogo -NoProfile` 가상 터미널을 엽니다.
2. provider command를 입력합니다.
3. CLI ready prompt를 기다립니다.
4. slash command를 입력합니다.
5. usage 출력이 안정될 때까지 짧게 대기합니다.
6. 출력 text를 parser에 넘깁니다.

`node-pty` 실행이 실패하면 일반 child process pipe 방식으로 fallback합니다.

Gemini CLI에는 `--skip-trust`와 `GEMINI_CLI_TRUST_WORKSPACE=true`를 함께 전달합니다. 대시보드의 숨은 `node-pty` 세션에서는 Gemini ready prompt가 늦게 뜰 수 있어 `/model` 입력을 ready 감지와 별도로 예약합니다.

Claude/Codex는 기본 command를 유지합니다. Claude의 `--permission-mode bypassPermissions`, Codex의 `--ask-for-approval never`/`--sandbox` 계열 옵션은 workspace trust skip이 아니라 권한/승인 정책 변경이며, usage 조회 수집에서 속도 이득이 없거나 Codex `/status` 수집을 깨뜨릴 수 있습니다.

## UI 동작

화면은 provider card 중심입니다.

- Claude/Codex: current, week usage window 표시
- Gemini CLI: Flash, Flash Lite, Pro 모델별 사용률 표시
- 각 usage bar에는 80% 기준선이 표시됩니다.
- Week usage에는 Pace 카드가 표시됩니다.
- Pace 카드는 현재 week 사용률을 fill bar로 표시하고 목표 pace를 vertical threshold marker line으로 표시합니다.
- reset 시간은 남은 day/hour/minute 단위로 분리해 보여줍니다.
- provider 우측 상단에는 상태와 수집 소요 시간이 표시됩니다.

상단 control:

- Auto: `nextRefreshAt` 기준 자동 refresh
- Refresh: 수동 refresh, 10초 cooldown
- Stop: 현재 서버 종료 API 호출

하단 logs:

- 서버 console 로그를 SSE로 받아 표시합니다.
- 최대 500개 client-side entry를 유지합니다.
- auto scroll toggle과 clear 버튼을 제공합니다.

## Cache와 History

서버 캐시:

- 파일: `data/usage-history.json`
- bucket 단위: 10분
- 보관: 최근 12개 bucket, 최소 5개 이상
- 같은 bucket 안에서 다시 수집하면 기존 bucket을 갱신합니다.
- 파일 쓰기는 임시 파일 작성 후 rename하는 방식으로 처리합니다.

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

`docs/index.html`은 Markdown renderer 없이 브라우저에서 바로 열 수 있는 개요 문서입니다. Git 저장소에서 문서 미리보기나 GitHub Pages 같은 정적 문서 entry로 사용할 수 있습니다.
