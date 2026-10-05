# TASK 161 — Dashboard as a real OS: tiny cards, top status bar, 3D centrepiece, support button, wallpaper

**Status: SCOPED, not started.** Written 2026-10-05 from the owner's sketch + verbal brief.
This doc is the *scope*, not the work. Every claim about current code was read from the repo
on 2026-10-05 and cites `file:line` so the next agent can verify rather than trust.

## 0. Owner's brief

> take out the cards, make some tiny cards just the way it is on the menu on the left, that way
> we can show other apps or subtabs like mailbox; the upper part will be for wallet balance, ai
> bal and used for the day, devices numbers, agent actions; in the middle where I wrote 3d we will
> have a 3d animation of a robot running round a space or a globe... allow users upload theirs as
> wallpaper. I want it like a real OS. And a button just like the agent button on the right, I want
> the support button on the left, and I should be able to send any user a message and it shows there.

The sketch is a macOS-style window: title bar (traffic lights, app name, clock, sign out), a
left sidebar of tiny tiles, a top row of 4 status cells (**Wallet / Bal / Devices / Agent**),
and a large empty centre labelled "3D".

---

## 1. What exists today (verified — do not re-derive)

| Thing | Reality | Cite |
|---|---|---|
| OS chrome | Already an OS: menu bar, traffic lights, clock, dock | `components/shell.tsx:18-60` |
| Nav data | **Single source of truth**, consumed by dock + sidebar + mobile row | `components/dashboard-nav.tsx:37-59` |
| Build narrowing | Only `extractor` narrows; other targets see the full nav | `components/dashboard-nav.tsx:64-66` |
| Big cards | Overview grid from `useNavItems()` **re-filtered by a hardcoded `href` list** | `app/dashboard/page.tsx:22-39` |
| Agent button | `fixed bottom-5 right-5 z-50`, self-hides when `enabled === false` | `components/agent-widget.tsx:315` |
| Ambient 3D | Exists but is **static CSS `rotateX/Y/Z` panels, no motion** | `components/desktop-background.tsx:1-5` |
| Wallet read | `getWallet()` returns `balanceCents` / `spendableCents` / `postpaidLimitCents` | `lib/wallet.ts:78-91` |
| AI used today | `getUsedAiTodayHundredthsCent(userId)` exists | `lib/ai-metering.ts:31` |
| Support backend | `listUserTickets` / `getUserTicket` / `addUserMessage` + admin equivalents exist | `lib/support/tickets.ts:357-574` |
| Support routes | 6 authenticated routes exist, **zero UI** | `app/api/support/**`, `app/api/admin/support/**` |
| 3D library | **NONE.** No `three`, no `framer-motion`, no chart lib | `package.json:55-77` |
| Wallpaper | No user preference column exists at all | `model User`, `prisma/schema.prisma` |

### Decisions — the centrepiece and wallpaper are now RESOLVED (2026-10-05, owner)

> Both were open questions when this doc was first written. **Read §2 D6 before coding** — the
> centrepiece answer changed and the SVG/CSS option is withdrawn.

1. **The centrepiece — RESOLVED: a real, free, looping 3D VIDEO ASSET.** The owner rejected an
   SVG/CSS stand-in explicitly ("the 3D has to be REAL 3D, I don't want a fake"). So option (b)
   below is **withdrawn**. Full scope, the **measured** real-time-3D cost (which is ~130–200KB
   gzipped, not the ~700KB previously estimated), the licence-verification gap, and the phases
   are in **§2 D6**. Summary: a `<SpaceScene />` component wrapping a muted/looping/playsinline
   `<video>`, preset clips chosen by the admin, zero new npm dependencies.

2. **Wallpaper storage — PAUSED, not cancelled.** The owner locked **D1 WALLPAPER: PAUSED**:
   no per-user wallpaper isolation, so custom wallpaper uploads are **out of scope for now**.
   Revisit **only if** per-user isolation becomes a one-migration change. The options below are
   kept for that day but **nothing here should be built**. Note the interaction: the centrepiece
   is a **preset** asset, so pausing uploads costs nothing visually.
   - **(a)** Disk under a served static path — simplest, no schema, but a deploy rsync can
     wipe it and there is no per-user isolation.
   - **(b)** Upload endpoint + a `User.wallpaperKey` column served through an authenticated
     route. Survives deploys, per-user, costs a migration.
   Regardless, when it resumes: cap ~5MB, allow-list image MIME types, randomise the stored
   filename, never trust a client-supplied name or content-type.

---

## 2. Phase plan (each phase independently shippable + revertible)

### D7 — Marketing page: add Cyber Lab + Hosting pillars  ← **do this first**
`app/page.tsx:98-118` has exactly three `Pillar`s (Find & Reach / Assistant & Devices /
Automate). Hosting and Cyber Lab are **absent**, though both are shipped, nav-listed
(`components/dashboard-nav.tsx:51-55`) and store-sellable (`HOSTING_MODULE`,
`lib/products.ts:123-131`). Cheapest high-value item in this whole task and independent of
everything else — ship it first.

### D1 — Overview cards → tiny nav-shaped tiles
**⚠ CORRECTED 2026-10-05 (owner) — the `Mailboxes` half of this item was WRONG.**
Do **NOT** add `Mailboxes` to `NAV_ITEMS`. `app/dashboard/mailboxes/page.tsx:11` is
`redirect("/dashboard/campaigns?tab=mailboxes")` — Mailboxes is a **tab inside Campaigns**,
which is where the owner wants it. Same for `/dashboard/browser-profiles` →
`/dashboard/browser?tab=profiles` and `/dashboard/licenses` → `/dashboard/settings#licenses`.
**There is no orphaned-page defect**; an earlier handoff claimed there was and was corrected.
Adding a nav entry would have created a *second* entry for a tab that already exists.
See `PLAN_TASK_165_OS_DASHBOARD_REDESIGN.md` §0 C1.

The rest of the item stands: replace the card grid in `app/dashboard/page.tsx` with a compact
tile grid, icon + short label, **driven from `useNavItems()` with the hardcoded `href`
filter deleted**. That filter (the allow-list including `i.href === "/dashboard/mailboxes"`,
a condition that can never be true) is what silently dropped every newly added app — which is
why Billing existed but appeared nowhere. **Delete it; do not patch it.**

### D2 — Top status bar — **UNBLOCKED 2026-10-05**
One row above the content, four cells: **Wallet** (`getWallet().balanceCents` +
`spendableCents`, showing the postpaid line when negative), **AI balance + used today**
(`getUsedAiTodayHundredthsCent` + `formatCents`), **Devices** (count + online), **Agent**
(last action / pending approvals). All server-read, no polling spike. Cells link to
`/dashboard/billing`, `/dashboard/devices`, etc.

**Was blocked on W2** (`GET /api/wallet`). **That is now shipped** — commit `231ae31`, deployed
and live-verified 2026-10-05 (`/api/wallet` unauthenticated → **401**, and the compiled deployed
chunk shows the handler as `allowAndRecord(…,"wallet-read")` → `getCurrentUser()` →
`getWallet(t.id)`). So the Wallet cell can call the same route the billing card uses. Do **not**
call `getWallet()` from the client component directly — it is server-only; fetch the route.

### D3 — Support button on the left + both UIs
- New `components/support-widget.tsx`, mounted in `components/shell.tsx` **left of** the agent
  widget. Mirror the agent button's footprint (`bottom-5 right-5 z-50` → the support button
  sits at `left-5`, or immediately left of the orb via `right-20`). Same open/close, same
  z-index, same EXE suppression (`{!buildTarget && …}` — the EXE has no `DATABASE_URL`, see
  `components/shell.tsx:64-67`).
- **User composer**: list own tickets → open thread → reply. Backs onto `lib/support/tickets.ts`
  + the 3 existing `/api/support/**` routes. **No new API needed.**
- **Admin queue**: list all tickets → thread → reply → `open → resolved`. Backs onto
  `/api/admin/support/**`. Also **no new API needed.**

### D4 — Owner-initiated message to any user — **DECIDED 2026-10-05: admin-composed ticket**
> "I should be able to send any user a message and it shows there"

**This genuinely needs a schema decision before it is buildable.** Verified in the schema today:
- `SupportMessage.ticketId` is a **required FK** to `SupportTicket` with `onDelete: Cascade`
  (`prisma/schema.prisma:3537-3541`). A message **cannot exist** without a ticket.
- `SupportTicket.userId` is documented **immutable, never reassigned** (`:3494-3495`).

So there is **no way to open a thread with a user who has never filed a ticket**, and reassigning
an existing ticket's owner is explicitly forbidden. This is a real constraint, not an oversight.

**Decision — route (a), the admin-composed ticket.** Let `createSupportTicket` accept an
`actorId` (the admin) so the admin opens a ticket **on behalf of** a chosen user.

Why (a) and not a separate messaging model:
1. **One thread model.** Every existing read path — user list, thread read, admin queue,
   reopen/resolve transitions — works unchanged. A second model means the UI and the admin queue
   special-case a message type forever.
2. **No new UI surface** beyond the admin composer.
3. The `authorRole` CHECK (`user` | `admin`) and the nullable `authorId` (`:3542-3551`) both keep
   working as-is.

**The security rule that makes this safe, and it is non-negotiable:**
> The **target user** MUST come from the **admin session**, never from the request body.

Reading the target `userId` from the body is exactly the bug the schema comment at `:3492-3494`
warns about (a crafted POST files a ticket against another user). The `actorId` — the admin
doing the composing — also comes from the session. **Only the message body and the subject may be
client-supplied.**

Implementation notes:
- `createSupportTicket` currently resolves identity from the session; add an explicit
  `onBehalfOfUserId` parameter that is only reachable from an **admin-guarded** route, so the
  user-facing route cannot be widened by accident.
- Set `status` to something that is **not** the literal `"resolved"`, and re-read
  `prisma/schema.prisma:3497-3505` first: `status` is a deliberately **un-CHECKed** extensible
  string, and readers treat **only** exactly `"resolved"` as closed. Do **not** add a CHECK here.
- Consider `category`/`priority` values that mark it as admin-initiated so the admin queue can
  distinguish "we reached out" from "they asked".
- No migration is required for route (a) — it is a code change over the existing models.

### D5 — Wallpaper preference
Per §1 decision 2. Also honour `prefers-reduced-motion` on the centrepiece, and keep the scene
`aria-hidden` and purely decorative (the existing `DesktopBackground` is correctly `aria-hidden`).

### D6 — 3D centrepiece — **RESOLVED 2026-10-05 (owner): REAL 3D, looped VIDEO ASSET**
> Owner: *"The 3D has to be REAL 3D. I don't want a fake. A robot running round a space or a
> globe, and I want a few options they can pick from. Free — I'm not paying for it and users are
> not uploading anything."*

**Decision (locked, do not relitigate):** the centrepiece is a **short looping 3D VIDEO ASSET** —
a robot running around a space/globe — **sourced free**, shipped as **preset options**. No user
uploads (which is also why **D1 WALLPAPER is PAUSED**: see §1 decision 3). The same asset must
appear on the **MARKETING page**.

This **supersedes §1 decision 1 option (b)** (SVG/CSS stand-in). Option (a) — the three.js stack —
was the only other candidate and is now measured below.

#### D6.1 The real-time-3D cost, measured (not estimated) — 2026-10-05
I installed the stack in a scratch dir and measured the actual gzipped payload rather than
repeating the "~700KB" figure in the brief:

| Package | Version | Installed size | Gzipped ESM entry |
|---|---|---|---|
| `three` | 0.186.1 | 22 MB unpacked | **~128 KB** gz (`build/three.module.js`) |
| `@react-three/fiber` | 9.8.1 | 2.4 MB unpacked | ~3 KB gz core + ~75 KB gz shared `events` chunk |

Both are **MIT** (`node_modules/three/LICENSE` verified). `@react-three/drei` (10.7.9) is an
optional extra and was **not** measured — it is the heavy one.

**Honest correction:** "~700KB gzipped" is an over-estimate for `three` + `fiber` alone. The real
figure is **~130–200KB gzipped, code-split**, and only for users who load the dashboard centrepiece.
Three corrects it downward; the conclusion (defer the stack) is unchanged because the owner has
already chosen the video asset, which needs **zero** dependencies.

#### D6.2 Why a video asset is also the right call, technically
- **Zero new dependencies.** The repo has no `three`/`framer-motion` (`package.json:55-77`).
- **Costs nothing on the VPS.** No GPU/WebGL concerns, no server-side rendering.
- Works identically on the marketing page, in the dashboard, and in the **Tauri EXE builds**,
  which have no `DATABASE_URL` and must not grow a heavy runtime.
- Degrades perfectly: `<video muted loop playsinline autoplay>` with a static poster.

#### D6.3 Licensing — **NOT YET VERIFIED. This is a blocker, see §6.**
I could **not** verify any stock-video licence. `pexels.com`, `help.pexels.com`, `pixabay.com`
and `pixabay.com/service/license-summary/` all returned **HTTP 403** to automated fetches, and
Mixkit's terms load from JavaScript modals (`mixkit.co/license/` returns only the modal triggers,
not the licence text). The one candidate I did retrieve (`rissoverfoundation.org/assets/
pixabay_license.pdf`) came back as **raw uncompressed PDF binary**, not readable text.

**I am therefore NOT asserting that any of these licences permit commercial use.** The brief said
"verify, do not assume" and I could not verify. Candidates to check **by hand in a browser**, in
this order:

| Source | Why | Must confirm |
|---|---|---|
| Mixkit "Stock Video **Free** License" | Envato-owned, no signup | Note Mixkit has BOTH a *Free* and a *Restricted* video licence — only the Free one is a candidate, and the item's licence type must be read per-item |
| Pexels | Large 3D/space library | Commercial use in a paid SaaS; no attribution; redistribution-as-standalone prohibited |
| Pixabay | Large library | Same three questions |

**For each chosen asset, record: the source URL, the exact licence name, the licence URL, the
date fetched, and the asset ID.** Keep that as a tracked file (e.g. `ASSETS_LICENCE.md`) so the
answer survives a session. If a licence forbids redistribution inside a product, that asset is
out regardless of how good it looks.

**Recommended safe pattern:** use an asset whose licence explicitly permits commercial use AND
distribution as part of a website/product, keep the asset file in-repo (not hotlinked), and
prefer a **dedicated/free-to-use 3D or motion-graphics source** over generic stock footage.

#### D6.4 Phases (independently deployable)
- **V1** `<SpaceScene />` shell: an autoplaying/muted/looping/playsinline `<video>` with a
  static poster, `prefers-reduced-motion` honoured (pause or poster-only), `aria-hidden` +
  `pointer-events-none` (it is decorative), and a CSS fallback when the asset is absent.
  Mounted in the dashboard centre slot. **Zero deps, zero licences needed** (any placeholder).
- **V2** Preset picker: 3–4 vetted clips, selected via `AdminSetting` (the setting mechanism
  already exists — `AdminSetting.cyberlab*`, `AdminSetting.hostingPremiumMaxLinks`). **No user
  uploads** — this is what keeps D1 PAUSED and true.
- **V3** Marketing page hero uses the same `<SpaceScene />`, so one asset serves both surfaces.
- **V4** *(only if the owner later wants it)* real-time `three`/`fiber` scene behind the same
  `<SpaceScene />` boundary. The component boundary from V1 is what makes this a drop-in.

#### D6.5 Rules
- Never ship a licence-unverified asset. An unverified licence is a release blocker, not a nit.
- `aria-hidden`, `pointer-events-none`, and a poster so the element never blocks a control.
- Must not regress `prefers-reduced-motion` — a looping video for a vestibular-sensitive user is
  an accessibility defect, not a preference.
- No autoplay-with-sound. Muted is a browser requirement, not a style choice.

---

## 3. Build order (each phase independently deployable)

| Phase | What | Blocked on |
|---|---|---|
| **D7** | Marketing pillars + Hero + `SpaceScene` on the marketing page | Nothing — **start here** |
| **D1** | Tiny nav-shaped tiles. **Do NOT add `Mailboxes` to `NAV_ITEMS`** (corrected 2026-10-05 — it is a tab inside Campaigns) | Nothing |
| **D2** | Top status bar (4 cells) | W2 — **now shipped**, so unblocked |
| **D3** | Support button (left) + user composer + admin queue | Backend exists; UI only |
| **D4** | Admin-composed ticket ("message any user") | Decision made — **no migration needed** |
| **D6 V1** | `<SpaceScene />` video shell, no asset yet | Nothing (zero deps) |
| **D6 V2/V3** | Preset clips + same scene on marketing | **Licence verification** |
| D5 | Per-user wallpaper | **PAUSED by owner** — do not build |

**Recommended next step: D7**, because it is copy-only, touches one file (`app/page.tsx`), has no
dependency on any of the above, and is the item most likely to be noticed by a prospect.

## 4. Hard rules for whoever builds this

1. **Nav data stays the single source of truth.** Never hardcode an app list in the overview;
   the dead `href` allow-list that did exactly that is now deleted. (It never actually hid
   Mailboxes — see the D1 correction above.)
2. **`getWallet()`/`listLedger()` are server-only.** No wallet arithmetic in a client
   component. Integer cents end to end; `formatCents` for display. The **client** must go through
   `GET /api/wallet` (shipped, `231ae31`), never import the service.
3. **No Cloudflare token ever reaches a ticket** — `PLAN_TASK_159` + `lib/support/redact.ts`.
4. **Build-target narrowing must not regress.** If D1 adds tiles, the Extractor EXE must still
   not render Hosting/Cyber Lab tiles.
5. **Never ship a licence-unverified 3D asset** (§2 D6.3).
6. **The target user id in D4 comes from the admin session, never the request body.**
7. **Every phase ends with the full suite green**: `npx tsc --noEmit`, `npm run test:hosting`
   (334), `npm run test:support` (30), `npm run test:wallet` (29), touched-file ESLint,
   `CI=true npm run build`. **No CI runs these** — trap 2 in §5 of the handoff.
8. **Commit, push, deploy are three separate steps.** Pushing to main does not deploy. Only
   `gh workflow run deploy.yml --ref main` deploys, and you must check the **job list** — a
   green run can have SKIPPED the deploy job.

## 5. Blocked on — status 2026-10-05
- ~~**W2** (`GET /api/wallet`)~~ — **RESOLVED.** Shipped, deployed and live-verified.
- ~~**D4** needs an owner decision~~ — **RESOLVED.** Admin-composed ticket (§2 D4), no migration.
- **D5 (wallpaper)** — **PAUSED by the owner.** Not a blocker; out of scope.
- **D6 assets** — **BLOCKED on licence verification** (§2 D6.3). The `<SpaceScene />` shell (V1)
  is *not* blocked; only putting a real clip in it is.
- **D6 real-time 3D** — not needed for the chosen approach.

## 6. Open questions I deliberately did NOT guess
1. **Which stock footage is actually licensed for this** — unverifiable by tooling here (§2 D6.3).
   Needs a human in a browser.
2. **Should the centrepiece differ per build target / EXE?** Video bytes in a Tauri bundle is a
   different packaging decision than video in a web page.
3. **Does an admin-initiated ticket notify the user?** There is **no email wired to tickets at
   all** today (Task 159 Phase 1 is API-only), so "it shows there" is currently true only if the
   user opens the dashboard. If it must reach them, that is new work.
4. **How long should an admin-initiated ticket stay open**, and does the user replying to one
   count as them "opening" a support relationship for SLA purposes?

## 7. Not in scope here
Store multi-select pricing (→ `PLAN_TASK_162_STORE_MULTISELECT.md`) and self-host per-module
builds (→ `PLAN_TASK_163_SELFHOST_DEVICES_FIRST.md`). Both were requested in the same breath
and are scoped separately because each needs its own migration or build matrix.
