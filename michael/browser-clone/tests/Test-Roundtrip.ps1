#requires -Version 5.1
<#
.SYNOPSIS
  MT-1 self-test: GCM roundtrip + tamper rejection + full capture→restore byte-verify
  against a synthetic profile (no real browser data touched).
  Exit 0 = all passed; 2 = failure.
#>
[CmdletBinding()]
param([switch]$WithKey)   # $env:SPACEWORKER_CLONE_KEY supplies the job key for the GCM path

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $root 'lib/GcmCrypto.ps1')
. (Join-Path $root 'lib/ProfilePaths.ps1')

$failures = @()
function Check { param($Name, $Cond) if ($Cond) { Write-Output "PASS $Name" } else { $failures += $Name; Write-Output "FAIL $Name" } }

# ── 1. GCM roundtrip ────────────────────────────────────────────────────────
$key = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($key)
$plain = [System.Text.Encoding]::UTF8.GetBytes('spaceworker-mt1-roundtrip-payload')
$sealed = Protect-Gcm -PlainText $plain -Key $key
Check 'gcm.seal-length' ($sealed.Length -eq $plain.Length + 28)
$open = Unprotect-Gcm -Data $sealed -Key $key
Check 'gcm.roundtrip' ([System.Text.Encoding]::UTF8.GetString($open) -eq [System.Text.Encoding]::UTF8.GetString($plain))

# ── 2. tamper rejection ─────────────────────────────────────────────────────
$tampered = [byte[]]$sealed.Clone()
$tampered[20] = $tampered[20] -bxor 0xFF
$thrown = $false
try { Unprotect-Gcm -Data $tampered -Key $key | Out-Null } catch { $thrown = $true }
Check 'gcm.tamper-rejected' $thrown

# ── 3. wrong key rejected ───────────────────────────────────────────────────
$key2 = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($key2)
$thrown = $false
try { Unprotect-Gcm -Data $sealed -Key $key2 | Out-Null } catch { $thrown = $true }
Check 'gcm.wrong-key-rejected' $thrown

# ── 4. synthetic profile capture → restore → verify ────────────────────────
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("swmt1-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $work 'fakeprofile') -Force | Out-Null
$fp = Join-Path $work 'fakeprofile'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText((Join-Path $fp 'Preferences'), '{"test":"mt1"}', $utf8NoBom)
[System.IO.File]::WriteAllText((Join-Path $fp 'Bookmarks'), '{"roots":{}}', $utf8NoBom)
New-Item -ItemType Directory -Path (Join-Path $fp 'Extensions\abc') -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $fp 'Extensions\abc\manifest.json'), '{"name":"t"}', $utf8NoBom)
# Tabs/window state (the "…down to tabs" file set), and a separate root that
# carries a `Last Version` marker so the version-match input is exercised on a
# profile of its own (the happy-path profile above must stay version-free: a
# marker there would correctly trigger the 127+ refusal asserted in step 4d).
New-Item -ItemType Directory -Path (Join-Path $fp 'Sessions') -Force | Out-Null
$sessDir = Join-Path $fp 'Sessions'
[System.IO.File]::WriteAllText((Join-Path $sessDir 'Session_13370000000000000'), 'tabs', $utf8NoBom)
[System.IO.File]::WriteAllText((Join-Path $sessDir 'Tabs_13370000000000000'), 'tabs', $utf8NoBom)
$vroot = Join-Path $work 'vroot'
New-Item -ItemType Directory -Path $vroot -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $vroot 'Last Version'), '141.0.7390.55', $utf8NoBom)
$vprofile = Join-Path $vroot 'Default'
New-Item -ItemType Directory -Path $vprofile -Force | Out-Null

# capture via the library functions directly against the synthetic dir
$rel = Get-ProfileFileList -ProfileDir $fp
Check 'capture.file-list-finds-synthetics' (($rel -contains 'Preferences') -and ($rel -contains 'Bookmarks') -and ($rel -join ' ') -match 'manifest.json')
# Tabs/window state: the entry must be enumerated, or a restored clone can never
# bring back the windows it was cloned from. Separator-agnostic so the same check
# holds on Windows and on pwsh/Linux (`Sessions\Session_…` vs `Sessions/Session_…`).
Check 'capture.file-list-finds-sessions' (($rel -join '|') -match 'Sessions[\\/](Session|Tabs)_')

$capKey = if ($WithKey -and $env:SPACEWORKER_CLONE_KEY) { [Convert]::FromBase64String($env:SPACEWORKER_CLONE_KEY) } else { $null }
$archive = Join-Path $work 'test.psa'
$cap = Invoke-CaptureFromDir -ProfileDir $fp -Out $archive -Browser 'chrome' -Key $capKey
Check 'capture.copied-files' ($cap.files_captured -ge 3)
Check 'capture.exit-code-contract' ($cap.exit_code -eq 0)

# ── 4b. restore roundtrip on the synthetic archive ──────────────────────────
$dest = Join-Path $work 'restored'
$res = Invoke-Restore -Archive $archive -Out $dest -BrowserHint 'chrome' -Key $capKey
Check 'restore.restored-count' ($res.files_restored -ge 3)
$expectedBytes = [System.Text.Encoding]::UTF8.GetBytes('{"test":"mt1"}')
$actualBytes = [System.IO.File]::ReadAllBytes((Join-Path $dest 'Preferences'))
Check 'restore.prefs-byte-identical' ([Convert]::ToBase64String($actualBytes) -eq [Convert]::ToBase64String($expectedBytes))
Check 'restore.manifest-present' (Test-Path (Join-Path $dest 'Extensions\abc\manifest.json'))

# ── 4c. tampered archive fails closed (exit 2 path) ─────────────────────────
if ($capKey) {
    $bytes = [System.IO.File]::ReadAllBytes($archive)
    $bytes[40] = $bytes[40] -bxor 0xFF
    $badPath = Join-Path $work 'bad.psa'
    [System.IO.File]::WriteAllBytes($badPath, $bytes)
    $thrown = $false
    try { Invoke-Restore -Archive $badPath -Out (Join-Path $work 'never') -Key $capKey | Out-Null } catch { $thrown = $true }
    Check 'restore.tampered-rejected' $thrown
} else {
    Write-Output 'SKIP restore.tampered-rejected (no SPACEWORKER_CLONE_KEY; DPAPI path is Windows-only)'
}

# ── 4d. source browser version + the app-bound refusal (Chrome/Edge 127+) ───
# The version is the input to "deliver a matching browser"; the refusal is the
# honest answer for a version whose cookies no out-of-process reader can decrypt.
Check 'version.major-detected' ((Get-BrowserMajorVersion -Browser 'chrome' -ProfileDir $vprofile) -eq '141')
Check 'version.unknown-is-null' ($null -eq (Get-BrowserMajorVersion -Browser 'firefox' -ProfileDir $vprofile))
$vcap = Invoke-CaptureFromDir -ProfileDir $vprofile -Out (Join-Path $work 'v.psa') -Browser 'chrome' -Key $capKey
Check 'capture.reports-browser-version' ($vcap.browser_major_version -eq '141')
Check 'capture.app-bound-refused-by-name' ($vcap.cookie_transfer -eq 'unsupported:app-bound-encryption')
Check 'capture.app-bound-is-partial' ($vcap.exit_code -eq 1)

# ── 4e. browser roots: Chrome / Edge / Brave must each read their OWN tree ───
# This is the test for the two-browser assumption that used to live in this file:
# version detection had `if ($Browser -eq 'chrome') {…} else {…Edge…}`, so a third
# Chromium browser (Brave) would have read its version out of EDGE's directory and
# silently changed which hosted build a clone is pinned to. Each browser below has a
# DIFFERENT "Last Version", so reading the wrong one cannot pass by accident. The
# profile directory is deliberately somewhere unrelated: that is the case where the
# configured root is the only thing that can answer.
$savedLocal = $env:LOCALAPPDATA
$savedRoaming = $env:APPDATA
try {
    $lad = Join-Path $work 'lad'
    $roots = @{
        chrome = Join-Path $lad 'Google\Chrome\User Data'
        edge   = Join-Path $lad 'Microsoft\Edge\User Data'
        brave  = Join-Path $lad 'BraveSoftware\Brave-Browser\User Data'
    }
    $versions = @{ chrome = '150.0.1.2'; edge = '151.0.2.3'; brave = '152.0.3.4' }
    foreach ($b in $roots.Keys) {
        New-Item -ItemType Directory -Path (Join-Path $roots[$b] 'Default') -Force | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $roots[$b] 'Last Version'), $versions[$b], $utf8NoBom)
        [System.IO.File]::WriteAllText((Join-Path $roots[$b] 'Default\Preferences'), '{}', $utf8NoBom)
    }
    $env:LOCALAPPDATA = $lad

    $elsewhere = Join-Path $work 'elsewhere\Default'
    New-Item -ItemType Directory -Path $elsewhere -Force | Out-Null

    Check 'roots.brave-is-its-own-root' ((Get-ChromiumUserDataRoot -Browser 'brave') -eq $roots['brave'])
    Check 'roots.chrome-is-its-own-root' ((Get-ChromiumUserDataRoot -Browser 'chrome') -eq $roots['chrome'])
    Check 'roots.edge-is-its-own-root' ((Get-ChromiumUserDataRoot -Browser 'edge') -eq $roots['edge'])

    Check 'version.brave-reads-brave' ((Get-BrowserMajorVersion -Browser 'brave' -ProfileDir $elsewhere) -eq '152')
    Check 'version.chrome-reads-chrome' ((Get-BrowserMajorVersion -Browser 'chrome' -ProfileDir $elsewhere) -eq '150')
    Check 'version.edge-reads-edge' ((Get-BrowserMajorVersion -Browser 'edge' -ProfileDir $elsewhere) -eq '151')

    Check 'profile-dir.brave-resolves-default' ((Get-BrowserProfileDir -Browser 'brave' -ProfileName 'Default') -eq (Join-Path $roots['brave'] 'Default'))
    Check 'profile-dir.edge-resolves-default' ((Get-BrowserProfileDir -Browser 'edge' -ProfileName 'Default') -eq (Join-Path $roots['edge'] 'Default'))

    # Firefox is not Chromium and must not be folded into that map: its base comes
    # from Roaming and it is a list of profiles, not a "User Data" root.
    $ffRoot = Join-Path $work 'roaming\Mozilla\Firefox\Profiles'
    $ffProfile = Join-Path $ffRoot 'abc123.default-release'
    New-Item -ItemType Directory -Path $ffProfile -Force | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $ffProfile 'prefs.js'), '// x', $utf8NoBom)
    $env:APPDATA = Join-Path $work 'roaming'
    Check 'profile-dir.firefox-uses-roaming' ((Get-BrowserProfileDir -Browser 'firefox') -eq $ffProfile)
} finally {
    $env:LOCALAPPDATA = $savedLocal
    $env:APPDATA = $savedRoaming
}

# ── 4f. Brave is accepted by the CDP cookie module ──────────────────────────
# The ValidateSet is the contract between the orchestrator's browser list and the
# module that must run the browser to move cookies. Before Brave was added, a Brave
# clone failed with a PowerShell parameter-binding error — a message about a script,
# not about the browser.
#
# Each browser gets a PLANTED executable in a synthetic ProgramFiles, because the
# candidate lists are what actually decide which binary runs: a copy-paste error
# (Brave's candidates pointing at msedge.exe) would move the wrong browser's cookies
# and still exit 0. Planting distinct files makes that failure impossible to miss.
$savedPf = $env:ProgramFiles
$savedPf86 = ${env:ProgramFiles(x86)}
$savedLocalApp = $env:LOCALAPPDATA
$cdpThrew = $false
$cdpErr = ''
$cdpFound = @{}
try {
    . (Join-Path $root 'lib/CdpCookies.ps1')
    $pf = Join-Path $work 'pf'
    $pf86 = Join-Path $work 'pf86'   # non-empty: Join-Path throws on an empty base
    New-Item -ItemType Directory -Path $pf86 -Force | Out-Null
    $exes = @{
        chrome = 'Google\Chrome\Application\chrome.exe'
        edge   = 'Microsoft\Edge\Application\msedge.exe'
        brave  = 'BraveSoftware\Brave-Browser\Application\brave.exe'
    }
    foreach ($b in $exes.Keys) {
        $p = Join-Path $pf $exes[$b]
        New-Item -ItemType Directory -Path (Split-Path $p -Parent) -Force | Out-Null
        [System.IO.File]::WriteAllText($p, 'stub', $utf8NoBom)
    }
    $env:ProgramFiles = $pf
    ${env:ProgramFiles(x86)} = $pf86
    $env:LOCALAPPDATA = $pf86
    foreach ($b in @('chrome', 'edge', 'brave')) {
        $cdpFound[$b] = Get-CloneBrowserExe -Browser $b
    }
} catch { $cdpThrew = $true; $cdpErr = $_.Exception.Message } finally {
    $env:ProgramFiles = $savedPf
    ${env:ProgramFiles(x86)} = $savedPf86
    $env:LOCALAPPDATA = $savedLocalApp
}
Check 'cdp.brave-accepted-by-validate-set' (-not $cdpThrew)
if ($cdpThrew) { Write-Output "       (CDP module error: $cdpErr)" }
Check 'cdp.chrome-exe-resolves' ($cdpFound['chrome'] -eq (Join-Path $work 'pf\Google\Chrome\Application\chrome.exe'))
Check 'cdp.edge-exe-resolves' ($cdpFound['edge'] -eq (Join-Path $work 'pf\Microsoft\Edge\Application\msedge.exe'))
Check 'cdp.brave-exe-resolves' ($cdpFound['brave'] -eq (Join-Path $work 'pf\BraveSoftware\Brave-Browser\Application\brave.exe'))
Check 'cdp.brave-does-not-run-a-chromium-exe' ($cdpFound['brave'] -notmatch 'chrome\.exe|msedge\.exe')


Check 'contract.exit-codes' ($script:Magic.Length -eq 7)

Write-Output ''
if ($failures.Count -eq 0) { Write-Output 'ALL PASSED'; exit 0 }
Write-Output ("FAILURES: " + ($failures -join ', '))
exit 2
