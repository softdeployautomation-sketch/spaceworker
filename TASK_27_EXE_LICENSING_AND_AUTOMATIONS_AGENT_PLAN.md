# Task 27 — Licensed EXE distribution + Automations tab (manual builder + AI agent)

**Status: architecture decided 2026-09-12, ready to implement in sequence.** Every open question in both Parts (the 4-EXE local-runtime design, the licensing gate, the Channelry AI contract, Part B's always-test-send-confirm behavior) has been resolved by the owner directly — see "Decisions made 2026-09-12" in Part A and the reconciled Part B below. What's still gating is **Task 26's manual tools being fully verified**, specifically a real confirmed end-to-end mailer send (see "Where this stands against the dependency ordering" in Part B) — not a lack of a plan. Two genuinely separate workstreams are covered here (Part A: EXE + licensing, Part B: Automations tab), tied together only by both depending on Task 26 being done and both landing on the same dashboard. Written 2026-09-12, grounded in the actual current code: the standalone Lead Extractor's real, working license system (`app/license/{generator,machine_id,validator}.py`), SpaceWorker's existing `Payment`/admin-review infrastructure (`prisma/schema.prisma`'s `Payment` model, `app/admin/`, `app/api/admin/payments/`), the current landing page (`app/page.tsx`), and the Piece 6 `Automations` placeholder (`app/dashboard/automations/page.tsx`).

**Updated 2026-09-12, same day, with the user's follow-up clarification on both parts** — see the "4 separate EXEs" note in Part A and the Task 09 reconciliation folded into Part B below. Both updates are additive to the original text above; nothing already-written was found to be wrong, only underspecified.

---

# Part A — Licensed EXE distribution ("buy tools" flow)

## The ask, as given

A visitor to the marketing landing page shouldn't have to sign up for the web SaaS to use SpaceWorker's tools — they should be able to **buy** a tool as a downloadable EXE directly from the landing page, no account required first. The EXE runs unlicensed for one day, then requires an activation key to keep working. License purchase happens inside that same "buy tools" flow. The existing web signup/subscription path stays exactly as it is — this is an *additional* entry point ("go to the store to get tools"), not a replacement.

## Confirmed: you've already built and shipped this exact mechanism once

`~/lead-extractor/app/license/` is a real, working, HMAC-signed license system, already used for "Lead Extractor Pro" (per this session's own memory: sold on Selar, hardware-bound licenses already issued to real customers). Reusing its actual design is the right call, not reinventing licensing from scratch:

- **`generator.py`**: `generate_license_key(secret, licensee_name, machine_id/machine_ids, plan, days_valid)` — builds a JSON payload (`licensee`, `plan`, `issued_at`, `expires_at`, optional `machine_id`/`machine_ids`), base64-encodes it, HMAC-SHA256-signs it with a server-only secret, and ships the key as `payload_b64.signature`. No server round-trip needed to *validate* a key later — it's fully self-contained.
- **`machine_id.py`**: `get_machine_id()` derives a stable 16-char hex ID from real hardware identifiers (Windows: system UUID via `wmic`/PowerShell + disk serial; macOS: `IOPlatformUUID` via `ioreg`; Linux: `/etc/machine-id`) — falls back to a weaker processor/MAC/hostname hash only when no stable ID is available (VMs/sandboxes).
- **`validator.py`**: `validate_license(key, secret)` re-derives the HMAC over the payload, rejects on mismatch (`hmac.compare_digest`, timing-safe), checks `expires_at` against `datetime.utcnow()`, and — if the payload carries `machine_id`/`machine_ids` — checks the CURRENT machine's `get_machine_id()` against it. All of this runs **fully offline inside the EXE** once the key is issued; only *issuing* a key needs the server (and the signing secret must never leave the server/never ship inside the EXE).

**What's genuinely new here, not in the existing system**: the standalone requires activation immediately (no free window) — SpaceWorker's ask adds a **1-day unlicensed trial** before the gate kicks in. This needs its own small addition: on first launch, write a local trial-start timestamp (same tier of tamper-resistance as the rest of this scheme — a determined user could reset it by editing a file, which is an accepted, known limitation of client-side-only licensing, not something to over-engineer around); the app runs normally until `now - trial_start > 24h`, then requires a valid key exactly like the standalone always has.

## DECIDED 2026-09-12 — full local reimplementation, reusing the actual dashboard UI

The wrapper-vs-native fork above is now resolved by the user directly, unambiguously in favor of **option 2, full local reimplementation** — confirmed in the user's own words: *"data storage is local for exe... the mailer just uses the ui of our spaceworker same with the lead extractor, i want the current ui also."* Two things pinned down at once: (1) each EXE stores its own data locally (no dependency on the shared Postgres/VPS for its core function), and (2) the UI is **the actual current SpaceWorker Next.js dashboard** (Extract, Mailboxes/Campaigns pages) running locally, not a separate simplified tool UI. This is a materially larger build than the "wrapper" default originally recommended — sized and architected below accordingly, not softened.

### Architecture — one shared local runtime, four build targets

**Shell**: Tauri wrapping the actual Next.js dashboard codebase (`app/`, `components/`) — reuse this account's own proven precedent (`~/faceless-channel-os` already ships a Tauri+Next.js desktop app) rather than evaluating packaging tools from scratch. No UI rewrite: the same React pages/components render, just served by a local Next.js server instead of the hosted one.

**Local database**: SQLite instead of the shared Postgres, via a second Prisma schema (`prisma/schema.local.prisma`, `provider = "sqlite"`, same models, separate generated client) selected at build time via a `RUNTIME_MODE=local` flag; `lib/prisma.ts` picks the right client. **Real porting work, not a copy-paste**: SQLite has no native array column type, so every `String[]` field (`findTerms`, `locationTerms`, `mailboxIds`, etc. — several exist across `SearchJob`/`CampaignAutomation`) needs to become a JSON-encoded string column or a join table in the local schema specifically; audit every model for Postgres-only features (arrays, native `Json` behavior differences) before assuming the schema ports 1:1.

**Local extraction engine** (Extractor EXE, and the shared/combined EXE): bundle the actual Python `worker/automation.py` pipeline — same Playwright-based DDG/pagination logic, same Tasks 22-25 bug fixes — as a local sidecar process the Next.js server spawns, instead of dispatching to the shared VPS job queue. This directly reuses Lead Extractor Pro's own proven packaging (Python + Playwright + bundled Chromium into one Windows EXE, ~290MB, already shipped and sold) rather than porting the pipeline to Node — don't rewrite working, hard-won logic into a new language for this.

**Local mailer engine** (Mailer EXE, and the shared/combined EXE): port `lib/mailer-send.ts`/`lib/campaign-recipients.ts`'s send/rotation/queue logic into a local drain loop the Next.js server runs in-process (polling the LOCAL `EmailQueueItem` table, same rotation math, same SMTP transport code) instead of the hosted dispatcher's systemd service. This is genuinely new code (today's drain logic is written as a standalone systemd-triggered process against the shared DB, not a library callable in-process) — a bounded port, not a full rewrite, since the actual send/rotation logic itself is untouched.

**Four build targets, one core**: build-time flags decide which dashboard routes and backends compile into a given EXE — they are not four separate codebases.
- **Extractor**: Next.js UI (Extract page only — Mailboxes/Campaigns/Automations routes excluded from the build) + local SQLite + Python extraction sidecar.
- **Mailer**: Next.js UI (Mailboxes/Campaigns pages only — Extract route excluded) + local SQLite + local mailer drain loop. Since the user wants "the current ui" for this too, it's the real Campaigns/Mailboxes management UI (not a stripped single-session tool) — a user can add mailboxes, build campaigns, and send to a CSV upload or a lead list without ever running the Extractor EXE.
- **Combined "Lead and Mailer"**: both engines + both UI sections in one shell, one local database, one license file — the natural default most buyers will actually want, letting Extract-page leads flow straight into the same local Campaigns UI with no export/import step.
- **Automation-enabled**: the combined build plus the Automations tab (Part B below) and its Channelry AI-relay call — the only one of the four with any network dependency for its core function (the AI reasoning step always calls out, per Part B's architecture note, regardless of how local everything else is).

**Effort reality check**: this is genuinely weeks of work, not days — porting the extraction pipeline as a sidecar is de-risked by the Lead Extractor Pro precedent, but the SQLite schema fork, the new local mailer drain loop, and four coordinated build variants sharing one licensing gate is a substantial, first-of-its-kind packaging project for this codebase. **Recommended build order**: Extractor first (closest to an existing proven precedent), then Mailer (new local drain loop, but simpler surface than extraction), then the combined build (mostly integration work once both exist), then automation-enabled last (blocked on the Channelry AI contract regardless — see Part B).

## Build/release pipeline — how "one core, four build targets" stays true in practice, not just in principle

**Raised 2026-09-14, before the shell work starts**: the owner's own words — *"as soon as we are fixing bugs in the spaceworker, and we want to run an exe build for a new version, it should be an easy flow to build from the current update, without having to maintain each build separately."* The "one core, four build targets" decision above already answers this ARCHITECTURALLY (one codebase, not four forks) — this section pins down the MECHANICAL side, researched against Tauri's own actual 2026 conventions rather than invented from scratch, so the shell work starts on the right footing instead of drifting into per-variant maintenance by accident.

- **Config, the Tauri-idiomatic way**: ONE base `src-tauri/tauri.conf.json`, plus one small override file per variant (`tauri.extractor.conf.json`, `tauri.mailer.conf.json`, `tauri.combined.conf.json`, `tauri.automation.conf.json`) merged in at build time via `tauri build --config <override-file>` — Tauri's own supported mechanism for exactly this shape of problem (confirmed against Tauri v2's current docs/community guidance, not assumed). Each override only needs to differ on what's GENUINELY different per variant: `productName`, `identifier` (bundle id), the icon, and which routes compile in — set via a build-time env var the Next.js app itself reads (`BUILD_TARGET=extractor|mailer|combined|automation`, matching the "Four build targets" section above) to conditionally exclude routes/pages. Everything else — the actual application code, the licensing gate, the shared components — is the SAME source for all four, read once, built four times.
- **CI, the same pipeline the web app already uses**: extend the existing GitHub Actions "Build & Deploy" workflow (the one already deploying the web app to the VPS) with a sibling job using [`tauri-action`](https://github.com/tauri-apps/tauri-action) (the official, actively-maintained GitHub Action for exactly this — builds native binaries and can upload them to a GitHub Release), matrixed over the 4 variants. Given the direct precedent (Lead Extractor Pro shipped as a ~290MB bundled-Chromium Windows EXE, and Task 27 Part A's own copy references "a secure download link for Windows"), scope this to **Windows-only initially** unless there's a real reason to also target macOS/Linux — don't build three platforms nobody asked for. Trigger it the same way the web deploy is already triggered manually today (`gh workflow run`) — a deliberate "cut a new EXE release from the current commit" action, not an automatic build on every push (desktop releases don't need that cadence, and it would burn CI minutes on every trivial commit).
- **Auto-updates — the actual payoff for "easy to maintain"**: wire in Tauri's built-in updater (the app periodically asks a version endpoint if something newer exists, downloads it, verifies its signature — Tauri's own standard flow, not custom-built). Without this, "fixing a bug and cutting a new build" doesn't actually reach anyone who already downloaded an earlier version — they'd need to notice and manually re-download, which is the exact maintenance burden the owner is trying to avoid. With it: fix the bug once in the shared codebase → tag a release → CI cuts all 4 variants → every already-installed copy picks up the fix on its own next launch, no support burden, no "did you redownload the latest version" back-and-forth.
- **Versioning discipline**: tag EXE releases against the exact git commit/tag the web app was running at the time (e.g. `v1.4.0` triggers both the web deploy AND the EXE builds from the same commit) — so "which web version does this EXE match" is always a fact, not a guess, and nothing quietly drifts between the two over time.

This is guidance for whoever picks up the actual Tauri shell work (not blocking the current licensing-layer slice) — read it before scaffolding `src-tauri/`, since the config/CI shape decided at that point is what determines whether this stays "one easy release flow" or quietly becomes four things to maintain.

Sources: [Tauri config overrides for multi-variant builds](https://github.com/orgs/tauri-apps/discussions/13941), [tauri-action GitHub Action](https://github.com/tauri-apps/tauri-action), [Tauri v2 updater guide](https://thatgurjot.com/til/tauri-auto-updater/), [Ship Your Tauri v2 App Like a Pro — release automation](https://dev.to/tomtomdu73/ship-your-tauri-v2-app-like-a-pro-github-actions-and-release-automation-part-22-2ef7)

## The purchase flow — reuses existing payment infrastructure, doesn't invent a new one

**Confirmed current state**: SpaceWorker already has a real, working manual-crypto-payment system — `Payment` model (`kind: "btc"|"usdt_trc20"`, `amountUsd`, `txHash` unique, `toAddress`, `status: "pending"|"approved"|"flagged"|"rejected"`, `autoApproved`), `PaymentVerificationAttempt` audit trail, an admin panel (`app/admin/`) with a payments review route (`app/api/admin/payments/`), and `app/api/internal/payment-verify/` doing the actual on-chain verification. This is the exact infrastructure a "buy a license" flow needs — don't build a second payment system for it.

**The flow**:
1. Landing page gets a "Get the desktop app" (or "Buy tools") section/page, showing all 4 EXE options + price, no login required to START the flow.
2. Checkout collects an email (for delivering the license key — this is the ONE piece of identity needed, not a full account) and routes into the SAME BTC/USDT manual-verification flow already built, with a new `Payment.kind` value or a `product` field distinguishing which of the 4 EXE licenses was purchased from whatever else `Payment` rows represent today (check what `Payment` rows currently represent in this app before assuming — confirm during implementation, don't guess here).
3. On admin-approval (the existing review action), the system **generates a real license key** server-side using the ported `generate_license_key` logic (Node/TypeScript port of `generator.py`'s exact scheme — HMAC-SHA256 over a base64 JSON payload, same format, so a future cross-tool validator could work identically whether the key came from this system or the old standalone's), embedding the purchase email as `licensee` in the payload, and emails the key to that same address (reuse whatever email-sending mechanism this app already has for other transactional email — check before adding a second one).
4. No `machine_id` is bound server-side at issuance time (the server never sees the buyer's machine) — machine binding, if wanted, happens client-side at first activation inside the EXE itself (the EXE calls `get_machine_id()` locally and could optionally report it back to a "register this activation" endpoint, but the VALIDATION itself stays fully offline per the standalone's proven design — don't build a system that requires the EXE to phone home on every launch just to check a license, that defeats the point of an HMAC scheme built specifically to avoid that).
5. Signup remains available as a clearly separate button/path alongside the buy-tools flow, exactly as today — this whole Part A is additive, not a replacement for anything in `app/signup`.

## Licensing gate UI — one shared component across all 4 EXEs

Per the user's explicit instruction ("just a gated email for activation and licensing page for all exe"): a single licensing/activation gate design, reused identically across all 4 build targets — not four separate license screens.

- **First launch**: no gate at all — the app opens straight into the (build-appropriate) dashboard UI and silently starts the 24h local trial timer (per the "Confirmed: you've already built and shipped this exact mechanism once" section above). No email needed just to try it.
- **Trial expired**: a single shared `<LicenseGate>` component (rendered by the Tauri shell before the dashboard mounts, same component compiled into all 4 builds) blocks the app with two fields — **license key** and **email** — and an "Activate" button. The email is checked against the `licensee` field embedded in the key's payload (light usability/anti-sharing check — "does this key belong to the account this person is typing," not a security boundary; matches the existing system's own accepted HMAC-not-DRM risk tolerance, don't build anything stronger than that). A "Buy a license" link/button on this same screen deep-links back to the landing page's buy-tools flow for a user who hasn't purchased yet.
- **Which build the gate is compiled into** determines nothing about the gate itself — it's the exact same component/copy across Extractor, Mailer, Combined, and Automation-enabled; only the dashboard behind it differs.

## Scope decision — 2026-09-14: build the licensing layer now, not the Tauri shell

Cline asked which slice of this Part A to build first. Answer: **the licensing layer only** — `lib/machine-id.ts` (port of `~/lead-extractor/app/license/machine_id.py`), an offline validator, the 24h local trial-state store, and the shared `<LicenseGate>` component from the section above. **Not** the Tauri shell, the ported local extraction/mailer engines, or the 4 build variants yet — those stay queued behind this, per this doc's own "Recommended build order" (Extractor first, once this prerequisite layer exists).

Why this slice: it's genuinely verifiable in isolation (pure TypeScript logic, testable without a desktop shell existing), it's a real prerequisite EVERY one of the 4 future builds needs regardless of which gets built first, and it directly extends work already proven today — Task 42's `lib/exe-license.ts` (the license *generator*, live in production, issuing real 180-day keys) needs an offline *validator* counterpart to actually be useful once a real EXE exists.

Concrete guidance for building it:
- **Don't fork a second, parallel license module.** `lib/exe-license.ts` already has `decodeLicenseKey`/`verifyLicenseKey`, and per this doc's own architecture the EXE eventually runs THIS SAME Next.js codebase locally (not a rewrite) — so the offline validator belongs in that same file, extended if needed, not a new standalone port living elsewhere.
- **The date-format lesson from Task 42 applies doubly here.** The generator was fixed on 2026-09-14 to emit `issued_at`/`expires_at` matching Python's own `datetime.isoformat()` exactly (no `Z` suffix, 6-digit microseconds) — because `datetime.fromisoformat()` in the real `validator.py` only accepts a `Z` suffix on Python 3.11+. Whatever offline validator gets built now must expect that SAME format on the way in — verify this explicitly (generate a key, decode it, confirm the dates parse) rather than assuming, exactly like Task 42's own verification did (which caught a real bug this way).
- **The embedded-secret tradeoff is already accepted, not a new blocker.** An offline HMAC validator necessarily ships the verification secret inside every copy of the EXE (HMAC has no public/private split — verifying requires the same secret that signed). This is the exact, already-accepted baseline from Lead Extractor Pro ("not real DRM," per this doc's own "Anti-piracy hardening" line below) — don't try to architect around it or treat it as a new problem to solve.
- **Machine binding**: per the existing decision below, none at issuance time — `<LicenseGate>`'s activation step is where `get_machine_id()` gets read for the first time, client-side, exactly as `~/lead-extractor`'s standalone already does it.

## Decisions made 2026-09-12 (previously flagged as business questions — owner-authorized to decide directly, no further wait needed)

- **Pricing/plan structure — superseded 2026-09-14, see `TASK_42_MARKETING_PAGE_AND_APP_STORE.md`**: no longer perpetual. Real launch prices are decided ($25/mo web, $50 Extractor, $50 Mailer, $70 Combined, $100 Automation-enabled) and every EXE license is a flat 180-day (6 month) term, undisclosed pre-purchase and stated plainly to the buyer only after payment (Task 42 §4/§6) — this is what actually shipped in the checkout/licensing plumbing ahead of the real EXE builds.
  - **Noted for when the EXE build actually starts (this task, not Task 42)**: once a real download exists, add a term-length step to the buy flow — after "pay for license," show a page letting the buyer pick a longer term than the 6-month default (a year or more) before checkout, with a small discount for longer terms. `expires_at` already being a normal field in the license payload (per the format below) means this needs no license-format change, only a UI step + a term→price/discount table before the existing checkout. Not built now — flagged here so it isn't lost, to pick up when Part A's real build starts.
- **Which tools are sold this way**: exactly the 4 SpaceWorker EXE tiers already specified above (Extractor / Mailer / Combined / Automation-enabled) — not bundled with the separate Selar store's existing products; those stay on their own separate purchase flow.
- **Anti-piracy hardening**: stays at the existing standalone's baseline (HMAC signature + optional machine-binding at activation, not real DRM) — no stricter bar for these 4 EXEs than what Lead Extractor Pro already accepts.

---

# Part B — Automations tab: manual builder first, then an AI agent

## Reconciled 2026-09-12 with the pre-existing `TASK_09_CAMPAIGN_AUTOMATION_AND_AGENT.md`

The first draft of this Part (above the line, superseded below) modeled an "Automation" as a bare saved-job-template — reasonable as far as it went, but `TASK_09_CAMPAIGN_AUTOMATION_AND_AGENT.md` (written 2026-09-08, four days earlier, directly from the user's own description of the full end-to-end flow) already specced something considerably richer for the exact same feature: a `CampaignAutomation`/`CampaignAutomationRun` pair covering daily-or-manual triggers, a hard campaign+mailbox gate before a run is even allowed, a personal-uploaded-lead-list source alongside fresh extraction, always-on test-send-confirm, and a full run-summary/drill-down UI. That's the correct, more complete model — it was simply written before this doc existed and the two were never merged. **This section replaces the "manual automation builder" content below the reconciliation, folding Task 09's model in wholesale rather than leaving two conflicting specs in two files.** Task 09 itself should now be treated as superseded/absorbed by this section — don't build from it directly, it's kept only as the historical record of where this model came from.

**What carries over unchanged from Task 09** (already correct, restated here so this doc is self-contained): the hard dependency ordering (extraction solid → mailbox/campaign send verified end-to-end → only then this layer — see "Where this stands against the dependency ordering" below for current status), the `CampaignAutomation`/`CampaignAutomationRun` two-table shape (config vs. one-row-per-execution), the manual/daily trigger split with a systemd-timer scheduler rather than an in-process one (matching this repo's existing dispatcher/queue-drain convention), the hard gate requiring a campaign AND at least one mailbox before an automation can be created (not just before it runs), the two-tier template system (build-your-own vs. ready-made "just needs lead volume + mailboxes" templates), the personal-lead-list source as a distinct ingestion path from extraction, the always-test-send-confirm question flagged as needing explicit confirmation, and the full run-summary/drill-down UI shape (duration by phase, leads extracted, emails sent by mailbox/variant, source indicator, per-run detail view).

**What this doc adds on top of Task 09** (the parts Task 09 explicitly deferred to "its own pass," now addressed): the concrete Prisma shape reconciled against Task 26's actual shipped models (`SearchJob`/`Lead`/`EmailCampaign`/`EmailQueueItem`, not hypothetical ones), the AI-agent architecture and its REST-endpoint mapping, and the confirmation-gate design for the agent specifically (Task 09 flagged Channelry's Agent Decider System as "worth reviewing," this doc reviews it and applies it).

### Where this stands against the dependency ordering

Task 09's step 1 (extraction solid) and step 2 (mailbox/campaign send verified end-to-end) are both **substantially further along** than when Task 09 was written, per this session's own work: Task 26's five root-caused extraction bugs are fixed and a real job reached 7,000+ leads; the mailbox SMTP transport bug (secure/TLS derived from port) is fixed and deployed. **Neither is fully closed out**, though: a real, confirmed, end-to-end delivered test email through SpaceWorker's own send pipeline has not yet happened (the user was mid-troubleshooting Brevo IP-allowlisting as of the last mailbox-testing message) — that confirmation is the actual gate, not "the code looks right." Do not start building the automation layer below until that real send is confirmed.

## Sequencing, exactly as asked

1. Build the **manual automation builder** first — a saved, campaign+mailbox-gated, re-runnable configuration a user can trigger manually or schedule daily. This alone needs to work well before anything conversational sits on top of it, since the agent's whole job is "fill this same form out correctly on the user's behalf," not a separate system.
2. Add an **agent option beside it** on the same tab, once the manual path is proven.

## Manual automation builder

### Data model

```prisma
model CampaignAutomation {
  id                String   @id @default(cuid())
  userId            String
  user              User     @relation(fields: [userId], references: [id])
  name              String

  // Lead source — extraction (this automation's own saved find/location/params,
  // the exact same params shape POST /api/jobs already accepts) OR a personal
  // uploaded list, per Task 09's item 4. Never both for the same run.
  leadSource        String   @default("extract") // "extract" | "personal_list"
  findTerms         String[]
  locationTerms     String[]
  params            Json?    // engine, maxResults, minResults, pagesPerQuery,
                              // maxDurationMinutes, resultMode, emailDomains — same
                              // keys POST /api/jobs already reads today. Null when
                              // leadSource is "personal_list".
  personalListId    String?  // set when leadSource is "personal_list" — see the
                              // upload-ingestion note below; reuses Task 26 Piece 3's
                              // existing upload-as-SearchJob(template:"upload") path
                              // rather than inventing a second lead-storage shape,
                              // since that path already produces ordinary Lead rows.

  // Campaign + mailbox — HARD GATE per Task 09: both required to even CREATE this
  // row, not just to run it. Enforced in the create route, not just at run time.
  campaignTemplateId String  // which EmailCampaign-shaped template this run uses —
                              // see "two-tier template system" below
  mailboxIds        String[] // must be non-empty at creation time

  // Trigger
  triggerMode       String   @default("manual") // "manual" | "daily"
  scheduleHour      Int?     // 0-23, UTC — only meaningful when triggerMode is "daily"
  scheduleEnabled   Boolean  @default(true) // lets a daily automation be paused
                                             // without deleting its config

  createdAt         DateTime @default(now())
  lastRunAt         DateTime?
  runCount          Int      @default(0)
  runs              CampaignAutomationRun[]

  @@index([userId])
  @@index([triggerMode, scheduleEnabled])
}

model CampaignAutomationRun {
  id                    String   @id @default(cuid())
  automationId          String
  automation            CampaignAutomation @relation(fields: [automationId], references: [id])

  startedAt             DateTime @default(now())
  extractionCompletedAt DateTime?
  completedAt           DateTime?
  status                String   @default("running") // "running"|"done"|"failed"|"stopped"

  leadSource            String   // snapshot of the automation's leadSource at run time
  searchJobId           String?  // set when leadSource was "extract" (or the
                                  // upload-derived SearchJob when "personal_list")
  leadsExtracted        Int?     // null when not meaningful (personal-list runs still
                                  // get a count via the uploaded SearchJob's lead count)
  campaignId            String?  // the EmailCampaign this run actually created/queued
  emailsSent            Int?
  emailsSentByMailbox   Json?    // { [mailboxId]: count } — rotation visibility, per
                                  // Task 09 item 5, computed from EmailQueueItem at
                                  // completion rather than tracked incrementally
  errorMessage          String?

  @@index([automationId, startedAt])
}
```

Deliberately NOT a new job-execution path for the extraction half — a `CampaignAutomation` re-derives the exact `queries`/`params` body `POST /api/jobs` already accepts (cross-multiplying `findTerms`×`locationTerms` the same way the Extract page's own form does today — confirm and reuse that exact cross-multiply function rather than re-deriving it) and calls the SAME job-creation code path, and for the send half it calls the SAME `buildQueueItemRows`/campaign-creation code path Task 26 Piece 4/5b already built (`lib/campaign-recipients.ts`, `POST /api/campaigns`). This is the concrete payoff of the "AI automation ready" discipline noted back in Task 26 Piece 4: because job creation and campaign creation were always plain, reusable REST/library calls, this whole layer is new CRUD + a small orchestrator, not new extraction or send logic.

**Personal-lead-list ingestion**: reuses Task 26 Piece 3's existing `POST /api/leads/upload` path unchanged (creates a `SearchJob{template:"upload", status:"done"}` + real `Lead` rows) rather than inventing Task 09's speculative separate `PersonalLeadList` model — the upload path already produces exactly the shape a `CampaignAutomation` run needs (a `SearchJob` with `Lead` rows, validated the same way an extracted job's leads are). `CampaignAutomation.personalListId` stores that upload's `SearchJob.id`; a "personal_list" run skips the extraction phase entirely and jumps straight to campaign creation using the leads already on that job (respecting Task 26 Piece 3/7's validation-status filtering, same as any other job's leads).

**Two-tier template system** (Task 09 item 2, made concrete against Task 26's actual `EmailCampaign`/`CampaignVariant` shape): tier (a) is a from-scratch campaign a user has already built themselves via the Campaigns tab (its `EmailCampaign.id` referenced directly as `campaignTemplateId`, cloned per-run rather than reused directly, so each automation run gets its own fresh `EmailCampaign`+`EmailQueueItem` set instead of appending to a shared one); tier (b) is a ready-made template — a `CampaignVariant` set with placeholder-only merge fields (no mailboxes chosen yet) that a user selects and then only supplies mailbox rotation for. Implementation-time decision, not designed further here: whether tier (b) templates are just `EmailCampaign` rows owned by a system/admin account that get cloned the same way tier (a) does, or a dedicated `CampaignTemplate` model — the cloning behavior is identical either way, so this doesn't block the schema above.

**Always-test-send-confirm — DECIDED 2026-09-12**: take the user's literal wording ("it confirms the email delivers with the first test sending before going ahead always") at face value — **no skip option, ever, even for a mailbox with an established track record.** This is the safer default (a silently-broken mailbox on a daily automation would otherwise burn through a whole lead list undetected) and costs little: for the `triggerMode:"daily"` case specifically, this means a run that reaches the send phase pauses in a `"needs_confirmation"` status and notifies the user (reuse whatever notification channel Task 26/Vantra-pattern email/in-app alerting already exists in this app) rather than sending unattended — it is NOT fully "hands-off" end to end, only the extraction half is. State this plainly in the UI (a daily automation's card should say "sends require your confirmation" so this isn't a surprise) rather than implying full unattended operation.

### UI (`app/dashboard/automations/page.tsx`, replacing the Piece 6 placeholder)

- List of saved Automations (name, find/location term summary via the same `summarizeQuery`-style compaction Task 26 Piece 1 already built — reuse it, don't write a second one; trigger mode badge — "Manual" or "Daily at HH:00 UTC"; last-run status), each with "Run now," "Edit," "Pause/Resume" (for daily), "Delete."
- "New automation" is a multi-step form: lead source (extract with the same find/location/engine/limits fields the Extract page's job-creation flow already has, reused not duplicated — or personal list, picking from existing uploaded jobs) → campaign template (tier a or b, per above) → mailbox rotation → trigger mode (manual, or daily + hour picker). The **hard gate is enforced here**: the form cannot be submitted without a valid campaign template AND at least one mailbox selected, matching Task 09's explicit "enforce at creation time" instruction.
- "Run now" calls `POST /api/automations/[id]/run`, which creates a `CampaignAutomationRun` row, kicks off the extraction/upload-reuse phase, then the campaign-clone-and-queue phase, and redirects to a new **run detail page** (`/dashboard/automations/[id]/runs/[runId]`) rather than the plain Extract page — this is Task 09's run-summary/drill-down surface: duration (extraction phase / send phase / total, computed from `startedAt`/`extractionCompletedAt`/`completedAt`), leads extracted (or "personal list: N leads" when applicable), emails sent with the per-mailbox breakdown, and links through to the underlying `SearchJob` and `EmailCampaign` for full detail — not just the summary numbers.
- Daily automations run via a systemd timer hitting a new `POST /api/internal/automations-sweep` (same `INTERNAL_BEARER_TOKEN` gate as the existing `retention-sweep` route, same "sibling of `app/api/internal/dispatch`" pattern) that finds `CampaignAutomation` rows with `triggerMode:"daily", scheduleEnabled:true` due for their `scheduleHour`, and creates a `CampaignAutomationRun` for each — not a long-lived in-process scheduler, matching this repo's existing dispatcher/queue-drain convention exactly.

## The AI agent

### What the agent actually needs to do, mapped to what already exists

Re-reading the ask against the current codebase: almost everything the agent needs to DO already exists as a plain REST endpoint (the "AI automation ready" discipline from Task 26 paying off directly) — the agent's real job is **interpreting intent into the right parameters**, not inventing new backend capability.

| User's ask | Existing endpoint the agent calls |
|---|---|
| "I want up to 10,000 leads for AI-apps outreach" | `POST /api/jobs` (or `POST /api/automations` to save it first) — agent fills `findTerms`/`locationTerms`/`minResults: 10000`/reasonable `maxDurationMinutes` |
| "give feedback on the outcome" | `GET /api/jobs/[id]` polled, same shape the dashboard already polls |
| "ask back other details, like domain filters" | agent-side conversation turn, not a new endpoint — `emailDomains` is already a supported param |
| "plan the campaign if mailboxes are added" | `GET /api/mailboxes` (does the user have any?) then `POST /api/campaigns` with `leadIds` from the just-finished job's validated leads (Task 26 Piece 4's exact picker logic, called programmatically instead of through the UI) |

**The one piece of "knowledge" the agent needs that ISN'T just an API call**: picking GOOD `findTerms`/`locationTerms` wording from a vague goal like "AI apps outreach." This is squarely a prompting/context problem, not new backend work — the agent's system prompt should encode what this session already proved works (bulk-document-targeting query construction is already baked into `worker/automation.py`'s own `_EXPANSION_SUFFIXES`/pagination fixes at the WORKER level, so the agent doesn't need to replicate that — it only needs to pick sensible, specific BASE find/location terms; the worker's own expansion machinery does the rest). Write the agent's system prompt with real example find/location terms from this session's actual successful tests (e.g. broad-but-specific industry+role phrasing) once this piece is actually built — don't invent example terms now in a planning doc that will go stale.

### Architecture: routes through Channelry's Groq integration, confirmed direction from Task 26

Per the direction already recorded in Task 26 (Piece 4's "ready for AI automation linking" note): SpaceWorker's agent is NOT going to stand up its own separate LLM provider/key management — it routes through Channelry's existing pooled Groq integration, with AI usage calculated per user. **The contract this needs is now grounded AND decided, not guessed**: `~/faceless-channel-os/CLINE_TASK_EXTERNAL_AI_INTEGRATION_SPACEWORKER_2026-09-12.md` (written 2026-09-12, after reading Channelry's real `worker-full.ts`) specifies the Channelry-side build — a new `external_clients` roster + `POST /external/ai-chat` relay endpoint (parallel to the existing internal `/internal/groq-chat`), reusing `llmChatRaw`'s pooled-key calling and `groqCostHundredthsCent`'s exact cost formula/units. Its three open decisions are now resolved (owner-authorized, same authority as this doc's other 2026-09-12 decisions — see that doc's own "Decisions made" section for the reasoning): attribution uses the `client_id`+nullable-`user_id`+`external_user_id` widening (option a), the relay supports `llmToolChat`'s tool-calling mode from day one (required — this agent's REST-mapping table above needs multi-step tool orchestration, not single-shot completions), and SpaceWorker's `external_clients` row starts with a $50/day pooled cap (well above any single Channelry user's $1/day default, since it aggregates every SpaceWorker user's agent usage under one client identity — admin-adjustable without a redeploy, raise it once real usage volume is visible). SpaceWorker's own side of this contract (the admin-panel section to configure/test the Channelry connection, storing the issued external-client key, calling `/external/ai-chat`) still needs to be built — the contract is settled, the SpaceWorker-side implementation is not yet written.

### UI shape

- A chat-style panel on the Automations tab, alongside (not replacing) the manual list — "Ask the agent" as a second way to create an Automation/job, sitting next to "New automation."
- **Confirmation gate before any job actually runs** — matching the pattern already proven in Channelry's own "Agent Decider System" (per this session's memory: confirmation gates before content generation, an explicit approval step) rather than letting the agent fire off a 10,000-lead job unattended the first time it guesses at parameters. The agent proposes a plan (find/location terms, minResults, duration, estimated time) as a reviewable card; the user confirms or asks for changes before it actually calls `POST /api/jobs`.
- Once confirmed and the job finishes, the agent's own turn reports the outcome (leads found vs. requested, validation split) and, if mailboxes exist, offers the campaign-creation follow-up as its own confirmable step — never chains straight from extraction into a live send without a second explicit confirmation, since sending email is a much higher-stakes action than running a search.

## Explicitly out of scope, Part B

- Anything beyond daily/manual scheduling (e.g. "every Monday," specific weekday/interval schedules) — the reconciled model above covers manual + once-a-day, per Task 09's exact ask; a richer cron-style schedule is a future extension of `CampaignAutomation.triggerMode`, not part of this pass.
- Any agent capability beyond leads-extraction-then-optionally-campaign — no broader "general assistant" scope creep into this specific tab, and no "talk to other apps" (Mailboxes/Browser Profiles as their own agent-drivable surfaces) beyond what already falls out of the campaign flow — Task 09's broader "talk to other apps" framing is noted but not scoped here.
- Actually building the Channelry-side `external_clients`/`POST /external/ai-chat` work — that's Channelry's own task doc's job (see the Architecture section above), not this repo's; this doc only needs to build SpaceWorker's consuming side once that contract's three open decisions are settled.

---

## How this fits with the currently-in-progress Task 26

No conflict: Task 26's Automations-tab placeholder (Piece 6) is exactly the landing spot Part B replaces once built. Task 26's "AI automation ready" REST-endpoint discipline (Piece 4's note) is precisely what makes Part B's agent layer thin instead of a rewrite, and its already-shipped `buildQueueItemRows`/leads-picker code (Piece 4/5b) is exactly what `CampaignAutomation`'s send phase calls. Nothing in Part A touches Task 26's files at all — it's a fully separate distribution channel.

**As of 2026-09-12, every open architecture question in this whole doc is now decided** (the 4-EXE local-reimplementation design in Part A, its licensing gate, and the Channelry AI-contract's three open items) — nothing left to confirm before implementation starts, only sequencing left to decide:

1. **Confirm the real end-to-end mailer send** — the one piece of the original dependency ordering not yet closed (see "Where this stands against the dependency ordering" above). Still the actual gate for Part B's builder, code readiness aside.
2. **Build Part B's manual `CampaignAutomation` builder** — the smallest fully-unblocked increment: no new architecture decisions needed, builds entirely on already-shipped, already-reviewed Task 26 code (job creation, `buildQueueItemRows`, the leads picker), self-contained to the existing Next.js/Postgres stack Cline already knows. Recommended **first hand-off**, precisely because it has zero remaining open questions and the smallest blast radius of everything left in this doc.
3. **Build Part A's 4-EXE local runtime** — now fully decided, but the biggest, most novel undertaking in this doc (Tauri shell, SQLite schema fork, a new local mailer drain loop, 4 coordinated build variants, one shared licensing gate) and worth its own dedicated implementation pass with the build-order already specified above (Extractor → Mailer → Combined → Automation-enabled), not squeezed in alongside other work.
4. **Build the Channelry-side `external_clients`/`POST /external/ai-chat` work** — decided, but touches a single 14,616-line production file handling real payments; hand off with the same PR-reviewed discipline already used for every other Channelry/Vantra external-collaborator handoff this session (small, reviewable diffs, reviewed before merge), not a first-thing-deployed rush.
5. **Only then** the agent half of Part B, which depends on both 3's local runtime existing (for the automation-enabled EXE) and 4's contract being live.

---

# UPDATE 2026-09-12 — Part B manual `CampaignAutomation` builder is now implemented (sequencing item #2, "first hand-off")

**Status: the manual builder is landed end-to-end and `tsc`-clean.** The schema + migration, the shared job/campaign helpers, the full automation API surface (CRUD + run + confirm + run-detail), the internal hourly sweep, and a functioning dashboard UI (list, multi-step create/edit, run-now/pause/resume/delete, run history, run drill-down) are in place, built entirely on already-shipped Task 26 code as designed. A continuation pass has since been layered on top that further polishes the UI (themed confirm dialog replacing `window.confirm`, richer run-detail page). This section records the verifiable state and exactly what the next agent should pick up.

## What is in place (verified via `tsc --noEmit` = 0 errors)

**Database** — `prisma/schema.prisma` now defines `CampaignAutomation` + `CampaignAutomationRun` (relation wired on `User`), matching the reconciled Part B model: lead source (`extract`|`personal_list`), hard-gated `campaignTemplateId` + `mailboxIds`, manual|daily trigger with `scheduleHour`/`scheduleEnabled`, and a per-run snapshot (`leadsExtracted`, `campaignId`, `emailsSent`, `emailsSentByMailbox`, phase timestamps, `errorMessage`). Hand-written migration at `prisma/migrations/20260912100000_add_campaign_automations/`. **The migration is written but NOT yet `prisma migrate deploy`-applied to the live DB — do that on the next deploy.**

**Shared helpers** (the "reuse, don't duplicate" payoff):
- `lib/build-search-queries.ts` — Find × Location cross-multiply, identical to the Extract page (capped at 300).
- `lib/create-search-job.ts` — the single SearchJob+JobQueueEntry enqueue transaction; `POST /api/jobs` was refactored to call it.
- `lib/campaign-create.ts` — the one campaign+variant+queue create transaction → send phase clones a template here.
- `lib/automation-run.ts` — the orchestrator: `kickOffRun`, `processSendPhase` (manual clones+queues; daily stops at `needs_confirmation`), `confirmDailyRun`, `sweepCreateDueDailyRuns`, `sweepAdvanceFinishedRuns`.

**API** — `app/api/automations/route.ts` (list + create, hard gate enforced server-side), `app/api/automations/[id]/route.ts` (edit re-gates, pause/resume, delete), `app/api/automations/[id]/run/route.ts` (run-now), `app/api/automations/[id]/runs/[runId]/route.ts` (drill-down), `.../runs/[runId]/confirm/route.ts` (daily send unlock), `app/api/internal/automations-sweep/route.ts` (hourly: creates due daily runs + advances finished runs; same `INTERNAL_BEARER_TOKEN` gate as siblings).

**UI** — `app/dashboard/automations/page.tsx` (list + 5-step create/edit form), `app/dashboard/automations/[id]/page.tsx` (run history), `app/dashboard/automations/[id]/runs/[runId]/page.tsx` (drill-down with Confirm & send for daily runs).

## What the next agent should do (in priority order)

1. **Apply the migration + wire the scheduler.** Run `prisma migrate deploy` on the real DB. Add `deploy/automations-sweep.{service,timer}` mirroring `deploy/mail-queue-drain.{service,timer}` exactly (oneshot curl with `%INTERNAL_BEARER_TOKEN%` → `/api/internal/automations-sweep`), on an **hourly** cadence (`OnUnitActiveSec=1h`) so daily automations fire on their `scheduleHour`.
2. **Refactor `POST /api/campaigns` to call `lib/campaign-create.ts`** — it currently inlines its own equivalent transaction; unifying removes the second implementation `campaign-create.ts` was written to prevent. Low risk, watch the return shape (create-campaign currently returns `{ campaign: { id }, recipientCount, byMailbox }`).
3. **Real mailer confirmation is still the true gate for sends** (the always-test-send-confirm decision). Manual runs clone into a `pending_test_confirm` campaign, so the existing test-send→`confirm-test` flow already gates; but no confirmed end-to-end delivered send has been recorded — close that before relying on live sends.
4. **External alert for daily `needs_confirmation` runs** — currently only a `NotificationLog` row is written (`automation_needs_confirmation`); wire a real Resend email using `lib/email.ts`'s existing channel.
5. **Tier (b) ready-made templates are not built** — this ships tier (a) only (user clones one of their own `EmailCampaign`s). The implementation-time decision (system/admin-owned `EmailCampaign` rows vs. a `CampaignTemplate` model) is still open.
6. **Still-gated/separate workstreams** from the plan are untouched and remain as before: Part A's 4-EXE local runtime, the Channelry-side `external_clients`/`POST /external/ai-chat` contract (SpaceWorker's consumer side of it too), and the agent half of Part B.
