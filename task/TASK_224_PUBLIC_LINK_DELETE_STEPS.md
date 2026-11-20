# TASK_224 STEPS — Delete button for public install links (Task Agent working record)

Task doc: `TASK_224_PUBLIC_LINK_DELETE.md` (SCOPED 2026-10-19).

## BEFORE record (2026-10-18 session start)

### Git state
- Branch created: `agent/task-224-install-link-delete` @ `982a42c` (= local `main` = `origin/main`, fresh).
- Prior branch: `agent/task-222-f8-signup-gate` @ `d4a6754`.
- Tracked working tree: CLEAN (all untracked `TASK_*`/`HANDOFF_*`/`scripts/*` docs carried over untouched).
- Owner files preserved byte-identical: `PROMPT_NEXT_AGENT.md`,
  `PROMPT_NEXT_VERIFICATION_AGENT.md`, `PROMPT_TASK_AGENT.md`,
  `PROMPT_SENIOR_VERIFICATION_AGENT.md` (hash-verified vs `origin/main`;
  safety copies in `/tmp/t224-prompt-backup-20261018084621` and `/tmp/t224-prompt2-20261018084754`).
- **Branch-base incident (recorded honestly):** first `-b` attempt created the
  branch from task-222's tip because `main` is locked to the sibling worktree
  `/Users/mikeolab/sw-vbsfix` (`fatal: 'main' is already used by worktree`).
  Fixed with `git checkout -B agent/task-224-install-link-delete origin/main`
  after hash-verifying every conflicted file was byte-identical to `origin/main`.
  Noted: to switch branches here, never `git checkout main` — use `origin/main`
  or the `sw-vbsfix` worktree.

### §3.1 CLOBBER CHECK (before touching `components/device-list.tsx` / `lib/vantra-link.ts`)
Branches whose changes vs `main` touch these files:

| Branch | Files | Overlap with my edits? |
|---|---|---|
| `agent/task-206-quarantine-rework` (unmerged, 2026-10-14) | `device-list.tsx` (+2 @ L61, L792 hunks), `vantra-link.ts` (+36) | **No line overlap** — my block is L1232–1281 + a new handler; 206's hunks are elsewhere. Do NOT `git checkout <206> -- <file>` ever. Potential textual conflict at merge → flag in handoff. |
| `phase2-selfhosted-env` (2026-09-27), `self-hosted-build` (2026-10-01), `xdevice-monitor` (2026-10-13) | `vantra-link.ts` (each 7 lines: +2/−5, identical delta) | Informational only; my lib change is additive (new helper), no clobber path. |

### Owner decisions (from task doc top)
- **Current link PROTECTED** — no delete on the row matching `link.installUrl`;
  only history rows (expired or live) removable. Expired current stays until replaced.
- Schema change: NONE. Deploy: NOT this agent (Senior Verification after 🚦 GO).

## Steps

- [x] 0. Session ritual: task doc + playbook read; git BEFORE captured; clobber check run.
- [x] 1. Read surfaces: device-list.tsx block, vantra-link.ts (list/resolvers), POST install-link route, `[id]` house pattern, session/audit helpers, test harness.
- [x] 2. `lib/vantra-link.ts` — `deleteInstallLink()` helper (ownership 404 + current-link 409 + delete + audit, all prod code the tests will hit).
- [x] 3. New route `app/api/assistant/vantra/install-link/[id]/route.ts` (DELETE, Next-16 Promise params).
- [x] 4. `components/device-list.tsx` — Delete button (hidden on current row), `useConfirm` danger variant, `deletingId` busy state, optimistic row removal / error path.
- [x] 5. Tests ×7 in `tests/vantra-link-installer.test.ts` (incl. fake-delegate `delete`/`findFirst` addition — stub must actually work).
- [x] 6. Gates — ALL GREEN, evidence below.
- [x] 7. Commit (ONE, message = task id) + `HANDOFF → VERIFICATION AGENT` section. <!-- hash appended post-commit -->
  - Committed 2026-10-19: **`816bea7`** — `TASK_224: delete button on public install-link history rows (current link protected — UI-hidden + server 409)`. Exactly 4 files, 312 insertions. Tracked worktree clean after commit. (STEPS/task docs intentionally left untracked, per house convention.)

## Gate evidence (2026-10-18/19)

| Gate | Command | Result |
|---|---|---|
| Typecheck | `npx tsc --noEmit -p .` | exit 0, no output |
| Schema | `npx prisma validate` | "The schema at prisma/schema.prisma is valid 🚀" exit 0 (schema UNTOUCHED by this task — gate run for the record) |
| Lint | `npx eslint components/device-list.tsx lib/vantra-link.ts 'app/api/assistant/vantra/install-link/[id]/route.ts' tests/vantra-link-installer.test.ts` | exit 0, no findings |
| Touched suite | `npm run test:vantra` | **97/97 pass, 0 fail, 0 skipped** (7 new TASK_224 tests = ok 91–97; prior baseline 90) |
| FULL suite | `npm test` (backgrounded via nohup + poll, per §5.4) | **1670 tests / 1669 pass / 0 fail / 1 skipped** (pre-existing skip), 25 suites, 22.3 s — floor 1662 exceeded |
| Build | `CI=true npm run build` (backgrounded + polled) | ✓ Compiled successfully; `/api/assistant/vantra/install-link/[id]` appears as `ƒ` (Dynamic) in the route table |

### Build-gate note (pre-existing, NOT this task — proven by baseline)
Plain `npm run build` (no `CI`) fails on this machine at
`/api/admin/campaign-templates` with `RESEND_API_KEY looks like a dev/placeholder
value in PRODUCTION (starts "re_local_dev...")` — the `lib/env.ts` guard added
after the 2026-09-27 incident. Proven pre-existing by **stashing all four
TASK_224 files** and rebuilding clean `982a42c` (= `origin/main`): identical
failure (`/tmp/t224-build-baseline.log`, guard count 1, page-data failure count 1).
`.env:3` literally holds `RESEND_API_KEY=re_local_dev...`. The guard is
deliberately gated on `!process.env.CI` ("the CI build legitimately sets
NODE_ENV=production AND its own placeholder values"), so the build was run with
`CI=true` — exactly the signal deploy CI sends — and passed clean
(`/tmp/t224-build-ci.log`). No `.env` was edited; nothing was bypassed.

## HANDOFF → VERIFICATION AGENT

**Task:** TASK_224 — Delete button on public install-link history rows.
**Status:** COMPLETE, awaiting Senior Verification → owner 🚦 GO → CI deploy.

### Repo / branch / commit
- Repo: spaceworker, `/Users/mikeolab/spaceworker`.
- Branch: `agent/task-224-install-link-delete` (based on `origin/main` @ `982a42c`).
- Commit: **`816bea7`** — `TASK_224: delete button on public install-link history rows (current link protected — UI-hidden + server 409)` (ONE commit, 4 files, 312 insertions; branch tip).
- ⚠️ Depends-on / merge-order: NONE. (No other in-flight branch owns these hunks; see §3.1 clobber check in BEFORE record. `agent/task-206-quarantine-rework` touches the same two files but different hunks — textual conflict possible at ITS merge, not this one.)

### Deploy file list (rsync/tar these — NO migration, NO schema change)
1. `lib/vantra-link.ts` — NEW exported helper `deleteInstallLink(userId, id)` (additive; existing exports untouched).
2. `app/api/assistant/vantra/install-link/[id]/route.ts` — NEW FILE (new directory). `DELETE`, `export const dynamic = "force-dynamic"`, `getSession()`-guarded (401 anon — no route-middleware exists per §5.3), Next-16 `params: Promise<{id}>` awaited.
3. `components/device-list.tsx` — Delete button + `deleteInstallLinkRow` handler + `deletingId` state (UI only; imports unchanged).

Import closure checked (§3.1): route imports only `next/server`, `@/lib/session`, `@/lib/vantra-link` — all already deployed. `lib/vantra-link.ts` change adds a function using existing `db` + `recordAgentActionAudit` + `getVantraLinkView` — no new deps.

### Migration / DB steps
NONE. `prisma/schema.prisma` untouched. Deletion is a plain row delete on `VantraInstallLink` at runtime — **no `prisma db push`, no migrate.** (`prisma validate` ran green for the record.)

### Behaviour summary (what the code enforces)
- Owner rule (2026-10-19): the CURRENT link row is PROTECTED. UI hides the button (`item.installUrl !== link.installUrl`), AND the server 409s (`current_link` error) if a hand-crafted DELETE targets the current token — the hide is not the gate.
- History rows (expired OR live) delete; no `expiresAt` branch anywhere.
- Ownership: another user's row → 404 `not_found` (never 403 — no existence oracle).
- Deletion is LOCAL-ONLY: no `vantraFetch`, no `VantraLink` pointer change; the token resolves nowhere afterwards because both resolver paths look up the deleted row (covered by test).
- Audit: `vantra_install_link_deleted` via `recordAgentActionAudit`, detail `{ orgId }` only — URL/token NEVER enters the audit row (same rule as mint).
- UI confirm: `useConfirm` danger variant; expired copy reassures "nothing stops working".

### Post-deploy verification checks (senior lane, on-box)
1. `ls -la /opt/spaceworker/app/api/assistant/vantra/install-link/` → `[id]/route.ts` present, mtime = deploy time.
2. `grep -c 'deleteInstallLink' /opt/spaceworker/lib/vantra-link.ts` → ≥ 2 (definition + export).
3. As a logged-in user with ≥ 2 minted links: row shows "Delete" on non-current rows; NO Delete on the current row; confirm dialog appears; row disappears; a second browser (stale copy of the token) gets 404 from BOTH resolver paths after reload.
4. `curl -X DELETE https://<apphost>/api/assistant/vantra/install-link/<some-id>` (anon) → 401.
5. Admin audit list shows `vantra_install_link_deleted` with orgId only (grep the row for the absence of `/link/vantra/`).

### Risks / rollback
- Risk: LOW. Additive helper + new isolated route + UI button. Worst case a broken DELETE route → 404/500 on click; nothing else calls it. No schema, no migration, no shared-file clobber.
- Rollback: delete `app/api/assistant/vantra/install-link/[id]/` dir, revert the 3 modified files (single revert commit). No DB rollback needed.
- NOTE for senior lane: plain local `npm run build` fails at `/api/admin/campaign-templates` due to the `.env` placeholder `RESEND_API_KEY` + `lib/env.ts` guard — **pre-existing on origin/main** (baseline-proven). CI builds pass (CI=true). Not a TASK_224 issue; no action needed unless the owner wants the local `.env` realigned.

## DEPLOYED & VERIFIED — Senior Verification Agent (2026-10-18)

Shipped to production in CI run **39118093287** (Build & Deploy, dispatch after owner GO).
Merged to main as part of `c9aa516` (together with TASK_225).

On-box evidence:
- BUILD_ID changed: `KKKGK3ukBt1_W_w793yJj` → `FzRmVYbdp4To16F2NjDaT`
- Route built: `.next/server/app/api/assistant/vantra/install-link/[id]/route.js` present
- `deleteInstallLink` present in compiled server chunks (lib_vantra-link chunk)
- Services: spaceworker.service active (fresh PID), vantra.service active
- Journal since restart: zero `-p err` entries (both services)
- Public https://spaceworker.top/ → 200
- Functional probes on localhost:3500: anon DELETE `[id]` → **401** `{"error":"unauthorized"}`;
  GET `[id]` → **405** (only DELETE exported); GET collection → 405 (POST-only)

Merged-tree gates run by verification agent (not copied from task agent):
tsc exit 0 · eslint exit 0 · full suite 1677 tests / 1676 pass / 0 fail / 1 pre-existing skip
(= 1663 base + 7 TASK_224 + 7 TASK_225, first combined run). CI push-run 39117651765 success.
