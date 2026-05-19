# AI Usage Dashboard Architecture

## Overview

AI Usage Dashboard는 로컬에서 실행되는 SvelteKit 기반 대시보드입니다.

브라우저는 직접 Claude, Codex, Gemini CLI를 실행하지 않습니다. 대신 SvelteKit 서버 API가 각 CLI를 실행해서 usage 정보를 수집하고, 결과를 `data/usage-history.json`에 JSON 스냅샷으로 저장합니다. 화면은 이 저장된 JSON을 먼저 읽고, 새 수집은 백그라운드에서 진행합니다.

## Main Components

| 영역                | 파일                                      | 역할                                                      |
| ------------------- | ----------------------------------------- | --------------------------------------------------------- |
| UI                  | `src/routes/+page.svelte`                 | 대시보드 화면, refresh 버튼, 자동 갱신, localStorage 캐시 |
| API: cached usage   | `src/routes/api/usage/+server.ts`         | 저장된 usage JSON 반환, prefetch 예약                     |
| API: refresh        | `src/routes/api/usage/refresh/+server.ts` | 새 usage 수집 요청 처리                                   |
| refresh manager     | `src/lib/server/usage/refresh-manager.ts` | 백그라운드 refresh, 중복 refresh 방지, 빠른 캐시 응답     |
| collector           | `src/lib/server/usage/collector.ts`       | Claude/Codex/Gemini CLI 실행                              |
| parser              | `src/lib/server/usage/parser.ts`          | CLI 출력에서 usage percent/reset 정보 파싱                |
| storage             | `src/lib/server/usage/storage.ts`         | `usage-history.json` 읽기/쓰기, history 보관              |
| shared types/config | `src/lib/usage.ts`                        | provider 정의, payload 타입, CLI 설정                     |

## Data Flow

1. 브라우저가 `GET /api/usage`를 호출합니다.
2. 서버는 `data/usage-history.json`을 읽어 `UsagePayload`를 반환합니다.
3. `refresh-manager`는 `nextRefreshAt` 기준으로 다음 prefetch를 예약합니다.
4. 화면은 받은 payload를 렌더링하고, 같은 JSON을 `localStorage`에도 저장합니다.
5. 수동 또는 자동 refresh 시 브라우저가 `POST /api/usage/refresh`를 호출합니다.
6. 서버는 이미 refresh 중이면 같은 작업을 재사용합니다.
7. 새 수집이 빠르게 끝나면 `200`과 최신 JSON을 반환합니다.
8. 새 수집이 오래 걸리면 `202`와 기존 캐시 JSON을 먼저 반환하고, 실제 수집은 백그라운드에서 계속합니다.
9. 브라우저는 `202` 또는 `refreshState.refreshing === true`를 받으면 `GET /api/usage`를 polling해서 완료된 JSON으로 교체합니다.

## Refresh Behavior

현재 refresh는 provider별 CLI 수집을 병렬로 실행합니다.

대상 provider:

| Provider   | Command  | Slash command |
| ---------- | -------- | ------------- |
| Claude     | `claude` | `/usage`      |
| Codex      | `codex`  | `/status`     |
| Gemini CLI | `gemini` | `/model`      |

전체 수집은 `Promise.all`로 병렬 실행됩니다. 따라서 전체 refresh 시간은 세 provider 시간의 합이 아니라, 가장 오래 걸리는 provider에 의해 결정됩니다.

현재 설정:

| 항목                      | 값              |
| ------------------------- | --------------- |
| CLI working directory     | `D:\Code\_temp` |
| capture timeout           | 45초            |
| refresh bucket interval   | 10분            |
| prefetch lead time        | 30초 전         |
| quick refresh wait        | 2초             |
| frontend polling interval | 1.5초           |
| frontend polling attempts | 24회            |

실측 기준:

| 동작                                | 시간    |
| ----------------------------------- | ------- |
| `POST /api/usage/refresh` 캐시 응답 | 약 2초  |
| 백그라운드 전체 수집 완료           | 약 18초 |

최근 provider별 실측:

| Provider   | 수집 시간 |
| ---------- | --------- |
| Gemini CLI | 약 17초   |
| Codex      | 약 12초   |
| Claude     | 약 8초    |

각 provider별 수집 시간은 `ProviderUsage.collectionDurationMs`에 저장됩니다. 화면의 provider 카드 우측 상단에도 초 단위로 표시됩니다.

## Caching Strategy

캐시는 두 단계입니다.

서버 캐시:

- `data/usage-history.json`에 usage history를 저장합니다.
- refresh 중에도 이 파일을 읽어서 빠르게 응답합니다.
- 파일 쓰기는 임시 파일 작성 후 rename하는 방식으로 처리합니다.

브라우저 캐시:

- `localStorage` key: `ai-usage-payload-cache`
- 최초 화면 진입 시 localStorage에 이전 payload가 있으면 먼저 렌더링합니다.
- `GET /api/usage`가 실패해도 마지막 캐시를 유지합니다.
- 네트워크/서버 refresh가 느려도 화면이 빈 상태로 떨어지는 것을 줄입니다.

## History Retention

요구사항은 최소 5세트 보관입니다.

현재 구현은 최근 12세트를 보관합니다.

관련 설정:

- `src/lib/server/usage/storage.ts`
- `MIN_BUCKETS = 5`
- `MAX_BUCKETS = 12`

bucket은 10분 단위입니다. 같은 10분 구간 안에서 여러 번 수집하면 기존 bucket을 업데이트하고, 새 10분 구간이면 새 bucket을 추가합니다.

## Failure Handling

CLI 수집 실패 또는 timeout이 발생해도 대시보드 전체가 바로 깨지지 않도록 구성되어 있습니다.

- provider 하나가 실패하면 해당 provider는 `unavailable` 또는 `partial` 상태가 됩니다.
- refresh API는 긴 수집을 기다리다 브라우저 fetch가 실패하지 않도록 기존 JSON을 먼저 반환합니다.
- 프론트는 실패 시 localStorage에 저장된 마지막 JSON을 사용합니다.
- `refreshState.error`에 refresh manager 수준의 에러 메시지를 담을 수 있습니다.

## API Contract

### `GET /api/usage`

저장된 usage payload를 반환합니다.

주요 필드:

- `generatedAt`: API 응답 생성 시각
- `nextRefreshAt`: 다음 refresh 목표 시각
- `providers`: 화면에 표시할 최신 provider별 usage
- `history`: 최근 usage bucket 목록
- `refreshState`: 현재 백그라운드 refresh 상태

각 provider에는 `collectionDurationMs`가 포함됩니다. 이 값은 해당 provider CLI를 시작해서 파싱 가능한 결과를 얻거나 timeout 처리될 때까지 걸린 시간입니다.

### `POST /api/usage/refresh`

새 usage 수집을 요청합니다.

응답:

- `200`: 새 수집이 빠르게 완료되어 최신 JSON 반환
- `202`: 수집이 계속 진행 중이며, 현재 저장된 캐시 JSON 반환

## Operational Notes

개발 서버 실행:

```powershell
.\scripts\start-server.ps1
```

서버 실행 도움말:

```powershell
.\scripts\start-server.ps1 -Help
```

서버 상태 확인:

```powershell
.\scripts\start-server.ps1 -Status
```

스크립트는 `.server/ai-usage-dashboard.json` 상태 파일과 프로세스 command line을 기준으로 이 프로젝트에서 띄운 기존 서버만 중지하고 재시작합니다. 주소는 기본적으로 `http://127.0.0.1:5173/`에 고정됩니다. PID 재사용 오탐을 줄이기 위해 상태 파일에는 프로세스 생성 시각도 저장합니다.

브라우저 접속:

```text
http://localhost:5173/
```

refresh API는 CLI를 실제로 실행하므로 일반 JSON 조회보다 훨씬 느립니다. 화면은 `GET /api/usage`를 빠른 read path로 사용하고, `POST /api/usage/refresh`는 background update trigger로 보는 구조입니다.
