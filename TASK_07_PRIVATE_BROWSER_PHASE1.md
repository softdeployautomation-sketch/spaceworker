# Cline Task 7 — Interactive Private Browser (Phase 1: shared box, streamed sessions, free + BYO proxy)

**Repo**: `/Users/mikeolab/spaceworker`. **Scope**: new feature, real infrastructure work — genuinely the largest task in the backlog after Task 2/3 land. Not blocked on Michael's PRs (doesn't touch the extraction worker or the queue at all) — can start independently.

## What this is, and what it is NOT (read this first, it's a real confusion risk)

Three genuinely different things in this codebase all involve "a browser" — don't conflate them:
- **Task 2 (extraction worker)**: a headless Playwright/Chromium instance the *scraper* drives. No visible UI, ever. Unaffected by this task.
- **Task 6 (browser profiles, already shipped)**: `BrowserProfile` model + `lib/browser-profiles.ts` + `app/api/browser-profiles/**` + `app/api/internal/browser-profiles/[id]/{acquire,release}` — persistent profile *directories* on disk (`BROWSER_PROFILE_BASE_DIR/{profileId}/`), with an `idle`/`in_use` status lock so Task 2's scraper can reuse cookies/sessions across a user's jobs. Backend bookkeeping only, no running browser at rest, no user-facing UI beyond profile CRUD. **This task reuses that exact model and directory scheme as a second consumer** — it does not need to be rebuilt.
- **This task, the third thing**: a genuinely interactive, user-facing browser session — the user actually sees and drives a real Chrome instance, streamed into the SpaceWorker dashboard, routed through a proxy so their activity isn't linkable to their real IP. This is the literal, non-metaphorical version of "SpaceWorker is a private browser platform."

## Confirmed decisions — do not re-litigate these, they were settled directly with the user

**Architecture**: no per-user VMs at this stage (cost was considered and explicitly rejected for now). One shared box (this VPS), multiple Chrome/Chromium processes, one profile directory per user — literally "a single browser, each user gets a profile, the way Chrome does" (the user's own words). Concretely: launch Chrome **non-headless** (or headless-with-a-virtual-display, e.g. Xvfb, since it needs to actually render pixels to stream) pointed at that user's existing `BrowserProfile.dirPath` from Task 6 — reused, not reinvented.

**Concurrency target: 2–3 simultaneous interactive sessions, not unlimited.** A deliberate Phase 1 cap — size everything (RAM headroom, process limits) around this number specifically, not "as many as fit."

**IP/proxy model, confirmed and simpler than paid-residential-proxy research originally assumed:**
1. **Free default tier**: SpaceWorker's own self-hosted WireGuard (or OpenVPN) exit nodes — a handful of small, cheap VPS instances in a few popular locations (e.g. US, UK, maybe one more), genuinely cheap (a few small droplets, not per-GB billing). **Exact node count/locations/hosting provider are not yet decided** — this is a small, non-blocking follow-up; pick something reasonable (e.g. 2 nodes, US + UK, on whatever cheap VPS provider is easiest to provision) and note the choice back rather than blocking on it.
2. **BYO**: a per-profile settings field for the user's own proxy/VPN credentials (host, port, protocol, auth) — SpaceWorker is a pass-through here, not a new proxy-provider integration. Test-connect before trusting it (same discipline as Task 4's mailbox test-connection flow).
3. **Explicitly NOT this stage**: a paid premium-IP tier SpaceWorker itself sells. Don't build toward this.

**Control granularity — three independent levels, all required:**
1. Whole SpaceWorker app off — already exists (`spaceworker.service` in Vantra's shared instaweb Services panel).
2. Whole browser-streaming subsystem off (kills all interactive sessions, headless extraction/Task 2 and the rest of the app unaffected) — needs to be its **own separate systemd unit**, e.g. `spaceworker-browser.service`, distinct from both `spaceworker.service` (main app) and `spaceworker-worker.service` (Task 2's headless worker, once that deploys). Flag this to Claude once it's ready to deploy — it needs adding to Vantra's shared `lib/services-control.ts`/`CONTROLLABLE_UNITS` allowlist and the sudoers rule, the same infra-hardening pass already done for `spaceworker.service` itself; **don't attempt to touch the VPS sudoers/systemd config yourself** — that's Claude's side of the work, same division of labor as every other systemd-unit addition in this project.
3. Individual user's session off — an **application-level** control (systemd only knows about the whole subsystem, not which Chrome process belongs to which user). Needs a small in-app process registry (`userId` → PID or container ID) that a new admin-panel action can read from and kill against, without affecting other concurrent users' sessions.

**Browser-panel UI, confirmed requirement — keep it simple for Phase 1, not a polished wizard:**
- A live **IP checker**: an actual "what's my IP" check from inside the streamed session (or from the server process routing that session's traffic) — not a cached/assumed value, so a broken exit-node route is visibly caught, not silently trusted.
- Inline controls to **switch** which free-location route the session uses.
- Inline controls to **add/edit a BYO proxy**.
- All three reachable from the same panel the user is already looking at — not a separate settings page.

## Still open, your call, not blocking

**Streaming technology.** Candidates already researched: **Neko** (`n.eko`, self-hosted, WebRTC, purpose-built for exactly "stream one browser with input forwarding," Docker-friendly — recommended, smallest footprint of the three for a 2-3 user cap) vs. Kasm Workspaces (more moving parts than needed here) vs. a custom build on Chrome's own CDP screencast protocol (more work, more control). **Recommendation is Neko** but this was never formally confirmed with the user — do a quick real spike (get one Neko container actually streaming one Chrome session end-to-end) before committing the whole task to it; if it doesn't pan out cleanly, report back with what you found rather than forcing it.

## Concrete build plan

1. **Reuse Task 6's `BrowserProfile` model and `lib/browser-profiles.ts` as-is** — no schema changes needed for the profile-directory part itself. What's new: a session needs to *launch a real, visible Chrome process* against that directory (not just reserve it via `acquire`/`release` for a headless job), and that process needs to be *streamed*.

2. **New model** to track a live interactive session (distinct from Task 6's `idle`/`in_use` profile-lock status, which is about headless-job mutual exclusion, not this):
   ```prisma
   model BrowserSession {
     id             String    @id @default(cuid())
     userId         String
     user           User      @relation(fields: [userId], references: [id])
     profileId      String
     profile        BrowserProfile @relation(fields: [profileId], references: [id])
     status         String    @default("starting") // "starting" | "running" | "stopped" | "failed"
     proxyMode      String    @default("free") // "free" | "byo"
     exitNodeId     String?   // which free exit node, if proxyMode = "free"
     byoProxyHost   String?
     byoProxyPort   Int?
     byoProxyAuth   String?   // encrypted, same pattern as Mailbox's encrypted SMTP password
     containerId    String?   // or PID — whatever the process registry actually uses
     startedAt      DateTime?
     endedAt        DateTime?
     createdAt      DateTime  @default(now())
     @@index([userId, status])
   }
   ```
   Adjust field names/shape as the actual implementation needs — this is a starting sketch, not a spec to follow blindly if something doesn't fit once you're in the code.

3. **Session lifecycle routes**: `POST /api/browser-sessions` (start — acquires a `BrowserProfile` via the existing Task 6 acquire route, launches Neko+Chrome against it, creates the `BrowserSession` row), `DELETE /api/browser-sessions/[id]` (stop — kills the process, releases the profile via Task 6's existing release route, marks `stopped`), `GET /api/browser-sessions/[id]` (status, for the panel to poll). Enforce the 2-3 concurrency cap here (count `status: "running"` rows before allowing a new start).

4. **Proxy wiring**: launch Chrome with `--proxy-server=` pointed at either the selected free exit node's local SOCKS/HTTP endpoint or the user's BYO proxy credentials, depending on `proxyMode`.

5. **Streaming**: wire Neko (or whatever the spike confirms) to point at the launched Chrome instance, expose its WebRTC/websocket endpoint through the app so `components/`'s browser-panel can embed it (an iframe or a small Neko client widget, depending on how Neko's own client works — check its docs for the embeddable path rather than assuming).

6. **Browser panel UI** (new component, e.g. `components/browser-session-panel.tsx`): the streamed view, the IP checker, the location switcher, the BYO-proxy form — all in one panel per the confirmed "keep it simple" requirement.

7. **Admin: individual-session kill switch** — a new admin panel action (whichever admin route/page pattern SpaceWorker already uses for other kill/force-release actions — check `app/api/admin/browser-profiles/[id]/force-release/route.ts`, which already exists from Task 6, for the exact established pattern to mirror) that looks up a `BrowserSession` by id and kills its process without touching other concurrent sessions.

## Explicitly out of scope this pass

Per-user VMs, a paid premium-IP tier, more than 2-3 concurrent sessions, any fingerprint-spoofing beyond what a real Chrome profile naturally provides (this product should never be marketed as an antidetect-browser replacement — if that's ever asked, the honest answer is this doesn't solve browser-fingerprint detection, only IP/session isolation).

## Verification

1. Start a session, confirm the streamed Chrome view actually renders and responds to real mouse/keyboard input from the dashboard.
2. IP checker inside the session shows the correct exit-node IP (or BYO proxy's IP), not the VPS's own real IP — confirm this explicitly, it's the entire point of the feature.
3. Switch the free-location route mid-session (or start a new session with a different one), confirm the IP actually changes.
4. Add a BYO proxy, confirm the test-connect step actually validates it and a session using it is genuinely routed through it.
5. Start 3 sessions, confirm a 4th is correctly blocked by the concurrency cap with a clear message.
6. Stop one session, confirm its `BrowserProfile` correctly returns to `idle` (reusable by Task 2's headless worker or another interactive session) and its process is genuinely gone (not orphaned).
7. Admin kill-switch: kill one user's session from the admin panel, confirm other concurrent sessions are completely unaffected.
8. Confirm two different users' sessions never share a profile directory or proxy credential — tenant isolation check, same standing discipline as every other multi-tenant feature in this project.
