# TASK_205 — Hosting: editable Desktop-only wording + "link"→"file" + optional Desktop/Mobile split destinations

**Status:** PLANNED — expanded 2026-10-14 (added the platform-split feature; still no code)
**Owner report (verbatim intent):**
1. "the redirect links in hosting for desktop, if its possible to make another button beside the desktop select so users can edit the redirect wordings."
2. "i want to change the current wording from link, to file."
3. "a button that allows user gate the desktop to a different link and the mobile to another link. That means user will have to provide the desktop link and mobile link, then we provide them with a single redirect for both, I want the function dynamic and optional, so users can choose any flow."

**Repo:** `spaceworker` (`/Users/mikeolab/spaceworker`).
**Branch (this task):** new branch `agent/task-205-link-routing-wording`, cut from **`origin/main`** (NOT the current `agent/task-206-quarantine-rework` — TASK_206 touched device-onboarding/devices/device-list/device-console/vantra-link and **zero** hosting files, so TASK_205 is independent and rebases cleanly off main). HEAD at planning time: `cb8ec7b`. STEPS tracker: `TASK_205_STEPS.md`.
**Playbook:** `HOW_WE_MOVE_FAST.md`. Hosting regression suites are binding (§ gates).

---

## 1. What exists today (ground truth — verified 2026-10-14, real greps)

The Desktop-only gate is **TASK_175**, premium-only. A mobile/tablet opener of a gated link sees a white "open this on your PC" interstitial instead of the redirect; a desktop opener (or `?desktop=1`) passes through.

- **Schema** (`prisma/schema.prisma`, `model LinkRedirect`): `target String` (the single destination) + `desktopOnly Boolean?` (NULL = gate off). **No per-link wording column and no second (mobile) destination column exist yet.**
- **The interstitial copy is HARD-CODED in TWO places** (core of the task):
  - **Local `/r/<token>` resolver** — `lib/hosting/links.ts:626 desktopOnlyInterstitialHtml(continueUrl)`. Copy: title `Open this on your PC`; body `This link opens best on a desktop computer. Please open it on your PC to continue.`; button `Continue anyway`; note `On a desktop? Tap Continue anyway.`
  - **Edge Cloudflare Worker** — `lib/hosting/workers.ts:782 WORKER_DESKTOP_GATE_SNIPPET` — the SAME copy duplicated (stringified into the per-user Worker script; snippet deliberately dependency-free so it does not bundle server-only modules).
- **Resolver wiring** — `app/r/[token]/route.ts:38-52`: resolves via `resolveLink(token)` → `{ id, target, desktopOnly }`; if `desktopOnly && mobile && !?desktop=1` serve interstitial; else `NextResponse.redirect(link.target, 302)`. `resolveLink` at `lib/hosting/links.ts:581`. Mobile detection: `isMobileUserAgent(ua)` at `:601`.
- **Edge Worker map** — `buildWorkerMapSource(entries)` (`lib/hosting/workers.ts:799`) emits `const MAP = {...}` (key→target) + `const DESKTOP = new Set([...])`; the fetch handler 302s to `MAP[key]`, and for a `DESKTOP` key runs `t175IsMobile` → interstitial. **`WorkerMapEntry = { key, target, desktopOnly? }`** (`workers.ts:763`). Entries are built from rows in **`mapEntriesFor`** (`lib/hosting/links-engine.ts:127`) which selects `token, slug, target, customHost, desktopOnly` and pushes one entry per key (token AND slug each).
- **Validation** — `isValidLinkTarget(value)` (`lib/hosting/rules.ts`): `http:`/`https:` only.
- **Entitlement** — `canUseDesktopOnlyGate(userId)` (`lib/hosting/links.ts:151`). The desktop-only gate is premium-only at mint AND update (`links.ts:246`, `:422`).
- **Create-form checkbox** — `components/hosting-panel.tsx` (~`:1467-1478`): `Desktop only — mobile openers see "open on your PC"`, rendered only when `status.desktopOnlyAllowed === true`. **Per-link toggle** (~`:1546-1554`): `Desktop-only: on/off`. (Line numbers from the 2026-10-14 scan — re-confirm on the new branch at implementation.)
- **Create/update API** — `createHostedLink` (`lib/hosting/links.ts:230`), `updateHostedLink` (`:345`), `UpdateHostedLinkInput` (`:329`). A cloudflare edit re-publishes the Worker (the `marked`/`updated` path at `:445-489`).
- **View model** — `HostedLinkView` (`links.ts:~40`) + `toHostedLinkView` (`:65`); `HostedLinkView.desktopOnly` reads `row.desktopOnly === true`.
- **Tests** — `tests/hosting-desktop-gate.test.ts` (interstitial content/escaping, worker-map gating, premium persistence) and `tests/hosting-workers.test.ts` (map-source isolation, publish order). Runner: `npm test` = `tsx --test tests/*.test.ts`.

---

## 2. Scope (what we build)

Two additive, optional capabilities on the SAME link, plus a copy change. All are per-link, NULL-defaulted, so every existing row (incl. the 12 anonymous Task-30 campaign links) reads back unchanged and `/r` keeps its current behaviour.

### Part A — Editable desktop-only wording + "link"→"file"

### S1 — Persist per-link editable wording (additive, nullable)
- New nullable columns on `LinkRedirect`: store the owner-editable interstitial copy. Keep it to the **two user-visible sentences** (title + body); the `Continue anyway` button and the `On a desktop?` note stay fixed (escape hatch, not marketing copy).
  - Proposed fields: `desktopTitle String?` + `desktopBody String?` (NULL ⇒ today's defaults). **Additive migration** — every existing row reads back as the current default, `/r` unchanged.
- **Why two columns, not one blob:** each is validated and HTML-escaped independently at render; a single free-text blob invites injection review across two render paths (local + edge). Keep the surface minimal.
### S2 — Thread the wording through BOTH render paths
- `desktopOnlyInterstitialHtml(continueUrl, wording?)` — local `/r` path. Defaults unchanged when `wording` is absent. HTML-escape title + body (the function already escapes the URL; extend the same care to the new text — the interstitial is user-influenced content rendered as HTML).
- Edge Worker: the per-user map already carries `key → target` + a `DESKTOP` set (`lib/hosting/workers.ts:799 buildWorkerMapSource`). Add a parallel `desktopTitle`/`desktopBody` map (key → wording) so the edge gate renders the custom copy. **Re-publish the Worker on edit** (same mechanism as target changes — the map is rewritten and re-PUT).
- **Rule:** a gated link's custom wording must render identically on `/r` and on the edge, or the feature is half-true. A unit test asserts both builders embed the same title/body for the same input.



### S3 — UI: an "Edit wording" button beside the Desktop-only select
- Beside the create-form `Desktop only` checkbox **and** on each per-link row (next to the existing `Desktop-only: on/off` toggle): an **Edit wording** button that opens a small modal with two fields (Title, Body) + live preview of the interstitial card.
- Editing is **premium-only** (same `desktopOnlyAllowed` gate — no new fetch). Free users never see the button.
- Save routes through the existing create/update link API with the two new fields; a per-link edit re-publishes the Worker when the link is `engine:"cloudflare"`.

### S4 — Copy change: "link" → "file" (desktop-only surfaces)
Owner: "change the current wording from link, to file." Interpreted as: **where the desktop-only feature calls the redirected thing a "link", call it a "file"** (the thing being gated is a hosted file). Exact strings to change (documented so verification is mechanical):
- Interstitial body: `This link opens best…` → `This file opens best on a desktop computer. Please open it on your PC to continue.` (in BOTH `lib/hosting/links.ts` and `lib/hosting/workers.ts` — they must stay identical).
- Create-form helper: keep `— mobile openers see "open on your PC"` (no "link" there).
- **NOT changed** (out of scope — these "link" uses are correct/structural): the tab label `Links`, `Short links that redirect…`, `The link is served by a Cloudflare Worker…`, `Create link`, delete confirm `The link will stop working.` If the owner wants those too, that is a follow-up — flagged, not assumed.

### Part B — Optional Desktop / Mobile split destinations ("one redirect for both")

The user provides a **desktop link** and a **mobile link**; we give them the SAME single `/r/<token>` redirect, which sends each platform to its own destination. Routing is decided at open time from the opener's platform (dynamic) and the mobile destination is optional (NULL mobile destination = today's single-target behaviour).

**Three optional flows, one model (the user "chooses any flow"):**

| Flow | `mobileTarget` | `desktopOnly` | Desktop opener | Mobile/tablet opener |
|---|---|---|---|---|
| Single (default) | NULL | off | 302 → `target` | 302 → `target` |
| Split (NEW) | set | off | 302 → `target` (the "desktop link") | **302 → `mobileTarget`** (the "mobile link") |
| Desktop-only gate (TASK_175) | NULL | on | 302 → `target` | white interstitial |

**Precedence (documented + tested):** if BOTH `mobileTarget` is set and `desktopOnly` is on, **split wins** — a mobile opener always has a real destination to go to, so the interstitial is not shown. The UI de-emphasises the desktop-only toggle when a mobile link is present and states the precedence in a note. (Mental model: `mobileTarget` set ⇒ the link is "split", full stop.)

#### B/S5 — Persist the mobile destination (additive, nullable)
- New nullable column **`mobileTarget String?`** on `LinkRedirect`. NULL = single-target (today). Validated with `isValidLinkTarget` (http/https only). Trimmed; empty string normalised to NULL.

#### B/S6 — Thread the split through BOTH render paths
- **Local `/r`** (`resolveLink` + `app/r/[token]/route.ts`): `resolveLink` returns `mobileTarget`. Route order: `if (mobile && mobileTarget && !?desktop=1) → 302 mobileTarget` (counts the click) **before** the desktop-only interstitial check; else today's logic. `?desktop=1` on a split link forces the desktop `target`.
- **Edge Worker**: add `mobileTarget` to `WorkerMapEntry`; `mapEntriesFor` selects it and stamps token+slug entries; `buildWorkerMapSource` emits a parallel `const MOBILETARGET = {...}` map (URLs embedded via `JSON.stringify`, exactly as `MAP` already is — no HTML escaping needed, it's a JS string literal fed to `Response.redirect`). Fetch handler: for a key present in `MOBILETARGET` whose value is truthy, `t175IsMobile(ua)` → `Response.redirect(mobileTarget, 302)`; else `MAP[key]`. Split checked before the `DESKTOP` gate.

#### B/S7 — UI: a "Split by device" button beside the Desktop-only select
- Beside the create-form checkbox and on each per-link row: a **Split by device** button → modal with **Desktop link** + **Mobile link** fields + a live preview showing "Desktop opens → X · Mobile opens → Y" and the resulting single `/r/<token>` link. Optional: leaving Mobile blank = single-target. Save routes through the create/update API; cloudflare edit re-publishes.
- **Premium gate (DEFAULT, owner-confirmable):** reuse `canUseDesktopOnlyGate` — the split sits beside the desktop-only feature and is the same class of advanced routing. If the owner wants it free, it is a one-line removal of the entitlement check (flagged in §5, not assumed).

---

## 3. Plan (slices → gates → commit each)

One migration, one branch. Order chosen so the shared plumbing lands first and each render path is proven before the next is touched.

- **A1 — schema + migration.** ONE migration adding `desktopTitle`, `desktopBody`, `mobileTarget` (all nullable) to `LinkRedirect`. Timestamp **strictly greater** than `20261121000000` (newest on `origin/main` — re-verify with `git fetch origin; git ls-tree --name-only origin/main prisma/migrations/ | tail -3` per the §23 trap; local `main` drifts). Proposed: `20261122000000_task205_link_routing_and_wording`. `db:generate`; `db:push` locally to confirm replay.
- **A2 — Part A render paths (wording).** `desktopOnlyInterstitialHtml(..., wording?)` + edge wording map; defaults byte-identical when absent. `toHostedLinkView`/`HostedLinkView` expose `desktopTitle`/`desktopBody`.
- **B2 — Part B render paths (split).** `resolveLink`+route mobile-target branch; `WorkerMapEntry.mobileTarget` + `mapEntriesFor` + `buildWorkerMapSource` `MOBILETARGET` map + fetch branch. `toHostedLinkView` exposes `mobileTarget`.
- **A3/B3 — create/update API.** Accept `desktopTitle`/`desktopBody`/`mobileTarget` (validated length, trimmed, NULL-able); persist behind `canUseDesktopOnlyGate`; re-publish Worker on cloudflare edit.
- **A4/B4 — UI.** Two buttons beside the desktop-only select (Edit wording, Split by device) + modals + previews, on create form AND per-link row. Premium-only.
- **A5 — copy.** "link"→"file" per §2 S4, both interstitial copies identical.
- **A6 — gates + deploy.** `tsc` 0 · eslint 0 new · hosting suites green · `test:hosting` regression · build. Deploy per §2 playbook (shared prebuilt build). Live-verify: a gated link's custom wording, AND a split link routing desktop vs mobile to different destinations, on `/r` AND on the edge Worker.

## 4. Gates (binding)
- `npx tsc --noEmit` → 0; ESLint on touched files → 0 NEW.
- All hosting suites green (`tests/hosting-*.test.ts`); **`test:hosting` must not regress**.
- New tests:
  - Default interstitial copy unchanged (guards the "link"→"file" from over-reaching).
  - Custom wording renders on BOTH local + edge; HTML-escaped (`<script>`/`"` inert).
  - Split: local `/r` 302s mobile→`mobileTarget`, desktop→`target`; `?desktop=1` forces desktop.
  - Split edge: `MOBILETARGET` map present; a mobile UA for a split key 302s to the mobile target; desktop UA → `target`.
  - Precedence: `mobileTarget` set + `desktopOnly` on ⇒ mobile gets the redirect, NOT the interstitial.
  - `mobileTarget` validated (junk URL rejected); a link with no `mobileTarget` resolves exactly as today.
  - Non-premium cannot set `mobileTarget`/wording (silently dropped, same posture as `desktopOnly`).
- Migration replays on a fresh DB and does not touch the 12 anonymous Task-30 links.
- Deploy: fresh BUILD_ID, service active, site 200, repo↔box md5 parity on touched files, and verify the routing/wording **inside the built chunk** (not `lib/` — the build-is-runtime rule).

## 5. Risks / notes
- **Injection (wording):** the interstitial is HTML; title/body are user-influenced. Escape on both render paths; a test feeds `<script>`/`"` and asserts inert output. The edge copy is stringified into a Worker — escape for the JS-string context too (mirror the existing `contJson` escaping at `workers.ts:783`). `mobileTarget` is NOT HTML (it feeds `Response.redirect`), embedded via `JSON.stringify` like `MAP` already is — but it must still pass `isValidLinkTarget` so an opener is never redirected to a `javascript:`/`data:` URL.
- **Two copies of the copy:** local + edge must be updated together (wording) or the feature drifts. A test pins them equal.
- **Precedence must be one story:** split vs desktop-only. Pinned by a test + stated in the UI so it's never ambiguous to the user.
- **Money/premium (DEFAULT, owner-confirmable):** Part A reuses `desktopOnlyAllowed` (no new entitlement). Part B default-reuses `canUseDesktopOnlyGate` — if the owner wants split free, drop that one check. No pricing surface touched either way.
- **Independent of TASK_206:** no shared files; branch off `origin/main`.

