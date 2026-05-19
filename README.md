# AI Usage Dashboard

로컬 Claude, Codex, Gemini CLI의 usage 상태를 한 화면에서 보는 SvelteKit 대시보드입니다.

브라우저가 CLI를 직접 실행하지 않고, SvelteKit 서버 API가 각 CLI를 `node-pty` 가상 터미널로 실행해서 usage 출력을 수집합니다. 수집 결과는 JSON 스냅샷으로 저장되고, 화면은 저장된 JSON을 먼저 보여준 뒤 백그라운드 refresh 결과로 갱신됩니다.

## Features

- Claude `/usage`, Codex `/status`, Gemini CLI `/model` 수집
- provider별 usage, reset 시간, 수집 소요 시간 표시
- refresh 중에도 기존 JSON을 먼저 반환하는 빠른 응답 경로
- 브라우저 `localStorage` fallback 캐시
- 최근 usage history 최소 5세트 이상 보관
- `data/usage-history.json` 기반 로컬 JSON 저장

## Run

```powershell
.\scripts\start-server.ps1
```

브라우저:

```text
http://localhost:5173/
```

옵션:

```powershell
.\scripts\start-server.ps1 -Open
.\scripts\start-server.ps1 -Port 3000
.\scripts\start-server.ps1 -Mode preview
.\scripts\start-server.ps1 -NoRestart
.\scripts\start-server.ps1 -Status
.\scripts\start-server.ps1 -Help
```

기본 모드에서는 주소를 고정하기 위해 `--strictPort`로 실행합니다. 같은 프로젝트의 이전 `ai-usage-dashboard` 서버가 있으면 `.server/ai-usage-dashboard.json` 상태 파일과 프로세스 정보를 확인한 뒤 해당 서버만 중지하고 재시작합니다. 다른 서버가 같은 포트를 쓰는 경우에는 중지하지 않고 실패합니다.

작업 관리자에서 확인하거나 수동 종료하는 방법은 다음 명령으로 볼 수 있습니다.

```powershell
.\scripts\start-server.ps1 -Help
```

현재 상태만 확인하려면 서버를 시작하거나 중지하지 않는 `-Status`를 사용합니다.

```powershell
.\scripts\start-server.ps1 -Status
```

## Development

```powershell
pnpm install
pnpm dev
```

검사:

```powershell
pnpm check
pnpm build
```

## How Collection Works

수집은 서버에서 실행됩니다.

1. 브라우저가 `POST /api/usage/refresh`를 호출합니다.
2. 서버가 `node-pty`로 `pwsh.exe -NoLogo -NoProfile` 가상 터미널을 엽니다.
3. provider별 CLI를 병렬 실행합니다.
4. 각 CLI에 slash command를 입력합니다.
5. 터미널 출력을 파싱해서 usage JSON을 만듭니다.
6. 결과를 `data/usage-history.json`에 저장합니다.

현재 CLI working directory:

```text
D:\Code\_temp
```

provider별 명령:

| Provider | Command | Slash command |
| --- | --- | --- |
| Claude | `claude` | `/usage` |
| Codex | `codex` | `/status` |
| Gemini CLI | `gemini` | `/model` |

`node-pty`가 실패하면 일반 child process pipe 방식으로 fallback합니다.

## Timing

각 provider 카드 우측 상단에 `Fetch 7.8s`처럼 수집 시간이 표시됩니다. 이 값은 `ProviderUsage.collectionDurationMs`에 저장됩니다.

최근 실측:

| Provider | 수집 시간 |
| --- | --- |
| Gemini CLI | 약 18초 |
| Codex | 약 12초 |
| Claude | 약 8초 |

전체 refresh는 provider들을 병렬로 수집하므로 가장 느린 provider가 전체 시간을 결정합니다.

## Docs

상세 구조는 [docs/architecture.md](docs/architecture.md)를 참고하세요.
