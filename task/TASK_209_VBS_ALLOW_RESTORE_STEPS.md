# TASK_209 STEPS — .vbs allow-all restore

## BEFORE — 2026-10-15
- Root cause CONFIRMED (see task doc §2): the allowance lived only on `mailer-exe`; my Oct-14 14:25 checkout (mailer-exe -> task-206) rewrote the working-tree rules.ts, and the task-205 deploy shipped the reverted copy to the box (box mtime = the checkout second; rsync -a preserves mtimes).
- Box `scanUpload` (live): `vbs` in BLOCKED_EXTENSIONS -> exact user error string reproduced in source.
- Recovered from `mailer-exe` (committed there, tip 56509b3): rules.ts scanUpload retirement (owner decision 2026-10-14, executables stay GATED, serve route = attachment+nosniff) + 2 hosting-files test updates.
- Grep: no other test asserts blocked downloads; scanUpload called only from the hosting upload path.
- Branch: `agent/task-209-vbs-allow-restore` off `agent/task-207-console-scope` (current deployed lineage).


## HANDOFF → VERIFICATION AGENT (resolved) — see PROMPT §7

## AFTER — 2026-10-15 (Senior Verification Agent)

### Chain outcome
Chain's first run ended `TSC_FAILED` (TSC_EXIT=2, 218 errors). Root cause found with
`--traceResolution`: **86 stray `*.test.ts` copies at the box repo ROOT**
(`/opt/spaceworker/*.test.ts` — accumulated by historical flattened rsyncs; no repo
tree has tests at root). tsc included them via `**/*.ts`; from the root their
`../lib/…` imports resolve to `/opt/lib/…` (nonexistent) → every TS2307/TS18046/TS7006
in the log was one of these strays. **0 errors came from the real `tests/` dir.**
Fix applied (not re-rsynced — moved, with md5 evidence):
- `scripts/t209-strays-force.sh` → all 86 moved to **`/root/stray-tests-20261015/`**
  (81 md5-identical to their `tests/` twins; 5 lineage-divergent, md5s logged in
  `/root/stray-tests-cleanup.log`).
- Box-wide `tsc --noEmit` rerun → **`/root/tsc-final2.log`: TSC_EXIT=0, 0 errors.**
- Side finding (deferred hygiene, NOT touched pre-deploy): box `tests/` lineage drift —
  audit (`scripts/t209-tests-audit.sh`, log `/tmp/t209-tests-audit.txt`) = 75 files ==
  7055cf3, 2 lab extras kept, **14 files off the 7055cf3 lineage** (3 match no branch).
  All typecheck clean; restore batch deferred to a follow-up task.

### Chain rerun + deploy (log `/tmp/t209-final.txt`, ends `CHAIN_DONE`)
- rules.ts guard: local == box `6b95a8f7…` ✔ · box tsc gate: `TSC_EXIT=0` ✔
- `deploy-vps.sh` **exit=0** · prisma generate OK (no schema/db-push — 209 has none)
- **BUILD_ID `LV5YN3X3CbJDMU8NfNn25` → `LSBPhV9fXXLIV3nozjbo6`**
- service active · localhost:3500 → 200 · https://spaceworker.top/ → 200 · maintenance OFF
- safety: `/opt/spaceworker/.next.prev` + `/root/.next.LV5-safety` both exist
- license-service box md5 still `4365a413…` (= origin/mailer-exe, intentional) ✔
- slice-2 `lib/lab` markers present (4) · journal: no module/runtime errors —
  the single `Failed with result 'exit-code'` line is the **SIGTERM stop (status=143)
  of the old process during restart**; new PID booted `Ready in 416ms`, env-health OK.

### Verification battery (`scripts/t209-verify.sh` + `scripts/t209-functional.sh`)
| Check | Result |
|---|---|
| old error string `hosted as downloads` in built chunks | **0 hits** |
| new policy marker `gate is retired` in server chunk map | **present** |
| cyberlab slice-2 built pages under `.next/server/app/cyberlab/` | **present** |
| functional: POST `/api/hosting/files` with `t209-probe.vbs` | **201** (full file payload, url `https://dl.instaweb.top/hf/…`) |
| control: POST `.exe` w/o acknowledgeGated | **400 `gated_ack_required`** (executables stay gated) |
| probe cleanup DELETE | **200** (no junk left) |
| `GET https://spaceworker.top/cyberlab` | **200** |
| DB | n/a — no migration in this task |

### Incidents during verification
1. First functional run false-FAILED: `UID` is a **readonly bash variable** — the
   probe minted a session for id `0` → 401. Fixed (`PROBE_USER`), rerun green.
   A 401 is not proof of a broken feature; always read the body before judging.

### Follow-ups (owner/queue)
1. **Box `tests/` 14-file lineage drift** — restore batch deferred (compiles clean).
2. **Root `.ts/.tsx` strays (non-test)** — dozens of flattened `lib/`+`components/`
   copies still at `/opt/spaceworker/` root: compile clean, dead weight, but they are
   drift-detector bait (same class as the `.vbs` clobber). Candidates for cleanup in
   TASK_210 tooling + a one-shot sweep.
3. **TASK_210 not started** — no `agent/task-210-deploy-tooling` branch exists yet
   (scoped to task agent, no handoff) → nothing to deploy for 210 this session.
