#
# Rundock from-source bootstrap for Windows.
#
# Usage:
#   irm https://raw.githubusercontent.com/liamdarmody/rundock/main/scripts/install-windows-source.ps1 | iex
#
# What this does, end to end:
#   [1/5] Check Node.js 20+ and Git, install via winget if missing
#   [2/5] Check Claude Code, prompt to run Anthropic's installer if missing
#   [3/5] Clone or update the Rundock repository at %USERPROFILE%\Rundock
#   [4/5] Run npm install
#   [5/5] Generate a launcher script and Desktop and Start Menu shortcuts
#
# After this completes, Rundock can be launched by double-clicking its
# Desktop or Start Menu shortcut. No PowerShell required for daily use.
#
# This script is interim. It exists to get non-developer Windows users
# into Rundock without a real terminal session, before the proper
# Windows installer ships. It will be retired when the NSIS installer
# tracked in the Rundock backlog ("Ship a Windows installer and add
# Windows to the release pipeline") lands.
#

$ErrorActionPreference = 'Stop'

$RepoUrl    = 'https://github.com/liamdarmody/rundock.git'
$InstallDir = Join-Path $env:USERPROFILE 'Rundock'
$LogPath    = Join-Path $InstallDir '.rundock-bootstrap.log'

function Write-Step {
    param([string]$Label, [string]$Detail = '')
    if ($Detail) {
        Write-Host ("{0}... {1}" -f $Label, $Detail)
    } else {
        Write-Host ("{0}..." -f $Label)
    }
}

function Refresh-Path {
    $machine = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user    = [System.Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = ($machine, $user | Where-Object { $_ }) -join ';'
}

function Fail {
    param([string]$Message)
    Write-Host ''
    Write-Host ("Bootstrap failed: {0}" -f $Message) -ForegroundColor Red
    if (Test-Path $LogPath) {
        Write-Host ("Log: {0}" -f $LogPath)
    }
    Write-Host 'Re-running the bootstrap one-liner is safe.'
    exit 1
}

# ----------------------------------------------------------------------
# [1/5] Dependencies: Node.js 20+ and Git, via winget if missing
# ----------------------------------------------------------------------

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Host 'Bootstrap failed: winget is not available on this machine.'
    Write-Host 'Install App Installer from the Microsoft Store, then rerun:'
    Write-Host '  ms-windows-store://pdp/?productid=9NBLGGH4NNS1'
    exit 1
}

function Ensure-Tool {
    param(
        [string]$Name,
        [string]$VersionFlag,
        [string]$WingetId,
        [int]   $MinMajor = 0
    )
    $okLabel = $null
    try {
        $output = (& $Name $VersionFlag) 2>$null
        if ($output) {
            if ($MinMajor -gt 0 -and $output -match 'v?(\d+)\.') {
                $major = [int]$matches[1]
                if ($major -lt $MinMajor) { $okLabel = $null }
                else { $okLabel = $output }
            } else {
                $okLabel = $output
            }
        }
    } catch { $okLabel = $null }

    if ($okLabel) {
        Write-Step ("[1/5] Checking {0}" -f $Name) ("installed ({0})" -f $okLabel)
        return
    }

    Write-Step ("[1/5] Checking {0}" -f $Name) ("missing, installing via winget {0}" -f $WingetId)
    & winget install --id $WingetId -e `
        --accept-source-agreements `
        --accept-package-agreements `
        --silent
    if ($LASTEXITCODE -ne 0) {
        Fail ("winget install {0} failed (exit {1})" -f $WingetId, $LASTEXITCODE)
    }
    Refresh-Path
    try { $output = (& $Name $VersionFlag) 2>$null } catch { $output = $null }
    if (-not $output) {
        Fail ("{0} is still not on PATH after install. Open a new PowerShell window and rerun the one-liner." -f $Name)
    }
    Write-Host ("        installed ({0})" -f $output)
}

Ensure-Tool -Name 'node' -VersionFlag '--version' -WingetId 'OpenJS.NodeJS.LTS' -MinMajor 20
Ensure-Tool -Name 'git'  -VersionFlag '--version' -WingetId 'Git.Git'

# ----------------------------------------------------------------------
# [2/5] Claude Code: detect via priority paths, then where.exe
# ----------------------------------------------------------------------

function Find-Claude {
    $candidates = @(
        (Join-Path $env:USERPROFILE '.local\bin\claude.exe'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\claude.exe'),
        (Join-Path $env:APPDATA 'npm\claude.cmd')
    )
    foreach ($p in $candidates) {
        if (Test-Path $p) { return $p }
    }
    $found = & where.exe claude 2>$null
    if ($LASTEXITCODE -eq 0 -and $found) {
        return ($found | Select-Object -First 1)
    }
    return $null
}

$claudePath = Find-Claude
if ($claudePath) {
    Write-Step '[2/5] Checking Claude Code' ("found ({0})" -f $claudePath)
} else {
    Write-Step '[2/5] Checking Claude Code' 'not found'
    Write-Host ''
    Write-Host "Rundock requires Claude Code. We'll run Anthropic's installer:"
    Write-Host '  irm https://claude.ai/install.ps1 | iex'
    $reply = Read-Host 'Continue? [Y/n]'
    if ($reply -notmatch '^(y|yes)$') {
        Write-Host "Install Claude Code (irm https://claude.ai/install.ps1 | iex), then rerun the Rundock bootstrap."
        exit 0
    }
    & powershell.exe -NoProfile -Command 'irm https://claude.ai/install.ps1 | iex'
    if ($LASTEXITCODE -ne 0) {
        Fail ("Anthropic Claude Code installer failed (exit {0})" -f $LASTEXITCODE)
    }
    Refresh-Path
    $claudePath = Find-Claude
    if (-not $claudePath) {
        Fail 'Claude Code not found on PATH after install. Open a new PowerShell window and rerun the one-liner.'
    }
    Write-Host ("        installed ({0})" -f $claudePath)
}

# ----------------------------------------------------------------------
# [3/5] Repo clone or update
# ----------------------------------------------------------------------

if (Test-Path $InstallDir) {
    if (-not (Test-Path (Join-Path $InstallDir '.git'))) {
        Fail ("{0} exists but is not a git repository. Move or remove it, then rerun." -f $InstallDir)
    }
    Push-Location $InstallDir
    try {
        $remote = (& git config --get remote.origin.url) 2>$null
        if ($remote -notmatch 'liamdarmody/rundock') {
            Fail ("{0} contains a different repository ({1}). Move or remove it, then rerun." -f $InstallDir, $remote)
        }
        Write-Step '[3/5] Updating Rundock checkout' $InstallDir
        & git pull --ff-only
        if ($LASTEXITCODE -ne 0) {
            Fail ("git pull failed in {0} (exit {1})" -f $InstallDir, $LASTEXITCODE)
        }
    } finally {
        Pop-Location
    }
} else {
    Write-Step '[3/5] Cloning Rundock' $InstallDir
    & git clone $RepoUrl $InstallDir
    if ($LASTEXITCODE -ne 0) {
        Fail ("git clone failed (exit {0})" -f $LASTEXITCODE)
    }
}

# Make the log file exist so the final pointer below resolves.
if (-not (Test-Path $LogPath)) {
    New-Item -ItemType File -Path $LogPath -Force | Out-Null
}

# ----------------------------------------------------------------------
# [4/5] npm install
# ----------------------------------------------------------------------

Push-Location $InstallDir
try {
    Write-Step '[4/5] Installing dependencies' 'running npm install'
    & npm install
    if ($LASTEXITCODE -ne 0) {
        Fail ("npm install failed (exit {0}). See npm output above." -f $LASTEXITCODE)
    }
} finally {
    Pop-Location
}

# ----------------------------------------------------------------------
# [5/5] Launcher script and shortcuts
# ----------------------------------------------------------------------

Write-Step '[5/5] Wiring launchers' 'Desktop and Start Menu shortcuts'

$LauncherPath = Join-Path $InstallDir 'launch-rundock.ps1'

$launcherBody = @'
# Rundock launcher (generated by install-windows-source.ps1).
# Boots the embedded Node server in the background, waits for the port
# to respond, then opens the default browser at the Rundock URL.

$Repo = Join-Path $env:USERPROFILE 'Rundock'
$Log  = Join-Path $Repo '.rundock-bootstrap.log'
$Url  = 'http://localhost:3000'

Set-Location -Path $Repo

function Test-Port {
    try {
        $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 1
        return ($r.StatusCode -ge 200)
    } catch {
        return $false
    }
}

if (-not (Test-Port)) {
    Start-Process -FilePath 'node' `
        -ArgumentList (Join-Path $Repo 'server.js') `
        -WorkingDirectory $Repo `
        -WindowStyle Hidden `
        -RedirectStandardOutput $Log `
        -RedirectStandardError  $Log

    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline) {
        if (Test-Port) { break }
        Start-Sleep -Milliseconds 250
    }
}

Start-Process $Url
'@

Set-Content -Path $LauncherPath -Value $launcherBody -Encoding UTF8 -Force

$icon       = Join-Path $InstallDir 'electron\build\icon.ico'
$desktopLnk = Join-Path $env:USERPROFILE 'Desktop\Rundock.lnk'
$startLnk   = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Rundock.lnk'

$wshShell = New-Object -ComObject WScript.Shell
foreach ($lnk in @($desktopLnk, $startLnk)) {
    $sc = $wshShell.CreateShortcut($lnk)
    $sc.TargetPath       = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
    $sc.Arguments        = "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$LauncherPath`""
    $sc.WorkingDirectory = $InstallDir
    $sc.IconLocation     = "$icon,0"
    $sc.Description      = 'Rundock: a visual interface for AI agent teams'
    $sc.Save()
}

Write-Host ''
Write-Host 'Rundock is installed.'
Write-Host 'Launch from the Desktop or Start Menu shortcut, or run:'
Write-Host ("  powershell -ExecutionPolicy Bypass -File `"{0}`"" -f $LauncherPath)
Write-Host ''
Write-Host 'If something does not work, the launcher writes server output to:'
Write-Host ("  {0}" -f $LogPath)
Write-Host ''
Write-Host 'This bootstrap is interim and will be retired when the proper Windows installer ships.'
