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
#>
param(
    [string]$InstallPath = "$HOME\ai_usage",
    [switch]$Open,
    [string]$Branch = "main"
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

if (-not (Test-Cmd "git")) { Write-Fail "git not found. Install from https://git-scm.com" }
Write-Ok "git found"

$pkgMgr = $null
foreach ($pm in @("pnpm", "npm")) {
    if (Test-Cmd $pm) { $pkgMgr = $pm; break }
}

if (-not $pkgMgr) {
    Write-Fail "No package manager found. Install pnpm: https://pnpm.io/installation"
}

if ($pkgMgr -ne "pnpm") {
    Write-Warn "pnpm not found — falling back to $pkgMgr (pnpm recommended)"
} else {
    Write-Ok "pnpm found"
}

# ── clone ─────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Step "Installing to: $InstallPath"

if (Test-Path $InstallPath) {
    $existing = Get-ChildItem $InstallPath -Force -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Warn "Directory already exists and is not empty."
        $answer = Read-Host "  Overwrite? [y/N]"
        if ($answer -notmatch '^[Yy]$') {
            Write-Host "  Aborted." -ForegroundColor DarkGray
            exit 0
        }
        Remove-Item $InstallPath -Recurse -Force
    }
}

Write-Step "Cloning savvy773/ai_usage ($Branch)..."
git clone --branch $Branch --depth 1 "https://github.com/savvy773/ai_usage.git" $InstallPath 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Fail "git clone failed." }
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

if ($Open) {
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
