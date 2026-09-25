# Task 120 (bit B10) — "Carry my session" must install itself: silent setup + visible per-section activity

Owner request, 2026-09-25 (verbatim): *"to select carry my session, it wants the extension, but when i
tried to install the extension, your rebuild came in, don't know if it was installed… is there a way to
show the activity and maybe a drop down to show all the necessary steps passed, for each section, to go
ahead, so if the extension is the only one left, user can just rerun the full setup. or just install the
extension easily… lets make this seamless, click a button and we good."*

**Goal.** Make "Carry my session" turn on by **clicking one button** — silently, no download, no manual
step — and make the setup show **what is done and what is left, per section**, so a user can see it and
re-run the whole thing if something failed.

---

## 1. WHY IT CANNOT TURN ON TODAY — verified, with file:line

This is not "a click is missing". **The entire delivery half was never built.** Five independent facts:

1. **`lib/clone-setup.ts:68-77` — `ROLE_ARTIFACTS.source` does not include the extension or its host.**
   It is exactly: `hack-browser-clone.exe`, `hack-relay.exe`, `install-relay.ps1`,
   `Invoke-BrowserClone.ps1`, plus the three PS libs (`CdpCookies.ps1`, `GcmCrypto.ps1`,
   `ProfilePaths.ps1`). **No `clone-native-host.exe`. No extension. No `install-registry.ps1`.**
2. **`engine-dist/manifest.json` holds 9 entries and none of them are those three.** So even if
   `ROLE_ARTIFACTS` named them, the hash-verified `fetch` step would 404 — the union must be fixed on
   **both** sides or the fetch step fails closed (correctly).
3. **`install-registry.ps1` — the only thing that registers the native-messaging host — is invoked
   nowhere.** That script is what writes the manifest and creates, per browser,
   `HKLM\SOFTWARE\{Google\Chrome | Microsoft\Edge | BraveSoftware\Brave-Browser}\NativeMessagingHosts\com.spaceworker.clone`.
   `grep` for it across `lib/` and `app/` returns nothing.
4. **`michael/browser-clone/engine/scripts/build.ps1` DOES build `clone-native-host.exe`**
   (`./cmd/native-host`, windowsgui, "silence is mandatory") — and nothing ever ships it. The binary
   exists in the build and in no distribution.
5. **Consequence, and exactly what the owner saw:** `buildNativeHostPresenceScript()` (the check behind
   `CloneSetupStatus.liveCaptureReady`, `lib/clone-setup.ts:110`) can *only ever* return false, so
   `CloneStartCard` disables the option (`components/device-console.tsx:1740`) and there is **no
   in-product path to satisfy it**. The user is told to install something the product never offers.

**Context:** V10 (`9885497`) fixed the **token file** (`live-capture.json`) that the frozen Path B host
reads. That was the last mile of a road whose first mile was never paved. This task paves it.

---

## 2. OWNER DECISIONS — do not re-litigate

- **Q1 (done, Path B)** capture **all sites** — `"cookies"` + `host_permissions: ["<all_urls>"]`, **no
  domain picker**. The user (or an agent) picks what to open *after* the clone is running.
- **Q2** if the extension is not installed, the console must **detect that and offer to install it** —
  never offer `live` and fail after Start. This task makes the install actually exist.
- **Q4 (this task)** the install must be **SILENT**: one click, no manual download, no step the user
  performs outside the app. "Silent" means the *agent* does it, exactly like the existing relay path.
- **Q5 (this task)** **no dead end**: once setup finishes, **open the browser** — do not stop at "ready"
  and make the user go hunt for Start again.
- **D-1 (this task)** setup activity must **survive a page reload / a deploy**. The owner's exact
  complaint was *"your rebuild came in, don't know if it was installed"* — a transient in-memory
  response is therefore **not** acceptable as the source of truth.

---

## 3. THE ONE HARD CHOICE — how to install a Chrome extension silently

| Route | Silent (no user step)? | Survives restart? | Verdict |
|---|---|---|---|
| Unpacked `--load-extension` | No — needs Chrome relaunched with a flag; **no effect on an already-running Chrome**; Google is removing the flag | No | **REJECTED** |
| Chrome Web Store (unlisted/private) | Yes | Yes | **REJECTED for now** — needs a store developer account + review; "private" only works for Workspace domains |
| **`ExtensionInstallForcelist` + self-hosted signed CRX3** | **Yes** | **Yes** | **CHOSEN** |

**CHOSEN: `ExtensionInstallForcelist`** (HKLM policy) pointing at an **update manifest we host over
HTTPS** (`update.xml` → `.crx`), written by the same SYSTEM-context setup script that already writes the
native-host registration. It is the only route that is silent, persistent across restarts, applies to
any signed-in user, and is **reversible by deleting the policy** (rollback, §7).

**The cost, disclosed and not hidden:** a force-installed extension makes Chrome show **"Managed by your
organization"**, and the extension is not removable by the user while the policy is set. The console
must state this **before** the click, in one plain sentence. We do not paper over it — the user is
changing their own browser.

**Facts the implementer must not get wrong (CRX3):**
- **The extension ID is derived from the signing key.** Generate **once**, store the `.pem` as a
  **GitHub Actions secret** — **never commit it, never put it in `engine-dist/`, never print it.** Both
  repos are PUBLIC. Losing it changes the ID and breaks every installed policy entry.
- Chrome requires **CRX3**; CRX2 is dead. Pack with Chrome on `windows-latest`
  (`chrome.exe --pack-extension=<dir> --pack-extension-key=<pem>`) — a plain CI step — or a small CRX3
  signer. **Do not hand-roll the container format.**
- Serve the `.crx` and `update.xml` over **HTTPS at a stable URL**, `.crx` as
  `Content-Type: application/x-chrome-extension`, and **do not let nginx gzip or rewrite them**. Same
  origin as `engine-dist` is fine (`env.appBaseUrl` + a path).
- Forcelist entry form: `<extension-id>;https://<origin>/clone-ext/update.xml`.
- `manifest.json`'s `_comment` key yields Chrome's benign *"Unrecognized manifest key"* warning.
  **Strip it when packaging** — a warning on a policy-installed extension reads as a fault.

---

## 4. THE BITS

### B10-1 — Ship the native host and the extension at all (build + distribution)
1. `engine-dist` must carry **`clone-native-host.exe`** and **`install-registry.ps1`**, with real
   SHA-256s in `engine-dist/manifest.json`. **That directory is gitignored (`.gitignore:23`) and rsynced
   to the VPS — it is NOT in git**, and the manifest is **generated**, so extend the list that
   `scripts/engine-dist.mjs` walks (that script *is* tracked) and re-run it. **Never hand-edit the
   manifest** — the signature check reads it.
2. The extension must be **packaged as CRX3** in CI and published to the HTTPS origin with an
   `update.xml` (new workflow, or a step in an existing one — mirror the `overlay-trial.yml` pattern).
3. Serve the `.crx` + `update.xml` from our origin. **The `.crx` must not live in git** and the `.pem`
   must never be in git, in `engine-dist/`, or in the manifest.
4. **Order matters:** `install-registry.ps1` requires **both** `clone-native-host.exe` **and**
   `hack-browser-clone.exe` in `-BinDir` and throws otherwise. Stage both before it runs.

### B10-2 — Register them from the one-click setup (this is the "silent" part)
1. Add `clone-native-host.exe` + `install-registry.ps1` to `ROLE_ARTIFACTS.source` (§1.1) **and** confirm
   the union with the manifest, or `buildFetchScript` cannot resolve every entry.
2. Add a **registry step** to `setupCloneDevice`, in **elevated/SYSTEM context**, running
   `install-registry.ps1 -BinDir <INSTALL_DIR>` — the same pattern as the relay install
   (`lib/clone-setup.ts:718`) and the hosted install (`:810`).
3. **Emit `STEP:` lines.** `install-registry.ps1` uses `Write-Host` only, and the setup's `parseSteps()`
   (line 168) reads `STEP:<name> OK|FAIL|SKIP[:detail]`. Add those lines to the script — otherwise the
   new work is invisible in the activity UI (B10-4) and only `ensureReported()` fires.
4. Write the **`ExtensionInstallForcelist`** policy (HKLM, Chrome + Edge) in that same elevated script,
   then **read the key back** and report `STEP:ext-policy OK` only if the value is present. Report,
   don't assume.
5. Keep `buildNativeHostPresenceScript()` as the **read-side truth** (it already checks the real HKLM
   keys). After this change it can finally return true. Do **not** replace it with a DB flag.
6. **Idempotent and re-runnable:** the owner explicitly wants "re-run the full setup" to be safe. Every
   new step must tolerate already-installed state and report `OK`, not fail.


### B10-3 — Persist setup runs, so the activity survives a reload
Today the step list exists **only** in the `POST /clone-setup` response (`CloneSetupCard`'s `steps`
prop, `components/device-console.tsx:1628`). Reload the page, or deploy, and the history is gone — which
is precisely the owner's *"don't know if it was installed"*. Fix the source of truth, not the display.

1. New model **`DeviceSetupRun`** (hand-written migration, house style):
   `id`, `deviceId`, `role` (`source`|`hosted`), `ok`, `stepsJson` (the `CloneSetupStep[]` array),
   `startedAt`, `finishedAt`, `error` (fixed reason code, never raw script output), `triggeredByUserId`.
   Index `[deviceId, startedAt]`.
2. `setupCloneDevice` writes one row per run (success **and** failure — a failed run is the most
   important thing to be able to see).
3. `cloneSetupStatus` returns the **last run per role** plus a derived **per-section** breakdown (§B10-4).
   Re-runs append; keep the last N (say 10) for debugging, prune the rest.
4. **Never store raw script output** — it can contain device paths and, on the capture path, is one
   step away from credential material. Store the parsed steps + a fixed error code.

### B10-4 — The activity UI: per-section, expandable, honest
Replace the flat `<ul>` (`components/device-console.tsx:1711-1723`) with a **sectioned** view. Sections,
in run order — status derived from `DeviceSetupRun` **and** the live read model, never from a guess:

| Section | Shows | Truth source |
|---|---|---|
| **Engine** | engine + CLI + PS libs staged, hash-verified | last run `stage` steps |
| **Egress relay** | relay installed, tunnel up, last check | `relay.status` / `relay.lastCheckAt` |
| **Capture host** | native host binary + HKLM registration per browser (Chrome/Edge/Brave) | `buildNativeHostPresenceScript()` result in the last run |
| **Browser extension** | policy written, extension ID present, **"Managed by your organization" disclosed here** | last run `ext-policy` step |
| **Session token** | `live-capture.json` delivered, token committed | last run token step |

Requirements:
- Each section: a **one-line current state** (`done` / `missing` / `failed` / `not needed for this role`)
  and a **disclosure** (`<details>` or an expand button) listing **each step with ✓/✗ and its detail**.
- A **"what's left" summary at the top** — the owner's actual ask: *"if the extension is the only one
  left, user can just rerun the full setup"*. One sentence naming the remaining sections.
- **Counts only** for anything credential-shaped; never render a token, never a raw script line.
- Empty state must be explicit ("no setup has run yet"), not blank.

### B10-5 — One button: set up, then open the browser (Q5, no dead end)
1. **One primary action** on the card. When `liveCaptureReady === false`, the setup button **is** the
   install-the-extension path — click once, the agent does everything, no manual step.
2. On success, **do not stop at "ready"**. If the user's intent was "Carry my session", **start the
   clone** with `sessionMode: "live"` in the same flow, and land them on the running clone — the cloned
   browser opens with the session already carried.
3. If a section failed, the button becomes **"Re-run setup"** and the summary names what failed. Never
   a silent no-op, never a button that reports success for work that did not happen.
4. `sessionMode` already flows end to end (picker → route → `requestClone`) — **do not re-add it**.
   Verify it is still intact before wiring the auto-start.


---

## 5. FILES — split so two agents can work without colliding

Path A owns the server + console; Path B owns the Windows-side install script. **Overlap: none.**
The only coupling is the **`STEP:<name>` vocabulary** (A parses, B emits) — agree it in this doc, and a
change to it changes both.

### PATH A (Claude) — server, state, UI
- `prisma/schema.prisma` + **one hand-written migration** — `DeviceSetupRun` (+ `Device` relation)
- `lib/clone-setup.ts` — `ROLE_ARTIFACTS.source`, the new registry/extension step, `DEVICE_SETUP_SECTIONS`
- `lib/clone-setup-runs.ts` **(new)** — persist/read runs, prune to last N
- `app/api/devices/[deviceId]/clone-setup/route.ts` — return the sectioned status
- `components/device-console.tsx` — the sectioned card (B10-4) + one-button flow (B10-5)
- `scripts/engine-dist.mjs` — include `clone-native-host.exe` + `install-registry.ps1`
- `.github/workflows/` — a CRX3 pack + publish job (new file)

### PATH B (Cline) — the Windows install script only
- `michael/browser-clone/engine/scripts/install-registry.ps1` — emit `STEP:` lines; write and verify the
  `ExtensionInstallForcelist` policy; keep it idempotent
- `michael/browser-clone/tests/Test-RegistryInstall.ps1` **(new)** — the harness

### The `STEP:` vocabulary (frozen — A parses it, B emits it)
`STEP:native-host OK|FAIL[:detail]` · `STEP:browser-registration OK|FAIL[:detail]` ·
`STEP:ext-policy OK|FAIL[:detail]` · `STEP:ext-verify OK|FAIL[:detail]` · `STEP:registry DONE|FAIL[:detail]`

---

## 6. ACCEPTANCE (evidence, not assertions)

1. **Silent install, provable:** on a real source device, one click on the setup button, with **no
   manual step**, ends with the extension **present and enabled in `chrome://extensions`** and the
   native-host **present in both HKLM key sets** (Chrome + Edge). Paste the check output.
2. **`liveCaptureReady` flips to `true`** for that device, and **the "Carry my session" option becomes
   selectable** in the console.
3. **The activity survives a reload and a deploy** — show the sectioned card after a rebuild, listing
   the same steps. This is the owner's original complaint; it must be explicitly demonstrated.
4. **Re-run is safe** — run setup twice back to back; the second run reports `OK` for every step and
   changes nothing. Show both runs in the history.
5. **One button, no dead end** — with a session to carry, click once and land on a **running clone that
   is signed in**. Not "ready", not a second button.
6. **Honesty** — no section shows `done` unless the device's own output said so; a failed section is
   visible with its reason, and no token or raw script output appears anywhere in the UI, the DB or the
   logs.
7. **No regression:** `fresh` clones are unaffected; `cloneSetupStatus` still answers without a device
   RPC; the relay and hosted paths still install on a device that never had them.
8. **The key is not leaked:** `git log -p` and the manifest contain **no `.pem`**; show the grep.

---

## 7. ROLLBACK (must be trivial — the owner asked for it)

- **Extension off:** delete the `ExtensionInstallForcelist` value (and the policy key) — the extension
  is removed by Chrome on next start. Provide this as a **single documented command**, not a manual
  registry hunt, and record it in the runbook.
- **Setup off:** `sessionMode` stays optional and `fresh` stays the default, so a broken live path
  cannot break ordinary cloning.
- **Nothing is destructive on re-run** — no data migration, no profile deletion.

---

## 8. REPORT BACK WITH

- Files changed, the migration SQL, `npx tsc --noEmit` result.
- For Path B: `gofmt -l` / `go vet` / `go build ./...` and the PowerShell harness output (PowerShell 7
  is fine; note any Windows-only SKIPs — and say plainly if it was not run on Windows).
- The **extension ID** and the exact forcelist string used (the ID is public, the key is not).
- Acceptance evidence for §6.1–§6.5, or an explicit statement of which you could **not** verify and why.
- Anything you had to decide that is not in this file.

