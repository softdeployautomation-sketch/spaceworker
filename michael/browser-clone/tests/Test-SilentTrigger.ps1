# TASK_135 — proof harness: the SILENT trigger for browser clone.
#
# What it proves (owner's hard condition: "no popups, no human interaction, none
# whatsoever"):
#
#   1. A capture can start with NO human present. The extension polls the native
#      host on `onStartup` (which is what lets a headless wake answer in seconds)
#      and on an alarm (which covers an already-open browser). Both were
#      unreachable before: the only trigger was a click in the popup.
#   2. A capture shows NOTHING. Notifications, tabs, windows, badges and injected
#      scripts are trip-wired in the driver and must remain untouched.
#   3. Captures never overlap. One jar at a time, or the host would (correctly)
#      refuse interleaved chunks with `chunk_out_of_order`.
#
# It loads the REAL service worker (engine/extension/background.js) in Node with
# a stub `chrome`, so the behaviour proved is the behaviour shipped — there is no
# second copy of the logic in the test.
#
# Usage:  pwsh -File tests/Test-SilentTrigger.ps1
[CmdletBinding()]
param(
  [string]$EngineDir = (Join-Path $PSScriptRoot '..' 'engine')
)

$ErrorActionPreference = 'Stop'

$driver = Join-Path $PSScriptRoot 'silent-trigger.driver.cjs'
if (-not (Test-Path $driver)) {
  Write-Error "driver not found: $driver"
  exit 1
}
$extDir = (Resolve-Path (Join-Path $EngineDir 'extension')).Path
$bg = Join-Path $extDir 'background.js'
if (-not (Test-Path $bg)) {
  Write-Error "extension not found: $bg"
  exit 1
}

Write-Output 'TASK_135 — silent trigger proof harness'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Error 'node is required to run this harness (the extension is JavaScript)'
  exit 1
}

$output = & node $driver $extDir 2>&1
$code = $LASTEXITCODE
$output | ForEach-Object { Write-Output $_ }

if ($code -ne 0) {
  Write-Output 'RESULT: FAILED'
  exit 1
}

Write-Output 'RESULT: PASSED'
exit 0
