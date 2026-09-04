# Cline Task 10 — Desktop/Dock Shell + the Browser App

**Repo**: `/Users/mikeolab/spaceworker`. **Scope**: app code (Next.js/React) only, no infra/deploy changes — Claude has already handled the VPS side (Docker, Neko image, nginx, systemd) for the pieces that needed it.

**Design reference**: a Claude Design canvas covers the full visual direction — landing page, OS desktop/dock shell (`Desktop.dc.html`), and the Browser app (`BrowserApp.dc.html`). Ask the user for the current canvas link if you don't have it.

This is the smaller, higher-priority half of what was originally one combined task — split out so it can be picked up and finished on its own without pulling in Lead Extractor/Mailer context. See `TASK_11_LEAD_EXTRACTOR_AND_MAILER.md` for the other half; the two don't depend on each other and can be worked in parallel by two different people.

## What already exists, don't rebuild it

- `components/dashboard-nav.tsx` already has all the right nav items (Overview, Extract, Mailboxes, Campaigns, Browser Profiles, Private Browser, Settings) — this task is about the visual shell/chrome around navigation, not the nav logic itself.
- `components/browser-session-panel.tsx` already has real, working logic: session start/stop/switch-location, BYO proxy test-and-save, an IP checker, and an `<iframe src={\`/browser/${s.id}/\`}>` for the live view. **This already works end-to-end as of 2026-09-04** — Claude found and fixed two real bugs blocking it (wrong Neko image name, host-side profile-directory permissions preventing Chromium from starting) and added the missing nginx+browser-server proxy layer connecting the iframe's URL to the actual running session. Verify it works against a real session before changing anything in this file — if something's still broken, that's a bug to fix in place, not a sign the architecture needs rework.
- **The native browser tab bar is not something to build.** Neko streams the *real* Chrome UI — no kiosk/app-mode flags are set on the container's Chromium (`browser-server/server.ts`'s `buildNekoArgs()`), so Chrome's own tab bar, address bar, and back/forward buttons are already part of what the iframe shows once a session is running. Do **not** build a custom tab-strip component to sit above the iframe — it would just duplicate Chrome's own chrome. If the design canvas shows a mocked-up tab strip, treat that as illustrative of "you can already do this," not a literal component to implement.

## What to actually build

1. **A real desktop/dock shell**, replacing the current bare `app/dashboard/page.tsx` (two link-cards) and the plain sidebar-only layout. Reference the design canvas's `Desktop.dc.html` artboard: a top bar (product name + a clock/status area is optional polish, skip if it adds complexity for no real value) and a dock or icon row for the core destinations (Overview, Extract, Mailboxes, Campaigns, Browser Profiles, Private Browser, Settings) — reusing the existing `dashboard-nav.tsx` items as the source of truth for what belongs in the dock, not a separate hardcoded list that could drift from the real nav.
2. **A static (non-animated) 3D-styled ambient background** behind the desktop, matching `Desktop.dc.html`'s treatment: a few translucent panel shapes fixed at real CSS `rotateX/rotateY/rotateZ` perspective angles (no `@keyframes`, no JS) — genuinely three-dimensional-looking without moving. Low opacity, sits behind the dock/icons, never competes with them for attention.
3. **Keep it additive, not a full navigation rewrite.** The existing sidebar nav (`components/dashboard-nav.tsx`) can stay as the actual navigation mechanism (hrefs, active-state logic, mobile row) — this task is about the *visual* framing (desktop/dock chrome) layered on top of or alongside it, not ripping out working routing logic. Use your judgment on whether the dock supplements the sidebar or replaces it for desktop viewports while the sidebar stays for mobile — either is fine as long as every real nav destination stays reachable.
4. **The Browser app's empty state.** Confirm `browser-session-panel.tsx` already has a real "no session yet" state (profile + location picker + Launch button) matching the design canvas's `BrowserApp.dc.html` empty-state artboard. If it's missing or thin, build it to match — this is the state a user sees before starting a session, and it should feel like a deliberate app screen, not a bare form.
5. **Visual polish pass** on `browser-session-panel.tsx` to match the design canvas's dark theme/window-chrome treatment (title bar styling, IP badge, location switcher) if the current implementation is more utilitarian than the design — a styling pass on working logic, not a rebuild.

## Explicitly not this task

- The exit-node "free" proxy locations (`EXIT_NODE_US`/`EXIT_NODE_UK`) aren't provisioned yet — no real WireGuard/OpenVPN exit boxes exist. The UI should handle this gracefully (it likely already does, per the existing "no exit nodes configured" guard) but don't block this task on provisioning them — that's separate infrastructure work for later.
- Don't touch `browser-server/server.ts`, `lib/browser-profiles.ts`, or the nginx/systemd config — those are the pieces Claude just fixed and deployed; this task is purely the Next.js dashboard UI layer.
- Lead Extractor and Mailer — that's `TASK_11_LEAD_EXTRACTOR_AND_MAILER.md`, a separate task.

## Verification

1. Open the dashboard, confirm the new shell renders and every real nav destination (Overview, Extract, Mailboxes, Campaigns, Browser Profiles, Private Browser, Settings) is reachable.
2. Confirm the ambient background is genuinely static (no visible motion, no console errors about missing animation targets) but reads as 3D — real depth from the perspective transforms, not a flat gradient.
3. Start a real browser session, confirm the live Chrome stream actually shows in the iframe, confirm you can open a new tab using Chrome's own native "+" button (not a custom one), confirm the IP checker and location switcher still work.
4. Confirm the empty (no-session) state looks like a deliberate app screen, matching the design.
