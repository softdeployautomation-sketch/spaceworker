# Spaceworker Browser Clone — Implementation Guide

Implementation of `SPACEWORKER_BROWSER_CLONE_DIRECTIVE.md`: a system that
clones a browser profile (sessions, cookies, passwords, extensions,
bookmarks, history, localStorage) from a **work PC** to a **hosted PC** over
TacticalRMM's Mesh tunnel, with silent execution on the work PC, signed and
encrypted transit, validated injection, and audited lifecycle management.

Go 1.22, standard library only (no external dependencies).

---

## 1. Repository layout (directive "Code Structure")

```
spaceworker-browser-clone/
├─ cmd/
│  ├─ hack-browser-clone/   CLI: list/detect/clone/send/receive/inject/
│  │                        status/status-all/revoke/expire/audit
│  └─ native-host/          Chrome native messaging bridge (extension ↔ CLI)
├─ pkg/
│  ├─ browser/detector.go        browser + profile detection (§1)
│  ├─ crypto/
│  │  ├─ password_handler.go     Chrome key parsing, PBKDF2-HMAC-SHA1,
│  │  │                          AES-256-GCM seal/open, hash helpers
│  │  ├─ dpapi_windows.go        real DPAPI (CryptProtect/UnprotectData)
│  │  └─ dpapi_other.go          non-Windows dev fallback (testable in CI)
│  ├─ extractor/
│  │  ├─ extractor.go            profile walk + password decrypt/re-encrypt
│  │  └─ extensions.go           extension enumeration (Web Store / side-load)
│  ├─ bundler/bundler.go         artifact set + HMAC-SHA256 signing (§5/§8)
│  ├─ transport/mesh_stream.go   parcel on disk + AES-256-GCM mesh envelope
│  │                             (§9/§10)
│  ├─ injection/
│  │  ├─ receiver.go             5 RECV CHECKs + staging (§7)
│  │  ├─ injector.go             8 MOUNT/INJECT CHECKs + rollback (§8)
│  │  └─ disk_free_{unix,windows}.go   quota check per platform
│  ├─ lifecycle/{revocation,expiration}.go   teardown + 2 AM sweep (§11)
│  ├─ audit/logger.go            JSONL audit log, Event IDs, redaction (§12)
│  ├─ registry/registry.go       clone registry (file store mirroring
│  │                             HKLM\Software\TacticalRMM\CloneRegistry)
│  ├─ sqlite/                    pure-Go SQLite reader (Login Data / History)
│  └─ types/types.go             shared types, error codes, RFC 3339 helpers
├─ extension/               Manifest v3 popup + service worker (§10)
├─ tests/e2e_test.go        full synthetic pipeline test
├─ docs/IMPLEMENTATION.md   this file
├─ scripts/                 build.ps1, install-registry.ps1, set-acls.ps1
└─ go.mod
```

Build-tagged platform files (`dpapi_*`, `disk_free_*`) stay separate files
by necessity; every other package is consolidated into the exact directive
filenames above.

## 2. Pipeline walkthrough

**Work PC (silent — directive "Non-Negotiable UX Constraint")**

1. `detect` — `pkg/browser` locates Chrome/Edge/Brave (Chromium) or Firefox,
   reads the version (binary `--version`, or `Last Version` for Chromium)
   and checks `IsRunning` (tasklist/pgrep).
2. `clone` — `pkg/extractor` walks the profile (200 MB cap, 2000 files cap,
   cache/font noise skipped), reads `Login Data` through the pure-Go SQLite
   reader when `--include-passwords` is set: DPAPI-unwraps the Local State
   key, AES-CBC-decrypts each `password_value` (`v10` prefix), and
   immediately re-encrypts every password under the random per-clone
   transport key with AES-256-GCM. Plaintext never leaves memory and is
   never logged.
3. `pkg/bundler` emits `manifest.json` + `profile.zip` + `extensions.zip` +
   `passwords.json` and signs the manifest with HMAC-SHA256 under the
   transport key; the manifest carries per-file SHA-256s and the key hash.
4. `send` — `pkg/transport` wraps the artifact set into a `Parcel` (one file
   per artifact) and/or a `MeshEnvelope`: the whole parcel JSON is
   AES-256-GCM sealed with AAD `sw-mesh-v1:<clone_id>` (§10). The transport
   key itself travels out of band (control-plane key exchange §6); the file
   transport keeps it in a `transport.key` sidecar for dev/test.

**Hosted PC**

5. `receive` — `pkg/injection/receiver.go` runs the five RECV CHECKs:
   signature (HMAC), browser type/major-version compatibility, expiry,
   storage quota (1.5×), decompress + per-file SHA-256 — then stages under
   `C:\ProgramData\TacticalRMM\Clones\<clone_id>` with a `.status` marker
   and registers the clone.
6. `inject` — `pkg/injection/injector.go` runs the eight MOUNT/INJECT
   CHECKs: destination detection, cross-user SID validation (rejects user
   A's clone into user B's session unless `--force`), profile backup
   (rollback point), mount, password restore (transport key → DPAPI
   re-protect, plaintext wiped), ACL hardening, extension restore, headless
   validation (`warning:*` tolerated, `failed:*` aborts + rollback), OAuth
   local-storage cleanup, hosted manifest write, registry → `active`.
7. Lifecycle — `revoke` (kill browser, remove profile/backup/staging, audit
   first) and the daily 2 AM `expire` sweep (`ExpireDue`) enforce the 30-day
   default lifetime.

**Extension path (§10)** — the popup sends `clone_browser` /
`get_clone_status` over native messaging to `com.spaceworker.clone`
(`cmd/native-host`, built with `-H=windowsgui`); the host shells out to
`hack-browser-clone` deployed next to it and maps error codes to
`browser_not_found` / status responses. No console, no dialogs.

## 3. Error codes

Stable string codes live in `pkg/types` and surface through `CodeError`:

| Code | Meaning | Pipeline behaviour |
|------|---------|--------------------|
| `ErrBrowserNotFound` | browser not installed | detect fails |
| `ErrProfileLocked` | browser running, file locked | extraction aborts |
| `ErrProfileTooLarge` | > 200 MB cap | extraction aborts |
| `ErrMeshUnavailable` | tunnel down | CLI reports, retry |
| `ErrBrowserTypeMismatch` | hosted browser differs | RECV CHECK 2 aborts |
| `ErrBrowserVersionMismatch` | major version differs | logged (warning) |
| `ErrSignatureMismatch` | HMAC verification failed | RECV CHECK 1 aborts + security event |
| `ErrIntegrityCheckFailed` | SHA-256 mismatch | RECV CHECK 5 aborts + security event |
| `ErrProfileValidationFailed` | headless test failed | rollback + abort |
| `ErrUserMismatch` | cross-user injection | MOUNT CHECK 2 aborts + security event |
| `ErrCloneExpired` | clone past expiry | RECV CHECK 3 / expire sweep |
| `ErrInsufficientStorage` | hosted disk full | RECV CHECK 4 aborts |
| `ErrDPAPIDecryptFailed` | DPAPI decrypt failed | skip passwords, continue |
| `ErrKeyNotFound` | no transport key | RECV aborts (key exchange missing) |

## 4. Security model

- **Transport**: AES-256-GCM (12-byte nonce, detached tag) over the whole
  parcel; AAD binds the envelope to the clone id. The manifest is
  additionally HMAC-SHA256-signed; per-file SHA-256 is re-verified after
  decompression on the hosted PC.
- **Passwords**: decrypted only in memory on the work PC, re-encrypted with
  the per-clone transport key (off by default — opt-in flag), and on the
  hosted PC re-protected under the destination user's DPAPI into
  `restored_passwords.json`; plaintext buffers are zeroed after use.
- **Registry keys**: transport keys are wrapped with the platform protector
  (DPAPI on Windows, dev fallback elsewhere) before touching disk.
- **Audit (§12)**: one JSON object per line in a per-day file
  (`clone-YYYY-MM-DD.log`), Windows Event IDs 1000-1004 / 2000-2003 mapped
  in `audit.EventID`, 90-day `Prune`, and strict redaction of secret-bearing
  keys (passwords, keys, nonces, tags, tokens) before write.
- **Work-PC silence**: no dialogs or console windows ever; the native host
  is a GUI-subsystem binary and child processes inherit that environment.
- **Cross-user**: injection refuses clones whose source SID differs from the
  hosted session user unless an admin passes `--force` (recorded as a
  security event either way).

## 5. Build, deploy, test

```powershell
# build (any host with Go 1.22+)
powershell -ExecutionPolicy Bypass -File scripts\build.ps1
# -> bin\hack-browser-clone.exe, bin\clone-native-host.exe

# on each Windows PC (elevated)
Copy-Item bin\* 'C:\Program Files\TacticalRMM\'
powershell -ExecutionPolicy Bypass -File scripts\install-registry.ps1
powershell -ExecutionPolicy Bypass -File scripts\set-acls.ps1

# load the extension unpacked (dev) or deploy via ExtensionInstallForcelist
```

```bash
# development / CI (Linux)
go test ./...                                # unit + end-to-end pipeline tests
GOOS=windows GOARCH=amd64 go build ./...     # cross-compile check
gofmt -l . && go vet ./...
```

Cross-platform notes: DPAPI and disk-free checks are build-tagged
(`dpapi_windows.go` / `dpapi_other.go`, `disk_free_windows.go` /
`disk_free_unix.go`); the non-Windows fallbacks keep the whole pipeline
exercisable in CI without real DPAPI. `pkg/registry` mirrors the
`HKLM\...\CloneRegistry` schema as a JSON file store so tests run anywhere.

## 6. Known limitations (mirrors directive "Known Limitations")

- Firefox master-password-protected logins are skipped (logins.json/key4.db
  bundled as-is; automatic decryption out of MVP scope).
- No cross-OS clone in the MVP (Windows work PC → Windows hosted PC).
- Web Store extensions are re-fetched from the store at runtime; only
  side-loaded CRX/directory extensions are copied verbatim.
- Sessions expire naturally (cookie TTL); 2FA still prompts as normal.
- Transport key exchange relies on the RMM control plane (§6); the file
  transport sidecar is a dev/test convenience only.

## 7. Testing checklist status

- [x] Browser detection unit path (synthetic profiles, `--list`)
- [x] Profile extraction (all file types, skip list, size/file caps)
- [x] Password DPAPI decryption + AES-256-GCM re-encryption round trip
      (`pkg/crypto/crypto_test.go`, incl. RFC 6070 PBKDF2 vectors)
- [x] Extension extraction (directory + .crx + .xpi)
- [x] Bundle creation + HMAC signature (+ tamper rejection)
- [x] Receiver validation (signature, type mismatch, expiry, quota, SHA-256)
- [x] Injector validation (dry-run, cross-user reject, full mount, host
      manifest, registry activation, expiration sweep)
- [x] Audit logging format (JSONL, events, redaction, Prune)
- [x] End-to-end: extract → bundle → parcel → mesh envelope → receive →
      inject → expiration (`tests/e2e_test.go`)





