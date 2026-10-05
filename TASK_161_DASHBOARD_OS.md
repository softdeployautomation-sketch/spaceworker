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

### Two decisions the owner must confirm before coding

1. **The centrepiece.** A real WebGL globe with a robot orbiting it means adding `three` +
   `@react-three/fiber` + `@react-three/drei` (~700KB gzipped before scene content). There is
   **no 3D dependency in this repo today**. Options:
   - **(a)** Add the three.js stack. Real globe, real orbit, best result, new heavy dep.
   - **(b)** CSS/SVG-only: an SVG globe with a robot sprite on a CSS orbit. No new dependency,
     works everywhere, far lighter. **Recommended to start** — swappable for (a) later.
   Build it as `<SpaceScene />` with the implementation internal so (a) can replace (b)
   without touching the dashboard.

2. **Wallpaper storage.**
   - **(a)** Disk under a served static path — simplest, no schema, but a deploy rsync can
     wipe it and there is no per-user isolation.
   - **(b)** Upload endpoint + a `User.wallpaperKey` column served through an authenticated
     route. Survives deploys, per-user, costs a migration. **Recommended.**
   Regardless: cap ~5MB, allow-list image MIME types, randomise the stored filename, never
   trust a client-supplied name or content-type.

---

## 2. Phase plan (each phase independently shippable + revertible)

### D7 — Marketing page: add Cyber Lab + Hosting pillars  ← **do this first**
`app/page.tsx:98-118` has exactly three `Pillar`s (Find & Reach / Assistant & Devices /
Automate). Hosting and Cyber Lab are **absent**, though both are shipped, nav-listed
(`components/dashboard-nav.tsx:51-55`) and store-sellable (`HOSTING_MODULE`,
`lib/products.ts:123-131`). Cheapest high-value item in this whole task and independent of
everything else — ship it first.

### D1 — Overview cards → tiny nav-shaped tiles
Replace the card grid in `app/dashboard/page.tsx` with a compact tile grid: icon + short
label, sized like the dock icons. **Drive it from `useNavItems()` with the hardcoded `href`
filter deleted** so a new app appears automatically — that filter is exactly how Mailboxes
went missing from the overview while it exists in `app/dashboard/mailboxes` and in the
description map (`app/dashboard/page.tsx:15`). Also add `Mailboxes` to `NAV_ITEMS`
(`components/dashboard-nav.tsx:37-59`): it is described in `DESCRIPTIONS` but has **no nav
entry**, so it is currently unreachable from the OS chrome.

### D2 — Top status bar
One row above the content, four cells: **Wallet** (`getWallet().balanceCents` +
`spendableCents`, showing the postpaid line when negative), **AI balance + used today**
(`getUsedAiTodayHundredthsCent` + `formatCents`, `lib/wallet.ts:203`), **Devices** (count +
online), **Agent** (last action / pending approvals). All server-read, no polling spike.
Cells link to `/dashboard/billing`, `/dashboard/devices`, etc.
**Blocked on W2** (`GET /api/wallet`), which does not exist yet.

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

### D4 — Owner-initiated message to any user (the one part that is NOT just UI)
> "I should be able to send any user a message and it shows there"

Today's model **cannot** express this. `SupportMessage` **belongs to a ticket**
(`SupportMessage.ticketId` FK, `onDelete: Cascade`, `prisma/schema.prisma:3535-3552`), and
`SupportTicket.userId` is documented **immutable, never reassigned**
(`prisma/schema.prisma:3494-3495`). There is no way to open a thread with a user who has never
filed a ticket.

- **(a)** Admin-composed ticket: let `createSupportTicket` take an admin `actorId` so the admin
  opens a ticket *on behalf of* a chosen user. Smallest change, reuses every read path, one
  thread model. **Recommended.** The actor — never the `userId` — must come from the **admin
  session**, never the body (the exact bug warned about at `prisma/schema.prisma:3492-3494`).
- **(b)** A separate direct-message model. Cleaner conceptually, but a second thread type the
  UI and the admin queue must both special-case forever.

Either way `SupportMessage.authorRole`'s CHECK must still hold (`user` | `admin`) and the
`authorId` nullability must be preserved.

### D5 — Wallpaper preference
Per §1 decision 2. Also honour `prefers-reduced-motion` on the centrepiece, and keep the scene
`aria-hidden` and purely decorative (the existing `DesktopBackground` is correctly `aria-hidden`).

### D6 — 3D centrepiece
Per §1 decision 1. Replaces/augments `components/desktop-background.tsx` behind `<SpaceScene />`.
Must degrade to the existing static background when WebGL is unavailable.

---

## 3. Hard rules for whoever builds this

1. **Nav data stays the single source of truth.** Never hardcode an app list in the overview;
   that is the defect that hid Mailboxes.
2. **`getWallet()`/`listLedger()` are server-only.** No wallet arithmetic in a client
   component. Integer cents end to end; `formatCents` for display.
3. **No Cloudflare token ever reaches a ticket** — `PLAN_TASK_159` + `lib/support/redact.ts`.
4. **Build-target narrowing must not regress.** If D1 adds tiles, the Extractor EXE must still
   not render Hosting/Cyber Lab tiles.
5. **Every phase ends with the full suite green**: `npx tsc --noEmit`, `npm run test:hosting`
   (334), `npm run test:support` (30), `npm run test:wallet` (29), touched-file ESLint,
   `CI=true npm run build`. **No CI runs these** — trap 2 in §5 of the handoff.
6. **Commit, push, deploy are three separate steps.** Pushing to main does not deploy.

## 4. Blocked on
- **W2** (`GET /api/wallet`) for D2's wallet cell.
- **D4** needs an owner decision between (a) and (b).
- **D5/D6** need the two decisions in §1.

## 5. Not in scope here
Store multi-select pricing (→ `PLAN_TASK_162_STORE_MULTISELECT.md`) and self-host per-module
builds (→ `PLAN_TASK_163_SELFHOST_DEVICES_FIRST.md`). Both were requested in the same breath
and are scoped separately because each needs its own migration or build matrix.
