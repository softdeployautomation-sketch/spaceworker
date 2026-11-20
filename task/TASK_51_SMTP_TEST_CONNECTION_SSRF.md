# Task 51 — Mailbox "Test connection" is an authenticated SSRF / internal port-scan oracle

**Status: FIXED, 2026-09-20.** Found during a security audit, 2026-09-20. `app/api/mailboxes/test-connection/route.ts` now runs the host through `validatePublicSmtpHost()` (new `lib/smtp-host-guard.ts`) BEFORE any `buildSmtpTransport`/`verify()` call — it does a real DNS resolution (both IPv4+IPv6 families via `dns/promises`) and rejects loopback, RFC1918 private, link-local, CGNAT, and other non-routable ranges, failing closed if the host doesn't resolve at all. The same guard is applied at mailbox save time (`app/api/mailboxes/route.ts` create + `app/api/mailboxes/[id]/route.ts` update) so a private-IP host can never be stored, AND inside `transporterForMailbox` (`lib/mailer-send.ts`, now async) so the REAL send path — not just test/save — is guarded against any mailbox saved before the fix (the pre-existing-gap the original fix had missed). The route also got a `mailbox-test` rate limit (20/hr/IP). Verified live against the deployed server via a disposable E2E: a test-connection against `127.0.0.1:587` is rejected with `400` mentioning "non-routable" before any network call, while `smtp.gmail.com` passes the guard and reaches the SMTP attempt; `npx tsc --noEmit` is clean.

## The real gap, confirmed live in code (not assumed)

`app/api/mailboxes/test-connection/route.ts` (lines 36–55) accepts raw `host`, `port`, `username`, `password`, `allowInsecure` from any authenticated user (session-gated only — no tier/trial restriction) and passes them straight into `buildSmtpTransport()` (`lib/mailer-send.ts:63–72`), which calls `nodemailer.createTransport(...).verify()` against whatever `host:port` was supplied. There is no allowlist, denylist, or private-IP/loopback check anywhere in that path.

Any signed-in user (including a free/trial account) can therefore point this endpoint at:
- `127.0.0.1` or `localhost` plus arbitrary ports, probing what's listening on the VPS itself (the app on 3500, the extraction worker on its bound port, Postgres, Redis if present, etc.) and getting an immediate `{ok:true}`/`{ok:false, error}` response that reveals open vs. closed vs. non-SMTP-speaking;
- internal VPS-network addresses or a cloud metadata endpoint (`169.254.169.254`) if the host is ever moved to a cloud provider that serves one;
- any third party's mail server, using SpaceWorker's own VPS IP as the source of an unsolicited connection attempt — a minor abuse-of-infrastructure vector on top of the SSRF concern.

This is a fast oracle: the response is immediate and distinguishes connection-refused vs. timeout vs. TLS/handshake failure vs. success, which is enough to fingerprint what's running on internal ports. There is no rate limit on this route either, so it can be scripted into a full internal port sweep cheaply.

## The fix

1. Reject `host` values that resolve to loopback, private (RFC1918), link-local, or other non-routable ranges before ever calling `buildSmtpTransport`/`verify()` — resolve the hostname first (don't just string-match the literal, since a hostname can resolve to a private IP via DNS rebinding) and check the resolved address.
2. Add rate limiting to this route (new `RateLimitKind`, e.g. `"mailbox-test"`), scoped per-user or per-IP.
3. Apply the same host-range check to the real send path (`transporterForMailbox` in `lib/mailer-send.ts`) if not already covered elsewhere — a saved mailbox with a private-IP host should be rejected at save time too, not just at test time.

## Verification expected

- Confirm a test-connection request against `127.0.0.1:3500` (or any private-range host) is rejected before any network call is made.
- Confirm a legitimate external SMTP host (e.g. a real Gmail/SMTP-relay test account) still passes.
- Confirm repeated rapid test-connection calls from one account/IP get rate-limited.

## Known follow-up (not in this batch)

The guard resolves the host once at save/test time and checks that result, but nodemailer does its own independent DNS resolution later when it actually connects — a potential TOCTOU/DNS-rebinding gap (an attacker's DNS answers public at validation but private at connect, via a short TTL). Fully closing it would mean connecting to the already-validated IP directly (passing the resolved address as the connect host, keeping the original hostname only for TLS SNI/cert verification) rather than re-resolving at connect time. Out of scope for this task; worth its own follow-up if a higher-threat deployment needs it.
