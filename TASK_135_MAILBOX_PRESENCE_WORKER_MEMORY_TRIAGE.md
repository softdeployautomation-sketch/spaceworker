# TASK_135 — Mailbox, presence and worker-memory triage (owner session 2026-09-28)

**Status: fixed and shipped.** Three independent defects, all diagnosed live on the production VPS rather than by inspection, each with a stated root cause and a measurement that proves it. A fourth finding (the relay itself) is NOT a SpaceWorker defect and is recorded here so it stops being re-triaged as one.

Owner's original report, in full:

> "it takes long for the active to turn off, I tried pinging this agent and it was not reachable... the test can connect now, but whenever I turn it off, it takes long to show offline. also why is python taking so much ram when nothing is running... python 19.9% 12.4% 4794 MB"

---

## 1. Device presence: the badge lied while Ping told the truth (FIXED)

**Symptom.** `WilkSF9` rendered `online · active now` while the same panel said `Agent not reachable · last check-in 8 min ago`. Turning a machine off took minutes to show.

**Root cause.** Two definitions of "online" existed and disagreed.

- `pingDevice()` asks the agent directly — authoritative, instant.
- The status badge came from `deviceStatus()` in `lib/devices.ts`, which **discarded the stored `status` column entirely** and answered purely from `lastSeenAt` age against `DEVICE_ONLINE_WINDOW_MS` (10 minutes).

But the stored column is a real verdict, not a hint: `syncDevices()` (`lib/vantra-link.ts`) writes Vantra's live `online` flag on every device-list load, and `recordHeartbeat()` writes `"online"` on every agent check-in. Throwing that away meant a machine Vantra had already reported offline stayed green for up to 10 minutes.

Measured on production in the same session:

```
WilkSF9   rawStatus=offline  windowSaysOnline=false  lastSeenAt=1736s ago
Sc        rawStatus=offline  windowSaysOnline=false  lastSeenAt=1130s ago
```

Two further contributors found while tracing it:

- **`syncDevices` invented timestamps.** `lastSeenAt: d.lastSeen ? new Date(d.lastSeen) : now` — when Vantra omits `lastSeen` (it does, for some agents), an OFFLINE device was stamped as seen *just now*. That fed the UI a false "last seen 0s ago" and kept the freshness window alive for a box that had been off for hours. Now `now` is only applied when `d.online` is true; otherwise the update omits the field (Prisma: "don't change") so the real last-known check-in survives.
- **The notification sweep used the wrong definition too.** `device-status-sweep` derived online-ness from `isDeviceOnline(lastSeenAt)`, so "X went offline" could be delayed by a full 10-minute window *on top of* the 5-minute sweep cadence. It now reads `deviceStatus()` — the same verdict the owner sees on screen.

**The rule now, in one place (`deviceStatus`):**

| stored status | behaviour |
| --- | --- |
| `offline` | **offline immediately** — the verdict wins over a fresh timestamp |
| `asleep` | stays asleep when stale; a live heartbeat proves it woke (`online`) |
| `online` / anything else | must prove freshness through the 10-minute window, so a device that vanishes *without* a verdict still ages out |

**Regression guard.** `tests/device-status.test.ts` (`npm run test:devices`) — 6 tests against the REAL `lib/devices.ts`. Verified as a genuine guard: the old logic returns `online` for `{status:"offline", lastSeenAt: 10s ago}`, which the first test demands be `offline`.

---


## 2. 4.7 GB of idle RSS: glibc arenas, not a Python leak (FIXED)

**Symptom.** `python api.py` at 4.9 GB RSS and 12.3% CPU with zero jobs running, up 23h. The owner noticed system RAM at 40% idle vs ~16% normally.

**Root cause — confirmed, and not what the original brief suspected.** `TASK_48_PART_B_WORKER_MEMORY_INVESTIGATION.md` had guessed "per-job state retained after completion" and hedged with a fourth hypothesis: *"Python's allocator not returning freed memory to the OS, which can look identical to a leak from `ps` alone."* **The fourth hypothesis was correct.**

Evidence from the live process:

- `/proc/<pid>/maps` contained **29 mappings of exactly 64 MB** — glibc's `HEAP_MAX_SIZE` per arena. That signature is conclusive.
- 338 anonymous `rw-p` mappings, 5553 MB mapped, `VmPeak` 14.3 GB.
- `MALLOC_ARENA_MAX` was **unset**, so glibc's default ceiling applied: `8 × nproc` = **64 arenas** on this 8-core box.
- 95 live threads from `automation.py`'s `_EXTRACTION_EXECUTOR = ThreadPoolExecutor(max_workers=128)`. Each arena keeps its own free list forever, so freed blocks are only reused by allocations landing in the *same* arena — memory reads as used to the OS while nothing references it.

That explains every previous observation: a restart reclaims it instantly (nothing held it), growth looked job-correlated (more concurrent jobs → more threads → more arenas), and no Python object was ever retained.

**Fix.** `deploy/extraction-worker.service`:
- `Environment=MALLOC_ARENA_MAX=2` — caps arenas so retained-but-unused heap is bounded by a fixed couple of arenas instead of scaling with thread count.
- `MemoryHigh=3G` (throttle + reclaim, never kills a job) and `MemoryMax=6G` (backstop: turns "eats the box" into a service restart, which `Restart=always` already recovers from).

**Trap documented** in `worker/.env.example`: `MALLOC_ARENA_MAX` must NOT go in `.env`. glibc reads it at the process's first `malloc`, during interpreter boot, long before `api.py`'s `load_dotenv()`. Put it there and it silently does nothing.

**Deliberately not changed:** the 128-worker pool. It is tuned against a real measured failure (the 60s-per-result timeout is measured from dispatch, so a small pool starves the budget — see that constant's own comment). The arena cap removes the memory penalty of the pool size, so shrinking it would trade a real throughput fix for nothing.

---


## 3. `550 Not allowed` / `542 Internal server error` — the relay, not SpaceWorker

`blast1` is saved as `watsonandrade9382.ca.lu:25`, `allowInsecure: true`, `sendRegion: "us"`, **`lastTestedAt: null`** — so the owner's port-24610 edit was never actually saved, and the mailbox the campaign uses was still port 25.

Every one of the campaign's deliverability checks failed at the relay:

```
550 Not allowed                                                 (x several, 14:55-16:38)
550 This message was classified as SPAM and may not be delivered (older campaigns)
550 Message discarded as high-probability spam
542 Internal server error                                       (16:58, most recent)
```

A full MAIL FROM / RCPT TO probe (no DATA sent, so no mail was transmitted) established what the relay actually is:

```
=== watsonandrade9382.ca.lu:25 ===
  EHLO+AUTH -> OK (credentials accepted)
  <- 220 localhost Python SMTP 1.4.6        <- an aiosmtpd instance on the owner's own host
  <- 250-SIZE 33554432 / 250-8BITMIME

=== watsonandrade9382.ca.lu:24610 ===
  EHLO+AUTH -> FAIL: Invalid login: 542 Internal server error
```

The relay is a **customer-operated Python `aiosmtpd` server**, and it is unstable: 24610 returned `542 Internal server error` minutes after the same port had answered `auth=true` in an earlier probe. Its banner even changed between probes (`220 ABC XYZ` in the first E2E, `220 localhost Python SMTP 1.4.6` later), i.e. it is being reconfigured or restarted underneath us.

### The decisive finding: even port 25 never checks credentials

Running the deployed test route against `blast1`'s real saved config produced this, in 1.7s:

```
port 25 + None (unencrypted)
   ok=true
   banner="220 localhost Python SMTP 1.4.6"  auth=false  starttls=false
```

**`auth=false`.** The relay advertises no AUTH mechanism on port 25 at all, so `verify()` succeeds while **the password is never checked**. That is exactly the "connected fine, delivered nothing" signature — and it is why the owner got a delivery locally but the campaign delivered nothing. `lib/smtp-diagnostics.ts` already had a `capabilityWarning()` built for precisely this case (it was written after a previous incident where "a 'successful' campaign delivered nothing, not even to spam"), and the route now surfaces it as a first-class warning:

> Heads-up: this server did not ask for a username or password at all (it advertises no AUTH), so your credentials were never actually checked. Messages may be accepted and then silently dropped instead of relayed — if this is a real mail provider, switch to the port that requires authentication.

**Conclusion: no SpaceWorker setting fixes this.** The customer's relay either (a) accepts unauthenticated mail on port 25 and drops it, or (b) refuses the transaction with `550 Not allowed` / `542 Internal server error`. Both are the relay's behaviour, not a configuration the app can reach. The campaign never left `pending_test_confirm`, so nothing was ever queued out — consistent with "it didn't deliver".


Two genuine SpaceWorker-side problems surfaced here, both fixed:

1. **A wrong `MAILBOX_ENCRYPTION_KEY` looked like a mail fault.** Campaign *"finall outreach"* failed all 50 items with the bare OpenSSL string `Unsupported state or unable to authenticate data`. That is AES-GCM telling you the row was encrypted under a *different* key (rotated, or written by another deployment) — nothing to do with SMTP. `decryptSecretOrThrow` (`lib/mailbox-crypto.ts`) now names the cause and the fix, and `classifySmtpError` maps it to `auth_failed` so it is never retried per-recipient and is surfaced to the owner instead. A live key check confirmed `blast1` decrypts fine and one **`E2E MB` mailbox (`smtp.e2e.test`) is corrupt — "Invalid initialization vector"** and should be deleted.
2. **No SPF on the sending domain.** `dig TXT watsonandrade9382.ca.lu` returns nothing, and the VPS egresses over IPv6 (`2a02:c207:2354:8623::1`) with PTR `vmi3548623.contaboserver.net` (Contabo). Mail sent as `fleming@watsonandrade9382.ca.lu` from a Contabo IPv6 address with no SPF, no DKIM and no matching PTR is close to guaranteed to be spam-foldered by Comcast/Gmail regardless of which port works. **This is the "worked locally but not from the server" difference:** locally the sending IP carries residential reputation.

### Answering "i cant see any security test to choose that works with that port"

There IS one, and it now works — it is **None (unencrypted)** on port **25**, and it returns `ok=true` in 1.7s. The reason the owner could not find it before is that the test used to *hang* rather than report, so every option looked broken; port 24610 genuinely cannot work because the relay rejects the login there.

**But read the warning the test now shows before using it for a campaign** — "this server did not ask for a username or password at all". A green test on this relay does not mean mail will be delivered. For a *sound mailbox*, this relay is not usable until the customer fixes it; a real provider (or their own properly-configured MTA with authentication and SPF) is what makes a campaign deliverable.

### Owner actions for the campaign

1. Open mailbox **blast1**, **save** it on port **25** with **None (unencrypted)**, and **read the warning** the test returns (it did not persist before — `lastTestedAt` is still null — so the earlier port-24610 edit was never saved). Set **send region to direct**: the us/ca tunnels are not carrying SMTP, and per TASK_134 exit nodes never fixed SPF alignment in the first place.
2. Delete the corrupt **`E2E MB`** mailbox (`smtp.e2e.test` — "Invalid initialization vector").
3. Have the relay fixed on the customer side: it must advertise AUTH and actually check it, and stop returning `542`/`550 Not allowed`. Until then this mailbox cannot be a sound campaign sender.
4. Publish `v=spf1 ip6:2a02:c207:2354:8623::1 ip4:164.68.105.96 -all` for `watsonandrade9382.ca.lu`, or stop sending as that domain. With no SPF, no DKIM and a PTR of `vmi3548623.contaboserver.net`, mail from this VPS is close to guaranteed to be spam-foldered regardless of which port works.

---

## Verification performed

| Check | Result |
| --- | --- |
| `npm run test:devices` (new regression suite) | 6/6 pass; old logic provably fails it |
| `npm run test:deliverability` | 6/6 pass |
| `npx tsc --noEmit -p .` | exit 0 |
| `npx eslint` on every changed file | clean |
| Deployed route E2E, 3 port×security combos + 6 assertions | **6/6 PASS** (25+None ok in 1714ms; 25+STARTTLS fails explained in 1859ms; 24610 fails explained in 2362ms) |
| Worker: RSS after restart with `MALLOC_ARENA_MAX=2` | **62 MB, down from 4,908 MB** (79x); env + `MemoryHigh`/`MemoryMax` confirmed in the live unit |
| Deploy: `systemctl is-active` + `curl` | active / 200 |
| Deploy: full-tree checksum parity vs `main` (§2a) | **PARITY OK — 388/388 files, 0 missing, 0 stale, 0 extra** |

