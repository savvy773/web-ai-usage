#Requires -Version 5.1
<#
.SYNOPSIS
    One-line installer for AI Usage Dashboard.

.DESCRIPTION
    irm https://raw.githubusercontent.com/savvy773/ai_usage/main/scripts/install.ps1 | iex

.PARAMETER InstallPath
    Directory to clone into. Defaults to $HOME\ai_usage.

.PARAMETER Open
    Open the dashboard in the browser after install.

.PARAMETER Branch
    Git branch to clone. Defaults to main.

.PARAMETER Yes
    Auto-confirm all prompts (overwrite, launch). Alias: -y
#>
param(
    [string]$InstallPath = "$HOME\ai_usage",
    [switch]$Open,
    [string]$Branch = "main",
    [Alias("y")]
    [switch]$Yes
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── helpers ──────────────────────────────────────────────────────────────────

function Write-Step  { param([string]$msg) Write-Host "  $msg" -ForegroundColor Cyan }
function Write-Ok    { param([string]$msg) Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Warn  { param([string]$msg) Write-Host "  ⚠ $msg" -ForegroundColor Yellow }
function Write-Fail  { param([string]$msg) Write-Host "  ✗ $msg" -ForegroundColor Red; exit 1 }

function Test-Cmd {
    param([string]$name)
    $null -ne (Get-Command $name -ErrorAction SilentlyContinue)
}

# ── banner ───────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  AI Usage Dashboard — Installer" -ForegroundColor White
Write-Host "  ────────────────────────────────────────" -ForegroundColor DarkGray
Write-Host ""

# ── preflight ────────────────────────────────────────────────────────────────

Write-Step "Checking requirements..."

function Update-Path {
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("PATH","User")
}

function Install-WithWinget {
    param([string]$id, [string]$name)
    if (-not (Test-Cmd "winget")) {
        Write-Fail "$name not found and winget is unavailable. Install manually: $name"
    }
    Write-Step "$name not found — installing via winget..."
    winget install --id $id --silent --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Fail "winget failed to install $name. Install manually." }
    Update-Path
    Write-Ok "$name installed"
}

if (-not (Test-Cmd "git")) { Install-WithWinget "Git.Git" "git" } else { Write-Ok "git found" }

if (-not (Test-Cmd "node")) { Install-WithWinget "OpenJS.NodeJS.LTS" "Node.js" } else { Write-Ok "node found" }

# node-pty requires native compilation — check for cl.exe (MSVC) or warn
if (-not (Test-Cmd "cl")) {
    Write-Warn "Visual Studio Build Tools (C++) not found."
    Write-Warn "node-pty requires native compilation. If pnpm install fails, run:"
    Write-Warn "  winget install Microsoft.VisualStudio.2022.BuildTools --override `"--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive`""
    Write-Host ""
}
if (-not (Test-Cmd "python")) {
    Write-Warn "Python not found (needed by node-gyp). Install with:"
    Write-Warn "  winget install Python.Python.3"
    Write-Host ""
}

if (-not (Test-Cmd "pnpm")) {
    Write-Step "pnpm not found — installing globally via npm..."
    npm install -g pnpm --silent 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Fail "Failed to install pnpm. Run manually: npm install -g pnpm" }
    Update-Path
    Write-Ok "pnpm installed"
} else {
    Write-Ok "pnpm found"
}

$pkgMgr = "pnpm"

# ── clone ─────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Step "Installing to: $InstallPath"

if (Test-Path $InstallPath) {
    $existing = Get-ChildItem $InstallPath -Force -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Warn "Directory already exists and is not empty."
        if ($Yes) {
            Write-Host "  -Yes flag set — overwriting." -ForegroundColor DarkGray
        } else {
            $answer = Read-Host "  Overwrite? [y/N]"
            if ($answer -notmatch '^[Yy]$') {
                Write-Host "  Aborted." -ForegroundColor DarkGray
                exit 0
            }
        }
        Remove-Item $InstallPath -Recurse -Force
    }
}

Write-Step "Cloning savvy773/ai_usage ($Branch)..."
# Suppress stderr redirect on PS5.1 — git progress on stderr triggers NativeCommandError with Stop preference
$ErrorActionPreference = "Continue"
git clone --branch $Branch --depth 1 "https://github.com/savvy773/ai_usage.git" $InstallPath 2>&1 | Out-Null
$cloneExit = $LASTEXITCODE
$ErrorActionPreference = "Stop"
if ($cloneExit -ne 0) { Write-Fail "git clone failed." }
Write-Ok "Cloned"

# ── install dependencies ──────────────────────────────────────────────────────

Write-Step "Installing dependencies with $pkgMgr..."
Push-Location $InstallPath
try {
    & $pkgMgr install --silent 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Fail "$pkgMgr install failed." }
} finally {
    Pop-Location
}
Write-Ok "Dependencies installed"

# ── done ─────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  ────────────────────────────────────────" -ForegroundColor DarkGray
Write-Host "  Done! AI Usage Dashboard is ready." -ForegroundColor Green
Write-Host ""
Write-Host "  Start:" -ForegroundColor DarkGray
Write-Host "    cd `"$InstallPath`"" -ForegroundColor White
Write-Host "    .\scripts\start-server.ps1 -Open" -ForegroundColor White
Write-Host ""

# ── optional: launch now ─────────────────────────────────────────────────────

if ($Open -or $Yes) {
    Write-Step "Starting dashboard..."
    Push-Location $InstallPath
    & ".\scripts\start-server.ps1" -Open
    Pop-Location
} else {
    $answer = Read-Host "  Launch the dashboard now? [Y/n]"
    if ($answer -match '^[Yy]$' -or $answer -eq '') {
        Push-Location $InstallPath
        & ".\scripts\start-server.ps1" -Open
        Pop-Location
    }
}
