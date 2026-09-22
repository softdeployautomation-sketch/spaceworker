# Task 92 — Assistant foundation + entitlements core (P5 + C1)

**Status: ready.** **Plan: `PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md` §PRIORITY (P5) + §COMMERCIAL (C1).**

## Read first (mandatory)
- **`HOW_WE_MOVE_FAST.md`** — the deploy bible. §0 access (VPS `ssh -i ~/.ssh/tacticalrmm_vps root@164.68.105.96`; VPS has NO git), §1 repo-root vs `app/` trap, §1a `proxy.ts` trap, §2 deploy sequence (**`--exclude='.env'` mandatory**), §3 schema flow (hand-written migration SQL → `npx prisma generate` → `npx tsc --noEmit` → deploy).
- **`PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md`** — §SCHEMA (field lists), §CROSS-TRACK RULES 1/2/5 (shared primitives, secrets classes), §FINALIZED DECISIONS.
- `prisma/migrations/` — copy an existing migration's exact style.

## Goal
Build the common device layer + the single entitlement gate. No user-visible features yet — everything later rides on this.

## Deliverables
1. **Migration (hand-written SQL in `prisma/migrations/<ts>_assistant_foundation/`)**: `Device`, `DeviceHeartbeat`, `DeviceCapability`, `DeviceJob`, `DeviceAction`, `DeviceAudit`, `DeviceRelationship`, `DevicePowerPolicy`, `ActivityRollup`, `UserEntitlement`, `AgentActionAudit` (fields per plan §SCHEMA).
2. **`lib/entitlements.ts`**: `hasEntitlement(userId, key)` + grant/revoke/list. Tier 5 auto-grants all keys. Lazy expiry mirroring Task 55 `premiumExpiresAt` semantics exactly (NULL on existing tier-5 = grandfathered; never backfill). Keys v1: `extractor`, `mailer`, `assistant`, `devices`, `cyberlab`.
3. **Device ingest API** (`app/api/devices/...`): heartbeat upsert, online/offline state. Device identity = the user's Vantra agent (`vantraAgentId` field nullable until Task 93 wires provisioning).
4. **Digest**: nightly `ActivityRollup` → Channelry digest via `lib/agent.ts runAgentTurn` → pinned "Device digest" `AgentThread`; per-user master toggle; cost attributed to `AiUsageLog`.
5. Extend `AgentPendingAction` kind validation constants: `"device" | "email-reply" | "power" | "wake" | "browser-clone" | "clone-control" | "lab-action"`.
6. Web UI: assistant digest panel in the Task 41 agent workspace; device list placeholder; master toggles.

## Non-goals
Vantra provisioning (93), Telegram loop (94), parity UI (95), WoL (96), clone (97), lab (98), store (99).

## Acceptance
- `npx tsc --noEmit` clean; migration applies on VPS from `/opt/spaceworker` (repo root) per §3; `prisma migrate status` clean.
- curl: heartbeat upsert 200 + second upsert updates (no duplicate rows); entitlement check denies tier-1 for paid key, allows tier-5; revoking tier-5 premium lazily flips access on next check.
- Digest thread appears for a test user; real cost in `AiUsageLog`.
- Deploy per §2: rsync `--exclude='.env'` → build as `trmm` → restart → `curl` 200 → `journalctl -u spaceworker.service` clean.
