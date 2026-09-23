#requires -Version 5.1
<#
.SYNOPSIS
  Browser detection, profile file enumeration, locked-file retry, capture/restore.
  Container format (.psa): magic "SWCLN1\0" + 1 protection byte (1=AES-256-GCM job key,
  2=DPAPI user scope) + payload. Paths and counts only — never secret content.
#>

$script:Magic = [byte[]](0x53,0x57,0x43,0x4C,0x4E,0x31,0x00)  # SWCLN1\0

function Get-BrowserProfileDir {
    param([Parameter(Mandatory=$true)][ValidateSet('chrome','edge','firefox')][string]$Browser,
          [string]$ProfileName)
    $base = $null
    switch ($Browser) {
        'chrome'  { $base = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data' }
        'edge'    { $base = Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data' }
        'firefox' { $base = Join-Path $env:APPDATA 'Mozilla\Firefox\Profiles' }
    }
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
    $patterns = @(
        'Preferences', 'Secure Preferences', 'Bookmarks', 'Bookmarks.bak',
        # legacy + current Chromium cookie locations
        'Cookies', 'Cookies-journal',
        'Network\*',
        'Login Data', 'Login Data-journal', 'Login Data-wal', 'Login Data-shm',
        'Web Data', 'History', 'Favicons',
        'Extensions\*',
        'Local Storage\leveldb\*',
        'Session Storage\*',
        'Extension State\*', 'Sync Extension Settings\*'
    )
    $files = @()
    foreach ($p in $patterns) {
        Get-ChildItem -Path (Join-Path $ProfileDir $p) -File -ErrorAction SilentlyContinue |
            ForEach-Object { $files += $_.FullName.Substring($ProfileDir.Length + 1) }
    }
    foreach ($p in @('prefs.js','key4.db','logins.json','cookies.sqlite','cookies.sqlite-wal',
                     'places.sqlite','formhistory.sqlite','extensions.json','xulstore.json')) {
        if (Test-Path (Join-Path $ProfileDir $p)) { $files += $p }
    }
    return $files | Sort-Object -Unique
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

        $cookieTransfer = 'none'
        $cookieInfo = $null
        if ($WithCookies -and @('chrome', 'edge') -contains $Browser) {
            if (-not (Test-Path $localState)) {
                $cookieTransfer = 'skipped:no-local-state'
            } elseif (-not (Get-Command Export-CdpCookies -ErrorAction SilentlyContinue)) {
                $cookieTransfer = 'skipped:cdp-module-not-loaded'
            } else {
                try {
                    New-Item -ItemType Directory -Path $metaDir -Force | Out-Null
                    $cookieInfo = Export-CdpCookies -Browser $Browser -ProfileDir $profileDir `
                        -OutFile (Join-Path $metaDir 'cookies.json')
                    $cookieTransfer = 'cdp'
                } catch {
                    $cookieTransfer = 'failed:' + $_.Exception.Message
                }
            }
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
    # A cookie transfer that completed but moved ZERO cookies is also partial: the
    # archive restores a browser with no logins (review fix F2, 2026-09-23).
    if ($cookieTransfer -eq 'cdp' -and $cookieInfo -and $cookieInfo.count -eq 0) {
        $cookieTransfer = 'cdp-zero'
        $exit = 1
    }
    [pscustomobject]@{
        op = 'capture'; browser = $Browser; profile_dir = $profileDir
        out = $Out; files_captured = $copied; files_skipped = $skipped.Count
        skipped_names = $skipped; protected_by = $(if ($Key) {'aes-256-gcm'} else {'dpapi-user'})
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
            $browserForCdp = if ($BrowserHint -in @('chrome', 'edge')) { $BrowserHint } else { 'chrome' }
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

