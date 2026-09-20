# Task 51 — Mailbox "Test connection" is an authenticated SSRF / internal port-scan oracle

**Status: ready to build. Found during a security audit, 2026-09-20.**

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
