# Batch 1 of 3 — SpaceWorker security hardening

**Give this file's path to Cline as its own, self-contained instruction.** Do not start Batch 2 or Batch 3 — those are separate handoffs the owner gives you later.

## Before you start

Read `HOW_WE_MOVE_FAST.md` in this repo root in full — it has the exact deploy, migration, and live-verification mechanics (rsync pattern, the repo-root vs. `app/` distinction, the E2E test-script pattern against the real deployed routes). Everything below assumes you're following that playbook, not inventing a different process.

## Why this batch, in this order

These three tasks are all real security findings from a 2026-09-20/21 audit, all mechanical fixes that follow patterns already proven working elsewhere in this exact codebase (`lib/rate-limit.ts`'s `RateLimitKind` pattern, and the fail-closed discipline `lib/admin-auth.ts` already demonstrates). Lowest ambiguity of everything queued up — do these first, in this order:

1. **`TASK_51_SMTP_TEST_CONNECTION_SSRF.md`** — highest severity (an authenticated SSRF / internal port-scan oracle, live today). Do this one first.
2. **`TASK_53_INTERNAL_BEARER_TOKEN_FAIL_OPEN.md`** — quick, high-value: a fail-open bug in every `/api/internal/*` route.
3. **`TASK_52_UNAUTH_ENDPOINTS_NO_RATE_LIMIT.md`** — mechanical, same `RateLimitKind` pattern you'll have just touched for Task 53's neighbors; do it last in this batch since it's the most routine.

Full detail, exact file:line references, and the fix + verification steps for each are in their own `TASK_NN_*.md` file — read each one fully before starting it. This batch doc is sequencing + guardrails, not a duplicate of that detail.

## How to work through this batch

For **each** task, in order:

1. Read the task file fully.
2. Implement the fix.
3. `npx tsc --noEmit -p .` — must be clean before moving on.
4. Where the task's own "Verification expected" section calls for a live check (most of them do — an SSRF rejection, a rate-limit 429, a fail-closed rejection with the token unset), write a disposable, self-cleaning E2E script per `HOW_WE_MOVE_FAST.md` §4 and run it against the real deployed server after deploying. Don't skip this step to move faster — a security fix that only passed `tsc` is not verified.
5. Deploy per `HOW_WE_MOVE_FAST.md` §2 (or §3 if the task needs a migration — none of these three do). Confirm the service comes back `active` and a real `curl` returns 200 before considering the task done.
6. Commit the fix with a message that states what the bug was and how you verified the fix (match the style of the existing `TASK_49...` commit in this repo's `git log` — that's the reference for "what a properly-documented fix commit looks like here").
7. Push.
8. Update that task's own `.md` file: change its `**Status: ...**` line to say it's fixed and how it was verified (same pattern as `TASK_49`'s status line after its fix — read it as the example).
9. Move to the next task in this batch.

## Guardrails

- Stay inside these three tasks. If you notice something else that looks broken while you're in a file, don't fix it inline — note it and leave it for the owner to decide whether it's worth a new task file.
- Don't touch anything under `app/dashboard/`, `components/store.tsx`, `components/license-activation-form.tsx`, or anything licensing/payment-related — that's all out of scope for this batch and was already heavily reworked this session.
- If a fix requires a product/security tradeoff decision the task file doesn't already resolve (none of these three should, but if you hit one), stop and ask rather than guessing.

## When the batch is done

Once all three tasks are implemented, verified live, committed, and pushed: **stop.** Report back, per task: what the bug was, exactly what you changed (files), and exactly how you verified it (the E2E script's assertions and their result, or the specific curl/manual check and its output). Don't start Batch 2 or Batch 3 — the owner will hand those over separately once they've reviewed this one.
