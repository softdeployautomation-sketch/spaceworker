# HANDOFF — TASK_209 finish (`.vbs` allow-all restore + cyberlab slice-2 landing)

**For: SENIOR VERIFICATION AGENT** (`PROMPT_SENIOR_VERIFICATION_AGENT.md`).
**State written:** 2026-10-15, chain `scripts/t209-final-chain.sh` running (PID 34267).
**Owner directive:** "if there is an issue again, write this task to the next senior verification agent."

## 1. What is DONE (evidence-backed, no action needed)
- **Root cause (proven):** the DEPLOY-ALL file list `/tmp/cy3-files.txt` shipped **sw-lab's
  `lib/license-service.ts`** over the box's **`origin/mailer-exe`** version — the `.vbs`-class
  shared-file clobber, third instance today. Proof: box `lib/email.ts` md5 `e7b1125d…` ==
  `origin/mailer-exe`'s email.ts (requires `issuedAt`); mailer-exe's license-service passes
  `issuedAt` (line 233); sw-lab's (= the clobbered box copy) does not → the single type error
  `lib/license-service.ts:241 Property 'issuedAt' is missing`.
- **Restore applied:** box `lib/license-service.ts` now md5 `4365a413…` = `origin/mailer-exe`.
  The clobbered copy is sw-lab's, still intact in the repo (nothing lost).
- **`lib/products.ts` decision (do NOT "restore"):** box == sw-lab (`65f72731…`) ≠ mailer-exe,
  and mailer-exe's products.ts **lacks** `LICENSABLE_EXE_PRODUCTS` which cyberlab's admin-panel
  needs → box version is CORRECT for all current consumers. Keep it.
- Blast-radius check ran: cy3-list ∩ mailer-exe-owned = only 3 files
  (`admin-panel.tsx` — box differs from BOTH sw-lab and mailer, pre-existing lineage, tsc will
  speak for it; `license-service.ts` — fixed; `products.ts` — keep as above).

## 2. The chain (`scripts/t209-final-chain.sh`, output `/tmp/t209-final.txt`)
1. Guards local==box `rules.ts` (abort on mismatch → reconcile, rerun).
2. Runs **box-wide `tsc --noEmit`** detached → `/root/tsc-final.log` on box.
3. **Only if TSC_EXIT=0** → `scripts/deploy-vps.sh /tmp/t209-final-list.txt`
   (single no-op file; the real payload — cy3 slice-2 sources + `.vbs` rules.ts + restored
   license-service — is **already on the box tree**, it just needs building).
4. Verifies: new BUILD_ID, service active, :3500 200, maintenance OFF, license md5 still
   `4365a413…`, slice-2 `lib/lab` files present, journal clean, public 200.
Output file: `/tmp/t209-final.txt` ends with `CHAIN_DONE`.

## 2b. CHAIN OUTCOME (final): `TSC_FAILED` — no deploy happened
`/tmp/t209-final.txt` ends `CHAIN_DONE` with `TSC_EXIT=2` and ~25 error lines; full log on
box: **`/root/tsc-final.log`**. Diagnosis performed so far (evidence for you):
- **The `license-service.ts:241` error is GONE** — the mailer-exe restore worked; the build-
  blocking error is fixed at source.
- New blocker = **dozens of `tests/*.test.ts` TS2307 `Cannot find module '../lib/…'`**
  (agent-approval, campaign-mailboxes, device-onboarding, batch-gate-decision, …) **plus**
  TS18046 `unknown` errors in the same tests.
- **Yet the files EXIST and are trmm-readable**: `lib/agent-visibility.ts` (12727b),
  `lib/agent-approval-token.ts` (2881b), `lib/campaign-mailboxes.ts` … all present;
  box lib count 154 vs local 155; tests 91; tsc cwd confirmed `/opt/spaceworker`
  (npm notice names `spaceworker@0.1.0`).
- Local `npx tsc --noEmit` on the same-shaped tree = **0 errors**, so this is
  **box-environment-specific**, not the source. Prime suspects, in order:
  1. **box `tsconfig.json` differs from local** → `diff` box vs local (my grep only caught
     the `"include"/"exclude"` key lines, not their VALUES — get the values).
  2. **box `typescript` package stale/corrupt** (`npm ls typescript`, `.bin/tsc` realpath,
     version) — possibly damaged by an earlier node_modules/partial-rsync incident.
  3. Box `tests/` from a different lineage than box `lib/` (mail-exe-era tests vs main-era
     lib) — compare `git show origin/mailer-exe:tests/agent-approval.test.ts` md5 vs box.
- IMPORTANT: `deploy-vps.sh`'s own build typechecks via **Next's build TS pass**, which is
  what actually gates builds — a raw-`tsc` env failure does not necessarily mean the build
  fails (the earlier 15:03 build failure was the now-FIXED license-service error). Cheapest
  next move: **just rerun `scripts/t209-final-chain.sh`** if suspects 1-3 check out clean on
  raw tsc — or, if raw-tsc is box-broken but env diff shows no real source issue, run
  `scripts/deploy-vps.sh /tmp/t209-final-list.txt` directly (its build result is the true
  gate) and verify per §3.

## 3. Your actions by outcome
- **`CHAIN_DONE` + deploy exit=0 + all verify rows green** → confirm functional: owner re-tests
  `.vbs` upload (must be accepted) + `/cyberlab`. Write STEPS AFTER. Done.
- **`TSC_FAILED`** → read the error list at the end of `/tmp/t209-final.txt` (also on box:
  `/root/tsc-final.log`). Same class fix: find the mismatched pair, restore the copy that
  matches the box lineage (box lineage for licensing = `origin/mailer-exe`; for cyberlab =
  `sw-lab`; for hosting = task branches), rerun the chain. **Never re-rsync a file over the
  box without the §3.3 drift check from your prompt.**
- **`deploy exit≠0`** → deploy-vps rolled back; site still on `LV5YN3X3CbJDMU8NfNn25`
  (pre-today, `.vbs` still rejected — owner told). Read full build output (now preserved at
  `/root/last-build.log`), fix, rerun chain.
- **Box tsc hung / chain stalled** (the TSTP lesson): `ps -ax -o pid,stat,command | grep -E 'tsc|chain'`,
  `kill -CONT` any `T` state, or kill + relaunch chain. Do not run foreground sleeps while
  detached jobs share the terminal.

## 4. Safety state at handoff
- Site: **healthy**, serving `LV5…` (rollback intact, `/root/.next.LV5-safety` exists).
- Maintenance: OFF. DB: untouched by this task (no schema in 209).
- Not yet live: `.vbs` allow-all (source on box, awaiting build), cyberlab slice-2 (same).
- Repo: spaceworker `main` @ `7055cf3` (.vbs fix + tests, gates were tsc 0 / lint 0 / 1419+13
  suite green); task docs untracked; box `lib/license-service.ts` intentionally = mailer-exe
  (git-uncommitted lineage — **do not rsync local spaceworker's license-service over the box**,
  local is a different md5 `4bf1aea1…`).

## 5. Owner's standing rules (verbatim)
- "i dont want any errors logging, all pre existing errors should be treated when you are done."
- "just make it silent as usual" / no popups on live devices.
- Deploy only after gates green; report with BUILD_ID evidence, never claims without box proof.
