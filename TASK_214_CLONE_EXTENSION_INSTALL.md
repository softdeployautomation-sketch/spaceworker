# TASK_214 — Dynamic per-device browser-extension install (kill the manual push)

**Owner request 2026-10-16 (verbatim):** *"why do you have to push the folder
manually, will we have to do it manually everytime… make it dynamic for each
users… the point is to be able to do this without touching the pc."*

**Role:** Task agent. Branch `agent/task-214-clone-extension-install` from local
`main`. Deliver code + a handoff. **Commit locally only; do NOT push and do NOT
deploy** — I review and own the box-side rollout per the standing coordination
rule.

---

## 1. The problem, precisely

The one-click clone setup (`lib/clone-setup.ts`, the "Path A" flow) already
downloads every engine artifact to `C:\ProgramData\TacticalRMM\CloneTool`, runs
the quarantine preflight, installs the relay, probes health, and mints the
live-capture token — all remotely, per device, no human on the PC. **Except the
browser extension and the native messaging host.** Those are the two pieces that
`live-capture-capability` needs, and the setup deliberately does not install them.
The gap is written into the code itself, `lib/clone-setup.ts:465-468`:

> *"Path A cannot install the extension itself (that is Path B's frozen scope),
> so this is a presence CHECK, never an assumption: a source device that only ran
> this (Path A) setup has no native host yet and correctly reads as absent."*

That "frozen scope" separation is exactly why the owner had to have me push the
files by hand over the RMM and click `Load unpacked`. It must go. Every customer
device must become self-installing through the same one-click button they already
press.

**Reference implementation already exists but is NOT wired in:** `michael/
browser-clone/engine/scripts/install-registry.ps1` ("Path B") writes the native
host manifest and registers `com.spaceworker.clone` under the HKLM
`NativeMessagingHosts` keys for Chrome/Edge/Brave. It is a standalone, elevated,
`-BinDir`-parameterised script that assumes `C:\Program Files\TacticalRMM` and is
never invoked by `clone-setup.ts`. Do not run it as-is — its default BinDir is
wrong for our layout (the installer uses `C:\ProgramData\TacticalRMM\CloneTool`,
per TASK_213) and it additionally registers a `TacticalRMM-CloneExpiration`
scheduled task and `CloneRegistry` key that are out of scope. **Reuse its
registry logic, not the whole script.**

## 2. What already works (verified live, do not rebuild)

- **Artifacts are served to the device already.** `/api/clone-engine/
  clone-native-host.exe` and `/api/clone-engine/clone-extension.zip` both return
  200 over the HMAC-signed single-device URL on the box, sha256 manifest-backed.
- **The registry presence check already exists and is correct.**
  `buildNativeHostPresenceScript()` (`lib/clone-setup.ts:470-488`) tests the exact
  three HKLM keys. When they exist it emits `STEP:native-host-check OK`, and the
  setup step at `:835` records `live-capture-capability — native host detected`
  and enables the `live-capture` capability. **The moment we register the host,
  this check flips to OK on its own — no change needed to the detection.**
- **The token is already on disk next to the host.** `live-capture.json` is
  written by the existing `live-capture-token` step into the CloneTool dir; the
  native host looks for it there. Already correct.

## 3. What TASK_214 must add

### D1 — Add the two artifacts to the source role
`ROLE_ARTIFACTS.source` (`lib/clone-setup.ts:69-78`) currently omits
`clone-native-host.exe` and `clone-extension.zip`. Add both so the existing
fetch/stage steps download and hash-verify them like every other artifact. Note
`clone-native-host.exe` is ~7 MB, so it lands in its own fetch chunk via
`fetchChunks` automatically — no caller change needed. Keep the
`Invoke-BrowserClone.ps1`/`install-relay.ps1` ordering intact.

### D2 — Extract the extension on the device
The staged `clone-extension.zip` must be expanded to
`C:\ProgramData\TacticalRMM\CloneTool\clone-extension` so `manifest.json` sits at
that folder's root (that is what Chrome's `Load unpacked` and any force-install
point at). Use `Expand-Archive -Force` into that path in the stage step (mirror
`buildStageScript`, `lib/clone-setup.ts:307+`). Verify `manifest.json` exists
after extraction and fail the step loudly if not — never assume the zip expanded.

### D3 — Register the native messaging host (lift the registry block from Path B)
After the engine is in place, write the native host manifest JSON
(`com.spaceworker.clone.json` → `{name, description, path:
<install>\clone-native-host.exe, type: stdio}`) and create the three HKLM
`NativeMessagingHosts\com.spaceworker.clone` keys (Chrome, Edge, Brave) with
`(Default)` = the manifest path — **exactly the block at
`install-registry.ps1:37-57`**, reusing the same host name and key paths that
`buildNativeHostPresenceScript` already checks. Must run under the elevated
SYSTEM context (the setup already runs `runAsUser: false` — match that).
**Do NOT** add the CloneRegistry key or the expire task — out of scope.

### D4 — Wire the install as a reported setup step
Give it a visible `STEP:` name (e.g. `extension-install`) reporting OK/FAIL with
the device's own words, consistent with the other steps. A failure here must fail
that step (not silently pass), but must NOT abort the whole setup (relay already
installed is valuable — mirror the `live-capture-token` best-effort posture OR
gate strictly, whichever the existing step ordering supports; document your
choice).

### D5 — Leave the ONE remaining manual step documented, not hidden
After D1–D4 the native host is registered and `live-capture-capability` reads
`native host detected`. The **extension binary itself still has to be loaded into
the browser** — `Load unpacked` (dev) or, for true zero-touch, an
`ExtensionInstallForcelist` policy + a hosted CRX/`update.xml`. That policy path
is a **separate follow-up task**, not this one. D5 = update the console copy /
setup result so the user is told precisely: *"native host installed ✓ — now load
the extension from `<install>\clone-extension` (Developer mode → Load unpacked),
or wait for force-install."* Do not claim hands-off until force-install exists.

### D6 (PHASE 2) — Zero-touch force-install of the extension
Goal: remove even the D5 browser click, so `install-relay`-style one-click setup
leaves a device with the extension **already loaded** in Chrome/Edge/Brave with
no human action. This is `ExtensionInstallForcelist`. **Verified constraints that
make this a phase 2, not a few extra lines** (checked 2026-10-16):

- **No packing key exists yet.** `michael/browser-clone/engine/extension/` has
  only source (`background.js`, `manifest.json`, `popup.*`) — no `.pem`, no
  `.crx`. Chrome derives a CRX's **extension ID from its signing key**, and
  force-install pins that ID. Without a **persistent** `.pem`, every rebuild
  mints a new ID and the forcelist silently stops matching. **P6a (decision +
  work):** generate the packing key ONCE, store it as a secret (whoever holds it
  controls the ID — owner must say where it lives), and pack the CRX with it in
  the build so the ID is stable forever.
- **The engine route can't serve it.** `/api/clone-engine/<file>` requires an
  HMAC signature bound to one artifact + one Device id, expiring within an hour
  (`app/api/clone-engine/[file]/route.ts:13-15`). Chrome's auto-updater fetches
  the update manifest **anonymously** — no HMAC, no Device id. **P6b:** serve the
  CRX + a Chrome-format JSON update manifest from a deliberately **public** path
  (e.g. `public/clone-ext/…` static, or a dedicated unauthenticated route). Note
  explicitly in the handoff that this path is intentionally public — acceptable
  because the extension is not secret, but it is a decision, not an accident.

**D6 work, once P6a/P6b exist:** (1) add CRX packing (with the persistent key) to
the engine build so `engine-dist/` carries `clone-extension.crx` + the update
manifest alongside the zip; (2) in the setup's registry step, additionally write
the `ExtensionInstallForcelist` policy value (`1;<update-url>`) under HKLM
`SOFTWARE\Policies\{Google\Chrome | Microsoft\Edge | BraveSoftware\Brave-Browser}`
— the setup already runs elevated SYSTEM, so HKLM policy writes work; (3) the
device picks the extension up on next browser launch (no reload-the-browser
trick needed). Keep D1–D4 (native-host path) intact as the fallback for devices
where policy is blocked.

**Do not block D1–D5 on D6.** D1–D5 = native host registered + extension on disk
+ honest "load it" copy = shippable today. D6 = the zero-touch layer on top.

## 4. Constraints & non-goals
- **No box access, no deploy, no push** for the task agent. Code + handoff only.
- **Do not** run or port `install-registry.ps1` wholesale (wrong BinDir default;
  extra task/key). Lift only the native-host manifest + 3-key registry block.
- **Do not** touch the relay install, token minting, or capability DB writes.
- **Correct BinDir is `C:\ProgramData\TacticalRMM\CloneTool`** (TASK_213 fixed
  exactly this on the installer; do not reintroduce `Program Files`).
- Chrome extension install **cannot** be fully automated without the force-install
  policy; be honest in copy and handoff (see D5).

## 5. Verification (task agent, local)
1. `npx tsc --noEmit` → 0 errors.
2. `npx tsx --test tests/*.test.ts` → full suite green (1489 pass / 0 fail / 1
   skip at TASK_210; do not regress). Add/extend a unit test asserting the source
   role now includes both artifacts and that the generated install script contains
   the three registry paths + the `Expand-Archive` target.
3. `bash -n` on any script you touch.
4. Manual acceptance (documented for me to run on V73 after I deploy): rerun
   one-click setup → `fetch:clone-native-host.exe OK` + `fetch:clone-extension.zip
   OK` + `extension-install OK` + `live-capture-capability — native host
   detected` + `native-host-check OK`; confirm
   `C:\ProgramData\TacticalRMM\CloneTool\clone-extension\manifest.json` exists and
   the three HKLM keys are present.
5. **D6 only (phase 2):** after the CRX is packed with the persistent key and
   force-install policy is written, confirm the extension appears in
   `chrome://extensions` **enabled** with a **stable ID across two rebuilds**, and
   that the update manifest + CRX are reachable anonymously (no HMAC) from the
   public path. Confirm the forcelist registry value exists under all three
   browser policy keys.

## 5b. Two decisions the OWNER must make before D6 (not blockers for D1–D5)
- **P6a — signing-key custody.** The `.pem` sets the extension ID forever. Where
  does it live (repo secret? a vault? generated on the box and never committed)?
  It must NOT be committed in plaintext to a public repo.
- **P6b — public path is intentional.** The update manifest + CRX will be served
  without auth so Chrome can auto-update. Confirm that's acceptable (the
  extension isn't secret, but the URL becomes world-readable).

## 6. Handoff
Write `TASK_214_CLONE_EXTENSION_INSTALL_STEPS.md` following the established
`TASK_*_STEPS.md` format (what/why, files touched with line refs,
branch/commit/sha, gates with real numbers, deviations, what I must run on the
box). Flag any assumption you could not verify from source.

