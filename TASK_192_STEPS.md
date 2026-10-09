# TASK_192_STEPS — wrapper request-premium flow = web flow

## BEFORE-PLAN (written 2026-10-09, before any code)

1. **S1** — settings card: delete the wrapper priced `<Link>` arm, render the
   web `SupportTicketButton template="premium-xdevice"` unconditionally;
   `ToolLockCard`: delete price fetch/state/label branch, render the same
   button with `Upgrade to Premium XDevice`. Update B1 locks in
   `tests/premium-request-static.test.ts` to the NEW line (no price anywhere,
   ticket CTA everywhere).
   Gates: tsc · eslint touched files · `npm run test:premium-request-static`.
   Commit.
2. **S2** — billing page: wrapper subscription branch → `PremiumRequestCard`
   pinned to xdevice (never web_subscription); remove the wrapper-only
   `SpendFlow` block; rejected-resubmit wrapper arm → `PremiumRequestCard`.
   Remove now-dead code only if unreferenced (else keep — no gratuitous
   deletions). Gates + `test:xdevice-payment` `test:xdevice-route-gate`. Commit.
3. **S3** — support composer in wrapper mode: hide the
   `premium_request_plus` `<option>` via `useWrapperMode()`; add a static test
   asserting the wrapper branch filters it. Gates + commit.
4. Full-suite sanity `npm run test` before closeout; push everything.
5. Progress entry after EVERY step (dated, with proof).

## PROGRESS

