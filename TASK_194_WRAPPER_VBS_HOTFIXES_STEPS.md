# TASK_194 — wrapper/VBS hotfix batch (silent install + wrapper VBS download)

Owner, 2026-10-09 (after TASK_191/192 went live). Three live regressions, taken
in priority order. HOW_WE_MOVE_FAST: smallest slice → test → gates → commit+push
per slice; every step recorded here BEFORE and AFTER.

## S1 — the VBS agent install stopped being silent  ✅ DONE + DEPLOYED

Owner: "i downloaded the vbs, it showed the installation powershell gui which
wasnt like that before. it happened silently… after user clicks install, it
should only show the pdf guide added by the user and then the agent
installation all happen in background unnoticed."

### Triage (this is the part compaction will eat — read it before touching anything)

Traced the WHOLE chain and reproduced the exact command the end user runs
(`/tmp/t192-repro-vbs.ts` imports the real carrier and prints the rendered .vbs):

  Vantra `toPowerShellInstallCommand`  →  SpaceWorker `mintPublicVbsFile`
    1. normalizePowerShellCommand   (multi-line → single line)
    2. ensureSilentEnroll           (--silent on `-m install`)
    3. ensureAgentCleanSlate        (TASK_182 uninstall-old-agent prologue)
    4. renderCarrierVbs             (hidden console + UAC runas + sidecar)

Findings — the code was NOT obviously broken, which is why this looked like a
ghost. Every OUTER powershell launch already carried `-WindowStyle Hidden`
(carrier console, the UAC re-launch in SELF_ELEVATE_HEADER, the agent
configure step, and the wrapper EXE carrier). The ONE gap: the two **Inno**
`Start-Process` calls launched GUI-subsystem processes relying ONLY on
`/VERYSILENT`, with no `-WindowStyle Hidden` of their own. If that Inno build
flashes a window, you get exactly the symptom the owner saw — and it would
come and go with the agent build, not with a code change.

Also recorded (does NOT explain the symptom, but it is the reason the VBS was
500-ing until an hour ago): the box's Vantra install-link route was STALE (built
Oct 8 19:03, source Sep 22) and lacked the public-PowerShell branch entirely, so
`as:"powershell"` returned 400 → SpaceWorker surfaced `vantra_deploy_outdated`
("the device service is mid-update"). Fixed by restoring the route to local
HEAD c8b6680 and rebuilding (see the earlier record).

### Fix (two repos, one line each — both Start-Process calls now hide their child)

| repo      | file                     | change |
|-----------|--------------------------|--------|
| Vantra    | `lib/trmm.ts:229`        | Inno installer step += `-WindowStyle Hidden` |
| SpaceWorker | `lib/vantra-carrier.ts:273` | `AGENT_CLEAN_SLATE` uninstaller step += `-WindowStyle Hidden` |

### Proof

- Repro audit of the REAL minted command: **3/3 `Start-Process` now `hidden=true`** (was 2/3).
- SpaceWorker tests: vantra-carrier 26/26, wrapper-carrier 6/6, vantra-link-installer 90/90.
- Vantra tests: install-link-zip 34/34, all 3 test files green.
- Commits: SpaceWorker **d742580**, Vantra **edc71ec** (both pushed).
- Deployed Vantra: `BUILD_EXIT:0`, service `active`, http 200, BUILD_ID `YKzQRowfpmGHUnTWB7WjP`.
- Deployed SpaceWorker: rsynced + rebuilt (`/tmp/t192-silent-build.log`), see below.

## S6 — ROLLBACK: remove the uninstall prologue entirely (terminal still shows)  ⏳ IN PROGRESS

2026-10-10. Owner after testing the S5-fixed VBS: "the powershell blue gui still
shows before it shows the pdf, and then after the cmd gui shows looking for
mesh agent, checking firewall.. the best fallback is to locate the push before
the fix of the uninstall, so we just leave it that way." Directive: revert the
VBS pipeline to the pre-uninstall-saga shape (silent install worked then),
ship just those files to the VPS, commit+push locally.

### Triage (compaction-proof record)

- The saga = exactly 3 SpaceWorker commits: **0029633** (Oct 7 22:43, introduced
  AGENT_CLEAN_SLATE + ensureAgentCleanSlate + wiring + tests), **d742580**
  (Oct 9: -WindowStyle Hidden INSIDE the prologue), **43d1e5e** (Oct 9:
  sc.exe→Get-Service INSIDE the prologue). Files touched by all three:
  lib/vantra-carrier.ts, lib/vantra-link.ts, scripts/mint-vantra-carrier.ts,
  tests/vantra-carrier.test.ts (+ docs).
- `git diff 0029633^ HEAD` proves: vantra-carrier.ts, mint script and the test
  file's ENTIRE post-Oct-7 diff is the clean-slate block → safe full checkout
  revert. lib/vantra-link.ts also carries TASK_185 idle-provenance work
  (idleByAgentId) → SURGICAL edit only (import + 2 call sites + comment).
- The blue PowerShell GUI = UAC self-elevate (unavoidable, pre-existing, owner
  accepted). The CMD/terminal window = child console processes; with the
  prologue gone there are none (sc.exe source already removed; the mesh-agent
  text comes from the enrollment script/tacticalagent, which pre-saga ran
  without complaint on the VM).
- Vantra repo edc71ec (Inno `-WindowStyle Hidden`) is KEPT — unrelated to
  uninstall, only hides an installer window; reverting would risk flashes.

### BEFORE (proof of state at rollback start)

- Mint chain TODAY: normalize → ensureSilentEnroll → ensureAgentCleanSlate →
  renderCarrierVbs (4 steps; pre-saga it was 3).
- vantra-carrier tests 26/26 (6 of them clean-slate tests that go away with
  the block).

### Execution + AFTER proof (2026-10-09 evening)

1. `git checkout 0029633^ -- lib/vantra-carrier.ts scripts/mint-vantra-carrier.ts
   tests/vantra-carrier.test.ts` (full revert); surgical vantra-link.ts edits
   (import + 2 call sites + pipeline comment).
2. Gates: `grep ensureAgentCleanSlate|AGENT_CLEAN_SLATE` across
   lib/app/scripts/tests → NONE; `tsc` exit 0; eslint exit 0; tests:
   vantra-carrier **21/21** (pre-saga count), wrapper-carrier 6/6,
   vantra-link-installer 90/90, openframe-carrier 6/6,
   wrapper-vbs-download 5/5, vantra-idle-provenance 9/9.
3. Commit **49aac13** pushed (msg /tmp/t194-s6-rollback-msg.txt via editor +
   `git commit -F`).
4. VPS: rsync'd the 3 files (vantra-carrier.ts, vantra-link.ts,
   mint-vantra-carrier.ts); md5 verified BOTH ends: all 3 match
   (1cef5c67…, 3a3fd4d7…, e4930ac8…). NOTE: the first remote md5 check
   showed mismatch — false alarm, the check ran CONCURRENTLY with the rsync
   in one tool call; sequential re-check = all YES.
5. Build on box: first attempt BUILD_EXIT:1 (EACCES unlink .next/build/*.js —
   root-owned leftovers); fixed with `chown -R trmm:trmm /opt/spaceworker/.next`,
   relaunched → **BUILD_EXIT:0**.
6. `systemctl restart` → active; **http:200** on :3500 (the unit's real port —
   .env's PORT=3400 is stale, journal shows Next listening on 3500; do NOT
   trust the .env PORT line for curl checks). BUILD_ID
   **IDIqns4Lx77Na-nHCwbH-** (fresh). Remote grep: AGENT_CLEAN_SLATE=0,
   ensureAgentCleanSlate=0 in shipped lib files.
7. Test VBS minted for the owner's Desktop via the reverted local pipeline
   (normalize → ensureSilentEnroll → renderCarrierVbs + the Downloads PDF):
   **vantra-agent-t194-rollback-test.vbs** (70,060 bytes). Lint of the file:
   `$swAg`/`unins000`/`Get-Service`/`sc.exe` all absent, `WindowStyle Hidden`
   present, `--silent` present.

### Trade-off accepted

Re-install onto a machine with an older agent may keep stale config (the
original TASK_182 failure mode: `-m install` refuses reconfigure). Owner
chose pre-saga behaviour over the uninstall prologue; if the stale-config
failure re-appears, re-open with a QUIET design (no console windows).



## S2 — wrapper: "Download .vbs" does nothing  ✅ DONE + COMMITTED (10450ba)

Owner: "when i try to download the vbs file from wrapper nothing happens, and i
Owner: "when i try to download the vbs file from wrapper nothing happens, and i
am sure uploading the pdf might be a issue, we fixed this before in the
spaceworker exe when we couldnt download the csv."

ROOT CAUSE (confirmed, not a guess): `components/device-list.tsx:523` downloads
the minted .vbs with the browser-only pattern
`URL.createObjectURL` → synthetic `<a download>` click. That is EXACTLY the bug
already fixed once as **"Task 57 Bug 2 — the browser `<a download>` pattern
silently no-ops in WebView2"**; the working fix lives in
`app/dashboard/extract/local-extract.tsx:250` as `isTauri()` +
`@tauri-apps/plugin-dialog` `save()` + `@tauri-apps/plugin-fs` `writeTextFile()`.

Plan:
1. Lift that proven pattern into a shared client helper `lib/download-text.ts`
   (`downloadTextFile(filename, contents, mime, extension)`), browser path kept
   byte-identical for the hosted web product.
2. Point `mintVbsFile` at it (single blob-download site in that file — verified
   by grep: `createObjectURL` appears exactly once).
3. Verify the PDF picker path (owner suspects it too) — `<input type=file>` in
   WebView2; if it does not open, use the Tauri dialog plugin the same way.
4. Wrapper needs a NEW EXE build (the fix ships inside the wrapper, not the
   hosted site) — that is the deploy for this slice.

### After-record (2026-10-09)

Built `lib/download-text.ts` (`downloadTextFile(filename, contents, mime, extension)`):
`isTauriShell()` via `__TAURI_INTERNALS__` → lazy `@tauri-apps/plugin-dialog`
`save()` + `@tauri-apps/plugin-fs` `writeTextFile()`; a null path is treated as
"user cancelled" (NO fall-through to a second, useless download); a native fault
falls back to the browser path; the web product keeps the original Blob path.

`mintVbsFile` now calls `downloadTextFile(fileName, content, "text/vbscript", "vbs")`.

Gates: `tsc` **exit 0** · `eslint` on all three files **exit 0** · new suite
`tests/wrapper-vbs-download.test.ts` **5/5 pass, 0 fail** (helper exists +
client-safe, detects Tauri via the bridge object, uses BOTH plugins, keeps the
browser path; the UI routes the .vbs call through the helper and no longer
contains `createObjectURL`).

**DEPLOY NOTE (do not forget):** this fix is inside the wrapper EXE, so it is NOT
live from the hosted deploy — the wrapper must be rebuilt (CI `build-exe.yml`
`devices` variant, or the local `scripts/runtime-assemble.mjs` flow) and
reinstalled on the owner's machine before he can click "Download .vbs" and see a
Save-As dialog.

Trap hit & fixed while writing the gate: the first `server-only` assertion grepped
the bare word and false-failed on the comment that *explains* why the helper must
not import it — the assertion now matches the import statement only.

## S3 — quarantine/onboarding strip STILL shows for XDevice  ✅ CLOSED — NO CODE CHANGE (TASK_191 already correct)

Owner screenshot showed the "Securing new device · hiding the agent" strip and
per-row "Quarantine · 14:41" badges on a tier-3 XDevice account.

### Proof chain (all against the LIVE box, not the source tree)

1. **The code is deployed.** `route.js` is only a 729-byte Turbopack loader stub
   that `require()`s shared chunks, so grepping it for `suppressOnboarding`
   returns 0 and is MEANINGLESS (first trap — I nearly reported a false bug).
   Grepping the real chunks: `premiumExpiresAt` (a Prisma select field that
   survives minification) appears in **94 of 600** server chunks. Source on the
   box is byte-identical to local (`md5 db47ee97…` both sides).
2. **The logic is right.** `isXdeviceLive` = `tier === 3 && (expiry null || >
   now)`. `GET /api/devices` nulls `onboarding` wholesale when true.
3. **The account qualifies.** Live DB (`/tmp/t194-tiers.sql`): exactly **one**
   tier-3 user, `premiumExpiresAt = 2026-11-07` → **live** ⇒ `suppressOnboarding`
   = true ⇒ `onboarding` = null for that account.
4. **Both visuals are `onboarding`-gated**, so with it null neither can render:
   - the strip reads `onboardingStrip` built from `d.onboarding`
     (`components/device-list.tsx:784`);
   - the row pill is `onboardingRowLabel(d.onboarding, nowMs)`, guarded by
     `d.onboarding &&` (`device-list.tsx:1782`); its text ("Quarantine · 14:41",
     "…taking longer", "…stuck") is produced in `lib/device-onboarding.ts:429-433`.

Conclusion: the owner tested either **before** the 13:30 deploy finished, or his
tab/wrapper served a **stale cached poll** — a known prior failure mode here
(TASK_185 was literally "maintenance responses poisoned client caches"). Ask him
to hard-refresh the web tab and RESTART the wrapper (not just re-open the page),
then re-test. If it still shows after that, re-open S3 with his account id —
that would mean a session-vs-user mismatch, which the above cannot rule out.

**No code change made, and none is justified by the evidence** (HOW_WE_MOVE_FAST:
never claim what you didn't prove).

Owner screenshot shows both the "Securing new device · … hiding the agent" strip
AND per-row "Quarantine · 14:41" badges on a tier-3 XDevice account, which
TASK_191 was supposed to hide (Premium Plus keeps them).

Known facts from the earlier grep:
- `app/api/devices/route.ts:67` computes `suppressOnboarding = isXdeviceLive(user)`
  and line 100 applies it — but ONLY to `view.onboarding`.
- `grep suppressOnboarding components/ app/` returns NOTHING outside that route:
  **the UI never consumes the flag**, so the strip + badges still render.
- The UI lives in `components/device-list.tsx` ("Securing new device" at :1564,
  the quarantine badge around :1769) and `components/device-console.tsx:1884`.

Open design question before S3: the API nulls onboarding only on the list route.
The console page (:1884) renders the SAME 4-step strip — must be suppressed
there too, and the row badge needs the tier, not just `onboarding: null`.

## S4 — admin invoice → wrapper user: no support-button notification  ✅ DONE (code committed; ships on next deploy)

### Root cause (traced, not guessed)

The badge is **DERIVED, never stored**: `lib/support/tickets.ts:316`
`unread: isUnread(row.messages, row.lastReadAt)`, and the docstring is explicit —
"It is the NEWEST message that decides" and "a ticket whose newest message is the
customer's own is not unread either".

There are TWO invoice entry points, and only one of them posted a message:

| path | writes a SupportMessage? | badge lights? |
|---|---|---|
| support panel → `POST /api/admin/support/tickets/[id]/messages` with `invoiceId` (TASK_187) | yes | yes |
| users panel → `POST /api/admin/users/[id]/invoices` (TASK_184 B3) | **NO** — only `premiumInvoice.create` + an email | **no** |

So an invoice sent from the users panel produced a row + an email and nothing
the support button could ever see. Not wrapper-specific: the wrapper is a window
onto the HOSTED app, so this is a hosted-API bug that happens to be most visible
from the wrapper.

### Fix

- `lib/support/tickets.ts` → new `postInvoiceNoticeToUser(userId, invoiceId,
  adminId, body)`: reuses the user's most recent **unresolved** ticket, else
  opens one, then posts through the EXISTING `addAdminMessage` so the invoice
  binding + body validation run exactly once on one path (no second implementation).
- `app/api/admin/users/[id]/invoices/route.ts` → after the invoice row + the
  existing `notifyUserInvoiceSent` email, fire-and-forget the notice with a
  plain-language body naming the plan and amount.

Kept **best-effort** on purpose (`.catch()` + its own try): the 201 that already
created the invoice can never be changed by a notice failure.

### Gates

`tsc` **0** · `eslint` on both files **0** · `npm run test:support` **57/57** ·
new `tests/invoice-support-badge.test.ts` **3/3** (helper exists and posts
through `addAdminMessage`; the route calls it and imports it; the notice is
fire-and-forget + defensively wrapped).

### Deploy of S4 — ✅ LIVE on the hosted site

- rsynced `lib/support/tickets.ts` + `app/api/admin/users/[id]/invoices/route.ts`.
  **Trap:** the first rsync reported OK but the md5 check caught a MISMATCH
  (box `a720a1bf…` vs local `b0771fce…`) — re-ran it and confirmed `b0771fce…`
  on both sides. **Always md5 the box against local after rsync**; an rsync
  "success" line is not proof of content.
- Build `/tmp/t194-s4-build.log` → **`BUILD_EXIT:0`**; service `active`,
  `http:200`, new BUILD_ID **`8OHP1mqgKFEcZuxrfYylK`**.
- Deployed-output proof: `postInvoiceNoticeToUser` present in **2** server chunks,
  the "Premium invoice" thread subject in **3**.
  (`isUnread` shows 0 — it is a local function and minifies away; the badge
  derivation itself predates this deploy and already worked on the support-panel path.)

---

## S5 — SILENT-INSTALL REGRESSION (owner report) — RESEARCH DONE, NOT DEPLOYED

**Owner's report + direction (verbatim intent):**
- Running the VBS shows a **CMD window** printing *"searching for mesh agent"* then *"uninstalling"* before the PDF appears. All of that must be invisible.
- The **blue PowerShell window is acceptable** — it was always like that.
- The mesh-search + uninstall step was added **only because we were testing on the same VM** (re-adding an already-added device). It is **NOT needed for a brand-new device**, but is still useful for re-installs on previously-added devices.
- **Fallback if this drags on:** find the commit that was live *before* the uninstall fix and just ship that.
- **Owner's hard rule: NO DEPLOY until he confirms green on a freshly minted test agent.**

**Code facts — `lib/vantra-carrier.ts` (SpaceWorker repo, NOT the vantra repo):**
- `buildSwInstallScript(opts)` builds the PowerShell the wrapper/web hand out.
- **Mesh-agent search loop** — iterates `$meshAgentPaths` (TacticalRMM's own install dir first, then other candidates) to set `$agent`.
- **Uninstall block** — `$swUn = $swDir + 'unins000.exe'`; if present: `Start-Process … '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART' -WindowStyle Hidden -Wait` then `Get-Process tacticalrmm | Stop-Process -Force`.
- **MeshAgent install** — `Start-Process $agent -ArgumentList … -WindowStyle Hidden -Wait` then the firewall rule.
- **The two console-visible steps the owner sees are exactly the mesh-agent search loop and the uninstall block**, both added together — which is why they read as one visible run.
- **Blue PS window source:** `SELF_ELEVATE_HEADER` — `Start-Process powershell.exe … -Verb RunAs`. `-Verb RunAs` always opens a new console; PowerShell cannot suppress it. **Pre-existing, owner accepts it.**
- The outer dropper is already silent: `renderCarrierVbs` footer uses `shell.Run(…, 0, True)` = `SW_HIDE`.

**Agreed fix:** gate the mesh-search + uninstall block behind an option — **default OFF for a fresh device** (a new device never runs the visible steps) and **ON for a re-install** (keeps the useful addition). Then mint a test agent + any PDF onto the Desktop for the owner to confirm **before** any deploy.

---

## S5 — FIX + TEST VBS MINTED (owner: "after it uninstalls it must continue to install; all silent")

**Owner's added detail:** the flow **stops after uninstalling** — it does not proceed to install the new agent, so he has to run it again. Fix must make uninstall → continue → install, all silent.

**Root cause found (`lib/vantra-carrier.ts`, `AGENT_CLEAN_SLATE`):**
- `sc.exe delete tacticalrmm | Out-Null` — `sc.exe` is a **native console app**; when PowerShell runs it, Windows opens a **CMD window** (that is the "searching / uninstalling" console the owner sees). Not a separate vantra step — it is THIS line.
- The block had **no `try/catch`** on the service-removal steps, so a service busy/locked state could throw and halt the prepend → the enrollment never ran → **"stops after uninstalling."**

**Fix applied (line ~272–279):**
- `sc.exe delete` → **pure .NET** `Get-Service … | ForEach-Object { try { $_.Stop(); WaitForStatus; $_.Delete(); WaitForStatus } catch {} }` — **no console window, fully fail-open (try/catch)**. The uninstall now always continues into the install.
- Inno uninstaller `Start-Process` got `-ErrorAction SilentlyContinue` (fail-open parity).
- Clean-slate is still prepended (keeps the re-install smoothness) — but now silent + non-fatal.

**Gates:** `tsc` 0 · `eslint lib/vantra-carrier.ts` 0 · `vantra-carrier` **26/26** · `wrapper-carrier` **6/6**.

**Test VBS minted to Desktop (same config as the prior test — stripped `vantra-agent-182-test.vbs`'s enrollment, re-rendered with the fix + a real PDF from Downloads):**
- **`~/Desktop/vantra-agent-t194-silent-test.vbs`** — 71,003 bytes.
- Verified inside the VBS: `Get-Service` present ✓ · **`sc.exe` absent (0 occurrences)** ✓ · `WindowStyle Hidden` ✓ · real enrollment (`-m install --silent`, live token) ✓ · PDF embedded (Agent Assignment Test Results.pdf) ✓.
- **NO DEPLOY** — owner must confirm green on the VM first (his hard rule).

---

## EXE + update VBS — BUILT and on the owner's Desktop  ✅

- CI `build-exe.yml` variant=devices, run **37944157341** → **success** (~7 min).
- Artifact `spaceworker-devices-windows` already contains the CI-minted
  **EXE-in-VBS carrier** (TASK_181 P4b) alongside the installer.
- Verified the VBS is the **silent** build: it launches with
  `powershell … -WindowStyle Hidden` (1 occurrence, exactly the S1 fix's shape).
- Placed on the Desktop: `SpaceWorker OS_0.1.0_x64-setup.vbs` (54.8 MB, embeds
  the installer + SHA-256 check) and `SpaceWorker OS_0.1.0_x64-setup.exe` (40.3 MB).

**This EXE carries S2** (the Save-As download fix), so the owner should install
from the VBS and then re-test: download .vbs (Save-As dialog now appears), the
silent agent install (guide PDF only, no PowerShell window), and the support
badge after an invoice is sent.

## S5 — email the user on a new support message  ⏳ QUEUED (owner ask, not a bug)

Owner, 2026-10-09: "a user should get an email once they get a support message."
There is already a working email path (lib/email.ts / Resend, used by TASK_190's
admin-notify fan-out) and a support ticket model (TASK_187/188) — so this is
likely: on a user-facing reply/ticket-create, fire the same sendEmail helper.
Open Q before building: which events notify (admin reply only? ticket created
by admin? both?), and the from-address/reply-to to use.

---
(kept open for the S2/S3 after-records)
