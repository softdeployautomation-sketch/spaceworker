# TASK_210 — Deploy tooling hardening (prevents yesterday's + today's incidents)

**Status:** SCOPED → assigned to TASK AGENT · **Repo:** spaceworker · **Branch:** `agent/task-210-deploy-tooling` (base `origin/main`) · **No deploy by the task agent.**

## 1. Why (two incidents, same week — owner: "i dont want to be going through this again")
- **2026-10-14 (4h outage):** mid-build SIGTSTP freezes, build output truncated to last 25
  lines hiding the missing module, orphan cleanup vs stale-code imports, stray root
  `schema.prisma` hijacking prisma generate.
- **2026-10-15 (TASK_209):** build failure diagnosis impossible — the local deploy log was
  destroyed by shell mangling and `deploy-vps.sh` captures only `tail -25` of the build;
  `.next.prev` safety copy was **consumed by the rollback**, leaving no safety net; the
  shared-file clobber (`.vbs`) shipped a revert nobody detected because no preflight diffed
  shared files against other branches.

## 2. Scope (repo-only code; each item ships with its own check/test)

### S1 — Full build-log preservation in `scripts/deploy-vps.sh`
Change the build step so the **complete** `npm run build` output is preserved on the box:
`sudo -u "$SERVICE_USER" bash -c "cd '$APP_DIR' && npm run build" 2>&1 | tee /root/last-build.log`
(or equivalent that writes full output server-side before any local tail). Keep echoing the
last 25 lines locally. Log must be **overwritten** per run (rm-before-write), never appended
across runs. Guard: after a failed build, `test -s /root/last-build.log` and its mtime == now.

### S2 — Per-build `.next` safety copy in `scripts/deploy-vps.sh`
Before the build, additionally `cp -a .next /root/.next.<CURRENT_BUILD_ID>-safety` (keep
last 3 by rotation: `/root/.next.*-safety`); the existing `.next.prev` rollback stays.
Rationale: rollback consumes `.next.prev`, so a second failure inside recovery had zero net.
Failure path unchanged otherwise (rollback → restart → health → maintenance OFF).

### S3 — `scripts/preflight-shared-drift.sh` (the `.vbs` clobber detector)
Input: a deploy file list + base ref. For each listed file: diff against **every** branch in
`refs/heads` + `origin/mailer-exe` (if present) and print `DIVERGENT <file> <branch> <±lines>`
when another branch's copy differs from ours; exit non-zero on any divergence unless
`--ack <branch>` acknowledges it. Output: a drift matrix suitable for pasting into STEPS.

### S4 — `scripts/preflight-import-closure.sh` (the 4-hour missing-sibling detector)
Input: a deploy file list. Resolve every `@/…`/relative import in those files (TS/TSX,
regex-level is fine — no need for the TS compiler) and verify each resolved target exists
**locally**; with `--box`, also verify on the VPS under `/opt/spaceworker/` via ssh.
Print `MISSING` lines; exit non-zero if any. Must correctly trace
`components/device-console.tsx → lib/clone-browsers.ts` (the historical case).

### S5 — Docs
Add a short "Deploy preflight" subsection to `HOW_WE_MOVE_FAST.md` §2a: run S3 + S4 before
every deploy list; safety copies exist; full build logs are at `/root/last-build.log`.

## 3. Gates (owner standing rule — zero errors, pre-existing included)
`bash -n` on all touched scripts · `npx tsc --noEmit` 0 · `npx eslint` 0 err/0 warn on
changed files · full suite green (1419 baseline, 1 known DB-gated skip) ·
S3/S4 exercised against real data: S4 with `/tmp/t205-files.txt` and the historical
clone case; S3 against a list containing a known-divergent file (prove it catches one).

## 4. NOT in scope (explicitly)
- No deploy of this tooling by the task agent; Verification Agent ships it (handoff in STEPS).
- No behaviour change to build/restart/rollback sequencing beyond S1/S2's log+copy additions.
- No changes to Vantra's deploy scripts (separate follow-up if wanted).
