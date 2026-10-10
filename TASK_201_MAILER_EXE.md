# TASK_201 — Standalone Mailer EXE (campaign + mailbox, "different exe trim")

## Goal
A third Tauri EXE variant — `mailer` — following the SAME flow as the Extractor
EXE (and the devices wrapper): runtime-assemble → Tauri NSIS installer → CI
(`build-exe.yml -f variant=mailer`) → verified artifact. Must not repeat the
EXE-build mistakes already burned once (all codified in
`EXE_BUILD_LESSONS_LEARNED.md` — read it fully before the first slice).

## Ground truth (verified 2026-10-10, HEAD b653bd5)
- `lib/exe-build-target.ts` already lists **`"mailer"`** as a legal
  `BUILD_TARGET` (`extractor | mailer | combined | automation`).
- License stack is already generic: `app/api/exe-license/*` derives
  `product: ${exeBuildTarget()}_exe` → a **`mailer_exe`** license product works
  with zero schema change (activate/password-login/trial/status/claim/auto-bind).
- `scripts/runtime-assemble.mjs` already parameterizes `BUILD_TARGET` (defaults
  extractor) and only writes `WRAPPER_MODE` when set ⇒ a mailer build is
  `BUILD_TARGET=mailer` and the assembled `.env.local` differs by exactly one
  line — same scrub/strip/fail-closed guards apply automatically.
- `src-tauri/` has per-variant confs (`tauri.devices.conf.json`,
  `tauri.extractor.conf.json`); devices conf renames `identifier` only.
  Need `tauri.mailer.conf.json`.
- `.github/workflows/build-exe.yml` variant switch today only handles
  `devices`; needs a `mailer` arm (`build_target=mailer`, no WRAPPER_MODE).
- EXE runtime gating is uniform: `isLocalExeRuntime()` fail-closed (404 on
  hosted web) — every new `/api/exe/mailer/*` route must use it.
- Mailer web stack to expose in the EXE: `lib/mailer-send.ts` (nodemailer +
  SOCKS5 exit-nodes), `lib/campaign-mailboxes.ts`, `lib/mailbox-crypto.ts`
  (server-encrypted SMTP passwords), `lib/sending-domains.ts`,
  `app/dashboard/campaigns/*`, `app/dashboard/mailboxes/*`.
- Precedent for a separate branch: `self-hosted-build` (sw selfhost) → this
  task works on branch **`mailer-exe`**.

## External research (how existing custom desktop mailers work)
- **Gammadyne Mailer** (win32 desktop, one-time fee, since 1999): pure
  self-hosted — local SMTP engine sends from the user's OWN mail servers,
  configured manually in-app. No monthly service, no phone-home. Per-destination-
  domain throttling, multi-thread, load-balance across multiple SMTP servers,
  direct delivery optional.
- **X Mailer** ($69 one-time): Windows app, **local-first data** (lists/logs
  stay on the user's PC). User manually adds SMTP accounts + SOCKS5 proxies;
  rotates accounts AND proxies per send; activation transferable; nothing synced
  from a cloud — every fresh install starts empty and the user re-enters
  everything.
- **Common pattern:** desktop control panel + user-owned SMTP accounts stored

## Proposed architecture (decision pending — see Open questions)
Variant = extractor pattern with three deltas:
1. `BUILD_TARGET=mailer` env cut; `tauri.mailer.conf.json` (own identifier
   `com.spaceworker-os.mailer`, own productName "SpaceWorker Mailer", window
   size ≥1024×700 to dodge lesson #5); CI `mailer` arm in build-exe.yml.
2. UI trim: the EXE boots straight into the mailer app surface — Campaigns,
   Mailboxes (sources), Templates — not the full dashboard (the web decides
   trimming via `BUILD_TARGET`; devices variant already uses this pattern with
   WRAPPER_MODE).
3. **Dynamic sources:** new `app/api/exe/mailer/sources` route (gated
   `isLocalExeRuntime()`, auth = the user's license session) returning the
   user's mailbox accounts (host/port/user/sender-aliases; passwords handled
   per the send-path decision below) + sending domains + templates, so a fresh
   install is populated the moment the license activates.

### Send-path options
- **A. Server-proxied (recommended default):** the EXE is a control panel;
  the actual SMTP send POSTs to the hosted server, which sends through the
  existing `mailer-send.ts` pipeline (incl. premium exit-node regions).
  Passwords never leave the server. Same deliverability stack as the web.
- **B. Local send (Gammadyne-style):** EXE holds the user's decrypted SMTP
  creds locally and sends from the user's own machine/IP. No server round-trip
  per mail; matches competitor tools; but credentials must be exported
  decrypted (or export-key'd) to the endpoint.
- **C. Hybrid:** server-proxied by default, local-send toggle for power users.

## Slice plan (each slice = test → gates → commit+push)
- S0: branch `mailer-exe` + this plan + steps (BEFORE record) — commit.
- S1: CI + build plumbing: `tauri.mailer.conf.json`, build-exe.yml `mailer`
  arm, runtime-assemble untouched (already generic) — verify `.env.local`
  diff is exactly `BUILD_TARGET=mailer` vs extractor cut.
- S2: server: `/api/exe/mailer/sources` (+ license auth), returns
  sources/domains/templates; unit tests with fake db.
- S3: UI trim for BUILD_TARGET=mailer (campaigns/mailboxes/templates surface);
  static tests.
- S4: CI `variant=mailer` build → download artifact → **unpack and verify per
  lessons checklist** (`.env` scrubbed, 0 `.ts` files, placeholder-secret
  guard, node runtime guard, real launch on a Windows box).
- S5: live trial: owner installs on a VM → activation → sources appear →
  test send → deliver → closeout.

## Rules for this build (from EXE_BUILD_LESSONS_LEARNED.md, non-negotiable)
1. Reuse `scripts/runtime-assemble.mjs` — never rewrite the scrub logic.

## DECISION (owner, 2026-10-10, recorded before S1)
**Send path = local-first hybrid, v1 = LOCAL SEND ONLY.**
- Default and only active send path in v1: the EXE sends locally from the
  user's own machine/IP via its bundled nodemailer engine (reuses
  `lib/mailer-send.ts`'s `transporterForMailbox` transport-building;
  no exit-node proxying locally — the user's own connection is the point).
- Sources are pulled dynamically post-activation (`/api/exe/mailer/sources`,
  license-authed) WITH the decrypted SMTP passwords the local engine needs —
  security tradeoff accepted: user's own credentials, user's own machine,
  same as X Mailer storing them locally.
- v1.1 (deferred, design kept): Settings toggle "Send via SpaceWorker
  server" — server-proxied sends authenticate with a **one-time code**
  rendered in a box beside the toggle (redeemed server-side for a scoped,
  short-lived send token); powers the premium exit-node regions.
- Owner's scope rule honored: server-proxy was flagged as possibly "too
  broad" for v1 → v1 ships local-alone, toggle UI present but disabled
  ("Send via server — coming soon").

2. Tauri entry: `.run(...)`, not `.build(...)`.
3. Resource lookup probes candidate paths incl. `_up_/`.
4. Bundle FULL Windows node dir; build-guard runs `node --version`.
5. Verify the ACTUAL artifact (7z + grep) after every customer-facing build.
6. Before CI trigger: `git status` + `origin/main..HEAD` empty check.
7. Authoritative build = CI, not local macOS next build.
8. Deliver via existing download infra, verify SHA-256 across hops.
  locally + rotation/throttling + one-time license.
- **Our deviation (owner requirement):** the user's SMTP "sources" already
  exist on SpaceWorker (encrypted at rest). A fresh mailer-EXE install must
  **not** start empty — after activation it pulls the user's sources
  dynamically from the hosted account ("each user gets their dynamic source"),
  so it works immediately on install. That is the one thing Gammadyne/X Mailer
  users never get.

## Open questions for the owner
1. Send path: A (server-proxied, recommended), B (local send), or C (hybrid)?
2. Which surfaces ship in the mailer trim: campaigns+mailboxes+templates only,
   or also recipients/leads import?
3. Activation: same password/trial flow as extractor (`mailer_exe` product)?
