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
    <# Directive §2 file set. Returns relative paths. #>
    param([Parameter(Mandatory=$true)][string]$ProfileDir)
    $patterns = @(
        'Preferences', 'Secure Preferences', 'Bookmarks', 'Bookmarks.bak',
        'Cookies', 'Cookies-journal',
        'Login Data', 'Login Data-journal', 'Login Data-wal', 'Login Data-shm',
        'Web Data', 'History', 'Favicons',
        'Local State',
        'Extensions\*\manifest.json',
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
          [byte[]]$Key)
    $profileDir = Get-BrowserProfileDir -Browser $Browser -ProfileName $ProfileName
    return (Invoke-CaptureFromDir -ProfileDir $profileDir -Out $Out -Browser $Browser -Key $Key)
}

function Invoke-CaptureFromDir {
    <# Core capture pipeline against an explicit directory (platform-independent, testable). #>
    param([Parameter(Mandatory=$true)][string]$ProfileDir,
          [Parameter(Mandatory=$true)][string]$Out,
          [string]$Browser = 'chrome',
          [byte[]]$Key)
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
    [pscustomobject]@{
        op = 'capture'; browser = $Browser; profile_dir = $profileDir
        out = $Out; files_captured = $copied; files_skipped = $skipped.Count
        skipped_names = $skipped; protected_by = $(if ($Key) {'aes-256-gcm'} else {'dpapi-user'})
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
    }
    finally { Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue }

    [pscustomobject]@{
        op = 'restore'; browser_hint = $BrowserHint; archive = $Archive
        out = $Out; files_restored = $restored; protection = $(if ($protection -eq 1) {'aes-256-gcm'} else {'dpapi-user'})
        exit_code = 0
    }
}

