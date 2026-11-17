# TASK_226 — Campaign Stall Visibility: BUILD STEPS + EVIDENCE

**Built by:** task agent · **Date:** 2026-10-18 · **Branch:** `agent/task-226-campaign-stall-visibility` (off `origin/main` @ `c9aa516`)
**Scope doc:** `TASK_226_CAMPAIGN_STALL_VISIBILITY.md` · **Status:** ✅ built, gates green, awaiting verification + owner deploy 🚦

## What was built (maps to §3)

1. **Stall banner (status → plain language)** — `lib/campaign-stall.ts` `stallExplanation()` maps every state the drain can park a campaign in, rendered under the status header AND at the top of the "Sending activity" modal (`app/dashboard/campaigns/[id]/page.tsx`, `stallVisibilitySection`):
   - `paused_deliverability` (automated) → "Paused: waiting for your resume. The queue drains every 60s; nothing sends while paused." (danger tone)
   - `paused_deliverability` + `testRecipientOverride` → "Paused at a 50-recipient checkpoint — click resume… (by design while test recipients are active)" (warning tone — TASK_150 T3 framing preserved: owner's turn, never failure copy)
   - `pending_test_confirm` → "Waiting for you to confirm the test email before the full send starts."
   - `sending` + override → "…sends pause at every 50-recipient checkpoint for your confirmation — a pause at a boundary is expected, not a failure."
   - `sending` → drain cadence explained (60s / ≤50 per tick / auto-retry backoff)
   - `paused_manual` → "You paused this campaign…"
   - `done`/`stopped`/`draft`/unknown → no banner (nothing expected to move)
2. **Last drain activity strip** — new lightweight GET **`/api/campaigns/[id]/stall-info`** (session-gated, owner-scoped, no new table): fresh `EmailQueueItem` groupBy counts + retry backlog (`queued` with `nextAttemptAt`, index `[status, nextAttemptAt]`), LIMIT-1 lookups for last `sentAt` and soonest `nextRetryAt`. Rendered as: last sent · N sent · N queued (N awaiting retry) · N failed · next retry time + a "checked every ~60s" reassurance line.
3. **Failure summary card** — grouped error counts ("N × <error> — will retry automatically" / "— will not retry") from a DB-side `groupBy(error, errorCategory, status)` over errored items only; top 5, 160-char truncation. Plus the **sending path** rows: mailbox label + SMTP host + **region** ("direct from server" vs "via US exit node (New York)") — the exact `sendRegion` field behind the 2026-10-18 stall is now visible.
4. **Test-override hint** — standalone hint line in the banner for non-`sending` statuses ("sends pause every 50 recipients for your confirmation"); folded into the `sending` copy itself.

Polling: `stall-info` pulled every **15s** while status ∈ {sending, paused_deliverability, paused_manual, pending_test_confirm} (keeps running through pauses — deliberately unlike the 4s `recent-sends` poll which stops at non-sending). Payload is **render-gated** by status (never cleared from an effect — `react-hooks/set-state-in-effect`).

## Files touched

| File | Change |
|---|---|
| `lib/campaign-stall.ts` | NEW — pure, zero-import: `stallExplanation`, `regionText`, `groupStallFailures`, `buildStallPayload` |
| `app/api/campaigns/[id]/stall-info/route.ts` | NEW — GET, session + ownership gated, read-only, NO `toEmail` selected anywhere |
| `app/dashboard/campaigns/[id]/page.tsx` | `StallInfo` type + `STALL_STATUSES`, 15s poll effect, `stallVisibilitySection` rendered under header + inside activity modal |
| `tests/campaign-stall.test.ts` | NEW — 17 tests (§6 list below) |

## MUST NOT touch (§4) — respected

- Drain route logic/cadence/batch caps/override modes/retry math: **untouched** (`git diff --stat` shows no changes under `app/api/internal/`, `lib/mailer-send.ts`, `lib/deliverability.ts`, `prisma/`).
- No schema change / no migration / no `.env` / no deploy.
- No `toEmail` rendered beyond what the activity modal already shows (payload has none at all).
- Nothing auto-resumes — visibility only.

## Gate evidence (§6)

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 ✅ |
| eslint touched files | 0 new problems; the page keeps exactly its 1 pre-existing baseline error (`react-hooks/set-state-in-effect` at Task 35's poll — verified via `git stash` comparison: baseline 1 error, after 1 error, same one) ✅ |
| `npm test` | **1694 tests / 1693 pass / 0 fail / 1 skip** (floor was 1677/1676/0/1; +17 new, none lost) ✅ |
| `CI=true npm run build` | exit 0; `ƒ /api/campaigns/[id]/stall-info` present in route manifest ✅ |
| New tests (§6 list) | status→message (all 4 + both paused_deliverability variants + null statuses) · region label (direct vs `us`/`ca`/`uk`/unknown) · failure-group (grouping, retryable OR-merge, cap, truncation) · **no-PII pin** (serialized payload has no `toEmail`/recipient field/email-shaped values) · empty-payload serialization ✅ |

## §5 owner decisions (flagged, NOT built)

1. **Exit-node SMTP policy:** should `sendRegion` be forbidden/warned for SMTP send paths? The banner now *shows* the region, but the product rule (warn/block at save time) is untouched.
2. **Auto-continue:** per-boundary manual resume still required; an opt-in "keep sending" toggle is not built.
3. **Sblast1 recovery:** still `paused_deliverability` (its 100 soft failures are retry-eligible now that the route is direct); blast3 still needs its test confirmation — owner actions, not code.

## HANDOFF → VERIFICATION AGENT

Verify, in order:
1. `git diff origin/main --stat` — only the 4 files above (+ these docs).
2. `npx tsc --noEmit`; `npx eslint lib/campaign-stall.ts 'app/api/campaigns/[id]/stall-info/route.ts' 'app/dashboard/campaigns/[id]/page.tsx' tests/campaign-stall.test.ts` (expect the 1 pre-existing page error only — present on `origin/main` too).
3. `npm test` (expect ≥1694/1693/0/1) and `CI=true npm run build`.
4. `npx tsx --test tests/campaign-stall.test.ts` — 17/17.
5. Functional (staging or owner box): open Sblast1 (`cmvdo5ujp0f0tkpl4i5cqnx3i`, `paused_deliverability`, region now NULL) → banner reads "Paused — waiting for your resume"; queue-activity card shows the retry backlog + "direct from server" path. Open blast3 (`pending_test_confirm`) → test-gate copy. Confirm the modal shows the same block. Confirm NO recipient addresses appear in the new card (payload is PII-free by construction — verify in devtools network tab).
6. Confirm the drain is untouched: `git diff origin/main -- app/api/internal/mail-queue-drain/route.ts` is empty.
7. Deploy gate: this branch is UI + one read-only API route — safe to merge; deploy at owner's discretion 🚦.


## DEPLOYED & VERIFIED — 2026-10-19 (senior verification agent)
Merged to main via ort merge (c9aa516..c0b56f2, merge-order free with 227/228). Merged-tree gates in an isolated worktree: tsc 0 · eslint 0 · suite 1642/1641 pass/0 fail/1 skip · CI build ✓. Shipped by SW dispatch run 39138493191 (owner GO given) — BUILD_ID FzRmVYbdp4To16F2NjDaT → DavUl7Z8N2p9pbivrx4zw. On-box proof: /api/campaigns/[id]/stall-info route dir present; stallExplanation string in deployed chunks; anon GET stall-info → 401 (session gate live). Services active, public 200, no -p err entries.
