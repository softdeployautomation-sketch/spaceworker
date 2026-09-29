# TASK_143 — The capability probe lied about a mail server that sends perfectly

**Status:** done, deployed, verified
**Touches:** `lib/smtp-diagnostics.ts`, `app/api/mailboxes/test-connection/route.ts`,
`app/api/mailboxes/[id]/test/route.ts`, `components/mailboxes-panel.tsx`,
`lib/smtp-provider-presets.ts`, `tests/smtp-capability-probe.test.ts` (new),
`tests/smtp-provider-presets.test.ts`

---

## 1. What the customer reported

They added a **working** mailbox and were told it was broken:

```
Heads-up: this server did not ask for a username or password at all
(it advertises no AUTH), so your credentials were never actually checked.
Server says: 220 wes1-so1.wedos.net ESMTP Postfix
Authentication: NOT offered — your password isn't checked on this port · STARTTLS: offered
Send test (MAIL FROM/RCPT TO, cancelled before any message): the server accepted it
```

Same credentials, same host, same port, **same screen**: the envelope probe said the
server accepted the mail while the capability probe said the password was ignored.
One of them had to be wrong, and the customer was explicit that Gammadyne had
already delivered to a real Comcast inbox with this exact mailbox — so they were
right to push back.

## 2. Root cause: AUTH is not advertised before encryption

Measured live, from the same machine, with the customer's own credentials:

```
smtp-184101.m1.wedos.net:587
  EHLO (plaintext) AUTH lines: *** NONE ***
  STARTTLS: 220 2.0.0 Ready to start TLS
  EHLO (after STARTTLS) AUTH lines: ["AUTH PLAIN LOGIN"]
  AUTH: 235 2.7.0 Authentication successful
```

A submission server is **required** to withhold its AUTH list until the channel is
encrypted (RFC 4954 §4, RFC 3207). The capability probe was reading AUTH from the
**plaintext** EHLO and treating that as the whole truth — so it reported "no AUTH"
for the *most common server shape on the internet*. `smtp.gmail.com:587` behaves
identically (plaintext: none; post-TLS: `AUTH PLAIN LOGIN …`), which is the tell
that this was never provider-specific.

The envelope probe, meanwhile, had **always** spoken the correct order
(EHLO → STARTTLS → EHLO → AUTH) — which is exactly why the two surfaces
contradicted each other on one screen.

## 3. The fix

**`probeSmtpCapabilities`** now does what a real send does:

1. EHLO in the clear, recording `starttlsAdvertised` **before** any upgrade (a server
   does not re-advertise STARTTLS once encrypted — reading it later would report
   "STARTTLS: not offered" for a server we just used STARTTLS on).
2. If STARTTLS is offered, upgrade and re-issue EHLO; the capability list — and
   therefore `authMechanisms` — becomes the post-encryption one.
3. A failed upgrade is **not** a verdict: fall back to the plaintext list and leave
   `starttlsUpgraded: false`, which the UI reads as "we could not see past the
   encryption".

Two new fields carry the distinction into the UI: `authAdvertisedBeforeTls` and
`starttlsUpgraded`.

**`capabilityWarning()`** moved out of the route handler into `lib/smtp-diagnostics.ts`
(two copies of a warning string is how the two test surfaces drift, and they already
had) and now has **three** cases instead of one:

| Case | Message | Why |
|---|---|---|
| encrypted, still no AUTH | "…offered no way to log in (no AUTH, even after STARTTLS)…" | the finding is now about an **encrypted** session — earned |
| STARTTLS offered, upgrade failed | "…we could not confirm whether your password is used…" | we genuinely do not know; saying "not offered" is a guess dressed as a finding |
| no STARTTLS, no AUTH | the original accept-and-drop warning | the real customer relay on port 25 — still correct, still shown |

## 4. Evidence that the send path was never broken

Through **our own transport** (`lib/mailer-send.ts` → nodemailer — md5-identical to
the deployed file `4a9dae6c58adcb1b2093279fd590acb5`), from the VPS, with the same
WEDOS credentials:

```
Sending via OUR transport -> smtp-184101.m1.WEDOS.net:587
  accepted : ["typple6@comcast.net"]
  rejected : []
  response : 250 2.0.0 Ok: queued as 4hv8jQ5G6kzBpk
  elapsed  : 789ms
```

**Zero rejects, sub-second.** So nothing was wrong with the mailbox, the transport,
the port, or the credentials. The only wrong thing in the chain was our warning —
which is why this task changes a *message* and a *probe*, not the send path.

## 5. The preset gap this exposed

The customer asked for this shape to be available in the preset picker. Two entries
were added, because the shape that works had no preset at all:

| Preset | Host | Port | Mode |
|---|---|---|---|
| **WEDOS** | `wes1-smtp.wedos.net` | 587 | STARTTLS |
| **Other provider — standard 587 (STARTTLS)** | *(user replaces)* | 587 | STARTTLS |

Before this, the only shared-hosting entry offered **465 + implicit**, so a
hosting-company mailbox on the standard submission port had to be hand-typed.

**On the WEDOS host:** WEDOS gives each hosting account its own submission host
(`smtp-<id>.m1.wedos.net`) — account-specific, so naming it in a preset would be
wrong for everyone else. `wes1-smtp.wedos.net` is the shared cluster host and was
verified to accept the same login (`235 2.7.0 Authentication successful`). The note
tells anyone who *was* given a per-account host to keep it. No `fixedUser`: WEDOS
authenticates the mailbox's own address.

`"Custom / self-hosted — fill the fields below yourself"` remains the default option,
so the plain "type your own host/port/user/password" path is unchanged.

## 6. Verification

- `test:smtpcap` (**new**, 7 tests) — a fake server that **hides AUTH until
  STARTTLS**, plus real implicit-TLS and broken-handshake variants.
- Full suite **143/143** (6 deliverability + 11 smtp + 7 smtpcap + 10 mailguard +
  37 domains + 8 presets + 6 devices + 58 vantra). `tsc` clean, eslint clean.
- **Mutations, each caught then restored:**
  - capability probe STARTTLS upgrade disabled → **4 of 7 smtpcap fail**, while the
    genuine accept-and-drop case *still passes* (the suite separates the two rather
    than blanket-failing).
  - both historical defects reconstructed (no upgrade + the old single-case warning)
    → reproduced the customer's message **character for character**:
    *"Heads up: this server did not ask for a username or password at all…"*
  - WEDOS preset port changed 587 → 465 → **3 preset tests fail**.
- **Live, after the fix** (real servers, not fakes). The controls were chosen so no
  single behaviour can be hardcoded: Gmail withholds AUTH until encrypted, Brevo
  advertises it in the clear, implicit TLS never upgrades at all, and the broken
  relay must STILL warn.

  | Server | AUTH before TLS | AUTH after TLS | panel warning |
  |---|---|---|---|
  | `smtp-184101.m1.WEDOS.net:587` (customer's) | false | **true** `PLAIN,LOGIN` | *none* |
  | `wes1-smtp.wedos.net:587` (preset host) | false | **true** `PLAIN,LOGIN` | *none* |
  | `smtp.gmail.com:587` | false | **true** | *none* |
  | `smtp.gmail.com:465` (implicit TLS) | n/a | **true** from first EHLO | *none* |
  | `smtp-relay.brevo.com:587` | **true** (advertises in clear) | **true** | *none* |
  | `watsonandrade9382.ca.lu:25` (genuinely broken) | false | false | **warns** ✅ |

- **The regression itself, measured on the deployed build** — the same hosts through
  the *pre-fix* probe, with the old `!reachable || authAdvertised` rule replayed:

  | Server | deployed `authAdvertised` | old verdict |
  |---|---|---|
  | `smtp-184101.m1.WEDOS.net:587` | false | **YES (FALSE ALARM)** |
  | `smtp.gmail.com:587` | false | **YES (FALSE ALARM)** |
  | `watsonandrade9382.ca.lu:25` | false | YES (correct, but for the wrong reason) |

  The old rule could not tell Gmail from a broken relay: it printed the *same*
  "your password isn't checked" sentence for both. That is the entire class of bug,
  and it is why the fix is measured by the negative control as much as the positives.

- End-to-end send from the deployed server to a real Comcast address: accepted,
  739 ms (`250 2.0.0 Ok: queued as 4hv8xJ151YzBj1`), and **the customer confirmed the
  message arrived in the INBOX, not spam**. Corroborated independently: the sender's
  own mailbox (read over IMAP, `wes1-imap.wedos.net:993`) was **empty** afterwards —
  no bounce — which rules out "accepted then bounced" as well as "silently dropped".

## 7. The lesson worth keeping

**A probe that reads a capability from the wrong phase of the conversation will
confidently accuse a correct server.** The envelope probe and the capability probe
disagreed *on one screen* for months because one spoke the real protocol order and
the other took a shortcut — and the shortcut happened to be wrong for nearly every
real provider. When two detectors contradict each other, the bug is at least as
likely to be in the detector as in the subject; here it was entirely in the detector.

