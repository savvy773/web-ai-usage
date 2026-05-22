# AI Usage Dashboard

로컬 Claude, Codex, Gemini CLI 사용량을 한 화면에서 확인하는 SvelteKit 대시보드입니다.

브라우저가 CLI를 직접 실행하지 않습니다. SvelteKit 서버 API가 로컬 CLI를 가상 터미널로 실행해 사용량을 수집하고, 결과를 `data/usage-history.json`에 저장합니다. 화면은 저장된 JSON과 브라우저 캐시를 먼저 보여준 뒤 백그라운드 refresh 결과로 갱신됩니다.

## 주요 기능

- Claude `/usage`, Codex `/status`, Gemini CLI `/model` 수집
- provider별 상태, 수집 시간, reset countdown, 사용률 bar 표시
- Claude/Codex의 current, week usage 표시
- Gemini CLI의 Flash, Flash Lite, Pro 모델 사용률 표시
- TUI 출력 정규화: ANSI/control code 제거, 단독 `\r` 공백 처리, 그래프/box 문자 제거
- Gemini 다중 redraw 대응: 퍼센트가 채워진 최신 `Model usage` 화면 기준 파싱
- 주간 Pace 카드: 실제 사용률 bar와 목표 threshold marker 비교
- 자동 refresh, 수동 refresh, refresh cooldown
- 서버 로그 패널: `/api/server/logs` SSE 기반 실시간 로그 표시
- 서버 종료 버튼: `/api/server/stop` 호출
- 서버 JSON history와 브라우저 `localStorage` fallback 캐시

## 빠른 실행

```powershell
.\scripts\start-server.ps1
```

브라우저:

```text
http://127.0.0.1:5173/
```

자주 쓰는 옵션:

```powershell
.\scripts\start-server.ps1 -Open
.\scripts\start-server.ps1 -Port 5173
.\scripts\start-server.ps1 -Mode preview
.\scripts\start-server.ps1 -NoRestart
.\scripts\start-server.ps1 -Status
.\scripts\start-server.ps1 -Help
```

`start-server.ps1`은 기본적으로 `--strictPort`를 사용합니다. 같은 프로젝트에서 실행한 기존 dashboard 서버만 식별해서 재시작하고, 다른 프로세스가 포트를 사용 중이면 중지하지 않고 실패합니다.

## 개발

```powershell
pnpm install
pnpm dev
```

검사:

```powershell
pnpm check
pnpm build
```

패키지 매니저는 `pnpm`을 기준으로 합니다.

## CLI 수집 대상

현재 CLI working directory:

```text
D:\Code\_temp
```

| Provider   | Command               | Slash command | 표시 방식           |
| ---------- | --------------------- | ------------- | ------------------- |
| Claude     | `claude`              | `/usage`      | current, week usage |
| Codex      | `codex`               | `/status`     | current, week usage |
| Gemini CLI | `gemini --skip-trust` | `/model`      | model별 usage       |

Gemini CLI만 `--skip-trust`를 사용합니다. Claude/Codex의 유사 옵션은 workspace trust 생략이 아니라 권한/승인 정책 변경에 가깝고, 현재 `/usage`, `/status` 수집에서는 속도 개선이 없거나 수집 실패를 만들 수 있어 기본 command를 유지합니다.

CLI 실행과 파싱의 자세한 흐름은 [docs/architecture.md](docs/architecture.md)를 참고하세요.

## 문서

- [Architecture](docs/architecture.md): 구현 구조, API contract, refresh/cache 동작, 운영 메모
- [HTML Overview](docs/ai_dash.html): 브라우저에서 바로 열 수 있는 공유용 문서

## 데이터

- 저장 파일: `data/usage-history.json`
- history bucket: 10분 단위
- 보관 개수: 최근 12개 bucket, 최소 5개 이상
- 브라우저 캐시 key: `ai-usage-payload-cache`

`data/usage-history.json`은 로컬 실행 결과이므로 Git에 올릴지 여부를 별도로 판단하세요.
