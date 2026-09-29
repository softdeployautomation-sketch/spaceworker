# Browser Clone — MT-1 device-side capture/restore

## What it does (two sentences)
Captures a user's browser profile (Chrome, Edge, Brave; Firefox as a fresh session only) into an encrypted archive on the work PC and restores it into a hosted SpaceWorker PC profile, headless under the Vantra agent. Includes the full production clone engine (Go) that powers transfer, validation, injection and egress-relay enforcement.

## Files
- `Invoke-BrowserClone.ps1` — contract entry: `-Browser chrome|edge|firefox -Mode capture|restore -Out <path> [-Profile <name>] [-In <archive>] [-PreferEngine]`; exit codes 0/1/2
- `lib/GcmCrypto.ps1` — AES-256-GCM via Windows CNG (BCrypt P/Invoke), correct auth-info interop, PS 5.1 + pwsh 7
- `lib/ProfilePaths.ps1` — browser/profile detection, §2 file enumeration, locked-file retry (3×/5 s → skip), capture/restore, zip-slip guard, lock scrub
- `tests/Test-Roundtrip.ps1` — self-test: GCM roundtrip, tamper rejection, wrong-key rejection, file-list, exit-code constants
- `engine/` — full `spaceworker-browser-clone` Go codebase (cmd/hack-browser-clone, cmd/relay, cmd/native-host, pkg/*, extension/, scripts/, docs/, tests/). The PowerShell layer is the MT-1 contract skin; the engine is the production pipeline (RECV CHECKs, MOUNT/INJECT CHECKs, egress relay per §13).
- `engine/README-ENGINE.md` — engine map and how Invoke-BrowserClone delegates to it with `-PreferEngine`
- `STATE-PIPE.md` — **the browser state pipe (TASK_135 §6)**: how history, bookmarks, open tabs, extensions and settings reach a clone; the two hard rules (completely silent on the work PC, AV-excluded directories); how a transfer larger than one device command still finishes; every failure name; and an exact statement of what is and is not verified.
- `BROWSER-SUPPORT.md` — **which browsers a clone can carry, layer by layer** (Chrome/Edge/Brave carriable; Firefox as a fresh session only), why a clone never runs your browser, the App-Bound-Encryption boundary that decides which half travels as files and which over CDP, and the contract check that keeps every layer's browser list from drifting.

## Usage
```
powershell -NoProfile -ExecutionPolicy Bypass -File Invoke-BrowserClone.ps1 ^
  -Browser chrome -Mode capture -Out C:\jobs\out\chrome.psa
# $env:SPACEWORKER_CLONE_KEY must be set (base64, 32 bytes) for AES-256-GCM job protection;
# without it the archive falls back to DPAPI user-scope (exit code unchanged, JSON notes it).

powershell -NoProfile -ExecutionPolicy Bypass -File Invoke-BrowserClone.ps1 ^
  -Browser chrome -Mode restore -In C:\jobs\out\chrome.psa -Out D:\HostedProfiles\chrome\Default

# full-fidelity engine path (transfer + RECV/MOUNT/INJECT CHECKs + egress relay):
...\Invoke-BrowserClone.ps1 -Browser chrome -Mode capture -Out C:\jobs\a.psa -PreferEngine

# self-test:
powershell -NoProfile -File tests\Test-Roundtrip.ps1
```
Exit codes: **0** success · **1** partial (some files skipped after lock retries) · **2** failure (bad args, missing key/profile, tamper detected, restore error).

## Inputs / outputs
- Args in: `-Browser`, `-Mode`, `-Out`, optional `-Profile`, `-In`, `-PreferEngine`.
- Env in: `SPACEWORKER_CLONE_KEY` (base64 32-byte AES-256-GCM job key; **never** written to disk, never logged).
- Files out: `.psa` archive — `"SWCLN1\0"` magic + 1 protection byte (1 = AES-256-GCM job key, 2 = DPAPI user scope) + sealed zip payload of the directive-§2 profile file set.
- Integration side (CloneJob pipeline) must provide: the job env with the key, the destination path on the hosted device, and (engine path) the transfer endpoint + relay address.
- stdout: one JSON line per operation — `op`, `browser`, `profile_dir`, `out`, `files_captured`/`files_restored`, `files_skipped`, `protected_by`, `exit_code`.

## Safety
- Never logs/emits: cookie values, passwords, decrypted secrets, key material — paths and counts only.
- Key handling: read once from env into a byte array; not persisted, not echoed; archive records only the protection mode.
- Restore is zip-slip-guarded (entries outside the destination root are dropped) and scrubs cross-OS browser lock files.
- Capture/restore staging dirs are temp + deleted in `finally` on every path, including failure.
- Tampered or wrong-key archives fail closed (GCM tag mismatch → exit 2, no partial plaintext written).

## Test evidence
- Self-test suite (`tests/Test-Roundtrip.ps1`): **32/32 PASS on pwsh 7 / Linux (run as `-WithKey` with `SPACEWORKER_CLONE_KEY` set — without `-WithKey` the GCM path is skipped and the archive falls back to DPAPI, which is Windows-only and throws on Linux)** — GCM seal/open roundtrip, tamper rejection, wrong-key rejection, the §2 file list (Preferences/Bookmarks/Sessions/Extensions), capture→restore byte-identical `Preferences`, tampered-archive fail-closed, per-browser roots and `Last Version` reads for Chrome/Edge/Brave, Firefox staying out of the Chromium map, the CDP module accepting Brave and resolving each browser's own executable, container-format constants.
- CNG note: `BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO` is pinned at its native layout (cbSize = 88 on x64 — includes `cbAAD` and `cbData` before `dwFlags`); CLR's default marshal packs this struct incorrectly, so `lib/GcmCrypto.ps1` writes it at explicit offsets. Getting this wrong yields `0xC000000D` from `BCryptEncrypt`. (The same suite exercises the Windows/PS 5.1 CNG path in `GcmCrypto.ps1`; the count above is from the pwsh 7 / Linux run, which is the environment this task could execute in.)

- **History note on that number.** This suite previously reported `ALL PASSED` and exit 0 *even while printing `FAIL` lines*: `Check` accumulated into a local `$failures` (`+=` inside a function creates a new variable), so the script-level array it tested at the end was always empty. It is now `$script:failures` on both sides, and the fix is verified by sabotage — planting a failing check yields `exit 2` and `FAILURES: sabotage.must-fail`. **Any pass count recorded before 2026-09-29 was produced by a harness that could not fail**, and one of the two bugs it hid was real (see below).
- Engine (`engine/`): full Go test suite (crypto RFC-6070 vectors, sqlite reader, injection receiver/injector, e2e pipeline) — `go build ./...` and `go test ./...` green on Linux, `GOOS=windows` cross-compile green; live-verified end-to-end: work-PC VM → hosted Linux PC, 1,988 files, egress relay parity proven (relayed and direct egress IP identical), Defender-exclusion preflight verified on the VM.
- Two bugs found in this layer on 2026-09-29, both silent by construction — the file list's `'Extensions\*'` pattern could only match loose files directly inside `Extensions\`, while every real extension lives at `Extensions\<id>\manifest.json`, so **a capture of a browser full of extensions carried none of them and still reported success**; the pattern list also hardcoded `\`, which on pwsh/Linux is an ordinary filename character and matched nothing at all. The Extensions root is now walked recursively and patterns are built with the platform separator; see `STATE-PIPE.md` §12.
- Notes for the owner: `Local State` is included in captures; on restore the DPAPI-encrypted `app_bound_encrypted` key from the source machine will not open on the hosted device — the engine's injection step already handles key re-protection per directive §8; MT-1 native-PS path captures `Login Data` but does not decrypt passwords (by contract: no plaintext secrets on device).
