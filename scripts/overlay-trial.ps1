# Overlay trial probe — runs on a throwaway cloud Windows runner.
#
# Owner request 2026-09-24: test the "maintenance screen" EXE on a CLOUD Windows
# box instead of the local VM (the VM slows the Mac down).
#
# Run 1 (36010676988) proved the EXE launches and survives (7 threads, 35 MB,
# alive at 20 s) and that it STEALS FOREGROUND Z-ORDER (the console title bar
# went active -> inactive). But nothing appeared in the screenshot. Two very
# different explanations:
#   (a) the overlay never painted in the cloud session (harness limitation), or
#   (b) it painted but called SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE),
#       the documented red flag that would BLACK OUT a capture-based viewer
#       (TASK_19 requires our overlay to stay visible).
# Run 1 could not tell them apart, so this script adds the two missing pieces:
#
#   CONTROL — a magenta full-screen topmost form. If its pixels show up in the
#             screenshot, capture DOES see overlays, so the absence of the EXE's
#             own overlay is real rather than a harness artifact.
#   WINDOW PROBE — EnumWindows filtered to the trial PID, reporting class,
#             rect, IsWindowVisible and GetWindowDisplayAffinity for EVERY
#             top-level window it owns. Detects the overlay even when it is
#             invisible to capture, and reads its affinity directly.
#
# Static analysis (dnfile, 2026-09-24) of the same binary: imports user32
# SetSystemCursor/CreateCursor/CopyIcon/LoadCursor/DestroyCursor with an
# _originalCursors cache + HideAllCursors/RestoreAllCursors (the exact
# global-cursor technique TASK_23 rejected 3/3), SetWindowDisplayAffinity, and a
# narrow EnumWindows sweep hiding ONLY #32768 / tooltips_class32 / SysShadow.
# No network, file, registry or process APIs (user32 + kernel32 only).
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ExePath,
  [string]$OutDir = $env:RUNNER_TEMP,
  [int]$RunSeconds = 20,
  [switch]$SkipControl
)

$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$log = Join-Path $OutDir 'overlay-trial.log'
# Write-Host + Add-Content (NOT Tee-Object): Tee-Object emits to the pipeline and
# would pollute every function's return value, which silently corrupted the
# control-overlay path in run 2 and produced a false "CONTROL PASS".
function Say([string]$m) { Write-Host $m; Add-Content -Path $log -Value $m }

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class WinProbe {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowDisplayAffinity(IntPtr h, out uint a);
  [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] public struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT pt; }

  // affinity: 0 = none, 0x01 = WDA_MONITOR, 0x11 = WDA_EXCLUDEFROMCAPTURE
  public static List<string> Windows(uint pid) {
    var outp = new List<string>();
    EnumWindows((h, l) => {
      uint p;
      GetWindowThreadProcessId(h, out p);
      if (pid != 0 && p != pid) return true;
      var cls = new StringBuilder(256); GetClassName(h, cls, 256);
      var txt = new StringBuilder(512); GetWindowText(h, txt, 512);
      RECT r; GetWindowRect(h, out r);
      uint aff = 0; try { GetWindowDisplayAffinity(h, out aff); } catch {}
      outp.Add(String.Format(
        "pid={0} hwnd=0x{1:X} visible={2} class='{3}' affinity=0x{4:X} rect=({5},{6}) {7}x{8} title=\"{9}\"",
        p, h.ToInt64(), IsWindowVisible(h), cls.ToString().Trim(), aff,
        r.L, r.T, r.R - r.L, r.B - r.T, txt.ToString()));
      return true;
    }, IntPtr.Zero);
    return outp;
  }

  public static string Cursor() {
    CURSORINFO ci = new CURSORINFO();
    ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
    bool ok = GetCursorInfo(ref ci);
    // flags: bit0 = CURSOR_SHOWING, 0x02 = CURSOR_SUPPRESSED
    return String.Format("ok={0} flags={1} showing={2} hCursor=0x{3:X} pos={4},{5}",
      ok, ci.flags, (ci.flags & 1) == 1, ci.hCursor.ToInt64(), ci.pt.x, ci.pt.y);
  }
}
'@

function Shot([string]$name) {
  try {
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($vs.X, $vs.Y, 0, 0, $bmp.Size)
    $path = Join-Path $OutDir $name
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Say ("screenshot saved: {0}" -f $path)
    return $path
  } catch {
    Say ("screenshot failed: {0}" -f $_.Exception.Message)
    return $null
  }
}

# Count near-magenta pixels: proof that the capture actually contains an overlay.
function CountMagenta([string]$path) {
  try {
    $bmp = [System.Drawing.Bitmap]::FromFile($path)
    $n = 0
    for ($y = 0; $y -lt $bmp.Height; $y += 4) {
      for ($x = 0; $x -lt $bmp.Width; $x += 4) {
        $c = $bmp.GetPixel($x, $y)
        if ($c.R -gt 235 -and $c.G -lt 30 -and $c.B -gt 235) { $n++ }
      }
    }
    $bmp.Dispose()
    return $n
  } catch {
    Say ("magenta count failed: {0}" -f $_.Exception.Message)
    return -1
  }
}

Say "=== ENVIRONMENT ==="
Say ("computer={0} user={1} ps={2}" -f $env:COMPUTERNAME, $env:USERNAME, $PSVersionTable.PSVersion)
Say ("exe={0} size={1}" -f $ExePath, (Get-Item $ExePath).Length)
Say ("session id={0} interactive={1}" -f (Get-Process -Id $PID).SessionId, [Environment]::UserInteractive)

Say "`n=== BASELINE ==="
Say ("CURSOR {0}" -f [WinProbe]::Cursor())
Shot 'baseline.png' | Out-Null

if (-not $SkipControl) {
  Say "`n=== CONTROL: can the capture see a full-screen topmost overlay? ==="
  $ctrlPath = Join-Path $env:RUNNER_TEMP 'control-overlay.ps1'
  @'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$f = New-Object System.Windows.Forms.Form
$f.FormBorderStyle = 'None'
$f.WindowState = 'Maximized'
$f.TopMost = $true
$f.BackColor = [System.Drawing.Color]::Magenta
$f.ShowInTaskbar = $false
$t = New-Object System.Windows.Forms.Timer
$t.Interval = 25000
$t.Add_Tick({ $f.Close() })
$t.Start()
[System.Windows.Forms.Application]::Run($f)
'@ | Set-Content -Path $ctrlPath -Encoding utf8
  $cp = Start-Process -FilePath 'pwsh' -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ctrlPath -PassThru
  Start-Sleep -Seconds 8
  Say "control overlay windows:"
  ([WinProbe]::Windows([uint32]$cp.Id)) | ForEach-Object { Say ("  {0}" -f $_) }
  $ctrlShot = Shot 'control.png'
  $mag = if ($ctrlShot) { CountMagenta $ctrlShot } else { -1 }
  Say ("CONTROL magenta pixels (sampled every 4px): {0}" -f $mag)
  if ($mag -gt 1000) {
    Say "CONTROL RESULT: PASS - the capture DOES see full-screen topmost overlays"
  } else {
    Say "CONTROL RESULT: FAIL - this session cannot capture overlays; EXE absence is inconclusive"
  }
  if (-not $cp.HasExited) { Stop-Process -Id $cp.Id -Force }
  Start-Sleep -Seconds 3
}

Say "`n=== LAUNCHING THE TRIAL EXE ==="
$p = Start-Process -FilePath $ExePath -PassThru
Say ("started pid={0}" -f $p.Id)
Start-Sleep -Seconds $RunSeconds

$alive = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
Say ("still running after {0}s: {1}" -f $RunSeconds, [bool]$alive)
if ($alive) { Say ("threads={0} workingSetMB={1}" -f $alive.Threads.Count, [math]::Round($alive.WorkingSet64 / 1MB, 1)) }

Say "`n=== CURSOR WHILE THE TRIAL RUNS (TASK_23 red flag) ==="
Say ("CURSOR {0}" -f [WinProbe]::Cursor())

Say "`n=== WINDOWS OWNED BY THE TRIAL EXE (finds overlays invisible to capture) ==="
$tw = [WinProbe]::Windows([uint32]$p.Id)
Say ("count={0}" -f $tw.Count)
$tw | ForEach-Object { Say ("  {0}" -f $_) }

# Verdict on the one property that decides whether this binary may ship at all.
$overlayWin = $tw | Where-Object { $_ -match 'WindowsForms10\.Window\.8' -and $_ -match 'visible=True' }
$excluded = $overlayWin | Where-Object { $_ -match 'affinity=0x11' }
$monitored = $overlayWin | Where-Object { $_ -match 'affinity=0x1 ' }
if ($excluded) {
  Say ""
  Say "VERDICT: the overlay window IS visible but affinity=0x11 (WDA_EXCLUDEFROMCAPTURE) ->"
  Say "         a capture-based technician viewer would render BLACK. Do NOT ship this binary."
  Say "         Graft only the narrow #32768/tooltips/SysShadow sweep into our own overlay."
} elseif ($monitored) {
  Say ""
  Say "VERDICT: overlay is affinity=0x1 (WDA_MONITOR) -> viewer shows black too. Do NOT ship."
} elseif ($overlayWin) {
  Say ""
  Say "VERDICT: overlay is visible and capture-visible (affinity=0, like the control) -> shippable property."
} else {
  Say ""
  Say "VERDICT: no WindowsForms overlay window found -> it did not render in this session (inconclusive)."
}

Shot 'overlay.png' | Out-Null

Say "`n=== CLEANUP ==="
if ($alive) { Stop-Process -Id $p.Id -Force; Start-Sleep -Seconds 3; Say 'trial process stopped' }
Say ("CURSOR after kill: {0}" -f [WinProbe]::Cursor())
Shot 'after-kill.png' | Out-Null
Say "`n=== DONE ==="

