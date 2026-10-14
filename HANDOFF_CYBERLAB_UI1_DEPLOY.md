# HANDOFF — CyberLab UI-1: run + deploy (to the deploy owner)

**From:** cyberlab agent (worktree `/Users/mikeolab/sw-lab`, branch `main`).
**To:** the deploy owner (the agent running the `spaceworker` VPS deploy flow).
**Date:** 2026-10-14. **Owner approval to deploy: YES** (relayed in chat). This doc is the handoff — I am not executing the deploy.

---

## 0. TL;DR — read this first

1. **Ready to deploy:** the whole CyberLab line C2a → C2b → UI-1, gates green, committed at `sw-lab` `main` @ **`3765ab4`**.
2. **Hard prerequisite before rsync:** `npx prisma db push` on the VPS to add the nullable `LabTarget.sourceDeviceId` column. The live DB does **not** have it (verified). Without this the C2b/UI-1 code 500s on the targets/attest path.
3. **⚠ Biggest gotcha:** this code is **NOT in the `spaceworker` checkout and NOT pushed to any remote.** It lives only on `sw-lab` local `main`. **Do not run `deploy-vps.sh` from `spaceworker` as-is — it contains zero cyberlab files** (`app/cyberlab/`, `console-map.ts`, `cyberlab-ops-console.tsx` all absent there). Deploy **from `sw-lab`** (see §4), or push `sw-lab/main` and merge into the deploy branch first.
4. **Live box today:** C1 only. `lib/lab/` has aup/catalog-seed/consent/gate/research/tools; `app/api/cyberlab/` has only `consent` + `status`. No `app/cyberlab/`, no ops-console, no `engine.ts`/`runs`/`episodes`/`victim-sensor`. Service `spaceworker.service` **active**, `BUILD_ID = TPjU5_KQzyOIG3DELTbt2`.

---

## 1. Verified state (real checks, 2026-10-14)

**Git / where the code is**
- `sw-lab` remotes: `origin` = softdeployautomation-sketch/spaceworker, `michael-fork` = Mikeolab/spaceworker. Branch `main`, HEAD `3765ab4`.
- `git branch -r --contains 3765ab4` → **empty** ⇒ UI-1 is **local-only, unpushed**. `origin/main` contains **0** cyberlab files.
- `sw-lab main` is 6 commits ahead of `origin/main`:
  - `db988d2` C2a chain · `cdd454e` C2a panel console · `bb873d7` C2b victim-sensor + admin + tool rows · `26afcf7` C2b device picker (`sourceDeviceId`) · `3765ab4` UI-1 standalone `/cyberlab` console · *(plus one unrelated clone fix `3e641ba` — see §3, exclude it from a cyberlab-only deploy)*.
- `spaceworker` checkout: branch `agent/task-205-link-routing-wording` (the other agent's in-flight hosting task). **Zero cyberlab files present.** The two trees have diverged from `origin/main` independently.

**Live VPS (`root@164.68.105.96`, `/opt/spaceworker`, rsync — not git)**
- C1-only (see §0.4). No task-205 changes deployed either (that agent's work is still in-flight).
- Live DB `LabTarget` columns: `attestationId, attestedAt, createdAt, id, kind, rangeId, userId, value` — **no `sourceDeviceId`**.

**Gates (local, all green)**
- `npx prisma generate` ok · `npx tsc --noEmit -p .` = **0** · eslint on changed files + new test = **0** · `npm run test:lab` = **51/51** (lab-gate + c2 + c2b + ui1).

---

## 2. Prerequisite — DB (do this FIRST, before any rsync)

The `sourceDeviceId` column is added by `26afcf7` and is **nullable**. On the VPS:

```
cd /opt/spaceworker
sudo -u <service-user> npx --no-install prisma db push
```

Confirm it landed:

```
sudo -u postgres psql -d spaceworker -tAc \
  "select column_name from information_schema.columns where table_name='LabTarget' order by column_name"
# expect sourceDeviceId to appear
```

> `deploy-vps.sh` runs `prisma generate` + `next build` but **does not** run `db push` — this is a separate, manual step. Skip it and the attest/targets route throws on the missing column at runtime.

---

## 3. Files to deploy (cyberlab-only)

Derived from `git diff --name-only origin/main..3765ab4`, **minus the unrelated clone-fix commit `3e641ba`** (which touched `components/device-console.tsx` + `tests/clone-open-session.test.ts` — leave those to the clone task; if you deploy the whole sw-lab tree they come along harmlessly, but a cyberlab-scoped deploy excludes them).

New source trees (deploy as directory entries — `deploy-vps.sh` tree-syncs any list line ending in `/`):
- `app/cyberlab/`  (page + layout — the new standalone route)
- `app/api/cyberlab/`  (adds `runs/`, `runs/[id]/stream/`, `episodes/`, `episodes/[id]/`, `scenarios/`, `targets/`, `devices/`; existing `consent`+`status` unchanged)
- `app/api/admin/cyberlab/`  (admin runs + episode viewer routes)

New/changed flat files:
- `lib/lab/`: `engine.ts` `runner.ts` `range.ts` `scenarios.ts` `episode.ts` `evidence.ts` `targets.ts` `targets-core.ts` `victim-sensor.ts` `catalog-seed.ts` `console-map.ts`
- `lib/resource-governor.ts`  (labRanges governor slot wiring)
- `components/cyberlab-ops-console.tsx` (NEW — the console) · `components/cyberlab-panel.tsx` (launcher card) · `components/admin-lab-runs-view.tsx` (NEW admin view) · `app/admin=topsecret6199/(protected)/admin-panel.tsx` (admin nav entry)
- `app/globals.css`  (`.lab-ops` SOC theme + keyframes + reduced-motion)
- `prisma/schema.prisma`  (the `sourceDeviceId` column — pairs with §2 db push)
- `scripts/cyberlab-dry-run.ts`  (ops helper)
- `package.json`  (adds `tests/lab-ui1.test.ts` to `test:lab`)
- Docs (optional, non-runtime): `PLAN_CYBERLAB_STANDALONE_UI.md`, `TASK_156B_CYBERLAB_STANDALONE_UI_STEPS.md`

**⚠ Shared-file coordination note.** `package.json`, `prisma/schema.prisma`, `app/globals.css`, `.gitignore` are shared with the `spaceworker` branch. Deploying **from `sw-lab`** carries sw-lab's version of these (= `origin/main` + cyberlab commits). Since task-205 is **not yet on the live box**, there is nothing to regress today. If task-205 deploys **first**, coordinate order — whichever tree deploys last wins on these shared files, so re-run the losing side's shared-file changes or merge before the second deploy.

**A deleted file:** the superseded `components/cyberlab-console.tsx` was `git rm`'d on sw-lab. It was **never** on the live box (C1 had no console), so nothing to delete remotely — just don't rsync it.

---

## 4. How to deploy (mechanics pointer — you own this)

- Script: `scripts/deploy-vps.sh <files-from-list> [--prune]`. Defaults: `VPS_HOST=root@164.68.105.96`, `APP_DIR=/opt/spaceworker`, `SERVICE=spaceworker.service`, `PORT=3500`, `LOCAL_ROOT=<repo root>`.
- **Run it with `LOCAL_ROOT=/Users/mikeolab/sw-lab`** (or `cd` there) so it rsyncs the tree that actually has the cyberlab code. From `spaceworker` it would sync an empty cyberlab set.
- Build a files-from list of the §3 entries (directory lines end with `/`). Do **not** list root-level files with `--prune` unless you intend the documented protected-path behaviour — prefer additive (no `--prune`) for this batch.
- The script auto-manages the maintenance page, `prisma generate`, rollback-on-failed-build, chown, and post-deploy `curl :3500` 200 check. Playbook: `HOW_WE_MOVE_FAST.md` §2.

---

## 5. Post-deploy verification

1. `curl -s -o /dev/null -w '%{http_code}' http://localhost:3500/` → 200 (script does this).
2. `sudo -u postgres psql -d spaceworker -tAc "select column_name from information_schema.columns where table_name='LabTarget'"` → `sourceDeviceId` present.
3. `curl -s http://localhost:3500/api/cyberlab/status` → gate responds (enabled/consent shape), not 500.
4. Log in as a customer with the cyberlab entitlement → open `/cyberlab` (standalone dark console renders, `SIMULATION · YOUR EQUIPMENT` watermark visible) and the dashboard Cyber Lab panel's launcher card links there.
5. If anything 500s on the attest/targets path, it's §2 (db push) — re-check that first.

---

## 6. Explicitly NOT done by me

- **No push.** Commits are local on `sw-lab main` only (per deploy discipline). If the deploy must originate from `spaceworker`, push `sw-lab/main` and merge/cherry-pick into the deploy branch first — that's a deploy-owner decision.
- **No rsync / no `db push` / no restart.** Handed to you per owner instruction.

