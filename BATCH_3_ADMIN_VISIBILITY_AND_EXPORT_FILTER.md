# Batch 3 of 3 — SpaceWorker admin visibility, premium grants, export domain filter, maintenance mode

**Give this file's path to Cline as its own, self-contained instruction.** This is the last of 3 batches (Batch 1 was SpaceWorker security hardening, Batch 2 was Vantra security hardening — both handled separately, possibly still in progress). After this batch, the owner runs a separate full end-to-end acceptance pass before handing the product to its first customer — don't start that yourself, it's a distinct handoff.

**Added 2026-09-21**: if you've already started this batch, don't reorder or redo what's done — `TASK_56_MAINTENANCE_MODE_AND_DEPLOY_GRACE_PAGE.md` is appended as a 4th item, added after this batch was first handed over. Slot it in wherever you are (do it last if the other three are in progress or done; do it in order if you haven't started yet).

## Before you start

Read `HOW_WE_MOVE_FAST.md` in this repo root — the deploy/migration/live-verification playbook. Everything below assumes you're following it.

## Why this batch, in this order

Four items, ordered by how directly they block getting the product ready for a real paying customer:

1. **`TASK_50_ADMIN_VISIBILITY_MAILBOXES_CAMPAIGNS_AUTOMATIONS.md`** — do this first. Admin-visibility work, same category as security (a real abuse blind spot: outbound email is the highest real-world-abuse-potential feature in the product and the admin currently can't see any of it happening).
2. **`TASK_55_ADMIN_PREMIUM_GRANT_AND_EXTEND.md`** — do this second. The owner needs to be able to comp/extend premium access before the first customer arrives (this may literally be how the first customer gets onboarded). Ports an already-proven design from the sibling Vantra repo — read the task file's porting notes carefully, there's a genuinely important null-semantics difference from Vantra's version that's easy to get backwards.
3. **`TASK_54_EXPORT_DOMAIN_FILTER.md`** — do this third. It's a product feature, not something blocking launch, and it has an open decision flagged in its own file (see the guardrail below — read it before writing any code for this one).
4. **`TASK_56_MAINTENANCE_MODE_AND_DEPLOY_GRACE_PAGE.md`** — do this last. An admin-toggleable "we're updating" page for both web and the EXE, replacing raw 502s during deploys — read the task file closely, it has two genuinely separate mechanisms (an nginx-level fallback for the exact moment the app process is restarting, and a DB-backed admin toggle for planned maintenance windows) that both need building, not just one.

## Task 50 — copy an existing pattern, don't invent a new one

This exact shape (a read-only admin listing over a table nothing in `/admin` previously surfaced) was already built this session for a different feature — the "Active trials" section. Use it as your template instead of designing from scratch:

- **The route pattern**: `app/api/admin/exe-trials/route.ts` — a `GET` handler, `requireAdminSession()`-gated, that queries a table, cross-references it against related data, and returns a shaped JSON array. Task 50 needs three of these (mailboxes, campaigns, automations) — same shape, different Prisma models.
- **The UI pattern**: `app/admin/(protected)/admin-panel.tsx`'s `ActiveTrialsSection` function (search for it) — a self-contained component with its own `useState`/`useEffect`/fetch-on-mount, a "Refresh" button, a loading/empty/table state, rendered as its own bordered card. Task 50 needs three of these (or one component parameterized by table, your call), added inside the existing `ExeLicensesTab`-style tab structure — check `admin-panel.tsx`'s `Tab` type and the existing tab nav (`TABS`, `tab` state) for where new top-level tabs get registered, since Task 50's three areas (Mailboxes/Campaigns/Automations) each probably deserve their own tab rather than being squeezed into an existing one — use your judgment on tab-vs-section once you see how crowded the existing nav already is.
- **The `notifyAdmin()` pattern**: `lib/exe-license-bind.ts`'s `transferExeLicenseToMachine` (and `lib/find-or-create-user.ts`, `app/api/auth/signup/route.ts`) show the exact `void notifyAdmin(...)` fire-and-forget call shape to copy for the "campaign entering `paused_deliverability`" alert Task 50 asks for.

## Task 55 — port Vantra's proven design, don't invent a new one either

Same discipline as Task 50: Vantra (`/Users/mikeolab/vantra`) already has this exact feature working — `lib/premium.ts`'s `extendPremium()` + `app/api/admin/organizations/[orgId]/grant-premium/route.ts` + the check-on-read expiry-reversion in `lib/session-user.ts:108-116`. The task file has the full porting plan; the one thing to get right is the null-semantics difference it calls out explicitly (an existing pre-feature `tier: 5` user's `premiumExpiresAt: null` means "grandfathered, permanent" in SpaceWorker — the OPPOSITE of what null means in Vantra's model, where it means "not premium"). Read the task file's point 1 twice before touching the schema.

## Task 54 — the open decision (read this before writing any code)

The task file itself flags that the owner described two different, mutually-exclusive outcomes for the same filter action ("replaces the leads" vs. "create a new run session") and didn't pick one. **Do not guess between them.**

Build the **safe default only**: an export-time-only domain filter (a `?domains=a.com,b.com` param on `GET /api/jobs/[id]/export.csv` that filters which rows go into the CSV — no database mutation at all, the underlying `SearchJob`/`Lead` rows are never touched). This is explicitly called out in the task file as "may be all the owner actually needs" and sidesteps the unresolved decision entirely. Ship the UI control (domain multi-select + verify-count step, per the task file's suggested shape) wired to that export-only parameter.

**Do not build either the "replace in place" (destructive) or "new run session" (forking) variant.** If you think one of them is clearly needed after building the export-only version, say so in your final report and let the owner decide — don't build it preemptively.

## Task 56 — build both mechanisms, not just one

The task file spells this out, but it's easy to build only the admin-toggle part and call it done: a DB flag check inside the Next.js app CANNOT respond during the exact seconds `systemctl restart` has the process down (the process doesn't exist yet to check anything) — that specific window needs the nginx-level `error_page` fallback, which is a completely separate mechanism. Both need to actually exist and be tested; don't skip the nginx piece because the admin-toggle piece is more interesting to build.

## How to work through this batch

For **each** task, in order:

1. Read the task file fully (and, for Task 54, this batch doc's guardrail above; for Task 55, also skim Vantra's `lib/premium.ts` and `lib/session-user.ts` directly rather than working from description alone).
2. Implement.
3. `npx tsc --noEmit -p .` — must be clean.
4. Live-verify per the task's "Verification expected" section, using the E2E-script pattern from `HOW_WE_MOVE_FAST.md` §4 where it applies (Task 50's admin tabs are easiest to verify by creating a real test mailbox/campaign/automation as a disposable test user and confirming it shows up; Task 55 needs a disposable test user taken through grant → stack-on-re-grant → backdated-expiry-reverts; Task 54's export filter is easiest to verify with a direct `curl` against the export route with and without the `domains` param, diffing row counts; Task 56 needs BOTH a live toggle test AND a real `systemctl restart` timed to hit the nginx fallback — don't consider it verified from the toggle alone).
5. Deploy per the playbook, confirm the service is `active` and returns 200.
6. Commit with a message stating what changed and how it was verified.
7. Push.
8. Update the task file's `**Status: ...**` line.
9. Move to the next task.

## Guardrails

- Task 50 is read-only visibility — don't add any admin action (pause/delete/edit) on a customer's mailbox/campaign/automation from these new tabs; that's a different, bigger task than "make it visible."
- Task 55: don't backfill `premiumExpiresAt` onto any existing `tier: 5` user — leave existing rows untouched (see the task file). If `bumpWebTier` gets wired to `extendPremium` too (the task file's point 3), say so clearly in your final report — that's a real behavior change for future paying customers the owner should know landed, even though it's the recommended default.
- Task 54: see the open-decision guardrail above — this is the one to get wrong if you rush it.
- Both EXE-side surfaces this session touched (`local-extract.tsx`'s leads table, `LicenseGate`/`license-activation-form.tsx`) are out of scope here unless Task 54 genuinely needs the EXE's export UI updated too (it does — the task file calls this out explicitly for `local-extract.tsx`). If you touch the EXE UI, that means a fresh `gh workflow run "Build EXE"` + reinstall cycle is needed before it's actually testable end-to-end — budget the ~10 minutes for that, per `HOW_WE_MOVE_FAST.md` §5, or use its "faster alternative" (`SPACEWORKER_LOCAL_EXE=true npm run dev`) to verify the backend route logic without the full cycle, and note in your final report that the full Windows install/GUI check still needs a human. Task 56's EXE-side client handling (Mechanism 3) also touches `LicenseGate`, so the same EXE-build note applies there too — don't do two separate EXE rebuild cycles if Task 54 and Task 56 both need one, batch them into one build+reinstall pass.
- Task 56: never let the maintenance toggle lock out `/admin/**` itself — that's the one path that must always stay reachable so the toggle can be flipped back off. Test this specifically, not just assumed.

## When the batch is done

Once all four tasks are implemented, verified, committed, and pushed: **stop.** Report back, per task: what changed, how it was verified, and — for Task 54 specifically — a clear one-line note confirming you built ONLY the export-only variant and left the replace/new-session decision for the owner; for Task 55, a clear note on whether `bumpWebTier` was wired to expire real purchases too; for Task 56, confirmation that BOTH the nginx fallback and the admin-toggle were tested, not just one. This is the last queued batch — the owner runs a separate full end-to-end acceptance pass after this, not something to start yourself.
