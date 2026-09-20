# Task 49 — `confirmTransfer` is a bare client-supplied boolean, not real consent

**Status: ready to build. Found during a security audit, 2026-09-20, directly contradicts the intent of this session's own Task 47/auto-bind "no silent theft" fix.**

## The real gap, confirmed live in code (not assumed)

`app/api/exe-license/auto-bind/route.ts` (lines 98–131) accepts `confirmTransfer: boolean` straight from the request body and, when `true`, calls `transferExeLicenseToMachine()` directly — no session, no admin check, no proof the "confirmation" ever happened on a real screen.

That function is `lib/exe-license-bind.ts`'s `transferExeLicenseToMachine` — and that file's own comment block (lines 228–230) says, in its own words:

> "No self-service caller uses this — it stays admin/support-only (letting a buyer freely re-bind would defeat the one-device-per-license guarantee)."

That's no longer true. `auto-bind`'s self-service path IS a self-service caller of it now.

The route's file-top comment (added this session, 2026-09-20) explains the intent: require `confirmTransfer` so a transfer only happens "after the person on the NEW machine has seen an 'already active on another device — move it here?' prompt and clicked through it." But `confirmTransfer` is just a JSON boolean in the POST body — nothing about the request proves a human saw that prompt. Anyone who has:
- a copy of a customer's plaintext license key (leaked, phished, pulled from a support ticket, shared by the buyer with a friend), and
- the matching purchase email (often guessable — it's usually the buyer's own email, sometimes visible in the same leak),

...can `curl` `auto-bind` directly with `confirmTransfer: true` and silently move the binding to their own machine in one request. This is exactly the "silent theft" scenario the owner asked to close this session ("i need to be sure a user with the exe doesnt get using this exe without my consent"), just with one extra JSON field standing in the way instead of zero.

Compounding it: `transferExeLicenseToMachine` only calls `notifyAdmin()` (a Telegram ping to the operator) — it never emails or otherwise notifies the actual licensee/account owner that their device binding just changed. The legitimate user on the original machine has no way to find out their license was moved until it silently stops working.

There's also no rate limit on this route, so even a low-confidence guess-the-email attempt could be scripted and retried cheaply.

## The fix

1. **Self-service transfer needs a real out-of-band confirmation step**, not a client-supplied boolean. Minimum viable version: when `bindExeLicenseToMachine` returns `already_bound`, don't accept `confirmTransfer` in the same request — instead send a confirmation link/code to the licensee's registered email (or, if the account has Telegram linked, a Telegram prompt) and require that token on the follow-up request. Only then call `transferExeLicenseToMachine`.
2. **Notify the actual license owner**, not just the admin, whenever a transfer happens — email (and Telegram if linked) to the account on file, before or immediately after the transfer completes, so a legitimate user whose license was moved out from under them finds out immediately rather than by their EXE silently failing.
3. Add rate limiting to `auto-bind` (new `RateLimitKind`, e.g. `"exe-auto-bind"`) keyed by IP, matching the posture already used for `login`/`exe-password-login`.
4. Either update `lib/exe-license-bind.ts`'s comment to stop claiming "no self-service caller uses this" (now false), or — better — keep that invariant true by moving the self-service confirmation flow through a genuinely separate, token-gated path rather than letting `auto-bind` call the admin-only transfer function directly.

## Verification expected

- Attempt a scripted `curl` to `/api/exe-license/auto-bind` with a valid key + matching email + `confirmTransfer: true` and NO prior confirmation step — must be rejected until the new out-of-band token is presented.
- Confirm the licensee's email (and Telegram, if linked) actually receives a notification when a transfer completes.
- Confirm the rate limit trips on repeated attempts from one IP.
