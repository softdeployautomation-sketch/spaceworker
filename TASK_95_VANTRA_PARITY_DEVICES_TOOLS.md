# Task 95 — Vantra parity: devices + tools + org/agent-granting + nav (V1, V2, V5, M7)

**Status: ready. Depends on TASK_92/93.**
**Plan: `PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md` §VANTRA PARITY TRACK.**

## Read first (mandatory)
- **`HOW_WE_MOVE_FAST.md`** §0–§3 (as TASK_92).
- **`PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md`** §VANTRA PARITY (V1/V2/V5), §FINALIZED DECISIONS M7 (nav + dashboard cards), §CROSS-TRACK RULES 1/5.
- **Vantra reference flows (copy the flows, not the codebase)** — read these vantra files for interaction patterns only, wire everything to SpaceWorker auth + per-user org: `vantra/components/dashboard-client.tsx`, `device-card.tsx`, `device-context-menu.tsx`, `remote-tools.tsx`, `script-manager.tsx`, `org-switcher.tsx`, `private-move-panel.tsx`, `auto-move-toggle.tsx`, `add-device-page-client.tsx`, `vantra/app/dashboard/devices/[agentId]/page.tsx`.
- SpaceWorker design tokens: `app/globals.css`, `components/ui.tsx` (Night Studio).

## Goal
SpaceWorker web does everything Vantra's user surface does — users/staff never open Vantra. **Manual-first (owner, 2026-09-22): every manual function available in Vantra must be user-reachable in SpaceWorker BEFORE/alongside the agent doing it — the agent shares the same DeviceCapability/DeviceAction layer and never gets a power users don't have (plan CROSS-TRACK RULE 8).**

## Deliverables
1. **Devices core (V1)**: device grid/cards w/ status (from Task 92 `Device`), device detail (specs, health, history), add-device via SpaceWorker-issued Vantra-agent install link (from Task 93), auto-move + private-move rules re-skinned.
2. **Control + maintenance tools (V2)**: remote tools panel (wake, reboot/shutdown, remote session launch, script run) + script manager — proxied through Vantra API with server-only `VantraLink` tokens; EVERY mutating action = `AgentPendingAction` proposal (no direct execution path).
3. **Org flow + agent granting (V5)**: user requests agent → PUBLIC Vantra agent by default into their `sw-<userId>` org; **admin grants PRIVATE (or public) from SpaceWorker admin user detail** (grant UI + request queue + audit on every grant/switch). Default public; private = admin-approved only.
4. **Nav + dashboard (M7)**: nav order Assistant / Devices / Cyber Lab / Extract & Mail / Store / Billing / Settings / Support; dashboard cards: device health, assistant digest, security posture, lab activity (placeholders allowed for not-yet-built tracks).

## Non-goals
Account surfaces/billing/tickets/desktop-mode (Task 101); staff-badge admin RMM views (Task 101); clone (97); lab (98).

## Acceptance
- Parity walk-through on the VM: add device → see it in grid → detail → wake/reboot/script-run via gated proposals → device moves (auto/private) work → admin granted a private agent for a test user → audit rows everywhere.
- **Manual-first check (CROSS-TRACK RULE 8):** every Vantra UI function has a user-reachable manual control in SpaceWorker, all flowing through the SAME DeviceCapability/DeviceAction layer the agent uses.
- **Admin limits (CROSS-TRACK RULE 7):** device job concurrency is an AdminSetting (enabled + maxConcurrent) surfaced in the admin panel with live counts — no hardwired limits.
- No Vantra login needed at any point; all Vantra tokens server-side only.
- `tsc --noEmit` clean; §2 deploy; live curl checks on the new routes; mobile viewport sane.
