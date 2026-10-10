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

### PROGRESS 2026-10-10 ~11:20 — S3 done: mailer UI trim (owner directives, no new tabs)
- Owner (2026-10-10, three messages): campaign + mailbox tabs EXACTLY as web,
  minus the extractor link; recipients = CSV upload or type/paste only (no
  "pull from leads"); test email unchanged; menu = Campaigns + Settings only,
  no Support/Agent — "a standalone, following the steps of the standalone
  extractor", and STOP asking anything that links the EXE to the webapp.
- `components/dashboard-nav.tsx`: `BUILD_ALLOWED_HREFS.mailer =
  {"/dashboard/campaigns", "/dashboard/settings"}`. Campaigns covers the
  mailboxes sub-tab (startsWith on ?tab=mailboxes). Overview deliberately
  excluded (owner named exactly two entries; its stats are DB-backed and the
  EXE has no DATABASE_URL). Support/Agent/Wallet/Logout needed NO change —
  shell.tsx already renders none of them when buildTarget is set. Health QA
  tab unaffected (admin panel, own chrome).
- `app/dashboard/campaigns/page.tsx`: `useBuildTarget()` → isMailerBuild.
  (1) ?fromSearchJob deep link (the Extract page's "Create campaign from
  these leads") resolves to null in mailer builds — web unchanged; (2)
  "Pick from my leads" source button filtered out + chooseSource() guard so
  /api/leads/selectable can never be fetched from the EXE (401/DB there);
  (3) recipient-source description text drops the leads phrase. CSV upload
  (.csv,text/csv — unchanged, no txt claim) and type/paste untouched; test
  email (manualInsert / testRecipientOverride) untouched; server payload
  shape untouched.
- Gates: tsc exit 0; eslint on both files = only the 2 pre-existing
  react-hooks/set-state-in-effect errors at 299/309 (PROOF: identical on
  stashed HEAD) — zero new issues; no test pins these surfaces.
- NEXT: S4 — CI dispatch for the mailer variant
  (`gh workflow run build-exe.yml -f variant=mailer --ref mailer-exe`),
  verify artifact naming/shape, then S5 QA battery (Health tab + CLI) and
  the parked threads (TASK_196 watcher, TASK_193, TASK_200b auto-run).

### PROGRESS 2026-10-10 ~11:45 — S4 done: CI build + artifact verification (PASS; 3 hygiene findings)
- Dispatch `gh workflow run build-exe.yml -f variant=mailer --ref mailer-exe` →
  run 38044370678, windows-latest, ~12min, ALL GREEN. "Resolve variant env"
  passed BUILD_TARGET=mailer (else-branch passthrough); "Render devices VBS
  carrier" correctly `skipped` (if: variant==devices); artifact
  `spaceworker-mailer-windows` = 40,292,928b.
- Downloaded + 7z-unpacked `SpaceWorker OS - Mailer_0.1.0_x64-setup.exe`
  → 6,632 files / 222MB. Runtime .env.local = EXACTLY the intended minimal set
  (SPACEWORKER_LOCAL_EXE / BUILD_TARGET=mailer / EXE_LICENSE_SECRET /
  NEXT_TELEMETRY_DISABLED). bundled node.exe = PE32+ x64 Windows, 71MB. Tauri
  shell spaceworker-exe.exe present.
- Secret scan (real values from repo .env, classified): DATABASE_URL 0 hits,
  SESSION_SECRET 0, INTERNAL_BEARER_TOKEN 0, MAILBOX_ENCRYPTION_KEY 0 — the
  4 true secrets do NOT ship. BUILD_TARGET stamped = mailer ✓.
- Findings (NOT blockers for the owner's VM trial — none are runtime secrets;
  fix in a S4b hygiene pass before any customer download):
  1. scripts/runtime-assemble.mjs ships in the tree (contains only the PLACEHOLDER
     string `dev_exe_license_secret_for_local_testing_only`, not the real secret).
     Fix: stripSourceFiles should also drop `scripts/` + `*.mjs` config.
  2. Real RESEND_API_KEY value inlined into 1 server chunk
     (lib_email_ts… — lib/email.ts imports `env` from lib/env.ts whose object
     literal the bundler inlines). Fix: read Resend key lazily at call time.
  3. 190 internal .md docs ship (29 contain CF account id / internal host /
     VPS IP — HOW_WE_MOVE_FAST, PLAN_*, TASK_*, HANDOFF). Fix: exclude *.md
     from the runtime copy.
- EMAIL_FROM (noreply@spaceworker.app) in 4 files = the public privacy page
  contact address (intended); APP_BASE_URL (http://localhost:3400) = harmless
  build-time default in chunks + .md. Neither is a secret.
- NEXT: S6 template fix (owner directive) — "Save as template" disabled
  because `c.variants?.length===0` on the list row (real campaigns keep
  subject/body, not variants); EXE template flow must be PERSONAL (save →
  user's own saved templates in campaign creation), NOT the web's
  user+admin+general flow. Then S5 owner VM trial, then S4b hygiene.
### PROGRESS 2026-10-10 ~13:30 — S6 done: dead "Save as template" button fixed (WEB bug, owner-confirmed)
- Owner clarification after compaction: the unclickable button was observed on
  the **web app**, not the EXE; there is no working mailer-EXE campaign flow
  yet. Next after this = S5 EXE campaign test (create a campaign on the exe).
- ROOT CAUSE (verified, not guessed): since Task 29 every campaign created
  from the web form is DECOUPLED — createCampaign stores content in
  `EmailCampaign.subjects[]/bodies[]` and creates ZERO CampaignVariant rows
  (lib/campaign-create.ts:189-191; schema:687-688). Three inlined
  variants-only checks in app/dashboard/campaigns/page.tsx were therefore
  false for every real campaign: (1) row button `disabled` — permanently
  unclickable; (2) "My templates" optgroup filter — saved decoupled campaigns
  never listed; (3) applyTemplate own-campaign branch — picking one loaded
  nothing. Server side verified CORRECT (GET returns full rows incl.
  subjects/bodies; PATCH savedAsTemplate handles the flag) — zero API change.
- FIX: new pure `lib/campaign-template-content.ts` — `campaignTemplateContent()`
  (decoupled columns first, legacy variant rows fallback, trimmed + empties
  dropped) and `hasTemplateContent()` (both a subject AND a body present).
  Page now reads content only via the helper in all 3 spots; Campaign type
  gains subjects/bodies; "My templates" label shows "N subjects".
- Tests: `tests/campaign-template-content.test.ts` (8 cases: decoupled-only,
  legacy-only, empty, nullish fields, whitespace drop, null variant fields,
  decoupled-wins precedence, one-sided lists) — 8/8 pass; new
  `test:tmplcontent` script. Gates: tsc exit 0; eslint = only the 2
  pre-existing set-state-in-effect errors (count unchanged vs stashed HEAD,
  line numbers shifted by added lines); test:message/mailboxes/merge all 0 fail.
- Adjacent threads recorded (NOT in this slice): (a) automations builder's
  "My campaigns" picker is a different mechanism (server-side variant clone)
  — decoupled support there is its own thread; (b) creating a campaign inside
  the mailer EXE will 401 today — /api/campaigns is session+DB and the local
  runtime has neither (no DB by design); S5's exe campaign test needs the
  local-first storage decision (ties into the owner's "templates must be
  personal in the exe" directive).
- Committed on mailer-exe; web deploy rides the normal main merge — NEVER
  deployed from this branch (branching discipline).
- NEXT: S5 — install the mailer build, try creating a campaign on the EXE
  (expect the no-DB wall → design local campaign/template storage), then S4b
  hygiene pass.

## S7c — Turbopack hashed-external shim + SMTP guard mapped-IPv6 fix (2026-01-10, second half)
- SYMPTOM (run 38052488430 artifact): build GREEN, but the unpacked standalone
  server died at boot — "Failed to load external module
  @electric-sql/pglite-7966c14983af6418: Cannot find module". Also would have
  hit bcrypt-a3fecf8c027c10c9 / @prisma/client-2c3a283f134fdcb6 at request time.
- ROOT CAUSE (traced from the artifact, not guessed): Turbopack compiles every
  serverExternalPackages require into a HASHED ALIAS "pkg-<16hex>" and Node
  must find a directory of that exact name (the .nft.json traces literally
  reference `node_modules/bcrypt-a3fecf8c027c10c9`). The CI Windows standalone
  build never materializes those alias dirs. The REAL packages all ship fine
  in standalone/node_modules (incl. 21MB @electric-sql/pglite wasm payload,
  query_engine-windows.dll.node, db/schema.sql, .env.local with
  BUILD_TARGET=mailer) — only the aliases are missing.
- FIX: new `lib/turbopack-external-alias.ts` — installs a
  Module._resolveFilename fallback (same technique as Next's own
  require-hook.js): a failed request ending in `-[0-9a-f]{16}` is retried with
  the suffix stripped. Idempotent; collision-free (npm forbids a final
  16-hex segment); inert on hosted (fallback never fires). Installed FIRST in
  instrumentation.ts register() via dynamic import under NEXT_RUNTIME==="nodejs".
- SECOND BUG found during the same artifact's live round-trip: saving a
  mailbox with host smtp.hostinger.com was rejected — the resolver returned
  `::ffff:172.65.255.143` (IPv4-MAPPED IPv6, even for a family:4 lookup) and
  v6IsNonRoutable read "ffff" as ff00::/8 multicast → EVERY mapped address
  blocked. Real-user impact on any resolver that behaves this way (macOS /
  Windows getaddrinfo). FIX: `v4FromMappedV6()` — mapped answers are judged by
  the embedded IPv4 via v4IsNonRoutable (mapped loopback/RFC1918 still
  blocked). Regression test with stub DNS covering public/mapped-loopback/
  mapped-private.
- PROOF (mimic = the real artifact booted on macOS with the shim preloaded and
  the repo's darwin prisma engine swapped in for the windows one):
  "[local-exe] database ready; auto-drain loop started", then live HTTP:
  drain-settings GET {"autoDrain":true,"intervalSeconds":60} → mailbox create
  (id returned) → campaign create via csv (recipientCount 2) → PATCH
  savedAsTemplate true → GET shows flag + subjects → list shows the template.
  Full standalone replica loop proven BEFORE spending CI minutes.
- Tests: `test:tb-alias` 5/5 (alias resolves to real pkg incl. scoped;
  unresolvable alias still throws; non-alias misses untouched; idempotent);
  smtp-host-guard 11/11 (incl. new mapped-v6 case); local-exe 9/9;
  tmplcontent 8/8. tsc 0; eslint 0 on touched files.
- NEXT: CI mailer build → verify new artifact boots WITHOUT the preload shim →
  hand installer to owner for Windows S5 test (campaign + save-template +
  drain settings).


