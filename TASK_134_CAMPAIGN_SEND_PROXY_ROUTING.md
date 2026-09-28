# TASK_134 — Route campaign sends through a regional proxy (premium)

## Why

`lib/mailer-send.ts` connects directly as an SMTP client to each mailbox's own
server — the TCP connection (and therefore the `Received: from` header the
recipient's mail server sees) always originates from wherever SpaceWorker
itself runs. Our VPS is in Germany/France (a generic European datacenter
range). A user whose actual business and recipients are US-based sending
through a European datacenter IP is a real, independent deliverability
signal some spam filters weigh — separate from content and separate from
SPF/DKIM (see "What this does NOT fix" below).

We already have working, stress-tested SOCKS5 exit nodes for exactly this
kind of regional routing — built for the private-browser tool, not sending
mail, but the underlying "route this outbound TCP connection through a named
regional exit" problem is identical.

## What already exists (reuse, don't rebuild)

- `lib/exit-nodes.ts` — `listExitNodes()` / `getExitNode(id)`. Three nodes
  today: `us` (New York), `ca` (Toronto), `uk` (London), each a SOCKS5
  endpoint read from an env var (`EXIT_NODE_US` etc.), confirmed reliable
  under stress test. UK is deploy-time config, no fake IP committed.
- `lib/browser-proxy.ts` — `ProxySpec`, `encryptProxySecret()` /
  `decryptProxySecret()` (same AES-256-GCM machinery as mailbox passwords),
  `proxyServerValue()`. Built for a BYO proxy on the browser tool; the
  encryption pattern is directly reusable, the Chrome-specific bits are not.

## What's new

1. **A SOCKS5-aware SMTP transport.** `buildSmtpTransport()`
   (`lib/mailer-send.ts`) needs an optional `proxy: { host, port }` param that,
   when set, tunnels the raw TCP connection through the SOCKS5 exit before
   nodemailer does its TLS/SMTP handshake — the SMTP auth/TLS logic itself is
   unchanged, only the underlying socket's origin moves. The `socks` npm
   package's `SocksClient.createConnection()` returns a raw `net.Socket`
   nodemailer's `connection.socket` option accepts directly; no forked
   transport class needed.
2. **A per-mailbox routing setting**, not per-campaign — a mailbox is already
   the unit of "one real-world sending identity," and routing is a property
   of that identity, not of any one campaign sent from it. Add
   `Mailbox.sendRegion: String?` (`"us" | "ca" | "uk" | null`, null = default/
   direct). Shown in Settings → Mailboxes, next to the existing "Test
   connection" button — gate the control itself behind `isPremiumTier()`
   (free tier sees it disabled with an upsell tooltip, not hidden entirely,
   matching how other premium gates in this app already read).
3. **Test-before-save**, mirroring the existing mailbox test-connection
   pattern exactly: picking a region does a live `transporter.verify()`
   through that exit before the setting is allowed to save, so a flaky/down
   exit node is caught immediately, not on the next real campaign send.
4. **Wire it into the real send path**: `transporterForMailbox()` reads
   `mailbox.sendRegion`, resolves it via `getExitNode()`, passes the proxy
   spec into `buildSmtpTransport()`. One call site, no changes to the
   mail-queue drain's own logic.

## What this does NOT fix (say this to the user up front, every time)

Changing the connecting IP addresses the "generic datacenter IP, no
reputation, geographically implausible" signal. It does **not** fix SPF/DKIM
alignment: if a mailbox's sending domain publishes an SPF record that only
authorizes its own real mail server's IPs, sending through ANY IP outside
that record — our VPS or a proxy — still fails a strict SPF check. Domains
the user actually owns can add the proxy exit's IP to their SPF record
(worth a one-line note in the UI linking to instructions); domains they
don't own (most BYO mailbox setups) can't be fixed this way at all, proxy or
not. Frame this feature as "removes one real signal," never as "guarantees
inbox placement."

## Scope boundaries for v1

- No new regions beyond the existing three (US/CA/UK) — French/German nodes
  matching our own server's location aren't useful here (the problem is a
  European IP, adding another one doesn't help); a genuinely new region is a
  separate ask (new Fly.io Machine + env wiring), not part of this task.
- No per-recipient/per-country auto-selection — the user picks one region
  per mailbox, manually. Smarter auto-routing (e.g. "route US recipients
  through `us`, everyone else direct") is a real idea but a distinct,
  larger feature — flag it, don't build it here.
- Free tier: setting is visible but disabled (see point 2) — never silently
  ignored or hidden, per this app's existing "expose every setting, gate
  don't hide" convention.

## Verification

- Real `transporter.verify()` through each of the three exit nodes from a
  disposable test mailbox, confirming SMTP AUTH actually succeeds end-to-end
  through the tunnel (not just that the SOCKS5 handshake completes).
- A real test send through a proxied mailbox, confirming the recipient's
  `Received:` header chain shows the exit node's IP, not the VPS's.
- Free-tier account confirms the control is visible-but-disabled with a
  working upsell link, not silently absent.
