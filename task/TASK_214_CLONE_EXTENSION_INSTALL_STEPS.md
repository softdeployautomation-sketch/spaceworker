# TASK_214 — STEPS (task agent record)

Task: `TASK_214_CLONE_EXTENSION_INSTALL.md` — make the one-click clone setup
install the browser extension + native messaging host per device (kill the
manual push), plus the D6 phase-2 zero-touch force-install layer.

## 0. BEFORE

- Repo: `/Users/mikeolab/spaceworker`, branch `agent/task-214-clone-extension-install`
  created from local `main` @ `067e7fdb46b7dd0a13fbd1f0a89ab7425a9ff8f1`.
- Tree clean of tracked changes before the branch was created (§3.2: docs +
  helper scripts stay untracked).
- Baseline gates (before any edit), verbatim:
  - `npx tsc --noEmit` → exit 0, **0 `error TS`** (`/tmp/t214-tsc-before.log`).
  - `npx tsx --test tests/*.test.ts` → **1538 tests / 1537 pass / 0 fail /
    1 skipped / 0 cancelled** (`/tmp/t214-tests-before.log`). The single skip
    is the known DB-gated test carried since TASK_210.
  - eslint: not run as a gate yet — the task touches TS + a Next route; run
    after edits and compare against the baseline file set.
- Key pre-existing facts (verified from source before planning):
  - `ROLE_ARTIFACTS.source` (lib/clone-setup.ts:69-78) omits
    `clone-native-host.exe` + `clone-extension.zip`; both ARE already emitted
    into `engine-dist/` + `manifest.json` by `scripts/engine-dist.mjs`
    (native host binary since TASK_213; extension zip since TASK_119A), and
    both are served 200 over the HMAC route.
  - `buildNativeHostPresenceScript()` (lib/clone-setup.ts:470-488) checks the
    exact three HKLM `NativeMessagingHosts\com.spaceworker.clone` keys that
    Path B's `install-registry.ps1:37-57` writes; the capability flip at
    :833-835 needs no change once the keys exist.
  - `install-registry.ps1` default BinDir is the WRONG `C:\Program Files\…`
    and it also registers `CloneRegistry` + an expire task → lift ONLY the
    manifest + 3-key block (§4).
  - Extension `manifest.json` has no `update_url`; no `.pem`/`.crx` exists
    anywhere in the repo; no git hooks configured (no husky, no core.hooksPath).

## 1. Plan (D1–D6 → concrete edits)

- **D1** `lib/clone-setup.ts` — append `clone-native-host.exe`,
  `clone-extension.zip` to `ROLE_ARTIFACTS.source` (after the existing order;
  `fetchChunks` auto-puts the ~7 MB exe in its own chunk).
- **D2** `buildStageScript` — after the copy loop, `Expand-Archive -Force`
  the zip into `<install>\clone-extension`, verify `manifest.json` exists
  there, emit `STEP:extension-extract OK|FAIL:…` and count failures into the
  step's existing `$bad` abort (fails loudly; re-runs idempotent via -Force).
- **D3** new `buildExtensionInstallScript()` — write
  `<install>\com.spaceworker.clone.json` (name/description/path/type stdio)
  + register the three HKLM keys with `(Default)` = manifest path, lifted
  verbatim from `install-registry.ps1:37-57`; no CloneRegistry, no expire
  task. Runs SYSTEM-side (`runAsUser: false`).
- **D4** wire into `runCloneSetup`'s source branch between the token block
  and the native-host presence check, as reported step `extension-install`.
  Posture: **best-effort, mirroring `live-capture-token`** (documented
  choice): a FAIL is pushed to the step list (never silent) but does not
  abort — the relay + capture capability stay valuable, and the follow-up
  presence check honestly reports `native host not detected` when
  registration failed. Same script also handles D6's forcelist write as its
  own step line (`extension-forcelist OK|SKIP|FAIL`).
- **D5** honest console copy: update the "Carry my session" refusal copy and
  the setup-success notice in `components/device-console.tsx` — native host
  is installed automatically now; the extension still needs one
  `Load unpacked` from `<install>\clone-extension`, **unless** the forcelist
  step reported OK (then the note says force-install instead — the copy
  self-retires when D6 goes live, per §4).
- **D6** phase 2:
  - `scripts/lib/crx3.mjs` (new, dependency-free) — CRX3 packer: RSA key →
    SPKI DER → crx_id (first 16 bytes of SHA-256) → SignedData signature →
    `Cr24` v3 container. Extension ID = a-p mapping of the crx_id hex.
  - `scripts/engine-dist.mjs` — pack `clone-extension.crx` + write
    `update.json` (Chrome `genc` format, absolute `crx_url`) **only when a
    signing key is configured** (`CLONE_EXTENSION_PEM`); missing key under
    explicit pack intent → hard abort "restore it, do not regenerate" (the
    §3 D6 build-safety guardrail — never silently generates).
  - `app/clone-ext/[file]/route.ts` (new) — deliberately PUBLIC route
    (P6b) serving exactly `update.json` + `clone-extension.crx` from
    engine-dist, no HMAC/session. Separate from `/api/clone-engine/*`.
  - forcelist policy write in the setup script under the three HKLM
    `SOFTWARE\Policies\…` keys, gated on optional env
    `CLONE_EXT_FORCELIST_URL` (unset → `SKIP:not_configured`, so nothing
    points at an undeployed CRX; owner sets it once the CRX is live).
  - `.gitignore` `*.pem`/`*.crx` + pre-commit guard
    `scripts/githooks/pre-commit` (refuses staged key material), enabled via
    repo-local `core.hooksPath`.
- **Tests** `tests/task-214-clone-extension-install.test.ts` — source-contract
  pins (role artifacts, Expand-Archive target, 3 registry paths, no
  CloneRegistry/expire leakage, wiring order, engine-dist guardrail, public
  route allowlist) + behavioral round-trip of `packCrx3` (magic/version,
  parse-back header, signature verify, stable ID, throws on bad key, never
  generates).

## 2. AFTER

All of D1–D6 + tests implemented and gated green (numbers below). No commits
made by me (§5: commit only when instructed); files sit uncommitted on the
working tree. Note: the repo is currently checked out on the shared
`agent/hidden-login-referral-security` branch (a concurrent referral-security
task's uncommitted files — `app/login/page.tsx`, `prisma/schema.prisma`,
`app/api/captcha/`, `lib/referral.ts`, `lib/captcha*.ts`,
`prisma/migrations/…_referral_security/` — are interleaved in the same tree).
My T214 files are listed explicitly at the bottom so the two tasks stay
separable.

### 2.0 Implementation progress log

- ✅ **D1** `lib/clone-setup.ts:70-82` — `ROLE_ARTIFACTS.source` now ends with
  `clone-native-host.exe`, `clone-extension.zip` (after the existing order;
  `fetchChunks` auto-chunks the ~7 MB exe).
- ✅ **D2** `buildStageScript` (:377-395) — after the copy-abort check and
  before `STEP:stage DONE`: `Remove-Item` stale `<install>\clone-extension`,
  `Expand-Archive -Force` the staged zip there, verify `manifest.json` exists
  (FAIL `manifest_json_missing` → `exit 1`), delete the zip, emit
  `STEP:extension-extract OK`. Gated on `Test-Path $zip` so the hosted role's
  stage is unaffected; re-runs are idempotent.
- ✅ **D3** new `buildExtensionInstallScript()` (:515-616) — writes
  `<install>\com.spaceworker.clone.json` (name/description/path/type=stdio),
  checks `clone-native-host.exe` exists first, registers the three HKLM
  `NativeMessagingHosts\com.spaceworker.clone` keys with `(Default)` = manifest
  path (lifted from `install-registry.ps1:37-57`; no CloneRegistry, no expire
  task; correct BinDir `C:\ProgramData\TacticalRMM\CloneTool`).
- ✅ **D3/D4 (D6 half)** same function, gated on `opts.forcelistUrl` — when
  `CLONE_EXT_FORCELIST_URL` env is set on the server, the script fetches the
  public update manifest, reads the extension id from its `genc` entry (id is
  only knowable from the persistent .pem — never guessed), and writes
  `ExtensionInstallForcelist` value `1;<id>;<url>` under the three HKLM
  `SOFTWARE\Policies\…` keys. Unset → `STEP:extension-forcelist SKIP:not_configured`.
- ✅ **D4** `runCloneSetup` source branch (:946-971) — new best-effort step
  between `live-capture-token` and the native-host presence check, mirroring
  the token posture (documented choice): FAIL is reported loudly
  (`ensureReported` covers empty output) but never aborts; the relay +
  capture capability stay installed, and the presence check below honestly
  reads absent when registration failed.
- ✅ **comments updated** — presence-check doc (:484-494) and the
  `live-capture-capability` FAIL detail (:995-996) no longer claim Path A
  cannot install the host / "until the extension is deployed".
- ✅ **D5** console copy (`components/device-console.tsx`) — `:1384-1398`
  updateHint: forceStep present → "…force-install ships, load the extension
  once from Load unpacked"; native-host FAIL → "…Re-run setup; Carry my
  session stays off"; else the plain one-Load-unpacked hint. `:3123-3126`
  carry-session blocked tooltip now names `force-install ships, load the
  extension once (chrome://extensions → Developer mode → Load unpacked)` and
  the `extensionReady`/`liveSelectable`/`· setup needed` gating at
  `:2973-3112` re-verified unchanged (still driven by `liveCaptureReady`).
- ✅ **D6** — `scripts/lib/crx3.mjs` (CRX3 packer + `updateManifestJson`),
  `scripts/engine-dist.mjs:114-148` (`CLONE_EXT_PACK === "1"` opt-in; reads
  the persistent .pem at `CLONE_EXT_SIGNING_KEY` or the documented default;
  **aborts loudly** `restore it, do not regenerate` when absent — never
  generates a key; emits `clone-extension.crx` + `clone-ext-update.json`),
  `app/clone-ext/[file]/route.ts` (public allowlist: exactly
  `clone-extension.crx` + `clone-ext-update.json`, CORS header, no session),
  `.gitignore` (`*.pem`/`*.crx`), `scripts/githooks/pre-commit` (refuses to
  stage any `.pem`/`.crx`, `exit 1`). `core.hooksPath` set to
  `scripts/githooks` (repo-local git config, not committed).
- ✅ **Tests** `tests/task-214-clone-extension-install.test.ts` — 11 tests,
  **11/11 pass**: behavioural CRX3 verification (independent protobuf parse,
  crx_id = sha256(SPKI)[0..16], RSA-SHA256 over `CRX3 SignedData\0` +
  varint + SignedData re-verified, a..p id re-derived), determinism/id-
  stability, non-RSA & empty-payload refusal, `updateManifestJson` genc
  shape, + 6 source-contract pins (engine-dist guardrail, artifact list,
  public-route allowlist, pem/crx git-refusal, forcelist wiring, native-host
  registration).
### 2.1 Gates (after edits, verbatim)

- `npx tsc --noEmit` → **exit 0, 0 `error TS`** (`/tmp/t214-tsc-after.log`).
- `npx tsx --test tests/*.test.ts` → **1549 tests / 1548 pass / 0 fail /
  1 skipped / 0 cancelled** (`/tmp/t214-tests-final.log`). Arithmetic check:
  1538 baseline + 11 new t214 = 1549 → **zero regressions**; the single skip
  is the same known DB-gated test present in the BEFORE baseline.
- New `tests/task-214-clone-extension-install.test.ts` standalone →
  **11/11 pass**.
- `npx eslint tests/task-214-clone-extension-install.test.ts
  lib/clone-setup.ts 'app/clone-ext/[file]/route.ts'` → **0 errors**; 1
  pre-existing warning (`'hostedAvailableForUser' is defined but never used`
  at `lib/clone-setup.ts:724`) that is NOT from my edits — left untouched.

### 2.2 File inventory (mine vs. the concurrent referral-security task)

My TASK_214 files (all currently uncommitted on the shared working tree):

- Modified: `lib/clone-setup.ts`, `components/device-console.tsx`,
  `scripts/engine-dist.mjs`, `.gitignore`.
- New: `scripts/lib/crx3.mjs`, `app/clone-ext/[file]/route.ts`,
  `scripts/githooks/pre-commit`, `tests/task-214-clone-extension-install.test.ts`.
- Untracked doc (§3.2): `TASK_214_CLONE_EXTENSION_INSTALL_STEPS.md`.
- Repo-local (not a file change): `git config core.hooksPath scripts/githooks`.

NOT mine — a concurrent `agent/hidden-login-referral-security` task's
uncommitted work sharing this tree (do not fold into any T214 commit):
`app/login/page.tsx`, `prisma/schema.prisma`, `app/api/captcha/`,
`app/r/[code]/`, `components/captcha-grid.tsx`, `lib/captcha.ts`,
`lib/captcha-seed.ts`, `lib/referral.ts`,
`prisma/migrations/20261123000000_referral_security/`, and the many
`scripts/*.sh` helper files unrelated to T214.