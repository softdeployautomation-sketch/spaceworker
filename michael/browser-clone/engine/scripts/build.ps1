# scripts/build.ps1 — build the Windows deliverables of the Spaceworker
# Browser Clone system (run from the repo root on any host with Go 1.22+):
#
#   powershell -ExecutionPolicy Bypass -File scripts\build.ps1
#
# Outputs (under bin\):
#   hack-browser-clone.exe   console CLI (RMM agent / admin use; stdout and
#                            stderr must stay capturable by TacticalRMM)
#   hack-relay.exe           GUI-subsystem egress relay (§13: runs as a
#                            SYSTEM scheduled task AND occasionally by hand
#                            over ssh; windowsgui guarantees no console
#                            window can ever appear on the work PC - piped
#                            stdout under ssh still works)
#   clone-native-host.exe    GUI-subsystem native messaging host (§10: never
#                            owns a console window on the work PC)
#
# The extension\ directory is loaded unpacked (or packaged as .crx) as-is.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$bin  = Join-Path $root 'bin'
New-Item -ItemType Directory -Force -Path $bin | Out-Null

$env:GOOS        = 'windows'
$env:GOARCH      = 'amd64'
$env:CGO_ENABLED = '0'

# CLI: console subsystem on purpose (RMM captures its output).
go build -trimpath -ldflags '-s -w' `
    -o (Join-Path $bin 'hack-browser-clone.exe') `
    ./cmd/hack-browser-clone
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# CLI service twin: GUI-subsystem build of the SAME code, used exclusively by
# scheduled tasks on the hosted PC (receiver ONLOGON, browser launch). A
# console-subsystem exe started by schtasks in the user session pops a
# console window on the desktop; windowsgui cannot. Interactive operators
# and RMM use the console build above.
go build -trimpath -ldflags '-s -w -H=windowsgui' `
    -o (Join-Path $bin 'hack-browser-clone-svc.exe') `
    ./cmd/hack-browser-clone
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Relay: windowsgui so no console window can ever appear on the work PC
# (directive "Non-Negotiable UX Constraint"). ssh-piped stdout still works.
go build -trimpath -ldflags '-s -w -H=windowsgui' `
    -o (Join-Path $bin 'hack-relay.exe') `
    ./cmd/relay
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Native host: windowsgui so no console window can ever appear on the work PC
# (directive "Non-Negotiable UX Constraint" — silence is mandatory; the only
# sanctioned UI is the extension popup).
go build -trimpath -ldflags '-s -w -H=windowsgui' `
    -o (Join-Path $bin 'clone-native-host.exe') `
    ./cmd/native-host
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "built: $bin\hack-browser-clone.exe"
Write-Host "built: $bin\hack-relay.exe"
Write-Host "built: $bin\clone-native-host.exe"
Write-Host "next:  scripts\install-registry.ps1 -BinDir <deploy-dir>; scripts\install-relay.ps1 <relay-exe>"
