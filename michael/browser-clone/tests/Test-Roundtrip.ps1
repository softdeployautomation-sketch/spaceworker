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

# ── 5. exit-code contract constants ─────────────────────────────────────────
Check 'contract.exit-codes' ($script:Magic.Length -eq 7)

Write-Output ''
if ($failures.Count -eq 0) { Write-Output 'ALL PASSED'; exit 0 }
Write-Output ("FAILURES: " + ($failures -join ', '))
exit 2
