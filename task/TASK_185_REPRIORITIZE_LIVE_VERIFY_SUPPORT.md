# TASK_185 — Reprioritized: live-verification bugs → support/invoice/notify → admin device privacy

**Owner (2026-10-08, after TASK_184 shipped + live testing):** "so lets reprioritize" —
the queue below replaces TASK_183 (wrapper hosted-window) as the ACTIVE track. TASK_183
stays parked (research complete, W1–W9 design ready — flip back when owner says so).

Owner's stated order (message 1): ① activity "unknown" ② overview device counts
③ admin Devices tab → secret URL ④ deleted-devices recovery page ⑤ referral-gated
login. Message 2 added ⑥ the support/invoice/notify bundle from a LIVE test
("the ticket came in… firstly i need a notification for every ticket") — slotted after
② as N1/N2 (small, tested gap in the flow that just shipped; ① ② were the only
explicit "first/next" sequencing).

| # | Item | Kind | Status |
|---|------|------|--------|
| P1 | "activity unknown" → "online · active" | bug fix | research ✅ |
| P2 | overview "4 online of 9" vs 2 real devices | bug fix | CONFIRMED live ✅ |
| N1 | every ticket → email + Telegram; payment email missing | notify | research ✅ |
| N2 | support invoice composer (dropdown/amount/duration) + user email + manual payment entry | feature | research ✅ |
| P3 | admin Devices tab + users "View devices →" → secret `/admin/device/101` | feature | scoped |
| P4 | deleted devices: run command / recover to any user | feature | scoped |
| P5 | referral-gated signup/login + link tree | feature | scoped (research pending) |
| — | TASK_183 wrapper hosted-window | parked | W1–W9 ready |

---

## P1 — Online device shows "activity unknown" instead of "online · active"

**Display path:** `idleChipLabel` `lib/device-idle.ts:119-180` — online/asleep + no idle
reading + no latch ⇒ `` `${word} · activity unknown` `` (`:179`). Rendered by
`components/device-list.tsx:859` and `components/device-console.tsx:548/1500/1826`
("User activity" row). `formatIdle(null) → "unknown"` (`:13`).

**Data path:** `GET /api/devices` `app/api/devices/route.ts:66` —
`idle.idleByHostname[view.name]` — keyed by **Device.name**. Vantra bulk idle
`vantra/app/api/internal/sw/devices/idle/route.ts` — keyed by **TRMM `a.hostname`**,
and ONLY when `toIdleSeconds(match.idletime) !== null`; `matchMeshNode`
(`vantra/lib/meshcentral-api.ts:378-390`) is fail-closed: exact `n.name === hostname`,
and when `expectedIp` (agent `public_ip`) is present the IP must agree on exactly one
node → **no entry → null → "activity unknown"**.

**Key divergence proof (live DB, owner's account):** device names `Sc` ×6,
`WilkSF9`, `DESKTOP-V73JQPJ`, `SpaceWorker browser` — `Sc` cannot be a TRMM hostname,
so `idleByHostname["Sc"]` misses forever. Names come from sync `name: a.hostname`
(`lib/vantra-link.ts:1269`, matches) BUT heartbeat overwrites
`name: input.name ?? existing.name` (`lib/devices.ts:141`, agent-reported → diverges).

**Not the mesh read:** `journalctl -u spaceworker --since '3 days ago'` → 0
`bulk idle read failed` warnings → reads succeed; misses are keying/match failures.

**Fix direction (decide in W1):**
- **A (structural, preferred):** key idle by `vantraAgentId` — Vantra route returns
  `Record<agentId, seconds>` alongside hostname; `route.ts` looks up
  `view.vantraAgentId`. Immune to renames. Small Vantra + SpaceWorker change.
- **B (spaceworker-only):** keep hostname keying; heartbeat must not overwrite the
  name with a divergent value (add `hostname` column, look up by it).
- **Display copy:** owner wants active/online instead of "unknown" — TASK_154 made the
  chip deliberately honest. Compromise: provenance `fresh` + device online but no entry
  ⇒ bare `online` (status IS known from heartbeat); reserve "activity unknown" for the
  true mesh-outage case. Tests pinning the old copy: `tests/device-idle-chip.test.ts`
  (:130/:142/:214) + `tests/vantra-idle-provenance.test.ts`.

## P2 — Overview "4 online of 9" with 2 real devices, none online ✅ CONFIRMED LIVE

**Bug:** `app/api/overview-stats/route.ts:72-73`:
- total: `count({ where: { userId } })` — no `removedAt: null`, no `deviceKind` filter
  (the real list filters both: `app/api/devices/route.ts:40-45`).
- online: `count({ where: { userId, status: "online" } })` — stale stored column; the
  list derives online from `lastSeenAt` within 10 min (`lib/devices.ts:21-49`).

**Live evidence (VPS psql, owner myrate619):** 9 rows = 3 live + 6 removed; 4 rows
still `status='online'`; **0** rows with `lastSeenAt` in the last 10 min; 1 live row is
`deviceKind='hosted'` (excluded from the list) ⇒ list = 2, overview = "4 online of 9"
— exactly the screenshot. (`removeDevice` DOES set `removedAt` — the parked §2B guess
"no removedAt?" was wrong; the READ is at fault.)

**Fix:** overview-stats total =
`{ userId, removedAt: null, deviceKind: { not: "hosted" } }`; online = same +
`lastSeenAt > now − DEVICE_ONLINE_WINDOW_MS` (import from `lib/devices`). Unit test
asserts removed/hosted/stale-status exclusion.

---

## N1 — Ticket notifications (email + Telegram) + missing payment email

- **Gap confirmed:** no `notifyAdmin`/`sendEmail` anywhere in `lib/support/**` or
  `app/api/(admin)/support/**` — a new ticket pings nobody.
- **Payment email:** `lib/payment-notify.ts` (TASK_186) already sends BOTH Telegram
  AND email (`env.adminEmail` = `ADMIN_EMAIL || EMAIL_FROM`, `lib/env.ts:168`) — called
  at 3 sites (submit ×1, topup ×2). Owner got Telegram only ⇒ diagnose FIRST:
  `NotificationLog` rows for `admin_pending_payment`, `ADMIN_EMAIL` unset on VPS, or
  Resend key placeholder. Query before changing code.
- **Shape:** `notifyAdminSupport(...)` mirroring `payment-notify.ts` (fire-and-forget,
  per-channel best-effort) from `createSupportTicket` + admin reply `addAdminMessage`,
  plus a USER email when the admin replies.

## N2 — Support-panel invoice composer + user flow + manual entry

Existing (TASK_184 B3/B4): `PremiumInvoice` (`prisma/schema.prisma:3695` — plan,
tier, amountUsd, status, methods Json snapshot; **no duration field**), admin
`POST|PATCH /api/admin/users/[id]/invoices` (one open per user), cell
`components/admin/user-invoice-cell.tsx`, user card `app/dashboard/billing/page.tsx:618+`
(pay buttons per snapshot chain, `invoiceId` on `/api/billing/submit`).

Owner's flow: SupportQueuePanel gets a **plan dropdown** (templates from
`lib/support-templates.ts`) → amount (template default, editable, e.g. $50) →
**optional duration** → Send ⇒ invoice created + posted INTO the ticket thread +
**email to the user** ⇒ user clicks Pay (ticket/billing) ⇒ method chooser (existing
card) ⇒ admin approves. **Manual entry:** admin records payment details by hand
(mark paid / enter tx details without on-chain flow) for speed. Duration needs a
migration OR settle-time-only reuse of `Payment.durationDays` — decide in W1.

## P3 — Devices out of the admin panel → secret `/admin/device/101`

`app/admin/(protected)/admin-panel.tsx`: Tab union `:65`, tab def `:72`, jump
`:227` (`onViewDevices`), render `:231`, users-tab button `:656-662`. Plan: remove tab
+ button; new unlisted `app/admin/device/101/page.tsx` (admin-session gated via
`requireAdminSession`, not in any nav) rendering the same fleet view — extract
`DevicesTab` to `components/admin/devices-tab.tsx` so panel and secret page share it.

## P4 — Deleted devices → secret page section: recover / run command

`removeDevice` marks `removedAt` + closes onboarding + audits (never deletes; RESTRICT
FKs). New section on `/admin/device/101`: list `removedAt != null`, actions:
**recover** (clear `removedAt`, optionally reassign `userId`) and **run command**
(agent survives `localOnly` removals; reuses admin device tools —
`tests/admin-device-tools.test.ts`). TASK_128 caveat: `syncDevices` never resurrects a
removed row — recovery must clear `removedAt` explicitly.

## P5 — Referral-gated signup/login + link tree (abuse pre-verification)

Signup/login only reachable via referral links issued by admin or existing users; a
"link tree" shows how each user arrived (admin→user A→user B). Research PENDING
(W-step): existing invite/referral infra? signup route `app/api/auth/signup/route.ts`.
No code touched yet.

## Reference — live access (read-only so far)

```bash
ssh -i ~/.ssh/tacticalrmm_vps root@164.68.105.96   # VPS: /opt/spaceworker, svc active
sudo -u postgres psql -d spaceworker                # DB; use $$..$$ literals to avoid
                                                    # nested-quote hell over ssh
```
