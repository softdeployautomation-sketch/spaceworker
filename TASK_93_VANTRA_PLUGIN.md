# Task 93 — Vantra plugin: provisioning + gated device tools (P1)

**Status: ready. Depends on TASK_92.** **Plan: `PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md` §PRIORITY (P1), §VANTRA PARITY intro.**

## Read first (mandatory)
- **`HOW_WE_MOVE_FAST.md`** §0/§1/§2/§3 (as TASK_92) — plus: env changes on the VPS are `ssh` sed/append ONLY, never rsync; snapshot first per §2's env rule.
- **`vantra/TASK_82_PER_ORG_AGENT_HOST_ALLOWLIST.md`** — the per-org agent host allowlist this plugin must register new orgs into.
- **`PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md`** §PRIORITY P1, §CROSS-TRACK RULES (gate is absolute).
- Vantra repo layout: `/Users/mikeolab/vantra` (sibling repo, `vantra.service` on the same VPS).

## Goal
Every SpaceWorker user who enables the Assistant gets a hidden Vantra org + can link devices + gets agent device tools — without ever visiting Vantra.

## Deliverables
1. **Migration**: `VantraLink` (userId, orgId, agentTokenEnc, status).
2. **Provisioning service** (`lib/vantra-link.ts`): server-side org creation (`sw-<userId>`) via Vantra's internal API; new env `VANTRA_INTERNAL_TOKEN` added on the VPS by hand (ssh), documented in code comments — NEVER committed, NEVER rsynced. Register org in the Task 82 allowlist.
3. **Install link/token flow**: SpaceWorker issues a one-time install link binding the Vantra agent to the user's org; agent health surfaced in SpaceWorker UI.
4. **Device tools as gated proposals**: wake / reboot / run-script / remote-session via Vantra API, each creating `AgentPendingAction` (kind "device"), one-time execution, `AgentActionAudit` row. Vantra tokens are server-only — never to the client.
5. Admin visibility: which users have links/orgs; revoke = tear down link (audit).
6. **Admin limits (CROSS-TRACK RULE 7):** Vantra-link provisioning rate + device-job concurrency get AdminSetting keys (enabled + max) surfaced in the admin panel with live counts — no hardwired caps.

## Non-goals
Devices grid/detail UI (Task 95), clone (97), lab (98).

## Acceptance
- Enabling the Assistant creates exactly one `VantraLink` + org (idempotent); the org appears in the Task 82 allowlist.
- Install link binds a test VM's Vantra agent; device appears online (heartbeat from Task 92).
- Wake/reboot/script proposals: approve in web → executes once → second-approve rejected → audit rows present.
- Admin panel shows the provisioning/job-limit settings with live counts (CROSS-TRACK RULE 7).
- `VANTRA_INTERNAL_TOKEN` NOT in repo, NOT overwritten by deploys (verify `.env` still has it after a §2 deploy).
