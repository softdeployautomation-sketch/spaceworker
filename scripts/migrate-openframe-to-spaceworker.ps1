<#
.SYNOPSIS
  Move a Windows device OFF the OpenFrame dashboard and ONTO SpaceWorker.

.DESCRIPTION
  TASK_177 companion script. Two phases, in order:

    1. UNREGISTER (OpenFrame): stop and delete the OpenFrame Client Service
       (service name: com.openframe.client, display name: "OpenFrame Client
       Service"), remove its install leftovers, then run the agent's own
       `openframe-client uninstall` when the binary is still present — that is
       the deregistration path that tells the OpenFrame dashboard the machine
       is gone (it is parameterless; the server URL/key are already in the
       local config). Fallbacks cover the cases where the binary or config
       was already removed.

    2. ENROLL (SpaceWorker): run the OpenFrame-style install command minted
       for OUR tenant (scripts/mint-openframe-carrier.ts renders the same
       command for the new agent), or a supplied command via -InstallCommand.

  Must run ELEVATED (admin): service delete + agent install both require it.
  Run from an elevated PowerShell:  powershell -ExecutionPolicy Bypass -File .\migrate-openframe-to-spaceworker.ps1

.NOTES
  TASK_177 hygiene: pass tenant values as ARGUMENTS at run time. Never bake
  initialKey/orgId/userId/machine-id into a committed file.
#>
[CmdletBinding()]
param(
  # OpenFrame agent binary if not on PATH / not in $HOME (default: look next
  # to the service ImagePath, then ~\openframe-client.exe).
  [string]$OpenFrameExe = "",

  # The new enroll command (full PowerShell one-liner for OUR tenant).
  # If omitted, the script only does the OpenFrame uninstall half.
  [string]$InstallCommand = "",

  # Keep the downloaded OpenFrame zip/exe for forensics instead of deleting.
  [switch]$KeepOpenFrameArtifacts
)

$ErrorActionPreference = 'Stop'

function Test-IsAdmin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdmin)) {
  Write-Error 'Not elevated. Re-run from an elevated PowerShell (admin required for service delete + install).'
  exit 1
}

$svcName = 'com.openframe.client'
$phase = 'preflight'

try {
  # ---------------------------------------------------------------- phase 1
  Write-Host "[1/2] Unregistering OpenFrame on this device..."

  $svc = Get-Service -Name $svcName -ErrorAction SilentlyContinue
  if ($svc) {
    $phase = 'stop-service'
    if ($svc.Status -ne 'Stopped') {
      Stop-Service -Name $svcName -Force -ErrorAction SilentlyContinue
      # Give SCM a moment; agents register on service stop.
      $deadline = (Get-Date).AddSeconds(30)
      while ((Get-Service -Name $svcName).Status -ne 'Stopped' -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
      }
    }
    $phase = 'delete-service'
    # Prefer the agent's own uninstall (server-side deregistration) when we
    # can find the binary from the registered ImagePath.
    if (-not $OpenFrameExe) {
      $img = (Get-CimInstance Win32_Service -Filter "Name='$svcName'").PathName
      if ($img) {
        $candidate = ($img -replace '^"|"$', '').Split(' ')[0]
        if (Test-Path $candidate) { $OpenFrameExe = $candidate }
      }
    }
    if ($OpenFrameExe -and (Test-Path $OpenFrameExe)) {
      Write-Host "  agent uninstall: $OpenFrameExe uninstall"
      & $OpenFrameExe uninstall
      if ($LASTEXITCODE -ne 0) { Write-Warning "  uninstall exited $LASTEXITCODE; falling back to sc delete" }
    }
    if (Get-Service -Name $svcName -ErrorAction SilentlyContinue) {
      & sc.exe delete $svcName | Out-Null
      Start-Sleep -Seconds 2
    }
  } else {
    Write-Host '  no com.openframe.client service present (already clean or never installed).'
  }

  # Leftovers: the agent's working dir holds config (server URL, key, device
  # id). Removing it guarantees no stale enrollment survives to re-register.
  $phase = 'cleanup'
  $leftovers = @(
    (Join-Path $env:ProgramFiles 'OpenFrame'),
    (Join-Path $env:ProgramFiles 'openframe'),
    (Join-Path $env:ProgramData 'OpenFrame'),
    (Join-Path $HOME 'openframe-client.zip'),
    (Join-Path $HOME 'openframe-client.exe'),
    (Join-Path $HOME '.openframe')
  )
  foreach ($p in $leftovers) {
    if (Test-Path $p) {
      if ($KeepOpenFrameArtifacts -and $p -match 'openframe-client\.(zip|exe)$') {
        Write-Host "  keeping $p (-KeepOpenFrameArtifacts)"
      } else {
        Remove-Item -Path $p -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "  removed $p"
      }
    }
  }

  # ---------------------------------------------------------------- phase 2
  if ($InstallCommand) {
    Write-Host '[2/2] Enrolling this device with SpaceWorker...'
    $phase = 'install'
    # Same shape as the OpenFrame dashboard script: single-line, single-quoted,
    # safe to hand to PowerShell verbatim.
    Invoke-Expression $InstallCommand
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
      Write-Error "install command exited $LASTEXITCODE"
      exit $LASTEXITCODE
    }
  } else {
    Write-Host '[2/2] No -InstallCommand supplied; OpenFrame removed, device not yet enrolled.'
    Write-Host '      Mint our command first: npx tsx scripts/mint-openframe-carrier.ts --serverUrl ... --machineId ... --initialKey ... --orgId ... --userId ...'
  }

  Write-Host 'Done. Verify in the OpenFrame dashboard (device should drop to offline/' +
    'gone) and in ours (device should appear).'
  exit 0
}
catch {
  Write-Error "MIGRATION FAILED in phase '$phase': $($_.Exception.Message)"
  # Fail closed: a half-migrated device (OpenFrame gone, us not enrolled, or
  # vice versa) must be obvious, not silent. Nonzero exit for callers.
  exit 1
}
