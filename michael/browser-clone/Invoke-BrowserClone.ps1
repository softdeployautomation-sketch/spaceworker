#requires -Version 5.1
<#
.SYNOPSIS
  MT-1 contract entry: browser profile capture/restore for Chrome, Edge, Firefox.
.DESCRIPTION
  Contract adapter for the SpaceWorker Browser Clone pipeline (TASK_97, "Michael MT-1 contract").
  Two execution paths:
    1. Native PowerShell capture/restore via lib/ (no build needed).
    2. Full-fidelity delegation to the compiled engine (engine/cmd/hack-browser-clone)
       when its binary is present — adds transfer, RECV/MOUNT/INJECT checks and egress relay.
  Both paths emit JSON lines (paths + counts only) and honor exit codes 0/1/2.
.SECURITY
  - AES-256-GCM key is read ONLY from $env:SPACEWORKER_CLONE_KEY (never arg, never disk).
  - stdout/logs contain paths and counts only — never cookie/password/secret content.
.EXAMPLE
  .\Invoke-BrowserClone.ps1 -Browser chrome -Mode capture -Out C:\jobs\out\chrome.psa
  .\Invoke-BrowserClone.ps1 -Browser chrome -Mode restore -In C:\jobs\out\chrome.psa
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('chrome', 'edge', 'firefox')]
    [string]$Browser,

    [Parameter(Mandatory = $true)]
    [ValidateSet('capture', 'restore')]
    [string]$Mode,

    [Parameter(Mandatory = $true)]
    [string]$Out,

    [string]$In,

    [string]$Profile,

    # Delegate to the compiled engine if present (full-fidelity pipeline).
    [switch]$PreferEngine,

    # Review fix F1/F2: transfer session cookies (Chrome/Edge) through Chrome
    # itself so they survive the machine move. On by default for the native path.
    [switch]$SkipCookies
)

$ErrorActionPreference = 'Stop'
$script:ExitCodes = @{ Success = 0; Partial = 1; Fail = 2 }
$script:KeyEnvVar = 'SPACEWORKER_CLONE_KEY'

function Write-Result {
    param([hashtable]$Data)
    ($Data | ConvertTo-Json -Compress) | Write-Output
}

function Get-CloneKey {
    <# Returns the job key as raw bytes. Never written to disk, never echoed. #>
    $b64 = [Environment]::GetEnvironmentVariable($script:KeyEnvVar)
    if ([string]::IsNullOrWhiteSpace($b64)) {
        throw "environment variable $script:KeyEnvVar is not set (AES-256-GCM key, base64, 32 bytes)"
    }
    $bytes = [Convert]::FromBase64String($b64)
    if ($bytes.Length -ne 32) {
        throw "$script:KeyEnvVar must decode to exactly 32 bytes (got $($bytes.Length))"
    }
    return $bytes
}

function Find-EngineBinary {
    $candidates = @(
        (Join-Path $PSScriptRoot 'engine\build\hack-browser-clone.exe'),
        (Join-Path $PSScriptRoot '..\..\..\engine\build\hack-browser-clone.exe')
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { return $c }
    }
    return $null
}

function Invoke-Engine {
    <# Full-fidelity path: delegate to the Go engine, map its exit code to 0/1/2. #>
    param([string]$Exe)
    $engineArgs = @()
    switch ($Mode) {
        'capture' {
            $engineArgs = @('clone', '--browser', $Browser, '--out', $Out)
            if ($Profile) { $engineArgs += @('--profile', $Profile) }
        }
        'restore' {
            if (-not $In) { throw 'restore requires -In <bundle path>' }
            $engineArgs = @('inject', '--bundle', $In, '--dest', $Out)
            if ($Profile) { $engineArgs += @('--profile', $Profile) }
        }
    }
    & $Exe @engineArgs
    $rc = $LASTEXITCODE
    # engine convention: 0 ok, non-zero fail (partial reported inside JSON)
    if ($rc -eq 0) { return $script:ExitCodes.Success } else { return $script:ExitCodes.Fail }
}

# ── main ────────────────────────────────────────────────────────────────────
try {
    . (Join-Path $PSScriptRoot 'lib/GcmCrypto.ps1')
    # CdpCookies must be loaded before ProfilePaths: the capture/restore pipeline
    # probes for Export-CdpCookies / Import-CdpCookies at runtime.
    . (Join-Path $PSScriptRoot 'lib/CdpCookies.ps1')
    . (Join-Path $PSScriptRoot 'lib/ProfilePaths.ps1')

    if ($PreferEngine) {
        $engine = Find-EngineBinary
        if ($engine) {
            $code = Invoke-Engine -Exe $engine
            exit $code
        }
        Write-Result @{ level = 'warn'; msg = 'engine binary not found; using native PowerShell path' }
    }

    # Native PowerShell path
    if ($Mode -eq 'capture') {
        if (-not $env:SPACEWORKER_CLONE_KEY) {
            # capture without a key falls back to DPAPI-only archive; key path requires env
            Write-Result @{ level = 'info'; msg = 'no job key in env; archive will be DPAPI-protected (source-user scope)' }
        }
        $key = $null
        if ($env:SPACEWORKER_CLONE_KEY) { $key = Get-CloneKey }

        $result = Invoke-Capture -Browser $Browser -Out $Out -ProfileName $Profile -Key $key -WithCookies (-not $SkipCookies)
        exit ($result.ExitCode)
    }
    else {
        if (-not $In) { throw 'restore requires -In <encrypted archive path>' }
        $key = $null
        if ($env:SPACEWORKER_CLONE_KEY) { $key = Get-CloneKey }

        $result = Invoke-Restore -Archive $In -Out $Out -ProfileName $Profile -BrowserHint $Browser -Key $key
        exit ($result.ExitCode)
    }
}
catch {
    Write-Result @{
        level = 'error'
        op    = $Mode
        msg   = $_.Exception.Message   # message text only; never inner exception payloads
    }
    exit $script:ExitCodes.Fail
}
