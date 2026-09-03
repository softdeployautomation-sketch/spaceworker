# Cline Task 9 — Verify Mailbox + Campaign Flows End-to-End (not blocked on Michael)

**Repo**: `/Users/mikeolab/spaceworker`. **Scope**: verification first, fixes only if something's actually broken — this is not a rewrite task.

## Why this exists

Task 4 (Mailboxes + Email Campaigns) is merged and deployed, but per the README's own outstanding-verification list, the actual send/drain flow has only been smoke-tested at the HTTP-status level, never exercised end-to-end against real data. Addendum 4's campaign-automation work (template-based mass-send flows, sender rotation, subject rotation) is explicitly **gated on this being solid first** — the user's own words: "lead extractor needs to work perfectly and senders need to work out perfectly for the campaign template automation to work." This task is the "senders work out perfectly" half — do it before anyone starts building rotation/template logic on top of a single-sender path that might have latent bugs.

This is genuinely unblocked — it doesn't touch Task 2/3 (Michael's in-review PRs) at all, and doesn't require waiting for anything.

## What to actually verify (the current, real shape — read `prisma/schema.prisma`'s `Mailbox`/`EmailCampaign`/`EmailQueueItem` models before starting, don't assume field names)

1. **Add a real mailbox** (`POST /api/mailboxes`) using a real SMTP account you control (a throwaway Gmail app-password account or similar — don't use a customer's real account for this). Confirm:
   - The password is actually encrypted at rest — read the raw DB row (`encryptedPassword`/`passwordIv`/`passwordTag`) and confirm it's not plaintext, confirm no API response (`GET /api/mailboxes`, the mailbox list UI) ever echoes back the raw or encrypted password.
   - `POST /api/mailboxes/[id]/test` actually attempts a real SMTP connection and returns a genuinely different result for a correct vs. deliberately-wrong password/host — don't just confirm it returns 200, confirm the `lastTestOk`/`lastTestedAt` fields update correctly in the DB and that a failing test is reported as failing, not silently swallowed.

2. **Create a real campaign** (`POST /api/campaigns`) targeting a small list of real, throwaway addresses you control (2-3 inboxes across different providers is enough — don't spam real third parties for this test). Confirm:
   - `EmailQueueItem` rows are created correctly, one per recipient, correctly linked to both the campaign and the chosen mailbox.
   - `POST /api/campaigns/[id]/send` (or however sending is actually triggered — check the route, this may be the same as queuing vs. a separate trigger) correctly transitions the campaign/queue items into a sending state.

3. **Manually trigger the drain** (`POST /api/internal/mail-queue-drain` — this is meant to run on a systemd timer per the original Task 4 design; trigger it directly for this test rather than waiting for the timer). Confirm, against the real mailboxes you actually receive:
   - The emails actually arrive (check the real inboxes, not just "the API returned success" — a message can report sent without ever delivering, this exact caveat is already noted in Task 4's own scope).
   - **Daily caps are enforced**: set a mailbox's `dailyLimit` low (e.g. 2) via a test campaign with more recipients than that, confirm sending actually stops at the cap for that mailbox and doesn't silently exceed it — check `sentToday`/`sentTodayDate` update correctly, and specifically check what happens at the day-rollover boundary (does `sentTodayDate` correctly reset `sentToday` on a new day, or is there an off-by-one/timezone bug there worth catching now).
   - **Inter-send jitter is actually happening**, not just configured — look at the actual timestamps of consecutive sends from the same mailbox in the drain's logs/DB timestamps, confirm there's real spacing, not a tight loop.
   - **Bounce/error handling**: send to at least one deliberately-invalid address (e.g. `nonexistent-address-xyz123@gmail.com`) and confirm the `EmailQueueItem.status`/`error` fields correctly reflect the failure rather than silently marking it "sent."

4. **Tenant isolation** (this project's own standing #1 regression risk per the original Phase 1 plan): create a second test account, confirm it cannot see or send from the first account's mailboxes, and cannot see the first account's campaigns/queue items under any circumstance — check this at the API level (call the routes directly with the second account's session, not just via the UI) since a UI-level check alone wouldn't catch an API route missing its own ownership filter.

## What NOT to do in this task

- Don't build sender rotation, subject rotation, CSV recipient import, or any of Addendum 2/4's mailer-research features — that's explicitly later work (`TASK_09_CAMPAIGN_AUTOMATION.md` will be a separate, later task once this verification is done and clean).
- Don't touch Task 2/3 — unrelated, and those are mid-review on Michael's branches.
- If you find a real bug, fix it — this isn't "verification only, never fix anything" — but keep fixes scoped to what's actually broken, don't refactor working code you encounter along the way just because you're in the area.

## Report back

For each of the 4 verification areas above: what you tested, what you found (working as expected / found and fixed a real bug / found something questionable but didn't touch it — explain why), and whether this whole thing is now solid enough for the campaign-automation work to build on top of. If anything is genuinely broken and non-trivial to fix, say so explicitly rather than quietly patching around it — this verification's whole purpose is to surface the truth about this flow's state before more is built on it.
