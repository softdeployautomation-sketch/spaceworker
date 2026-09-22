# PLAN (NOW) — Task 89 rev2: SpaceWorker Assistant + Cyber Lab staff track

**Status: FINALIZED (2026-09-22) — owner + Michael feedback integrated
(Browser Clone directive). Ready for task creation.**
**Date: 2026-09-22. Merges old PLAN_TASK_89 (device agent) + PLAN_TASK_91
(cyber lab). The AI model / GPU / training work moved to
`PLAN_LATER_OWN_AI_GPU_TRAINING.md` (funded phase) — nothing here blocks on it.
The agent brain stays Channelry (Task 31) until the LATER plan lands.**

**Owner's priority directive (2026-09-22, updated with Michael's reply):** top
priority is (1) the Assistant getting its Vantra plugin, (2) the **Browser
Clone** — moving the user's browser environment to a hosted SpaceWorker PC so
the agent acts as the user while they're away, including checking email
**while the device is turned off** (replaces the old cookie-vault idea per
Michael), (3) wake-on-LAN so the agent can reach the device. These come
first; everything else follows.

**DELIVERY SURFACE RULE (owner correction 2026-09-22 — read before building):**
- **Everything in this plan ships in the `spaceworker.top` WEB app.** Users
  sign up on the web and use every feature there. There is NO SpaceWorker
  Assistant EXE — none exists, none is scoped in this plan.
- The only EXEs in the ecosystem: (a) the **SpaceWorker extractor EXE** —
  the separate lead-extraction product, unchanged by this plan; (b) the
  **Vantra agent/EXE** — the wrapper that connects a device to our end
  (RMM agent). Device-side actions in this plan (cookie capture, keep-awake,
  WoL relay, telemetry, remote ops) ride the **Vantra agent**, never a
  SpaceWorker EXE.
- A standalone SpaceWorker/Assistant EXE is a **later decision**, taken only
  after all web features are grounded and working. Not designed here, not
  guessed at here.

---

## PRIORITY TRACK (build first, in this order)

### P1 — Vantra plugin (Assistant gets device powers)
- Server-side provisioning: every SpaceWorker user who enables the Assistant
  gets an auto-created Vantra org (`sw-<userId>`) registered in the Task 82
  per-org agent allowlist; link + tokens stored in `VantraLink`
  (orgId, agentTokenEnc, status) — server-only, never to the client.
- Device linking: the user installs the **Vantra agent** on their PC via a
  SpaceWorker-issued install link/token bound to their auto-created org —
  the Vantra EXE is the only client in this loop (the wrapper that connects
  devices to our end); agent health shown in the SpaceWorker web UI.
- Assistant gains device tools via Vantra API — run script, reboot, remote
  session, wake — **each wrapped as a gated proposal** (`AgentPendingAction`,
  kind "device"), one-time execution, audited.
- Exit: a SpaceWorker-only user (no Vantra signup) has full device control
  through the Assistant.

### P2 — Browser Clone (hosted-PC act-as-you; replaces the old cookie-vault idea)
> **Michael's directive (2026-09-22):** the Browser Clone is a first-class
> device capability of this plan — NOT a parallel subsystem. It is NOT built
> now, but the foundation (P1/P5) must reserve its seams so it never becomes
> a bolt-on. Concept: move a user's browser working environment (profiles,
> sessions, cookies, extensions, app state) from their work PC to a hosted
> SpaceWorker PC, then operate that browser through device infrastructure.

- **Topology (reserve now):** User → Device A (work PC: heartbeat, telemetry,
  Vantra link, clone SOURCE) + Device B (hosted SpaceWorker PC: heartbeat,
  clone DESTINATION, browser runtime). Source/destination/relay is a
  first-class device relationship in the schema, not a browser detail.
- **Egress relay is launch/runtime policy, not browser config:** the hosted
  browser egresses through the work PC (authenticated relay) so network
  identity stays the user's; where the relay is required it MUST NOT
  silently fall back to the hosted PC's own identity.
- **Same gate, no second framework:** a clone = staged proposal in
  `AgentPendingAction` (kind "browser-clone") → human approval (phone or
  web) → CloneJob created → source device agent secure-transfers → hosted
  device agent validates/injects → audit result. The user's explicit click
  can initiate it, but backend lifecycle converges on the shared
  approval/audit/lifecycle primitives.
- **Security boundary:** clone material (cookies, sessions, saved passwords,
  extension state, app tokens) is a HIGHER security class than telemetry.
  The AI receives capabilities/results — NEVER raw secrets in prompts,
  context, or logs. The later cookie-vault/act-as-user phase shares ONE
  browser credential boundary with Clone (audit/expiry/revocation/panic) —
  never two unrelated credential systems.
- **Transport abstraction:** SpaceWorker thinks in DeviceCommand /
  DeviceCapability / DeviceJob / DeviceAudit; TacticalRMM/Mesh specifics
  stay encapsulated behind the device capability interface (product stays
  stable if the RMM implementation changes).
- **Panic switch coverage:** the global kill switch stops pending device
  actions, clone jobs, active clone sessions, browser/session capabilities,
  and vault capabilities in one place — clone revocation participates in
  the SAME switch, never an isolated feature.
- **Hosted PCs:** dedicated hosted devices (start on the personal-VM/lab
  host), never the production VPS. Email-when-off unchanged: (a) IMAP
  mailboxes via existing plumbing; (b) webmail via the hosted clone browser;
  drafts → gated proposal either way.

### P3 — Wake-on-LAN + keep-reachable
- On-device keep-awake: the Vantra agent applies a power policy
  (`powercfg` request-override / keep-awake helper) — user or agent sets
  indefinite/timed "stay on" from the web (one-tap command button, no gate
  needed since it's user-initiated both ways).
- WoL delivery reality: magic packets only travel on the device's LAN, so
  delivery paths are (a) any other online Vantra agent on the same LAN
  (org peers — the plugin from P1 makes this possible), (b) the user's router
  if it supports WoL relay. Server relays to the LAN agent as a gated action
  ("wake then act" = wake, wait for heartbeat, run queued proposal).
- Device shows reachability state; agent-visible; unreachable actions queue.

### P4 — Minimal phone approval loop (makes P2 useful off-device)
- **Channel: Telegram (owner, 2026-09-22)** — build on the EXISTING per-device
  Telegram notification pattern (SpaceWorker already has `User.telegramChatId`
  / `notifyTelegram` / `telegramLinkToken`, `lib/telegram.ts`, `lib/notify.ts`,
  and `app/api/telegram/webhook` — this is an extension, not a new build).
  Proposal push to Telegram with Approve / Reject inline buttons; Edit opens a
  tokenized web page.
- Signed, single-use, short-TTL tokenized links so no full login is needed;
  every tap lands in the audit trail.
- Required by P2's promise: reply approved from phone while the PC is off.

### P5 — Assistant foundation it all stands on (from old 89 Phase A, web-first)
- `Device`/`DeviceHeartbeat` (device identity = the user's **Vantra agent**
  install), device telemetry via the **Vantra agent's RMM capabilities**
  (process/app inventory rather than a custom foreground sampler — no
  SpaceWorker EXE exists to sample from), "what did I do today" digest thread
  rendered in the web app (Channelry), per-user toggles + visibility live in
  the web UI (no tray indicator — that would imply our own EXE).

## VANTRA PARITY TRACK (SpaceWorker web = the only front-end users/staff need)

**Principle (owner, 2026-09-22):** the SpaceWorker agent/web must do EVERYTHING
Vantra does today — full device management & control plus the maintenance
tools — so users AND staff never have to go to Vantra for anything. Anyone
who signs up on `spaceworker.top` gets what Vantra offers as part of the
product. **Vantra stays exactly what it is: the isolated RMM engine** —
SpaceWorker copies its flows and builds the rest of the tools around them.

Vantra's current surface (audited from the vantra repo, 2026-09-22) that
SpaceWorker web must reach parity with:

- V1 — **Devices core:** device grid/cards w/ status, org switcher,
  add-device flow (SpaceWorker-issued Vantra-agent install link/token),
  device detail (specs, health, history), auto-move + private-move rules.
- V2 — **Control + maintenance tools:** the remote-tools set (wake, reboot/
  shutdown, remote session launch, script run) and the script manager —
  all proxied through Vantra's API with server-only `VantraLink` tokens,
  all gated like every other mutating action.
- V3 — **Account surfaces:** settings, billing (incl. crypto panel pattern),
  support tickets (list + thread), desktop-mode UX, notifications (Task 39
  channels + the Telegram pattern Vantra already has).
- V4 — **Staff/admin parity:** SpaceWorker admin sees device inventory,
  tooling, and RMM status per user org (staff badge) — Vantra's own admin
  stays internal-only for RMM engine ops.
- V5 — **Organization flow + agent granting (owner, 2026-09-22):** keep the
  organization model intact end-to-end. A SpaceWorker user requesting an
  agent **gets a PUBLIC agent from Vantra by default** (provisioned into
  their auto-created `sw-<userId>` org via the P1 flow). **SpaceWorker admin
  can grant any user a PRIVATE agent (or public) from the SpaceWorker admin
  panel** — mirroring Vantra's existing public/private agent + move flows
  (`private-move-panel`, `auto-move`), re-skinned: grant UI in admin user
  detail, agent request queue for users, audit row on every grant/switch.
  Default stays public; private = admin-approved only.

Build approach: **copy the flows, not the codebase** — reuse Vantra's proven
interaction patterns/component structure where useful, but wire them to
SpaceWorker auth + the per-user Vantra org, re-skinned in SpaceWorker's
design system. No shared runtime, no cross-app sessions.

**Menu & dashboard reprioritization (owner + Michael at finalization):**
rework the SpaceWorker nav so the new surface reads in priority order
(Assistant, Devices, Cyber Lab, existing extraction/mail features, Billing,
Settings, Support), and enrich the dashboard cards (device health, assistant
digest, security posture, lab activity). Exact tab order = decision at
finalization with Michael's feedback (M7).

## CYBER LAB TRACK (staff-first, personal-VM start, per owner directive)

### L1 — Lab foundation on personal VMs (no dedicated hardware yet)
- Runs on the owner's/personal VMs first (the 192.168.0.x LAN box + any
  rented VPS we already have); **no no-internet gate for staff track** —
  real-live testing is the point during development.
- Caldera (Apache-2.0) on a lab host, driven by our agent via REST; victim
  VMs run the Vantra agent so attacks are recorded as real telemetry.
- Episode recorder -> `LabEpisode` (timeline, techniques, telemetry
  signatures, outcome).

### L2 — Staff-badge live access (like Vantra staff mode)
- Staff badge = the existing Vantra staff/admin access pattern: staff can
  reach ALL lab infrastructure exposed for live testing.
- Staff run real scenarios against personal/staff VMs — deliberately NOT
  sandboxed to no-egress, so we learn how attacks behave on real networks.
- Everything audited; panic switch; lab hosts tagged and isolated from
  production secrets (no customer data on lab VMs, ever).

### L3 — What the lab feeds (without training yet)
- Detection derivation: episode telemetry -> candidate detection rule ->
  validated -> `DetectionPack` -> shipped via the Assistant's security
  toolbelt (digest + checks) to real users.
- Scenario catalog + findings reports start internal (staff-only), become a
  pro-tier product surface later.
- **Model training is explicitly OUT of this plan** — the data pipeline is
  built (episodes stored structured for future `TrainingExample` export), but
  training runs happen in the LATER plan when the GPU exists.

### L4 — Customer gating (when lab goes beyond staff)
- Customers only ever get: no-egress disposable ranges + attestation +
  allow-listed scenarios + lawyer-reviewed AUP. Staff track keeps broader
  access. Nothing customer-facing ships from this track until those fences
  exist (old plan §4 stays the customer-gating contract).

## CROSS-TRACK RULES (updated for the Browser Clone directive)

1. **The gate is absolute and singular:** every mutating action (device op,
   email send, clone job, wake-then-act) = staged proposal -> human approval
   -> one-time execution -> audit row. NO second approval framework for
   cloning or anything else. Phone approval (P4) is the same gate, second door.
2. **Privacy floor + secrets classes:** telemetry is app/window metadata only
   (never keystrokes/screenshots), master toggles + visibility in the web UI.
   Browser/session material (cookies, passwords, tokens, extensions) is a
   HIGHER security class: never in AI prompts, context, or logs — agents get
   capabilities and results only. Never generalize telemetry storage into a
   "collect arbitrary browser data" mechanism.
3. **Brain stays Channelry** until the LATER plan's model exists; all agent
   calls stay behind `lib/agent.ts` so the swap later is a config change.
4. **Schema work now, funded hardware later:** build models so nothing here
   needs rework when the GPU plan lands (`VantraLink`, `CloneJob`,
   `Device*`, `Lab*`, `AgentActionAudit`).
5. **Shared primitives rule (Michael):** device identity, approval state,
   audit, device authentication, lifecycle/revocation, and panic/kill-switch
   belong to SpaceWorker's common device layer. Browser Clone, cookie vault,
   lab ranges — all consume them; none may invent their own.
6. **Panic switch is total:** one operation stops pending device actions,
   clone jobs, active clone sessions, browser/session capabilities, and
   device-side agent operations together.

## SCHEMA (consolidated draft)

- `VantraLink` (userId, orgId, agentTokenEnc, status)
- **Common device layer — reserved seams, shared by EVERYTHING device-side
  (Michael directive):** `Device` (DeviceIdentity) / `DeviceHeartbeat` /
  `DeviceCapability` (capability metadata) / `DeviceJob` / `DeviceAction` /
  `DeviceAudit` / `DeviceRelationship` (source/destination/relay-peer).
  Never duplicate identity, approval state, audit, device auth, lifecycle,
  or panic infrastructure anywhere else.
- `DevicePowerPolicy` (keep-awake + WoL state)
- `ActivityRollup` (digests)
- **Browser Clone (capability; seams reserved now, built after device
  control):** `CloneJob` (userId, sourceDeviceId, destinationDeviceId,
  relayId, lifecycle pending→transferring→active→revoked/expired,
  launchState, browserProfileRef) + `RelayHealth` — rides the common layer.
- `HostedBrowserSession` (cloneJobId, state, ttl) — hosted-PC browser runtime.
- Cookie vault: DEFERRED to a later phase; shares ONE browser credential
  boundary with Clone (expiry/revocation/panic), informed by clone design.
- `AgentPendingAction` kind extended: "device" | "email-reply" | "power" |
  "wake" | "browser-clone" | "clone-control" | "lab-action"
- `AgentActionAudit` — canonical PRODUCT audit: userId, action (incl.
  "browser_clone"), sourceDeviceId, destinationDeviceId, pendingActionId,
  initiatingChannel, approvalChannel, status, timestamps, cloneId. RMM/Mesh
  low-level logs remain infrastructure-only diagnostics.
- `LabScenario` / `LabRange` / `LabEpisode` / `LabFinding` / `DetectionPack` / `LabConsent`

## BUILD ORDER (top = first)

1. **P5** Assistant foundation (schema + Vantra-agent telemetry + digest) — everything stands on it
2. **P1** Vantra plugin (org provisioning + agent link + device tools, gated)
3. **P4** Phone approval loop (human control BEFORE device control — Michael
   sequencing: the gate exists before any device/clone execution)
4. **V1–V2** Vantra parity: devices core + control/maintenance tools
5. **P3** WoL + keep-awake (reach the device)
6. **P2** Browser Clone capability (seams already reserved in P5/P1; clone
   follows device control and powers the hosted-browser act-as-you story)
7. **V3–V4** Parity: account surfaces + staff/admin visibility
8. **L1–L3** Cyber lab staff track (parallel once P1 exists — victim VMs
   need the Vantra agent from P1)
9. **MK1–MK4** Marketing reposition + store-as-tab (owner-sequenced: only
   after P2/priority flagship tasks are done and the story is true)
10. Customer-facing lab surfaces (L4) — gated on fences + Michael's AUP review

P2 and P3 land before the phone loop so the flagship demo works end-to-end:
**PC is off → agent wakes it or uses the hosted clone browser → checks email →
drafts reply → owner approves from phone → sent.**

## FINALIZED DECISIONS (owner + Michael, 2026-09-22 — every question answered)

- **M6 (Michael's directive) — ANSWERED:** Browser Clone replaces the
  cookie-vault as the browser capability; this plan reserves its seams
  (Device → Action → Approval → Audit → Lifecycle) but the clone itself is
  built AFTER device control exists, per Michael's sequencing. See P2 + schema.
- **M1 — ANSWERED (superseded by clone):** no per-site cookie capture;
  Browser Clone handles Chrome/Edge/Firefox profiles wholesale. Flagship
  demo = webmail + customer portal on the hosted clone browser, egressing
  through the work PC.
- **M2 — ANSWERED:** hosted clone PCs are dedicated hosted devices (start on
  the personal-VM/lab host), never the production VPS (isolation; the VPS is
  a shared 24GB box).
- **M3 — ANSWERED:** v1 WoL = org-peer Vantra agent on the same LAN
  (router relay later if demand). Keep-awake policy is the primary
  reachability tool; WoL is the fallback.
- **M4 — ANSWERED:** SpaceWorker-side staff badge (admin-role mirror of
  Vantra's pattern). Staff never need to log into Vantra.
- **M5 — ANSWERED (owner accepted):** personal VMs + staff-badge full
  access, egress gate deferred for the staff track, everything audited,
  panic switch.
- **M7 — ANSWERED (default, tweakable):** nav order Assistant / Devices /
  Cyber Lab / Extract & Mail / Store / Billing / Settings / Support;
  dashboard cards: device health, assistant digest, security posture, lab
  activity.
- **M8 — ANSWERED:** exe-gate/licensing stays extractor-EXE-only; web
  features gate via entitlements (C-track); no SpaceWorker-web mirror.
- **M9 — ANSWERED (final, 2026-09-22):** brand line is "SpaceWorker OS" +
  **"Your Cloud Cyber Partner"** (hero tagline; "your cyber partner" remains
  the short form for tight layouts).
- **Pricing defaults (runtime-tweakable AdminSetting values, per C3 — zero
  code to change):** extractor $19/mo, mailer $19/mo, assistant/devices
  $29/mo, cyberlab $29/mo; full tier-5 bundle unchanged at $79.97/mo; free
  tier 1 = see-all/run-limited; 24h full-access trial per signup.
- **C4 / standalone EXE — CONFIRMED deferred:** yearly-license EXE only
  after the web is proven.

## COMMERCIAL TRACK — modular pricing, entitlements, trials (researched 2026-09-22)

**Owner directive:** free signup sees ALL tools but limited on some (24h-trial
style); users pick WHAT they pay for — extractor alone, extractor+mailer,
Cyber Lab alone, etc., each a small monthly amount; the bigger plan is a
standalone EXE with a yearly license once every web feature is grounded.
**No new billing build — pricing is added per feature onto the existing
store + crypto rails** (`lib/products.ts` single source of truth, `Payment`
crypto flow, `AdminSetting` price fields — all live).

**Pattern to implement — the entitlements pattern (industry standard):**
code checks *capabilities*, never tiers/prices. "Does this user have
`extractor`?", not "is tier >= 5?". Plans/purchases GRANT entitlements; the
mapping lives in config, so pricing changes never require code changes
(research: Salable entitlements pattern — tier checks rot the codebase,
entitlements make custom bundles/promotions pure configuration).

- **C1 — Entitlement core (lands with P5, before any module sells):**
  `UserEntitlement` (userId, key, source "trial"|"module"|"tier5"|"admin_grant",
  expiresAt nullable = grandfathered — mirror Task 55's premiumExpiresAt
  lazy-expiry semantics exactly, never backfill); central `lib/entitlements.ts`
  with `hasEntitlement(userId, key)`; the ONLY gate every feature checks
  (UI show/hide + server route enforcement — server is the real gate).
- **C2 — Tier mapping (reuses existing 1/5 + reserved 2/3/4):** tier 5 =
  the head — ALL entitlements, unlimited, auto-granted on grant-check
  (keeping the existing "test >= 5, never >= 1" rule intact); tier 1 free =
  see everything, run-limited (existing 15min/day tool trials + 900s caps +
  silent 24h EXE trial stay as the limits); 2/3/4 stay reserved headroom.
- **C3 — Module store:** each feature ships as a `StoreProduct`
  (`extractor_module`, `mailer_module`, `cyberlab_module`, `assistant_module`,
  …) with its own AdminSetting price field + monthly term; user checks
  modules on the store → existing crypto checkout → payment success grants
  the entitlement (monthly expiry, lazy reversion). Bundle discounts = a
  bundled product row, pure config.
- **C4 — Future standalone EXE (deferred decision):** yearly-license EXE
  gated on ALL web features working as expected — reuse `ExeLicense`
  machine-binding with a 1-year term product; NOT designed until the web is
  proven (per the delivery-surface rule at the top of this plan).

## TASK BREAKDOWN (executed in TASK_92–TASK_101 + MICHAEL_BRIEF.md, 2026-09-22)

| Task | Scope | Plan refs |
|---|---|---|
| TASK_92 | Assistant foundation + entitlements core (device layer schema, `lib/entitlements.ts`, digest) | P5, C1 |
| TASK_93 | Vantra plugin: org provisioning, agent link, gated device tools | P1 |
| TASK_94 | Telegram approval loop (inline Approve/Reject + tokenized edit) | P4 |
| TASK_95 | Vantra parity: devices grid/detail, remote tools, script manager, org flow + public/private agent granting, nav/dashboard | V1, V2, V5, M7 |
| TASK_96 | WoL + keep-awake ("wake then act" composite) | P3 |
| TASK_97 | Browser Clone: CloneJob/RelayHealth/hosted browser + **Michael MT-1 contract** | P2 |
| TASK_98 | Cyber Lab staff track: Caldera, episodes, detection packs + **Michael MT-2/MT-3 contracts** | L1–L3 |
| TASK_99 | Module store + commerce (products → checkout → entitlements) | C2, C3 |
| TASK_100 | Marketing reposition "Your Cloud Cyber Partner" + store as its own route | MK1–MK4, M9 |
| TASK_101 | Account + staff parity surfaces (settings, billing, tickets, desktop-mode, admin views) | V3, V4 |
| MICHAEL_BRIEF.md | Michael's orientation: codebase map, rules, push flow, README template, his task contracts | — |

Every task doc carries: references to HOW_WE_MOVE_FAST.md (deploy/migration
playbook), this plan's sections, contract deliverables, and acceptance checks.

## WORKFLOW — Michael + owner task split (seamless by contract)

Michael (cybersecurity) writes scripts for planned builds and builds features
in isolation, pushing to GitHub (he has access to all repos); **the owner
does all integration + development merging**. To make that straight:

- **Contract-first tasks:** every task doc Michael builds from defines
  inputs/outputs up front — schema additions (hand-written migration SQL per
  HOW_WE_MOVE_FAST §3), API route shapes, entitlement keys it gates behind,
  and acceptance criteria. His isolated build then merges without surprises.
- **Isolation = his own repo/branch** (`michael/<feature>` or standalone
  repos for scripts/tools); integration is always: owner reviews → runs
  `npx tsc --noEmit` → applies migration on VPS → rsync `--exclude='.env'`
  → build + restart + live verify (HOW_WE_MOVE_FAST §2/§3, verbatim).
- **Dark-launch integration:** merged features ship entitlement-gated and
  invisible until the module goes on sale (C3) — integration never waits on
  pricing decisions.
- **Natural Michael track from this plan:** Cyber Lab scenarios/detection
  scripts (L-track), the security toolbelt checks, browser-clone
  profile-capture/restore extension scripts (P2 device side), extraction
  pipeline improvements — all contract-defined, isolation-built,
  owner-integrated.

## MARKETING TRACK (MK) — reposition + rephrase for the full platform
**Sequencing (owner): starts AFTER the agent (P1/P3) and browser-cookie
private-browser task (P2) are done — the flagship story must be true before
the site claims it.**

**Owner direction:** the current page sells only leads ("find leads, then let
the agent handle the outreach") but the product is becoming a cybersecurity
platform + assistant + extraction + outreach. New positioning:
**"SpaceWorker OS — Your Cybersecurity Partner"** (final phrasing owner +
Michael at finalization, M9; "your cyber partner" as the short variant).
Research anchor (2026-09-22): Wiz/CrowdStrike platform pages — category-first
hero ("Your cloud & AI security HQ" / "The cybersecurity platform"), then
outcome-led capability pillars, then per-module sections; store/pricing live
as separate click-through destinations, never an inline scroll section.

- **MK1 — Hero reposition:** badge pill broadened (currently "Lead extraction
  + AI-assisted outreach"); H1 becomes the partner positioning; subtitle says
  what the app IS — "an AI assistant that runs your devices, finds and reaches
  your customers, and defends your PCs — with you approving every action" —
  files: `app/page.tsx` (hero + metadata), `components/menu-bar.tsx`.
- **MK2 — Capability pillars (replace the 6-card grid):** four outcome groups
  that grow as modules ship — **Find & Reach** (extraction, outreach,
  profiles), **Assistant & Devices** (agent, device control, browser clone,
  keep-awake), **Cyber Lab** (scenarios, detection packs, training ground),
  **Automate** (automations, digests, phone approvals). Copy rephrased
  outcome-first, not feature-first; unreleased modules render as "coming
  soon" cards only once they exist (dark-launch friendly per C3).
- **MK3 — Store becomes its own tab/route:** move the store off the marketing
  scroll to a dedicated `/store` route (new tab "Store" in NAV); the landing
  page keeps only a "Browse the store" button linking there; nav reads
  Features / Store / Pricing. Store page rephrased for modules ("pick what
  you pay for") once C3 modules exist — reuse `components/store.tsx` as-is
  in the new route.
- **MK4 — Copy + SEO sweep:** page title/metadata, footer line, and pricing
  page intro rephrased to platform-level; keep the cold-outreach
  responsibility disclaimer (legal).

## WHAT MOVED TO THE LATER PLAN

Own model, GPU hosting, training runs, Router/eval canaries, lab-at-scale
hardware, customer lab tiers, pay-as-you-go user-triggered GPU billing —
all in `PLAN_LATER_OWN_AI_GPU_TRAINING.md`. Nothing in the NOW plan depends
on it; the NOW plan keeps building tools and testing with external and
personal VMs in the meantime, with Channelry as the brain.


