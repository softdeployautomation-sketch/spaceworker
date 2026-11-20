# TASK_142 — A DKIM verdict that is DEFINITIVE, and a preset for our own relay

**Status:** done, deployed, verified
**Touches:** `lib/sending-domain-coverage.ts`, `lib/sending-domains.ts`,
`lib/smtp-provider-presets.ts`, `components/mailboxes-panel.tsx`,
`tests/sending-domains.test.ts`, `tests/smtp-provider-presets.test.ts`

---

## 1. Why this task exists

Two requests, both from a real support conversation:

1. The DKIM notice said *"…whether that signature validates is **unknown**"*. That
   is true but useless, and it is not the strongest thing we can say. We hold the
   signing key, so we know the exact record name the receiver will fetch; asking
   DNS for that name turns "unknown" into a definite answer either way.
2. There was no preset for the relay this platform runs on its own machine, so
   every operator had to be told the host, port, security mode and — the part that
   caused a real question — **where the password comes from**.

---

## 2. The DKIM half: signed is not the same as authenticated

This is the fact the whole task turns on, and it is worth stating plainly because
it is counter-intuitive and we generated support questions by not stating it:

| Half | Who does it | Can we affect it? |
|---|---|---|
| **Applying** the signature | the sending server — our relay, Brevo, Resend, Gammadyne | **Yes.** Our relay signs with `sw._domainkey.<domain>`. |
| **Validating** the signature | the **receiver**, which fetches `<selector>._domainkey.<FromDomain>` from **DNS** and checks the maths against the published public key | **Never.** That key sits in the From domain's DNS zone, which is not ours. |

A sender can therefore sign perfectly and still fail authentication, and **no
sending software can fix that** — Brevo/Resend/SendGrid/Gammadyne are all in the
same position, which is why they all hand you the same "add these DNS records"
screen. For `watsonandrade9382.ca.lu` the receiver will look up
`sw._domainkey.watsonandrade9382.ca.lu`, and that name does not exist:

```
sw._domainkey.watsonandrade9382.ca.lu   ->  (NO RECORD)
_domainkey.watsonandrade9382.ca.lu      ->  (NO RECORD)   no selector can exist
```

So the signature **will fail**, and the previous "unknown" understated a fact we
can prove.

### 2a. The false-accusation rule (the part that must not regress)

Turning "unknown" into a definite verdict is only safe if the *definite* case is
reserved for answers that really are definite:

| Resolver answer | Meaning | Verdict |
|---|---|---|
| `ENOTFOUND` / `ENODATA` | the name genuinely does not exist | **`missing`** — a real failure, with a call to action |
| any other error (`SERVFAIL`, refused) | the resolver did not answer | **`unknown`** — say nothing |
| timeout (raced at 2.5 s) | the resolver did not answer | **`unknown`** — say nothing |
| TXT exists but carries no `p=` | nothing to verify with | **`missing`** — "present" would promise a check that cannot happen |
| TXT exists, `p=` matches ours | confirmed | **`verified`** |
| TXT exists, `p=` is different | a DKIM record exists and is useless to us | **`mismatch`** |

Conflating the first two rows is the whole hazard: it would send a user to
re-publish a record that may already be correct and live. That is why the rows are
pinned separately, at the DNS layer, in this task.

### 2b. What the user now sees

- **`verified`** (a live lookup found OUR key) → green `✓`.
- **`missing` / `mismatch`** (we looked, the key is not usable) → **red** warning
  naming the exact record to publish, and *"the signature will FAIL verification
  and receivers will treat the mail as unsigned"*.
- **`unknown`** (we could not answer, or could not compare) → amber `⚠`, because
  "could not confirm" is not "confirmed", and a green tick over an unconfirmed
  signature is the same class of lie the warning path exists to prevent.
- **unsigned** (no key on the relay) → unchanged.

---

## 3. The preset half

`lib/smtp-provider-presets.ts` gained one entry:

```
id: "relay"   label: "This server's relay (local)"
host: 127.0.0.1   port: 587   security: none   internal: true
```

Two deliberate decisions:

- **No `fixedUser`.** The relay's login realm is whatever the operator set when
  they installed it, so inventing a username here would produce a certain auth
  failure on someone else's deployment. The note says what to ask for instead.
- **`internal: true`, so the unencrypted exemption stays exactly one entry wide.**
  The rule "no preset may use `none`" now reads "no *commercial* preset may use
  `none`" — the loopback relay is the one case where `none` is correct rather than
  a mistake, because nothing off-box can reach it. A test pins the exemption to one
  entry so it cannot spread.

The note also answers the question that was actually asked — where the password
lives (`/etc/sasldb2`, hashed, therefore it cannot be shown back and must be pasted
once).

---

## 4. Verification

- `test:domains` **37/37** (was 21)
- `test:presets` **7/7** (was 6)
- Full suite **135/135** — 6 deliverability + 11 smtp + 10 mailguard + 37 domains
  + 7 presets + 6 devices + 58 vantra
- `tsc` clean, `eslint` clean, CI build exits 0
- **7 mutations applied to the real source, all 7 caught, source restored
  byte-for-byte:**

| # | Mutation | Caught by |
|---|---|---|
| M1 | `missing` no longer treated as a definite failure | test:domains #22, #27, #28 |
| M2 | a resolver **timeout** becomes `missing` | test:domains #34 |
| M3 | **SERVFAIL** becomes `missing` | test:domains #33 |
| M4 | `dkimRecordStates` no longer case-normalised | test:domains #27 |
| M5 | `unpublished` dropped from the roll-up warning | test:domains #22, #23, #28 |
| M6 | the exact record name dropped from the warning | test:domains #22, #23, #27 |
| M7 | relay preset loses its `internal` marker | test:presets #3, #4 |

### 4a. The two traps this task hit

**The require hook silently matched nothing.** Its condition was written as
`from.endsWith("/lib/sending-domain-coverage")` — without the `.ts` that every
required filename actually has — so the module under test imported the **real**
resolver, and three of the new tests still passed, because a real NXDOMAIN for a
nonexistent name produces the same `"missing"` verdict the stub would have. It was
revealed only by assertions whose expected values exist **only** in the stub table
(a chunked 2048-bit key, a non-default selector). Fixed by listing consumers with
their real extension (`DNS_CONSUMERS`), and recorded in `HOW_WE_MOVE_FAST` §6.

**A shallow "chunked key" check would have passed while proving nothing.** The
rejoined-chunks test asserts `verified`, and the stub did return the real chunking
shape — but that assertion also passes for database reasons alone, so on its own
it says nothing about the joiner. Rather than claim coverage it does not have, the
joiner's behaviour was proven directly against the real relay (section 5) and the
test kept for what it genuinely pins: the `p=` comparison and the chunked
round-trip.

---

## 5. Live verification on the deployed box

Run against real DNS, the real relay tables and the real database — not a stub.

### 5a. The lookup, on real names (9/9)

```
--- live lookup: sw._domainkey.watsonandrade9382.ca.lu
ok   a domain whose key is provably absent is reported DEFINITE, not unknown
ok   the published record name is built by the same helper the lookup uses
--- live chunked key: s1._domainkey.sendgrid.net (p= 392 chars, >255 so chunked)
ok   a real chunked key at s1._domainkey.sendgrid.net is REJOINED and compares verified
ok   the same record with no known key is "present", never a fault
ok   a key that is not ours is "mismatch"
ok   at least one live published key was long enough to exercise the joiner
ok   an unresolvable name is definite (missing) or unknown, never a crash
--- relay SigningTable domains: ["sw._domainkey.watsonandrade9382.ca.lu"]
ok   the relay signs the customer domain in the conversation
ok   no customer domain was swapped out for our own (no spaceworker.top signing)
```

**The first run of this script FAILED**, and that failure is the interesting part:
it reported `no live chunked key found — the joiner was NOT proven by this run`.
The candidate names I had picked (`resend._domainkey.*`, `google._domainkey.gmail.com`)
all publish a **216-char** `p=`, which fits in a single 255-byte chunk — so they
never exercise the rejoin at all, and the check was honest enough to say so rather
than pass vacuously. Finding a real chunked key meant scanning published keys for a
`p=` over 255 bytes:

```
CHUNKED  p= 392  chunks=2  s1._domainkey.sendgrid.net      <- used
CHUNKED  p= 392  chunks=2  k2._domainkey.mailchimp.com
CHUNKED  p= 392  chunks=2  s1._domainkey.github.com
single   p= 216  chunks=1  resend._domainkey.instaweb.top   <- proves nothing
single   p= 216  chunks=1  selector2._domainkey.microsoft.com
```

### 5b. What the user now sees (the point of the task)

`signingCoverageFor()` — the exact function the Test-connection route calls — run
against the real `blast1` row:

```
=== mailbox "blast1"
    From: ["fleming@watsonandrade9382.ca.lu"]
    [unpublished] Mail from @watsonandrade9382.ca.lu IS signed by the relay, but no
      public key is published at sw._domainkey.watsonandrade9382.ca.lu — so the
      signature will FAIL verification and receivers will treat the mail as unsigned.
      Add @watsonandrade9382.ca.lu on the Sending domains tab to get the exact
      record to publish
    warning: These domains are signed but their DKIM key cannot validate —
      @watsonandrade9382.ca.lu: no public key is published at
      sw._domainkey.watsonandrade9382.ca.lu. ...
```

Before this task that same mailbox said *"whether that signature validates is
**unknown**"*. It is now a definite verdict carrying the exact record to publish.

### 5c. Both features are in the shipped bundle

```
"This server's relay (local)"  -> .next/static/chunks/3waohonlceoae.js   (client)
"Sending domains tab"          -> .next/server/chunks/[root-of-the-server]__*.js
```

---

## 6. A deploy defect this task exposed (fixed here)

The deploy of this task **aborted at preflight** with:

```
MISSING .next   <- deploy destroyed runtime state
FAIL: server-only runtime incomplete - recover before restarting.
```

Nothing had been destroyed — `.next`, `BUILD_ID`, the service and HTTP 200 were all
intact. The truth was in the line above it:

```
ssh: connect to host 164.68.105.96 port 22: Operation timed out
```

Two defects, both about a network blip being reported as a local fact:

1. **`run_remote` had no `ConnectTimeout` and no keepalives.** A single dropped
   packet left ssh waiting on the OS TCP timeout, so every probe beneath it returned
   a wrong answer instead of no answer — and `verify_runtime` reads a non-zero probe
   as "the path is gone". The message then sends the operator to *recover* a server
   that is perfectly healthy, which is how a blip turns into an outage.
   Now `-o ConnectTimeout=15 -o ServerAliveInterval=10 -o ServerAliveCountMax=3`.

2. **`verify_runtime` probed each path over its own connection.** One blip could
   therefore produce a partial, nonsensical picture (`ok .env`, `MISSING .next`,
   `ok node_modules`) that reads as corruption rather than as a flaky link. It now
   asserts reachability first (a nonce echo, so a half-open connection producing no
   output cannot pass) and then probes every path over **one** connection, reporting
   "runtime state is UNKNOWN — re-run with --verify-only" when the host stops
   answering mid-check.

A third, smaller false alarm was fixed at the same time: the exit sentinel added by
TASK_140 (`never reached '-- done' but exited 0`) fired on the two legitimate early
exits, `--verify-only` and `--maintenance-off`, which had no build to run. Both now
mark `DEPLOY_COMPLETE=1`.

Proof, without touching the real box — `VPS_HOST` is overridable:

```
$ time VPS_HOST=root@127.0.0.1 bash scripts/deploy-vps.sh /tmp/deploy142.txt
-- preflight
REFUSED: root@127.0.0.1 did not answer over ssh (timeout or dropped link).
NOTHING WAS CHANGED and nothing is broken - this is a network blip, not a
deploy failure. Re-run the same command. Do NOT 'recover' the server.
0.042 total

$ bash scripts/deploy-vps.sh /tmp/deploy142.txt --verify-only
   ok      .env
   ok      .next
   ok      node_modules
   ok      static/maintenance.html
active
http:200
-- verify-only done          <- no false "ABORTED"
```

Re-running the same deploy against the real host then completed normally:

```
-- rsync
-- prisma generate (as trmm)
… 102 routes …
-- restart + verify
active
   localhost:3500/ -> 200
-- asserting server-only runtime survived
   ok      .env / .next / node_modules / static/maintenance.html
-- maintenance OFF
-- done
```

---

## 7. Outcome

- The Postfix relay on the platform box (TASK_137) remains the sending path, **not**
  the customer's broken third-party relay: nothing off-box is required to send.
- DKIM status is now a definite, actionable verdict rather than "unknown", and the
  one thing only a domain owner can supply — the public key in **their** DNS — is
  named exactly, with the record to publish.
- Our own relay is selectable as a preset, so an operator no longer has to be told
  its host, port, security mode or where its password lives.
- The mail the platform signs for a customer is not, and will not be, sent as our
  own domain: `PLATFORM_SENDING_DOMAIN` stays unset until there is a reason.


