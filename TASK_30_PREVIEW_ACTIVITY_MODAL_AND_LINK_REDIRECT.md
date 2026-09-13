# Task 30 — Send preview, an activity/sent overview modal, and optional link-redirect cloaking

**Status: ready for Cline, after Task 29 and the deliverability-fallback batch (commit `52f87f7`).** Three separate asks from live-testing feedback (2026-09-13), grounded in the actual current code. Independent of each other — ship in any order, but 1 and 2 are smaller and more urgent (they came out of directly diagnosing why a real test email looked broken and landed in spam).

---

## 1. Preview the resolved subject/body before sending

**The concrete bug that surfaced this need**: a real test send went out with the subject `", a faster way to create content"` — a stray leading comma where `{{firstName}}` should have been. Root cause: the subject template is `"{{firstName}}, a faster way to create content"`, and `lib/render-merge.ts`'s `renderMerge()` substitutes a missing merge variable with an empty string rather than leaving the tag or adjusting surrounding punctuation. This happens to every ad-hoc "manual insert" test recipient (`lib/campaign-recipients.ts`'s `insertManualRecipients()` creates them with `variables: {}` — no `firstName`, ever), and will also happen to any real lead missing that field. **Don't silently rewrite the user's authored template or invent punctuation-collapsing logic** — that's a content decision, not a bug fix. The actual fix is visibility: let the user see exactly what will be sent, for real recipients, before they confirm.

**Build**: a "Preview" affordance in two places:
- **Campaign create modal** (`app/dashboard/campaigns/page.tsx`): next to the subject/body editor, a "Preview" button that renders the CURRENT draft subjects/bodies (or legacy variants) through `renderMerge()` using a **sample recipient** — either the first selected lead's real merge variables (if `recipientSource === "leads"` and at least one is selected) or an all-empty-variables render (so a user testing with no real leads yet still sees the "Hi ," problem BEFORE creating the campaign, not after). Show it as a read-only modal or inline expandable panel: resolved subject, and the body rendered as actual HTML (in a sandboxed `<iframe srcDoc=...>` — never `dangerouslySetInnerHTML` directly, matching this page's own existing XSS-avoidance note in `stripHtml()`) so the user sees it as a recipient's mail client would, not raw markup.
- **Campaign detail page** (`app/dashboard/campaigns/[id]/page.tsx`): once queue items exist, let the user pick ANY real `EmailQueueItem` from the roster (a dropdown or "Preview" link per row in the existing items table) and see that exact item's `resolvedSubject`/`resolvedBodyHtml` (decoupled campaigns) or `variant.subject`/`variant.bodyHtml` (legacy) rendered with that item's real `variables` — the actual content that specific recipient will receive, not a generic sample. This is what would have caught the reported bug directly: previewing the `manual_insert` test row itself would have shown the exact broken subject before it ever sent.

Reuse `renderMerge` as-is (client-safe import or a tiny API route that calls it server-side and returns `{subject, html}` — check whether `lib/render-merge.ts` has any server-only dependencies before assuming it can run client-side; if it does, add a small `POST /api/campaigns/[id]/preview` route instead of calling it directly from the browser).

## 2. Activity/sent-overview modal (don't require scrolling the whole queue)

Live feedback: the campaign detail page's queue table requires scrolling through potentially thousands of rows to see "what's been sent so far" — the user wants a compact overview surfaced in a modal instead. Build a "View activity" / "Sending activity" button (near the existing status badge / batch-size line) that opens a modal (portal to `document.body`, matching every other modal in this app — see `components/modal.tsx`'s stacking-context fix) showing:
- A running tally: total queued / sent / failed (counts already computable from `campaign.items`, or add a lightweight `GET /api/campaigns/[id]/stats` if the full item list isn't always loaded).
- The most recent N sends (e.g., last 20-50 `status: "sent"` items, newest first) with recipient, mailbox, sent-at time — a live-feeling activity feed, not the full paginated table.
- Any failures, surfaced prominently (recipient + error), since those are the ones a user actually needs to act on.
- Auto-refresh while `campaign.status === "sending"` (poll every few seconds, same pattern as the Extract page's job-list polling) so it reads as "live," matching the spirit of Task 26 Piece 1's activity feed on the Extract page — this is the Campaigns-side equivalent of that feature.

Keep the existing full paginated table on the page as-is for anyone who wants the complete, scrollable record — this modal is a faster-glance addition, not a replacement.

## 3. Optional link-redirect cloaking (bigger, genuinely new subsystem)

**The ask**: raw links in a campaign's HTML body (e.g., `https://channelryapp.sbs/...`) can themselves be a spam signal — a `.sbs` domain or an unfamiliar raw link is exactly the kind of thing spam filters key on. Let a user optionally wrap any link in the body behind a SpaceWorker-hosted redirect, so the visible/crawled link is on SpaceWorker's own (presumably better-reputed) domain instead.

**Scope, explicitly bounded for a first pass** — a real link-shortener/redirect system, not full click-analytics:
- **New model** `LinkRedirect { id, userId, campaignId, token (unique, short, url-safe), targetUrl, clickCount, createdAt }`.
- **New public route** `GET /r/[token]` (no auth — it's a public redirect endpoint, same trust model as any link-shortener) — looks up the token, increments `clickCount`, issues a 302 to `targetUrl`. Getting a real click count essentially for free here is a reasonable, cheap addition on top of the redirect itself — not scope creep, just don't build more analytics than a plain counter for this pass.
- **Link extraction + picker UI**: parse the campaign's HTML body(ies) for `<a href="...">` targets (a simple regex or a lightweight HTML parser — check what's already available in `package.json` before adding a new dependency; `lib/lead-file-parser.ts`'s xlsx handling might already pull in something usable, or a plain regex is fine for well-formed authored HTML). Show the user every distinct link found, each with a checkbox — **optional per-link, not automatic** (per the ask). For each checked link, generate a `LinkRedirect` row and replace that exact URL in the stored body with `https://spaceworker.instaweb.top/r/<token>` before the campaign is created (do this at `createCampaign()` time, not by mutating the user's draft — the redirect is a distinct database link, not a UI-side string edit that could drift from what's actually resolvable).
- **"Encoded" / non-obvious token**: use a short random token (e.g., `nanoid` or `crypto.randomBytes(6).toString("base64url")` — check if a slug-safe random-string helper already exists in `lib/` before adding a dependency) — the goal per the ask is "doesn't visually announce itself as a tracking/redirect link," not cryptographic security; a public route means the token itself carries no secret, it's just an opaque lookup key.
- **Where this lives in the UI**: the campaign create modal, in a new section near the subject/body editor (or folded into the same area as the Preview feature from item 1, since a user would naturally want to preview what the cloaked link looks like inline). Only show it when the body actually contains `http(s)://` links — no UI clutter for a plain-text or link-free body.

**Explicitly out of scope for this pass**: per-click analytics beyond a plain counter (no click timestamps table, no per-recipient click attribution — that's a much bigger feature and wasn't asked for); domain rotation/multiple redirect domains; automatic (non-optional) link wrapping — the ask was explicit that this stays opt-in per link.

---

## Sequencing recommendation

1. Item 1 (preview) — smallest, and the one that would have caught the actual bug that prompted all three asks. Do this first.
2. Item 2 (activity modal) — self-contained UI addition, no schema changes.
3. Item 3 (link redirect) — the only one needing a new model + new public route; give it its own careful pass, verify the redirect route live (a real click should actually land on the target, and increment the counter) before considering it done.

## Verification expected

- `npx tsc --noEmit` / `npm run build` clean, as always.
- Item 1: preview a template with a merge tag and no value for it (exactly the reported scenario) — confirm the resulting gap is now VISIBLE to the user before they send, not hidden.
- Item 3: create a real `LinkRedirect`, visit `/r/<token>` in a real browser, confirm it redirects to the right target and the click count increments. Confirm an unknown/expired token responds with a clean 404, not a raw stack trace.
