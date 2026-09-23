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
Copy-Item $NewExe (Join-Path $InstallDir 'hack-browser-clone.exe') -Force
$svc = Join-Path (Split-Path -Parent $NewExe) 'hack-browser-clone-svc.exe'
if (Test-Path $svc) {
    Copy-Item $svc (Join-Path $InstallDir 'hack-browser-clone-svc.exe') -Force
} else {
    Write-Warning "hack-browser-clone-svc.exe not found next to $NewExe - run scripts\\build.ps1 (task will pop a console without it)"
}

# 3. register + start the receiver as a scheduled task (GUI build, silent).
$exe = Join-Path $InstallDir 'hack-browser-clone-svc.exe'
if (-not (Test-Path $exe)) { $exe = Join-Path $InstallDir 'hack-browser-clone.exe' }
schtasks /Create /TN SpaceworkerCloneSrv /TR "`"$exe`" serve --addr $Addr --staging-root $StagingRoot" /SC ONLOGON /RL HIGHEST /F | Out-Null
schtasks /Run /TN SpaceworkerCloneSrv | Out-Null
Start-Sleep -Seconds 2
$t = schtasks /Query /TN SpaceworkerCloneSrv 2>&1
if ("$t" -notmatch 'SpaceworkerCloneSrv') {
    throw "scheduled task SpaceworkerCloneSrv not present after install (endpoint protection may have stripped it)"
}
Write-Host "installed $exe; receiver task SpaceworkerCloneSrv on $Addr (staging $StagingRoot)"