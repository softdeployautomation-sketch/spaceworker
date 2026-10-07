# PROMPT — NEXT VERIFICATION AGENT (TASK_181 device wrapper — VERIFY THE PRE-FLIGHTS + THE BUILD, then deploy-state)

TASK_180 is DONE-live and owner-confirmed ("now perfect on live as expected", 2026-10-07):
main pushed through `74bd6a0` + this session's later commits (record `git rev-parse HEAD`
at session start — do not trust this line). TASK_179 stage-2 VBS (retries + guide PDF +
share link) shipped with it and passed the owner's VM runs ("perfect now"). TASK_181 scope
is **binding**: `TASK_181_DEVICE_WRAPPER_EXE.md`; playbook **binding**:
`HOW_WE_MOVE_FAST.md` (§7 gates → §2/§3 deploy → §4/§6 live evidence). TASK_133 is the
owner's — never touch it. Never git stash; never edit `.env`; never build on the VPS.

MONEY + SECRETS HYGIENE: payment/grant code must live in its own commits, never mixed
with UI (`PLAN_TASK_158` §8, `PLAN_TASK_165` §5 rule 1) — check `git log` for violations.
REJECT any doc/test/log/commit containing live secrets (RMM `--auth` token, OpenFrame
initialKey/orgId/userId/machine-id) — placeholders ONLY.

Start: `spaceworker` main at the HEAD you record. The build under test was produced by
the P1–P4 phases of TASK_181 (verify what actually landed — do not assume all phases
shipped; if a phase is missing, that is the report).

## 1. P0 PRE-FLIGHTS (the dependency verdict — verify these first)

1. **0c grant fix:** live grant of $X on a disposable user → balance **+X**, ledger row
   `admin_grant` with note, **JSON error shape** (a forced failure must NOT return HTML),
   unit test for null-adminId present. (Root cause in `SENIOR_HANDOFF.md` §7 row 0c.)
2. **W5 live-confirm:** one real `POST /api/wallet/spend` → debit + ledger + terms
   granted, recorded with raw output. If TASK_181 built XDevice spend on top of W5, this
   evidence MUST predate it.

## 2. THE FEATURE (run TASK_181 §6 acceptance yourself — curl/CLI, not vibes)

1. **Menu (option B, confirmed):** wrapper shows ONLY Devices + Settings; direct GETs to
   `/dashboard/extract`, `/dashboard/campaigns`, etc. inside wrapper mode are
   404/redirect — hidden links alone = FAIL. **No Panic button** in wrapper mode;
   branding = window "SpaceWorker OS", dock label "Devices".
2. **Wording:** zero public/private vocabulary in the wrapper (grep the SHIPPED chunks for
   `Public device`, `private agent`, `silently move` — any hit = FAIL). Web app keeps its
   wording untouched.
3. **Methods:** wrapper dropdown = `.vbs` file, `EXE link`, `macOS (coming soon)` ONLY;
   zip + PowerShell present and working in the web app (unchanged).
4. **Free matrix:** fresh tier-1 account → Devices tab opens, mints a VBS file AND a VBS
   share link (rename honored), device enrolls on a VM; **tool route returns 403
   `xdevice_required`** (actual curl with the free session) and the UI shows the lock.
5. **Premium XDevice:** tier 3 → `hasEntitlement` = `devices` ONLY (not the tier-5
   catch-all); tools unlock; `canUseDeviceTools`-style gate passes for 3/5/10, fails ≤1.
6. **Payment rails (both):** checkout → submit → admin approve grants tier 3; wallet
   balance spend on the xdevice product grants tier 3 with correct ledger rows. Double-
   mint guard: one approval/debit ⇒ exactly one grant. **Price shows $500 default and
   reads from the admin-adjustable store — change it in admin → new number appears
   without redeploy; grep for a hardcoded 500 (= FAIL).**
7. **Support + Settings:** ticket open + reply from the wrapper works; Settings shows
   only user-concerning sections; Wallet chip + Sign out present.
8. **Flag OFF regression:** without wrapper mode, the web app is unchanged — full dock,
   all five methods, private tier mint still entitlement-gated (diff/chunk evidence).

## 3. REGRESSIONS (re-run yourself)

- `npx tsc --noEmit` → 0; ESLint clean on every touched file.
- `npm run test:vantra`, `test:vantra-carrier`, `test:openframe` + any new
  wrapper/wallet/support suites — or the subset the feature touched + an explicit
  untouched claim for the rest.
- **Migrations: expected NONE** (tier 3 needs no migration) — flag ANY new migration as
  unexpected and verify it is additive + replayed.
- `git log` commit separation (money vs UI) + secrets grep clean.

## 4. DEPLOY-STATE (confirm with evidence, don't redo)

- Fresh `BUILD_ID`, `systemctl is-active spaceworker.service`, `prisma migrate status` →
  up to date (if a migration shipped: ledger row, additive, `rolled_back_at` NULL).
- §6 probes: server `.map` contains the gate string (`xdevice_required`); client chunk
  contains `Premium XDevice`; wrapper-mode string present. §4 probes: route status codes
  (401 unauth / 404 unknown / 200 known) per playbook.

## 5. HANDOFF + REPORT

- Update `SENIOR_HANDOFF.md` (§6 state, §7 queue, §9 append-only log), check off
  `TASK_181_DEVICE_WRAPPER_EXE.md` §8, commit explicitly with `git commit -F`, push.
- Report: PASS/FAIL table over §1 + §2 (per step), regression output, deploy-state
  evidence (BUILD_ID, run id, probes), and an **openly unverified list** (e.g. Windows VM
  run if you could not run one) + next queued row.
