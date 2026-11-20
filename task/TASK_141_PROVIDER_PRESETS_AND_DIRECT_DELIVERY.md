# TASK_141 — Provider presets for BYO-SMTP, and why a desktop mailer "worked"

**Status:** done, deployed, verified
**Touches:** `lib/smtp-provider-presets.ts` (new), `tests/smtp-provider-presets.test.ts` (new),
`components/mailboxes-panel.tsx`, `package.json`

---

## 1. Why this task exists

The support loop we were stuck in looked like "our sending is broken". It is not.
It was two separate things wearing the same symptom, and this task settles both.

### 1a. The relay the customer supplied is broken for everyone

`watsonandrade9382.ca.lu` (`172.233.80.73`) refuses authenticated submission no
matter where you connect from. Measured, same conversation from two very
different networks:

| Probe origin | Port 25 | Port 24610 (AUTH) | MAIL / RCPT |
|---|---|---|---|
| VPS `164.68.105.96` (datacenter) | `220 localhost Python SMTP 1.4.6`, no AUTH | `542 Internal server error` | `530 5.7.0 Authentication required` |
| Mac `105.112.11.167` (residential) | **no TCP connection at all** | `542 Internal server error` | `530 5.7.0 Authentication required` |

Ports 465 / 587 / 2525 are not listening. The relay also refuses **its own**
address (`550 Not allowed`), so it is not recipient filtering and not our IP.
Its banner differs between ports and between probes (`ABC XYZ` vs
`localhost Python SMTP 1.4.6`) — two unstable `aiosmtpd` instances.

**Consequence for support: any mailer in RELAY mode would see the same 542/530.**
This is not a SpaceWorker bug and no mailbox setting can work around it.

### 1b. Why the customer's desktop mailer "worked from an RDP"

Researched against the vendor's own documentation (Gammadyne Mailer, Windows
desktop bulk mailer). It has two unrelated sending modes:

- **Relay mode** — three setup steps end with *"Specify the mail server that
  will relay the emails."* This is exactly our path. Point it at the broken
  relay above and it fails identically.
- **Direct Delivery** — a checkbox on the *Send/Delivery* branch. It resolves
  the RECIPIENT's MX, connects to that IP **on port 25**, and delivers with no
  relay and no credentials. Gammadyne's own docs concede the costs: a PTR is
  required, some domains refuse any IP on the **PBL** (which is "most IPs that
  are assigned dynamically or behind a residential gateway"), greylisting forces
  retries up to four hours, it **cannot be used through a VPN**, "only a web
  server can send email directly", and *"Gammadyne recommends against using
  Direct Delivery"* — the most reliable way, they say, is to relay through a
  server with a static IP.

So there are exactly two ways a desktop mailer appears to "just work":
it relays through a real mail service, or it Direct-Delivers from a
datacenter IP that has the PTR/PBL credentials a residential line lacks.

**Measured, from the two networks, to the real recipient MX:**

| Origin | `gmail-smtp-in.l.google.com:25` | `mx1.mail.yahoo.com:25` |
|---|---|---|
| Mac `105.112.11.167` (residential) | TCP connects, then **`read ECONNRESET`** — no banner | TCP connects, then **`read ECONNRESET`** |
| VPS `164.68.105.96` (datacenter) | **`220 mx.google.com ESMTP …` in ~300 ms** | no greeting |

This is the documented PBL/residential refusal, reproduced live. It settles the
open question: **the RDP was not incidental — it supplied an egress IP that
recipient MX servers will actually talk to.** And it is precisely the property
our own VPS already has, which is why `127.0.0.1:587` (Postfix + OpenDKIM) is
the RDP-equivalent, plus DKIM the desktop tool would also have needed.

**One caveat recorded honestly:** a reset before the SMTP banner can also be
injected by an ISP that blocks outbound port 25. Either way the operational
conclusion is identical — Direct Delivery from a residential line fails — so
the ambiguity does not change what we build.

## 2. What was built

Nothing about the sending path changed. What changed is that a customer can no
longer pick a wrong endpoint by hand:

- `lib/smtp-provider-presets.ts` — ten providers' published SMTP endpoints as
  **pure data** (Resend, Brevo, SendGrid, Mailgun, Postmark, Zoho, Google,
  Microsoft 365, Amazon SES, cPanel).
- The picker sits above **Host** and fills **host + port + security together**,
  because the send path derives the handshake from the **port**
  (`lib/mailer-send.ts`: 465 ⇒ implicit TLS, anything else ⇒ STARTTLS) and not
  from the label. A host with a mismatched port is the #1 cause of the
  "Test connection sits on Testing…" experience.
- `fixedUser` is set only where the provider mandates a literal login
  (Resend ⇒ `"resend"`, SendGrid ⇒ `"apikey"`). Everywhere else the login is the
  user's own address, and we do **not** invent one. A preset fills the username
  only when the field is still empty.
- Editing **Host** by hand drops the picker back to *Custom / self-hosted*, so
  the label never claims a provider whose endpoint is no longer filled in.
  Opening an existing mailbox recognises a provider from its **saved host** so
  the login hint is still shown — but an existing row's username is never
  overwritten.

Data lives in `lib/` rather than inside the React component specifically so the
coherence rule is testable. `tests/smtp-provider-presets.test.ts` pins three
things a preset can silently get wrong:

1. **Port agrees with the promised handshake** (the real guard).
2. **No preset offers `none`/unencrypted.** That mode is for self-hosted relays
   only and is the exact combination behind the accept-and-drop incident.
3. **No fabricated usernames** — `fixedUser` only for providers that mandate it,
   and never containing an `@`.

Proven to be a real guard by mutation: setting Resend to `587` + `implicit` fails
test 4 (5 pass / 1 fail), restored to 6/6.

## 3. Verification

- `test:presets` **6/6**; full suite **118/118**
  (deliverability 6, smtp 11, mailguard 10, domains 21, presets 6, devices 6,
  vantra 58); `tsc` clean; eslint clean
- Mutation check as above
- Deployed via a full-tree rsync + `scripts/deploy-vps.sh`, parity verified
  file-by-file against `/opt/spaceworker`
- Server scratch/debug scripts removed (`control-real-provider.ts`,
  `cleanup-spaceworker-domain.ts`, `relay-ip-trust.mjs`, `tmp-*.ts`)
- The earlier `spaceworker.top` platform-domain experiment is **fully removed**:
  `SigningTable` holds only `*@watsonandrade9382.ca.lu`, its key directory is
  intact, and the `SendingDomain` table is empty. We do not send customer mail
  as our own domain.

## 4. What we deliberately did NOT do

- **No VM/container isolation of the relay.** A VM on the same host has the same
  public IP, so the same SPF/PTR/reputation verdict — identical result. A VM on
  a different host is the exit-node idea, already deployed and already measured
  as byte-identical refusals (`550 Not allowed` from our IP, a US IP and a CA IP).
  There is no IP penalty to escape: `164.68.105.96` and `172.233.80.73` are both
  **clean on Spamhaus, SpamCop, Barracuda, SORBS and PSBL**, and Resend's own
  outbound IP carries a generic `ec2-…compute-1.amazonaws.com` PTR — so a
  matching PTR is not what makes a provider deliver.
- **No `PLATFORM_SENDING_DOMAIN`.** Left unset so the feature is inert by
  default. Note for whoever sets it later: `spaceworker.top` publishes **no SPF,
  no DKIM, no DMARC**, so it must not be used as-is; `instaweb.top` (Cloudflare
  zone, Resend-verified, already our transactional `EMAIL_FROM`) is the correct
  candidate, and any `ip4:` term must be **added** to its SPF, never substituted.

## 5. The line that matters for the business

A customer sending through a **commercial provider** needs **no DNS work from
us at all** — the provider authenticates the domain. A customer **self-hosting**
needs one-time SPF/DKIM/DMARC records for **their own** domain, in **their own**
DNS panel; that is how email works and it is not negotiable by any sender, ours
or Gammadyne's. The only real failure mode we can prevent is a customer handing
us a relay that never was a mail service — and the presets are how we prevent it.

