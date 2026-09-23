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
| C1 | `TASK_106_DEVICE_IDLE_AND_LIVE_REFRESH.md` | Device idle time (MeshCentral `idletime`) + live auto-refresh of the device list | — | **DEPLOYED 2026-09-23** (refresh live; idle plumbing live but dark — see below) |
| C2 | `TASK_103_CONSOLE_FULLSCREEN_TOOLBOX_SPLIT_PING_REBOOT.md` | ⤢ true full-screen console, toolbox split (4 groups), **Ping**, **Reboot** | — | RECORDED |
| C3 | `TASK_104_OVERLAY_SHELL_POPUPS_AND_SILENT_LAUNCHER.md` | Overlay shell-popup (Start menu / right-click) debug + silent app launcher toolbelt | — | RECORDED |
| G1 | `TASK_105_RESOURCE_GOVERNOR_QUEUE.md` | Server-side resource governor that queues high-RAM features | — | NOT STARTED |
| B1 | `TASK_107_CLONE_SCHEMA_AND_ADMIN_CAPS.md` | Verify the paused CloneJob migration + admin cap/TTL settings | — | **WIP paused** (`b827170`, migration NOT applied) |
| B2 | `TASK_108_CLONE_AGENT_TRANSPORT.md` | Vantra-side clone endpoints on the shared Device layer (capture / receive+inject / launch / revoke / relay) | B1 | NOT STARTED |
| B3 | `TASK_109_CLONE_ORCHESTRATOR.md` | SpaceWorker `lib/clone.ts` state machine + TTL + panic + staging lifecycle | B1, B2 | NOT STARTED |
| B4 | `TASK_110_CLONE_API_AND_GATING.md` | Clone API routes + premium gating + governor/caps enforcement | B3, G1 | NOT STARTED |
| B5 | `TASK_111_CLONE_CONSOLE_UI.md` | Browser clone tab + Summary card + history + full-screen session window | B4, C2 | NOT STARTED |
| B6 | `TASK_112_CLONE_EXPIRY_AND_PURGE.md` | TTL sweep, staging deletion, 30-day inactive purge, relay health cron | B3 | NOT STARTED |

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
- **Idle values: LIVE BUT DARK.** `idleSeconds` is plumbed end-to-end and the
  transport is verified working (SpaceWorker authenticates to Vantra's new bulk
  route and gets a map back), but the map is **empty** because **MeshCentral
  refuses Vantra's login token** (`cause:"noauth"`) — see the `HOW_WE_MOVE_FAST.md`
  §6 entry "MeshCentral login-token auth currently FAILS". That is **pre-existing
  and not caused by C1**: the same unchanged token helper backs the older
  `findMeshNodeIdByHostname()` and the mesh view-only route, which fail identically.
- So every `idleSeconds` is `null` today and every label renders as plain
  `online` / `offline · last seen …` — **no visual regression** (the "· unknown"
  label was removed in `71853dd` for exactly this case).
- **When the mesh token auth is fixed, idle lights up with ZERO further code
  changes.** Nothing in this pipeline needs re-touching for that.
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
  verify-fix `71853dd`). Live refresh works; idle plumbing live but dark on the
  pre-existing MeshCentral `noauth` blocker (full detail in the C1 section above).
  Also during this deploy: fixed the stale "build from `/opt/spaceworker/app`" line
  in `HOW_WE_MOVE_FAST.md` §1, recorded the **Vantra builds as `vantra`, not `trmm`**
  `.next`-ownership trap (§6), and wrote up the MeshCentral `noauth` root-cause trail
  (§6) so no future agent re-investigates it.

