# Batch 3 of 3 — SpaceWorker admin visibility + export domain filter

**Give this file's path to Cline as its own, self-contained instruction.** This is the last of 3 batches (Batch 1 was SpaceWorker security hardening, Batch 2 was Vantra security hardening — both handled separately). Nothing left after this batch until the owner queues up new work.

## Before you start

Read `HOW_WE_MOVE_FAST.md` in this repo root — the deploy/migration/live-verification playbook. Everything below assumes you're following it.

## Why this batch, in this order, and why it's last

Both items here are bigger in scope than Batch 1's mechanical security fixes, and one of them (Task 54) is a genuinely new feature with an unresolved product decision baked into it — that's why this batch comes last, after the pure security fixes are done and verified.

1. **`TASK_50_ADMIN_VISIBILITY_MAILBOXES_CAMPAIGNS_AUTOMATIONS.md`** — do this first. It's admin-visibility work, same category as security (a real abuse blind spot: outbound email is the highest real-world-abuse-potential feature in the product and the admin currently can't see any of it happening).
2. **`TASK_54_EXPORT_DOMAIN_FILTER.md`** — do this second. It's a product feature, not a security fix, and it has an open decision flagged in its own file (see the guardrail below — read it before writing any code for this one).

## Task 50 — copy an existing pattern, don't invent a new one

This exact shape (a read-only admin listing over a table nothing in `/admin` previously surfaced) was already built this session for a different feature — the "Active trials" section. Use it as your template instead of designing from scratch:

- **The route pattern**: `app/api/admin/exe-trials/route.ts` — a `GET` handler, `requireAdminSession()`-gated, that queries a table, cross-references it against related data, and returns a shaped JSON array. Task 50 needs three of these (mailboxes, campaigns, automations) — same shape, different Prisma models.
- **The UI pattern**: `app/admin/(protected)/admin-panel.tsx`'s `ActiveTrialsSection` function (search for it) — a self-contained component with its own `useState`/`useEffect`/fetch-on-mount, a "Refresh" button, a loading/empty/table state, rendered as its own bordered card. Task 50 needs three of these (or one component parameterized by table, your call), added inside the existing `ExeLicensesTab`-style tab structure — check `admin-panel.tsx`'s `Tab` type and the existing tab nav (`TABS`, `tab` state) for where new top-level tabs get registered, since Task 50's three areas (Mailboxes/Campaigns/Automations) each probably deserve their own tab rather than being squeezed into an existing one — use your judgment on tab-vs-section once you see how crowded the existing nav already is.
- **The `notifyAdmin()` pattern**: `lib/exe-license-bind.ts`'s `transferExeLicenseToMachine` (and `lib/find-or-create-user.ts`, `app/api/auth/signup/route.ts`) show the exact `void notifyAdmin(...)` fire-and-forget call shape to copy for the "campaign entering `paused_deliverability`" alert Task 50 asks for.

## Task 54 — the open decision (read this before writing any code)

The task file itself flags that the owner described two different, mutually-exclusive outcomes for the same filter action ("replaces the leads" vs. "create a new run session") and didn't pick one. **Do not guess between them.**

Build the **safe default only**: an export-time-only domain filter (a `?domains=a.com,b.com` param on `GET /api/jobs/[id]/export.csv` that filters which rows go into the CSV — no database mutation at all, the underlying `SearchJob`/`Lead` rows are never touched). This is explicitly called out in the task file as "may be all the owner actually needs" and sidesteps the unresolved decision entirely. Ship the UI control (domain multi-select + verify-count step, per the task file's suggested shape) wired to that export-only parameter.

**Do not build either the "replace in place" (destructive) or "new run session" (forking) variant.** If you think one of them is clearly needed after building the export-only version, say so in your final report and let the owner decide — don't build it preemptively.

## How to work through this batch

For **each** task, in order:

1. Read the task file fully (and, for Task 54, this batch doc's guardrail above).
2. Implement.
3. `npx tsc --noEmit -p .` — must be clean.
4. Live-verify per the task's "Verification expected" section, using the E2E-script pattern from `HOW_WE_MOVE_FAST.md` §4 where it applies (Task 50's admin tabs are easiest to verify by creating a real test mailbox/campaign/automation as a disposable test user and confirming it shows up — Task 54's export filter is easiest to verify with a direct `curl` against the export route with and without the `domains` param, diffing row counts).
5. Deploy per the playbook, confirm the service is `active` and returns 200.
6. Commit with a message stating what changed and how it was verified.
7. Push.
8. Update the task file's `**Status: ...**` line.
9. Move to the next task.

## Guardrails

- Task 50 is read-only visibility — don't add any admin action (pause/delete/edit) on a customer's mailbox/campaign/automation from these new tabs; that's a different, bigger task than "make it visible."
- Task 54: see the open-decision guardrail above — this is the one to get wrong if you rush it.
- Both EXE-side surfaces this session touched (`local-extract.tsx`'s leads table, `LicenseGate`/`license-activation-form.tsx`) are out of scope here unless Task 54 genuinely needs the EXE's export UI updated too (it does — the task file calls this out explicitly for `local-extract.tsx`). If you touch the EXE UI, that means a fresh `gh workflow run "Build EXE"` + reinstall cycle is needed before it's actually testable end-to-end — budget the ~10 minutes for that, per `HOW_WE_MOVE_FAST.md` §5, or use its "faster alternative" (`SPACEWORKER_LOCAL_EXE=true npm run dev`) to verify the backend route logic without the full cycle, and note in your final report that the full Windows install/GUI check still needs a human.

## When the batch is done

Once both tasks are implemented, verified, committed, and pushed: **stop.** Report back, per task: what changed, how it was verified, and — for Task 54 specifically — a clear one-line note confirming you built ONLY the export-only variant and left the replace/new-session decision for the owner. This is the last queued batch; nothing to start after this without new instructions.
