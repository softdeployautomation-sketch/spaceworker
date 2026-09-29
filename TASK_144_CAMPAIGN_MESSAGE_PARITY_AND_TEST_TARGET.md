# TASK_144 — The test send was not the message the campaign sends

**Status:** done, deployed, verified
**Touches:** `lib/campaign-message.ts` (new), `lib/test-target.ts` (new),
`lib/deliverability.ts`, `app/api/internal/mail-queue-drain/route.ts`,
`app/api/campaigns/route.ts`, `app/api/campaigns/[id]/route.ts`,
`app/api/campaigns/[id]/test-send/route.ts`, `lib/campaign-create.ts`,
`app/dashboard/campaigns/page.tsx`, `app/dashboard/campaigns/[id]/page.tsx`,
`prisma/schema.prisma` + migration `20261019000000_campaign_body_format`,
`tests/campaign-message.test.ts` (new), `tests/test-target.test.ts` (new)

---

## 1. What the customer reported

Three things, in one session, on a mailbox that demonstrably works:

1. A campaign's **test emails never arrived** in the Comcast inbox — two tries,
   nothing. But a hand-built plain-text "hello" through the **same mailbox**
   reached the inbox. And the campaign's **real** sends also never arrived, while
   a *second* address in the same campaign did get its copy (in spam).
2. Adding an address as a **test** recipient **also made it a real recipient** —
   no way to test without also sending it the campaign.
3. After sending finished, the queue table **still showed rows as "Queued"**.

The customer's framing was the right one: *"if yours gave inbox, then what's the
issue"* — the mailbox was never the problem.

## 2. Root cause 1 — the test send and the real send were different messages

`app/api/internal/mail-queue-drain/route.ts` and `lib/deliverability.ts`'s
`runTestSend` **each built their own MIME payload**, and they had drifted in
exactly the two ways that decide inbox-vs-spam:

| | real queue drain | test / preview send |
|---|---|---|
| plaintext alternative | **yes** | **no** — HTML-only |
| `List-Unsubscribe` headers (RFC 8058) | **yes** | **no** |
| visible unsubscribe footer | **yes** | **no** |

So the deliverability gate the user is *gated behind* was grading a message
nobody would ever receive: an HTML-only, no-unsubscribe single-part message,
which is itself a documented spam heuristic.

**The decisive evidence** was already in hand from the previous session: a
hand-built **plain-text** message through the same WEDOS mailbox landed in the
Comcast **INBOX**, while the app's HTML-only test send did not. Same SMTP, same
credentials, same destination — the only variable was the message shape.

**Fix:** `lib/campaign-message.ts` is now the ONE place a campaign message is
assembled. Both paths call it, so a test message **is** the message a real
recipient gets. This is a structural fix, not a patch: there is no longer a
second implementation that *can* drift.

## 3. Root cause 2 — the only way to set a test target also queued it

## 4. Root cause 3 — "Queued" that never went away

`patchCampaign` in the detail page documents that it never touches `items` —
correct for the **test-time** actions it was written for, none of which change
the queue. But the **live-sending poll** also used it, and sending is precisely
the thing that changes every item's status.

Confirmed live: campaign `blasting2` sat showing three **"Queued"** rows while
the database held all three at `status: "sent"` with real `sentAt` timestamps.

**Fix:** the poll's per-item statuses are folded into the queue table by id (the
payload is `{id, toEmail, status, sentAt, error}` — exactly what a row renders, so
no extra fetch), **plus** a full `reloadItems()` on the final tick, because a
5-item poll window cannot cover a 500-item batch that ends in one go.

## 5. Also in this task

- **Plain-text-only mode.** `EmailCampaign.bodyFormat` (`"html"` default,
  `"text"`), so a user triaging spam can switch the body format and have the
  change actually apply to real sends. Deliberately a **campaign-level saved
  property**, not a test-only switch: a test that sends a different shape from
  the real send predicts nothing — which is the bug this whole task exists for.
  `normalizeBodyFormat` is the single normaliser; the PATCH route **rejects**
  anything but `"html"`/`"text"` rather than defaulting silently, so a typo can
  never be saved as an apparently-successful change.
- **"Latest check: delivered" no longer lies for override sends.** A test sent to
  a specific inbox is never auto-verified — we have no IMAP access to it, so the
  stored status only ever means "the SMTP send succeeded". It printed green
  "delivered" next to a "landed in unknown" note, and a user read that as *the
  test passed* while nothing had arrived. Now: `sent — not auto-verified` in
  amber.

## 6. Verification

- **168/168** across all suites
  (`deliverability` 6, `smtp` 11, `mailguard` 10, `domains` 37, `smtpcap` 7,
  `presets` 8, `target` 10, `message` 15, `devices` 6, `vantra` 58).
- **Mutation-checked, both caught then restored byte-identical:**
  - ignoring the standalone test target → **5 failures**
  - dropping the plaintext part from the builder (the exact drift that caused
    this bug) → **3 failures**
- `tsc` clean; eslint clean on every touched file (the one remaining
  `set-state-in-effect` in `campaigns/[id]/page.tsx` is **pre-existing** —
  verified by running the same check on the stashed HEAD version, which reports
  the same single error).
- CI production build `EXIT=0`.
- Migration validated on a scratch clone of production: column present
  (`text default='html' nullable=NO`), then `prisma migrate diff --exit-code`
  → **`No difference detected` / DRIFT=NONE**.

## 7. Test-harness note worth keeping

`tests/deliverability-probes.test.ts` loads `lib/deliverability.ts` under a
require hook. Adding the shared builder pulled in a new require chain —
`deliverability.ts → campaign-message.ts → unsubscribe-token.ts → env` — and
`lib/env.ts` calls `required()` at **import** time, so the suite died with
`Missing required environment variable: APP_BASE_URL`.

The env stub had to go **outside** the `from.endsWith(MODULE_UNDER_TEST)` gate,
because by the time env is requested the parent is `unsubscribe-token.ts`. Two
traps inside that one fix:

- The tempting shortcut is to stub `./campaign-message` itself, like the other
  entries. That is the **wrong** fix: the stub would silently satisfy any future
  probe that *does* build a message — a green test for a function that never ran.
  Only the env read is stubbed, so the real builder and the real HMAC signing
  still load.
- **Two spellings of the same module.** `unsubscribe-token.ts` requests
  `@/lib/env` while `campaign-message.ts` requests `./env`. Matching only the
  first silently fixed nothing; the suite still failed with the identical error.
  Both spellings are now matched, and the reason is commented in place.

## 8. The lesson worth keeping

**A verification path that builds its own artefact is not verifying the real
path.** Two send paths that "both send an email" are not equivalent — they were
equivalent in the field that mattered least (the SMTP call) and different in the
fields that decided delivery. The gate was gating on a message that did not
exist in production.

The rule this leaves behind: **if a test is meant to predict a real send, it must
call the same builder the real send calls.** Anything else is a second
implementation waiting to drift.

The sole mechanism was `manualInsert.useAsTestTarget`, a checkbox **inside the
queue-insert block**. Setting a test address therefore necessarily inserted that
address as a real recipient of the campaign.

Confirmed live 2026-09-29: one Comcast address received **4 tests plus 3 queued
sends within four minutes**, all with identical subject and body.

**Fix:** `lib/test-target.ts` holds the resolution rule, and the create flow
gained a **standalone** `testRecipientOverride` field that is never inserted into
the queue. Precedence is explicit (standalone wins) because both inputs can
arrive together, and the rule is a separate module so it is testable without
booting a route handler or a DB.
