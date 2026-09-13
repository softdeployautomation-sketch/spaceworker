# Task 34 — Revert to automated testing, and stop full-page refetches on every test action

**Status: ready for Cline, after Task 33 lands.** Same file Task 33 is working in (`app/dashboard/campaigns/[id]/page.tsx`) — do not start until that's committed. Two small, independent UX fixes from live-testing feedback (2026-09-13).

## 1. No way to switch back from a personal test recipient to the automated seed mailbox

**The backend already fully supports this — it's a pure frontend gap.** `POST /api/campaigns/[id]/test-recipient` (`app/api/campaigns/[id]/test-recipient/route.ts`) already accepts `{ email: null }` and correctly clears `testRecipientOverride` back to `null`, which makes `resolveSeedMailbox()` fall back to the platform default automatically — no backend change needed at all.

Add a small "Switch back to automated testing" link/button, shown only when `campaign.testRecipientOverride` is set (next to wherever the override address is currently displayed in the test-send box), that calls this same route with `{ email: null }` and refreshes. This undoes exactly what the "use this as my test recipient" flow (Task 29's human-assisted fallback, Task 32's edit-and-promote) did — a user who switched to their own Gmail while diagnosing a spam issue should be able to go back to the default automated IMAP-verified path once they're done, without having to know to type an empty string somewhere.

## 2. Stop re-fetching the whole campaign (including every queue item) after every test action

**Confirmed live**: every test-related action on this page — `sendTest`, `confirm`, `applyTestRecipient`, `deliverabilityDecision`, `sendDraftTest`, `promoteEdit` (8 call sites of `void load()` total) — currently calls the SAME full `load()` that re-fetches `/api/campaigns/[id]`, which includes the ENTIRE `items` array (every queued recipient, unpaginated in the payload — could be thousands of rows for a real campaign) just to refresh the small "Test-send before the real send" box's status line. The owner's own words: "the run is not yet even started" — there's no reason a test-send click before any real sending has begun should re-fetch or re-render the whole page.

**Fix**: have each of these actions merge a SMALL, targeted state update into the existing `campaign` state instead of calling `load()`:
- Extend each relevant route's response to include whatever the top box actually needs to redraw itself: `test-send` → the created `DeliverabilityCheck`'s full shape (`status`, `landedIn`, `error`, `checkedAt`), not just `{outcome, checkId, error}`; `confirm-test`/`deliverability-decision`/`test-recipient` already return the updated campaign fields relevant to each (status, subjects/bodies, testRecipientOverride) — return whatever's still missing for the frontend to avoid a re-fetch.
- On the frontend, replace `void load()` in these 6 handlers with a small `setCampaign(prev => prev ? { ...prev, ...partialUpdate } : prev)` that only touches the fields that actually changed (status, checks array with the new check prepended, testRecipientOverride, subjects/bodies, pinnedOverride) — leave `items`/pagination untouched entirely.
- Keep the real, full `load()` for: the initial page-mount fetch, and any action that actually changes `items` in a way the page needs to reflect (there may not be any among the test-time actions — a real send hasn't started yet for any of them, so `items` genuinely never changes during this phase; confirm this assumption while implementing rather than assuming it blindly).

**Explicitly not required**: paginating or virtualizing the queue table itself — that's a separate concern from "why does clicking Send test message re-fetch it." This task only stops the UNNECESSARY re-fetch of already-loaded data; if the queue table itself becomes a real problem to load at all for very large campaigns, that's a different, later task.

## Verification expected

- `npx tsc --noEmit` / `npm run build` clean.
- Set a personal test recipient, confirm the "Switch back to automated testing" option appears, click it, confirm a subsequent test-send goes back to the platform seed mailbox (check `DeliverabilityCheck.seedMailboxId` is set again, not null).
- With browser devtools open, click "Send test message" on a campaign with a large `items` list and confirm the network tab shows a small targeted response, not a full `/api/campaigns/[id]` re-fetch — and confirm the queue table below doesn't visibly re-render/flash.
