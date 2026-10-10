# PROMPT — CONTINUE TASK_201 (Standalone Mailer EXE) — read fully before touching anything

You are continuing as the senior engineer for the SpaceWorker ecosystem. This
prompt is the complete handoff. Context compaction WILL happen — the steps
files are the only memory that survives, so keep them updated relentlessly.

## 0. MANDATORY read order before touching code
1. `HOW_WE_MOVE_FAST.md` — word-for-word law. Smallest slice → test → gates
   (tsc --noEmit 0 errors, eslint no-new, targeted tests green) → commit+push
   per slice. Never claim what you didn't prove.
2. `TASK_201_MAILER_EXE.md` — the plan (ground truth, research, slice plan,
   the owner's DECISION section).
3. `TASK_201_STEPS.md` — the compaction-proof record (BEFORE record +
   PROGRESS entries; keep appending after EVERY meaningful action with the
   proof: command output, status codes, test counts).
4. `EXE_BUILD_LESSONS_LEARNED.md` — the 8 non-negotiable rules for this
   exact build (its final checklist section was written FOR this task).
5. The code files named per slice.

## 1. Commit discipline (non-negotiable)
- Commit messages: write `/tmp/<name>-msg.txt` with the **editor tool**, then
  `git commit -F /tmp/<name>-msg.txt`. NEVER a shell heredoc (mangles).
- NEVER commit `TASK_133_RMM_ENGINE_BRINGUP.md` (untracked forever).
- No stashes. No `.env` edits. Don't fix the 42 pre-existing eslint errors in
  the admin panel (that count is the verified baseline; just don't add new).
- Commit + push every slice so compaction can never eat work.

## 2. BRANCHING DISCIPLINE (owner's explicit concern — read twice)
- `main` = what the LIVE VPS runs. We are working on **`mailer-exe`**
  (created 2026-10-10 off main b653bd5; HEAD f7bb9f2 at prompt-write time).
- **The VPS deploys from the LOCAL working tree via rsync — whatever branch
  is checked out. Deploying while on `mailer-exe` would ship half-built
  mailer-exe code to production. NEVER deploy the VPS from this branch.**
- Live-hotfix protocol (a prod bug always beats the current task):
  1. If the working tree is dirty: finish/commit the current slice on
     `mailer-exe` first (or park it as a WIP commit — never stash).
  2. `git checkout main && git pull`.
  3. Fix → gates → commit with editor-written msg → push.
  4. Deploy + verify (see §4) + record in the relevant task's steps file.
  5. `git checkout mailer-exe` and resume. Record the whole branch dance in
     the steps file both ways.
- Anti-drift: `mailer-exe` must periodically merge/rebase `main` (EXE lesson
  #11 — deployment drift is real and silent). At minimum merge main before
  any CI build (S4) and before any VPS-touching work.
- CI (`build-exe.yml`) builds the REF you dispatch on. While `mailer-exe`
  is unmerged, trigger with `gh workflow run build-exe.yml -f variant=mailer
  --ref mailer-exe` (or the GH UI branch selector). Only after the mailer
  conf reaches main can main builds use variant=mailer.

## 3. Systems map (all verified 2026-10-10)
- **spaceworker** repo: `/Users/mikeolab/spaceworker` (this repo).
- **VPS**: `ssh -i ~/.ssh/tacticalrmm_vps root@164.68.105.96`; app at
  `/opt/spaceworker` running as user `trmm` (`spaceworker.service`); listens
  on **:3500** even though `.env` says 3400 (known quirk — curl :3500).
  Deploys = rsync specific dirs (app lib components prisma tests scripts,
  never blanket), `chown -R trmm:trmm /opt/spaceworker/.next` after any
  root-side touch (root-owned leftovers break builds), build via nohup on
  the box (`npx next build` ~2.5-4 min, check BUILD_EXIT), restart, curl 200.
- **Vantra** repo: `/Users/mikeolab/vantra`, deploys to `/opt/vantra`
  (same VPS, own systemd unit `vantra.service`). Separate git repo, own
  HOW_WE_MOVE_FAST.md.
- **QA Health Battery**: admin panel → Health tab, or on the box
  `sudo -u trmm -H bash -c 'cd /opt/spaceworker && set -a && . ./.env &&
  set +a && npx tsx scripts/qa-battery.ts'` — run after every deploy;
  exit 0 = nothing FAILing. (Known cosmetic: ledger stale-rows WARN,
  vantra probe SKIP when VANTRA_URL unset.)
- **Live probes**: mint a real admin cookie ON THE BOX with
  `createAdminSessionToken()` from `lib/admin-auth.ts` (never print secrets);
  user JWTs via `lib/session-user.ts` helpers. Always delete probe scripts
  from the box afterwards.
- **EXE CI**: `.github/workflows/build-exe.yml` (manual dispatch only),
  Windows runner, tauri-action with `--config src-tauri/tauri.<variant>.conf.json`,
  EXE_LICENSE_SECRET + build env from GH secrets. Artifact downloadable via
  `gh run download`.


## 4. Where TASK_201 stands (resume exactly here)
S0 DONE (cc587ee + f7bb9f2): branch `mailer-exe`, plan, steps BEFORE record,
owner decision recorded — **v1 ships LOCAL SEND ONLY** (Gammadyne-style:
the EXE sends from the user's own machine/IP via bundled nodemailer; sources
pulled dynamically post-activation with decrypted passwords; "send via
SpaceWorker server" toggle = v1.1, one-time-code auth, UI present but
disabled). **No code written yet.**

### S1 (next, plumbing only — no behavior change):
1. Create `src-tauri/tauri.mailer.conf.json` mirroring the extractor conf
   exactly in shape (verified content: `"$schema"`, `bundle: {targets:
   ["nsis"], createUpdaterArtifacts: false}`); set
   `productName: "SpaceWorker OS - Mailer"` (extractor precedent:
   "SpaceWorker OS - Lead Extractor") and
   `identifier: "com.spaceworker-os.mailer"`.
2. `.github/workflows/build-exe.yml`: add `- mailer` to the variant
   `options:` list. The resolve step's else-branch ALREADY passes non-devices
   variants through as `build_target` (verified) — so variant=mailer
   correctly produces BUILD_TARGET=mailer with WRAPPER_MODE omitted. Update
   the stale comment above that step (it claims "extractor for both variants
   today").
3. Verify (no CI run yet — that's S4): JSON validity of the new conf;
   `grep` the workflow shows mailer; runtime-assemble untouched (already
   generic — `BUILD_TARGET=${process.env.BUILD_TARGET ?? "extractor"}`).
   Base window is 1280×860, min 1024×700 (lesson #5 satisfied).
4. Record in steps + commit + push.

### Then: S2 = `/api/exe/mailer/sources` (license-authed, isLocalExeRuntime()
fail-closed, returns the user's mailboxes with decrypted passwords via
`lib/mailbox-crypto.ts` + templates + sending domains; unit tests with fake
db). S3 = UI trim for BUILD_TARGET=mailer (Campaigns/Mailboxes/Templates
surface; look at how `components/shell.tsx` uses buildTarget and how the
devices wrapper trims). S4 = CI `variant=mailer` build → download artifact →
**unpack with 7z and verify per the lessons checklist** (0 .ts files, no
secret values, no placeholder secret, node runtime runs). S5 = owner's VM
trial → closeout.

### Still-open owner question (ask before S3): UI trim scope —
campaigns+mailboxes+templates only, or also recipients/leads import?

## 5. Other open threads (parked — do NOT do these before TASK_201 unless
the owner says so; recorded so you know the landscape)
- **TASK_196**: tier-3 "remote control disconnect" — investigated (4 probes,
  tiers proven identical; mesh-checkin divergence suspected; 24h watcher
  long expired). Awaiting the owner's VM test.
- **TASK_200 S2b**: 15-min auto-run battery history + scrollable record in
  the Health panel — planned, not started.
- **TASK_193**: login referral gate — plan only, blocked on owner's answers.
- **TASK_194 leftovers**: wrapper EXE rebuild (S2 download fix) was built via
  CI run 37944157341 and delivered to the owner's Desktop.

## 6. Definition of done for TASK_201
Owner installs the mailer EXE on a Windows VM → activates (license flow,
product `mailer_exe` — already a legal product, zero schema change) → their
sources appear automatically → imports a CSV → sends a real campaign locally
→ mail delivers → QA battery still green on the web app → closeout entry in
`TASK_201_STEPS.md` with all proof + the branch-merge back to main recorded.