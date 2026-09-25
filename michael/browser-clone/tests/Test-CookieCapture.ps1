#requires -Version 5.1
<#
.SYNOPSIS
  TASK_119B (B9-B) proof harness — live session capture, WITHOUT Path A.

.DESCRIPTION
  Proves the whole capture chain that does not need a browser:

    extension chunker (background.js, loaded in Node)
      -> chunked native messages (the frozen contract, <= 1 MiB each)
        -> the REAL native host (cmd/native-host, built here)
          -> the ONE assembled POST body, written to a 0600 temp file

  The POST itself is intentionally NOT sent: the server route is Path A, which
  may not be deployed. `-Serve` stands up the disposable localhost login page
  for the manual browser leg; the automated assertions below never touch a real
  account, never `WilkSF9`, and never the owner's Gmail. The ONLY credential
  used anywhere in this harness is a random token generated below for a
  localhost page.

  Asserts:
    1. the disposable cookie comes back BY NAME with a non-empty value;
    2. the count / distinct-domain inventory (payload and reply agree);
    3. NO cookie value appears in any log this harness writes;
    4. an oversized synthetic jar splits into several messages, each under the
       1 MiB framing cap, and is flagged `truncated` at the cap;
    5. every temp file holding cookies is 0600 (POSIX) and deleted at the end.

  Exit 0 = all assertions passed; 2 = at least one failed.
#>
[CmdletBinding()]
param(
    # engine/ next to tests/
    [string]$EngineDir = (Join-Path (Split-Path $PSScriptRoot -Parent) 'engine'),
    # Serve the disposable login page and wait, for the manual browser leg.
    [switch]$Serve,
    [int]$ServePort = 8791,
    # Leave the temp directory behind for debugging (never for a real run).
    [switch]$KeepTemp
)

$ErrorActionPreference = 'Stop'

$failures = New-Object System.Collections.Generic.List[string]
$logLines = New-Object System.Collections.Generic.List[string]
function Check {
    param($Name, $Cond)
    if ($Cond) {
        $script:logLines.Add("PASS $Name")
        Write-Output "PASS $Name"
    } else {
        $script:failures.Add($Name)
        $script:logLines.Add("FAIL $Name")
        Write-Output "FAIL $Name"
    }
}

function Skip {
    param($Name, $Why)
    $script:logLines.Add("SKIP $Name ($Why)")
    Write-Output "SKIP $Name ($Why)"
}

# Invoke-NativeCapture feeds one or more native messages to the real host on ONE
# process (exactly what the extension's persistent connectNative port does) and
# returns its single reply frame plus stderr. Fully qualified names are used
# throughout: Windows PowerShell 5.1 does not resolve types without them here.
function Invoke-NativeCapture {
    param(
        [Parameter(Mandatory = $true)][string]$Exe,
        [Parameter(Mandatory = $true)][string[]]$Messages,
        [string]$PayloadOut = ''
    )
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Exe
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.WorkingDirectory = [System.IO.Path]::GetDirectoryName($Exe)
    if ($PayloadOut) { $psi.EnvironmentVariables['SPACEWORKER_CLONE_PAYLOAD_OUT'] = $PayloadOut }

    $proc = [System.Diagnostics.Process]::Start($psi)
    $stdin = $proc.StandardInput.BaseStream
    foreach ($message in $Messages) {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($message)
        $lenBuf = [System.BitConverter]::GetBytes([uint32]$bytes.Length)
        $stdin.Write($lenBuf, 0, 4)
        $stdin.Write($bytes, 0, $bytes.Length)
    }
    $stdin.Flush()
    $stdin.Close()

    $reply = Read-NativeFrame -Stream $proc.StandardOutput.BaseStream
    $stderr = $proc.StandardError.ReadToEnd()
    $proc.WaitForExit(120000) | Out-Null
    return [pscustomobject]@{
        Reply    = $reply
        StdErr   = $stderr
        ExitCode = $proc.ExitCode
    }
}

# Read-NativeFrame reads one 4-byte little-endian length prefix and the JSON body
# that follows it — the native-messaging framing.
function Read-NativeFrame {
    param([Parameter(Mandatory = $true)][System.IO.Stream]$Stream)
    $lenBuf = New-Object byte[] 4
    $got = 0
    while ($got -lt 4) {
        $n = $Stream.Read($lenBuf, $got, 4 - $got)
        if ($n -le 0) { return '' }
        $got += $n
    }
    $size = [System.BitConverter]::ToUInt32($lenBuf, 0)
    $body = New-Object byte[] $size
    $got = 0
    while ($got -lt $size) {
        $n = $Stream.Read($body, $got, $size - $got)
        if ($n -le 0) { break }
        $got += $n
    }
    return [System.Text.Encoding]::UTF8.GetString($body, 0, $got)
}

function Get-FileModeOctal {
    param([Parameter(Mandatory = $true)][string]$Path)
    $mode = (& stat -c '%a' $Path 2>$null)
    if (-not $mode) { $mode = (& stat -f '%Lp' $Path 2>$null) }
    return "$mode".Trim()
}

function Test-IsWindows {
    if ($PSVersionTable.PSVersion.Major -ge 6) { return $IsWindows }
    return $true
}

# ---------------------------------------------------------------------------
# The chunk driver: loads the REAL extension chunker (background.js) in Node and
# writes the exact native messages it would send, plus a counts-only digest.
# It receives the disposable cookie's name/value and the oversize marker as
# arguments, so nothing in this file has to be string-interpolated.
# ---------------------------------------------------------------------------
$chunkDriverJs = @'
'use strict';
// Test-CookieCapture.ps1 chunk driver (TASK_119B). Writes the native messages
// the extension would send, and a COUNTS-ONLY digest — never a cookie value.
const fs = require('fs');
const path = require('path');

const extDir = process.argv[2];
const outDir = process.argv[3];
const cookieName = process.argv[4];
const cookieValue = process.argv[5];
const oversizeMarker = process.argv[6];

const bg = require(path.join(extDir, 'background.js'));
const META = { cloneJobId: 'harness-job-119b', browser: 'chrome', capturedAt: '2026-09-25T12:00:00Z' };
const checks = [];
function check(name, ok) { checks.push({ name: name, ok: !!ok }); }

function dump(name, messages) {
  const body = messages.map(function (m) { return JSON.stringify(m); }).join('\n') + '\n';
  const file = path.join(outDir, name);
  fs.writeFileSync(file, body, { mode: 0o600 });
  return file;
}

function summary(messages) {
  var cookies = [];
  messages.forEach(function (m) { cookies = cookies.concat(m.cookies); });
  var domains = {};
  var valueLength = 0;
  var hasName = false;
  cookies.forEach(function (c) {
    if (c.domain) { domains[c.domain] = true; }
    if (c.name === cookieName) {
      hasName = true;
      if (typeof c.value === 'string' && c.value.length > valueLength) { valueLength = c.value.length; }
    }
  });
  var sizes = messages.map(function (m) { return Buffer.byteLength(JSON.stringify(m), 'utf8'); });
  return {
    chunkCount: messages.length,
    maxMessageBytes: sizes.length ? Math.max.apply(null, sizes) : 0,
    totalCookies: cookies.length,
    domainCount: Object.keys(domains).length,
    truncatedLast: !!messages[messages.length - 1].truncated,
    truncatedOnlyLast: messages.slice(0, -1).every(function (m) { return !m.truncated; }),
    contiguous: messages.every(function (m, i) { return m.chunk_index === i && m.chunk_count === messages.length; }),
    commandPresent: messages.every(function (m) { return m.command === 'capture_cookies'; }),
    containsCookieName: hasName,
    disposableValueLength: valueLength
  };
}

// ---- 1. normal jar: the disposable login + two other sites ---------------
const normalJar = [
  { name: cookieName, value: cookieValue, domain: '127.0.0.1', path: '/', secure: false, httpOnly: true, sameSite: 'lax' },
  { name: 'sid', value: 'x'.repeat(40), domain: '.example.test', path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction' },
  { name: 'theme', value: 'dark', domain: '.example.test', path: '/', secure: false, httpOnly: false, sameSite: 'unspecified' },
  { name: 'pref', value: 'a', domain: 'app.example.test', path: '/', secure: true, httpOnly: false }
];
const normalMsgs = bg.chunkCookies(normalJar, META);
dump('chunks-normal.ndjson', normalMsgs);
const normal = summary(normalMsgs);

// ---- 2. oversized synthetic jar: tiny injected limits --------------------
const bigJar = [];
for (var i = 0; i < 400; i++) {
  bigJar.push({ name: 'c' + i, value: oversizeMarker + 'v'.repeat(180), domain: 'd' + (i % 5) + '.example.test', path: '/', secure: true, httpOnly: true, sameSite: 'lax' });
}
const overMsgs = bg.chunkCookies(bigJar, META, { chunkBudgetBytes: 8 * 1024, maxCaptureBytes: 32 * 1024 });
dump('chunks-oversized.ndjson', overMsgs);
const oversized = summary(overMsgs);

// ---- 3. real limits: the 1 MiB rule on a realistically big jar -----------
const realJar = [];
for (var j = 0; j < 6000; j++) {
  realJar.push({ name: 'r' + j, value: 'V'.repeat(300), domain: 'site.example.test', path: '/', secure: true, httpOnly: true });
}
const realMsgs = bg.chunkCookies(realJar, META);
const real = summary(realMsgs);

// ---- assertions made where the chunking actually happens -----------------
check('chunker.loads-and-exports', typeof bg.chunkCookies === 'function');
check('normal.chunk-count-is-1', normal.chunkCount === 1);
check('normal.command-capture-cookies', normal.commandPresent);
check('normal.not-truncated', normal.truncatedLast === false && normal.truncatedOnlyLast);
check('normal.count-4', normal.totalCookies === 4);
check('normal.domain-inventory-3', normal.domainCount === 3);
check('normal.disposable-cookie-present-by-name', normal.containsCookieName);
check('normal.disposable-value-non-empty', normal.disposableValueLength > 0);
check('oversized.chunks-multiple', oversized.chunkCount > 1);
check('oversized.contiguous-indices', oversized.contiguous);
check('oversized.truncated-flagged-on-last-only', oversized.truncatedLast && oversized.truncatedOnlyLast);
check('oversized.every-message-under-1MiB', oversized.maxMessageBytes < bg.NATIVE_MESSAGE_LIMIT_BYTES);
check('real-limits.chunks-multiple', real.chunkCount > 1);
check('real-limits.every-message-under-1MiB', real.maxMessageBytes < bg.NATIVE_MESSAGE_LIMIT_BYTES);
check('real-limits.contiguous-indices', real.contiguous);
check('real-limits.not-truncated', real.truncatedLast === false);
check('real-limits.all-6000-cookies-kept', real.totalCookies === 6000);

fs.writeFileSync(path.join(outDir, 'digest.json'), JSON.stringify({
  checks: checks,
  normal: normal,
  oversized: oversized,
  real: real,
  limitBytes: bg.NATIVE_MESSAGE_LIMIT_BYTES
}, null, 2), { mode: 0o600 });

process.exit(checks.every(function (c) { return c.ok; }) ? 0 : 2);
'@

# ---------------------------------------------------------------------------
# Small helpers used below
# ---------------------------------------------------------------------------
function Read-Messages {
    param([Parameter(Mandatory = $true)][string]$Path)
    return @(Get-Content -Path $Path | Where-Object { "$_".Trim() -ne '' })
}

function Read-Json {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-Content -Path $Path -Raw | ConvertFrom-Json)
}

function Write-LogFile {
    param([string]$Path, [string]$Text)
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

# ---------------------------------------------------------------------------
# 0. Disposable material and a private temp workdir
# ---------------------------------------------------------------------------
$onWindows = Test-IsWindows
$cookieName = 'sw_test_session_harness'
# The ONLY credential anywhere in this run: random, localhost-only, single-use.
# It is never printed, never written to a log, and the page that sets it is
# thrown away. No real account, no WilkSF9, no owner Gmail — by design.
$cookieValue = 'swtest-' + [Guid]::NewGuid().ToString('N')
$oversizeMarker = 'SW_OVERSIZE_' + [Guid]::NewGuid().ToString('N').Substring(0, 10)

$work = Join-Path ([System.IO.Path]::GetTempPath()) ('sw119b-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work -Force | Out-Null
if (-not $onWindows) { & chmod 700 $work 2>$null }
$summaryLog = Join-Path $work 'run-summary.log'
$exe = Join-Path $work ('native-host' + $(if ($onWindows) { '.exe' } else { '' }))
$normalPayload = Join-Path $work 'payload-normal.json'
$oversizePayload = Join-Path $work 'payload-oversized.json'
$normalErrLog = Join-Path $work 'host-normal.stderr.log'
$oversizeErrLog = Join-Path $work 'host-oversized.stderr.log'

Write-Output 'TASK_119B (B9-B) — live session capture proof harness'
Write-Output "workdir: $work"
Write-Output "disposable login: cookie '$cookieName' on 127.0.0.1, random value (never printed)"
Write-Output ''

# ---------------------------------------------------------------------------
# 1. Build the real native host
# ---------------------------------------------------------------------------
$buildExit = 1
if (-not (Test-Path (Join-Path $EngineDir 'go.mod'))) {
    Write-Output "engine not found at $EngineDir (expected go.mod and cmd/native-host) - pass -EngineDir"
} else {
    Push-Location $EngineDir
    try {
        & go build -o $exe ./cmd/native-host 2>$null
        $buildExit = $LASTEXITCODE
    } catch {
        Write-Output "go build could not run: $($_.Exception.Message)"
        $buildExit = 1
    } finally {
        Pop-Location
    }
}
if ($buildExit -ne 0) {
    Write-Output "go build failed - run 'go build ./...' in $EngineDir for details"
}
Check 'host.builds' ($buildExit -eq 0)
Check 'host.binary-exists' (Test-Path $exe)
if (-not (Test-Path $exe)) {
    # Nothing below can run without the host: stop with a clear message rather
    # than cascading confusing failures.
    Write-Output ''
    Write-Output 'FAILURES: the native host could not be built, so no capture could be proven'
    if (-not $KeepTemp) { Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue }
    exit 2
}

# ---------------------------------------------------------------------------
# 2. The extension side: load the REAL chunker (background.js) in Node
# ---------------------------------------------------------------------------
$driverPath = Join-Path $work 'chunk-driver.js'
Write-LogFile -Path $driverPath -Text $chunkDriverJs
& node $driverPath (Join-Path $EngineDir 'extension') $work $cookieName $cookieValue $oversizeMarker | Out-Null
$driverExit = $LASTEXITCODE
$digestPath = Join-Path $work 'digest.json'
Check 'chunker.driver-exit-0' ($driverExit -eq 0)
Check 'chunker.digest-written' (Test-Path $digestPath)
if (-not (Test-Path $digestPath)) {
    Write-Output ''
    Write-Output 'FAILURES: the extension chunker produced no messages, so there is nothing to capture'
    if (-not $KeepTemp) { Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue }
    exit 2
}

if (Test-Path $digestPath) {
    $digest = Read-Json -Path $digestPath
    foreach ($c in $digest.checks) { Check ("chunker." + $c.name) $c.ok }
}

# ---------------------------------------------------------------------------
# 3. Feed the REAL host every message the extension produced, in ONE process
#    (what the persistent connectNative port does) and assert the payload.
# ---------------------------------------------------------------------------
$payloadCount = -1
$payloadDomains = -1

$normalRun = Invoke-NativeCapture -Exe $exe `
    -Messages (Read-Messages -Path (Join-Path $work 'chunks-normal.ndjson')) `
    -PayloadOut $normalPayload
Write-LogFile -Path $normalErrLog -Text $normalRun.StdErr
Check 'host.normal-exit-0' ($normalRun.ExitCode -eq 0)
Check 'host.normal-reply-received' ($normalRun.Reply -ne '')
Check 'host.normal-payload-written' (Test-Path $normalPayload)
Check 'host.normal-stderr-empty' ($normalRun.StdErr -eq '')

if (Test-Path $normalPayload) {
    $payload = Read-Json -Path $normalPayload
    $cookies = @($payload.cookies)
    $found = @($cookies | Where-Object { $_.name -eq $cookieName })
    $domains = @($cookies | ForEach-Object { $_.domain } | Sort-Object -Unique)
    $payloadCount = $cookies.Count
    $payloadDomains = $domains.Count

    Check 'payload.keys-exact' ((@($payload.PSObject.Properties.Name) -join ',') -eq 'cloneJobId,deviceId,browser,capturedAt,cookies,truncated')
    Check 'payload.clone-job-id' ($payload.cloneJobId -eq 'harness-job-119b')
    Check 'payload.browser' ($payload.browser -eq 'chrome')
    Check 'payload.partial-jar-not-present' ($payload.cookies -ne $null -and $payload.cookies -is [array])
    Check 'payload.no-token-field' (-not ($payload.PSObject.Properties.Name -contains 'token') -and -not ($payload.PSObject.Properties.Name -contains 'liveCaptureToken'))
    Check 'payload.disposable-cookie-present-by-name' ($found.Count -eq 1)
    Check 'payload.disposable-value-non-empty' ($found.Count -eq 1 -and -not [string]::IsNullOrEmpty("$($found[0].value)"))
    Check 'payload.disposable-value-round-trips' ($found.Count -eq 1 -and "$($found[0].value)" -eq $cookieValue)
    Check 'payload.count-4' ($cookies.Count -eq 4)
    Check 'payload.domain-inventory-3' ($domains.Count -eq 3)
    Check 'payload.not-truncated' ($payload.truncated -eq $false)

    if ($onWindows) {
        Skip 'payload.file-mode-0600' 'Windows uses the install-dir ACL (scripts/set-acls.ps1), not POSIX modes'
    } else {
        Check 'payload.file-mode-0600' ((Get-FileModeOctal -Path $normalPayload) -eq '600')
    }
}

$reply = $null
if ($normalRun.Reply -ne '') { $reply = $normalRun.Reply | ConvertFrom-Json }
Check 'reply.status-success' ($null -ne $reply -and $reply.status -eq 'success')
Check 'reply.accepted-matches-payload' ($null -ne $reply -and $reply.accepted -eq $payloadCount)
Check 'reply.domains-matches-payload' ($null -ne $reply -and $reply.domains -eq $payloadDomains)
Check 'reply.no-cookie-value' (-not $normalRun.Reply.Contains($cookieValue))

# ---------------------------------------------------------------------------
# 4. The oversized synthetic jar: several messages, flagged truncated at the cap
# ---------------------------------------------------------------------------
$oversizeRun = Invoke-NativeCapture -Exe $exe `
    -Messages (Read-Messages -Path (Join-Path $work 'chunks-oversized.ndjson')) `
    -PayloadOut $oversizePayload
Write-LogFile -Path $oversizeErrLog -Text $oversizeRun.StdErr
Check 'oversized.host-exit-0' ($oversizeRun.ExitCode -eq 0)
Check 'oversized.payload-written' (Test-Path $oversizePayload)
Check 'oversized.message-count-multiple' ((Read-Messages -Path (Join-Path $work 'chunks-oversized.ndjson')).Count -gt 1)

if ($null -ne $digest) {
    Check 'oversized.chunk-count-gt-1' ($digest.oversized.chunkCount -gt 1)
    Check 'oversized.max-message-under-1MiB' ($digest.oversized.maxMessageBytes -lt $digest.limitBytes)
    Check 'oversized.truncated-flagged' ($digest.oversized.truncatedLast -eq $true)
    Check 'oversized.truncated-only-on-last' ($digest.oversized.truncatedOnlyLast -eq $true)
}

if (Test-Path $oversizePayload) {
    $big = Read-Json -Path $oversizePayload
    $bigCount = @($big.cookies).Count
    Check 'oversized.payload-truncated-flag' ($big.truncated -eq $true)
    Check 'oversized.payload-non-empty' ($bigCount -gt 0)
    Check 'oversized.payload-capped-below-jar' ($bigCount -lt 400)
    if ($oversizeRun.Reply -ne '') {
        $bigReply = $oversizeRun.Reply | ConvertFrom-Json
        Check 'oversized.reply-accepted-matches-payload' ($bigReply.accepted -eq $bigCount)
        Check 'oversized.reply-truncated-flag' ($bigReply.truncated -eq $true)
        Check 'oversized.reply-no-value' (-not $oversizeRun.Reply.Contains($oversizeMarker))
    }
}

# ---------------------------------------------------------------------------
# 5. NO cookie value in any log this harness wrote
# ---------------------------------------------------------------------------
$logFiles = @($normalErrLog, $oversizeErrLog, $digestPath, $driverPath)
$leaked = $false
foreach ($f in $logFiles) {
    if (Test-Path $f) {
        $text = [System.IO.File]::ReadAllText($f)
        if ($text.Contains($cookieValue) -or $text.Contains($oversizeMarker)) { $leaked = $true }
    }
}
Check 'logs.scanned-at-least-3-files' (@($logFiles | Where-Object { Test-Path $_ }).Count -ge 3)
Check 'logs.no-cookie-value' (-not $leaked)

# ---------------------------------------------------------------------------
# 6. Every temp file holding cookies is 0600, and gone at the end of the run
# ---------------------------------------------------------------------------
if ($onWindows) {
    Skip 'temp.cookie-files-mode-0600' 'Windows uses the install-dir ACL (scripts/set-acls.ps1), not POSIX modes'
} else {
    Check 'temp.payload-file-mode-0600' ((Get-FileModeOctal -Path $normalPayload) -eq '600')
    Check 'temp.chunk-files-mode-0600' ((Get-FileModeOctal -Path (Join-Path $work 'chunks-normal.ndjson')) -eq '600')
}

# ---------------------------------------------------------------------------
# 7. The disposable login page (manual browser leg; -Serve)
# ---------------------------------------------------------------------------
function Start-DisposableLoginPage {
    param([int]$Port, [string]$Name, [string]$Value)
    $html = '<!DOCTYPE html><html><head><title>Disposable test login</title></head><body>' +
        '<h1>Disposable test login</h1>' +
        '<p>This page exists only to set ONE throwaway cookie for 127.0.0.1. ' +
        'Never sign in with a real account here.</p>' +
        '<p>Cookie set. Open the Spaceworker extension popup and click ' +
        '&quot;Carry my current session&quot;.</p></body></html>'
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
    $listener.Start()
    Write-Output "serving the disposable login page on http://127.0.0.1:$Port/ (Ctrl+C to stop)"
    try {
        while ($true) {
            $client = $listener.AcceptTcpClient()
            try {
                $stream = $client.GetStream()
                $reader = New-Object System.IO.StreamReader($stream)
                $reader.ReadLine() | Out-Null
                $body = [System.Text.Encoding]::UTF8.GetBytes($html)
                $head = "HTTP/1.1 200 OK`r`nContent-Type: text/html; charset=utf-8`r`n" +
                    "Set-Cookie: $Name=$Value; Path=/; HttpOnly; SameSite=Lax`r`n" +
                    "Content-Length: $($body.Length)`r`nConnection: close`r`n`r`n"
                $headBytes = [System.Text.Encoding]::UTF8.GetBytes($head)
                $stream.Write($headBytes, 0, $headBytes.Length)
                $stream.Write($body, 0, $body.Length)
                $stream.Flush()
            } finally {
                $client.Close()
            }
        }
    } finally {
        $listener.Stop()
    }
}

# ---------------------------------------------------------------------------
# 8. Report, clean up, exit
# ---------------------------------------------------------------------------
Write-LogFile -Path $summaryLog -Text ($logLines -join [Environment]::NewLine)
$summaryText = [System.IO.File]::ReadAllText($summaryLog)
Check 'logs.summary-file-has-no-value' (-not ($summaryText.Contains($cookieValue) -or $summaryText.Contains($oversizeMarker)))

if ($KeepTemp) {
    Skip 'temp.deleted-after-run' '-KeepTemp was set'
} else {
    Remove-Item -Recurse -Force $work
    Check 'temp.deleted-after-run' (-not (Test-Path $work))
}

Write-Output ''
if ($failures.Count -eq 0) {
    Write-Output 'ALL PASSED'
} else {
    Write-Output ('FAILURES: ' + ($failures -join ', '))
}

if ($Serve) {
    Write-Output ''
    Write-Output '--- manual browser leg (DISPOSABLE login only) ---'
    Write-Output "1. open http://127.0.0.1:$ServePort/ in the browser that has the unpacked extension"
    Write-Output '2. open the extension popup and click "Carry my current session"'
    Write-Output '3. the popup shows the count (or a named error); the POST itself is the owner''s'
    Write-Output '   live check once Path A is deployed'
    Write-Output ''
    Start-DisposableLoginPage -Port $ServePort -Name $cookieName -Value $cookieValue
}

if ($failures.Count -eq 0) { exit 0 }
exit 2




