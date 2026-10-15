# HANDOFF — CyberLab COMBINED deploy (money flow batch) — to the deploy owner

**From:** cyberlab agent (worktree `/Users/mikeolab/sw-lab`, branch `main`).
**To:** the deploy owner (agent running the VPS deploy flow).
**Date:** 2026-10-16. **Owner instruction: ONE combined deploy of everything pending.** This doc is the handoff — I am not executing the deploy (no rsync, no SQL, no restart run by me).

---

## 0. TL;DR — read this first

1. **What's already live (verified by SSH today):** the box (`/opt/spaceworker`) is deployed **through `2497294`** — UI-1 console, C2b, Slice 1 theme+guide, Slice 3 access toggle, Slice 2 recon, real server-egress, mode-aware watermark. `lib/lab/` has `recon-core/recon-runner/live-core/live-runner`, the egress `AdminSetting` columns exist, `cyberlabEnabled=t`, `cyberlabLiveEgressEnabled=t`, `cyberlabModulePriceUsd=29`, service `active`.
2. **What this deploy ships:** exactly **one new batch** (the commit this doc lands in): the **Cyber Lab add-on money flow + admin UX** — add-on lock CTA ("Add Cyber Lab to your subscription"), support-request template ("Request for Cyber Lab"), cyberlab as an invoice plan (`plan='cyberlab'`, sentinel tier 6) whose settlement grants the `cyberlab` entitlement, per-user grant duration/expiry in the admin user cell, and the admin **Cyber Lab tab** (block + Research + Lab Runs).
3. **⚠ THE DB STEP IS NOT `db push` AND NOT `migrate deploy` — it is one targeted `psql -f` (§2).** `prisma db push` cannot apply it (the two CHECK constraints exist only in migration SQL, not in schema.prisma). `migrate deploy` is unsuitable here for two proven reasons (§2). The migration file is **4 additive statements, safe to re-run**.
4. **⚠ Same gotcha as every cyberlab batch:** the code is **NOT pushed** and **NOT in the `spaceworker` checkout**. Deploy **from `LOCAL_ROOT=/Users/mikeolab/sw-lab`**, or push `sw-lab/main` and merge first. `sw-lab/main` = current `origin/main` (`a1704b4`, includes PR#3) + 15 cyberlab commits; `origin/main` is 0 commits ahead of my base (no divergence), so a push+merge is clean apart from task205 (§3).
5. **No other DB prerequisite:** the live `AdminSetting` already has `cyberlabModulePriceUsd=29`; the only missing DB piece is the CHECK widening.

---

## 1. Verified state (real checks, 2026-10-16)

**Live VPS (`root@164.68.105.96`, `/opt/spaceworker`, rsync — not git):**
- `PremiumInvoice` table exists; its CHECKs are the **OLD narrow** ones: `plan IN ('premium_plus','premium_xdevice')`, `tier IN (3,5)` — confirmed via `pg_get_constraintdef`. **This is what §2 widens.**
- `20261118000000_task184_premium_invoice` **applied** (2026-10-08) — my ALTERs have their target.
- `prisma migrate status`: **110 dirs; only `20261122000000_task205_link_routing_and_wording` pending** (the hosting agent's unpushed work, present on the box; SQL head verified additive). A historical **failed row `20260922000000_assistant_foundation` (2026-09-22)** exists in `_prisma_migrations` (`finished_at NULL`) — later migrations were applied via `db push`/manual SQL, not `migrate deploy`, which is why §2 uses targeted SQL.
- `components/admin/cyberlab-access-cell.tsx` present (Slice 3 live); `module-tool-lock.tsx` still has the OLD premium copy (0 "Add Cyber Lab" matches) → confirms this batch is **not yet deployed**.

**Local git:** `sw-lab` `main`, **15 ahead of `origin/main`** after the commit this doc ships in, working tree clean. Nothing pushed.


---

## 2. THE DB STEP — targeted SQL (do this AFTER rsync of the migration dir, BEFORE/with the build)

The migration directory ships with the rsync (§3): `prisma/migrations/20261122000000_task_cyberlab_invoice_addon/migration.sql`. Its content (verified by `cat`):

```sql
ALTER TABLE "PremiumInvoice" DROP CONSTRAINT "PremiumInvoice_plan_check";
ALTER TABLE "PremiumInvoice" ADD CONSTRAINT "PremiumInvoice_plan_check"
    CHECK ("plan" IN ('premium_plus', 'premium_xdevice', 'cyberlab'));
ALTER TABLE "PremiumInvoice" DROP CONSTRAINT "PremiumInvoice_tier_check";
ALTER TABLE "PremiumInvoice" ADD CONSTRAINT "PremiumInvoice_tier_check"
    CHECK ("tier" IN (3, 5, 6));
```

Apply with:

```bash
ssh -i ~/.ssh/tacticalrmm_vps root@164.68.105.96 \
  'sudo -u postgres psql -d spaceworker -v ON_ERROR_STOP=1 -f /opt/spaceworker/prisma/migrations/20261122000000_task_cyberlab_invoice_addon/migration.sql'
```

Then verify (expect the `plan` array to include `'cyberlab'` and the `tier` array to include `6`):

```bash
ssh -i ~/.ssh/tacticalrmm_vps root@164.68.105.96 \
  'sudo -u postgres psql -d spaceworker -tAc "select conname||chr(10)||pg_get_constraintdef(oid) from pg_constraint where conrelid=(select oid from pg_class where relname=$$PremiumInvoice$$) and contype=$$c$$"'
```

**Why NOT the other two ways (proven, not assumed):**
- `prisma db push` — diffs `schema.prisma`, where `plan`/`tier` are plain `String`/`Int`; the CHECKs exist **only** in migration SQL ⇒ `db push` will not touch them. (It is how the earlier egress columns were applied — fine for columns, useless for CHECKs.)
- `prisma migrate deploy` — (i) the failed `assistant_foundation` row may make it refuse outright ("New migrations cannot be applied before the error is recovered from" is literally in its `logs`); (ii) even if it proceeds it would first apply **task205** (the hosting agent's, unpushed, not mine to ship). The deploy agent may still fix history + deploy it later — **that is the hosting/platform owner's call, flagged here, not mine**.
- Re-run safety: the 4 statements are **idempotent in effect** (DROP of an existing widened constraint + re-ADD of the same definition) ⇒ running twice is harmless, and the file NOT being recorded in `_prisma_migrations` only leaves a cosmetic "pending dir" note for whoever eventually repairs migrate history.

**Sentinel semantics (why tier 6 is safe):** every reader branches on `plan` first — `settleLinkedInvoice` grants the `cyberlab` entitlement without reading tier; invoice displays name the plan. Tier 6 can never become a `User.tier`. No user data or existing invoice rows are touched (old values remain valid under the widened CHECKs — additive in effect).

---

## 3. Files to ship (additive rsync; no `--prune`)

Run `scripts/deploy-vps.sh` with **`LOCAL_ROOT=/Users/mikeolab/sw-lab`**, files-from list:

```
lib/products.ts
lib/license-service.ts
lib/invoice-notify.ts
lib/support-templates.ts
app/api/admin/users/[id]/invoices/route.ts
app/api/admin/users/[id]/invoices/[invoiceId]/route.ts
app/api/admin/wallets/route.ts
app/api/billing/submit/route.ts
app/dashboard/billing/page.tsx
components/support-invoice-card.tsx
components/module-tool-lock.tsx
components/admin/support-queue-panel.tsx
components/admin/user-invoice-cell.tsx
components/admin/cyberlab-access-cell.tsx
app/admin=topsecret6199/(protected)/admin-panel.tsx
prisma/migrations/20261122000000_task_cyberlab_invoice_addon/
```

Gates at commit time (all green): `npx prisma generate` ok · `npx tsc --noEmit` = **0** · eslint changed files = **0 errors** · `npm test` full suite = **1470 tests, 1469 pass, 0 fail, 1 pre-existing skip**.

**⚠ Shared-file coordination (read before rsync):**
- **`admin-panel.tsx` is the one real collision risk.** The box currently carries the hosting agent's **task205** edits; task205 is **not in `origin/main` and not in `sw-lab`** ⇒ rsyncing this file from `sw-lab` **reverts task205's admin edits**. Options: (a) deploy task205 first / merge it into the tree you deploy from, then ship mine; or (b) rsync my file to a temp path and merge on the box (my diff is small and line-scoped: tab union + nav entry + tab render + the Infrastructure-block removal). My 42 pre-existing eslint errors in this file are baseline (stash-proven earlier) and untouched by my lines.
- `prisma/schema.prisma`, `package.json`, `app/globals.css` are unchanged in this batch except `schema.prisma` comment lines on `PremiumInvoice` (plan/tier semantics) — trivial to merge.

---

## 4. Post-deploy verification

1. `curl -s -o /dev/null -w '%{http_code}' http://localhost:3500/` → 200 (script checks).
2. §2 verify query → `plan` includes `'cyberlab'`, `tier` includes `6`.
3. Admin panel → **"Cyber Lab" tab** exists; Infrastructure tab no longer carries the block; the tab contains block + Research + Lab Runs.
4. Admin Users table → **"Cyber Lab"** column: cell shows **Active** + "expires <date>", or the grant form with **30/90/365/Custom duration** buttons; toggling grants with a duration and the expiry displays.
5. A user without the grant opens `/cyberlab` → lock CTA reads **"Add Cyber Lab to your subscription"** → opens the **"Request for Cyber Lab"** support request (no price/plan-bundle wording anywhere in the lock copy).
6. Support queue → the cyberlab request behaves like the other premium requests (invoice composer prefills **$29**, plan shows **Cyber Lab** everywhere: queue, user-invoice cell, billing page, payment emails).
7. Money path end-to-end: admin sends a `cyberlab` invoice → user submits payment hash → on approval the settlement grants the **`cyberlab` entitlement for the invoice's days** (NOT premium, NOT a tier bump) → user can open `/cyberlab`.
8. Negative controls: a **Premium Plus** subscriber WITHOUT the grant still cannot open `/cyberlab` (off the premium catch-all); settling a `cyberlab` invoice does not alter premium/xdevice state.

---

## 5. Explicitly NOT done by me

- **No push.** All commits are local on `sw-lab/main`; deploy discipline = owner says push, then push.
- **No rsync / no psql / no restart.** Handed off per owner instruction.
- **No `migrate deploy`, no repair of the 2026-09-22 failed row, no task205 shipping** — pre-existing platform/history state, flagged for the deploy + hosting owners.
- **Zero overlap** with the hosting agent's runtime code beyond the shared-file notes above.

