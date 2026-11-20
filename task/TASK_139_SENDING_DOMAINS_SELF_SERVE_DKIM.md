# TASK 139 — Sending domains: self-serve DKIM, so we stop depending on anyone's server

**Status:** built, tested, deployed
**Date:** 2026-09-28
**Owner ask:** *"we dont have access to the box, and nothing can be done about the server,
we just have to do it our way… cant depend on what the server does, that can take very
long."*

## The dependency TASK_137 removed, and the one it could not

TASK_137 removed the dependency on a customer's own SMTP server for **ACCEPTING** mail:
our own relay (Postfix on `127.0.0.1:587` + OpenDKIM on the VPS) takes the message
whatever state their server is in.

It could not remove the dependency on the **From domain's DNS** for **AUTHENTICATING** it.
That is not a design choice — DKIM works by the *receiver* fetching a public key from the
domain's DNS and checking our signature against it. If the key isn't published, the
signature can't verify, and Gmail/Yahoo drop or spam the mail. Resend, SendGrid and
Mailgun all require the same one-time DNS edit.

So the remaining problem was purely **usability**: a customer had to generate a keypair,
publish the right TXT value without breaking it, and know whether it worked. This task
makes that self-serve.

## What was built

| Piece | Where |
|---|---|
| Keypair + record generation + DNS verification + relay table merge | `lib/sending-domains.ts` |
| Never-select-the-private-key projection | `lib/sending-domain-select.ts` |
| List / add / remove / verify endpoints | `app/api/sending-domains/**` |
| UI (sits with Mailboxes, under the same tab) | `components/sending-domains-panel.tsx` |
| Storage | `SendingDomain` model + migration `20261018000000_sending_domains` |
| Regression tests | `tests/sending-domains.test.ts` (`npm run test:domains`) |

Flow: **Add a domain** → the server generates a 2048-bit RSA keypair, installs the private
key into OpenDKIM's KeyTable/SigningTable, and hands back the three TXT records to publish.
**Verify** re-installs the key if it isn't installed yet and then checks DNS.

### Two design decisions worth keeping

- **The row is created BEFORE the relay install is attempted.** A half-failed install must
  never lose the keypair — the customer may already have published the matching record, and
  a retry that generated a *new* key would invalidate the record they just added. `Verify`
  is the retry path for exactly this reason.
- **`verified` means the whole chain, not just DNS.** A perfect DNS answer with no key on
  the relay signs nothing, so `verified = dns.ok && installed`. A green tick over mail that
  still lands in spam is worse than no tick.

### Verification compares the key, not its existence

DKIM verification fetches `<selector>._domainkey.<domain>` and requires the published `p=`
value to equal the `p=` of the key we sign with. A stale or rotated record fails DKIM
*identically* to nothing being published, so "the record exists" would be a false green
tick. `npm run test:domains` pins it — mutate the comparison to an existence check and the
test fails.

## The trap this feature had to avoid

OpenDKIM's `KeyTable`/`SigningTable` under `/etc/opendkim/` are **shared by every tenant**.
Regenerating them from only the domain being added would silently stop DKIM signing for
every other customer's domain: no error, no log, mail just starts landing in spam.
`upsertTableLine`/`removeTableLine` take the existing file contents and merge. The test
suite proves it by mutation (overwrite ⇒ test fails).

Domains are also unique across accounts at the *relay* level: two accounts registering the
same domain would make one overwrite the other's signing entry and break DKIM for both, so
the second registration is refused with an explanation (and a subdomain suggested).

## Two lessons recorded in HOW_WE_MOVE_FAST §6

1. **A `require`-hook stub must return methods at the TOP LEVEL.** Because the module does
   `import dns from "node:dns/promises"`, esbuild's CJS interop sets `.default` to the whole
   module object — so a stub shaped `{ default: { resolveTxt } }` left `dns.resolveTxt`
   undefined. `txtRecords()` correctly wraps its lookup in `catch {}` (ENOTFOUND = "nothing
   published"), which **swallowed the TypeError** and made every lookup answer "no record".
   The suite ran green against a stub that never worked. This is why the tests were
   mutation-checked rather than trusted.
2. **`scripts/deploy-vps.sh` does not run `prisma migrate deploy`** (only `prisma generate`).
   And replaying this repo's history onto an empty DB fails at `20260914150000` for reasons
   unrelated to any new migration. Validate a new migration by cloning production's schema
   **plus its `_prisma_migrations` rows** into a scratch DB and deploying there — that is the
   only shape that matches production.

## Verification

- `npm run test:domains` — 7/7; mutation-checked: existence-only DKIM ⇒ fails; overwrite
  instead of merge ⇒ fails. Also re-run **on the VPS against the deployed code**: 7/7.
- All other suites green: deliverability 6/6, smtp 11/11, mailguard 10/10, devices 6/6,
  vantra 58/58.
- `npx tsc --noEmit -p .` clean; eslint clean on every file touched.
- Production build `EXIT=0`; deploy `EXIT=0`; service `active`; public HTTPS 200; local 200;
  maintenance flag absent.
- **Migration applied to production** (ledger 69 → 70) after being proven against a scratch
  clone of the production schema. Table + both indexes + FK confirmed,
  `spaceworker` never written to by the scratch check.
- **§6b drift check is `-- This is an empty migration.`** — the live DB matches the
  datamodel exactly, zero drift.
- **Full-tree parity: 429/429 files md5-matched**, 0 missing, 0 stale, 0 extra.
- **Live E2E on the VPS against the real deployed routes — 41/41** (`HOW_WE_MOVE_FAST` §4),
  with a real session cookie and self-cleaning throwaway data. What it proved beyond the
  unit tests:
  - the relay install works **from the web process** (sudo + `/etc/opendkim` writes + reload)
  - **the key we INSTALL is the key we hand the customer to PUBLISH** (compared on disk
    against the returned `publicKeyTxt`) — the silent failure that makes DKIM fail while
    every log looks fine
  - `DELETE` removes the row, the key directory and both table entries; and after an
    add/delete cycle the **pre-existing customer key (`watsonandrade9382.ca.lu`) was still
    intact**, which is the merge invariant proven live rather than only in a unit test
  - unauthenticated `GET` is 401; a duplicate is 409; an invalid domain is 400; and
    `verify` reports `invalid` (never `verified`) when DNS is unpublished

## Operator action taken

`SENDING_RELAY_IPV4=164.68.105.96` was appended to `/opt/spaceworker/.env` (measured via
`curl -4 https://ifconfig.me`), with `SENDING_RELAY_IPV6=` left **empty** because this box
has no IPv6 egress at all (`curl -6` fails). Publishing an `ip6:` entry for an address a
receiver never sees would make SPF *fail* for our own mail — the opposite of the point.
The service was restarted to pick it up.

`SENDING_RELAY_IPV4` / `SENDING_RELAY_IPV6` — the addresses receivers actually see. Left
blank, DKIM still verifies; the SPF check reports "not configured" rather than guessing,
because publishing an SPF record that names the wrong address is worse than publishing
none. These are operator-set rather than auto-detected: the egress address can differ from
the box's primary one (NAT, proxy, second uplink).
