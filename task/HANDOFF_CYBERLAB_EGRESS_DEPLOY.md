# HANDOFF — CyberLab Egress batch: run + deploy (to the deploy owner)

**From:** cyberlab agent (worktree `/Users/mikeolab/sw-lab`, branch `main`).
**To:** the deploy owner (the agent running the `spaceworker` VPS deploy flow).
**Date:** 2026-10-15. **Owner approval to deploy: YES** ("go ahead with the run and deploy also"). This doc is the handoff — I am not executing the deploy.

---

## 0. TL;DR — read this first

1. **What this batch is:** everything on `sw-lab main` **after UI-1 (`3765ab4`)** — light/dark theme toggle + in-console guide (Slice 1), CyberLab off Premium Plus with a per-user admin access toggle (Slice 3), **scan-first recon with no attested device** (Slice 2), the **real server-egress** scan that sends actual TCP probes out of our servers (E1+E2), and the **mode-aware watermark + live-egress dial ships ON** commit. HEAD = **`2497294`**.
2. **Hard prerequisite before rsync:** `npx prisma db push` on the VPS to add **4 new `AdminSetting` columns** (`cyberlabLiveEgressEnabled`, `cyberlabEgressRequireOwnershipProof`, `cyberlabEgressScopeGuard`, `cyberlabEgressAllowList`). Verified the live schema has **none** of them yet. See §2.
3. **The dial ships ON via that db push:** `cyberlabLiveEgressEnabled` is declared `@default(true)`. When `db push` adds the column, PostgreSQL backfills the **existing** `AdminSetting` singleton with `true` — real-packet egress enabled automatically, exactly as the owner asked, no manual UPDATE. It stays a dial the owner can flip off in admin settings.
4. **⚠ Same gotcha as last time:** this code is **NOT in the `spaceworker` checkout and NOT pushed to any remote.** It lives only on `sw-lab` local `main`. **Do not run `deploy-vps.sh` from `spaceworker` — it contains zero of these files.** Deploy **from `sw-lab`** (§4), or push `sw-lab/main` and merge into the deploy branch first.
5. **Confirmed live already (SSH, today):** `app/cyberlab/{layout,page}.tsx`, `api/cyberlab/{consent,devices,episodes,runs,scenarios,status,targets}`, and `LabTarget.sourceDeviceId` are **already on the box** (UI-1 + C2b deployed). This deploy is **additive** — it does **not** need the old `sourceDeviceId` db push.

---

## 1. Verified state (real checks, 2026-10-15)

**Git / where the code is**
- `sw-lab` branch `main`, HEAD `2497294`, **13 commits ahead of `origin/main`**, working tree clean. Nothing pushed.
- Deployed-through commit = `3765ab4` (UI-1). The **7 commits to ship now** (beyond UI-1):
  - `a4d3621` docs (handoff + S7 plan — optional to deploy)
  - `3438d94` Slice 1 — lab light/dark toggle + "How Cyber Lab works" guide
  - `d9ce527` CyberLab off Premium Plus + admin per-user access toggle
  - `4c3337d` Slice 2 — scan-first recon (no attested device)
  - `d8fab88` docs (REAL EGRESS plan — optional)
  - `d9dc0dc` real server-egress scan (E1+E2)
  - `2497294` mode-aware watermark + live-egress dial ships ON

**Live VPS (`root@164.68.105.96`, `/opt/spaceworker`, rsync — not git), verified by SSH today**
- `app/api/cyberlab/` = `consent devices episodes runs scenarios status targets` → UI-1/C2b live.
- `app/cyberlab/` = `layout.tsx page.tsx` → standalone console live.
- `lib/lab/` grep for `recon|live` → **empty** → Slice 2 + egress **not** live.
- `LabTarget` columns include `sourceDeviceId` → C2b db push already done.
- `grep cyberlabLiveEgressEnabled prisma/schema.prisma` → **no match** → the 4 egress columns are **absent** (this is what §2 fixes).

**Gates (local, all green at HEAD)**
- `npx prisma generate` ok · `npx tsc --noEmit -p .` = **0** · eslint changed files = **0** · `npm run test:lab` = **77/77** (gate + c2 + c2b + ui1 + recon + live-egress + entitlements).

---

## 2. Prerequisite — DB (do this FIRST, before any rsync)

The 4 `AdminSetting` columns are added by `d9dc0dc`/`2497294`. On the VPS:

```
cd /opt/spaceworker
sudo -u <service-user> npx --no-install prisma db push
```

Confirm they landed **and that the dial is ON**:

```
sudo -u postgres psql -d spaceworker -tAc \
  "select column_name from information_schema.columns where table_name='AdminSetting' and (column_name like 'cyberlabEgress%' or column_name='cyberlabLiveEgressEnabled')"
# expect 4 rows

sudo -u postgres psql -d spaceworker -tAc \
  "select \"cyberlabLiveEgressEnabled\" from \"AdminSetting\" where id='singleton'"
# expect  t   (backfilled from the @default(true))
```

> `deploy-vps.sh` runs `prisma generate` + `next build` but **does not** run `db push` — separate, manual step. Skip it and the status/runs route throws on the missing column at runtime.
>
> All 4 columns are non-destructive (additive, with defaults). Existing rows are backfilled; no data is dropped. If the owner later wants egress off, flip `cyberlabLiveEgressEnabled` in admin settings — do **not** re-run a push to change it.

---

## 3. Files to deploy (this batch = UI-1 → HEAD)

Runtime files (from `git diff --name-status 3765ab4..HEAD`, docs excluded):

**New files**
- `lib/lab/recon-core.ts` · `lib/lab/recon-runner.ts`   (scan-first recon, pure + runner)
- `lib/lab/live-core.ts` · `lib/lab/live-runner.ts`     (real server-egress scan, pure + runner)
- `components/admin/cyberlab-access-cell.tsx`           (admin per-user CyberLab access toggle)
- `tests/entitlements-cyberlab.test.ts` · `tests/lab-recon.test.ts` · `tests/lab-live-egress.test.ts`  (deploy only if you want `npm run test:lab` to pass on the box)

**Modified files**
- `app/api/cyberlab/runs/route.ts`        (accepts recon + live scenario classes)
- `app/api/cyberlab/scenarios/route.ts`   (surfaces recon/live rows + mode)
- `app/api/cyberlab/status/route.ts`      (reports `liveEgressEnabled`)
- `app/cyberlab/layout.tsx`               (theme wiring)
- `app/globals.css`                       (light blueprint + dark `.dark .lab-ops` theme)
- `components/cyberlab-ops-console.tsx`   (theme toggle, guide, scan-first section, mode-aware watermark)
- `lib/entitlements.ts`                   (PREMIUM_EXCLUDED_KEYS = cyberlab)
- `lib/lab/engine.ts`                     (recon/live branches + dial gate)
- `lib/lab/scenarios.ts`                  (recon/live scenario rows)
- `lib/lab/targets-core.ts`               (shared normalisation for recon/live)
- `package.json`                          (`test:lab` wiring — shared file)
- `prisma/schema.prisma`                  (the 4 egress columns — pairs with §2 db push)
- `app/admin=topsecret6199/(protected)/admin-panel.tsx`  (imports + renders the access cell)

**⚠ Shared-file coordination (with the hosting agent's task-205).** `app/globals.css`, `package.json`, `prisma/schema.prisma`, and now **`admin-panel.tsx`** are shared. Deploying from `sw-lab` carries sw-lab's version (= `origin/main` + cyberlab commits). If task-205 deploys first, coordinate order — whichever tree deploys last wins on these shared files.
- `admin-panel.tsx` note: this file has **~42 pre-existing eslint errors** (none from my 3-line change — proven by a stash test). My gate lints *changed files* and my lines are clean. Not refactoring 42 unrelated errors in a file the hosting agent is actively editing.

**Docs (optional, non-runtime):** `PLAN_CYBERLAB_*.md`, `HANDOFF_CYBERLAB_UI1_DEPLOY.md`, `TASK_156B_CYBERLAB_STANDALONE_UI_STEPS.md`.

---

## 4. How to deploy (mechanics pointer — you own this)

- Script: `scripts/deploy-vps.sh <files-from-list> [--prune]`. Defaults: `VPS_HOST=root@164.68.105.96`, `APP_DIR=/opt/spaceworker`, `SERVICE=spaceworker.service`, `PORT=3500`, `LOCAL_ROOT=<repo root>`.
- **Run it with `LOCAL_ROOT=/Users/mikeolab/sw-lab`** (or `cd` there) so it rsyncs the tree that has the cyberlab code. From `spaceworker` it would sync an empty set.
- Build a files-from list of the §3 entries (directory lines end with `/`). Prefer additive (no `--prune`) for this batch.
- The script auto-manages the maintenance page, `prisma generate`, rollback-on-failed-build, chown, and post-deploy `curl :3500` 200 check. Playbook: `HOW_WE_MOVE_FAST.md` §2.

---

## 5. Post-deploy verification

1. `curl -s -o /dev/null -w '%{http_code}' http://localhost:3500/` → 200 (script does this).
2. `sudo -u postgres psql -d spaceworker -tAc "select \"cyberlabLiveEgressEnabled\" from \"AdminSetting\" where id='singleton'"` → `t`.
3. `curl -s http://localhost:3500/api/cyberlab/status` → responds, and its payload shows `liveEgressEnabled: true`.
4. Log in as a **granted** user → open `/cyberlab`:
   - Header **theme toggle** present; console renders in light "blueprint" by default and flips dark with the app toggle.
   - "How Cyber Lab works" guide expands.
   - **"1 · Scan for weaknesses"** section exists and starts a recon run **without** attesting a device.
   - The **live server-egress** scenario is selectable; a live run's header watermark reads **`AUTHORIZED LIVE TEST · REAL PACKETS`**, a dry-run reads **`SIMULATION · YOUR EQUIPMENT`**.
5. To test against your own VM: attest nothing, choose the live egress scenario, target your VM's IP, run — real TCP probes leave the box and open/closed/filtered is recorded.
6. Admin panel → Users → **"Cyber Lab"** column shows the per-user toggle. A user **without** the grant (even a Premium Plus subscriber) is blocked from `/cyberlab`; a granted user gets in.
7. If anything 500s on the runs/scenarios/status path, it's §2 (db push) — re-check the 4 columns first.

---

## 6. Explicitly NOT done by me

- **No push.** Commits are local on `sw-lab main` only (deploy discipline). If the deploy must originate from `spaceworker`, push `sw-lab/main` and merge/cherry-pick first — deploy-owner decision.
- **No rsync / no `db push` / no restart.** Handed to you per owner instruction.
- **Zero overlap** with the hosting agent's task-205 — still only touching `sw-lab`.

---