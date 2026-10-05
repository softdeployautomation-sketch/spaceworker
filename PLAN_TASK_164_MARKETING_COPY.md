# PLAN — Task 164: Marketing copy that matches what actually ships

**Status: SCOPED, not started.** 2026-10-05. Owner-locked direction; see §1.
Single file: **`app/page.tsx`** (166 lines today). Nothing else needs to change for the copy.

## 0. Owner ruling (locked — do not relitigate)
> *"we advertise it now, because we are completing it this week. we advertise both hosting and
> cyber labs. that's the complete package, and domains sales coming soon."*

So: **Hosting AND Cyber Lab are both advertised NOW**, even though Cyber Lab finishes this week.
Platform **domains** are **"coming soon"** and must be worded as forthcoming, never as shipped.

## 1. ⚠ Verified finding that changes the premise: the Hero is ALREADY correct

The brief proposed this hero:
> "An AI assistant that runs your devices, finds and reaches your customers, and defends your
> PCs — with you approving every action."

**That exact sentence already ships**, at `app/page.tsx:74-77`, word for word. The eyebrow pill
above it already reads **"AI Assistant · Device Control · Cybersecurity"** (`:68-70`).

**Do not rewrite the hero.** Rewriting shipped, correct copy is churn and a regression risk for
zero gain. The real gap is **pillars only**.

The **only** remaining hero question is the `<h1>`: `"SpaceWorker OS — Your Cloud Cyber Partner"`
(`:72`). "Cyber Partner" under-sells Hosting + domains. Suggested: **"SpaceWorker OS — Your
Business, Running Itself"** or **"One Platform. Devices, Customers and Defense."**
*(Owner's call; the subhead beneath it is already right.)*

## 2. Current state vs. target (verified 2026-10-05)

| Surface | Today | Target |
|---|---|---|
| Eyebrow pill | `AI Assistant · Device Control · Cybersecurity` (`:69`) | **keep as-is** |
| `<h1>` | `SpaceWorker OS — Your Cloud Cyber Partner` (`:72`) | reword to cover the full package |
| Hero subhead | already the target sentence (`:74-77`) | **keep as-is** |
| Pillars | **3**: Find & Reach / Assistant & Devices / Automate (`:99-113`) | **5**: + **Hosting** + **Cyber Lab** |
| Grid | `md:grid-cols-3` (`:98`) | `md:grid-cols-2 lg:grid-cols-3` so 5 tiles lay out cleanly |
| Page metadata | `title: "SpaceWorker OS — Your Cloud Cyber Partner"` (`:24`) | update to match the new `<h1>` |

**Why Hosting and Cyber Lab are safe to claim — both are real, not vapourware:**
- Hosting: `app/dashboard/hosting/page.tsx` exists; in `NAV_ITEMS`
  (`components/dashboard-nav.tsx:51`); sellable as `HOSTING_MODULE` with `entitlementKeys:
  ["hosting"]` (`lib/products.ts:118-126`). **Live in production**: `hostingEnabled = true`,
  `hostingPlatformCfEnabled = true` (read from `AdminSetting` on the VPS 2026-10-05).
- Cyber Lab: `app/dashboard/cyberlab/page.tsx` exists; in `NAV_ITEMS` (`:55`); sellable as
  `CYBERLAB_MODULE` (`cyberlabModulePriceUsd`). Premium-gated on the `cyberlab` entitlement.

## 3. ⚠ The one real risk in advertising Cyber Lab before it finishes

`lib/lab/gate.ts:14-19` — the lab is gated by **two** things: the `cyberlab` entitlement **and**
`AdminSetting.cyberlabEnabled`, which is **"OFF by default; the lab is dark until C2 ships."**

I read production directly: **`cyberlabEnabled = f` (false)**, `hostingEnabled = true`.

So a paying customer who buys Cyber Lab **today** clicks through and sees *"not switched on
yet"*. That is a **support ticket and a refund risk**, and it is the one thing that could make
this copy change a net negative. It does **not** change the owner's decision — the lab completes
this week — but the acceptance bar below makes the flip part of the change, not a follow-up.

**Rule: the copy ships with the lab, or the switch flips in the same week.** Do not leave the
marketing live and the switch off for longer than the lab takes to finish.

## 4. Model drafts (refine as the owner sees fit)

**Pillar 4 — Hosting** (title: `Hosting`)
> Publish files, pages and links and get a real URL back. Upload once, then share a short link,
> rename the download, or publish a zip as a page — with per-plan storage, bandwidth and link
> caps you can see before you hit them.
> `["File & page hosting", "Short links", "zip → preview → publish"]`

**Pillar 5 — Cyber Lab** (title: `Cyber Lab`)
> Run authorised security research against your own systems — reconnaissance, exposure checks
> and vulnerability scans — from a research-only catalog. Every run needs your recorded consent
> to the current terms, and the catalog can only ever point at targets you are allowed to test.
> `["Authorised recon", "Exposure + vulnerability scans", "Consent recorded per run"]`

⚠ **Cyber Lab wording is deliberately conservative.** It says *research against your own
systems*, and points at the consent gate — it does **not** say "hack anything", "attack anyone",
or "red team anyone". This is not marketing timidity: `lib/lab/gate.ts:26-29` explicitly calls the
gate *"authorization hygiene, not a legal fence"*, and C5/C6 abuse-sentinel work is still open.
Claiming more than the gate enforces is the kind of promise this repo's docs keep warning about.

**Domains — "coming soon", one line under the pillars, not a pillar of its own.** Something like:
> Platform domains are coming soon — register, point and manage domains on the same account as
> everything else.
> Must be visibly **forthcoming**, not a buy button.

## 5. Acceptance bars (all must be true before calling it done)
1. Five pillars render; **no** hardcoded capability that isn't shipped — check each claim against
   the actual page it describes.
2. Layout holds at 375px, 768px and 1280px (5 tiles must not orphan the last one).
3. `<h1>` and `metadata.title` agree.
4. The Cyber Lab claim matches what the gate actually enforces when `cyberlabEnabled` is true.
5. Full suite green: `npx tsc --noEmit`, `npm run test:hosting` (334), `npm run test:support`
   (30), `npm run test:wallet` (29), ESLint on the touched file, `CI=true npm run build`.
   **No CI runs these.**
6. Deployed and live-verified by curl — a copy change is only shipped when the live HTML shows it.

## 6. Open questions I deliberately did NOT guess
1. **Does the `<h1>` change?** The current one is defensible; I flagged it, I did not rewrite it.
2. **Is "Domains" a pillar or a coming-soon line?** I assumed a line, since it sells nothing yet.
3. **Do the 5 pillars stay 5, or do "Automate" and "Find & Reach" merge** to make room? 5 is
   asymmetric in a 3-wide grid; merging is a product decision.
4. **Should the marketing page get `<SpaceScene />`** (the 3D video centrepiece)? It is required on
   the dashboard; on marketing it is a separate judgement call about page weight and LCP.
5. **Does advertising Cyber Lab before the switch flips need a visible "beta" label?** I did not
   invent one.

## 7. Not in scope
The 3D centrepiece asset itself (→ `TASK_161_DASHBOARD_OS.md` §2 D6, blocked on licence
verification). Store multi-select (→ `PLAN_TASK_162`). Self-host per-module (→ `PLAN_TASK_163`).
