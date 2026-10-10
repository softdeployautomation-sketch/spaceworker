# TASK_197 — Invoice "sent twice" (duplicate thread card)

**Status:** PLANNED — created 2026-10-10 (before any code)
**Owner report:** "I tested the invoice for a user for device on wrapper, and it sent two invoices… i think its a general invoice bug."

## Evidence gathered BEFORE planning (2026-10-10)

- Forensics probe on the box (`t197-forensics.ts`, read-only): **ZERO duplicate invoice rows** — `DUP GROUPS: []`, `OPEN DUPS: []`. Today's invoice `cmv1wpdh` (premium_xdevice, $500, paid 04:47) exists exactly once.
- So "two invoices" = **two invoice CARDS in the support thread**, not two rows. Root cause:
  1. `POST /api/admin/users/[id]/invoices` (TASK_194 S4) fires `postInvoiceNoticeToUser` → server posts an invoice-bound message;
  2. the support composer (`support-queue-panel.tsx` step 2) then posts ITS OWN note with the same `invoiceId` → second card.
  - Users-tab path (`user-invoice-cell`) posts no message of its own → single card (the S4 fix was for it).
  - Emails are already deduped (messages route skips reply-email when `invoiceId` present).
- The 400-fallback (edit-existing) path also lands a composer note alongside an earlier server notice → same double.

## Fix plan (slices → gates → commit each)

- **S1 — route + composer opt-out**
  - Route: ALLOWED_KEYS += `threadNotice` (boolean, default true; non-boolean = 400 per strict-body rule). When false → skip `postInvoiceNoticeToUser` (invoice email `notifyUserInvoiceSent` unchanged — it is the money email).
  - `postInvoiceNoticeToUser`: idempotency belt — skip when a message already binds this `invoiceId` (protects old clients/retries).
  - Composer: include `threadNotice: false` in its POST body (its step-2 note IS the thread notice).
  - Tests: extend `tests/invoice-support-badge.test.ts` (+ composer static contract) — accepted key, skip path, idempotency, composer payload.
  - Gates: tsc 0 · eslint 0 new · affected suites green → commit + push.
- **S2 — deploy + live verify** (see deploy note below): send a test invoice from the composer on the box (or reason from build) → exactly ONE invoice card in the thread, invoice email still 1.
- **S3 — closeout**: record BEFORE/AFTER, command outputs, commits.

## Deploy note

TASK_197 + TASK_198 + TASK_199 + TASK_200 ship in **ONE VPS deploy** at the end (one build, one restart; each has its own commit + green gates first, and each is live-verified before closeout). Reason: identical files/route surfaces overlap and a single build halves deploy risk; recorded here BEFORE work starts.

## PROGRESS

_(entries appended after every step — dated, with proof)_
