# TASK_140 — "will this mail actually be SIGNED?" + the shared platform sending domain

## The question this answers

> *"if I create an RDP on the server, I am sure this issue won't showcase… is
> there a way we can make the sender act like it's not on the server? but nothing
> can be done about the DNS record. I don't expect all their customers coming to
> give them different records to add. So there should be a way this is done on a
> shared server."*

Three separate things were tangled together in that. Untangled:

### 1. "Act like it's not on the server" — already fully achieved (for acceptance)

Done in TASK_137: our own Postfix relay on `127.0.0.1:587` sends from **our** IP.
The customer's broken shared box is entirely out of the path. Measured:

```
egress IP when the relay sends:  164.68.105.96   (ours)
```

The customer's server is no longer contacted for sending at all. Nothing further
is needed here, and no VM/RDP is involved.

### 2. An RDP/VM on the server would change NOTHING — and here is the proof

This is worth stating flatly because it is intuitive but wrong. DKIM verification
is a **DNS lookup keyed on the From domain**: the receiver reads `d=` out of the
signature, fetches `<selector>._domainkey.<that domain>` and checks the signature
against the public key there. **The verifier never learns where the message was
composed, or from what kind of session.** SPF is the same shape — the receiver
checks its own allow-list against the domain's *published IP list*.

So the axes are:

| Axis | Decided by | Changed by an RDP session? |
|---|---|---|
| DKIM | public key in the From domain's DNS | **No** — DNS only |
| SPF | IP list in the sending domain's DNS | **No** — DNS only |
| DMARC | alignment of the above | **No** |
| IP reputation | the sending IP's history | Slightly, and only if the egress IP changes. Same box ⇒ same IP. |

An RDP on the same host has the same egress IP, so it changes neither
authentication nor reputation. It cannot help.

### 3. "No DNS record from each customer" — SOLVED, by moving the DNS to a domain we own

A customer's From domain can only be authenticated by a record in *that* domain's
DNS. That part is not negotiable and no server-side change substitutes for it.
**But it does not have to be the customer's domain.** Authenticate a domain WE
own, once, and every customer can send as it, fully authenticated, with zero DNS
work of their own. That is exactly how a shared sending domain at
Resend/SendGrid/Mailgun behaves.


## What was built

### a) Signing coverage — the failure that looks like success

Found by probe, against the live relay: a message sent From a domain with no key
installed goes out with **no `DKIM-Signature` header at all**, and the relay still
answers `250 2.0.0 Ok`. Proven:

```
A. From @watsonandrade9382.ca.lu (key installed)
   DKIM-Signature: PRESENT   d=watsonandrade9382.ca.lu  s=sw
B. From @spaceworker.top (no key installed)
   DKIM-Signature: *** ABSENT — relay sent this UNSIGNED ***
```

Both were accepted identically. That silence is *why* this class of bug survives:
every existing check (server talks, server takes the envelope) passes while the
mail is spam-foldered on arrival.

So both test surfaces now report it. `evaluateSigningCoverage()`
(`lib/sending-domains.ts`, PURE, unit-tested) is surfaced by the pre-save test and
the stored-mailbox Test:

- `verified` — signed, and the published key matches ours
- `unverified` — signed, but DNS not verified yet (signature will not validate)
- `unsigned` — **no key installed; mail leaves bare** → red warning

Two decisions that are easy to get subtly wrong, both mutation-tested:

1. **Coverage keys on `installedOnRelay`, NOT `status`.** What the relay does is
   sign with a key **on disk**. A domain whose DNS is not verified yet is still
   *signed*. Collapsing the two states would tell a user to publish a record they
   have already published. Mutating the check to ignore `installedOnRelay` fails
   test 12.
2. **Domain matching is case-insensitive** because DNS is; a row stored
   `Acme.Com` must cover `x@acme.com` or we warn about a domain that IS signed.
   Mutating to a case-sensitive `Map` fails test 13.

The lookup (`lib/sending-domain-coverage.ts`) is a thin separate file so the
decision stays dependency-free and testable. It queries the caller's own domains
**and** the platform domain — which belongs to whichever operator account created
it, so scoping it to the caller's `userId` would report our own live domain as
unsigned and then recommend a domain we cannot honour.

### b) `PLATFORM_SENDING_DOMAIN` — the no-customer-DNS option

Optional, fail-soft, operator-set. When configured, the warning for an unsigned
From domain gains a real way forward:

> …or — if you cannot edit that domain's DNS — send as `@<platform domain>`,
> which this platform has already authenticated and needs no record from you.

Blank ⇒ behaviour is unchanged, and the warning falls back to the only honest
advice (publish the record).

This is the answer to the "shared server" ask: **one DNS edit by us, for all
customers — instead of one edit per customer.**


## What we already have — measured, not assumed

```
instaweb.top   NS: Cloudflare (iris/leland)      <-- WE control this zone
   SPF   : v=spf1 include:_spf.mx.cloudflare.net ~all
   DMARC : v=DMARC1; p=none; rua=mailto:rua@dmarc.brevo.com
   DKIM  : resend._domainkey.instaweb.top FOUND   <-- Resend-verified
   EMAIL_FROM = spaceworker@instaweb.top           (the platform's own sender)
```

So a domain we own is **already** Resend-verified and has DMARC. The platform is
already a Resend customer (`lib/email.ts`). Two independent routes to a shared,
authenticated sending domain therefore exist, and **both are one-time**:

| Route | What to publish (once, by us) | Customer DNS work | Reputation |
|---|---|---|---|
| Our relay, our domain | add `ip4:164.68.105.96` to `instaweb.top` SPF **additively**; publish our `sw._domainkey` key; install it on the relay | **none** | our IP (cold) |
| Resend, our domain | already done (`resend._domainkey` + DMARC) | **none** | Resend's shared, pre-warmed IPs |

### The one edit, stated exactly

```
instaweb.top   TXT  "v=spf1 include:_spf.mx.cloudflare.net ip4:164.68.105.96 ~all"
```

**ADD the `ip4:` term — never replace the record.** The existing
`include:_spf.mx.cloudflare.net` carries the platform's own transactional mail
(signup/verification codes). Clobbering it would break logins. This is deliberately
left for the operator: it is the platform's live mail domain, not a sandbox.

⚠ Note `spaceworker.top` publishes **no SPF, no DKIM and no DMARC at all** (verified
by query). If `PLATFORM_SENDING_DOMAIN` is pointed at `spaceworker.top`, those
three records must be published first — pointing it at an unauthenticated domain
would produce exactly the silent unsigned send this task exists to expose.

## Verification

- `npm run test:domains` — **16/16** (7 pre-existing + 9 new), local and on the VPS
- **Two mutations, both caught then restored** (see a/1 and a/2 above)
- Full suite green: deliverability 6, smtp 11, mailguard 10, devices 6, domains 16
- `tsc --noEmit` clean; `eslint` exit 0 on all six files
- `CI=true npm run build` → `EXIT=0`
- Live relay probes: auth accepted; egress `164.68.105.96`; **message A signed,
  message B unsigned** — the exact behaviour this task makes visible

## What is NOT done here (deliberately)

The DNS edit above is the operator's call, not a code change — it touches the
platform's live mail domain. The software side is complete: once
`PLATFORM_SENDING_DOMAIN` is set and its records are published, every user sending
from a domain they cannot edit gets a working, authenticated alternative with no
action of their own.
