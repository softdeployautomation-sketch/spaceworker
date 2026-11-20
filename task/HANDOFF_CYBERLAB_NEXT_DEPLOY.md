# HANDOFF — CyberLab NEXT deploy (S7-A Replay + Admin Guide + S7-B Tool Bridge)

**Written by:** cyberlab agent · **For:** the deploy agent (the one who ran the money-flow deploy)
**Status:** ready to run · **Ship:** 3 commits (S7-A, admin guide, S7-B) · **DB change: NONE**

---

## 1 · What's already live (verified over SSH just now — do NOT re-ship)

The money-flow batch (`3eb3186`) **is deployed**. Confirmed on the box:
- `"PremiumInvoice"` plan CHECK now = `ARRAY['premium_plus','premium_xdevice','cyberlab']` ✔
- `AdminSetting` has all cyberlab dials: `cyberlabEnabled`, `cyberlabLiveEgressEnabled`,
  `cyberlabEgressRequireOwnershipProof`, `cyberlabEgressScopeGuard`, `cyberlabModulePriceUsd`, … ✔
- `lib/lab/` has `recon-core/recon-runner/live-core/live-runner.ts`, `components/cyberlab-ops-console.tsx` present, old `cyberlab-console.tsx` gone ✔
- Service `spaceworker.service` active · app root `/opt/spaceworker` · db `spaceworker` (user `spaceworker_app`).

**So: recon, real egress, and the add-on money flow are ALREADY working in production.**

## 2 · What THIS deploy ships (the only delta)

`3eb3186..5682d9b` — **15 files** (`git diff --name-status 3eb3186..HEAD`):

**New (A) — 9:**
- `app/cyberlab/replay/[id]/page.tsx`          — S7-A replay route
- `components/cyberlab-replay-player.tsx`      — S7-A scrubber player
- `lib/lab/replay.ts`                          — S7-A pure replay mapping
- `app/api/cyberlab/runs/[id]/artefacts/route.ts` — S7-B POST (signed companion episode)
- `components/cyberlab-tool-bridge.tsx`        — S7-B cards + return banner + paste-attach
- `lib/lab/tool-bridge.ts`                     — S7-B pure bridge helpers
- `components/admin/cyberlab-guide.tsx`        — admin Guide panel
- `tests/lab-replay.test.ts`, `tests/lab-tool-bridge.test.ts`, `tests/cyberlab-admin-guide.test.ts`

**Modified (M) — 6:**
- `components/cyberlab-ops-console.tsx`   — Replay ▶ link + "3 · Run it with the real tools" section
- `app/admin=topsecret6199/(protected)/admin-panel.tsx` — **ONLY 4 lines**: `CyberLabGuide` import (L17) + a 3-line mount div inside `CyberLabAdminTab`. Verified via diff — nothing else.
- `package.json` — registers the 3 new test files in `test:lab`
- `HANDOFF_CYBERLAB_DEPLOY_ALL.md`, `TASK_156B_..._STEPS.md` — docs

**NO schema change** in this range → **NO `prisma db push`, NO `prisma migrate deploy`, NO psql.** Pure code/rsync + rebuild.

## 3 · How to deploy

1. **Source is LOCAL-ONLY and UN-PUSHED.** `origin/main` is **18 commits behind** local `main` (`5682d9b`). Deploy from **`/Users/mikeolab/sw-lab`**, NOT from `spaceworker` (the cyberlab code is not in the spaceworker checkout).
   - If your flow requires a push first: `git push origin main` from `/Users/mikeolab/sw-lab` (owner's call), then rsync/clone on the box. Otherwise rsync straight from the local tree.
2. **Rsync the §2 file list** (or the whole tree, excluding `node_modules`, `.next`, `.env`, `prisma/migrations` if you prefer code-only) to `/opt/spaceworker`.
3. **Rebuild + restart:** `cd /opt/spaceworker && npm ci && npm run build && systemctl restart spaceworker`.

## 4 · Coordination / gotchas

- **`admin-panel.tsx` is the ONE shared file.** My 4-line edit (guide import + mount) is committed. If the other agent's **task205** hosting work also edited `admin-panel.tsx` and is on the box but NOT yet in `origin/main`, **merge — do not overwrite** — so you don't revert their hosting edits. The safest path: rsync my version only if task205 is already merged into local `main`; otherwise cherry-pick/merge manually.
- **No DB step.** If you also owe a *later* schema batch, do it separately — nothing here needs the database.
- Everything here is **append-only UI/routes** — it cannot break the already-live money-flow or egress paths.

## 5 · Post-deploy verification

- `/cyberlab` loads (standalone, light/dark via the app toggle).
- Open a completed run → **Replay ▶** → `/cyberlab/replay/<episodeId>` renders the scrubber; signature shows VERIFIED/INVALID from the server.
- Console shows **"3 · Run it with the real tools"** between Scenarios and Attested targets.
- Admin → **Cyber Lab** tab shows the **Guide** panel at the top (above Caps).
- `curl -s -o /dev/null -w '%{http_code}' /api/cyberlab/runs/<id>/artefacts -X POST` → expect **401** (unauth) not 404/500 (route mounted).
- `npm run test:lab` on the box (optional) → 97/97.

## 6 · If something's wrong

- **Replay 404s** → the `app/cyberlab/replay/[id]` dir didn't rsync (bracketed `[id]` path — some rsync configs need `-s`/shell-escape; verify the literal `[id]` dir exists on the box).
- **Guide missing in admin** → the 4-line `admin-panel.tsx` edit didn't land (check the import at L17).
- **Tool-bridge attach 404s** → same `[id]` bracket issue on the artefacts API route.

---

## DEPLOY RECORD — executed & verified (senior verification agent · 2026-10-15 18:20 CEST)

**How:** `spaceworker/scripts/deploy-vps.sh` with `LOCAL_ROOT=/Users/mikeolab/sw-lab`, file list = §2's `3eb3186..5682d9b` 15-file delta **+ this handoff doc (16 paths)**, no `--prune` (additive). `npm ci` skipped deliberately: the `package.json` delta is scripts-only (`test:lab` line); dependencies untouched.

**Preflight (all green):** drift matrix — every shared file on the box was byte-identical to the `3eb3186` base (`admin-panel.tsx` c1d59cb0, `cyberlab-ops-console.tsx` 086c8819, `package.json` e132c06a), so the §4 merge question resolved itself: task205's hosting edits never touched `admin-panel.tsx`, and the 4-line guide diff applied as a pure fast-forward. Import closure: 0 broken, 9 in-ship-set, 20 external deps all present on the box. No `prisma/` paths in the delta. Safety copy taken: `/root/.next.LSBPhV9fXXLIV3nozjbo6-safety`.

**Result:**
- BUILD_ID `LSBPhV9fXXLIV3nozjbo6` → **`nzk9TP7dXmPl0ATw-2IqI`**; restart 17:59:44 CEST; service active; maintenance OFF; runtime paths (`.env`/`.next`/`node_modules`/`static`) asserted; rollback available (`.next.prev` + safety copy).
- md5: **16/16** shipped files byte-identical to sw-lab `12ff9a8`.
- `npm run test:lab` on the box: **71/71 pass, 0 fail** — all 10 files ran (replay/bridge/guide test lines confirmed in the log; §5's "97/97" was an estimate).
- Functional (`spaceworker/scripts/cyberlab-s7-functional.sh` → `/tmp/cy7-functional.txt`): `/cyberlab` 200 · `/cyberlab/replay/<id>` **200 (NEW route → the new build serves)** · GET artefacts **405** (route mounted, POST-only) · POST unauth **401** · POST auth'd **403 `cyberlab_required`** (gate live; ZERO cyberlab entitlement rows exist yet — grant via the new admin Guide). All refusal paths — zero rows written.
- Sweeps: box root `*.test.*=0 *.bak=0 *.orig=0`; cyberlab dirs 0 strays; literal `[id]` dirs present (`runs/[id]/artefacts/`, `replay/[id]/page.tsx`); journal clean since restart; public root 200.

**Known pre-existing (NOT from this deploy):** 54 untracked legacy `*.tsx` copies at `/opt/spaceworker/` root (mtimes 09-08 → 10-08; untracked in every repo; tsc reads them — HANDOFF_T209_FINISH noted "13", actual 54).

**Still unpushed:** sw-lab `main` (now +1 docs commit) remains LOCAL-ONLY per §3.

