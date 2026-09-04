# Cline Task 10 — Implement the SpaceWorker OS Redesign (Parts 1 & 2)

**Repo**: `/Users/mikeolab/spaceworker`. **Scope**: app code (Next.js/React), no infra/deploy changes — Claude has already handled the VPS side (Docker, Neko image, nginx, systemd) for the pieces that needed it.

**Design reference**: a Claude Design canvas covers the full visual direction — landing page, OS desktop/dock shell, the Browser app, Lead Extractor (with its template picker), and Mailer (with sender + subject rotation). Ask the user for the current canvas link if you don't have it (it may have been updated since this doc was written — canvas links can be republished independently of this file).

Do this in two parts, in order. Part 1 is the structural shell + the Browser app (the thing that was actually broken and just got fixed at the infra layer — ship the UI that lets people use that fix). Part 2 is Lead Extractor + Mailer, which touch more business logic and can wait a beat.

---

## Part 1 — Desktop/dock shell + the Browser app for real

### What already exists, don't rebuild it

- `components/dashboard-nav.tsx` already has all the right nav items (Overview, Extract, Mailboxes, Campaigns, Browser Profiles, Private Browser, Settings) — this task is about the visual shell/chrome around navigation, not the nav logic itself.
- `components/browser-session-panel.tsx` already has real, working logic: session start/stop/switch-location, BYO proxy test-and-save, an IP checker, and an `<iframe src={\`/browser/${s.id}/\`}>` for the live view. **This already works end-to-end as of 2026-09-04** — Claude found and fixed two real bugs blocking it (wrong Neko image name, host-side profile-directory permissions preventing Chromium from starting) and added the missing nginx+browser-server proxy layer connecting the iframe's URL to the actual running session. Verify it works against a real session before changing anything in this file — if something's still broken, that's a bug to fix in place, not a sign the architecture needs rework.
- **The native browser tab bar is not something to build.** Neko streams the *real* Chrome UI — no kiosk/app-mode flags are set on the container's Chromium (`browser-server/server.ts`'s `buildNekoArgs()`), so Chrome's own tab bar, address bar, and back/forward buttons are already part of what the iframe shows once a session is running. Do **not** build a custom tab-strip component to sit above the iframe — it would just duplicate Chrome's own chrome. If the design canvas shows a mocked-up tab strip, treat that as illustrative of "you can already do this," not a literal component to implement.

### What to actually build

1. **A real desktop/dock shell**, replacing the current bare `app/dashboard/page.tsx` (two link-cards) and the plain sidebar-only `Shell`-equivalent layout. Reference the design canvas's `Desktop.dc.html` artboard: a top bar (product name + a clock/status area is optional polish, skip if it adds complexity for no real value) and a dock or icon row for the core destinations (Overview, Extract, Mailboxes, Campaigns, Browser Profiles, Private Browser, Settings) — reusing the existing `dashboard-nav.tsx` items as the source of truth for what belongs in the dock, not a separate hardcoded list that could drift from the real nav.
2. **Keep it additive, not a full navigation rewrite.** The existing sidebar nav (`components/dashboard-nav.tsx`) can stay as the actual navigation mechanism (hrefs, active-state logic, mobile row) — this task is about the *visual* framing (desktop/dock chrome) layered on top of or alongside it, not ripping out working routing logic. Use your judgment on whether the dock supplements the sidebar or replaces it for desktop viewports while the sidebar stays for mobile — either is fine as long as every real nav destination stays reachable.
3. **The Browser app's empty state.** Confirm `browser-session-panel.tsx` already has a real "no session yet" state (profile + location picker + Launch button) matching the design canvas's `BrowserApp.dc.html` empty-state artboard. If it's missing or thin, build it to match — this is the state a user sees before starting a session, and it should feel like a deliberate app screen, not a bare form.
4. **Visual polish pass** on `browser-session-panel.tsx` to match the design canvas's dark theme/window-chrome treatment (title bar styling, IP badge, location switcher) if the current implementation is more utilitarian than the design — a styling pass on working logic, not a rebuild.

### Explicitly not this task

- The exit-node "free" proxy locations (`EXIT_NODE_US`/`EXIT_NODE_UK`) aren't provisioned yet — no real WireGuard/OpenVPN exit boxes exist. The UI should handle this gracefully (it likely already does, per the existing "no exit nodes configured" guard) but don't block this task on provisioning them — that's separate infrastructure work for later.
- Don't touch `browser-server/server.ts`, `lib/browser-profiles.ts`, or the nginx/systemd config — those are the pieces Claude just fixed and deployed; this task is purely the Next.js dashboard UI layer.

---

## Part 2 — Lead Extractor (search templates) + Mailer (subject rotation)

### Lead Extractor — real workflow, not the generic form it has today

Current `app/dashboard/extract/page.tsx` (from Michael's Task 3 PR) is a single fixed form: one query box, engine (DDG/Google), lane (quick/deep), max results. Per the confirmed real product shape (`PLAN.md` Addendum 5 — read it before starting, it has the full reasoning, don't re-derive it), this needs to become:

1. **A template picker**: "Lead Search" (the existing form, relabeled), "HR / Recruiting" (new fields: job titles list, location, experience level), "Plain Search" (one freeform box). Match the design canvas's `LeadExtractor.dc.html` artboard for the visual pattern (a segmented picker at top, `<sc-if>`-equivalent conditional rendering of each template's fields in React).
2. **"Find" becomes a multi-item list**, not a single string — a user adds "plumber", then "carpenter", etc., as separate chips, and the job searches across all of them. This is a real change to `SearchJob.params`'s shape (currently likely a flat query string) — check the actual current `POST /api/jobs` request body shape in `app/api/jobs/route.ts` before changing it, and decide whether `params.query` becomes `params.queries: string[]` or a similar shape; keep the worker-side contract in mind (`worker/automation.py`'s `search_phase()` currently expects a single `query` string — this task may need a corresponding small worker change to loop over multiple queries, or the multi-query fan-out could happen at the dispatcher level, queuing one `SearchJob` per term. **Decide and note which approach you took** — this is a real architectural fork, not a trivial UI change.
3. **HR and Plain Search templates need their own automation**, per Addendum 5 — they are explicitly **not** the same DDG/Google lead-extraction engine with relabeled fields. Building the actual HR/Plain automation backends is likely too large for this task alone — if so, ship the UI for all three templates, wire "Lead Search" fully end-to-end (it's the one with a real backend today), and make the other two templates' submit action clearly say "coming soon" rather than silently doing nothing or (worse) running the wrong engine against HR/Plain input. Flag back explicitly if you think the HR backend is small enough to include here — don't guess silently either way.
4. Add a `SearchJob.template` field (`"lead" | "hr" | "plain"`) so this is trackable/extensible from the start, matching Addendum 5's note that this field needs to exist before Addendum 4's campaign-automation work assumes a single-template shape.

### Mailer — sender rotation already exists, subject rotation doesn't

Current `EmailCampaign` (Task 4) has a single `subject`/`bodyHtml` pair. Per `PLAN.md` Addendum 6 (and the original Addendum 2 §4/§5 research it confirms — read both), this needs:

1. **A `CampaignVariant` model** (or similarly named) — a campaign has 2+ subject/body variants, rotating evenly across the send, the same way sender-mailbox rotation already works for `EmailQueueItem`. Addendum 2 §5 has a draft schema sketch (`CampaignVariant: id, campaignId, subject, bodyHtml`) — use it as a starting point, adjust as needed once you're in the real schema.
2. **UI**: match the design canvas's `MailerApp.dc.html` artboard — a "Subject lines (rotates evenly)" section with add/remove chips, mirroring the existing "Sending from (rotates evenly)" mailbox-chip pattern already built for Task 4's multi-mailbox selection.
3. **The send/drain logic** (`app/api/internal/mail-queue-drain/route.ts` or wherever the actual send loop lives) needs to pick a variant per recipient the same way it currently picks a mailbox — round-robin or random, matching whatever rotation strategy the existing sender-rotation code already uses, for consistency.

### Explicitly not this task

- Campaign-template automation (Addendum 4) — still blocked on Task 9 (mailbox/campaign E2E verification) being done first, per the plan's own stated sequencing. Don't start building the "mass ads" template flow here.
- Spintax, open-rate-driven A/B — explicitly deferred in Addendum 2's priority tiers, not in scope.

---

## Verification

**Part 1:**
1. Open the dashboard, confirm the new shell renders and every real nav destination (Overview, Extract, Mailboxes, Campaigns, Browser Profiles, Private Browser, Settings) is reachable.
2. Start a real browser session, confirm the live Chrome stream actually shows in the iframe, confirm you can open a new tab using Chrome's own native "+" button (not a custom one), confirm the IP checker and location switcher still work.
3. Confirm the empty (no-session) state looks like a deliberate app screen, matching the design.

**Part 2:**
4. Create a Lead Search with 2+ "Find" terms, confirm the job actually searches for all of them (check the real leads that come back reference multiple different terms, not just the first one).
5. Confirm HR and Plain Search templates render their own distinct fields and either work end-to-end or clearly say "coming soon" — no silent no-ops.
6. Create a campaign with 2+ subject lines and 2+ senders, run a real small send, confirm both subject and sender actually rotate across the recipients (check the sent messages/logs, don't just trust the UI state).
