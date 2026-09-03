# SpaceWorker — Plan

**Name confirmed.** Checked for conflicts: no real competing product found under "SpaceWorker" (the closest hits were unrelated aerospace/coworking-software companies with similar-but-different names). `spaceworker.com` is registered but parked on Afternic (for sale, not in active use) — launch on `.io`/`.app`/`.co` for now, revisit buying the `.com` later. ("SecureSpace," "WorkYard," "PipeCraft," "FlowForge," "ChainWorks," "FlowSpace," and "CloudChain" were all checked first and ruled out — either taken by real active companies, or in FlowForge's case, an actual trademark dispute that already forced a rebrand away from that exact name.)

## Context

The original idea was a browser + VPN + automation "cloud OS" — users buy space, connect to an isolated desktop. Research changed its shape substantially:

- **Kasm Workspaces is ruled out.** Its free Community Edition forbids commercial use entirely and caps at 5 concurrent sessions; commercial licensing runs ~$5–10/user/month against a market anchored at ~$9/month for antidetect browsers. It would have eaten the entire margin.
- **The current Contabo VPS cannot run microVMs at all.** Verified live via SSH: no `/dev/kvm`, no `vmx`/`svm` CPU flags exposed to the guest, no KVM kernel modules loaded. Contabo does not offer nested virtualization on VPS plans. Firecracker/Cloud Hypervisor/Kata all require `/dev/kvm` — **upgrading to a bigger Contabo VPS would not fix this; it needs a fundamentally different class of machine (bare metal).**
- **The automation is the actual product; the desktop is just one delivery mechanism for it.** And a working lead extractor already exists on this machine, closer to production-shaped than expected.

**Decision: build the automation tools first, on existing hardware, and defer the desktop/microVM layer until the tools are validated and funded by real revenue.**

## Locked decisions

1. **Target customer**: marketing/automation operators — lead extraction, filtering, and email outreach, with a later user-facing "chain builder" (extract → filter → send, and eventually arbitrary custom linking of steps).
2. **Phase 1 = tools only, no desktop, no microVMs, no proxies.** Web forms + background jobs, running on the current Contabo VPS.
3. **Interaction model**: web forms + queued background jobs, deliberately structured (see Data model) so a visual pipeline/chain-builder can be layered on top later without re-architecting.
4. **BYO everything reputational**: users bring their own SMTP mailboxes now, and (much later, if ever) their own proxies. The platform supplies tooling and orchestration; the user supplies the identity/reputation resources that carry real abuse/reputation risk.
5. **Separate product from Vantra**: own repo (this one), own database, own domain, own deploy. Shares *code patterns* copied from Vantra, not any runtime, database, or session.

## Why BYO SMTP is mandatory, not a preference

Verified via research: **SendGrid, Mailgun, and Resend all explicitly prohibit cold outreach, purchased lists, and scraped contact data** in their acceptable-use policies, and suspend accounts without warning for it. A single tenant with a ~2% spam-complaint rate can poison an entire shared IP pool's sender reputation.

**Vantra already uses Resend for its own transactional email** (signup/verification codes). Routing this product's outreach through that same Resend account risks damaging Vantra's email deliverability too — these must stay on completely separate ESP accounts, ideally different providers entirely. Resend (or similar) remains fine for *this* product's own transactional email (its own signup/verification) — that's not outreach, it's a different category the ToS never restricts.

The consequence: users must configure their own sending mailboxes with their own domains (SPF/DKIM/DMARC set up on their side). Safe volume is roughly 30–50 emails/mailbox/day — the existing extractor code already models this exact constraint.

## What already exists and gets reused (verified by reading the actual code, not assumed)

`/Users/mikeolab/lead-extractor` is meaningfully more production-shaped than a typical prototype:

- **Extraction logic is already decoupled from the Streamlit UI.** `app/main.py` imports zero scraper modules — it only talks to `app/server/automation_server.py` over a WebSocket. `AutomationManager.run_automation(query, params)` is already shaped as a plain function call, not tangled into UI callbacks.
- Uses async Playwright + headless Chromium. Defaults to DuckDuckGo (deliberately, to dodge CAPTCHA); Google is optional.
- **Drop-in reusable as-is**: `app/extractors/{email,phone,name}_extractor.py`, `app/filters/email_domain_rules.py` — clean library code with existing tests.
- **Email sending already exists** in `app/email/`: `smtp_pool.py`, `mailbox_pool.py` (multi-mailbox rotation with daily send counters), `rate_limiter.py` (jitter + per-mailbox caps). This is **already BYO-mailbox shaped**, which is exactly what the ESP-ToS constraint above requires.
- `hr-recruitment-extractor` (a sibling project) additionally has `app/enrichment/email_enricher.py` — MX lookup, contact-page crawling, ~15 email-pattern permutations, and **SMTP RCPT-TO verification without actually sending**. Worth harvesting later for a "scrutinize leads before sending" step — not required for Phase 1.

**The real gaps to close** (this is the actual Phase 1 engineering work, not a rewrite of what exists):
- **No tenant column anywhere** — `searches`/`leads` tables are per-installation, single-user.
- **A module-level singleton** holds mutable run state — only one job can run per process, with no isolation between users.
- **No auth at all** on the automation server's endpoints (`/ws`, `/stop`); CORS is wide open (`*`).
- Progress reporting is coupled to a WebSocket `broadcast(...)` call, not a clean injectable callback.
- Licensing is hardware-bound desktop licensing (`app/license/`) — completely irrelevant to a multi-tenant web SaaS; do not port any of it.

## Architecture

Three processes on the existing VPS:

**1. Python extraction worker** (adapted from the existing `automation_server.py`, not rewritten). Kept **stateless per job**: receives `(query, params)`, returns leads as JSON, and does **not** write to any database itself — that avoids the worker and the Next.js app ever needing to agree on one shared schema.
- `POST /jobs` → `{jobId}`; `GET /jobs/{id}` → status + partial/final leads; `POST /jobs/{id}/stop`.
- Refactor the module-level singleton into a per-`jobId` dict; replace the WebSocket `broadcast()` call with an injected progress callback the caller supplies.
- **Bearer-token auth, bound to localhost only** — never exposed through nginx to the public internet. Same posture already established for `MSI_GENERATOR_SECRET` and `TRMM_API_KEY` in Vantra.
- **Concurrency capped at exactly 1 headless Chromium instance** via `asyncio.Semaphore(1)` — this directly mirrors the `lib/generation-queue.ts` concurrency limiter already built and deployed for Vantra's installer-generation endpoint.

**2. New Next.js control plane** (this repo) — owns all user data, the canonical Prisma schema, billing, and the UI. Copies Vantra's auth/session/rate-limit/admin-passcode/crypto-payment patterns, adapted, not shared at runtime.

**3. Email sending, done natively in Node** inside the Next.js app (`nodemailer` against each user's own SMTP credentials), rather than porting the existing Python email stack. Rationale: `nodemailer` already handles SMTP/TLS correctly, this keeps the cross-language surface to exactly one service (the extraction worker), and it matches the rest of this app's stack. The Python module's actual hard-won value — per-mailbox rotation, daily caps, send jitter — is roughly a day of work to reimplement in TypeScript, and doing so avoids a second runtime just for sending mail. Draining the send queue needs a **systemd timer** hitting an internal authenticated route, since `next start` has no persistent background worker of its own.

## Data model (new Prisma schema, new Postgres database)

`User` (+ Vantra's auth-related fields, adapted) · `SearchJob` (userId, query, params, status) · `Lead` (userId, searchJobId, and the exact field shape the extractor already emits: email, phone, contactName, businessName, website, sourceUrl, snippet) · `Mailbox` (userId, host, port, username, **encrypted** password, dailyLimit, sentToday, active) · `EmailCampaign` · `EmailQueueItem`.

⚠️ **SMTP credentials must be encrypted at rest** (AES-256-GCM, key from an env var) — the original desktop app used the OS keyring for this, which has no multi-tenant web equivalent. This is genuinely new code to write, not something to port, and it must not be skipped or deferred.

Keep `SearchJob → Lead → EmailCampaign` as **separate, independently-addressable resources** from day one (a campaign is built by filtering "leads from job X"). That relationship shape is exactly what makes a later pipeline/chain-builder an additive feature instead of a rewrite.

## What gets reused directly from Vantra (adapted, not shared at runtime)

`lib/auth.ts` (jose JWT sessions) · `lib/admin-auth.ts` (fail-closed shared-passcode admin panel) · `proxy.ts` (the Next.js 16 `proxy` convention, replacing the deprecated `middleware.ts`) · `lib/rate-limit.ts` (DB-backed IP rate limiting) · `lib/email.ts` (Resend, for this product's own transactional email only) · **`lib/crypto-verify.ts` plus the whole `Payment`/`PaymentVerificationAttempt`/`AdminSetting` stack — the single biggest reuse win, copies near-verbatim** (BTC via blockchain.info, USDT-TRC20 via Tronscan, the ±5% tolerance band, auto-approve/flag-for-review logic) · `components/{ui,modal,toast}.tsx` · the systemd/nginx/certbot deploy pattern already proven on the Contabo VPS.

**Do not inherit** `lib/billing.ts`'s OpenNode integration — its own code comments self-document that the webhook HMAC signature was never verified against a real delivery. Go manual-crypto-only from the start here, same as Vantra ended up doing anyway.

## Resource math — why this needs zero hardware spend for Phase 1

Verified live on the VPS: **1954 MB used, 5616 MB available** of 7937 MB total (after the V5 privilege-hardening work). Python 3.10 is present; no desktop environment is installed.

| Addition | Cost |
|---|---|
| New Next.js app | ~100 MB |
| Python extraction worker (idle) | ~60 MB |
| Headless Chromium (only while a job runs, capped to 1 concurrent) | ~300–500 MB, transient |
| **Total** | **~500–650 MB** |

Comfortably inside the 5.6 GB available — and Vantra's V5 service-control panel provides ~620 MB more on demand if it ever gets tight (stopping MeshCentral/Celery/CeleryBeat/Daphne). **No hardware purchase is needed for Phase 1.**

## Phase 1 scope — cut ruthlessly

**In**: signup/verify/login · one extraction form + job runner + a results table · lead export (CSV) · mailbox CRUD with a live connection test · one campaign type (pick leads → template → send with rotation and daily caps enforced) · a queue-drain systemd timer · manual crypto billing (BTC + USDT-TRC20, copied from Vantra) · an admin panel (users/payments/wallets, copied from Vantra's pattern).

**Out** (explicitly deferred): the desktop/cloud-workspace product entirely · microVMs · bundled or BYO proxies · the visual chain/pipeline builder · lead enrichment/verification (RCPT-TO checks) · multi-node deployment · team/multi-seat accounts.

Rough effort, solo operator + AI coding assistant: worker adapter 1–2 days · Next.js scaffold copied from Vantra's patterns 2–3 days · schema + extraction flow 3–4 days · mailboxes + campaigns + send queue 4–5 days · billing + admin panel 1–2 days · end-to-end QA 2 days → **roughly 3 weeks total.**

## Verification (end-to-end)

1. **Tenant isolation is the #1 regression risk** — create two accounts, confirm account A cannot see account B's leads, jobs, mailboxes, or campaigns under any circumstance.
2. Run a real extraction; confirm leads land scoped to the correct user, and confirm headless Chromium is genuinely capped at one concurrent instance (watch it live in Vantra's own VPS admin tab, which already shows top-processes-by-memory).
3. Add a real mailbox; the connection test must actually succeed/fail correctly; send one small real campaign and confirm per-mailbox daily caps and inter-send jitter are actually enforced, not just configured.
4. Confirm the extraction worker is completely unreachable from the public internet, and rejects any request that's missing the bearer token.
5. Kill the worker process mid-job; confirm the UI reports a clean failure state rather than hanging indefinitely.
6. Run one full crypto payment → premium unlock, reusing Vantra's already-verified flow end-to-end.

## Phase 2+ (deferred until Phase 1 is validated and funded) — the cloud workspace

This research is retained here so it isn't re-derived from scratch later:

- **Buy bare metal, not a bigger VPS.** Target spec: ~64 GB RAM, 2×1 TB NVMe mirrored, roughly €50–70/month to start. **Avoid Hetzner specifically** — their published system policies and enforcement track record make them a poor fit for this audience; prefer OVH or Contabo's dedicated (not VPS) line. The scaling unit is roughly one node per ~150 users; users are pinned to whichever node holds their storage.
- **Incus + KVM/QEMU on ZFS, not raw Firecracker.** Incus is Apache 2.0 and effectively *is* the orchestration layer (REST API, VM lifecycle, ZFS-backed quotas, snapshots) that would otherwise take months to hand-build. Firecracker has no virtio-fs support and only accepts raw disk images (no qcow2/backing files); its 125ms boot time is irrelevant for long-lived, stateful, rarely-rebooted VMs.
- **One VM per user, in two power states — not two separate VMs.** Idle footprint ~350 MB; the desktop is started as a stoppable `systemd` target and the VM is memory-ballooned up to ~3 GB only while a user is actively connected. This design makes an "always-on automation runner" inherent rather than a separate feature to build, and it **completely eliminates the shared-storage corruption problem** that a two-VM design would create (browser profiles are SQLite databases plus lockfiles; two separate guests writing one shared filesystem tree is a genuine, not theoretical, corruption hazard).
- **TigerVNC + noVNC + a small custom WebSocket broker.** Deliberately skip Apache Guacamole — `guacd` is only a protocol translator and still requires a real VNC server running inside the guest, so it adds a Java/Tomcat runtime and a second, separate auth model without actually removing any work. Selkies (MPL 2.0) is a legitimate later quality upgrade once this is running.
- **Egress must be enforced host-side and fail-closed, never left to in-guest configuration.** Per-workspace network namespace, `nftables` default-DROP as the baseline, all outbound port-53 DNS traffic force-DNAT'd to a local resolver that itself forwards over TCP/DoT through the user's configured proxy, IPv6 fully disabled inside each guest, and a locked-down WebRTC policy. In-guest proxy settings are advisory only, since the tenant has full root inside their own VM — the enforcement point has to live entirely outside their control.
- **MicroVMs do not solve the browser-fingerprinting problem, and this must not be oversold to customers.** A CPU-rendered browser reports `llvmpipe` or `SwiftShader` as its WebGL renderer string, which is one of the most reliable automated bot-detection signals in production use today. **Position this product as "isolated, always-on automation environments with host-enforced BYO egress" — never market it as an antidetect-browser replacement.** If a prospective customer's first question is "will this pass Meta's/Google's detection," the honest answer is no, and that should end the sales conversation rather than be talked around.
- Rough proxy economics for later reference: static residential IPs run about $4/IP/month; rotating residential proxies run about $3/GB (with Bright Data/Oxylabs pricing $8–15/GB for the same category).

## Open questions

- **Product name** — genuinely undecided; needs a real answer before any public-facing work (domain, branding) begins.
- Whether to pull in `hr-recruitment-extractor`'s email-verification code for a "scrutinize leads before sending" step now, or defer it past Phase 1.

---

## Addendum — priority queue, per-user isolation, lightweight tooling, and a per-user browser stepping stone

Added after further discussion. This section revises and sharpens Phase 1's architecture; the sections above still hold except where superseded here.

### Users configure and run tools from the portal — made explicit

Phase 1's "web forms + background jobs" already meant this, but to say it plainly: the portal is not a fixed one-shot extraction form — every tool (extraction today, email sending today, more tools later) is something a signed-in user configures with their own parameters and runs on their own schedule. This is the same posture the later "custom linking"/chain-builder idea needs, just without the chain-builder yet. Nothing in the architecture below is Vantra-specific reuse; it's this product's own control plane.

### Priority queue: admin-assigned tiers, not self-service, not payment-automated

**Decision**: `User.tier: Int @default(0)` (higher = higher priority) — a plain admin-editable field, set manually by the operator based on what a user has paid, exactly like Vantra's `isStaff` is set manually rather than self-service. **No automatic tier-from-payment-amount logic** — the admin panel just needs a way to view/edit a user's `tier`, nothing fancier. This intentionally mirrors Vantra's "admin decides, not the system" pattern rather than inventing a pricing-tier state machine before there's real usage data to design one from.

**The queue lives in Postgres, in the Next.js app — not in the Python worker.** The worker stays a dumb, stateless executor (`(query, params) → leads`, per the original design); it has no concept of users, tiers, or ordering. All prioritization intelligence belongs where the user/tier data already lives.

```prisma
model JobQueueEntry {
  id           String   @id @default(cuid())
  userId       String
  user         User     @relation(fields: [userId], references: [id])
  searchJobId  String   @unique
  priorityTier Int      // snapshotted from user.tier AT ENQUEUE TIME — a later tier change
                         // must not reorder a job that's already sitting in the queue
  lane         String   // "light" | "heavy" — see below
  status       String   @default("queued") // "queued" | "running" | "done" | "failed"
  createdAt    DateTime @default(now())

  @@index([lane, status, priorityTier, createdAt])
}
```

A small dispatcher (the same systemd-timer style already used for the email send-queue drain) runs every few seconds: for each lane with a free worker slot, pop the queued entry with the highest `priorityTier` (ties broken by oldest `createdAt` — plain FIFO within a tier), mark it `running`, POST it to the worker's `/jobs` endpoint, and poll `/jobs/{id}` until done. **Snapshotting `priorityTier` at enqueue is deliberate** — if the admin bumps someone's tier while their job is already queued, that job keeps the priority it was queued with; only jobs queued *after* the change get the new tier. Simple, predictable, no surprise reordering to explain to a customer mid-wait.

### Two queue lanes, not one — "a queue for tasks that require too much RAM"

Rather than one global concurrency-1 semaphore (the original Phase 1 sketch), split into **`light`** and **`heavy`** lanes, each with its own independent concurrency cap:
- **`light`**: quick jobs (small result-count target, single query). Cap: 1 concurrent, always available — this is what most jobs will be, and it must never sit blocked behind a heavy job.
- **`heavy`**: broad/deep jobs (large result-count target, multi-query). Cap: 1 concurrent, separate from light's slot.

Total worst-case concurrency is 2 headless Chromium instances instead of 1 — roughly 600MB–1GB instead of 300–500MB at peak, still comfortably inside the VPS's available RAM. **The lane is a user-facing choice at job-creation time** ("Quick" vs "Deep" on the extraction form), not a backend heuristic guessing at job cost — transparent, and the user directly trades speed-of-turnaround for depth-of-search. A heavy job never blocks a light one from a different user; that's the entire point.

### Lightweight tooling — a concrete, verified conversion opportunity, not a vague goal

Read the actual extractor code (`app/server/automation_server.py`) rather than assuming: **the DuckDuckGo path already hits `https://html.duckduckgo.com/html/?q=...`** — DuckDuckGo's genuine static, non-JS HTML endpoint (that's specifically *why* it avoids the CAPTCHA the Google path hits — the code's own comment says so: "🦆 DuckDuckGo (no CAPTCHA)"). Today this static page is loaded through a full Playwright/Chromium navigation and DOM-scrape anyway. **This is a real, low-risk lightweight-conversion target**: replace the DuckDuckGo path with a plain `requests.get()` + BeautifulSoup parse of the same URL (the CSS selectors already documented in the code — `.result`, `.result__a`, `.result__url` — work identically against the raw HTML, no browser needed to read them). This would drop the DuckDuckGo path's cost from ~300–500MB (a Chromium instance) to single-digit MB (an HTTP client), for what's already the default, no-CAPTCHA, most-used search path.

**Before committing**: live-test that a plain HTTP GET (normal browser User-Agent header) against `html.duckduckgo.com` returns the same result HTML a Playwright-rendered page would — high confidence given the endpoint is deliberately built for exactly this kind of client, but verify rather than assume before ripping out the browser dependency for this path.

Google search stays on Playwright (it needs a real browser to navigate CAPTCHA challenges, per the code's own existing handling) — this conversion only applies to the default DuckDuckGo path, which is also the one most users will use most of the time. Net effect: **most jobs likely won't need Chromium at all**, and the `light`/`heavy` lane concurrency caps above become a ceiling for the rarer Google-path and future browser-dependent tools, not the common case.

### Per-user data isolation — "a wall to guide each user's data" (since full per-user VMs aren't feasible yet)

The Phase 2+ cloud-workspace product (deferred, see below) solves tenant isolation via real VM boundaries. Until that exists, Phase 1 runs every user's job on the same shared worker process, so isolation has to be enforced deliberately at the filesystem level, not assumed:

- **Every job gets its own throwaway temp directory** (`/tmp/jobs/{jobId}/`), created fresh at job start and deleted immediately after the job ends (success or failure) — never reused across jobs, never shared across users.
- **No persistent shared browser state.** Each job launch gets a fresh, temporary browser profile/context — never a long-lived shared one that could carry one user's cookies, cache, or login session into a different user's job. (This is deliberately distinct from the per-user *persistent* profile described next — that's opt-in and explicitly per-user, never shared.)
- **Output files (exported leads, etc.) are written per-user**, never to a shared path, and a user can only ever read files the API layer explicitly scoped to their own `userId` — the existing Prisma-level tenant scoping (every query filtered by `userId`) is necessary but not sufficient on its own once real files exist on disk; the filesystem layer needs its own matching discipline.

None of this requires new infrastructure — it's a discipline to hold Cline to when this gets built, the same way "never trust a client-supplied path/ID without re-checking ownership" has been the standing rule everywhere else in this project.

### A middle ground short of full VMs: per-user *persistent* browser profiles

The eventual cloud-workspace product (Phase 2+, still deferred) gives each user a real, fully isolated VM. That's a large, hardware-gated undertaking. But there's a genuine middle ground worth building **before** that, once Phase 1's basic queue is working:

**Give each user their own persistent browser profile directory** (Playwright supports `launchPersistentContext(userDataDir, ...)` for exactly this) — not a VM, not a separate OS, just a per-user folder on the same shared worker box holding that user's own cookies, logged-in sessions, and browser state, reused across their jobs instead of starting fresh every time. This is what "a way to make a browser available for each user" can concretely mean *before* real per-user VMs exist:
- **First use per user is slower** — the profile has to be created and (if the user's workflow needs it) any manual login step completed once. Exactly the "even if it takes a longer process creating for each user the first period" tradeoff already anticipated — this is expected and fine.
- **Every use after that is fast** — the worker launches Chromium pointed at that user's existing profile directory, already warmed up.
- **Isolation stays intact**: a user's persistent profile is used *only* for that user's own jobs, on the same "one throwaway temp dir per job" discipline above for anything else the job touches — the persistent profile is the one deliberate, explicit exception, not a loosening of the rule.
- This is real infrastructure work (profile provisioning, storage growth per user over time, a cap on total profile-directory disk usage, cleanup for abandoned/inactive accounts) — it's a **Phase 1.5**, after the queue/lanes/lightweight-conversion above are working and validated with a real paying user, not bundled into the very first release.

### An off-switch for this whole project, mirroring Vantra's V5 service controls

Once this runs as its own systemd service(s) alongside Vantra/TRMM/MeshCentral on infrastructure Claude manages, stopping it if it strains shared resources is **already possible today with zero new engineering** — `systemctl stop` on its service(s) over SSH, the same lever already used throughout this project. No dedicated UI is needed for Phase 1 (there's no real user base yet to justify building one). If/when it's actually needed, the exact pattern already proven for Vantra (`lib/services-control.ts`, the admin VPS tab's Services section, a narrow sudoers allowlist) is directly reusable here — same shape, different service names. Worth having in mind, not worth building yet.

**Hard requirement, confirmed with the user 2026-09-03 — do not deploy Task 2 as part of the main Next.js process.** The main app (`spaceworker.service`, deployed and live at `spaceworker.instaweb.top`) must stay a single lightweight process with no real browser/Chromium footprint of its own — Task 6's browser-*profile* management is just directory/DB bookkeeping (no running browser at rest), so there is currently nothing RAM-heavy to toggle off. Task 2's actual Playwright/Chromium worker is where real browser processes will run, and it **must be deployed as its own separate systemd unit** (e.g. `spaceworker-worker.service`), never folded into the Next.js process — this is exactly what already-written `TASK_02_EXTRACTION_WORKER.md` specifies (`POST /jobs` API wrapper, bound to `127.0.0.1`, bearer-token gated, a distinct process from the app) and needs to stay true at deploy time, not just on paper. This is what lets the user stop just the browser-automation worker (freeing the RAM Chromium instances consume) while mailboxes/campaigns/billing/admin — none of which need a browser — keep running uninterrupted. Once Task 2 actually deploys, add `spaceworker-worker.service` to Vantra's shared `lib/services-control.ts`/`CONTROLLABLE_UNITS` allowlist (same mechanism already extended to cover `spaceworker.service` itself) so both the app and the worker are independently toggleable from the same shared instaweb admin panel.

### Updated Phase 1 scope (supersedes the earlier version)

**In**: everything the original Phase 1 scope already listed, **plus**: the `light`/`heavy` two-lane priority queue (admin-settable `User.tier`, snapshotted priority, dispatcher), and the DuckDuckGo-path lightweight conversion (verify-then-ship).

**Still out** (unchanged): the desktop/cloud-workspace product, proxies, the visual chain-builder, lead enrichment/verification, multi-node, teams.

**New, explicitly Phase 1.5, not Phase 1**: per-user persistent browser profiles.

Revised rough effort: the queue/lane/dispatcher work adds roughly 3–4 days on top of the original ~3-week estimate (mostly the `JobQueueEntry` model, the dispatcher loop, and wiring the lane choice into the extraction form) — call it **~3.5–4 weeks** for Phase 1 as now scoped.

---

## Addendum 2 — Product reframing (OS not "just automation"), real mailer-system research, landing page, dashboard fixes

**Status: captured 2026-09-03 from live product feedback after using the deployed app, NOT yet scoped into task specs for Michael/Cline.** Michael has a pending push (an unfinished job, not yet up) that likely touches the mailbox/campaign area this addendum redesigns — deliberately holding off on final task specs for that part until his push lands, so the spec is written against what actually exists rather than needing an immediate rewrite. The rest of this addendum (landing page, dashboard nav/OS-framing, browser-profiles tab) has no such dependency and can be scoped independently.

### 1. Product framing correction — SpaceWorker is a lightweight private-browser platform, not "an automation tool"

The user's correction, verbatim in spirit: SpaceWorker isn't just lead-extraction-plus-email-automation — it's a **private browser running on lightweight infrastructure**, with automation as one capability riding alongside a growing set of others (Task 6's per-user persistent Chrome profile is the seed of this, not a side feature). This changes how the landing page should pitch the product (lead with "your own private browser workspace," automation as a feature under that, not the headline) and how the dashboard should be structured (see §3 — an OS-style home, not a two-card feature list).

### 2. Landing page — needs a real design pass

Current `app/page.tsx` is a bare title + description + two buttons (adequate for Task 1's scaffolding purpose, not for showing the product). This needs an actual design pass reflecting §1's repositioning — hero section pitching the private-browser-workspace framing, a feature grid once more features exist to show (currently just Mailboxes/Campaigns/Browser Profiles — thin, but real), no fabricated testimonials/pricing (no real customers yet, same discipline already applied to Vantra's landing page work). **Recommend doing this as a design-canvas pass** (mirroring how Vantra's V3 did its landing-page and device-detail-tab mockups before implementation) once the dashboard reframing in §3 is settled, since the landing page should reflect what the product actually looks like once logged in.

### 3. Dashboard is not "explicit" enough — missing nav, OS-style framing

Two concrete bugs plus one larger direction:

- **Bug**: Task 6 (Browser Profiles) is deployed (`app/dashboard/browser-profiles/page.tsx` exists and works) but there is **no sidebar nav entry for it** — `components/dashboard-nav.tsx` only lists "Overview" and "Settings". Same gap for Mailboxes and Campaigns — they're only reachable via the two cards on the Overview page, not the sidebar. Fix: add Mailboxes, Campaigns, and Browser Profiles as real sidebar nav items (small, mechanical fix, not blocked on anything below).
- **Direction**: the user wants the dashboard to open like an OS desktop/start screen — a menu-driven home showing available "programs" (Mailboxes, Campaigns, Browser, future tools), not a generic SaaS dashboard. This is a real design decision, not a one-line fix — needs a design-canvas pass (same recommendation as §2) once the tool roster is clearer (right now: Mailboxes, Campaigns, Browser Profiles, and eventually the lead extractor once Task 2 lands). Don't over-build this before Task 2/3 exist — an OS-style shell for 2–3 tools risks feeling empty; revisit sizing once the extractor is live.

### 4. Mailer/campaign system — research findings and what a real BYO-SMTP sender needs

Task 4 as originally built (`Mailbox` + `EmailCampaign` + `EmailQueueItem`) covers "connect one SMTP mailbox, send one fixed subject/body to a fixed list" — real cold-email tools (Instantly, Smartlead, Woodpecker, Reply.io — [sources below](#sources)) collect and automate considerably more. Research findings, then a prioritized cut.

**What real tools collect/support (comprehensive, before prioritizing):**
- **Recipient list**: CSV upload, not a plain email array — with arbitrary custom columns (first name, company, job title, industry, custom fields) available as merge variables in the template, not just `toEmail`.
- **Template content**: subject **and** body support merge variables (`{{firstName}}`, `{{company}}`, etc.) and optionally **spintax** (`{Hi|Hello|Hey} {{firstName}}`) — each recipient gets one randomly-resolved variation, reducing exact-duplicate fingerprinting across a large send without changing the actual message/goal.
- **Multiple senders per campaign, rotated across the send** — not just today's sequential multi-*run* model (Run 1 fully from Mailbox A, then Run 2 fully from Mailbox B) but true interleaved rotation across a single run's recipient list, spreading volume across mailboxes as it sends (this is the mechanism the user described as "switch between senders... without changing the goal").
- **Multiple subject/body variants per campaign** (A/B or full rotation) — per the same "switch between subjects... without changing the goal" request. Real tools' A/B flow: send a small sample (~30%) with different variants, pick a winner by open-rate after a delay, send the remainder with the winner — a reasonable default if full manual control isn't wanted, but manual "just rotate evenly" should also be a supported mode since open-rate tracking needs a tracking pixel (privacy/deliverability tradeoff worth deciding deliberately, not assumed).
- **Sending-account warmup** (gradual volume ramp-up on a newly-connected mailbox) — most tools run this for weeks before a mailbox is trusted for real campaign volume. Real infrastructure (a warmup network of other mailboxes exchanging emails to build reputation) — likely **out of scope for SpaceWorker's own Phase 1** (this product doesn't own a warmup pool), but worth at minimum warning the user in-product if a newly-connected mailbox is being used for full-volume sending on day one.
- **Deliverability/inbox-placement monitoring via seed lists**: a set of real, monitored test mailboxes across major providers (Gmail, Outlook, Yahoo, iCloud) that periodically receive a copy of the live campaign message; an automated check (IMAP or provider API) reports which folder it landed in (inbox / spam / promotions) per provider.
- **Bounce/complaint handling**: hard bounces (SMTP 5xx) remove the address from future sends immediately; soft bounces (4xx) retry with backoff; spam complaints (where visible, e.g. via a feedback-loop or via noticing a seed mailbox flags it) should reduce sending volume or pause, not just log-and-continue.

**The automation behavior the user specifically asked for** (test-send-confirm, then monitor-and-pause-on-spam-signal) maps directly onto the seed-list pattern above:
1. **Before a campaign's first real send**: send one test message via the connected mailbox to one or more of SpaceWorker's own monitored seed mailboxes (platform-provided, not the customer's — same reasoning as Vantra's own transactional-email account being separate from customer mailboxes). Poll the seed mailbox via IMAP after a short delay; confirm the message actually arrived (proves the SMTP credentials genuinely deliver, not just that `nodemailer.send()` didn't throw — a message can be "sent successfully" from the sender's point of view and still never arrive, per Task 4's original scope note that `verify()` only proves the SMTP handshake, not delivery). **User-confirmation mode**: surface this result to the user and require an explicit "yes, this delivered, proceed" click before the real campaign starts (safer default, matches "first it tries to send a first message to be sure it gets delivered, when user confirms... automation can go ahead"). **Fully-automated mode**: skip the manual click, just confirm arrival on the seed mailbox program­matically and proceed automatically — offer both, default to manual confirmation for a new/never-tested mailbox, allow automatic for a mailbox with a proven track record.
2. **During the campaign**: after every N real sends (a configurable checkpoint, e.g. every 20–50), send another test message to a seed mailbox and check its placement (inbox vs. spam) the same way. If a checkpoint check lands in spam, **pause the campaign** (flip the run to a new `paused_deliverability` status, stop the drain from picking up more items from it) and surface a flag to the user — do not silently keep sending. Auto-resume is explicitly **not** proposed here (the user's own words leave room for "the automation... tries to make another judgment on what to change" — but deciding *what* to change algorithmically, e.g. swap sender vs. swap subject vs. slow down pacing, is a real judgment call that deserves a follow-up design pass, not guessed at in this addendum) — safe default: pause + notify, let the user (or a later, more deliberately-designed auto-remediation pass) decide the next step.
3. **Seed mailboxes are SpaceWorker's own infrastructure**, not the customer's — likely 3–5 real accounts across Gmail/Outlook/Yahoo that the platform owns and polls via IMAP (`imapflow` or `node-imap`, whichever has better maintenance status at implementation time — check before picking). This is a real new operational dependency (accounts to create and maintain, IMAP polling infrastructure, credentials to store) — flag as a cost/effort item when this gets scoped into an actual task, not a free addition.

**Proposed priority cut (nothing left as a silent "later" without saying so):**

| Tier | Feature | Reasoning |
|---|---|---|
| **Must have (Phase 1 of this rework)** | CSV recipient list w/ custom merge variables | Table stakes — today's plain `toEmails: string[]` can't personalize at all. |
| **Must have** | Multiple subject + multiple body variants per campaign, simple rotation (not full A/B open-rate automation) | Directly requested ("switch between subjects... html files"); rotation alone (round-robin or random) is far simpler than open-rate-driven A/B and delivers the "vary the surface, keep the goal" outcome without needing tracking pixels yet. |
| **Must have** | True sender rotation within a single run (not just sequential multi-run) | Directly requested; reuses the existing per-mailbox daily-cap logic, just changes the drain's mailbox-selection strategy from "one run = one mailbox" to "round-robin across the run's assigned mailboxes." |
| **Must have** | Test-send-then-confirm before first real send (manual-confirm mode) | Directly requested, and the cheaper of the two automation asks — needs one seed mailbox + one IMAP poll, not ongoing monitoring infrastructure. |
| **Should have (Phase 1.5 of this rework)** | Checkpoint deliverability monitoring + auto-pause | Directly requested ("fully automated" variant) — needs the seed-mailbox *infrastructure* (multiple accounts, IMAP polling scheduler) that the must-have test-send only needs once; more operational cost, do after the simpler version is proven. |
| **Should have** | Bounce handling (hard bounce → remove from list, soft bounce → retry w/ backoff) | Standard hygiene every real tool has; not explicitly requested but directly supports the "don't get flagged" goal — skipping it risks exactly the reputation damage the user is trying to avoid. |
| **Nice to have, explicitly deferred** | Spintax within subject/body text (not just whole-variant swapping) | More surface-level variation than whole-variant rotation gives, but adds real UI/parsing complexity (spintax syntax, preview rendering) — defer until whole-variant rotation is shipped and proven insufficient. |
| **Nice to have, explicitly deferred** | Open-rate-driven automatic A/B winner selection | Needs a tracking pixel (a real deliverability/privacy tradeoff to decide deliberately) and is strictly more complex than simple rotation — defer. |
| **Explicitly out of scope** | Owning a warmup network/pool | Real infrastructure investment (a pool of mailboxes that must themselves stay healthy) disproportionate to this product's current stage — a mailbox's own warmup (if any) happens on the customer's side, outside SpaceWorker. |

### 5. Data model implications (draft — do not finalize until Michael's pending push lands and this can be reconciled against it)

Sketch only, to size the work — the real Prisma diff should be written once Michael's current state is known:
- `EmailCampaign` needs a collection of subject/body **variants** (a new `CampaignVariant` model: `id, campaignId, subject, bodyHtml`) rather than the single `subject`/`bodyHtml` fields it has today, plus a `mailboxIds: String[]` or a join table for "which of the user's mailboxes are in this run's rotation."
- `EmailQueueItem` needs recipient-level merge-variable storage (a `variables: Json` column, populated from the uploaded CSV's extra columns) and a `variantId`/`mailboxId` recording *which* variant/sender it was actually resolved to at send time (needed for later analysis — "did variant B convert better").
- A new `SeedMailbox` model (platform-owned, not per-customer) for the seed/monitor accounts, and a `DeliverabilityCheck` model logging each checkpoint test (campaign, seed mailbox, folder result, timestamp) for audit/debugging — mirrors the existing `PaymentVerificationAttempt` audit-trail pattern already used in Task 5.
- `EmailCampaign`/`CampaignRun` needs a `paused_deliverability` status distinct from today's `draft`/`queued`/`sending`/`done`.

### Sources

- [Instantly / Smartlead deliverability feature comparison](https://www.mailreach.co/blog/email-deliverability-tools)
- [Cold email software rankings, 2026](https://smartreach.io/blog/best-cold-email-tools/)
- [Spintax explained](https://instantly.ai/blog/spintax/)
- [Cold email A/B testing mechanics](https://www.smartlead.ai/blog/cold-email-ab-testing)
- [Spintax + dynamic variables at scale](https://outboundpros.io/blog/spintax-dynamic-variables-cold-email)
- [Email seed lists explained](https://www.warmforge.ai/blog/email-seed-list)
- [Seed list inbox-placement testing](https://www.rejoiner.com/resources/seed-list-testing)
- [Seed list testing — when it helps](https://www.mailneo.co/blog/seed-list-deliverability-testing)

### Next steps (not started — waiting on the items below)

1. **Waiting on Michael's pending push** before finalizing §4/§5 into an actual Cline/Michael task spec — his current unfinished work likely touches this exact area; rewriting the mailbox/campaign data model out from under an in-flight change would create a merge headache. Re-scope once it lands.
2. **Waiting on Task 2 (extraction worker)** before sizing §3's OS-style dashboard — the "programs" list is thin (3 tools) until the extractor ships.
3. Landing page (§2) and the nav/OS-framing dashboard fix (§3's bug half) have no blocking dependency and could be scoped independently if wanted before the above land.

## Addendum 3 — A third, distinct pillar: the user-facing private/anonymous browser (NOT Task 2, NOT headless)

**Status: captured 2026-09-03, researched, NOT scoped into a task spec yet — needs two real cost/tooling decisions from the user first (proxy provider, streaming tech).** This clarifies real confusion risk between three genuinely different things that all involve "a browser," easy to conflate:

- **Task 2 (extraction worker)**: a Playwright/Chromium instance the *scraper* drives, headless, no visible UI — stays exactly as already scoped in `TASK_02_EXTRACTION_WORKER.md`. **Confirmed with the user: do not add any visible/streamed browser UI to Task 2** — same headless-only posture the existing lead-extractor app already uses; users never see this browser, they only see extracted results.
- **Task 6 (browser profiles, Phase 1)**: persistent Chrome **profile directories** so Task 2's headless scraper can reuse cookies/sessions across a user's jobs. Backend infrastructure only, no user-facing browser — deployed and live, unchanged by this addendum.
- **This addendum, a new third thing**: a genuinely **interactive, user-facing browser session** — the user actually sees and drives a real browser, streamed to them in the SpaceWorker dashboard, routed through a **dedicated/sticky IP** so their activity in it isn't linkable to their real network origin. This is the concrete form of the "SpaceWorker is a private browser platform" framing from Addendum 2 §1 — not a metaphor, an actual feature.

### Research — how real "anti-detect"/private-browser products architect this ([sources below](#sources-3))

Two separable layers, always used together in serious tools (GoLogin, AdsPower, Multilogin, and the newer cloud-native entrant GeeLark):

1. **Fingerprint/session isolation** — one profile (cookies, localStorage, extensions, canvas/WebGL fingerprint) per user, never shared or reused across users. **This is exactly Task 6's existing persistent-profile-directory design** — the same `/mnt/browser-profiles/{userId}/` mechanism already built for Task 2's headless reuse is the correct foundation for this feature too, just launched **non-headless** (or headless-with-a-virtual-display) instead of fully headless, and reused for interactive sessions instead of scraper jobs. Task 6 does not need to be rebuilt — it needs a second consumer.
2. **Dedicated/sticky IP per profile, via a proxy** — critically, "dedicated IP" in every real product in this space means a **sticky residential or mobile proxy IP** purchased from a proxy provider (Bright Data, Oxylabs, IPRoyal, Smartproxy, and similar), not literally provisioning unique network interfaces per user on our own infrastructure (infeasible on a shared VPS, and not how any competitor actually does it either). Two profiles sharing one IP get correlated regardless of how well their fingerprints differ — proxy assignment per profile is load-bearing, not optional polish.
3. **Delivery mechanism — the newer, more relevant model**: GeeLark's cloud-phone approach (no local install — a real instance runs on the provider's own server, the user connects via **screen streaming with input forwarding** through a web dashboard) is architecturally the right model for SpaceWorker, since this needs to live *inside* the existing web dashboard, not ship as a separate downloadable desktop app the way GoLogin/AdsPower/Multilogin do. Concretely: a real Chrome/Chromium instance runs server-side (with a virtual display, e.g. Xvfb, since it needs to actually render pixels to stream — not the same as Task 2's fully headless mode), and its screen streams to the user's actual browser tab via WebRTC or VNC-over-websocket, with mouse/keyboard forwarded back — the same *category* of remote-interaction problem Vantra already solved for whole-device remote desktop via MeshCentral, just pointed at a single browser process instead of a whole OS.

### Two real decisions needed before this can be scoped into a task spec (do not guess at either)

1. **Proxy/IP provider.** This is a real, ongoing per-user cost (residential/mobile proxy bandwidth is priced per-GB or per-IP by every provider in this space) — needs the user to pick a provider and confirm the cost model fits SpaceWorker's pricing before any integration work starts. Not a free feature to add.
2. **Streaming technology.** Candidates worth evaluating (not yet compared in depth): a self-hosted open-source browser-streaming server (e.g. Neko/`n.eko`, purpose-built for exactly this "stream one browser tab with input forwarding" problem, or Kasm Workspaces, a broader open-source remote-browser-isolation platform) vs. a lighter custom build on top of Chrome's own remote-debugging/CDP screencast protocol. Each has different resource cost (RAM/CPU per concurrent streamed session) and integration effort — needs a real spike/comparison before committing, not a guess.

### Resource/scope reality check (say this plainly, not optimistically)

Running a real, non-headless, screen-streamed browser per active user is **meaningfully heavier** than Task 2's headless scraping (a virtual display plus a streaming server per session, versus a scraper process that exits when its job finishes) — this is not "the same infrastructure, slightly repurposed," it's a genuinely bigger per-active-user resource commitment, and needs its own capacity planning (likely a small number of concurrent interactive sessions supported at launch, not unlimited) rather than assuming it fits on the same box for free once Task 2/6 exist.

### Explicitly not started

No Prisma model, no route, no UI sketch yet — this addendum is scoping-and-research only, deliberately, until the proxy-provider and streaming-tech decisions above are made. Once decided, this becomes its own task spec (likely its own `TASK_07_*.md`), sized and assigned separately from Task 2/3 (Cline/Michael's current backlog) — not bundled into either.

### Sources {#sources-3}

- [Antidetect browser proxy/fingerprint architecture, 2026](https://dataimpulse.com/blog/top-antidetect-browsers-of-2024/)
- [Best proxies for antidetect browsers](https://blog.send.win/best-proxies-for-antidetect-browsers-2026/)
- [GeeLark cloud-phone/cloud-browser architecture](https://www.geelark.com/product/antidetect-browser/)
- [GeeLark remote control / streaming model](https://www.geelark.com/glossary/remote-control/)
