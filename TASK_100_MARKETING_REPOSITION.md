# Task 100 — Marketing reposition + store-as-route (MK1–MK4)

**Status: ✅ MK1–MK4 DONE + DEPLOYED 2026-09-26.** Gate cleared — TASK_93 (Vantra
plugin/device control), TASK_96/TASK_123 (Wake-on-LAN + keep-awake), and TASK_97
(Browser Clone) are all live in production, confirmed this session. MK5 was already
done (§5 below).
**Plan: `PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md` §MARKETING TRACK (MK1–MK4), §FINALIZED DECISIONS M9.**

## Read first (mandatory)
- **`HOW_WE_MOVE_FAST.md`** §0–§2 (as TASK_92).
- **`PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md`** §MARKETING TRACK (full research anchor + copy direction), M9.
- **`app/page.tsx`** (hero + inline store + NAV), **`components/menu-bar.tsx`**, **`components/store.tsx`**, **`app/pricing/page.tsx`**, design tokens `app/globals.css` / `components/ui.tsx`.

## Goal
The page sells the platform ("Your Cloud Cyber Partner"), not just leads — and the store becomes its own click-through destination.

## Deliverables
1. **MK1 Hero reposition — ✅ DONE.** Badge broadened to "AI Assistant · Device Control · Cybersecurity"; H1 = "SpaceWorker OS — Your Cloud Cyber Partner" (verbatim M9); subtitle is the exact platform line: "an AI assistant that runs your devices, finds and reaches your customers, and defends your PCs — with you approving every action."
2. **MK2 Capability pillars — ✅ DONE, with a scope note.** Replaced the 6-card grid with **three** outcome groups — Find & Reach / Assistant & Devices / Automate — not four. **Cyber Lab was deliberately left out entirely**, not even as "coming soon": TASK_98 (Cyber Lab staff track) has no dashboard route anywhere in the codebase yet (confirmed by listing `app/dashboard/*`), and this doc's own dark-launch rule is "coming soon" only once a module **exists** — showing a card for something with zero code would be the exact thing that rule forbids. Add the fourth pillar the day TASK_98 ships a real route.
3. **MK3 Store route — ✅ DONE.** `app/store/page.tsx` (new) reuses `components/store.tsx` as-is, own header/footer/nav (Features / Store / Pricing). Landing page's inline store section removed entirely; its "Browse the store" button now links to `/store`. Every old `/#store` anchor reference across the codebase updated (grepped, none left).
4. **MK4 Copy + SEO sweep — ✅ DONE.** `app/page.tsx` metadata (title + description) rephrased to the platform line; footer nav updated (Store link now points to `/store`, not `/#store`); `/pricing`'s intro rephrased to platform level ("Pay for what you actually use" / "SpaceWorker OS is one cloud cyber partner...") — kept it a **distinct** page from `/store` per this doc's own intent (browse vs. "what does this cost"), not a duplicate. Cold-outreach responsibility disclaimer kept verbatim in the footer.
5. **MK5 Nav cleanup (owner, 2026-09-22) — ✅ DONE 2026-09-26.** Removed **Advanced Search** and **Licenses** from `NAV_ITEMS` in `components/dashboard-nav.tsx`. `app/dashboard/advanced-search/page.tsx` now just `redirect()`s to `/dashboard/extract?template=advanced-search` (the Extract page reads that query param and switches its `template` state — it already had the identical background-job engine as Lead Search since 2026-09-20, so nothing behavioral changed, only the entry point). Licenses: extracted the exact rendering logic from the old `/dashboard/licenses` page into `app/dashboard/settings/licenses-section.tsx` (a shared async server component), rendered inline in `app/dashboard/settings/page.tsx`. **Care taken**: a `license_only` session (Task 45's narrow EXE-buyer scope) is `proxy.ts`-gated to ONLY `/dashboard/licenses` — it can never reach `/dashboard/settings` — so `/dashboard/licenses` still serves the FULL page directly for that scope (and for the local EXE build), and only redirects a normal *full*-scope web session onward to `/dashboard/settings#licenses`. Blindly redirecting unconditionally would have infinite-looped a license_only session between the two pages; `proxy.ts` itself was intentionally left untouched. No dashboard overview tiles or hero-button checks referenced either old route, so nothing else needed updating.

## Non-goals
Module cards/pricing wiring (Task 99 renders through the same store component); any product behavior change.

## Acceptance
- Landing page: no store section inline; `/store` serves the full store (200, prices render); hero copy matches M9 exactly; pillars render; `tsc --noEmit` clean; §2 deploy; screenshot check on mobile + desktop.
