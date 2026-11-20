# TASK 136 — Mailbox "Connection OK" that cannot send (envelope verdict)

**Status:** fixed, tested, deployed
**Date:** 2026-09-28
**Owner report:** *"I tested the same campaign with that SMTP but it didn't deliver. The mailbox test says `✓ Connection OK` … is this okay, or is there still something missing?"*

## The report, and why it was true

The customer's relay (`watsonandrade9382.ca.lu`, a Python `aiosmtpd` server on
their own host) passed **every** check SpaceWorker had, and delivered nothing.
Reproduced against the live server during this task:

```
port 25   banner "220 localhost Python SMTP 1.4.6"
          EHLO capabilities: SIZE / 8BITMIME / SMTPUTF8 / HELP
          — no AUTH, no STARTTLS
          MAIL FROM:<fleming@…>   -> 250 OK
          RCPT TO:<fleming@…>     -> 550 Not allowed      <-- its OWN address
          RCPT TO:<postmaster@example.com> -> 550 Not allowed
```

`nodemailer.verify()` stops at EHLO (plus AUTH *when advertised*), so it never
sees that `550`. It returned `true`. The panel showed a green tick, the campaign
"completed", and the mail was refused at the envelope — not delivered, not even
to spam. Verified from the VPS, where port 25 answers (it is blocked from the
dev Mac, so all port-25 evidence in this task is VPS-side).

**Conclusion: the mailbox was reported healthy while being incapable of sending.
Nothing about the mailbox form could have fixed it — the refusal is the relay's
own policy about who may send through it (`550 Not allowed`, for its own address
too). The server side must change.**

## What was built

`probeEnvelope()` in `lib/smtp-diagnostics.ts` — offers a real envelope and reads
the server's own answer, then `describeEnvelopeRefusal()` turns a refusal into a
sentence naming the cause. Wired into both test routes:

| Route | Behaviour |
| --- | --- |
| `POST /api/mailboxes/test-connection` | pre-save; `ok:false` + server's reply when refused |
| `POST /api/mailboxes/[id]/test` | stored mailbox; records `lastTestOk=false` |

### The safety property that makes it usable behind a button

It issues `MAIL FROM` → `RCPT TO` → **`RSET`**. **`DATA` is never sent**, so no
message can ever be transmitted to a real recipient from a diagnostics screen.
`tests/smtp-envelope-probe.test.ts` asserts this after every conversation, and the
guard was proven live: patching `RSET` → `DATA` fails 4 tests, restoring passes 11.

## The bug this task nearly shipped (caught by a control, not by a test)

The first draft connected, skipped STARTTLS, skipped AUTH, and offered the
envelope. A control run against `smtp.gmail.com:587` returned:

```
530 5.7.0 Must issue a STARTTLS command first
```

…which the code reported as **"this mailbox cannot send"**. That is a *correct*
answer to a plaintext question: every normal 587 provider would have been
condemned. Same class of false positive for `530 Authentication required` on any
server that wants a login before `MAIL FROM`.

Fixed two ways, both required:

1. **The probe now speaks the full send conversation** — EHLO → STARTTLS → EHLO →
   AUTH (PLAIN/LOGIN) → envelope — so its session is equivalent to a real send.
2. **`describeEnvelopeRefusal` refuses to speak when the session wasn't
   equivalent**: a refusal that mentions STARTTLS while `!usedTls`, or demands
   authentication while `!authenticated`, returns `undefined` (inconclusive).
   `verify()` owns those questions; this probe may not answer them.

Live controls after the fix (both clean, no false positive):

```
smtp.gmail.com:587  usedTls=true  AUTH rejected (535, wrong password) -> inconclusive
smtp.gmail.com:465  usedTls=true  AUTH rejected (535)                 -> inconclusive
```

Also fixed while here: relay replies were rendered doubled — `"550 550 Not
allowed"` — because servers repeat their code inside the text
(`formatSmtpReply()` + its own test).

## Verified

- **Live, VPS, port 25** → `refused=true at=RCPT TO reply=550 "550 Not allowed"`
  with the panel message naming the relay-side cause. Port 24610 → AUTH rejected
  `542 Internal server error` → inconclusive (never a false verdict).
- 11/11 `npm run test:smtp`; 6/6 `test:deliverability`; 6/6 `test:devices`;
  58/58 `test:vantra`; `tsc --noEmit` clean; eslint clean; `npm run build` exit 0.
- Parity: full-tree deploy, md5 verified against the local checkout.

## Not fixed here (needs the relay owner)

The relay must accept AUTH (or the senders/IPs it trusts) before this mailbox can
send. Its AUTH is also unreachable by design: it replies
`538 5.7.11 Encryption required for requested authentication mechanism` while
advertising no STARTTLS on any port — there is no transport on which its AUTH
could succeed. It also refuses its own address, and SPF for
`watsonandrade9382.ca.lu` is absent while egress is Contabo IPv6 with a mismatched
PTR. See TASK_135 for the related mailbox triage.
