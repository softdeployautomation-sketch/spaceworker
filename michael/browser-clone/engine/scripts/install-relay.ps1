# install-relay.ps1 - work-PC (Windows) installer for the egress relay
# (directive section 13: the proxy the hosted clone browser dials so all
# traffic egresses from the work PC's IP).
#
# DEPLOYMENT RULE (same as the receiver): the install folder is QUARANTINED
# BEFORE the binary lands in it - Defender path+process exclusions are added
# and VERIFIED while the folder is still empty (preflight --exe selects the
# relay's process-exclusion name). Verified against the hack-relay.exe
# quarantine incident (relay killed mid-rollout without one).
#
# SILENCE: the scheduled task runs under SYSTEM in session 0, so neither the
# relay nor anything it spawns can put a window on the user's desktop.
#
# usage: install-relay.ps1 <new-relay-exe> [install-dir] [addr] [token]
param(
    [Parameter(Mandatory = $true)][string]$NewExe,
    [string]$InstallDir = "C:\ProgramData\TacticalRMM\Relay",
    [string]$Addr = "0.0.0.0:8080",
    [string]$Token = ""
)
$ErrorActionPreference = 'Stop'

# 1. RULE: quarantine first (folder must stay empty until verified).
$pf = & $NewExe preflight --dir $InstallDir --exe hack-relay.exe
$pf | Write-Host
if ($LASTEXITCODE -ne 0) {
    throw "preflight (install-folder quarantine) failed - refusing to install"
}

# 1b. port preflight: a stale listener squatting the endpoint silently
# breaks every later deploy (observed with the receiver on :8080).
$port = ($Addr -split ':')[-1]
$held = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($held) {
    Write-Warning "port $port is already held by PID(s) $($held.OwningProcess -join ',') - stopping them"
    $held | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
}

# 2. install into the quarantined folder.
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item $NewExe (Join-Path $InstallDir 'hack-relay.exe') -Force
$exe = Join-Path $InstallDir 'hack-relay.exe'

# 3. durable registration (SYSTEM, at boot, session 0 = no window): the
# ssh-spawned relay dies with the ssh session (job-object teardown),
# observed twice. Build it with -H=windowsgui (see build.ps1) so even a
# manual run cannot raise a console.
$args_ = "-addr $Addr"
if ($Token) { $args_ += " -token $Token" }
schtasks /Create /TN SpaceworkerRelay /TR "`"$exe`" $args_" /SC ONSTART /RU SYSTEM /F | Out-Null
schtasks /Run /TN SpaceworkerRelay | Out-Null
Start-Sleep -Seconds 2
netstat -ano | Select-String ":$port.*LISTENING" | Write-Host
Write-Host "relay installed: $exe on $Addr (task SpaceworkerRelay)"