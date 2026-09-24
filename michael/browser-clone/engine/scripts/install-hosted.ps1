# install-hosted.ps1 - hosted-PC (Windows) installer for the browser-clone
# receiver.
#
# DEPLOYMENT RULE (enforced, not optional): the install folder is QUARANTINED
# BEFORE the exe is installed into it. Behavioural endpoint protection
# (Windows Defender) quarantined a deployed binary mid-rollout and stripped
# its scheduled task. The folder is therefore registered as a Defender
# path+process exclusion (and the registration verified) while the folder is
# still empty; only then is the binary copied in. preflight failures ABORT
# the install.
param(
    [Parameter(Mandatory = $true)][string]$NewExe,   # freshly built exe to install
    [string]$InstallDir = "C:\ProgramData\TacticalRMM\CloneTool",
    [string]$Addr = ":8080",
    [string]$StagingRoot = "C:\ProgramData\TacticalRMM\Clones"
)
$ErrorActionPreference = 'Stop'

# 1. RULE: quarantine first (run from the SOURCE copy - the install folder
#    must stay empty until the quarantine is verified).
$pf = & $NewExe preflight --dir $InstallDir
$pf | Write-Host
if ($LASTEXITCODE -ne 0) {
    throw "preflight (install-folder quarantine) failed - refusing to install"
}

# 2. install the binaries into the quarantined folder. The scheduled task
#    runs the GUI-subsystem service twin (-H=windowsgui, build.ps1): a
#    console-subsystem exe started by schtasks in the user session pops a
#    console window on the desktop, the svc build cannot (silence rule).
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# 2b. STOP AN ALREADY-RUNNING RECEIVER BEFORE WRITING OVER IT.
#
# Windows locks a running .exe, so re-running setup on a PC that is ALREADY a
# clone host failed live (device `Sc`, 2026-09-24):
#   Copy-Item : The process cannot access the file
#   '…\CloneTool\hack-browser-clone-svc.exe' because it is being used by another
#   process.        (install-hosted.ps1:35 and the caller's stage copy, both.)
# In other words the one-click button worked exactly ONCE, and every retry after
# that reported a failure for a machine that was in fact already installed.
# Stop it here and start it again at the end of this script, so the install is
# genuinely re-runnable — which is also what makes a repair/upgrade work.
#
# Scoped by BOTH path and command line on purpose: a capture legitimately runs
# the plain engine twin from this same folder, and killing that would break a
# live clone. Only the `serve` receiver (or the -svc twin) is stopped.
Get-ScheduledTask -TaskName 'SpaceworkerCloneSrv' -ErrorAction SilentlyContinue |
    Stop-ScheduledTask -ErrorAction SilentlyContinue
foreach ($p in (Get-CimInstance Win32_Process -Filter "Name='hack-browser-clone.exe' OR Name='hack-browser-clone-svc.exe'" -ErrorAction SilentlyContinue)) {
    $exePath = $null
    try { $exePath = $p.ExecutablePath } catch { }
    if ($exePath -and ($exePath -like ($InstallDir + '*'))) {
        if (($p.Name -like '*-svc.exe') -or ($p.CommandLine -and ($p.CommandLine -match ' serve '))) {
            Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
}
# Bounded wait for Windows to release the image handle.
for ($i = 0; $i -lt 20; $i++) {
    $locked = $false
    foreach ($f in @('hack-browser-clone-svc.exe', 'hack-browser-clone.exe')) {
        $lp = Join-Path $InstallDir $f
        if (Test-Path $lp) { try { [IO.File]::OpenWrite($lp).Close() } catch { $locked = $true } }
    }
    if (-not $locked) { break }
    Start-Sleep -Milliseconds 500
}
if ($locked) { throw "the receiver still holds $InstallDir\*.exe after stopping it and waiting 10s; close it on the device and run setup again" }
Copy-Item $NewExe (Join-Path $InstallDir 'hack-browser-clone.exe') -Force
$svc = Join-Path (Split-Path -Parent $NewExe) 'hack-browser-clone-svc.exe'
if (Test-Path $svc) {
    Copy-Item $svc (Join-Path $InstallDir 'hack-browser-clone-svc.exe') -Force
} else {
    Write-Warning "hack-browser-clone-svc.exe not found next to $NewExe - run scripts\\build.ps1 (task will pop a console without it)"
}

# 3. register + start the receiver in the INTERACTIVE user's session.
#
# WHY NOT `schtasks /Create /SC ONLOGON` WITH NO /RU — live failure 2026-09-24:
# the setup harness runs over the agent as SYSTEM (lib/clone-setup.ts sends every
# step with runAsUser:false), so with no /RU schtasks tries to record the
# CREATING account as the task principal and dies with "No mapping between
# account names and security IDs was done". The task was therefore never
# created, and the /Query two lines below then reported the misleading "The
# system cannot find the file specified" — which is simply what /Query returns
# for a task that does not exist. (install-relay.ps1 never hit this because it
# passes an explicit /RU SYSTEM.)
#
# The receiver must live in a logged-on user's session anyway: the engine
# launches a VISIBLE browser (only INJECT CHECK 5 headlessValidate is headless)
# and session 0 has no desktop — which is also why build.ps1 ships the
# GUI-subsystem twin. So resolve the interactive user explicitly and register
# the task for them with an Interactive logon token: no password required, and
# the task lands in the desktop session the browser needs.
function Get-VantraInteractiveUser {
    try {
        $o = Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" -ErrorAction SilentlyContinue |
             Select-Object -First 1 | Invoke-CimMethod -MethodName GetOwner -ErrorAction SilentlyContinue
        if ($o -and $o.User) { return "$($o.Domain)\$($o.User)" }
    } catch { }
    return $null
}
$interactiveUser = Get-VantraInteractiveUser
if (-not $interactiveUser) {
    throw "no interactive desktop session found (no explorer.exe owner to attribute the receiver to). The clone host must run in a logged-on user's session because it launches a visible browser; session 0 cannot host it. Log a user in on this PC, then run setup again."
}

$exe = Join-Path $InstallDir 'hack-browser-clone-svc.exe'
if (-not (Test-Path $exe)) { $exe = Join-Path $InstallDir 'hack-browser-clone.exe' }

# 3b. FIREWALL — allow inbound BEFORE the receiver ever listens.
#
# Observed live 2026-09-24: the first time the receiver bound its port, Windows
# raised the interactive prompt "Do you want to allow public and private networks
# to access this app?" for hack-browser-clone-svc.exe. On a clone host nobody is
# sitting at the machine to click Allow, so the receiver would be silently
# unreachable — the clone would fail with a connection error and look like an
# engine bug. Windows only prompts when NO matching rule exists, so creating the
# rule here (as SYSTEM, which may) suppresses the prompt entirely and keeps the
# setup genuinely one-click. Same "declare it before the risky step" discipline
# as the Defender folder exclusion in preflight.
$fwName = 'SpaceWorker clone receiver'
Get-NetFirewallRule -DisplayName $fwName -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName $fwName -Direction Inbound -Action Allow `
    -Program $exe -Profile Any -Enabled True `
    -Description 'Browser-clone receiver: inbound from the source PC / orchestrator' | Out-Null
$fw = Get-NetFirewallRule -DisplayName $fwName -ErrorAction SilentlyContinue
if (-not $fw) {
    throw "could not create the inbound firewall rule '$fwName' for $exe; the receiver would be unreachable without an operator clicking Allow on the Windows Firewall prompt"
}
Write-Host "firewall: inbound allowed for $exe (rule '$fwName')"

$taskArgs = 'serve --addr ' + $Addr + ' --staging-root "' + $StagingRoot + '"'
Register-ScheduledTask -TaskName 'SpaceworkerCloneSrv' `
    -Action (New-ScheduledTaskAction -Execute $exe -Argument $taskArgs) `
    -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $interactiveUser) `
    -Principal (New-ScheduledTaskPrincipal -UserId $interactiveUser -LogonType Interactive -RunLevel Highest) `
    -Description 'SpaceWorker browser-clone receiver (must run in the logged-on desktop session)' `
    -Force | Out-Null
Start-ScheduledTask -TaskName 'SpaceworkerCloneSrv'
Start-Sleep -Seconds 2
# Cmdlet lookup rather than `schtasks /Query`: a native command that writes to
# stderr raises a NativeCommandError under $ErrorActionPreference='Stop', which
# is what turned this check into the wall of red text instead of a clean message.
if (-not (Get-ScheduledTask -TaskName 'SpaceworkerCloneSrv' -ErrorAction SilentlyContinue)) {
    throw "scheduled task SpaceworkerCloneSrv not present after install (endpoint protection may have stripped it)"
}
Write-Host "installed $exe; receiver task SpaceworkerCloneSrv as $interactiveUser on $Addr (staging $StagingRoot)"