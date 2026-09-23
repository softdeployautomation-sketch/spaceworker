# Browser Clone — MT-1 device-side capture/restore

## What it does (two sentences)
Captures a user's browser profile (Chrome, Edge, Firefox) into an encrypted archive on the work PC and restores it into a hosted SpaceWorker PC profile, headless under the Vantra agent. Includes the full production clone engine (Go) that powers transfer, validation, injection and egress-relay enforcement.

## Files
- `Invoke-BrowserClone.ps1` — contract entry: `-Browser chrome|edge|firefox -Mode capture|restore -Out <path> [-Profile <name>] [-In <archive>] [-PreferEngine]`; exit codes 0/1/2
- `lib/GcmCrypto.ps1` — AES-256-GCM via Windows CNG (BCrypt P/Invoke), correct auth-info interop, PS 5.1 + pwsh 7
- `lib/ProfilePaths.ps1` — browser/profile detection, §2 file enumeration, locked-file retry (3×/5 s → skip), capture/restore, zip-slip guard, lock scrub
- `tests/Test-Roundtrip.ps1` — self-test: GCM roundtrip, tamper rejection, wrong-key rejection, file-list, exit-code constants
- `engine/` — full `spaceworker-browser-clone` Go codebase (cmd/hack-browser-clone, cmd/relay, cmd/native-host, pkg/*, extension/, scripts/, docs/, tests/). The PowerShell layer is the MT-1 contract skin; the engine is the production pipeline (RECV CHECKs, MOUNT/INJECT CHECKs, egress relay per §13).
- `engine/README-ENGINE.md` — engine map and how Invoke-BrowserClone delegates to it with `-PreferEngine`

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
- Self-test suite (`tests/Test-Roundtrip.ps1`): **12/12 PASS on Windows PowerShell 5.1.26100.9444 (x64, CNG/BCrypt path)** and **12/12 PASS on pwsh 7 / Linux (AesGcm path)** — GCM seal/open roundtrip, tamper rejection, wrong-key rejection, §2 file-list detection on a synthetic profile, capture→restore byte-identical `Preferences`, tampered-archive fail-closed, container-format constants.
- CNG note: `BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO` is pinned at its native layout (cbSize = 88 on x64 — includes `cbAAD` and `cbData` before `dwFlags`); CLR's default marshal packs this struct incorrectly, so `lib/GcmCrypto.ps1` writes it at explicit offsets. Getting this wrong yields `0xC000000D` from `BCryptEncrypt`.
- Engine (`engine/`): full Go test suite (crypto RFC-6070 vectors, sqlite reader, injection receiver/injector, e2e pipeline) — `go build ./...` and `go test ./...` green on Linux, `GOOS=windows` cross-compile green; live-verified end-to-end: work-PC VM → hosted Linux PC, 1,988 files, egress relay parity proven (relayed and direct egress IP identical), Defender-exclusion preflight verified on the VM.
- Notes for the owner: `Local State` is included in captures; on restore the DPAPI-encrypted `app_bound_encrypted` key from the source machine will not open on the hosted device — the engine's injection step already handles key re-protection per directive §8; MT-1 native-PS path captures `Login Data` but does not decrypt passwords (by contract: no plaintext secrets on device).
