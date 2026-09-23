# Pipeline — Device Console & Browser Clone (tracker)

**Status: OPEN — this file is the single tracker for the console + clone work.**

## How this pipeline works (read this first)

1. The **owner** hands one task file to one agent (paste the path, say "treat this").
2. The **agent implements and COMMITS ONLY** — no deploy, no VPS, no `.env`, no
   `prisma migrate deploy`. See the standard contract below.
3. The **owner verifies and deploys** (build → migration → restart → live check)
   using `HOW_WE_MOVE_FAST.md` §0–§3, then flips the task's status line in this
   tracker.

### STANDARD AGENT CONTRACT (every bit in this pipeline)

> **COMMIT ONLY. DO NOT DEPLOY.**
> - Work on branch `agent/<task-slug>` (or a fork PR per `MICHAEL_BRIEF.md`).
> - `npx tsc --noEmit` must be clean in **both** repos if both are touched.
> - **Never** edit, create or rsync `.env`; never ssh the VPS; never run
>   `prisma migrate deploy` / `npm run build` on the server.
> - Hand-write the migration SQL (never `migrate dev`); mirror the style of the
>   existing migrations.
> - **Never** write JSX/PowerShell through a shell heredoc — use the file editor,
>   then verify (`HOW_WE_MOVE_FAST.md` §6).
> - Stay inside the task's declared file list. If you must go outside it, stop
>   and ask — do not improvise scope.
> - End your run by reporting: files changed, `tsc` result, and anything you
>   could not verify locally.

### Mandatory reads for every bit

- **`HOW_WE_MOVE_FAST.md`** — deploy discipline, §6 gotchas (append-only).
- **`PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md`** — §CROSS-TRACK RULES 1–8 (one gate,
  secrets classes, shared primitives, admin limits, manual-parity), §PRIORITY P2.
- **`DESIGN_DEVICES_PAGE.md`** + **`DESIGN_BROWSER_CLONE_UI_AND_FLOW.md`** for
  anything user-facing.
- **`MICHAEL_BRIEF.md`** if the work is a fork/PR deliverable.

---

## The bits (order = recommended pick-up order)

| # | Task file | Scope | Depends on | Status |
|---|---|---|---|---|
| C1 | `TASK_106_DEVICE_IDLE_AND_LIVE_REFRESH.md` | Device idle time (MeshCentral `idletime`) + live auto-refresh of the device list | — | **DONE · DEPLOYED · VERIFIED 2026-09-23** (both halves live) |
| C1-fu | (no new file — owner request) | **One last-seen per screen**: the duplicate display was removed in BOTH surfaces; the freed list cell is reserved for Ping (C2/MISSING-1) | — | **DONE · DEPLOYED 2026-09-23** |
| C2 | `TASK_103_CONSOLE_FULLSCREEN_TOOLBOX_SPLIT_PING_REBOOT.md` | ⤢ true full-screen console, toolbox split (4 groups), **Ping**, **Reboot** | — | RECORDED |
| C3 | `TASK_104_OVERLAY_SHELL_POPUPS_AND_SILENT_LAUNCHER.md` | Overlay shell-popup (Start menu / right-click) debug + silent app launcher toolbelt | — | RECORDED |
| G1 | `TASK_105_RESOURCE_GOVERNOR_QUEUE.md` | Server-side resource governor that queues high-RAM features | — | NOT STARTED |
| B1 | `TASK_107_CLONE_SCHEMA_AND_ADMIN_CAPS.md` | Verify the paused CloneJob migration + admin cap/TTL settings | — | **DONE · DEPLOYED · VERIFIED 2026-09-23** |
| B2 | `TASK_108_CLONE_AGENT_TRANSPORT.md` | Vantra-side clone endpoints on the shared Device layer (capture / receive+inject / launch / revoke / relay) | B1 | **DONE · DEPLOYED · VERIFIED 2026-09-23** (7 routes live; 401/404/400/503 boundaries proven; guard 500→404 hotfix `23f9919`; owner-only: real device capture/launch) |
| B3 | `TASK_109_CLONE_ORCHESTRATOR.md` | SpaceWorker `lib/clone.ts` state machine + TTL + panic + staging lifecycle | B1, B2 | NOT STARTED |
| B4 | `TASK_110_CLONE_API_AND_GATING.md` | Clone API routes + premium gating + governor/caps enforcement | B3, G1 | NOT STARTED |
| B5 | `TASK_111_CLONE_CONSOLE_UI.md` | Browser clone tab + Summary card + history + full-screen session window | B4, C2 | NOT STARTED |
| B6 | `TASK_112_CLONE_EXPIRY_AND_PURGE.md` | TTL sweep, staging deletion, 30-day inactive purge, relay health cron | B3 | NOT STARTED |

### Out-of-band (found during pipeline work — NOT clone-pipeline bits)

| # | Task file | Scope | Status |
|---|---|---|---|
| OOB-1 | `TASK_113_SCHEMA_DRIFT_DEVICE_LAYER_FKS.md` | Pre-existing Task-92 drift: 13 device-layer FKs are `ON DELETE CASCADE` in the live DB where the datamodel declares `RESTRICT` (+1 reversed RESTRICT→SET NULL, +1 index name). The DB currently **destroys** device/audit rows on delete — the exact thing RULE 5 forbids | NOT STARTED |

### Dependency graph

```
C1  C2  C3  G1        (independent console/ops bits)
             \
B1 ─┬─ B2 ─ B3 ─┬─ B4 ─ B5
    │           └─ B6
             (G1 feeds B4's caps enforcement)
```

### C1 deployed state (2026-09-23) — read before touching idle

**Shipped and live:** both halves are deployed (Vantra `0424b7b`, SpaceWorker
`589292f` + verify-fix `71853dd`), services active, builds clean.

- **Live auto-refresh: WORKING.** The device list re-polls `/api/devices` every 20 s
  (paused while the tab is hidden; refreshes on becoming visible), clearing the
  original complaint that the list only updated on reload.
- **Idle values: LIVE AND WORKING (verified end-to-end against the live boxes).**
  Real `idleSeconds` arrive from MeshCentral and join onto SpaceWorker's own device
  rows — live proof: `fetchUserIdle -> {"Sc":35,"WilkSF9":0}` then
  `JOIN -> 2/2 device rows got a real idle value`. Labels therefore render as
  `online · active now` / `online · idle 12 min` / `idle 3 hr`.
  *It was dark for most of the day* because **MeshCentral rejected Vantra's login
  token** (`cause:"noauth"`) — **pre-existing, not caused by C1**: the same unchanged
  token helper backs the mesh view-only route, which was equally broken. Root cause
  and the two-part fix are in `HOW_WE_MOVE_FAST.md` §6 ("MeshCentral login-token auth
  — RESOLVED"). One-line version: the token's `u` must be the **full userid**
  (`user//name`) and the env had a **bare** name.
- **Follow-on win (free): VERIFIED + CLOSED 2026-09-23.** That same fix repairs the
  pre-existing **mesh view-only session** flow (it had been failing for exactly the
  same reason). Proven by running Vantra's *real* functions against the live socket —
  deployed full userid → 3 nodes; a **bare** override → still 3 nodes (normalisation
  works); `findMeshNodeIdByHostname("Sc")` → `node//…`; `createViewOnlyShareLink()` →
  share URL; `GET <share url>` → **HTTP 200, 149135 bytes**. Nothing left to do here;
  do not re-open.
- **C1 follow-up (owner request, same day): one last-seen per screen.** The list row
  printed the same timestamp twice — the status chip (`offline · last seen 23 min
  ago`, `device-list.tsx`) and a dedicated "Last seen" column rendered *identically*
  right beside it; the console had the same duplication (`Summary` "Last seen" row vs
  the header chip). The **chip wins** (always visible, survives scrolling), so the
  duplicate column/row was removed in both files and **the freed list cell is now the
  reserved slot for the Ping button** (TASK_103 MISSING-1) so the row keeps its grid
  shape when that lands. `User activity` now reports idle only (idle exists only while
  connected) and shows `—` when offline instead of restating last-seen.
- **Visibility caveat:** idle renders only for devices SpaceWorker counts as
  `online`/`asleep` (its own heartbeat window). A device MeshCentral still sees as
  connected but SW marks `offline` shows `offline · last seen …` instead — that's by
  design, and it's why both of today's live devices still show `offline` labels while
  carrying idle values.
- **Unit is settled, don't re-investigate:** MeshCentral's `idletime` is in
  **seconds** (`agents/meshcore.js` → `win-deskutils.idle.getSecondsAllSessions()`,
  sampled ~every 5 min, most-recently-active session on the box). The shipped
  `MESHCENTRAL_IDLETIME_UNIT = "seconds"` is correct.


### Owner-confirmed decisions this pipeline encodes (do not re-litigate)

- **Direct-egress launch is PREMIUM ONLY** (owner 2026-10).
- **Clone records are kept** (audit value) and users can delete their own;
  **inactive records purge after 30 days** (`AdminSetting.clonePurgeAfterDays=30`).
  Only the *staging material* (encrypted capture) is deleted at revoke/expiry.
- **Hosted PCs are POOLED** (not one-per-user) — `AdminSetting.hostedPoolSize`,
  admin-set like every other RAM consumer (CROSS-TRACK RULE 7).
- **Manual actions never need approval**; approvals are for agent-initiated
  requests only (owner rule).
- **Session TTL defaults**: 60 min idle / 8 h hard cap — exposed as
  `AdminSetting.cloneIdleTtlMinutes` / `cloneHardTtlMinutes`, not hardwired.
- The clone **engine + MT-1 scripts already exist** (merged, `be88e29`); this
  pipeline is orchestration + schema + UI, not new device engineering.

---

## Owner runbook (per bit, after the agent commits)

1. Read the agent's diff — confirm it stayed inside the declared file list.
2. `npx tsc --noEmit` in the touched repo(s); `npm run build` locally.
3. For a migration bit: back up `.env` + DB, `prisma migrate deploy`,
   `prisma generate`.
4. Deploy per `HOW_WE_MOVE_FAST.md` §2 (`rsync --files-from … --exclude='.env'`,
   **with `-r`**, then build as the service user, then restart).
5. Live-verify (curl the route, check the journal, run the task's acceptance
   list). Only then flip the status line here.

## Status log

- 2026-10-02 — pipeline created; C1–C3, G1, B1–B6 registered above.
- 2026-09-23 — **C1 verified + DEPLOYED** (Vantra `0424b7b`, SpaceWorker `589292f`,
  verify-fix `71853dd`). Live refresh works; idle was initially dark on a
  pre-existing MeshCentral `noauth` outage.
- 2026-09-23 — **`noauth` ROOT-CAUSED + FIXED; C1 idle now fully live.** The token's
  `u` must be the full MeshCentral userid (`user//name`); the env had a bare name (the
  key itself was correct — verified byte-identical to MeshCentral's
  `LoginCookieEncryptionKey`). Two-part fix: `/opt/vantra/.env`
  `MESH_LOGIN_USER=user//vantra-service___4` (snapshot
  `/root/vantra.env.bak-t106fix-*`) **and** `makeLoginToken()` now normalises a bare
  name (Vantra `8296f47`, rebuilt + redeployed, build `EXIT:0`). Verified end-to-end
  live: `fetchUserIdle -> {"Sc":35,"WilkSF9":0}` and `JOIN -> 2/2 device rows got a
  real idle value`. **Bonus:** the pre-existing **mesh view-only session** flow is
  repaired by the same fix — **verified + closed 2026-09-23** (real
  `findMeshNodeIdByHostname` + `createViewOnlyShareLink` against the live socket:
  share URL minted, `GET` → HTTP 200 / 149135 bytes, and a bare-username override
  still authenticates). Full trail in `HOW_WE_MOVE_FAST.md` §6.
- 2026-09-23 — **C1-fu (owner request): one last-seen per screen.** Removed the
  duplicate last-seen rendering in BOTH surfaces (list column beside the status chip;
  console Summary row below the header chip). Chip wins; the freed list cell is the
  reserved slot for Ping (C2/MISSING-1). `User activity` reports idle only, `—` when
  offline.
- 2026-09-23 — **B1 DEPLOYED + VERIFIED.** Branch `agent/task-107-clone-schema`
  (`399a804`) merged to `main` as `7f27457`. DB backed up first
  (`/root/spaceworker-db.bak-t107.sql`), `prisma migrate deploy` → *all migrations
  applied*, `generate` → build (`trmm`, 0 errors) → restart. Live checks: migrate
  status **up to date**; 3 tables + 14 indexes (incl. both new sweep indexes) present;
  9 `AdminSetting` clone columns with defaults exactly matching
  `CLONE_SETTING_DEFAULTS`; `GET /api/admin/clone-limits` **403 unauth**, **full payload
  with a real admin session**; `PATCH {"maxConcurrent":3}` persisted then restored;
  `0` / unknown key / non-int all **400**; `/admin` 200 with the new block in the built
  chunk. Acceptance #2 (the shadow-DB test the agent couldn't run) satisfied against the
  **live** DB instead: drift filtered to clone objects = **none**.
- 2026-09-23 — **B2 DEPLOYED + VERIFIED.** `spaceworker 68c6586` + `vantra b7b42e4`
  merged to `main` and deployed (`.env` snapshotted, rsync `--exclude='.env'`, rebuild
  as the service user, restart). Both services active, both sites 200. All **7**
  clone/relay routes present; Vantra's bundle contains the command layer (7 compiled
  files). Boundaries proven live: invalid secret → **401 ×7**; valid secret + unknown
  agent → **404**; valid secret + real sw-linked agent → guard passes (route moved to
  its own zod check, 400 for a missing `cloneId`); offline device → **503** "This
  device is currently offline." Zero new 500s/errors in the journal; deployed
  `lib/clone-transport.ts` hash matches the commit. **Bug found + fixed:** the shared
  tenant guard let `getAgentDetail`'s `TRMM 404` throw escape, so every `sw-` route
  answered **500 instead of 404** for an unknown agent (contract violation + journal
  noise) — fixed in `23f9919`, verified 500→404. Two findings carried to B3/B4: agent
  RPC can take **~62 s** (client timeouts must exceed 60 s), and `clone-transport.ts`
  is intentionally absent from the SW build until B3/B4 import it. Remaining
  owner-only acceptance: real device capture/launch (needs the device online).
- 2026-09-23 — **OOB-1 filed (`TASK_113`) from B1's live drift check.** The 87-line drift
  is **entirely pre-existing Task-92** and contains **zero** clone references — B1 is
  clean. Real mechanism (corrected after reading `pg_constraint`): the FKs exist with the
  **same names** but the **wrong delete actions** — **13 × DB `CASCADE` where the
  datamodel declares `RESTRICT`**, **1 reversed** (`DeliverabilityCheck_seedMailboxId_fkey`
  DB RESTRICT / schema SET NULL), plus one index-name drift
  (`…relationType_k` → `…relationTy_key`). So the DB silently cascades device/audit
  deletes — the exact failure RULE 5 exists to prevent. Verified behaviourally inert
  today (no app code deletes a `Device`/`User`). Fix = Prisma's own diff output as an
  additive migration; owner applies.
  Also during this deploy: fixed the stale "build from `/opt/spaceworker/app`" line
  in `HOW_WE_MOVE_FAST.md` §1, recorded the **Vantra builds as `vantra`, not `trmm`**
  `.next`-ownership trap (§6), and wrote up the MeshCentral `noauth` root-cause trail
  (§6) so no future agent re-investigates it.

