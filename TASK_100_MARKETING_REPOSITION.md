# Task 100 — Marketing reposition + store-as-route (MK1–MK4)

**Status: ready. GATED: build only after Tasks 93/96/97 flagship is real (owner sequencing — the site must not claim a story the product can't deliver).**
**Plan: `PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md` §MARKETING TRACK (MK1–MK4), §FINALIZED DECISIONS M9.**

## Read first (mandatory)
- **`HOW_WE_MOVE_FAST.md`** §0–§2 (as TASK_92).
- **`PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md`** §MARKETING TRACK (full research anchor + copy direction), M9.
- **`app/page.tsx`** (hero + inline store + NAV), **`components/menu-bar.tsx`**, **`components/store.tsx`**, **`app/pricing/page.tsx`**, design tokens `app/globals.css` / `components/ui.tsx`.

## Goal
The page sells the platform ("Your Cloud Cyber Partner"), not just leads — and the store becomes its own click-through destination.

## Deliverables
1. **MK1 Hero reposition**: badge pill broadened (currently "Lead extraction + AI-assisted outreach"); H1 = "SpaceWorker OS — Your Cloud Cyber Partner" (final per M9); subtitle states the platform: "an AI assistant that runs your devices, finds and reaches your customers, and defends your PCs — with you approving every action."
2. **MK2 Capability pillars**: replace the 6-card grid with four outcome groups — Find & Reach / Assistant & Devices / Cyber Lab / Automate — copy outcome-first; unreleased modules as "coming soon" cards only once they exist (dark-launch friendly).
3. **MK3 Store route**: move the store off the marketing scroll to a dedicated `/store` route (`app/store/page.tsx` reusing `components/store.tsx` as-is); NAV becomes Features / Store / Pricing; landing keeps only a "Browse the store" button linking there.
4. **MK4 Copy + SEO sweep**: page title/metadata, footer, pricing-page intro rephrased to platform level; keep the cold-outreach responsibility disclaimer (legal).

## Non-goals
Module cards/pricing wiring (Task 99 renders through the same store component); any product behavior change.

## Acceptance
- Landing page: no store section inline; `/store` serves the full store (200, prices render); hero copy matches M9 exactly; pillars render; `tsc --noEmit` clean; §2 deploy; screenshot check on mobile + desktop.
