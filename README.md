# AI Usage Dashboard

로컬 Claude, Codex, Gemini CLI 사용량을 한 화면에서 확인하는 SvelteKit 대시보드입니다.

브라우저가 CLI를 직접 실행하지 않습니다. SvelteKit 서버 API가 로컬 CLI를 가상 터미널로 실행해 사용량을 수집하고, 결과를 `data/usage-history.json`에 저장합니다. 화면은 저장된 JSON과 브라우저 캐시를 먼저 보여준 뒤 백그라운드 refresh 결과로 갱신됩니다. 브라우저에서 F5/reload를 누르면 기존 payload를 먼저 표시한 다음 `/api/usage/refresh`를 호출해 새 수집을 시작합니다.

## 주요 기능

- Claude `/usage`, Codex `/status`, Gemini CLI `/model` 수집
- provider별 상태, 수집 시간, reset countdown, 사용률 bar 표시
- Claude/Codex의 current, week usage 표시
- Gemini CLI의 Flash, Flash Lite, Pro 모델 사용률 표시
- TUI 출력 정규화: ANSI/OSC/control code, cursor movement, ESC가 빠진 CSI 조각, 그래프/box 문자 제거
- Gemini 다중 redraw 대응: 최신 `Model usage` 화면의 `label + bar + percent + Resets` row 구조 기준 파싱
- 주간 Pace 카드: 실제 사용률 bar와 최소 20%에서 시작하는 목표 threshold marker 비교
- 자동 refresh, 수동 refresh, 브라우저 reload refresh, refresh cooldown
- Collector 재시도: provider별 최대 5회, phase 진단, slash command 소실 시 같은 세션 재입력
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
- [Fix Checklist](docs/fix_check.md): 오류 발생 시 밑단부터 좁히는 진단 체크리스트
- [HTML Overview](docs/ai_dash.html): 브라우저에서 바로 열 수 있는 공유용 문서

## 데이터

- usage history: `data/usage-history.json`
- 화면 확인용 최신 payload: `data/usage-latest.json`
- CLI raw tail: `data/raw/{provider}-latest.txt`
- 파싱 결과 snapshot: `data/raw/{provider}-latest.parsed.json`
- 마지막 실패 attempt raw: `data/raw/{provider}-last-failure.txt`
- 마지막 실패 attempt 파싱 snapshot: `data/raw/{provider}-last-failure.parsed.json`
- 서버 상태 파일: `.server/ai-usage-dashboard.json`
- 서버 로그: `data/logs/server.log`
- 오류 로그: `data/logs/server-error.log`, `data/logs/server-startup-error.log`
- collector 로그: `data/logs/collector.log`
- history bucket: 10분 단위
- 보관 개수: 최근 12개 bucket, 최소 5개 이상
- 브라우저 캐시 key: `ai-usage-payload-cache`

`data/usage-history.json`이 기능 동작 확인의 기준 파일입니다. refresh가 성공하면 이 파일의 최신 `history[].providers`에 provider별 `status`, `message`, `windows`, `modelUsages`가 저장됩니다. Gemini는 `modelUsages[]`의 `label`, `percent`, `resetAt`, `remainingText`를 보면 됩니다.

파싱 오류 확인은 `data/raw/gemini-last-failure.txt`처럼 provider별 마지막 실패 raw를 먼저 보고, 현재 최종 상태는 `data/raw/gemini-latest.txt` 또는 `data/raw/claude-latest.txt`에서 확인합니다. 화면에 뿌릴 최신 데이터와 최근 6개 bucket은 `data/usage-latest.json`에서 바로 확인할 수 있습니다.

`data/`와 `.server/`는 Git ignore 대상입니다. `rawPreview` 같은 raw terminal output은 history JSON에 저장하지 않고 `data/raw/`에 최신 tail만 별도 저장합니다.
