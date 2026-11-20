# TASK_209 — Restore the .vbs allow-all (revert of an accidental clobber)

**Status:** PLANNED → implementing · **Repo:** spaceworker · **Branch:** `agent/task-209-vbs-allow-restore` (off `agent/task-207-console-scope`)

## 1. What broke (owner report)
Yesterday the owner's "allow all file types for hosting" task landed (on the `mailer-exe` branch, deployed from its working tree) and `.vbs` hosting worked. Today the upload errors with
"Files of type `.vbs` can't be hosted as downloads…" again.

## 2. Root cause (CONFIRMED with file evidence)
- The allowance exists ONLY on branch `mailer-exe` (`lib/hosting/rules.ts` + `tests/hosting-files.test.ts`, owner-dated 2026-10-14).
- At 14:25:55 (Oct 14) this session checked out `agent/task-206` FROM `mailer-exe` — git rewrote the working-tree `rules.ts` back to the blocking version (box mtime of `/opt/spaceworker/lib/hosting/rules.ts` = that exact second; rsync preserves source mtimes).
- A later deploy (task-205 list included `lib/hosting/rules.ts`) shipped the reverted copy to the box → `scanUpload` blocks `vbs` again.
- No runtime setting involved; the user's "it worked yesterday" was the mailer-exe working-tree deploy.

## 3. Fix (playbook-clean — commit it this time, no working-tree deploys)
1. New branch off the current deployed lineage (`agent/task-207-console-scope`).
2. `git checkout mailer-exe -- lib/hosting/rules.ts tests/hosting-files.test.ts` (the diff is exactly the scanUpload retirement + its 2 test updates; verified no other divergence on those files, no new imports).
3. Gates: tsc 0 · eslint on the 2 files 0-new · **full suite green** (owner's standing rule: no pre-existing errors may remain) · check no other test asserts `blocked_extension` for downloads (grep).
4. Commit (single, owner-decision message).

## 4. Deploy (one clean rebuild)
- rsync `lib/hosting/rules.ts` only → server build (rollback-safe) → restart.
- Verify: BUILD_ID changed · old error string ABSENT from built chunks · **live .vbs upload via API succeeds** · site 200 · maintenance OFF.
- Bonus: the box already carries the cyberlab slice-2 files (rsynced but never built); this rebuild bakes them in if coherent — verify slice-2 markers in the new build.

## 5. Meta-lesson (recorded)
The third shared-file clobber: parallel agents deploy unmerged branches; my branch-switches + per-file deploys overwrite them. Rule: before any deploy whose list includes a shared file, diff that file against ALL non-main branches the owner has in flight (mailer-exe, sw-lab) and never ship a divergent copy silently.
