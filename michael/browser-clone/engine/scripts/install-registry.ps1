# scripts/install-registry.ps1 — Windows deployment registration for the
# Spaceworker Browser Clone system (run elevated on the target machine).
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-registry.ps1 `
#       [-BinDir 'C:\Program Files\TacticalRMM']
#
# Performs (directive §6/§7/§11 and "Deployment Notes"):
#   1. native messaging host manifest + registration for Chrome / Edge /
#      Brave (host name must match extension/background.js:
#      com.spaceworker.clone)
#   2. HKLM\SOFTWARE\TacticalRMM\CloneRegistry — the registry key whose
#      schema pkg/registry mirrors as a file store in dev/CI
#   3. C:\ProgramData\TacticalRMM\{Clones,audit} directories
#   4. daily 02:00 scheduled task running `hack-browser-clone expire`

param(
    [string]$BinDir = 'C:\Program Files\TacticalRMM'
)

$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'install-registry.ps1 must run elevated (Administrator).'
}

$hostName = 'com.spaceworker.clone'
$hostExe  = Join-Path $BinDir 'clone-native-host.exe'
$cliExe   = Join-Path $BinDir 'hack-browser-clone.exe'
$manifest = Join-Path $BinDir ($hostName + '.json')

foreach ($exe in @($hostExe, $cliExe)) {
    if (-not (Test-Path $exe)) {
        throw "missing binary: $exe (run scripts\build.ps1 first, then copy bin\* here)"
    }
}

# --- 1. native messaging host ------------------------------------------------
# HKLM covers every interactive user; per-user installs would use HKCU.
$manifestJson = @{
    name        = $hostName
    description = 'Spaceworker Browser Clone native messaging host'
    path        = $hostExe
    type        = 'stdio'
} | ConvertTo-Json
Set-Content -Path $manifest -Value $manifestJson -Encoding ASCII

$browsers = @{
    'Google Chrome' = 'HKLM:\SOFTWARE\Google\Chrome\NativeMessagingHosts'
    'Microsoft Edge' = 'HKLM:\SOFTWARE\Microsoft\Edge\NativeMessagingHosts'
    'Brave'         = 'HKLM:\SOFTWARE\BraveSoftware\Brave-Browser\NativeMessagingHosts'
}
foreach ($browser in $browsers.GetEnumerator()) {
    $key = Join-Path $browser.Value $hostName
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name '(Default)' -Value $manifest
    Write-Host "registered $hostName for $($browser.Key)"
}

# --- 2. clone registry key (production schema; pkg/registry mirrors it) ------
New-Item -Path 'HKLM:\SOFTWARE\TacticalRMM\CloneRegistry' -Force | Out-Null

# --- 3. data directories -----------------------------------------------------
$clones = 'C:\ProgramData\TacticalRMM\Clones'
$audit  = 'C:\ProgramData\TacticalRMM\audit'
New-Item -ItemType Directory -Force -Path $clones, $audit | Out-Null

# --- 4. daily expiration sweep (directive §11: 2 AM) -------------------------
$action   = New-ScheduledTaskAction -Execute $cliExe -Argument 'expire'
$trigger  = New-ScheduledTaskTrigger -Daily -At 02:00
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName 'TacticalRMM-CloneExpiration' `
    -Description 'Tear down expired Spaceworker browser clones' `
    -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

Write-Host 'install complete:'
Write-Host "  native host manifest : $manifest"
Write-Host '  clone registry key   : HKLM\SOFTWARE\TacticalRMM\CloneRegistry'
Write-Host "  staging              : $clones"
Write-Host "  audit                : $audit"
Write-Host '  scheduled task       : TacticalRMM-CloneExpiration (daily 02:00)'
Write-Host 'next: scripts\set-acls.ps1'
