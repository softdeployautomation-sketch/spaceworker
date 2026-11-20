# Task 96 — Wake-on-LAN + keep-awake (P3)

**Status: ready. Depends on TASK_93 (org peers) + TASK_94 (approvals exist).**
**Plan: `PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md` §PRIORITY (P3), §FINALIZED DECISIONS M3.**

## Read first (mandatory)
- **`HOW_WE_MOVE_FAST.md`** §0–§3 (as TASK_92).
- **`PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md`** §PRIORITY P3, §SCHEMA (`DevicePowerPolicy`, `DeviceRelationship`), M3 decision.
- Vantra agent script-exec path from Task 93/95 (how SpaceWorker triggers a script run on an org-peer device).

## Goal
Users keep devices reachable: one-tap "stay on" (indefinite/timed) + WoL fallback + a "wake then act" composite gated action.

## Deliverables
1. **`DevicePowerPolicy`** (mode `off|timed|indefinite`, `until`) + API + UI (one-tap command button in device detail; user-initiated both ways → no proposal gate, but audited).
2. **Keep-awake execution**: Vantra-agent script (powercfg request-override / keep-awake helper) applied/cleared per policy; policy status visible in UI.
3. **WoL relay (v1 = org-peer only per M3)**: magic packet sent by any OTHER online Vantra agent on the same LAN (org peers from `DeviceRelationship`); server relays the request to the peer as a gated action. No router assumptions in v1.
4. **"Wake then act" composite**: gated proposal that wakes (if asleep) → waits for heartbeat → executes the queued child action; timeout → fail closed with audit.
5. Reachability state surfaced in UI + agent context (online / asleep / offline).

## Non-goals
Router WoL integrations (later, on demand); Browser Clone (97).

## Acceptance
- VM test: put device to sleep → approve "wake then act" proposal → device wakes (org-peer relay) → child action runs once → audit trail complete.
- Timed keep-awake expires on schedule (policy flips to `off`, helper cleared).
- `tsc --noEmit` clean; §2 deploy; journalctl clean.
