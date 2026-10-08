# TASK_185 STEPS — progress log (compaction insurance)

## STATUS (updated 2026-10-08, POST-DEPLOY — owner confirmed live)

- **TRACK:** TASK_184 done (20/20) · TASK_183 wrapper PARKED. Scope doc:
  `TASK_185_REPRIORITIZE_LIVE_VERIFY_SUPPORT.md`.
- **P1 ✅ + P2 ✅ — IMPLEMENTED, DEPLOYED, OWNER-CONFIRMED ("its fixed now").**
  Remaining: **N1** (notification diagnose+wire) → **N2** (invoice composer) →
  **P3/P4** (secret admin device page + deleted-devices) → **P5** (referral gating) → **W9** closeout.
- **WORKING TREE:** HEAD = P1+P2 commit + this doc-only commit (steps update).
  Stray untracked `TASK_133_RMM_ENGINE_BRINGUP.md` is NOT ours — never commit it.
- **NEXT ACTION:** N1 — W3a DIAGNOSE on VPS first: `NotificationLog` rows for
  `admin_pending_payment`, `ADMIN_EMAIL` set?, Resend key valid? (owner reports
  Telegram arrived, EMAIL did not — likely `ADMIN_EMAIL` unset ⇒ fallback
  `spaceworker@instaweb.top`.) Then `notifyAdminSupport` on ticket create/reply.

## RESEARCH DONE (don't re-research — evidence in scope doc)

- [x] **P1 root cause** — `app/api/devices/route.ts:66` keys idle by Device.name; Vantra
      keys by TRMM hostname + fail-closed `matchMeshNode`; owner's live names `Sc`×6
      diverge (heartbeat overwrite `lib/devices.ts:141`). journalctl: 0 idle failures
      in 3d ⇒ keying, not mesh.
- [x] **P2 root cause CONFIRMED LIVE** — `app/api/overview-stats/route.ts:72-73` no
      `removedAt`/`deviceKind` filter + stale `status='online'`. VPS psql: owner 9 rows
      (3 live + 6 removed), 4 status-online, **0** in 10-min window, 1 hosted ⇒ UI "4
      online of 9" vs list of 2. `removeDevice` DOES set removedAt (§2B guess wrong).
- [x] **N1 gaps** — support code has zero notify calls (both directions). Payment email
      IS coded (`lib/payment-notify.ts` TASK_186, both channels, 3 call sites) but owner
      got Telegram only ⇒ check `NotificationLog` for `admin_pending_payment` +
      `ADMIN_EMAIL`/Resend key on VPS BEFORE touching code.
- [x] **N2 inventory** — invoice model (no duration field), admin invoice API + cell,
      user billing card + `invoiceId` submit all exist (TASK_184 B3/B4). Missing:
      composer in SupportQueuePanel, invoice-in-thread, user email, duration, manual
      payment entry.
- [x] **P3/P4 anchors** — admin-panel.tsx `:65/:72/:227/:231/:656-662`; extract
      DevicesTab → `components/admin/devices-tab.tsx`; secret `app/admin/device/101`.
      P4: clear `removedAt` explicitly (sync never resurrects), optional userId move.
- [ ] **P5 research** — invite/referral infra? signup route surface? (not started)

## LIVE ACCESS (read-only)

```
ssh -i ~/.ssh/tacticalrmm_vps root@164.68.105.96      # /opt/spaceworker, svc active
sudo -u postgres psql -d spaceworker                   # $$..$$ literals over ssh
```

## STEPS

### P1 — activity "unknown"
- [x] **W1a. DECIDED (2026-10-08):**
  - **Copy rule** (owner directive: "better it shows active instead of unknown"):
    online/asleep + no reading + no latch ⇒ `${word} · active` — "activity unknown"
    is retired in `idleChipLabel` (`lib/device-idle.ts:179`).
  - **Keying fix = A (same-box feasible)** — Vantra idle route adds additive
    `idleByAgentId` (TRMM `agent_id` → idle seconds); SpaceWorker merges it and
    `GET /api/devices` looks up `idleByAgentId[vantraAgentId] ?? idleByHostname[name]`.
    Backward compatible both ways (old Vantra ⇒ `{}` ⇒ name fallback). Vantra runs
    on the SAME box (`/opt/vantra`, `vantra.service` port 3300, deploy per Vantra
    `HOW_WE_MOVE_FAST.md`: rsync → `sudo -u vantra npm run build` → restart).
- [x] **W1b. IMPLEMENTED + gates GREEN (2026-10-08):**
  - SpaceWorker: `lib/device-idle.ts` copy rule · `lib/vantra-link.ts`
    (`OrgIdleMaps` + `BulkIdleReading.idleByAgentId`, cache/merge carry it) ·
    `app/api/devices/route.ts` two-key lookup (agent id first, name fallback).
  - Vantra: `app/api/internal/sw/devices/idle/route.ts` emits `idleByAgentId`
    (additive; mirrored `{}` in both catch paths).
  - Tests: chip 15/15 (3 expectations now "active") · provenance 9/9 (new
    agent-id-wins + name-fallback test) · `test:vantra` 90/90 · tsc 0 ·
    eslint 0 (both repos) · Vantra tsc 0.
- [x] **W1c. LIVE + OWNER-CONFIRMED (2026-10-08, "its fixed now")** — chips render
      "online · …" (active/idle), "activity unknown" gone from the live UI.

### P2 — overview counts
- [x] **W2a. FIXED (2026-10-08)** — `app/api/overview-stats/route.ts`: both
      counts now `removedAt: null` + `deviceKind: { not: "hosted" }` (byte-for-byte
      the `/api/devices` filters); online = `lastSeenAt >= now − DEVICE_ONLINE_WINDOW_MS`
      (10-min window from `lib/devices`, imported — same clock as `isDeviceOnline`),
      **never** the stale `status` column.
- [x] **W2b. TESTED** — new `tests/overview-stats-counts.test.ts` (`npm run
      test:overview`, 2/2): asserts both where-clauses carry the filters AND
      `status`/`lastSeenAt`-on-total are absent, window bound = 10 min ±5 s.
      Gates: tsc 0 · eslint 0.
- [x] **W2c. LIVE + OWNER-CONFIRMED (2026-10-08, "its fixed now")** — psql ran the
      new count queries: owner's row = 9 db rows → **0 online of 2** (matches the
      list exactly; owner: "none is online"). Evidence also captured: Vantra
      `idle?orgId=…` returns BOTH keys (`idleByHostname {WilkSF9,Sc}` +
      `idleByAgentId {TpvH…,bBt…}`), site 200 · `/api/devices` JSON 401 ·
      `/api/overview-stats` 401, box greps confirm deployed code (16×
      `idleByAgentId` in vantra-link, `lastSeenAt: { gte` in overview route).

### DEPLOY RECORD (P1+P2, 2026-10-08 evening)

- SpaceWorker: `14d41a3` pushed (`d5804bb..14d41a3`) — code+tests+steps; follow-up
  doc-comment commit pushed with this steps update. `scripts/deploy-vps.sh`
  completed CLEAN this run (build as trmm → restart → verify 200 → maintenance OFF).
- Vantra: `c8b6680` pushed (`ac7197b..c8b6680`) — idle route only; rsync →
  `sudo -u vantra npm run build` (BUILD_ID 2026-10-08 19:03:51) → restart →
  active · root 200.
- **Known cosmetic drift:** box `lib/device-idle.ts` predates the `:112` doc-comment
  fix (comment-only; runtime byte-identical semantics) — next normal deploy picks it up.
- Live internal proof (box curl, Bearer `SW_INTERNAL_TOKEN`):
  `{"ok":true,"idleByHostname":{"WilkSF9":0,"Sc":0},"idleByAgentId":{"TpvHNDsKSawsfKGLJPZZssSAygmdUJxecwRtaCEP":0,"bBtQQvVvVTjJhJNqoYGzcfyrUfkMbEDsYqzitkZq":0},"idleUnit":"seconds"}` — hostnames vs agent ids = the exact drift that caused the bug.

### N1 — notifications
- [ ] W3a. DIAGNOSE first: `NotificationLog` rows + `ADMIN_EMAIL` + Resend key on VPS
- [ ] W3b. `notifyAdminSupport` (email+Telegram) on ticket create + admin reply;
      USER email on admin reply
- [ ] W3c. Tests + live: new ticket ⇒ both channels

### N2 — invoice composer
- [ ] W4a. Decide duration storage (migration vs settle-time `Payment.durationDays`)
- [ ] W4b. SupportQueuePanel composer: plan dropdown (support-templates) + amount +
      optional duration → reuse `POST /api/admin/users/[id]/invoices` + thread message
- [ ] W4c. User email on invoice send; invoice render in ticket thread; Pay button →
      existing billing card/submit (`invoiceId`)
- [ ] W4d. Manual payment entry (admin marks paid / types tx details) — speed path
- [ ] W4e. Tests (invoice lifecycle must stay green: `test:invoice` 27) + live e2e

### P3/P4 — secret device page
- [ ] W5. Extract DevicesTab; remove tab + users-tab button; new
      `app/admin/device/101/page.tsx` (requireAdminSession, unlisted)
- [ ] W6. Deleted-devices section: list `removedAt != null` + recover (clear removedAt,
      reassign userId) + run-command (reuse admin device tools)
- [ ] W7. Tests: panel no longer renders devices tab; secret route 401-anon/200-admin

### P5 — referral gating
- [ ] W8. Research → design (invite tokens, gating, link-tree read model) → owner sign-off → implement

### Closeout
- [ ] W9. Gates: `tsc` 0 · eslint 0 · full test suite green → commit(s) (money code
      separate from UI per TASK_184 convention) → push → `scripts/deploy-vps.sh` →
      live checks → record here + in scope doc.
