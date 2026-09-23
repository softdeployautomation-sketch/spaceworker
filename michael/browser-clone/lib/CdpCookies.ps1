#requires -Version 5.1
<#
.SYNOPSIS
  Chrome-native cookie transfer via the DevTools Protocol (CDP).

.DESCRIPTION
  WHY THIS EXISTS (review finding F2, 2026-09-23):
  Modern Chrome encrypts cookie values with keys that are MACHINE-BOUND:
    v10 -> AES-GCM key stored DPAPI-wrapped in <User Data>\Local State
    v20 -> "app-bound" key (APPB blob) unwrapped by Chrome's elevation service
  Verified on Windows 11 / Chrome 153: a non-Chrome process CAN unwrap the v10
  key (DPAPI, current user) but the elevation service refuses IElevator with
  E_NOINTERFACE, so the app-bound key is NOT obtainable. Cookie values are
  therefore unreadable outside Chrome, and copying the raw Cookies database to
  another machine yields rows the destination Chrome cannot decrypt.

  The only robust, future-proof transport is to let Chrome itself do the
  cryptography:
    capture -> launch headless Chrome on the SOURCE profile, read DECRYPTED
               cookies with CDP Storage.getCookies
    restore -> launch headless Chrome on the DESTINATION profile, write them
               with CDP Storage.setCookies (Chrome re-encrypts with the
               destination's own key)

.SECURITY
  Cookie VALUES are secret session material. They exist in memory here and in
  the caller's archive, which is AES-256-GCM protected by the job key. Never
  write cookie values to the event log, stdout, or any file outside the
  encrypted archive. This module returns COUNTS only.
#>

function Get-CloneBrowserExe {
    <# Resolve the browser executable for a CDP-capable browser. #>
    param([Parameter(Mandatory = $true)][ValidateSet('chrome', 'edge')][string]$Browser)
    $candidates = if ($Browser -eq 'chrome') {
        @(
            (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
            (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
            (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
        )
    } else {
        @(
            (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
            (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
            (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
        )
    }
    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) { return $c }
    }
    return $null
}

function Get-FreeTcpPort {
    $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $l.Start()
    $port = ([System.Net.IPEndPoint]$l.LocalEndpoint).Port
    $l.Stop()
    return $port
}

function Test-CookieTransferSupport {
    <# Reports whether Chrome-native cookie transfer is possible on this host. #>
    param([ValidateSet('chrome', 'edge')][string]$Browser = 'chrome')
    $exe = Get-CloneBrowserExe -Browser $Browser
    return [pscustomobject]@{
        supported = [bool]$exe
        browser   = $Browser
        exe       = $exe
    }
}


function New-CloneUserDataDir {
    <#
      Build a throwaway Chromium user-data-dir that mirrors a captured profile so
      Chrome can open it and hand us plaintext cookies.

      Chromium layout required:
        <udd>\Local State        (the key material lives HERE, one level ABOVE the profile)
        <udd>\Default\<files>    (the profile itself)

      $ProfileDir is the profile dir (e.g. ...\User Data\Default). Its parent is
      treated as the User Data root.

      MINIMAL MODE (default for cookie transfer) copies only what Chrome needs to
      open the cookie store:
        Local State, Default\Preferences, Default\Network\Cookies(+journal)
      A full profile can be hundreds of MB (Code Cache alone was 123 MB on the
      test box) and copying it made the operation take minutes. Cookie transfer
      needs none of that.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$ProfileDir,
        [Parameter(Mandatory = $true)][string]$UserDataDir,
        [switch]$Minimal
    )
    $uddDefault = Join-Path $UserDataDir 'Default'
    New-Item -ItemType Directory -Path $uddDefault -Force | Out-Null

    $parent = Split-Path $ProfileDir -Parent
    foreach ($ls in @('Local State', 'First Run')) {
        $src = Join-Path $parent $ls
        if (Test-Path $src) {
            Copy-Item -LiteralPath $src -Destination (Join-Path $UserDataDir $ls) -Force -ErrorAction SilentlyContinue
        }
    }

    if ($Minimal) {
        # Cookie database location is version/platform dependent:
        #   modern Chromium (Windows 127+): <profile>\Network\Cookies
        #   macOS / legacy Chromium:        <profile>\Cookies
        # Copy BOTH when present — copying only one silently produced a
        # sessionless clone (review fix F2, verified 2026-09-23: a macOS profile
        # held 2373 cookies under Default\Cookies while the code looked in
        # Default\Network\Cookies and captured zero).
        foreach ($rel in @(
                'Preferences',
                'Cookies', 'Cookies-journal', 'Cookies-wal', 'Cookies-shm',
                'Network\Cookies', 'Network\Cookies-journal',
                'Network\Cookies-wal', 'Network\Cookies-shm')) {
            $src = Join-Path $ProfileDir $rel
            if (-not (Test-Path $src)) { continue }
            $dst = Join-Path $uddDefault $rel
            $dstDir = Split-Path $dst -Parent
            if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Path $dstDir -Force | Out-Null }
            Copy-Item -LiteralPath $src -Destination $dst -Force -ErrorAction SilentlyContinue
        }
        return $uddDefault
    }

    # Full mirror (used when the caller wants a complete profile copy).
    Get-ChildItem -LiteralPath $ProfileDir -Force -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.PSIsContainer -and $_.Name -match '^(Cache|Code Cache|GPUCache|DawnCache|GrShaderCache|ShaderCache|Service Worker|Application Cache)$') { return }
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $uddDefault $_.Name) -Recurse -Force -ErrorAction SilentlyContinue
    }
    return $uddDefault
}

function Start-CdpBrowser {
    <# Launch a headless Chromium with remote debugging on a throwaway user-data-dir. #>
    param(
        [Parameter(Mandatory = $true)][string]$Exe,
        [Parameter(Mandatory = $true)][string]$UserDataDir
    )
    $port = Get-FreeTcpPort
    $argList = @(
        '--headless=new',
        "--remote-debugging-port=$port",
        "--user-data-dir=$UserDataDir",
        '--remote-allow-origins=*',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-sync',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--metrics-recording-only',
        'about:blank'
    )
    $proc = Start-Process -FilePath $Exe -ArgumentList $argList -PassThru -WindowStyle Hidden
    $deadline = (Get-Date).AddSeconds(45)
    $wsUrl = $null
    while ((Get-Date) -lt $deadline) {
        if ($proc.HasExited) { break }
        try {
            $v = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 3 -ErrorAction Stop
            if ($v.webSocketDebuggerUrl) { $wsUrl = $v.webSocketDebuggerUrl; break }
        } catch { Start-Sleep -Milliseconds 400 }
    }
    if (-not $wsUrl) {
        try { if (-not $proc.HasExited) { $proc.Kill() } } catch {}
        throw "headless browser did not expose a debugging endpoint on port $port"
    }
    return [pscustomobject]@{ Process = $proc; Port = $port; WsUrl = $wsUrl }
}

function Stop-CdpBrowser {
    param([Parameter(Mandatory = $true)]$Handle)
    try {
        if ($Handle.Process -and -not $Handle.Process.HasExited) {
            $Handle.Process.Kill()
            $Handle.Process.WaitForExit(5000) | Out-Null
        }
    } catch {}
}


function Invoke-CdpCommand {
    <# One CDP round-trip over the browser-level WebSocket. Returns the raw JSON object. #>
    param(
        [Parameter(Mandatory = $true)][string]$WsUrl,
        [Parameter(Mandatory = $true)][string]$Method,
        [hashtable]$Params = @{},
        [int]$TimeoutSec = 60
    )
    $ws = New-Object System.Net.WebSockets.ClientWebSocket
    $ct = [System.Threading.CancellationToken]::None
    try {
        $ws.ConnectAsync([Uri]$WsUrl, $ct).GetAwaiter().GetResult()
        $payload = @{ id = 1; method = $Method; params = $Params } | ConvertTo-Json -Depth 15 -Compress
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
        $seg = New-Object 'System.ArraySegment[byte]' -ArgumentList @(, $bytes)
        $ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $ct).GetAwaiter().GetResult()

        $buffer = New-Object byte[] 262144
        $sb = New-Object System.Text.StringBuilder
        $deadline = (Get-Date).AddSeconds($TimeoutSec)
        while ((Get-Date) -lt $deadline) {
            $rseg = New-Object 'System.ArraySegment[byte]' -ArgumentList @(, $buffer)
            $res = $ws.ReceiveAsync($rseg, $ct).GetAwaiter().GetResult()
            if ($res.Count -gt 0) {
                [void]$sb.Append([System.Text.Encoding]::UTF8.GetString($buffer, 0, $res.Count))
            }
            if ($res.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { break }
            $text = $sb.ToString()
            if ($text.Length -gt 0 -and $text.TrimEnd().EndsWith('}')) {
                try {
                    $obj = $text | ConvertFrom-Json
                    if ($obj.PSObject.Properties.Name -contains 'id' -and $obj.id -eq 1) { return $obj }
                } catch { }
            }
        }
        throw "CDP command '$Method' produced no response within $TimeoutSec s"
    }
    finally {
        try { $ws.Dispose() } catch {}
    }
}

function Export-CdpCookies {
    <#
      Capture DECRYPTED cookies for a profile via Chrome itself.
      Writes $OutFile as JSON. Returns a summary (counts only).
    #>
    param(
        [Parameter(Mandatory = $true)][ValidateSet('chrome', 'edge')][string]$Browser,
        [Parameter(Mandatory = $true)][string]$ProfileDir,
        [Parameter(Mandatory = $true)][string]$OutFile
    )
    $exe = Get-CloneBrowserExe -Browser $Browser
    if (-not $exe) { throw "no $Browser executable found for CDP cookie export" }

    $work = Join-Path ([System.IO.Path]::GetTempPath()) ("swcdp-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $work -Force | Out-Null
    $handle = $null
    try {
        New-CloneUserDataDir -ProfileDir $ProfileDir -UserDataDir $work -Minimal | Out-Null
        $handle = Start-CdpBrowser -Exe $exe -UserDataDir $work
        $resp = Invoke-CdpCommand -WsUrl $handle.WsUrl -Method 'Storage.getCookies'
        if ($resp.PSObject.Properties.Name -contains 'error') {
            throw ("CDP Storage.getCookies failed: " + ($resp.error | ConvertTo-Json -Compress))
        }
        $cookies = @($resp.result.cookies)
        # Persist only what setCookies needs, so the archive stays deterministic.
        $keep = @('name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite', 'session')
        $slim = foreach ($c in $cookies) {
            $o = [ordered]@{}
            foreach ($k in $keep) {
                if ($c.PSObject.Properties.Name -contains $k) { $o[$k] = $c.$k }
            }
            [pscustomobject]$o
        }
        # Chrome will not persist session cookies across a restart; count them so
        # the caller can report honestly instead of silently losing sessions.
        $sessionOnly = @($slim | Where-Object { $_.session -eq $true }).Count
        $permanent = @($slim | Where-Object { $_.session -ne $true }).Count

        # Guard (review fix F2): a NON-EMPTY source cookie database that yields zero
        # readable cookies means the transfer produced a sessionless clone. Fail
        # loudly instead of writing an archive that looks fine but restores no logins.
        $srcBytes = 0
        foreach ($rel in @('Network\Cookies', 'Cookies')) {
            $p = Join-Path $ProfileDir $rel
            if (Test-Path $p) { $srcBytes += (Get-Item -LiteralPath $p).Length }
        }
        if (@($slim).Count -eq 0 -and $srcBytes -gt 10240) {
            throw ("captured 0 cookies but the source cookie database is $srcBytes bytes; refusing to emit a sessionless clone")
        }

        $json = @{
            version    = 1
            browser    = $Browser
            capturedAt = (Get-Date).ToUniversalTime().ToString('o')
            cookies    = @($slim)
        } | ConvertTo-Json -Depth 12
        $dir = Split-Path $OutFile -Parent
        if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        [System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
        return [pscustomobject]@{
            count = @($slim).Count; permanent = $permanent; session_only = $sessionOnly
            out = $OutFile; browser = $Browser
        }
    }
    finally {
        if ($handle) { Stop-CdpBrowser -Handle $handle }
        Start-Sleep -Milliseconds 300
        Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Import-CdpCookies {
    <#
      Write cookies into a destination profile via Chrome itself, so they are
      encrypted with the DESTINATION's own key. Returns counts only.
    #>
    param(
        [Parameter(Mandatory = $true)][ValidateSet('chrome', 'edge')][string]$Browser,
        [Parameter(Mandatory = $true)][string]$ProfileDir,
        [Parameter(Mandatory = $true)][string]$InFile
    )
    if (-not (Test-Path $InFile)) { throw "cookie payload not found: $InFile" }
    $exe = Get-CloneBrowserExe -Browser $Browser
    if (-not $exe) { throw "no $Browser executable found for CDP cookie import" }

    $doc = Get-Content -LiteralPath $InFile -Raw | ConvertFrom-Json
    $cookies = @($doc.cookies)
    if ($cookies.Count -eq 0) { return [pscustomobject]@{ requested = 0; set = 0; failed = 0 } }

    $work = Join-Path ([System.IO.Path]::GetTempPath()) ("swcdp-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $work -Force | Out-Null
    $handle = $null
    $set = 0; $failed = 0
    try {
        New-CloneUserDataDir -ProfileDir $ProfileDir -UserDataDir $work -Minimal | Out-Null
        $handle = Start-CdpBrowser -Exe $exe -UserDataDir $work
        # setCookies validates strictly: send only known-good fields, and give
        # SameSite=None rows an expiry (Chrome rejects None-without-expiry).
        $payload = foreach ($c in $cookies) {
            $o = [ordered]@{
                name     = [string]$c.name
                value    = [string]$c.value
                domain   = [string]$c.domain
                path     = [string]$c.path
                httpOnly = [bool]$c.httpOnly
                secure   = [bool]$c.secure
            }
            if ($c.PSObject.Properties.Name -contains 'sameSite' -and $c.sameSite) {
                $ss = [string]$c.sameSite
                if ($ss -in @('Strict', 'Lax', 'None')) { $o['sameSite'] = $ss }
            }
            $exp = $null
            if ($c.PSObject.Properties.Name -contains 'expires' -and $c.expires) { $exp = [double]$c.expires }
            if ($null -ne $exp -and $exp -gt 0) { $o['expires'] = $exp }
            if ($o.Contains('sameSite') -and $o['sameSite'] -eq 'None' -and -not $o.Contains('expires')) {
                $o['expires'] = [double]([DateTimeOffset]::UtcNow.AddDays(30).ToUnixTimeSeconds())
            }
            [pscustomobject]$o
        }
        $resp = Invoke-CdpCommand -WsUrl $handle.WsUrl -Method 'Storage.setCookies' -Params @{ cookies = @($payload) }
        if ($resp.PSObject.Properties.Name -contains 'error') {
            # Retry one-by-one so a single bad row cannot sink the batch.
            foreach ($one in $payload) {
                try {
                    $r1 = Invoke-CdpCommand -WsUrl $handle.WsUrl -Method 'Storage.setCookies' -Params @{ cookies = @($one) }
                    if ($r1.PSObject.Properties.Name -contains 'error') { $failed++ } else { $set++ }
                } catch { $failed++ }
            }
        } else {
            $set = @($payload).Count
        }
        # Give Chrome a moment to flush the cookie DB before we stop it.
        Start-Sleep -Milliseconds 800
    }
    finally {
        if ($handle) { Stop-CdpBrowser -Handle $handle }
        Start-Sleep -Milliseconds 500
        # Copy the cookie DB Chrome just wrote back into the destination profile.
        try {
            $srcNet = Join-Path (Join-Path $work 'Default') 'Network'
            $dstNet = Join-Path $ProfileDir 'Network'
            if (Test-Path $srcNet) {
                if (-not (Test-Path $dstNet)) { New-Item -ItemType Directory -Path $dstNet -Force | Out-Null }
                foreach ($f in @('Cookies', 'Cookies-journal')) {
                    $s = Join-Path $srcNet $f
                    if (Test-Path $s) { Copy-Item -LiteralPath $s -Destination (Join-Path $dstNet $f) -Force }
                }
                foreach ($stale in @("$dstNet\Cookies-wal", "$dstNet\Cookies-shm")) {
                    if (Test-Path $stale) { Remove-Item $stale -Force -ErrorAction SilentlyContinue }
                }
            }
        } catch {}
        Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    }
    return [pscustomobject]@{ requested = @($cookies).Count; set = $set; failed = $failed }
}

