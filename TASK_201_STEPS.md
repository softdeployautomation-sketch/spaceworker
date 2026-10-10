# TASK_201 STEPS — Standalone Mailer EXE (compaction-proof record)

Playbook: HOW_WE_MOVE_FAST.md. Smallest slice → test → gates → commit+push.
Commit messages via editor-written /tmp files + `git commit -F`.
Never commit TASK_133_RMM_ENGINE_BRINGUP.md.

## BEFORE record — 2026-10-10 09:27 (plan committed on branch `mailer-exe`)
- HEAD at start: b653bd5 (main) — TASK_200 S2a tab-wrap deployed.
- Working tree clean (except the never-committed TASK_133 file).
- Ground truth verified before writing the plan (all greps real):
  * `lib/exe-build-target.ts`: EXE_BUILD_TARGETS already includes "mailer".
  * exe-license routes derive product `${exeBuildTarget()}_exe` → mailer_exe
    licenses are already a working product value (no schema change).
  * `scripts/runtime-assemble.mjs` already writes BUILD_TARGET (default
    extractor) and only writes WRAPPER_MODE when set.
  * `src-tauri/`: tauri.conf.json + tauri.devices.conf.json +
    tauri.extractor.conf.json exist; devices conf differs only in identifier.
  * `.github/workflows/build-exe.yml`: variant switch handles `devices` only.
  * `isLocalExeRuntime()` is the uniform fail-closed gate for /api/exe/*.
  * Mailer web stack: lib/mailer-send.ts (nodemailer + SOCKS5 exit nodes),
    campaign-mailboxes, mailbox-crypto, sending-domains, campaigns/mailboxes
    dashboard pages.
  * selfhost precedent branch: `self-hosted-build`.
- External research (fetched 2026-10-10): Gammadyne Mailer = local desktop
  SMTP engine, user's own mail servers, manual config, no cloud; X Mailer =
  local-first, user re-enters accounts per install, proxy/account rotation.
  Both start EMPTY on fresh install; our EXE must instead pull the user's
  sources dynamically post-activation (owner requirement).
- Plan doc: TASK_201_MAILER_EXE.md (architecture + slice plan + the 3 open
  questions). No code written yet — S0 is docs + branch only.

## PROGRESS
