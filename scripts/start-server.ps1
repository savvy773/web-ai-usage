param(
	[ValidateSet('dev', 'preview')]
	[string]$Mode = 'preview',

	[string]$HostName = '127.0.0.1',

	[int]$Port = 5173,

	[switch]$Open,

	[switch]$NoRestart,

	[switch]$Status,

	[switch]$Help
)

# 숨김 창으로 자기 재실행 (터미널 독립 실행)
if (-not $env:AI_USAGE_HIDDEN -and -not $Status -and -not $Help) {
	$env:AI_USAGE_HIDDEN = '1'
	$argList = "-WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Mode $Mode -HostName $HostName -Port $Port"
	if ($Open) { $argList += ' -Open' }
	if ($NoRestart) { $argList += ' -NoRestart' }
	if ($Status) { $argList += ' -Status' }
	if ($Help) { $argList += ' -Help' }
	$pwshCmd = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }
	Start-Process $pwshCmd -ArgumentList $argList -WindowStyle Hidden
	exit
}

$ErrorActionPreference = 'Stop'

$ServerName = 'ai-usage-dashboard'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$RuntimeDir = Join-Path $ProjectRoot '.server'
$StatePath = Join-Path $RuntimeDir "$ServerName.json"
$NodeVersionStampPath = Join-Path $RuntimeDir 'node-version.txt'
$DataDir = Join-Path $ProjectRoot 'data'
$LogsDir = Join-Path $DataDir 'logs'
$ProcessLogPath = Join-Path $LogsDir 'server-process.log'
$StartupErrorLogPath = Join-Path $LogsDir 'server-startup-error.log'
$ServerReadyTimeoutSeconds = 150

Set-Location $ProjectRoot

function Import-DotEnv {
	$envPath = Join-Path $ProjectRoot '.env'
	if (-not (Test-Path -LiteralPath $envPath)) {
		return
	}

	foreach ($line in Get-Content -LiteralPath $envPath) {
		$trimmed = $line.Trim()
		if (-not $trimmed -or $trimmed.StartsWith('#')) {
			continue
		}

		$match = [regex]::Match($trimmed, '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$')
		if (-not $match.Success) {
			continue
		}

		$name = $match.Groups[1].Value
		$value = $match.Groups[2].Value.Trim()
		if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
			$value = $value.Substring(1, $value.Length - 2)
		}

		[Environment]::SetEnvironmentVariable($name, $value, 'Process')
	}
}

Import-DotEnv

function Get-PnpmCommand {
	$command = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
	if ($command) {
		return $command.Source
	}

	$command = Get-Command pnpm -ErrorAction SilentlyContinue
	if ($command) {
		return $command.Source
	}

	throw 'pnpm is required to run this project.'
}

function Get-CurrentNodeVersion {
	try {
		$node = Get-NodeCommand
		return (& $node --version 2>&1).Trim()
	} catch {
		return ''
	}
}

function Test-NativeBuildStale {
	if (-not (Test-Path -LiteralPath $NodeVersionStampPath)) { return $true }
	$stamped = (Get-Content -LiteralPath $NodeVersionStampPath -Raw -ErrorAction SilentlyContinue).Trim()
	return $stamped -ne (Get-CurrentNodeVersion)
}

function Repair-NativeModules {
	$version = Get-CurrentNodeVersion
	Write-Host "Node $version detected (version changed); rebuilding native modules..." -ForegroundColor Yellow
	$pnpm = Get-PnpmCommand
	& $pnpm rebuild 2>&1 | ForEach-Object { Write-Host $_ }
	if ($LASTEXITCODE -ne 0) {
		Write-Warning "Native module rebuild exited $LASTEXITCODE. The server may not work correctly."
	}
	New-Item -ItemType Directory -Force $RuntimeDir | Out-Null
	$version | Set-Content -LiteralPath $NodeVersionStampPath -Encoding UTF8
}

function Get-NodeCommand {
	$command = Get-Command node.exe -ErrorAction SilentlyContinue
	if ($command) {
		return $command.Source
	}

	$command = Get-Command node -ErrorAction SilentlyContinue
	if ($command) {
		return $command.Source
	}

	throw 'node is required to run this project.'
}

function Get-ProcessInfo {
	param(
		[Parameter(Mandatory)]
		[int]$ProcessId
	)

	return Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
}

function Get-ChildProcessInfos {
	param(
		[Parameter(Mandatory)]
		[int]$ParentProcessId
	)

	$children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $ParentProcessId" -ErrorAction SilentlyContinue)
	foreach ($child in $children) {
		$child
		Get-ChildProcessInfos -ParentProcessId $child.ProcessId
	}
}

function Get-ProcessTreeInfos {
	param(
		[Parameter(Mandatory)]
		[int]$RootProcessId
	)

	$root = Get-ProcessInfo -ProcessId $RootProcessId
	if (-not $root) {
		return @()
	}

	return @($root) + @(Get-ChildProcessInfos -ParentProcessId $RootProcessId)
}

function Test-DashboardProcessTree {
	param(
		[Parameter(Mandatory)]
		[int]$RootProcessId
	)

	$tree = @(Get-ProcessTreeInfos -RootProcessId $RootProcessId)
	if ($tree.Count -eq 0) {
		return $false
	}

	$projectPattern = [regex]::Escape($ProjectRoot)
	$portPattern = "--port([`"'\s]+)$Port\b"

	foreach ($process in $tree) {
		$commandLine = [string]$process.CommandLine
		if ($commandLine -match $projectPattern -and $commandLine -match 'vite') {
			return $true
		}

		if ($commandLine -match 'pnpm' -and $commandLine -match 'vite' -and $commandLine -match $portPattern) {
			return $true
		}
	}

	return $false
}

function Stop-DashboardProcessTree {
	param(
		[Parameter(Mandatory)]
		[int]$RootProcessId,

		[string]$Reason = 'Restarting dashboard server'
	)

	if (-not (Test-DashboardProcessTree -RootProcessId $RootProcessId)) {
		throw "Refusing to stop PID $RootProcessId because it does not look like $ServerName for this project."
	}

	Write-Host "$Reason. Stopping $ServerName process tree rooted at PID $RootProcessId." -ForegroundColor Yellow

	$tree = @(Get-ProcessTreeInfos -RootProcessId $RootProcessId) |
		Sort-Object ProcessId -Descending

	foreach ($process in $tree) {
		try {
			Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
		} catch {
			if (Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue) {
				throw
			}
		}
	}
}

function Read-ServerState {
	if (-not (Test-Path -LiteralPath $StatePath)) {
		return $null
	}

	try {
		return Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
	} catch {
		Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
		return $null
	}
}

function Stop-TrackedServer {
	$state = Read-ServerState
	if (-not $state) {
		return
	}

	if ($state.serverName -ne $ServerName -or $state.projectRoot -ne $ProjectRoot) {
		throw "Refusing to use state file for a different server: $StatePath"
	}

	$trackedProcessId = [int]$state.processId
	$trackedProcess = Get-ProcessInfo -ProcessId $trackedProcessId
	if ($trackedProcess -and $state.processCreationDate -and $state.processCreationDate -ne $trackedProcess.CreationDate) {
		Write-Host "Ignoring stale state file because PID $trackedProcessId was reused by another process." -ForegroundColor Yellow
		Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
		return
	}

	if ($trackedProcess) {
		Stop-DashboardProcessTree -RootProcessId $trackedProcessId -Reason 'Previous dashboard server found'
	}

	Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
}

function Get-PortOwnerProcessIds {
	param(
		[Parameter(Mandatory)]
		[int]$Port
	)

	return @(
		Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
			Select-Object -ExpandProperty OwningProcess -Unique
	)
}

function Stop-DashboardServerOnPort {
	param(
		[Parameter(Mandatory)]
		[int]$Port
	)

	$ownerProcessIds = @(Get-PortOwnerProcessIds -Port $Port)
	foreach ($ownerProcessId in $ownerProcessIds) {
		if (Test-DashboardProcessTree -RootProcessId $ownerProcessId) {
			Stop-DashboardProcessTree -RootProcessId $ownerProcessId -Reason "Dashboard server already owns port $Port"
			continue
		}

		throw "Port $Port is already used by PID $ownerProcessId, but it is not recognized as $ServerName. Not stopping it."
	}
}

function Write-ServerState {
	param(
		[Parameter(Mandatory)]
		[System.Diagnostics.Process]$Process
	)

	$processInfo = Get-ProcessInfo -ProcessId $Process.Id
	New-Item -ItemType Directory -Force $RuntimeDir | Out-Null
	@{
		serverName = $ServerName
		projectRoot = $ProjectRoot
		mode = $Mode
		hostName = $HostName
		port = $Port
		processId = $Process.Id
		processCreationDate = $processInfo.CreationDate
		startedAt = (Get-Date).ToString('o')
	} | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $StatePath -Encoding UTF8
}

function Remove-ServerState {
	param(
		[Parameter(Mandatory)]
		[int]$ProcessId
	)

	$state = Read-ServerState
	if ($state -and [int]$state.processId -eq $ProcessId) {
		Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
	}
}

function Wait-DashboardHttpReady {
	param(
		[Parameter(Mandatory)]
		[string]$Url,

		[int]$TimeoutSeconds = 150
	)

	$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
	while ((Get-Date) -lt $deadline) {
		try {
			$response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
			if ([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 500) {
				return $true
			}
		} catch {
			Start-Sleep -Seconds 1
		}
	}

	return $false
}

function Start-DashboardServer {
	$PnpmCommand = Get-PnpmCommand
	$NodeCommand = Get-NodeCommand
	$ViteBin = Join-Path $ProjectRoot 'node_modules\vite\bin\vite.js'

	if (-not (Test-Path 'node_modules')) {
		& $PnpmCommand install
		if ($LASTEXITCODE -ne 0) { return $LASTEXITCODE }
	} elseif (Test-NativeBuildStale) {
		Repair-NativeModules
	}

	if (-not $NoRestart) {
		Stop-TrackedServer
		Stop-DashboardServerOnPort -Port $Port
	} elseif ((Get-PortOwnerProcessIds -Port $Port).Count -gt 0) {
		throw "Port $Port is already in use. Run without -NoRestart to restart the tracked dashboard server."
	}

	Write-Host "Starting $ServerName ($Mode) at http://$HostName`:$Port/" -ForegroundColor Cyan

	if ($Mode -eq 'preview') {
		& $PnpmCommand build
		if ($LASTEXITCODE -ne 0) {
			return $LASTEXITCODE
		}
		New-Item -ItemType Directory -Force $RuntimeDir | Out-Null
		(Get-CurrentNodeVersion) | Set-Content -LiteralPath $NodeVersionStampPath -Encoding UTF8
		$ViteArgs = @($ViteBin, 'preview', '--host', $HostName, '--port', "$Port", '--strictPort')
	} else {
		$ViteArgs = @($ViteBin, 'dev', '--host', $HostName, '--port', "$Port", '--strictPort')
	}

	New-Item -ItemType Directory -Force $LogsDir | Out-Null

	$serverProcess = Start-Process -FilePath $NodeCommand -ArgumentList $ViteArgs -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput $ProcessLogPath -RedirectStandardError $StartupErrorLogPath -PassThru
	Write-ServerState -Process $serverProcess
	if ($Open) {
		$url = "http://$HostName`:$Port/"
		if (Wait-DashboardHttpReady -Url $url -TimeoutSeconds $ServerReadyTimeoutSeconds) {
			Start-Process $url
		} else {
			Write-Warning "Server did not answer within $ServerReadyTimeoutSeconds seconds. Open manually: $url"
		}
	}
	return 0
}

function Show-ServerStatus {
	Write-Host "AI Usage Dashboard server status" -ForegroundColor Cyan
	Write-Host "Name:       $ServerName"
	Write-Host "Project:    $ProjectRoot"
	Write-Host "Address:    http://$HostName`:$Port/"
	Write-Host "State file: $StatePath"
	Write-Host ''

	$state = Read-ServerState
	if ($state) {
		$trackedProcessId = [int]$state.processId
		$trackedProcess = Get-ProcessInfo -ProcessId $trackedProcessId
		$creationMatches = $trackedProcess -and (
			-not $state.processCreationDate -or $state.processCreationDate -eq $trackedProcess.CreationDate
		)
		$recognized = $creationMatches -and (Test-DashboardProcessTree -RootProcessId $trackedProcessId)

		Write-Host "Tracked process:"
		Write-Host "  PID:        $trackedProcessId"
		Write-Host "  Running:    $([bool]$trackedProcess)"
		Write-Host "  Recognized: $([bool]$recognized)"
		Write-Host "  Started at: $($state.startedAt)"
	} else {
		Write-Host 'Tracked process: none'
	}

	$ownerProcessIds = @(Get-PortOwnerProcessIds -Port $Port)
	if ($ownerProcessIds.Count -eq 0) {
		Write-Host "Port ${Port}: free"
		return
	}

	Write-Host "Port $Port owners:"
	foreach ($ownerProcessId in $ownerProcessIds) {
		$owner = Get-ProcessInfo -ProcessId $ownerProcessId
		$recognized = Test-DashboardProcessTree -RootProcessId $ownerProcessId
		Write-Host "  PID:        $ownerProcessId"
		Write-Host "  Name:       $($owner.Name)"
		Write-Host "  Recognized: $recognized"
		Write-Host "  Command:    $($owner.CommandLine)"
	}
}

function Show-ServerHelp {
	@"
AI Usage Dashboard server script

Usage:
  .\scripts\start-server.ps1
  .\scripts\start-server.ps1 -Open
  .\scripts\start-server.ps1 -Mode dev
  .\scripts\start-server.ps1 -Mode preview
  .\scripts\start-server.ps1 -Port 5173
  .\scripts\start-server.ps1 -NoRestart
  .\scripts\start-server.ps1 -Status
  .\scripts\start-server.ps1 -Help

Fixed address:
  http://$HostName`:$Port/

Server identity:
  Name:       $ServerName
  State file: $StatePath

Restart behavior:
  By default, this script keeps the address fixed and uses --strictPort.
  Before starting, it stops only the previous $ServerName process that was started from this project.
  It also checks port $Port. If that port is owned by another process that is not recognized as this dashboard, the script refuses to stop it.

How to check in Task Manager:
  1. Open Task Manager with Ctrl+Shift+Esc.
  2. Open the Details tab.
  3. Right-click the column header, choose Select columns, and enable PID and Command line.
  4. Look for node.exe, pnpm.cmd, or cmd.exe with this project path:
     $ProjectRoot
  5. The tracked root PID is stored in:
     $StatePath

Manual stop:
  Preferred:
    Use the stop button in the dashboard.

  Restart safely:
    Run this script again. It will stop only the tracked $ServerName server and start it again.

  Task Manager:
    In the Details tab, use the PID from the state file and choose End process tree.

  PowerShell:
    `$state = Get-Content '$StatePath' -Raw | ConvertFrom-Json
    `$ids = @([int]`$state.processId)
    for (`$i = 0; `$i -lt `$ids.Count; `$i++) {
      `$ids += Get-CimInstance Win32_Process -Filter "ParentProcessId = `$(`$ids[`$i])" | Select-Object -ExpandProperty ProcessId
    }
    `$ids | Sort-Object -Descending -Unique | ForEach-Object { Stop-Process -Id `$_ -Force -ErrorAction SilentlyContinue }
    Remove-Item '$StatePath' -Force

Notes:
  - Do not end random node.exe processes unless the Command line or PID matches this dashboard.
  - Use -NoRestart only when you want the script to fail instead of stopping a tracked existing server.
  - Use -Status to inspect the tracked PID and port owner without starting or stopping anything.
"@ | Write-Host
}

if ($Status) {
	Show-ServerStatus
	exit 0
}

if ($Help) {
	Show-ServerHelp
	exit 0
}

exit (Start-DashboardServer)
