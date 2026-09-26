# Task 120 (bit B10) — "Carry my session" must install itself: silent setup + visible per-section activity

**Status: DEFERRED (owner, 2026-09-26) — "i dont think the clone is necessary for now, we
can close that and allow michael fix it himself whenever he got time."** Not urgent, not
assigned to an agent. Michael owns this whenever he has time (matches the plan's own
"natural Michael track" — browser-clone profile-capture/extension work, PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md
§WORKFLOW). Live Browser Clone capture stays unavailable until this lands
(`live-capture-capability` keeps reporting "native host not detected" — confirmed 2026-09-26
via `Sc`'s own device setup run), but that is accepted as fine for now.

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

## 3. HOW TO INSTALL THE EXTENSION — CORRECTED 2026-09-25 after owner challenge

**The first version of this section chose `ExtensionInstallForcelist` + a self-hosted signed CRX3. That
was WRONG, and the owner's objection ("that actually breaks the flow") is correct.** Two independent,
documented facts kill it:

1. **`force_installed` = "Users can't remove it."** (Google's `ExtensionSettings` policy reference,
   quoted verbatim.) The extension is not just *present* — it is **unremovable** for as long as the
   policy exists, and **Chrome shows "Managed by your organization" (More menu, and
   `chrome://management`) for that entire time.** It is a property of the **BROWSER**, not of the clone
   session — it does **not** appear only while a session is shared, and it does not go away when the
   clone ends. Google's own help page then teaches the user to open `chrome://policy`, find "policies you
   don't recognize", and remove the responsible program — i.e. the badge is designed to be a
   malware/warning signal. Setting it on a **customer's personal browser** is a trust bomb and, as the
   owner said, breaks the flow.
2. **A self-hosted CRX is not an option on Windows at all.** Per Google's external-extensions doc:
   *"On Windows and Mac, the `update_URL` must point to the Chrome Web Store where the extension must be
   hosted"* and *"As of Chrome 33, no external installs are allowed from a path to a local `.crx` on
   Windows."* So the "silent, no policy, our own origin" variant **does not exist on Windows**, which is
   the only platform we ship.

### The two real routes

| Route | Silent? | "Managed by your organization"? | User can remove it? | Needs a Store listing? |
|---|---|---|---|---|
| **A. Policy — `ExtensionInstallForcelist` / `force_installed`** | yes | **YES — permanent, browser-wide** | **NO** | no |
| **B. Registry external install — `HKLM\SOFTWARE\Google\Chrome\Extensions\<id>` with `update_url` → Chrome Web Store** | yes (Chrome installs it at next start) | **NO** — this is **not** a policy (different registry root: `SOFTWARE\Google\Chrome`, not `SOFTWARE\Policies\Google\Chrome`) | **yes** — and Chrome **respects** it, blocklisting the extension rather than re-installing | **YES** |
| C. Unpacked `--load-extension` | no — requires relaunching Chrome with a flag, no effect on an already-running Chrome, and the flag is being removed | n/a | yes | no |

**Rejected: C** (not silent, needs the user's browser closed, being deprecated).

### CHOSEN: Route B — a Chrome Web Store listing installed via the registry `update_url`

Automatic and silent, **no policy, no "Managed by your organization", no permanent state on the user's
browser**, and the user keeps the right to remove an extension they don't want (Chrome blocklists it, and
we respect that — the setup card must then say so and offer the alternative, not nag).

**Costs, stated plainly (this is the trade, not a hidden one):**
- **One-time Chrome Web Store developer account ($5) and a review** before anything can ship. A listing
  with `"cookies"` + `host_permissions: ["<all_urls>"]` is the exact permission profile of session-
  stealing malware, so the **review is a real gate and can be rejected**; the listing's justification
  must be airtight. Plan for at least one rejection round.
- **Store review on every future extension change** (a new version needs review), so the extension can
  never be hot-patched in an emergency. Version updates therefore need a release habit, not a push.
- The registry entry carries a **`version`** that must match the published version.
- ~~Verify whether the registry entry installs at all.~~ **RESOLVED 2026-09-25, in our favour:**
  `BlockExternalExtensions` — *"Setting this policy to **Enabled** blocks external extensions from being
  installed. Setting this policy to **Disabled or leaving it unset allows external extensions to be
  installed."* (ADMX policy reference.) **Unset is the default, so external installs are allowed.** The
  one remaining case is a **customer machine under IT policy that has explicitly enabled it** — then the
  extension cannot install, `liveCaptureReady` stays false, and the console must say so and offer
  `fresh`. Checked by the existing presence check; no new machinery.

**Build facts (Route B):**
- The extension ID comes from the **Store listing**, and the signing key lives with the Store. There is
  **no `.pem` in our repo or CI, and no `.crx` we host** — that entire CRX3 subsection was an artefact
  of the wrong route and is deleted.
- Registry shape: `HKLM\SOFTWARE\Google\Chrome\Extensions\<extension-id>` with `REG_SZ update_url =
  https://clients2.google.com/service/update2/crx` and `REG_SZ version = <published version>`. Same for
  Edge under `HKLM\SOFTWARE\Microsoft\Edge\Extensions\<id>` (verify Edge's requirement separately).
- `manifest.json`'s `_comment` key yields Chrome's benign *"Unrecognized manifest key"* warning.
  **Strip it before publishing** — a warning on a browser extension reads as a fault.
- **Rollback = delete the two registry keys.** No policy, no browser state, nothing to un-flag. This is
  strictly better than Route A's rollback.

### B10-R — THE TIMING FACT THAT SHAPES THE UX (do not design around an instant install)

Chrome reads the `…\Extensions\<id>` registry keys **at browser startup**. So if the user's Chrome is
already open when setup writes them, **the extension appears at the NEXT Chrome start** — not
immediately, and not mid-session. **There is no supported way to make it instant** (the only lever would
be killing their Chrome, which we will not do), and the **native-messaging host registration needs the
same restart** for the extension to reach it.

Consequences the UI must honour:
- Never claim "carry my session" is ready **the moment** setup finishes. The card's **Browser extension**
  section must read something like *"installed — takes effect when Chrome restarts"* until the presence
  check actually passes, and `liveCaptureReady` must keep reporting **false** until then (§B10-2.6).
- The **Chrome-restart step belongs in the activity card** as a visible step, with the honest wording.
  Options in order of politeness: keep the clone `fresh` and offer `live` next time; or ask the user to
  reopen Chrome and re-run. Do **not** silently close their browser.
- This is exactly what the **per-section activity view (B10-4)** exists to make legible — so make this
  section the proof that it works.

### The Store listing flow, end to end (for whoever sets it up)

**Ours, once — this is the gate, and it is external:**
1. Register a Chrome Web Store **developer account** ($5, one-time; needs a publisher name, which is
   **publicly shown on the listing**).
2. Upload the extension as a **`.zip`** — the existing `engine/extension/` contents, with the `_comment`
   key removed and a real `version`. Google assigns the **extension ID** at this point; it is permanent
   and is what both our config and the device registry key use.
3. Fill the tabs that decide the outcome: **Privacy** (single purpose + data handling — where
   `cookies` + `<all_urls>` gets justified, and it must match the code), **Distribution** (countries +
   who can see/install it — keep it narrow), **Store Listing**, and **Test instructions** (tell the
   reviewer how to verify with a disposable login; **never** a real account).
4. Submit → review → published (deferred publishing is available if we want to pick the moment).
5. Put the **extension ID + published version** into our config so the setup script and the presence
   check can use them (§B10-2.5 — with them unset, the step is `SKIP:store_listing_pending`, a pass).

**Ours, every release:** bump version → upload → review. There is a *"skip review for eligible
changes"* path for some changes, but do not rely on it.

**The device, and only this:** one registry write, silent, no user action. Chrome does the rest at next
start.



### Until Route B is live: do NOT gate the flow on it

The Store listing cannot exist today, and the console currently blocks "Carry my session" with no
possible way to satisfy it. So **B10-2 ships the un-blocking first** (§4): the setup card must stop
presenting the extension as a prerequisite, and must offer the route that works **right now and needs no
browser modification at all** —

**Sign in once inside the clone, and it persists.** The clone's browser profile is per-device and
persistent, and TASK_117 **F6** proved a CDP-set cookie **survived a full container restart**. So the
user is signed in from the second clone onward with **zero** cookies extracted, **zero** extension and
**zero** policy. That is the honest default; Route B (when it exists) only saves the *first* sign-in.

---

## 4. THE BITS

### B10-1 — Ship the native host and the setup script at all (build + distribution)
1. `engine-dist` must carry **`clone-native-host.exe`** and **`install-registry.ps1`**, with real
   SHA-256s in `engine-dist/manifest.json`. **That directory is gitignored (`.gitignore:23`) and rsynced
   to the VPS — it is NOT in git**, and the manifest is **generated**, so extend the list that
   `scripts/engine-dist.mjs` walks (that script *is* tracked) and re-run it. **Never hand-edit the
   manifest** — the signature check reads it.
2. **The extension itself is NOT built, signed or hosted by us** (§3, Route B). There is no `.crx` in our
   CI, no `update.xml`, no `.pem` anywhere. The only thing we ship is the **native host binary** and the
   registry entry pointing at the **Chrome Web Store**. If you are tempted to add CRX3 packaging: don't —
   it was the wrong route and it is also impossible on Windows.
3. **Order matters:** `install-registry.ps1` requires **both** `clone-native-host.exe` **and**
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
4. **Route B registration, not a policy** (§3): write
   `HKLM\SOFTWARE\Google\Chrome\Extensions\<id>` (+ Edge) with `update_url` and `version`, then **read
   both values back** and report `STEP:ext-registry OK` only if they are present. **Do NOT write
   `ExtensionInstallForcelist` or any `SOFTWARE\Policies\Google\Chrome` key** — that is the route the
   owner rejected.
5. **The extension id and version must be configuration, not a literal** (they come from the Store
   listing). Missing config → that step reports **`SKIP:store_listing_pending`**, which is a *pass*, not
   a failure: the flow must not be blocked by a listing that does not exist yet (§3, last part).
6. Keep `buildNativeHostPresenceScript()` as the **read-side truth** (it already checks the real HKLM
   keys). **But it must now distinguish "native host present" from "extension present"**, and
   `liveCaptureReady` must mean **both** — otherwise the console offers `live` on the strength of a host
   that has no extension to talk to. Report, don't assume.
7. **Idempotent and re-runnable:** the owner explicitly wants "re-run the full setup" to be safe. Every
   new step must tolerate already-installed state and report `OK`, not fail.
8. **Un-block the flow while the listing is pending** (§3): the setup card must stop presenting the
   extension as a hard prerequisite, and must state the working alternative in one line — *"You can also
   sign in once inside your clone and it stays signed in."* `sessionMode: "live"` stays **disabled** with
   that reason, so a user is never offered an option that cannot work; but the **rest of the flow must
   not be gated on it**, and `fresh` must be reachable and obviously fine.



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
| **Browser extension** | extension installed via the Store registry entry, and whether it is **live yet** (see B10-R — a Chrome restart may be pending) | last run `ext-registry` step **+ the presence check** |
| **Session token** | `live-capture.json` delivered, token committed | last run token step |

Requirements:
- Each section: a **one-line current state** (`done` / `missing` / `failed` / `not needed for this role` /
  **`pending restart`**) and a **disclosure** (`<details>` or an expand button) listing **each step with
  ✓/✗ and its detail**.
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
3. **But handle the restart honestly (B10-R).** If the extension was just registered and the presence
   check has not passed yet, the extension is **not live until Chrome restarts** — so falling through to
   a `live` clone here would fail. In that state the button must offer **`fresh` now**, state in one line
   that carrying a session is available after Chrome restarts, and **not** pretend otherwise.
4. If a section failed, the button becomes **"Re-run setup"** and the summary names what failed. Never
   a silent no-op, never a button that reports success for work that did not happen.
5. `sessionMode` already flows end to end (picker → route → `requestClone`) — **do not re-add it**.
   Verify it is still intact before wiring the auto-start.


---

## 5. FILES — split so two agents can work without colliding

Path A owns the server + console; Path B owns the Windows-side install script. **Overlap: none.**
The only coupling is the **`STEP:<name>` vocabulary** (A parses, B emits) — agree it in this doc, and a
change to it changes both.

### PATH A (Claude) — server, state, UI
- `prisma/schema.prisma` + **one hand-written migration** — `DeviceSetupRun` (+ `Device` relation)
- `lib/clone-setup.ts` — `ROLE_ARTIFACTS.source`, the new registry step, `DEVICE_SETUP_SECTIONS`
- `lib/clone-setup-runs.ts` **(new)** — persist/read runs, prune to last N
- `app/api/devices/[deviceId]/clone-setup/route.ts` — return the sectioned status
- `components/device-console.tsx` — the sectioned card (B10-4) + one-button flow (B10-5)
- `scripts/engine-dist.mjs` — include `clone-native-host.exe` + `install-registry.ps1`
- `lib/env.ts` — the Store **extension id + version** as optional config (§B10-2.5)

### PATH B (Cline) — the Windows install script only
- `michael/browser-clone/engine/scripts/install-registry.ps1` — emit `STEP:` lines; write and verify the
  **`HKLM\SOFTWARE\Google\Chrome\Extensions\<id>`** entry (Route B — **not** a policy); keep it idempotent
- `michael/browser-clone/tests/Test-RegistryInstall.ps1` **(new)** — the harness

### The `STEP:` vocabulary (frozen — A parses it, B emits it)
`STEP:native-host OK|FAIL[:detail]` · `STEP:browser-registration OK|FAIL[:detail]` ·
`STEP:ext-registry OK|FAIL|SKIP:store_listing_pending[:detail]` · `STEP:ext-verify OK|FAIL[:detail]` ·
`STEP:registry DONE|FAIL[:detail]`

---

## 6. ACCEPTANCE (evidence, not assertions)

1. **The flow is NOT gated on a Store listing that does not exist.** With the extension id unset, the
   sectioned card shows the **Browser extension** section as *not yet available* with the reason, the
   rest of the setup is `OK`, and a **`fresh` clone completes normally** — the dead end is gone. Show
   the card. **This is the item that ships first and un-blocks the owner today.**
2. **No browser state is written that the owner rejected.** `chrome://policy` shows **no** policy from
   us and `chrome://management` does **not** report the browser as managed, after setup. Paste both.
   (This is the check the owner's objection demands — a policy anywhere fails this item.)
3. **Sign-in persists without any extension** (§3 last part): start a `fresh` clone, sign in once inside
   it, end the clone, start another — it is **still signed in**. This is the working path and must be
   demonstrated on a real device.
4. **When the Store listing exists:** one click, no manual step, ends with the extension **present and
   enabled in `chrome://extensions`**, **removable by the user**, and `liveCaptureReady: true`. Paste
   the check output. *(Blocked until a listing exists — do not fake this one.)*
5. **The restart is handled honestly (B10-R).** With Chrome open when the registry entry is written,
   the card reports the extension as **pending a Chrome restart** — *not* as ready — `liveCaptureReady`
   stays **false**, and the button offers `fresh`. After Chrome is restarted, it flips to ready. Show
   both states. **A run that claims ready before the restart fails this item.**
5. **Re-run is safe** — twice back to back; the second run reports `OK` for every step and changes
   nothing. Show both runs in the history.
6. **The activity survives a reload and a deploy** — show the sectioned card after a rebuild, listing
   the same steps. This is the owner's original complaint; it must be explicitly demonstrated.
7. **One button, no dead end** — once `live` is available, click once and land on a **running clone that
   is signed in**. Not "ready", not a second button.
8. **Honesty** — no section shows `done` unless the device's own output said so; a failed section is
   visible with its reason, and no token or raw script output appears anywhere in the UI, the DB or the
   logs.
9. **No regression:** `fresh` clones are unaffected; `cloneSetupStatus` still answers without a device
   RPC; the relay and hosted paths still install on a device that never had them.
10. **Nothing secret leaked, and nothing that should not exist:** `git log -p`, the manifest and CI
    contain **no `.pem` and no `.crx`**; show the grep. If you find yourself adding either, you are
    building the **rejected** route.

---

## 7. ROLLBACK (must be trivial — the owner asked for it)

- **Extension off:** delete the two registry keys (`HKLM\SOFTWARE\Google\Chrome\Extensions\<id>` and the
  Edge equivalent). Chrome removes the extension on next start. **No policy to unset, no browser state
  to un-flag** — Route B's rollback is strictly simpler than the rejected policy route. Provide it as a
  **single documented command**, not a manual registry hunt, and record it in the runbook.
- **Setup off:** `sessionMode` stays optional and `fresh` stays the default, so a broken live path
  cannot break ordinary cloning.
- **Nothing is destructive on re-run** — no data migration, no profile deletion.

---

## 8. REPORT BACK WITH

- Files changed, the migration SQL, `npx tsc --noEmit` result.
- For Path B: `gofmt -l` / `go vet` / `go build ./...` and the PowerShell harness output (PowerShell 7
  is fine; note any Windows-only SKIPs — and say plainly if it was not run on Windows).
- **Confirmation that no `SOFTWARE\Policies\Google\Chrome` key was written** and no `.pem`/`.crx` exists
  anywhere (grep output).
- The **extension ID** and registry shape used, once a Store listing exists (the ID is public).
- Acceptance evidence for §6.1–§6.5, or an explicit statement of which you could **not** verify and why.
- Anything you had to decide that is not in this file.


---

## 9. PENDING — OWNER GATE (externally blocked: the Chrome Web Store listing)

**Tracker row: `B10-pend`.** Parked here on 2026-09-25 at the owner's request
(*"just write this as a pending task"*). **No code can start this** — it is a real-world account-and-review
gate, which is why it is a row rather than a paragraph buried in §3.

**Exactly what is pending, and who does it:**

| # | Step | Who | Notes |
|---|---|---|---|
| P1 | Register a Chrome Web Store **developer account** ($5, one-time) | **Owner** | Needs a public **publisher name** — it is shown on the listing |
| P2 | Upload `engine/extension/` packaged as a **`.zip`** (drop the `_comment` key, set a real version) | Either | Google assigns the **extension ID** here, and it is permanent |
| P3 | Fill the four tabs: **Privacy** (single purpose + data handling), **Distribution**, **Store Listing**, **Test instructions** | Either | Privacy must match what the code actually does: `cookies` + `<all_urls>`. Test instructions must use a **disposable login** |
| P4 | Submit → **review** → published | Google | Plan for one rejection round; a listing asking `cookies` + `<all_urls>` is the permission profile of session-stealing malware and is scrutinised |
| P5 | Put the **extension ID + published version** into config | Either | Until then `B10-2` reports `SKIP:store_listing_pending` |

**Until it lands (this is deliberate — the flow must not dead-end):**
- The extension step reports **`SKIP:store_listing_pending`**, which counts as a **PASS**, so setup still
  completes and nothing is blocked.
- The console offers **`fresh`**, and the extension section reads *"not needed yet"*.
- A clone's profile is **persistent per device**, so signing in **once inside the clone** stays signed in
  (TASK_117 F6). The extension only ever saves the **first** sign-in per device.

**DO NOT substitute the policy route.** Re-litigating this is explicitly forbidden (§3): an
`ExtensionInstallForcelist` badge is a property of the **browser** (not the session), is **permanent**, says
**"Managed by your organization"**, is a signal Google actively tells users to remove, and makes the
extension **un-installable by the user** while set. A self-hosted CRX is **impossible on Windows** (Chrome 33+
requires `update_URL` to be the Web Store), so "silent + no policy + our own server" does not exist. The
registry `update_url` used by Route B needs **no policy and no badge**, is **user-removable**, and rolls back
by deleting two keys — its only cost is that it takes effect at the **next Chrome start**.

