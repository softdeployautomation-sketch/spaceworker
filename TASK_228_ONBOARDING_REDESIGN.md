# TASK_228 — Kill the quarantine/onboarding clock: public-on-top + manual "Move to private" + hide-only automation

**Scoped by:** verification agent · **Date:** 2026-10-18 · **Priority:** URGENT (owner-ordered after live triage of device `I`)
**Branches:** `agent/task-228-onboarding-redesign` (SpaceWorker) + Vantra repo half (see §3.5)
**Handoff:** `TASK_228_ONBOARDING_REDESIGN_STEPS.md`

## §1 Triage verdict (owner asked "what in the hide is killing the agent" — ANSWER: nothing)

Evidence from the live box + both repos, 2026-10-18:

- **The hide never ran on any recent device.** All 5 latest `DeviceOnboarding` rows (incl. your test device `I`) have `hideDoneAt = NULL`; every attempt bounced off `vantra_503: This device is currently offline.`
- **The hide script cannot kill the agent** (`lib/agent-visibility.ts`): `Set-Service -DisplayName` + registry `Description` + uninstall-entry `SystemComponent`. No Stop/Restart-Service, no touch of the agent process. Cosmetic by design.
- **Timeline proof (device I):** onboarding timer 11:59:55 → agent's last TRMM check-in **12:03:50** (dark ~4 min post-install) → hide due 12:04:55 → auto-move due ~12:14:55. The agent was **already dark before hide was due and long before the move could fire**. The fresh-install agent going dark with the machine on is the open root cause — **box-side probe for the senior agent** (TRMM agent record + agent log), NOT a build blocker: the redesign removes the stuck-forever consequence either way.
- **The auto-move IS a genuine hazard** (owner's instinct correct) — Vantra `lib/trmm.ts:582` `buildAgentDomainMoveScript` rewrites `HKLM\SOFTWARE\TacticalRMM\BaseURL/ApiURL` to the private domain and fires `Restart-Service tacticalrmm -Force`. If the private API domain is unreachable from the box or re-registration fails, the agent strands OFFLINE in the private org forever, with the UI showing it "moved".
- **The stuck-in-public death loop:** dark agent → SpaceWorker's 10-min-freshness gate briefly passes → hide attempt → TRMM 503 → attempt burns → strip shows "hiding/waiting" forever → auto-move can't fire (offline at due time, retries forever). Nothing ever recovers except manual intervention.

## §2 Owner design (build exactly this)

1. **Quarantine gone from the UI.** No "Securing new device · 2 of 4" strip, no Quarantine badge, no stay-awake, no auto-move, no 20-min window.
2. **Public devices sort to the TOP** of the device list, badged "Public" (badge already exists).
3. **Manual "Move to private" button** on each public row — the user moves the device themselves.
4. **The ONLY automation kept is the HIDE**, and it must run cleanly: fires ~1 min after the device appears, only while the device is actually online, never burning attempts on offline/503.

## §3 Scope

1. **SpaceWorker — sweep becomes hide-only** (`app/api/internal/device-onboarding-sweep/route.ts`): delete the stay_on / release / moving branches and the 5/10/15/20 clock. New rules: row with `hideDoneAt IS NULL` → due at `timerStartedAt + 60s`; offline (gate) → skip, no attempt burn, no lastError; **`vantra_503` from `runCommandNow` → same as offline** (skip, release claim, no attempt burn, no lastError spam — fixes the 503-burns-attempts bug); hide success → `hideDoneAt` set + row `released` (terminal). Keep the crash-safe `updateMany` claim exactly-once.
2. **SpaceWorker — `lib/device-onboarding.ts`**: retire the stage constants/state machine to the hide rule + display copy only; delete stay-awake/move copy. No schema change — `DeviceOnboarding` stays as the hide ledger (no migration).
3. **SpaceWorker — `components/device-list.tsx`**: remove the quarantine strip + Quarantine badge; sort public-tier devices first in the existing query/order; add the **Move to private** button on public rows (spinner + disabled while in flight; result error surfaced like other device actions).
4. **SpaceWorker — new route `POST /api/devices/[deviceId]/move-to-private`**: session-gated, caller-scoped, calls Vantra's move (§3.5) via `vantraFetch`, returns the per-step result (reassign/reconfigure) so the UI can name which half failed. Audit via `recordAgentActionAudit` (`device_move_to_private`, no secrets).
5. **Vantra repo — two changes:** (a) new internal endpoint `/api/internal/sw/devices/[agentId]/move` (existing internal bearer auth) calling `moveDeviceToPrivate` + `cancelPendingAutoMoveForManualMove` — the current `/api/devices/[agentId]/move` is Vantra-session authed and unusable from SpaceWorker; (b) **auto-move OFF for SW platform orgs**: set `autoMoveToPrivateEnabled = false` at `sw-` org provisioning + one-off box UPDATE for existing `sw-%` public orgs (owner-approved, recorded in STEPS).
6. **Box-side (deploy-time, senior agent):** `device-onboarding-sweep.timer` cadence 5 min → **1 min** (so the 1-min hide threshold actually lands in the first/second minute per owner's rule).

## §4 MUST NOT touch

- `buildHideAgentScript` / Reveal / console hide buttons (shared; unchanged and proven).
- `removeDevice` (still closes onboarding rows on removal), heartbeat/telemetry, `Device` schema.
- The Vantra auto-move code itself (kept for non-SW orgs; only SW orgs flip the flag).
- No migration; no deploy without owner 🚦 (senior agent).

## §5 Owner decisions recorded

- Auto-move removal is owner-ordered 2026-10-18, superseding the 2026-09-27 20-min quarantine design.
- Open root cause (why fresh agents go dark ~4 min post-install) = senior-agent box probe; if found fixable, it's a separate task.

## §6 Gates & tests

- `npx tsc --noEmit` exit 0 · eslint touched files · full `npm test` (floor 1677/1676/0/1) · `CI=true npm run build` · Vantra repo's own suite for its two changes.
- New tests: hide fires at +60 s when online; offline skip burns no attempt; **503 skip burns no attempt + clears claim**; exactly-once under double-claim; hide success → terminal; public-first sort; move route session/scope gates (401/404), happy path passes agentId, step-failure surfaces both halves.
- STEPS doc + `HANDOFF → VERIFICATION AGENT` section; box UPDATE for `autoMoveToPrivateEnabled` pasted before execution.

