# TASK_207 — Mobile console: (a) stop the cross-user device-tree leak, (b) desktop-forced view with touch controls

Status: PLANNED — no code. Owner asked 2026-10-14 (screenshots supplied).
Repo: spaceworker. Branch (when implementation starts): `agent/task-207-mobile-console` off `origin/main`.
Cross-repo risk: PARTIAL — the device-tree leak's cleanest fix is Vantra/MeshCentral-side (flagged, §5).

---

## 1. What the owner reported (verbatim intent)
- "the mobile view of the console, a user gets to see the other users devices with the bug."
- "it doesn't allow mobile users access to view console, i want that working."
- "make the mobile view act like a desktop view with special controls, so we don't switch to mobile and break things like this."
- "when i mean we make our site act like a desktop screen on mobile as well, but make it look easier, there are ways to do this."
- "a fix could go for both [console + n.eko], apart from the leak bug of devices from the rmm engine."

Screenshots (owner) show the MeshCentral remote-desktop iframe on a phone:
- A hamburger group view titled **"Individual Devices, 6 nodes"** listing CSFD-CHECKOUT, DESKTOP-V73JQPJ, and 3 unnamed/short nodes + WilkSF9 — i.e. nodes that are NOT all the current user's.

## 2. What exists today (ground truth — verified 2026-10-14, real greps)

### The console is a MeshCentral iframe, cross-origin
- `app/console/[deviceId]/page.tsx:38` → `<DeviceConsole deviceId fullScreen …/>` (chrome-free route outside `dashboard/`).
- `components/device-console.tsx:3793` → `<iframe src={mesh.control} … sandbox="allow-scripts allow-same-origin allow-forms">`.
- The URL is rewritten server-side to a DIFFERENT SUBDOMAIN: `lib/device-tools.ts:114-118` `MESH_ORIGIN_REWRITE` maps `mesh.instaweb.top → mesh.spaceworker.top`. Different subdomain ⇒ **different origin** ⇒ we CANNOT reach `iframe.contentDocument` to inject CSS/JS (the exact thing we CAN do for n.eko, TASK_208). This is the single most important constraint.
- The URL itself: `fetchMeshUrls` (`lib/device-tools.ts:144`) → `vantraFetch("/api/internal/sw/devices/<vantraAgentId>/mesh-urls")` → returns `control` / `terminal` / `file` (+ `controlViewOnly`). Vantra/TRMM mints the `login=` token.
- Mobile already has SOME handling: `device-console.tsx:3801-3810` (TASK_170) — below `sm`, the iframe height falls to `70dvh`; above `sm` it stays `480px`. So the iframe resizes on mobile, but nothing changes about WHAT MeshCentral renders inside it.

### Why the leak happens (hypothesis, needs live confirm — device offline)
The `mesh.control` login token authenticates the user into a MeshCentral **mesh GROUP** ("Individual Devices") that contains many nodes (not scoped to this user's one device). MeshCentral's own web UI renders a device-tree/node-list for that group. On desktop the tree is a collapsible side-nav you rarely open; on a phone MeshCentral reflows and the node list becomes the primary view — exposing every node in the group. So it is (a) a MeshCentral group-scope issue AND (b) a mobile-reflow-exposes-it issue. The owner correctly calls it "the leak bug of devices from the rmm engine."

### The site's responsive posture
- `app/layout.tsx:30-34` viewport = `width:"device-width"`, `initialScale:1`, `viewportFit:"cover"`. No `user-scalable=no`. The whole app is a normal responsive Tailwind site; below `sm` it reflows to mobile. There is currently NO "force desktop + touch overlay" mode anywhere.

### CONFIRMED addendum — 2026-10-14/15 investigation (real reads + primary sources; supersedes "hypothesis")
1. **The leak mechanism is now proven, not hypothesized:** TRMM's `control/terminal/file` URLs are
   `.../?login=...&gotonode=<x>&viewmode=11&hide=31` (quoted verbatim from the confirmed-live comment
   in `vantra/lib/meshcentral-api.ts:299-330`). So TRMM already sends `hide=31` to suppress nav — but the
   owner's phone screenshot still showed "Individual Devices, 6 nodes", i.e. **MeshCentral's mobile
   reflow defeats the `hide` param**. Display-param mitigation is therefore unreliable by evidence,
   not opinion.
2. **The token is broad:** Vantra's sw `mesh-urls` route (`app/api/internal/sw/devices/[agentId]/mesh-urls/route.ts`)
   just proxies TRMM's `/agents/<id>/meshcentral/` (`lib/trmm.ts:404-405`) — the minted `login=` session
   lands in the whole "Individual Devices" group = every customer's nodes on this TRMM instance.
   Tenant guard (`assertAgentInSwOrg`) proves the AGENT belongs to the caller's org — it does NOT
   scope what the MeshCentral session can SEE.
3. **The real fix (A1) is buildable in-repo-Vantra today** — the machinery already exists and is
   proven-live:
   - `vantra/lib/meshcentral-api.ts` is a working MeshCentral control-channel client:
     `makeLoginToken` (replicates TRMM's `meshctrl get_login_token`, confirmed against deployed
     MeshCentral 1.2.4), `createShareLinkOnSocket(controlUrl, nodeid, viewOnly, guestName)` with
     `consent:0` (silent — owner rule), `expire:0` (= "Unlimited sharing", confirmed by upstream
     meshctrl.js source), and `findMeshNodeIdByHostname`/`matchMeshNode` (fail-closed node mapping,
     Task 106).
   - **Server-enforced single-device scope:** MeshCentral guest share links give the visitor ONLY the
     shared node — no group, no tree. (Vantra's own header comment establishes the principle:
     "MeshCentral has NO per-URL viewonly flag … View-only is enforced server-side only through these
     device share links.")
   - **The share can cover all three apps:** upstream `meshctrl.js` (PR Ylianst/MeshCentral#5888,
     quoted): `if (shareTypes.indexOf('terminal') >= 0) { p |= 1; } if (...'desktop') { p |= 2; }
     if (...'files') { p |= 4; } if (p == 0) { p = 2; } // Desktop` — so `p: 7` = desktop+terminal+files
     on ONE share URL; `p: 2` (what Vantra sends today) = desktop only. Unlimited = `expire: 0`.
   - `controlViewOnly?` already flows through spaceworker's `MeshUrlsView` (`lib/device-tools.ts:81-140`)
     but the console UI never reads it — the share plumbing pattern exists end-to-end.
4. **Admin path is intentionally broad** (TASK_147 silent support viewer) — scoping applies to the
   CUSTOMER path only. The two paths are distinguished by an explicit `scope=device` query param
   (spaceworker customer `fetchMeshUrls` sends it; admin `adminFetchMeshUrls` does not).


## 3. Scope (what we build)

### Part A — Stop the cross-user device-tree leak (correctness / privacy)
This is the owner's #1 concern and is separate from the touch UX. Two candidate fixes; the choice is an owner decision (§6):

- **A1 (source fix, Vantra/MeshCentral — cleanest).** Scope the MeshCentral login so a customer's token only ever sees THAT customer's nodes — a per-user mesh group (or a single-node login). Eliminates the leak for real, on every device and every viewport. Cost: cross-repo Vantra change + possibly re-provisioning existing devices into per-user meshes. Without this, the leak is only hidden, not fixed.
- **A2 (display fix, SpaceWorker — hides the tree).** Open the MeshCentral viewer directly on the specific device node (not the group view) and/or hide the node-list UI, so a user never sees other users' nodes regardless of group scope. Requires either a per-device MeshCentral URL param or a same-origin proxy to inject CSS (see Part B).

> **OWNER DECISION (2026-10-15): A1 for real + new-tab UX.** Fix the leak at the source — Vantra per-device share mint (slice V1) — AND make the console open in a new tab on mobile. A2 (display hiding) rejected: hiding isn't fixing. B1 (same-origin proxy) rejected: the cross-origin wall stays, so TASK_208-style injection into MeshCentral is impossible; touch in the new tab comes from MeshCentral's own guest/mobile UI (validated live in S3/S4). `lib/touch-controls.ts` remains the one touch engine for same-origin embeds (n.eko).

### Part B — Desktop-forced view + touch controls (the "act like desktop on mobile" UX)
The owner does NOT want a separate mobile layout that breaks (the current state). He wants: render the DESKTOP view on mobile, then layer touch-friendly controls on top so it's usable without a mouse/keyboard. Approach:

- **B1 — Same-origin proxy for the MeshCentral viewer** (mirrors the proven n.eko `/browser/<id>/` proxy). Serve the viewer through our origin (e.g. `/mesh/<deviceId>/`) so it becomes same-origin and we can inject:
  - a **desktop-forcing** style (prevent MeshCentral's own mobile reflow that surfaces the node list — this also serves A2);
  - **touch → mouse/keyboard controls** (drag=move, tap=click, two-finger scroll, an on-screen modifier/keyboard bar). This is the "special controls" the owner described.
  - Risk: MeshCentral is heavier than n.eko (WebRTC + its own auth handshake + single-use `login=` token). Reverse-proxying its full traffic (incl. WebRTC signalling WS) is the hardest part. Must reuse the `MESH_ORIGIN_REWRITE` / `mesh.spaceworker.top` nginx vhost knowledge (see `lib/device-tools.ts:94-110`).
- **B2 — One shared touch-control module** (`lib/touch-controls.ts` or similar) used by BOTH this console proxy and the n.eko iframe (TASK_208), so the owner's "a fix could go for both" is literally true — one touch system, two embeds.

### Out of scope (for this task)
- Restructuring MeshCentral mesh GROUPS (per-user meshes) — no longer needed: the per-device share mint (V1) scopes visibility at the server without touching group membership.
- Any change to the desktop (>sm) console layout. Desktop must be untouched.

## 4. Plan (slices → gates → commit each) — FINALIZED 2026-10-15 after owner locks (§6)
- **V1 — Vantra scoped mint (the real leak fix), repo `vantra`, branch `agent/task-207-mesh-scoped-mint`.**
  `lib/meshcentral-api.ts`: add `createConsoleShareLink(nodeid)` reusing `createShareLinkOnSocket` with
  `p: 7` (desktop+terminal+files per upstream meshctrl.js bit values), `viewOnly: false`, `expire: 0`,
  `consent: 0` (silent — owner rule). Route `app/api/internal/sw/devices/[agentId]/mesh-urls/route.ts`:
  accept `?scope=device`; when present → `getAgentDetail` hostname → `findMeshNodeIdByHostname`/
  `matchMeshNode` (fail-closed, Task 106) → mint share → return its URL as `control`/`terminal`/`file`
  plus a `scoped:true` marker. On ANY failure → loud log + fall back to today's TRMM URLs (console must
  never break). No param (admin path) = unchanged TRMM URLs (TASK_147 by design). Tests: share-message
  builder + route scope/fallback behavior.
- **S1 — SpaceWorker customer path, repo `spaceworker`, branch `agent/task-207-mobile-console` (off
  `origin/main`; clone-resync WIP in `components/device-console.tsx` + `scripts/deploy-vps.sh` committed
  FIRST as its own labeled commit so the 207 diff stays clean).** `fetchMeshUrls`
  (`lib/device-tools.ts:144`) appends `?scope=device`; `adminFetchMeshUrls` does not. Source-contract
  test locks both directions.
- **S2 — Mobile new-tab UX (`components/device-console.tsx`, below `sm` only).** Replace the mesh
  iframe(s) with an "Open in new tab" card per tab (Remote/Terminal/Files) →
  `window.open(url, "_blank", "noopener,noreferrer")`. Desktop (>sm) block untouched (diff guard).
  Touch/keyboard in the new tab = MeshCentral's native guest/mobile UI (cross-origin wall: injection
  impossible — recorded honestly in §5).
- **S3 — Live mint verify (device offline is FINE for minting).** From Vantra's env, mint a share for
  the test node's real nodeid, `curl` the share URL → HTTP 200 + guest view shows ONLY that device
  (no group/tree). Also records which app the guest URL opens by default (decides how the
  Terminal/Files tabs map to the single share URL).
- **S4 — Phone verification (BLOCKED: test device offline).** On a real phone: console opens a new tab;
  guest view shows ONLY the owner's device; no "Individual Devices, 6 nodes" group anywhere;
  desktop (>sm) renders exactly as today.

## 5. Risks / notes (playbook §2a/§2b)
- **Fallback can mask the fix.** V1 fails open to TRMM URLs (by design — the console must not break),
  which silently restores the leak for that request. Mitigation: loud server log on fallback, `scoped`
  marker in the response, and the S3 curl check. "It looks fine on my phone" is NOT proof the scoped
  mint fired — check the marker/log.
- **Cross-origin wall stands (§2b, proven).** `mesh.spaceworker.top` ≠ `spaceworker.top`: no CSS
  injection, no touch injection, no proxy without owning MeshCentral's full traffic. New tab +
  MeshCentral's native guest/mobile UI is the honest answer; do NOT promise TASK_208-style injection
  into MeshCentral content.
- **Hostname → node mapping is fail-closed by design** (`matchMeshNode`, Task 106): duplicate or
  ambiguous hostnames across orgs → `null` → fallback (leak returns for that request, loudly logged).
  Renamed/multi-homed hosts are the trigger; S3 exercises the mapping against the real inventory.
- **Token semantics:** on the scoped path the TRMM `login=` URL is minted but discarded (Vantra's own
  meshctrl-style token does the share mint); the customer's pendingActionId freshness gate in
  `fetchMeshUrls` (`device-console.tsx:572-575,1633,1739` — TASK_103/170 history) is untouched.
- **Desktop must not regress** — the entire point is "don't switch to mobile and break things." Gate
  on desktop pixels unchanged.

## 6. Owner decisions — RESOLVED 2026-10-15 (direction locked; final implementation go-ahead covers the §5 touch caveat)
1. Leak fix → **Fix for real (A1):** Vantra-side per-device share mint (V1). Display-only hiding (A2) rejected.
2. Mobile UX → **Open in new tab** — no same-origin proxy (B1 rejected). One honest caveat surfaced in review: the TASK_208 touch module cannot inject into cross-origin MeshCentral, so touch/keyboard in the new tab is MeshCentral's own guest/mobile UI, not our overlay.
3. Touch module → **`lib/touch-controls.ts` is the single touch engine for same-origin embeds** (n.eko/TASK_208, shipped); MeshCentral's cross-origin guest view is the documented exception.

## 7. Gates (binding — playbooks §5/§12/§13)
- `tsc --noEmit` → 0 errors in BOTH repos. `eslint` on touched files → 0 new. Existing tests stay green.
- New tests: Vantra share-message builder (`p:7`, `viewOnly:false`, `expire:0`, `consent:0`) + route
  `scope=device` mint/fallback behavior; SpaceWorker source contracts (customer sends `scope=device`,
  admin does NOT; below-`sm` new-tab strings present; desktop iframe block unchanged).
- Desktop (>sm) console layout byte-for-byte unchanged (diff guard on the desktop branch of
  `device-console.tsx`).
- Live S3: minted URL → HTTP 200 serving a SINGLE-device guest view (no group/tree) — curl-verified
  before any phone claim; `scoped:true` present in the route response.
- Live S4 (blocked on device): phone opens new tab → only the owner's device; NO "Individual Devices"
  group; desktop renders exactly as today.
- Deploy both repos via the hardened script (TSTP/TTIN/TTOU trap); verify new BUILD_ID, no
  maintenance-page flash; rollback on build fail.

