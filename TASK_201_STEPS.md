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

### PROGRESS 2026-10-10 ~09:40 — S0 committed; owner decision on send path
- S0 pushed: branch `mailer-exe` (off main b653bd5), plan + steps committed
  at cc587ee. No code.
- Owner answered the send-path question: **local send default; v1 local-only;
  server-proxy toggle deferred to v1.1** with one-time-code auth design kept
  in the plan. Recorded in TASK_201_MAILER_EXE.md "DECISION" section.
- NEXT: S1 — tauri.mailer.conf.json + build-exe.yml mailer arm; verify
  runtime-assemble emits BUILD_TARGET=mailer as the only env delta.

### PROGRESS 2026-10-10 ~09:55 — next-agent handoff prompt written
- `PROMPT_CONTINUE_TASK_201.md` committed on `mailer-exe`: systems map (VPS,
  vantra, QA battery, CI, probe patterns), BRANCHING DISCIPLINE section
  (never deploy VPS from mailer-exe; live-hotfix = checkout main → fix →
  deploy → return; merge main before CI/VPS work), commit conventions,
  exact S1 resume point (tauri.mailer.conf.json + build-exe.yml mailer
  arm, with verified facts), S2–S5 outline, parked threads (196/193/200b),
  definition of done.
- NEXT: S1 as described in PROMPT_CONTINUE_TASK_201.md §4.


### PROGRESS 2026-10-10 ~10:05 — S1 done: mailer build plumbing (no behavior change)
- `src-tauri/tauri.mailer.conf.json` created, mirroring the extractor conf
  shape exactly: `productName: "SpaceWorker OS - Mailer"`,
  `identifier: "com.spaceworker-os.mailer"`, bundle `{targets:["nsis"],
  createUpdaterArtifacts:false}`. PROOF: `diff` of the two confs with
  productName/identifier deleted = empty ("SHAPE: identical apart from
  productName/identifier"); JSON.parse OK.
- `.github/workflows/build-exe.yml`: added `- mailer` to the variant
  `options:` list; updated the stale comments (the resolve-step comment that
  claimed "extractor for both variants today" — now explains mailer passes
  through the else-branch as BUILD_TARGET=mailer with WRAPPER_MODE omitted —
  and the `args:` comment enumerating the per-variant confs). PROOF:
  `grep -n mailer` shows lines 19/62-65; `js-yaml` load = "YAML OK".
- runtime-assemble.mjs untouched (confirmed — `git diff --name-only` lists
  only the workflow; the script already writes
  `BUILD_TARGET=${process.env.BUILD_TARGET ?? "extractor"}` and omits
  WRAPPER_MODE when unset). Base window sizes inherited from tauri.conf.json:
  1280×860, min 1024×700 (lesson #5 satisfied).
- Gates: `npx tsc --noEmit` exit 0 (no TS touched — plumbing only).
- NO CI run yet (that's S4; per lesson #6/7 the authoritative build is CI,
  and the mailer conf must reach the dispatched ref —
  `gh workflow run build-exe.yml -f variant=mailer --ref mailer-exe`).
- NEXT: S2 — `app/api/exe/mailer/sources` (license-authed,
  isLocalExeRuntime() fail-closed, decrypted SMTP passwords via
  lib/mailbox-crypto.ts + templates + sending domains; unit tests with fake
  db). Open owner question before S3: UI trim scope (campaigns+mailboxes+
  templates only, or also recipients/leads import?).




### PROGRESS 2026-10-10 ~10:40 — S2 done: mailer sources pipeline (lib + both route halves + tests)
- Architecture forced by the runtime, not taste: the EXE has NO DATABASE_URL
  and NO MAILBOX_ENCRYPTION_KEY (runtime-assemble scrubs both), so query +
  decryption happen HOSTED and the EXE receives plaintext HTTPS — the
  owner-approved v1 tradeoff in TASK_201 (server-proxy toggle = v1.1).
- `lib/mailer-sources.ts`: payload + store split. `prismaMailerSourcesStore(db)`
  (query half, client injected) + `buildMailerSources(store, userId)` (shape
  half) + per-row builders. Payload built FIELD BY FIELD — never spread — so
  encryptedPassword/passwordIv/passwordTag and the DKIM private key can't
  ride along. Per-row decrypt failure = `password:""` + `passwordError`
  (actionable message from decryptSecretOrThrow), NOT a blanked list.
- Hosted `POST /api/exe-license/mailer-sources/route.ts`: session-less,
  three layers — (1) validateLicenseKey (HMAC+expiry+machine, failure surfaced
  verbatim like /activate), (2) ExeLicense row: user+product+key OR
  boundLicenseKey (unknown email ≡ no license = one DENIED body, no existence
  oracle), (3) row.boundMachineId must match requester machineId when set.
  New rate-limit kind `exe-mailer-sources` 60/hr.
- Local `GET /api/exe/mailer/sources/route.ts`: isLocalExeRuntime() 404
  fail-closed; 401 without activation; offline validateLicenseKey fail-CLOSED
  (secrets endpoint, unlike status's fail-open revocation poll); proxies via
  hostedFetch (maintenance-window retries) with product
  `${exeBuildTarget()}_exe` + machineId.
- Tests `tests/mailer-sources.test.ts` (6/6 pass): exact output key sets
  (mailbox/domain/template), ciphertext/private-key never serializes, domain
  query select whitelist, decrypt-failure isolation, per-query userId scoping
  + savedAsTemplate filter — all against a recording fake db (house §4
  require pattern; MAILBOX_ENCRYPTION_KEY set BEFORE require).
- Gates: tsc exit 0, eslint exit 0 on all 5 touched files, `npm run
  test:mailer-sources` 6/6. package.json script added.
- NEXT: S3 — Mailer EXE UI trim (open owner question: campaigns+mailboxes+
  templates only, or also recipients/leads import?). Then S4 CI dispatch
  (`gh workflow run build-exe.yml -f variant=mailer --ref mailer-exe`),
  S5 VPS stays untouched until hotfix rules apply.
