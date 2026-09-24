# Overlay trial probe — runs on a throwaway cloud Windows runner.
#
# Owner request 2026-09-24: test the "maintenance screen" EXE on a CLOUD Windows
# box instead of the local VM (the VM slows the Mac down). This script measures
# the two documented RED FLAGS of the supplied EXE instead of assuming them:
#
#   1. GetCursorInfo           -> is the local cursor still CURSOR_SHOWING while
#                                 the overlay runs? The EXE imports
#                                 SetSystemCursor/CreateCursor/CopyIcon/
#                                 LoadCursor + HideAllCursors/RestoreAllCursors
#                                 with an _originalCursors cache, which is the
#                                 EXACT technique rejected 3/3 in TASK_23 for
#                                 breaking technician control.
#   2. GetWindowDisplayAffinity -> did it mark itself excluded-from-capture
#                                 (0x11) or monitor-only (0x01)? That decides
#                                 whether a capture-based viewer goes black.
#
# It also dumps the top-level windows it created and takes a desktop screenshot
# so the owner can SEE the overlay without running anything on their own machine.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ExePath,
  [string]$OutDir = $env:RUNNER_TEMP,
  [int]$RunSeconds = 20
)

$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$log = Join-Path $OutDir 'overlay-trial.log'
function Say([string]$m) { $m | Tee-Object -FilePath $log -Append }

Add-Type -Namespace Trial -Name Api -MemberDefinition @'
[DllImport("user32.dll")] public static extern int GetWindowDisplayAffinity(IntPtr hWnd, out uint a);
[DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CI p);
[StructLayout(LayoutKind.Sequential)] public struct PT { public int x; public int y; }
[StructLayout(LayoutKind.Sequential)] public struct CI { public int cbSize; public int flags; public IntPtr hCursor; public PT pt; }
'@

function Probe([string]$phase) {
  Say "`n=== PROBE $phase ==="
  $ci = New-Object Trial.Api+CI
  $ci.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($ci)
  $ok = [Trial.Api]::GetCursorInfo([ref]$ci)
  Say ("CURSOR ok={0} flags={1} hCursor={2} pos={3},{4}" -f $ok, $ci.flags, $ci.hCursor, $ci.pt.x, $ci.pt.y)
  Say "  (flags bit0 = CURSOR_SHOWING; 0 means the local cursor is hidden)"
  $wins = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 }
  Say ("WINDOWED PROCESSES: {0}" -f $wins.Count)
  foreach ($p in $wins) {
    $a = 0
    $rc = [Trial.Api]::GetWindowDisplayAffinity($p.MainWindowHandle, [ref]$a)
    Say ("  {0} pid={1} aff={2} title={3}" -f $p.ProcessName, $p.Id, $a, $p.MainWindowTitle)
  }
  $target = $wins | Where-Object { $_.ProcessName -match 'SCFakeUpdate|trial' }
  if ($target) { Say ("TRIAL PROCESS VISIBLE: {0}" -f ($target | ForEach-Object { $_.ProcessName + ':' + $_.MainWindowTitle } -join ', ')) }
  else { Say 'TRIAL PROCESS NOT VISIBLE (no window handle in this session)' }
}

function Shot([string]$name) {
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($vs.X, $vs.Y, 0, 0, $bmp.Size)
    $path = Join-Path $OutDir $name
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Say ("screenshot saved: {0}" -f $path)
  } catch {
    Say ("screenshot failed: {0}" -f $_.Exception.Message)
  }
}

Say "=== ENVIRONMENT ==="
Say ("computer={0} user={1} ps={2}" -f $env:COMPUTERNAME, $env:USERNAME, $PSVersionTable.PSVersion)
Say ("exe={0} size={1}" -f $ExePath, (Get-Item $ExePath).Length)
Say ("session id={0} interactive={1}" -f (Get-Process -Id $PID).SessionId, [Environment]::UserInteractive)

Probe 'BASELINE'
Shot 'baseline.png'

Say "`n=== LAUNCHING THE TRIAL EXE ==="
$p = Start-Process -FilePath $ExePath -PassThru
Say ("started pid={0}" -f $p.Id)
Start-Sleep -Seconds $RunSeconds

Probe 'AFTER LAUNCH'

$alive = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
Say ("still running after {0}s: {1}" -f $RunSeconds, [bool]$alive)
if ($alive) {
  Say ("threads={0} workingSetMB={1}" -f $alive.Threads.Count, [math]::Round($alive.WorkingSet64 / 1MB, 1))
}

Shot 'overlay.png'

Say "`n=== CLEANUP ==="
if ($alive) { Stop-Process -Id $p.Id -Force; Start-Sleep -Seconds 3; Say 'trial process stopped' }
Probe 'AFTER KILL'
Shot 'after-kill.png'

Say "`n=== DONE ==="
