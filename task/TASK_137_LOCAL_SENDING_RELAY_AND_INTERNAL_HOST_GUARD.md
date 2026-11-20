# TASK 137 — Sender fix: our own relay, our own DKIM, and the internal-host door

**Status:** fixed, tested, deployed
**Date:** 2026-09-28
**Owner ask:** *"is there a way we can create like a local server in the server to act
like that and help us send. we need this. cant write to a server, it will take long,
and is the ip route not helping. lets find a solution from our end... fix this first"*

## The problem, stated precisely

The customer's sending host `watsonandrade9382.ca.lu` (A → **172.233.80.73**, a Linode
box) is not a usable SMTP server, and no setting in SpaceWorker can change that:

| Port | Banner | AUTH | `RCPT TO` (its OWN address) | With the real password |
|---|---|---|---|---|
| 25 | `220 localhost Python SMTP 1.4.6` | **not offered** | `550 Not allowed` | nothing to log into |
| 24610 | `220 ABC XYZ` | offered (LOGIN) | `530 5.7.0 Authentication required` | **`542 Internal server error`** |

Read together: it **requires** authentication (24610 refuses `MAIL`/`RCPT` with `530`)
and it **offers no way to complete it** (25 advertises none at all; 24610 errors `542`
on the password). It also refuses **its own address**, so this is not recipient
filtering and not our IP's reputation. The banner differs between probes, so these are
two unstable `aiosmtpd` instances. `RCPT TO` is refused for everyone → every message
dies at the envelope, which is why a campaign delivered nothing — **not even to spam**.

The domain's DNS is equally empty (see below): no SPF, no DKIM, no DMARC, no MX.

## What I proved about "is the ip route not helping"

**Correct — it does not help, and it cannot.** I re-ran the identical probes three
ways: direct from the VPS, and twice through the US exit-node proxies
(`172.17.0.1:1090`, `:1091`). Every reply was **byte-identical** (`550 Not allowed` on
25; `542` on 24610). The relay's refusal is about authentication, not about who is
connecting, so changing the connecting IP changes nothing. The US route is therefore
**not needed for this mailbox** — and it could not fix the separate
`550 Message discarded as high-probability spam` either, because that verdict was
made by the *destination* from SPF/DKIM/PTR reputation, which an exit node does not
repair (it arguably makes PTR alignment worse). Recommendation: leave this mailbox on
**direct**.

## The solution from our end: a local relay we control

A Postfix relay on the VPS itself, **bound to loopback only** (`inet_interfaces =
loopback-only`, `mynetworks = 127.0.0.0/8`), with:
- **port 587 + SASL AUTH** (`relay@spaceworker.top`) — a real login, so the
  "server never asked for a password" pathology cannot recur;
- STARTTLS available, but AUTH is **not** TLS-gated (`smtpd_tls_auth_only = no`), so
  SpaceWorker can use it in **"None (unencrypted)"** mode on loopback — which is safe
  precisely because nothing can reach it off-box;
- **OpenDKIM** signing, `milter_default_action = accept` so a milter fault can never
  block mail;
- delivery via direct SMTP from the VPS's own IP (verified delivering: a live send to
  a third-party destination returned `250 Ok`).

### Two silent no-ops that had to be fixed before DKIM actually worked

1. **`systemctl reload/restart postfix` on this box is a no-op** — the unit is a stub
   (`ExecStart=/bin/true`, `ExecReload=/bin/true`). It always reports `active`, so the
   milter config sat in `main.cf` while the running `master` kept its old in-memory
   config, forever, with no error. Use the binary `postfix reload`.
2. **The milter socket was unopenable by the smtpd user** — bound `opendkim:opendkim`
   while smtpd runs as `postfix`; combined with `milter_default_action = accept` the
   failure was invisible (mail flowed, unsigned, silently). Fixed with
   `UserID opendkim:postfix`.

### Proof (not a log line)

```
DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/simple;
        d=watsonandrade9382.ca.lu; s=sw; t=1790629790;
        h=From:To:Subject:Date:From;  b=<2048-bit signature>
...
dns queries: ['sw._domainkey.watsonandrade9382.ca.lu.']
DKIM VERIFY: PASS          <-- dkimpy, signature validated against the keypair
```

`grep opendkim /var/log/mail.log` had shown **only start/stop banners** across two
supposedly-successful restarts, so the log looked like evidence and was not. The
verification is real: the delivered message's signature was checked against the
public key, stubbing DNS so the missing TXT record could not mask a key mismatch.

## The code change that makes it usable (this repo)

The relay is on `127.0.0.1`, and **Task 51's guard rejected every loopback/private SMTP
host** (correctly — it was an authenticated port-scan oracle against the VPS's own
network). So the relay existed but the product could not use it.

`lib/smtp-host-guard.ts` now takes an **operator-only** allowlist,
`SMTP_INTERNAL_RELAY_HOSTS`, accepting `host:PORT` pairs:

- read from the **operator's environment**, never from request data, so a signed-in
  user still cannot point a mailbox at `127.0.0.1` unless the operator allowed it;
- **the port is mandatory** — a portless entry is ignored (fail closed), because
  allowing the whole host would re-permit probing EVERY loopback port, which is
  exactly the hole Task 51 closed;
- `validatePublicSmtpHost(host, port)` — callers that cannot supply a port keep the
  old strict behaviour. Port threaded through all four call sites (mailbox **create**,
  **update**, **test-connection**, and the **real send path** in `mailer-send.ts`).

`npm run test:mailguard` (10 tests, `tests/smtp-host-guard.test.ts`) pins both halves:
with no allowlist nothing internal is reachable (loopback, RFC1918, link-local, and
the cloud metadata address all still blocked), and with `127.0.0.1:587` allowlisted
only that exact host:PORT opens. **Mutation-checked**: removing the port comparison
makes 2 tests fail, so the file is a real guard and not decoration.

### How to use the relay in the product

Add a mailbox with host `127.0.0.1`, port `587`, username `relay@spaceworker.top`,
and Security **None (unencrypted)** (safe: loopback only), then **Test connection**.
No SPF/PTR work is needed for the app to *connect*; those matter for *inbox placement*
below.

## The one thing still outstanding (and it is not on our servers)

DKIM only *verifies* once its public key is published. `watsonandrade9382.ca.lu` has
**no DNS records at all** — `dig` for NS/SOA/TXT/MX returned nothing; the name
resolves only via its A record inside the Cloudflare zone that owns `ca.lu`.

To make mail From this domain deliver, three TXT records must be added **in DNS** (a
five-minute change, no server access needed — nothing to "write to a server"):

```
sw._domainkey.watsonandrade9382.ca.lu  TXT  "v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxyW+kfYm1wlCPOj7niHWeNNtfG6f1ET+cd4JCMxBgUm8t56v0BvNPwJBkKbVC2GvAxyxlXJXGl19W3tgSH+4Kfoi6+1pvINHG9Rz4WoC8Ix3OCHqmk6XPOcK0k6fzFiKOyaNFwjMcroRMFw7/uEeJ8guga6WrbJJGCeDxYF1Lid5DfM7gr1COEw0WYm4XFFAWI2sBDVv/Xpp/0YIjqkcHZRp8AjBJJZaKRsLtoYu2Nzisrt/7npCNSm5ca5i12yuyr+NB/DjP5OLstutwuHv9IQX2Xu6mcSF1qy5RN5fZ3HP+dEwxfRSkQD3XgtMxXkizow1GMYI2PUXvZPdL/rPSQIDAQAB"

watsonandrade9382.ca.lu              TXT  "v=spf1 ip4:164.68.105.96 ip6:2a02:c207:2354:8623::1 -all"
_dmarc.watsonandrade9382.ca.lu       TXT  "v=DMARC1; p=none; rua=mailto:dmarc@spaceworker.top"
```

(SPF must list the relay's egress — the VPS IPv4 `164.68.105.96` and IANA IPv6
`2a02:c207:2354:8623::1`. `p=none` first, so nothing is lost while the records
propagate.) A **PTR** for `164.68.105.96` → `mail.spaceworker.top` is requested from
the hosting panel; it currently reads `vmi3548623.contaboserver.net`, and a HELO name
that does not match PTR is a reputation penalty. `mail.spaceworker.top` also needs an
**A record** → `164.68.105.96`, because Postfix HELOs as that name and it does not
currently resolve.

Until those exist, mail sent as the customer's domain carries a signature that cannot
be verified (receivers treat a missing key as "no DKIM", so it is not harmful — just
not yet earning anything). The relay itself and the signing are done.

## Deploy / verification

- `npm run test:mailguard` 10/10; full local suite green
  (deliverability 6, smtp 11, mailguard 10, devices 6, vantra 58); `tsc` 0 errors;
  eslint clean; `CI=true npm run build` **EXIT=0**
- `SMTP_INTERNAL_RELAY_HOSTS=127.0.0.1:587` set in `/opt/spaceworker/.env`
  (backup taken first: `/root/env.bak.<stamp>`)
- full-tree rsync + `scripts/deploy-vps.sh` (**not** a `--files-from` list — see
  HOW_WE_MOVE_FAST §2a for the sibling trap), then a full-tree md5 parity check
  against `/opt/spaceworker`

### Confirmed on the live server (not just locally)

Deploy log: `localhost:3500/ -> 200`, `-- maintenance OFF`, `-- done`; service
`active`, Postfix `active` (master etime < the reload, so the config is really
live), OpenDKIM `active`, allowlist present in the deployed `.env`.

The E2E script ran the **deployed** `lib/smtp-host-guard.ts` with production's own
`SMTP_INTERNAL_RELAY_HOSTS` and then sent through the relay as the app does:

```
=== 1. guard: the operator's relay ===
allowlist parsed: [{"host":"127.0.0.1","port":587}]
  ok   accepts 127.0.0.1:587
  ok   still REFUSES 127.0.0.1:3306 (not a port scanner)
  ok   still REFUSES cloud metadata
=== 2. real send through the relay (the app's own transport config) ===
  ok   relay accepted the message after authenticating — 250 2.0.0 Ok: queued as 301C413D7C9

ALL CHECKS PASSED
```

...and that queued message really arrived, signed and verifiable:

```
301C413D7C9: status=sent (delivered to mailbox)     <-- not "accepted and dropped"
DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/simple; d=watsonandrade9382.ca.lu; s=sw
DKIM VERIFY: PASS
```

Full-tree parity against `/opt/spaceworker`: **424/424 files, 0 missing, 0 stale,
0 extra — PARITY OK** (code trees + `next.config.ts`, `proxy.ts`, `package.json`).
All temporary probe/verify scripts were removed from both the repo and the server.

