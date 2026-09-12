# Task 27 — Licensed EXE distribution + Automations tab (manual builder + AI agent)

**Status: PLANNING ONLY. Do not start building.** Per the user's own explicit sequencing: Task 26's manual tools (extract, validate, merge, mailboxes, campaigns) need to be solid first — this doc exists so the destination is clear and the dashboard/data model don't paint themselves into a corner, not as a green light. Two genuinely separate workstreams are covered here (Part A: EXE + licensing, Part B: Automations tab), tied together only by both depending on Task 26 being done and both landing on the same dashboard. Written 2026-09-12, grounded in the actual current code: the standalone Lead Extractor's real, working license system (`app/license/{generator,machine_id,validator}.py`), SpaceWorker's existing `Payment`/admin-review infrastructure (`prisma/schema.prisma`'s `Payment` model, `app/admin/`, `app/api/admin/payments/`), the current landing page (`app/page.tsx`), and the Piece 6 `Automations` placeholder (`app/dashboard/automations/page.tsx`).

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

## Open question — confirm before Cline builds anything (this is the one real fork in this whole Part)

**What does "the EXE" actually contain?** Two very different builds hide behind that word, and the right one changes scope by an order of magnitude:

1. **A thin desktop wrapper around the existing hosted dashboard** (Electron or Tauri shell pointing at `https://spaceworker.instaweb.top`, license-gated locally before the shell loads the page) — SpaceWorker's real extraction/automation work already runs server-side (`worker/automation.py` on the shared VPS, not client-side), so this is the natural fit: the EXE is a distribution/paywall mechanism for the same product, not a reimplementation. Days of work, not weeks.
2. **A standalone local app reimplementing extraction/automation to run entirely on the buyer's own machine** (like Lead Extractor Pro genuinely does) — this would mean either porting `worker/automation.py`'s whole DDG/pagination/extraction pipeline to run locally (duplicating a lot of very recently, very hard-won correctness work — see Tasks 22-25 this session), or building a fundamentally different, disconnected product that happens to share a name. Weeks of work, and a real fork in the codebase going forward.

Given the standalone Lead Extractor is already exactly option 2 and already sold separately, and SpaceWorker's whole architecture (shared VPS worker, wallet-billed usage, one Postgres database) is built around option 1's model — **the wrapper (option 1) is the recommended default** unless there's a specific reason SpaceWorker needs to run fully offline/local that hasn't come up yet. Don't build either until this is confirmed explicitly.

## The purchase flow — reuses existing payment infrastructure, doesn't invent a new one

**Confirmed current state**: SpaceWorker already has a real, working manual-crypto-payment system — `Payment` model (`kind: "btc"|"usdt_trc20"`, `amountUsd`, `txHash` unique, `toAddress`, `status: "pending"|"approved"|"flagged"|"rejected"`, `autoApproved`), `PaymentVerificationAttempt` audit trail, an admin panel (`app/admin/`) with a payments review route (`app/api/admin/payments/`), and `app/api/internal/payment-verify/` doing the actual on-chain verification. This is the exact infrastructure a "buy a license" flow needs — don't build a second payment system for it.

**The flow**:
1. Landing page gets a "Get the desktop app" (or "Buy tools") section/page, showing the EXE download + price, no login required to START the flow.
2. Checkout collects an email (for delivering the license key — this is the ONE piece of identity needed, not a full account) and routes into the SAME BTC/USDT manual-verification flow already built, with a new `Payment.kind` value or a `product` field distinguishing "SpaceWorker Pro EXE license" from whatever else `Payment` rows represent today (check what `Payment` rows currently represent in this app before assuming — confirm during implementation, don't guess here).
3. On admin-approval (the existing review action), the system **generates a real license key** server-side using the ported `generate_license_key` logic (Node/TypeScript port of `generator.py`'s exact scheme — HMAC-SHA256 over a base64 JSON payload, same format, so a future cross-tool validator could work identically whether the key came from this system or the old standalone's) with `days_valid` reflecting whatever the purchased plan actually buys (a real decision to make explicit at build time: one-time perpetual license vs. a term license — don't assume, ask), and emails it to the purchase email (reuse whatever email-sending mechanism this app already has for other transactional email — check before adding a second one).
4. No `machine_id` is bound server-side at issuance time (the server never sees the buyer's machine) — machine binding, if wanted, happens client-side at first activation inside the EXE itself (the EXE calls `get_machine_id()` locally and could optionally report it back to a "register this activation" endpoint, but the VALIDATION itself stays fully offline per the standalone's proven design — don't build a system that requires the EXE to phone home on every launch just to check a license, that defeats the point of an HMAC scheme built specifically to avoid that).
5. Signup remains available as a clearly separate button/path alongside the buy-tools flow, exactly as today — this whole Part A is additive, not a replacement for anything in `app/signup`.

## Explicitly out of scope for this plan (flag, don't decide here)

- The exact pricing/plan structure (one-time vs. subscription-like `days_valid` terms) — a real business decision, not an engineering one; note it needs to be made, don't invent a number.
- Which specific "tools" are sold this way (just SpaceWorker, or multiple products bundled the way the existing Selar store already does) — out of scope until the wrapper-vs-native question above is answered, since it changes what's even being packaged.
- Anti-piracy hardening beyond what the standalone already accepts as a reasonable baseline (HMAC + machine-binding, not real DRM) — matching the existing system's own risk tolerance, not a new, stricter bar.

---

# Part B — Automations tab: manual builder first, then an AI agent

## Sequencing, exactly as asked

1. Build the **manual automation builder** first — a saved, reusable job configuration a user can re-run without re-entering every field. This alone needs to work well before anything conversational sits on top of it, since the agent's whole job is "fill this same form out correctly on the user's behalf," not a separate system.
2. Add an **agent option beside it** on the same tab, once the manual path is proven.

## Manual automation builder

### Data model

```prisma
model Automation {
  id             String   @id @default(cuid())
  userId         String
  user           User     @relation(fields: [userId], references: [id])
  name           String
  // The exact same params shape run_automation/POST /api/jobs already accepts —
  // an Automation IS a saved job configuration, not a new parameter language.
  template       String   @default("lead")
  findTerms      String[]
  locationTerms  String[]
  params         Json     // engine, maxResults, minResults, pagesPerQuery,
                           // maxDurationMinutes, resultMode, emailDomains — same
                           // keys POST /api/jobs already reads from params today
  lane           String   @default("light")
  createdAt      DateTime @default(now())
  lastRunAt      DateTime?
  runCount       Int      @default(0)

  @@index([userId])
}
```

Deliberately NOT a new job-execution path — an Automation is a **template**, `POST /api/automations/[id]/run` just re-derives the exact `queries`/`params` body `POST /api/jobs` already accepts (cross-multiplying `findTerms`×`locationTerms` the same way the Extract page's own form does today — confirm and reuse that exact cross-multiply function rather than re-deriving it) and calls the SAME job-creation code path. This is the concrete payoff of the "AI automation ready" discipline noted back in Task 26 Piece 4: because job creation was always a plain, reusable REST call, "save these settings and let me re-run them" required no changes to `worker/automation.py` or the dispatcher at all — only a new small CRUD layer on top.

### UI (`app/dashboard/automations/page.tsx`, replacing the Piece 6 placeholder)

- List of saved Automations (name, find/location term summary via the same `summarizeQuery`-style compaction Task 26 Piece 1 already built — reuse it, don't write a second one), each with "Run now," "Edit," "Delete."
- "New automation" opens essentially the SAME form the Extract page's job-creation flow already has (find/location chips, engine, min/max results, duration, domain filter, result mode) — reuse that form's fields/validation, just save-instead-of-submit. Concretely: consider whether the Extract page's existing create-job form component can be extracted into a shared component both pages render (Extract: "run once", Automations: "save for later, run anytime") rather than maintaining two copies of the same field set — Cline's call once it's looking at the actual current form's structure.
- "Run now" calls `POST /api/automations/[id]/run`, which creates a real `SearchJob` (bumping `lastRunAt`/`runCount`) and redirects to `/dashboard/extract?job=<newJobId>` (or wherever the Extract page can deep-link to a specific job) so the user watches it the same way any other job runs — no separate "automation run" UI to build.

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

Per the direction already recorded in Task 26 (Piece 4's "ready for AI automation linking" note): SpaceWorker's agent is NOT going to stand up its own separate LLM provider/key management — it routes through Channelry's existing pooled Groq integration, with AI usage calculated per user. **This still needs its own confirmation pass before building** (not decided here, repeating the same flag from Task 26 deliberately since this is where it actually gets used): the exact API contract between SpaceWorker and Channelry's Groq integration, the auth/identification mechanism, and where the per-user usage ledger lives. Read Channelry's actual integration code directly before writing that contract down — don't let Cline guess at it.

### UI shape

- A chat-style panel on the Automations tab, alongside (not replacing) the manual list — "Ask the agent" as a second way to create an Automation/job, sitting next to "New automation."
- **Confirmation gate before any job actually runs** — matching the pattern already proven in Channelry's own "Agent Decider System" (per this session's memory: confirmation gates before content generation, an explicit approval step) rather than letting the agent fire off a 10,000-lead job unattended the first time it guesses at parameters. The agent proposes a plan (find/location terms, minResults, duration, estimated time) as a reviewable card; the user confirms or asks for changes before it actually calls `POST /api/jobs`.
- Once confirmed and the job finishes, the agent's own turn reports the outcome (leads found vs. requested, validation split) and, if mailboxes exist, offers the campaign-creation follow-up as its own confirmable step — never chains straight from extraction into a live send without a second explicit confirmation, since sending email is a much higher-stakes action than running a search.

## Explicitly out of scope, Part B

- Scheduled/trigger-based automation (cron-style "run this every Monday") — the placeholder text already on the current Automations page mentions this as a future idea; this plan only covers on-demand manual + agent-triggered runs, not a scheduler.
- Any agent capability beyond leads-extraction-then-optionally-campaign — no broader "general assistant" scope creep into this specific tab.
- Building the Groq/Channelry integration contract itself — flagged twice now (Task 26 and here) as needing its own dedicated pass grounded in Channelry's real code, not guessed at in either planning doc.

---

## How this fits with the currently-in-progress Task 26

No conflict: Task 26's Automations-tab placeholder (Piece 6) is exactly the landing spot Part B replaces once built. Task 26's "AI automation ready" REST-endpoint discipline (Piece 4's note) is precisely what makes Part B's agent layer thin instead of a rewrite. Nothing in Part A touches Task 26's files at all — it's a fully separate distribution channel. **Recommended order once Task 26 is stable**: Part B's manual automation builder first (it's the smaller, more self-contained piece and directly extends what's already shipped), then the two open-architecture questions above (EXE wrapper-vs-native, Groq/Channelry contract) get their own confirmation passes before either Part A or the agent half of Part B starts.
