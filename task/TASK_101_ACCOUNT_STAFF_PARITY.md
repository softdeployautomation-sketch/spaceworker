# Task 101 — Account + staff parity surfaces (V3, V4)

**Status: READY FOR BUILD — assigned to Cline, 2026-09-26 (owner priority pick).** Dependency
cleared: TASK_95 is done (confirmed 2026-09-26 — see its own status line; the device-tools/UI work
it depended on shipped across TASK_103/104/108/114/119/122/123, just under different task numbers).
**Plan: `PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md` §VANTRA PARITY (V3/V4).**

## Read first (mandatory)
- **`HOW_WE_MOVE_FAST.md`** §0–§3 (as TASK_92).
- **`PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md`** §VANTRA PARITY V3/V4, M4 (staff badge), M7 (nav).
- Vantra reference flows (patterns only): `settings-form.tsx`, `billing-card.tsx`, `billing-crypto-panel.tsx`, `ticket-list-client.tsx`, `ticket-thread-client.tsx`, `desktop-lock-screen.tsx`, `desktop-mode-banner.tsx`, `tier-badge.tsx`, `vantra/components/admin/*`.

## Goal
Finish the parity so account management and staff/admin views live entirely in SpaceWorker — Vantra remains the isolated RMM engine only.

## Deliverables
1. **V3 Account surfaces**: settings parity (profile, notifications incl. Telegram prefs, security), billing parity (recharge/topup view with the crypto-panel pattern; module entitlements + tier state visible), support tickets parity (list + thread; wire to existing SpaceWorker ticket API if present, else proxy Vantra's), desktop-mode UX parity (lock screen + banner patterns), notification fan-out coverage (Task 39 channels + Telegram).
2. **V4 Staff/admin parity**: staff badge (M4) unlocks admin views in SpaceWorker: per-user device inventory + RMM status (read-only over VantraLink), lab range monitoring, entitlement management (from Task 99), audit log viewer (`AgentActionAudit`), support inbox. Vantra's own admin stays internal-only for RMM engine ops.
3. Nav integration per M7 (Store tab already separate after Task 100 or placeholder until then).

## Non-goals
Vantra engine changes; devices/tools UI (Task 95); commerce (Task 99).

## Acceptance
- A staff user and a normal user walk the whole app: every Vantra capability reachable in SpaceWorker, zero Vantra logins; admin sees user device inventory + entitlements + audits; `tsc --noEmit` clean; §2 deploy live-verified.
