#requires -Version 5.1
<#
.SYNOPSIS
  Browser detection, profile file enumeration, locked-file retry, capture/restore.
  Container format (.psa): magic "SWCLN1\0" + 1 protection byte (1=AES-256-GCM job key,
  2=DPAPI user scope) + payload. Paths and counts only — never secret content.
#>

$script:Magic = [byte[]](0x53,0x57,0x43,0x4C,0x4E,0x31,0x00)  # SWCLN1\0

<#
  THE ONE PLACE that maps a Chromium browser to its "User Data" directory.

  Every function here and in CdpCookies.ps1 that needs that root reads it from this
  map. The alternative was already in this file and is the reason the map exists: one
  function had a `switch` and another had `if ($Browser -eq 'chrome') {…} else {…Edge…}`,
  so a THIRD Chromium browser would have silently resolved to Edge's directory — the
  clone would carry another browser's history and every exit code would still be 0.

  Firefox is absent by design: it is not "User Data"/`Default`, it lives under
  Roaming and it is a list of profile directories (see Get-BrowserProfileDir).
#>
$script:ChromiumUserDataSubdirs = @{
    'chrome' = 'Google\Chrome\User Data'
    'edge'   = 'Microsoft\Edge\User Data'
    'brave'  = 'BraveSoftware\Brave-Browser\User Data'
}

function Get-ChromiumUserDataRoot {
    <#
      The LOCALAPPDATA-relative "User Data" root for a Chromium browser, or $null when
      this environment has no LOCALAPPDATA (off-Windows, or a stripped service
      environment). Returning $null rather than a relative path is deliberate: the
      callers all treat "no root" as "cannot answer", never as a path to test.
    #>
    param([Parameter(Mandatory=$true)][ValidateSet('chrome','edge','brave')][string]$Browser)
    $sub = $script:ChromiumUserDataSubdirs[$Browser]
    if (-not $sub) { return $null }
    if (-not $env:LOCALAPPDATA) { return $null }
    return (Join-Path $env:LOCALAPPDATA $sub)
}

function Get-BrowserProfileDir {
    param([Parameter(Mandatory=$true)][ValidateSet('chrome','edge','brave','firefox')][string]$Browser,
          [string]$ProfileName)
    # Chromium browsers share one layout and differ only by root, so the root comes
    # from the shared map; Firefox is its own shape and is handled on its own.
    $base = $null
    if ($Browser -eq 'firefox') {
        if ($env:APPDATA) { $base = Join-Path $env:APPDATA 'Mozilla\Firefox\Profiles' }
    } else {
        $base = Get-ChromiumUserDataRoot -Browser $Browser
    }
    if (-not $base) { throw "browser profile base not resolvable for '$Browser' in this environment" }
    if (-not (Test-Path $base)) { throw "browser profile base not found: $base" }
    if ($Browser -eq 'firefox') {
        $dir = if ($ProfileName) { Join-Path $base $ProfileName } else {
            (Get-ChildItem $base -Directory |
                Where-Object { Test-Path (Join-Path $_.FullName 'prefs.js') } |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
        }
        if (-not $dir -or -not (Test-Path $dir)) { throw "no Firefox profile found under $base" }
        return $dir
    }
    $name = if ($ProfileName) { $ProfileName } else { 'Default' }
    $dir = Join-Path $base $name
    if (-not (Test-Path $dir)) { throw "profile '$name' not found under $base" }
    return $dir
}

function Get-ProfileFileList {
    <#
      Directive §2 file set. Returns paths RELATIVE TO $ProfileDir.

      REVIEW FIX F1 (2026-09-23): modern Chromium keeps the cookie database at
      <profile>\Network\Cookies (NOT <profile>\Cookies) and lives alongside the
      transport-security / trust-token stores, so the Network\ subtree must be
      enumerated. The old root-level 'Cookies' patterns are kept for legacy
      installs. Verified on Chrome 153: the previous list matched nothing and a
      capture silently contained zero cookies.
    #>
    param([Parameter(Mandatory=$true)][string]$ProfileDir)
    # Patterns are written with the PLATFORM separator rather than a hardcoded `\`.
    # On Windows (the device) this is byte-for-byte the same list as before. On
    # pwsh/Linux — where this file's tests run — a backslash is an ordinary
    # filename character, so `'Extensions\*'` matched NOTHING and a check could not
    # tell "this profile has no extensions" apart from "the separator is wrong".
    # That is the same class of silent-empty failure this function's own review fix
    # F1 was about, so it is worth removing the ambiguity.
    $sep = [System.IO.Path]::DirectorySeparatorChar
    $patterns = @(
        'Preferences', 'Secure Preferences', 'Bookmarks', 'Bookmarks.bak',
        # legacy + current Chromium cookie locations
        'Cookies', 'Cookies-journal',
        "Network${sep}*",
        'Login Data', 'Login Data-journal', 'Login Data-wal', 'Login Data-shm',
        'Web Data', 'History', 'Favicons',
        # TABS / window state. Chromium keeps the last session in
        # Sessions\Session_<ts> and Sessions\Tabs_<ts> (legacy builds used
        # root-level Current Session / Current Tabs). These carry tab, window and
        # navigation-group state and are NOT encrypted — unlike Cookies/Login
        # Data, a copy survives a machine move — so "…down to tabs" is achievable
        # by copy. They were simply absent from this list, which is why a
        # restored clone came up with an empty window.
        "Sessions${sep}*",
        'Current Session', 'Current Tabs', 'Last Session', 'Last Tabs',
        # NOTE: the Extensions root is walked RECURSIVELY further down, not by a
        # one-level pattern. `Extensions\*` can only match loose files directly
        # inside Extensions, and every real extension lives at
        # `Extensions\<id>\manifest.json` — so that pattern matched nothing, a
        # capture of a browser full of extensions carried none of them, and the
        # run still reported success. One level deeper is not enough either: an
        # extension without its payload is a broken extension, so the whole
        # subtree goes.
        "Local Storage${sep}leveldb${sep}*",
        "Session Storage${sep}*",
        "Extension State${sep}*", "Sync Extension Settings${sep}*"
    )
    $files = @()
    foreach ($p in $patterns) {
        Get-ChildItem -Path (Join-Path $ProfileDir $p) -File -ErrorAction SilentlyContinue |
            ForEach-Object { $files += $_.FullName.Substring($ProfileDir.Length + 1) }
    }
    # Extensions, recursively (see the NOTE in $patterns). Kept separate from the
    # pattern loop because a recursive walk is a different operation from a glob, and
    # folding `-Recurse` into the shared loop would also recurse Network\, Local
    # Storage\ and Session Storage\ — where the files sit directly in the root and a
    # deep walk would pull in unrelated megabytes for no gain.
    $extRoot = Join-Path $ProfileDir 'Extensions'
    if (Test-Path $extRoot) {
        Get-ChildItem -Path $extRoot -File -Recurse -ErrorAction SilentlyContinue |
            ForEach-Object { $files += $_.FullName.Substring($ProfileDir.Length + 1) }
    }
    foreach ($p in @('prefs.js','key4.db','logins.json','cookies.sqlite','cookies.sqlite-wal',
                     'places.sqlite','formhistory.sqlite','extensions.json','xulstore.json')) {
        if (Test-Path (Join-Path $ProfileDir $p)) { $files += $p }
    }
    return $files | Sort-Object -Unique
}

function Get-BrowserMajorVersion {
    <#
      The MAJOR version of a browser, or $null when it cannot be determined.

      WHY IT MATTERS (two independent consumers):
      1. Costing a file move. Chromium refuses (or silently migrates) a profile
         written by a NEWER build, and extension/Preferences formats are
         version-sensitive — so the hosted browser that a captured profile is
         restored into must be the same major version. That is the
         "detect the version, deliver a matching browser" step, and the number
         has to be captured HERE, on the device, because nothing else knows it.
      2. Cookie capture support. Windows Chrome/Edge 127+ writes `v20`
         (App-Bound-Encrypted) cookie values that NO out-of-process reader can
         decrypt — see CdpCookies.ps1's header and TASK_117 F10/F11. For those
         versions the file route is refused with a named reason instead of
         silently producing a zero-cookie archive.
    #>
    param([Parameter(Mandatory=$true)][ValidateSet('chrome','edge','brave','firefox')][string]$Browser,
          [string]$ProfileDir)
    $version = $null

    if ($Browser -eq 'firefox') {
        # compatibility.ini sits in the profile and records the version that
        # last wrote it: "LastVersion=141.0".
        if ($ProfileDir) {
            $ini = Join-Path $ProfileDir 'compatibility.ini'
            if (Test-Path $ini) {
                $m = [regex]::Match((Get-Content -LiteralPath $ini -Raw -ErrorAction SilentlyContinue),
                                    'LastVersion=(\d+(?:\.\d+)*)')
                if ($m.Success) { $version = $m.Groups[1].Value }
            }
        }
    } else {
        # `Last Version` in the User Data root is written by the browser itself
        # on every update and needs no process spawn (the engine's Go detector
        # reads it too — one convention, both layers). The configured root is
        # preferred; LOCALAPPDATA is the fallback and is absent off-Windows, so
        # it is only joined when it actually exists.
        $dirs = @()
        if ($ProfileDir) { $dirs += (Split-Path $ProfileDir -Parent) }
        # The SAME map Get-BrowserProfileDir uses. As a map rather than
        # `if chrome … else Edge`, because that branch is exactly how Brave would have
        # read its version out of EDGE's directory — and a wrong major version silently
        # changes which hosted build a clone is pinned to, which is the one thing the
        # destination refuses rather than guesses at.
        $configuredRoot = Get-ChromiumUserDataRoot -Browser $Browser
        if ($configuredRoot) { $dirs += $configuredRoot }
        foreach ($dir in $dirs) {
            $lv = Join-Path $dir 'Last Version'
            if (Test-Path $lv) {
                $m = [regex]::Match((Get-Content -LiteralPath $lv -Raw -ErrorAction SilentlyContinue),
                                    '(\d+(?:\.\d+){1,3})')
                if ($m.Success) { $version = $m.Groups[1].Value; break }
            }
        }
    }

    if (-not $version) { return $null }              # unknown is a valid answer
    return ($version -split '\.')[0]
}

function Copy-WithRetry {
    <# Locked-file policy: wait 5s, retry up to 3x, then skip (caller marks partial). #>
    param([string]$Source, [string]$Dest)
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            Copy-Item -LiteralPath $Source -Destination $Dest -Force -ErrorAction Stop
            return $true
        }
        catch [System.IO.IOException] {
            if ($attempt -eq 3) { return $false }
            Start-Sleep -Seconds 5
        }
    }
    return $false
}

function Invoke-Capture {
    param([Parameter(Mandatory=$true)][string]$Browser,
          [Parameter(Mandatory=$true)][string]$Out,
          [string]$ProfileName,
          [byte[]]$Key,
          [bool]$WithCookies = $true)
    $profileDir = Get-BrowserProfileDir -Browser $Browser -ProfileName $ProfileName
    return (Invoke-CaptureFromDir -ProfileDir $profileDir -Out $Out -Browser $Browser -Key $Key -WithCookies $WithCookies)
}

function Invoke-CaptureFromDir {
    <# Core capture pipeline against an explicit directory (platform-independent, testable). #>
    param([Parameter(Mandatory=$true)][string]$ProfileDir,
          [Parameter(Mandatory=$true)][string]$Out,
          [string]$Browser = 'chrome',
          [byte[]]$Key,
          [bool]$WithCookies = $true)
    $rel = Get-ProfileFileList -ProfileDir $profileDir
    $stage = Join-Path ([System.IO.Path]::GetTempPath()) ("swclone-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    $copied = 0; $skipped = @()
    try {
        foreach ($r in $rel) {
            $src = Join-Path $profileDir $r
            $dst = Join-Path $stage $r
            $dstDir = Split-Path $dst -Parent
            if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Path $dstDir -Force | Out-Null }
            if (Copy-WithRetry -Source $src -Dest $dst) { $copied++ } else { $skipped += $r }
        }

        # ── session/cookie transfer (review fixes F1 + F2) ──────────────────
        # `Local State` lives at the User Data ROOT (the profile's parent) and holds
        # the machine-bound key material. It is captured for reference only and is
        # deliberately NOT restored (DPAPI/app-bound keys do not survive a machine
        # move); restore ignores the whole _meta\ subtree. Its presence is also the
        # signal that this is a real Chromium layout — synthetic test profiles have
        # none, so cookie transfer is skipped for them and tests stay hermetic.
        $localState = Join-Path (Split-Path $profileDir -Parent) 'Local State'
        $metaDir = Join-Path $stage '_meta'
        if (Test-Path $localState) {
            New-Item -ItemType Directory -Path $metaDir -Force | Out-Null
            Copy-Item -LiteralPath $localState -Destination (Join-Path $metaDir 'Local State') -Force -ErrorAction SilentlyContinue
        }

        # ── source browser version (the version-match input) ────────────────
        # Captured HERE because this is the only place that can see the real
        # install. It decides (a) which browser build the hosted side must
        # present to accept this profile and (b) whether out-of-process cookie
        # capture is even possible (below).
        $majorVersion = Get-BrowserMajorVersion -Browser $Browser -ProfileDir $ProfileDir

        $cookieTransfer = 'none'
        $cookieInfo = $null
        if ($WithCookies -and @('chrome', 'edge') -contains $Browser) {
            if ($majorVersion -and [int]$majorVersion -ge 127) {
                # DECISIVE, and not a bug to work around here: Chrome/Edge 127+
                # seal cookie values with the App-Bound key (v20), released only
                # to a path-validated browser process. Any out-of-process reader
                # gets nothing, and a relocated copy makes the browser DELETE the
                # rows (TASK_117 F10/F11/F12, F4). Attempting the old export here
                # produced a silent zero-cookie archive and burned minutes
                # launching a headless browser; naming it up front is what lets
                # the console offer the route that DOES work — the live session
                # (in-browser capture via the extension, TASK_119B → CDP
                # injection). Everything else in this archive is unaffected.
                $cookieTransfer = 'unsupported:app-bound-encryption'
            } elseif (-not (Test-Path $localState)) {
                $cookieTransfer = 'skipped:no-local-state'
            } elseif (-not (Get-Command Export-CdpCookies -ErrorAction SilentlyContinue)) {
                $cookieTransfer = 'skipped:cdp-module-not-loaded'
            } else {
                try {
                    New-Item -ItemType Directory -Path $metaDir -Force | Out-Null
                    $cookieInfo = Export-CdpCookies -Browser $Browser -ProfileDir $ProfileDir `
                        -OutFile (Join-Path $metaDir 'cookies.json')
                    $cookieTransfer = 'cdp'
                } catch {
                    $cookieTransfer = 'failed:' + $_.Exception.Message
                }
            }
        }

        # The capture's own manifest: what the archive is, and the browser
        # version it came from. Reference-only (restore skips _meta\ entirely —
        # see the _meta note above), plus the same values are reported on stdout
        # so the pipeline can record them on the clone job.
        if ($majorVersion -or (Test-Path $metaDir)) {
            New-Item -ItemType Directory -Path $metaDir -Force | Out-Null
            $manifest = [pscustomobject]@{
                browser        = $Browser
                major_version  = $majorVersion
                os             = [System.Environment]::OSVersion.VersionString
                captured_at    = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                source_profile = (Split-Path $ProfileDir -Leaf)
            }
            $manifest | ConvertTo-Json -Depth 4 |
                Set-Content -LiteralPath (Join-Path $metaDir 'source-browser.json') -Encoding UTF8
        }

        $zip = "$stage.zip"
        if (Test-Path $zip) { Remove-Item $zip -Force }
        Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
        $zipBytes = [System.IO.File]::ReadAllBytes($zip)
        $protection = $null
        if ($Key) {
            $sealed = Protect-Gcm -PlainText $zipBytes -Key $Key
            $protection = 1
        }
        else {
            Add-Type -AssemblyName System.Security
            $sealed = [System.Security.Cryptography.ProtectedData]::Protect($zipBytes, $null,
                [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
            $protection = 2
        }
        $blob = New-Object byte[] ($script:Magic.Length + 1 + $sealed.Length)
        [Array]::Copy($script:Magic, 0, $blob, 0, $script:Magic.Length)
        $blob[$script:Magic.Length] = $protection
        [Array]::Copy($sealed, 0, $blob, $script:Magic.Length + 1, $sealed.Length)
        $outDir = Split-Path $Out -Parent
        if ($outDir -and -not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
        [System.IO.File]::WriteAllBytes($Out, $blob)
    }
    finally {
        Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item "$stage.zip" -Force -ErrorAction SilentlyContinue
    }

    $exit = if ($skipped.Count -gt 0) { 1 } else { 0 }
    # A failed cookie transfer means the session did not move — that is a partial
    # clone (exit 1), not a clean one.
    if ($cookieTransfer -like 'failed:*') { $exit = 1 }
    # Nor did an app-bound refusal (Chrome/Edge 127+): the archive carries
    # history/bookmarks/tabs but no session. Exit 1, with the reason named, so
    # the caller reports a partial clone instead of "done".
    if ($cookieTransfer -eq 'unsupported:app-bound-encryption') { $exit = 1 }
    # A cookie transfer that completed but moved ZERO cookies is also partial: the
    # archive restores a browser with no logins (review fix F2, 2026-09-23).
    if ($cookieTransfer -eq 'cdp' -and $cookieInfo -and $cookieInfo.count -eq 0) {
        $cookieTransfer = 'cdp-zero'
        $exit = 1
    }
    [pscustomobject]@{
        op = 'capture'; browser = $Browser; profile_dir = $ProfileDir
        out = $Out; files_captured = $copied; files_skipped = $skipped.Count
        skipped_names = $skipped; protected_by = $(if ($Key) {'aes-256-gcm'} else {'dpapi-user'})
        # The hosted side needs this to pick a matching browser build; $null
        # means "undetermined", never "assume latest".
        browser_major_version = $majorVersion
        cookie_transfer = $cookieTransfer
        cookies_captured = $(if ($cookieInfo) { $cookieInfo.count } else { 0 })
        session_cookies = $(if ($cookieInfo) { $cookieInfo.session_only } else { 0 })
        exit_code = $exit
    }
}

function Invoke-Restore {
    param([Parameter(Mandatory=$true)][string]$Archive,
          [Parameter(Mandatory=$true)][string]$Out,
          [string]$ProfileName,
          [string]$BrowserHint,
          [byte[]]$Key)
    if (-not (Test-Path $Archive)) { throw "archive not found: $Archive" }
    $blob = [System.IO.File]::ReadAllBytes($Archive)
    $mLen = $script:Magic.Length
    if ($blob.Length -lt ($mLen + 1 + 28)) { throw 'archive too short / bad container' }
    for ($i = 0; $i -lt $mLen; $i++) {
        if ($blob[$i] -ne $script:Magic[$i]) { throw 'bad magic — not a SpaceWorker clone archive' }
    }
    $protection = $blob[$mLen]
    $payload = New-Object byte[] ($blob.Length - $mLen - 1)
    [Array]::Copy($blob, $mLen + 1, $payload, 0, $payload.Length)

    $zipBytes = $null
    switch ($protection) {
        1 {
            if (-not $Key) { throw 'archive is AES-256-GCM protected; set SPACEWORKER_CLONE_KEY' }
            $zipBytes = Unprotect-Gcm -Data $payload -Key $Key
        }
        2 {
            Add-Type -AssemblyName System.Security
            $zipBytes = [System.Security.Cryptography.ProtectedData]::Unprotect($payload, $null,
                [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
        }
        default { throw "unknown protection mode $protection" }
    }

    $stage = Join-Path ([System.IO.Path]::GetTempPath()) ("swrestore-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    $restored = 0
    try {
        $zipPath = Join-Path $stage 'payload.zip'
        [System.IO.File]::WriteAllBytes($zipPath, $zipBytes)
        Expand-Archive -Path $zipPath -DestinationPath $stage -Force
        Remove-Item $zipPath -Force
        # zip-slip guard: only copy entries that stayed inside the staging root
        $root = (Resolve-Path $stage).Path
        $dest = if ($Out) { $Out } else { throw 'restore requires -Out <destination profile dir>' }
        New-Item -ItemType Directory -Path $dest -Force | Out-Null
        Get-ChildItem $stage -Recurse -File | ForEach-Object {
            $full = (Resolve-Path $_.FullName).Path
            if (-not $full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) { return }
            $rel = $full.Substring($root.Length + 1)
            # _meta\ holds reference-only artifacts (source Local State + the
            # decrypted cookie payload). Neither is restored as a file: the key
            # material is machine-bound, and cookies go back through Chrome (CDP).
            if ($rel -like '_meta\*' -or $rel -eq '_meta') { return }
            $dst = Join-Path $dest $rel
            $dstDir = Split-Path $dst -Parent
            if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Path $dstDir -Force | Out-Null }
            Copy-Item -LiteralPath $full -Destination $dst -Force
            $restored++
        }
        # scrub cross-OS browser locks (directive INJECT CHECK 1b)
        foreach ($lock in @('SingletonLock','SingletonCookie','SingletonSocket','lockfile','lock')) {
            $l = Join-Path $dest $lock
            if (Test-Path $l) { Remove-Item $l -Force }
        }

        # ── cookie re-injection through Chrome (review fixes F1 + F2) ───────
        # The copied Cookies DB is unusable on this machine (its values are
        # sealed with the SOURCE machine's key). Re-write the cookies via CDP so
        # Chrome re-encrypts them with THIS machine's key.
        $cookieTransfer = 'none'
        $cookieResult = $null
        $cookiePayload = Join-Path $stage '_meta\cookies.json'
        if (Test-Path $cookiePayload) {
            $browserForCdp = if ($BrowserHint -in @('chrome', 'edge', 'brave')) { $BrowserHint } else { 'chrome' }
            if (-not (Get-Command Import-CdpCookies -ErrorAction SilentlyContinue)) {
                $cookieTransfer = 'skipped:cdp-module-not-loaded'
            } else {
                try {
                    $cookieResult = Import-CdpCookies -Browser $browserForCdp -ProfileDir $dest -InFile $cookiePayload
                    $cookieTransfer = 'cdp'
                } catch {
                    $cookieTransfer = 'failed:' + $_.Exception.Message
                }
            }
        }
    }
    finally { Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue }

    $exit = 0
    if ($cookieTransfer -like 'failed:*') { $exit = 1 }
    [pscustomobject]@{
        op = 'restore'; browser_hint = $BrowserHint; archive = $Archive
        out = $Out; files_restored = $restored; protection = $(if ($protection -eq 1) {'aes-256-gcm'} else {'dpapi-user'})
        cookie_transfer = $cookieTransfer
        cookies_restored = $(if ($cookieResult) { $cookieResult.set } else { 0 })
        cookies_failed = $(if ($cookieResult) { $cookieResult.failed } else { 0 })
        exit_code = $exit
    }
}

