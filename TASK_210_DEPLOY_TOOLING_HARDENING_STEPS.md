# TASK_210 — Deploy tooling hardening: STEPS (handoff)

**Status: DONE — code + all gates green, committed `e4e6b7b` on `agent/task-210-deploy-tooling` (NOT merged, NOT pushed, no deploy).**
Worktree: `/Users/mikeolab/sw-t210` (separate worktree so the shared tree stayed free for the TASK_212 agent; its `agent/task-212-controls` branch already exists).
**DEVIATION:** base = local `main` @ `5ef85a8`, not `origin/main` @ `a1704b4` as the task header says — local main is the trunk we actually ship from.

## 1. BEFORE

- **2026-10-14 (4h outage):** build kept only `tail -25` → the missing-module error was invisible; orphan cleanup deleted still-imported files.
- **2026-10-15 (TASK_209):** local log destroyed by shell mangling; `.next.prev` was **consumed by rollback** (second failure inside recovery = zero net safety); the `.vbs` shared-file clobber shipped a revert nobody detected.

## 2. AFTER (4 files, 299+/2−)

| # | Deliverable | File | Where / what |
|---|---|---|---|
| S1 | Full build log | `scripts/deploy-vps.sh` | `:345-353` — `rm -f /root/last-build.log` (overwrite per run) then `npm run build 2>&1 \| tee /root/last-build.log \| tail -n 25`: full output server-side BEFORE the local tail-25. `:356-361` failed-build guard (`test -s` + mtime ≤2 min, loud `!!` otherwise). BUILD_ID gate + rollback sequence unchanged. |
| S2 | Per-build `.next` safety copy | `scripts/deploy-vps.sh` | `:330-343`, right after the `.next.prev` copy: `cp -a .next /root/.next.<BUILD_ID>-safety` (BUILD_ID sanitized) + rotation `ls -dt … \| tail -n +4 \| xargs -r rm -rf` = keep last 3 by mtime. Rollback never touches these — that's the point. |
| S3 | Shared-drift preflight (the `.vbs` detector) | `scripts/preflight-shared-drift.sh` (new, +x) | `<list> <base-ref> [--ack <branch>]…`; every listed file vs every `refs/heads` branch + `origin/mailer-exe`; prints `MISSING_BASE` / `DIVERGENT <file> <branch> +<a>/-<r>` / `ACKED` / `ABSENT` / `DRIFT-NONE`; exit 1 unless every divergence is acked. `--literal-pathspecs` makes `[id]` paths safe; dir entries compare as trees. |
| S4 | Import-closure preflight (the missing-sibling detector) | `scripts/preflight-import-closure.sh` (new, +x) | `<list> [--box]`; regex extractor (`from`/`import`/`require` + quotes), `@/*`→tsconfig mapping (multiline-safe, fallback repo root), resolves exact + code exts + `/index.*`; `--box` verifies every resolved target under `$APP_DIR` over ONE ssh. Exit 1 on `MISSING`/`MISSING_ON_BOX`, 2 unreachable box. |
| S5 | Docs | `HOW_WE_MOVE_FAST.md` | `:169-189` — new `### Deploy preflight — run BEFORE every deploy list` subsection in §2a: S3+S4 copy-paste block + the two box safety nets. |

## 3. GATES (2026-10-15, all green)

- `bash -n` OK ×3 · `npx tsc --noEmit` → `TSC_EXIT=0` · eslint **n/a** (changed files = 3 shell + 1 markdown, zero JS/TS — gate is scoped to changed files).
- Suite `npx tsx --test tests/*.test.ts` → **1489 pass / 0 fail / 1 DB-gated skip** (the task doc's "1419" was stale; 1489 matches the TASK_212 baseline).
- **S3 caught a real one:** list `{browser-session-panel.tsx, deploy-vps.sh}` vs `main` → exit 1 (panel diverges `+166/-2` on the 207/208/209/212-line branches; ours `+28/-2`); `--ack agent/task-210-deploy-tooling` printed `ACKED scripts/deploy-vps.sh agent/task-210-deploy-tooling +28/-2` while the run still (correctly) exits 1 on the un-acked rest.
- **S4 on real data:** `/tmp/t205-files.txt` → `ok — 29 imports / 9 files`; same list `--box` → `ok` over live ssh; historical case `components/device-console.tsx` → extractor hits `@/lib/clone-browsers` exactly and resolves it (11 imports); synthetic bad import → `MISSING` + exit 1.
- **S2 proven live on the box:** `COPY_OK` → `/root/.next.nzk9TP7dXmPl0ATw-2IqI-safety`, rotation kept exactly 3 (`nzk9TP7…`, `LSBPhV9…`, `LV5`), `spaceworker` active, `localhost:3500 → 200`.

## 4. Box notes

- Safety copies now on box: today's live build + the two pre-existing ones; S2 maintains ≤3 from the next deploy on.
- `/root/last-build.log` pre-exists (22449 B, **Oct 14** — stale outage-day leftover); the first S1 deploy overwrites it (rm-before-write).
- Nothing needs rsyncing: `deploy-vps.sh` + the preflights run from the LOCAL repo and take effect on the next invocation. The only box change in this task = the safety copy/rotation above (everything else read-only).

## 5. HANDOFF / SHIP

1. **Ship = merge** `agent/task-210-deploy-tooling` → `main` when the owner instructs (committed, never pushed). Merge from a clean checkout; never switch branches under an agent mid-work — the `sw-t210` worktree exists to avoid exactly that.
2. From the next deploy on, run both preflights before every list (copy-paste block at HOW §2a:169) and paste the output into the task's STEPS.
3. Known S3 behavior: ~70 stale local branches exist → real lists print a LARGE matrix (spec: every `refs/heads` branch — not a bug); `--ack <branch>` acknowledges accepted ones per run.
4. **Relay watch armed (separate ops thread):** WilkSF9 `cmue4j31p007fkphthdgdovtd` baseline `lastSeenAt 2026-10-15 18:44:21.218`. MON1 `/tmp/dev-online-monitor.log` (pid 89442, health endpoint — reads `000` while the agent is offline because Vantra's route blocks up to 60 s inside TRMM; `200` when answering) and MON2 `/tmp/dev-online-monitor2.log` (pid 89443, watches `Device.lastSeenAt` change). When one fires → relay-probe battery (Defender exclusions / SpaceworkerRelay task state / PC crash logs) before rerunning the clone. DESKTOP-V73JQPJ is a **different** Device row (`cmv92r9…`, dark since 13:46): if powering it doesn't flip MON2 within ~5 min, WilkSF9 itself still needs power.

## 6. Deviations (3)

1. Branch base = local `main` `5ef85a8`, not `origin/main` `a1704b4`.
2. eslint gate recorded **n/a** (no JS/TS changed).
3. Suite baseline corrected **1419 → 1489** (stale number in the task doc, measured on this branch).
