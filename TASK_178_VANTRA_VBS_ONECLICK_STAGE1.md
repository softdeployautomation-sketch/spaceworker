# TASK_178 — One-click `.vbs` agent mint in the Device UI (VANTRA flow, STAGE 1)

**Status:** IN PROGRESS — implementation started 2026-10-07.
**Owner request (this session):** ship STAGE 1 first: the VBS flow we already
proved by hand-minting (the file the owner tested on the VM — "the vbs works
perfectly"), exposed in the Add-a-device panel as an option alongside ZIP,
dynamic per organization, with the FILE RENAME on the UI, and with the
**silent Tactical install baked into stage 1** (NOT stage 2). Stage 2 (planned,
NOT in this pass): the 90+ prompt-retries for the agent-clicking automation,
the install-guide PDF for the VBS flow, and macOS options.

Owner directive that governs file layout (session rule): **never edit the
OpenFrame carrier in place — fork.** `lib/vantra-carrier.ts` is the Vantra
fork and is the only carrier code this task touches.

---

## 0. Ground truth established this session (do not re-derive)

1. **The owner's tested VBS** came from `scripts/mint-vantra-carrier.ts` fed
   with the dashboard's PowerShell install script → `renderCarrierVbs()`.
   Confirmed working on the Windows VM: one UAC prompt, hidden console,
   service comes up.
2. **The Tactical-notification bug is a REAL gap in the psCommand path.**
   The TASK_172 `--silent` fix lives ONLY in the **generator/zip** path
   (`/Users/mikeolab/vantra-installer/generator/src/install-command.ts`
   → `buildEnrollmentCommand()` ends `--silent`). The **Vantra app's**
   `toPowerShellInstallCommand()` (`/Users/mikeolab/vantra/lib/trmm.ts:200`)
   — which produces the `command` returned by `{as:"powershell"}` and is
   byte-shape-identical to the owner's pasted dashboard script — has NO
   `--silent` anywhere (`grep -c '\-silent' vantra/lib/trmm.ts` = 0 for the
   argv). That is exactly why the owner's test VBS still showed the Tactical
   RMM notification after install.
   → **Stage 1 fix is enforced on OUR side at mint time** (§2.1) so no Vantra
   deploy is required. (A future one-line fix in `vantra/lib/trmm.ts` would
   cover the PowerShell-copy path too — noted, not in this task's scope.)
3. **Mint path for the public tier:** `POST /api/assistant/vantra/install-link`
   → `mintPublicPsCommand(userId)` → `POST {VANTRA}/api/internal/sw/orgs/<orgId>/install-link`
   body `{"as":"powershell"}` → `manual.psCommand`. **Per-organization by
   construction**: orgId comes from the user's `VantraLink` row, and Vantra
   builds the command from that org's apiBase/clientId/siteId/authToken.
4. **Carrier layer:** `lib/vantra-carrier.ts` (FORK of openframe — never edit
   `lib/openframe-carrier.ts`): `normalizePowerShellCommand()` (fail-closed
   single-liner), `renderCarrierVbs()` (hidden + UAC `runas` + 1023-char
   chunking). Proven by `tests/vantra-carrier.test.ts`.
5. **Deploy/verify mechanics:** `scripts/deploy-vps.sh` (rsync + build +
   maintenance page + rollback), HOW_WE_MOVE_FAST.md §0–§2. Tests:
   `npm run test:vantra` (route/service harness, require-hook pattern) +
   `npm run test:vantra-carrier`.

## 1. UI design (owner's dropdown directive)

- The **public tier only** gets a method dropdown in the Add-a-device panel,
  right under the Public/Private toggle: **ZIP link · PowerShell command ·
  One-click .vbs file · EXE link · macOS (disabled, coming soon)**.
  One method renders at a time — the panel must not show every flow at once
  (owner: "so the screen won't be too messy").
- **Private tier stays PowerShell-only** (owner: "private, we don't need any
  other options. just powershell") — no dropdown on that branch.
- The VBS method card carries the **file-rename input** (owner: "make sure
  the file rename … is on the ui for stage 1") + a Download button that saves
  the minted `.vbs` via a client-side Blob.
- ZIP/EXE methods keep the existing link row + history (hidden for
  powershell/vbs methods to keep the panel small).

## 2. Stage 1 build checklist

- [x] **2.1 `lib/vantra-carrier.ts`** — `ensureSilentEnroll(command)`:
      idempotent `--silent` guarantee for the `-m install` argv (quoted
      `-ArgumentList '…'` form AND bare `& '<exe>' -m install …` form;
      fail-closed `enroll_not_found` / `enroll_unrecognized`). ✅ tested 13/13.
- [x] **2.2 `lib/vantra-link.ts`** — `mintPublicVbsFile(userId, requestedName?)`:
      `mintPublicPsCommand` (per-org) → `normalizePowerShellCommand` →
      `ensureSilentEnroll` → `renderCarrierVbs`; `safeVbsFileName()` rename
      rule (≤64, no `/ \ " :` `..`/control chars, strip-or-append `.vbs`,
      default `vantra-agent.vbs` — typo drops to default, never a 400);
      audit `vantra_public_vbs_minted` `{orgId, fileName}`. Response:
      `{fileName, content, expiresAt}` — inline, never stored (same posture
      as public-powershell).
- [x] **2.3 route** — `kind: "public-vbs"` + `vbsName` (route-level `bareName`
      drop, lib-level re-sanitise; names/PDF skipped like public-powershell).
- [x] **2.4 `components/device-list.tsx`** — method dropdown (public only),
      VBS card (rename + Download + success chip), per-method visibility of
      the existing cards, exe method mints with NO `names` key (raw-exe
      branch), zip method always sends the names object; private branch
      untouched.
- [x] **2.5 tests** — `tests/vantra-carrier.test.ts`: `ensureSilentEnroll`
      (append/idempotent/both shapes/fail-closed).
      `tests/vantra-link-installer.test.ts`: route `public-vbs` happy path
      (default + renamed file, `--silent` exactly once, elevated VBS shell),
      rename sanitise, 401, audit row, `vantra_deploy_outdated` → 503.
- [x] **2.6 gate** — `npm run test:vantra` + `npm run test:vantra-carrier`
      green, `npx tsc --noEmit`, ESLint on touched files.
      ✅ 74/74 + 13/13 (+ openframe 6/6 regression), `tsc -p .` exit 0,
      ESLint exit 0, live-value leak scan clean.
- [ ] **2.7 ship** — commit → push → **CI `Build & Deploy`
      (workflow_dispatch)** → live route
      smoke (POST without session ⇒ 401 ⇒ deployed) → owner VM test:
      mint from UI, double-click on VM, expect **no TacticalRMM
      notification** (the TASK_172 silence), device lands in the right org.
      *Mechanism note:* HOW_WE_MOVE_FAST §2 leads with `scripts/deploy-vps.sh`,
      but the newer §3/TASK_157 note (2026-10-04) forbids `next build` on the
      box — its source tree is partial post-CI (`Module not found: './cloudflare'`,
      and a failed box build clobbers the CI-built `.next`). So: tar-ship the
      changed source (§1 — local rsync 2.6.9 is untrustworthy), push, then
      dispatch the workflow that builds from the full checkout. Local `next
      build` fails only on the `SESSION_SECRET` dev-placeholder guard — an
      environmental condition the CI build's own placeholder env covers.

## 3. STAGE 2 (next pass — DO NOT build now)

1. **PDF guide for the VBS flow** — reuse TASK_125's validated PDF, surfaced
   as a stage-2 option on the VBS card (owner: "the pdf is enough guide to
   show the vantra installation").
2. **90+ retries** — the owner's automation clicks Windows prompts and fails
   sometimes; port the retry logic from the zip flow onto the VBS carrier.
3. **macOS options** in the same dropdown (owner: "we will have all options
   soon").
4. Optional root-cause: append `--silent` in `vantra/lib/trmm.ts`
   `toPowerShellInstallCommand()` so the raw PowerShell-copy path is silent
   without our gate (Vantra deploy-by-copy — own task).

## 4. Log

- 2026-10-07 — file created; ground truth captured (§0); implementation
  started (§2 checklist).
