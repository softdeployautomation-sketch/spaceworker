# TASK_154 — Device status chip: idle must be STABLE, and never read as "active"

Owner report (2026-10-01):

> "when a user is idle, it shows, and then it goes away, even if the user is still
> idle. i need that showing the actual status everytime, once user gets active, it
> should switch to active, and once the agent detects inactivity it should switch to
> idle and then disappear to be last seen just as it is for the offline user as soon
> as user goes off."

Read as three requirements:

- **R1** — Active → the chip says active, reliably.
- **R2** — Idle → the chip says idle, and **KEEPS** saying idle while the machine is
  still idle. It must not blink away.
- **R3** — Actually gone → the chip becomes `offline · last seen …`, exactly as it
  already does for an offline user.

The defect is in R2. **Idle is currently allowed to vanish for one poll and then come
back**, and the value it falls back to ("`online`", bare) is *indistinguishable from an
active machine*. So an idle machine reads as **active** on a blip — the precise thing
the owner is objecting to.

---

## Status

- **N1 — ✅ DONE 2026-10-01**, commit `a64c702` (pushed, CI-green, **NOT deployed**). See the
  STATUS note at the end of §3 N1; raw evidence in `SENIOR_HANDOFF.md` §12.
- **N2 — ✅ DONE 2026-10-01**, commit `e342578` (pushed, CI-green, **NOT deployed**). One shared
  helper `idleChipLabel` in `lib/device-idle.ts`; both surfaces + all three console print sites
  wired; old bare-status fallback deleted; `tests/device-idle-chip.test.ts` (**10/10**). It used
  only the **always-on** top-level `idle: { state, asOf }` (not `?idle=provenance`). Raw evidence
  in `SENIOR_HANDOFF.md` §12.
- **NEXT — DEPLOY N1 + N2 together** (manual `workflow_dispatch`), then screenshot `/devices` and a
  device console (§8). That is what closes the owner report. **Nothing is live yet.**
- **N3 — not started** (optional, cross-repo).

Live-app state, deploy status and the update protocol live in `SENIOR_HANDOFF.md` (§6, §9, §10);
this doc holds only the diagnosis (§1) and the design/tasks (§2–§3).

## 1. Verified state (2026-10-01, `main`)

### 1.1 The label has a degradation path that lies

`components/device-list.tsx:635-640`:

```ts
const statusIdleLabel = (d: DeviceRow): string => {
  const online = d.status === "online" || d.status === "asleep";
  if (!online) return `offline · last seen ${relTime(d.lastSeenAt)}`;
  if (d.idleSeconds === null) return statusWord(d.status);          // <-- "online"
  return `${statusWord(d.status)} · ${formatIdle(d.idleSeconds)}`;  // <-- "online · idle 1 min"
};
```

`lib/device-idle.ts:12-18` — the formatter, for reference:

```
formatIdle(null)  -> "unknown"      (never reached: the null branch returns first)
formatIdle(20)    -> "active now"
formatIdle(104)   -> "idle 1 min"
formatIdle(10800) -> "idle 3 hr"
```

So an **active** machine renders `online · active now`, and a **blip** renders `online`.
The second is not "unknown" to the user — it reads as *fine/active*. There is no state
in which the owner can tell "no data" from "active".

The same three-way branch is duplicated at `components/device-console.tsx:1391-1395`,
and `formatIdle` is used a third time at `components/device-console.tsx:462`
(`online ? \` · idle ${formatIdle(device.idleSeconds)}\` : ""`). Any fix must cover all
three or the two screens disagree — which is the exact class of bug `lib/devices.ts:56-63`
("ONE selector definition, so the list page and the per-device console can never
disagree") was written to prevent.

### 1.2 `null` means two different things, and both are silent

`app/api/devices/route.ts:44-49`:

```ts
let idleByHostname: Record<string, number | null> = {};
try {
  idleByHostname = await fetchUserIdle(session.userId);
} catch {
  idleByHostname = {};            // <-- mesh unreachable => EVERY row idleSeconds:null
}
```

`app/api/devices/route.ts:64`:

```ts
idleSeconds: idleByHostname[view.name] ?? null,
```

`null` is emitted for (a) *mesh is unreachable*, (b) *mesh answered but has no node
with this hostname*, and (c) *the name is missing/renamed*. The client cannot tell
them apart, so it must treat all three the same way — and today it treats them as
"hide the idle text".

### 1.3 Why the mesh call fails often enough to be seen

The bottom half of the chain is a **15-second WebSocket round trip with no cache**,
executed **on every device-list poll for every user**:

- `app/api/devices/route.ts:46` calls `fetchUserIdle` on EVERY `GET /api/devices`.
- `components/device-list.tsx:260` polls it every **20 s** (`setInterval(tick, 20_000)`).
- `lib/vantra-link.ts:687-709` `fetchUserIdle` → `fetchOrgIdle` → Vantra's
  `/api/internal/sw/devices/idle`.
- Vantra side: `lib/meshcentral-api.ts:88-120` `listMeshNodes()` opens a MeshCentral
  control socket, sends `{action:"nodes"}`, and **`reject`s on a 15_000 ms timeout**
  (or any socket error). Its own docblock: *"Throws when unconfigured or on
  timeout/socket error (callers fail soft)."*
- Vantra's route catches and returns `{}` — `app/api/internal/sw/devices/idle/route.ts:60`
  `console.error("sw bulk idle failed:", err)`.
- `lib/vantra-link.ts:703-707` swallows a per-org failure so one org cannot block the
  other.

**A 15 s timeout inside a 20 s poll cycle, on a box that also runs the extractor, the
browser clone, the screenshot sweep and the dispatcher, means a hiccup blanks idle for
that poll.** That is the observed flicker: `online · idle 1 min` → `online` → `online ·
idle 1 min`, with the machine never having been touched.

### 1.4 Live proof that upstream works, and is not the cause

Executed on the production VPS against the real Vantra instance (`127.0.0.1:3300`),
using a real linked org — **not** a simulation:

```
$ curl -s -m 60 -w '\nHTTP=%{http_code} time=%{time_total}s\n' \
    -H "Authorization: Bearer $VANTRA_INTERNAL_TOKEN" \
    "http://127.0.0.1:3300/api/internal/sw/devices/idle?orgId=cmufkhca60002kpovrnlc92bq"
{"ok":true,"idleByHostname":{"I":104},"idleUnit":"seconds"}
HTTP=200 time=0.198700s

# repeated x3 - stable
{"ok":true,"idleByHostname":{"I":104},"idleUnit":"seconds"} HTTP=200
{"ok":true,"idleByHostname":{"I":104},"idleUnit":"seconds"} HTTP=200
{"ok":true,"idleByHostname":{"I":104},"idleUnit":"seconds"} HTTP=200
```

Conclusions that constrain the fix:

1. **The mesh path works and is fast (~0.2 s) when healthy.** The bug is not a broken
   feature; it is the **absence of any tolerance to a transient failure**.
2. **The map is keyed by hostname, and that hostname is `"I"`** — a one-character name
   (`Device.name`). The key is therefore fragile: a rename, an empty name, or two
   devices sharing a name all silently mis-key. Nothing in the code detects that.
3. No mesh failure has ever been logged for the reporting user, because the failure is
   swallowed at three levels (`lib/vantra-link.ts:703-707` is completely silent) - so
   this class of defect is currently **unobservable in production**. That is itself a
   finding: it must become observable.

### 1.5 What already works and must NOT be changed

- **Going offline is already correct.** `lib/devices.ts:48-52` `deviceStatus()` honours
  a definite `"offline"` verdict immediately and otherwise ages out via
  `DEVICE_ONLINE_WINDOW_MS` (10 min). `lastSeenAt` is written by `recordHeartbeat()`.
  This is R3 and there is no evidence it is broken - verify, do not rewrite.
- **Idle rides the existing 20 s poll** by design (`components/device-console.tsx:567-571`
  - "idle rides the existing 15 s poll of `/api/devices` (no extra request; console poll
  cadence unchanged)"). Do not add a second polling loop.
- **`fetchUserIdle` merges the public + private orgs.** Keep that.

---

## 2. The design (settle this before writing code)

The defect is **a missing concept**, not a wrong line: the system has no way to say
*"we do not know right now"* as distinct from *"the machine is active"*. Both collapse
to `null`, and the UI resolves `null` by silently deleting the idle text.

### 2.1 Principle: absent evidence is not evidence of activity

An idle machine is idle until something **positively** says it is active again. A
missing reading must never be allowed to promote a device to "active". This is the
opposite posture to the fail-open rule used for entitlement checks (TASK_145), and it
is correct here because a stale "idle" is *safe* (it understates activity) while a
stale "active" is a **lie about a machine nobody is touching**.

### 2.2 Server: make the values and their provenance explicit

`GET /api/devices` must stop emitting a bare `null` for three different situations, and
must stop being coupled to a live 15 s socket on every poll:

- Report per-row idle as **known-and-fresh**, **known-but-stale** (with `asOf`), or
  **unknown** — not a single nullable number the client must guess about.
- **Cache the bulk idle map server-side with a short TTL**, keyed by org, shared across
  all of that org's users. On a mesh failure serve the last good map with its timestamp
  instead of `{}`. A cache miss may be slow; a cache hit must not touch the socket.
  This removes the cause rather than hiding it, and it also stops N users each opening
  their own MeshCentral socket every 20 s.
- **Make failure observable**: log a rate-limited warning when the mesh read fails and
  a cached value is served (today it is swallowed and invisible — see §1.4.3).

### 2.3 Client: latch the state, and never print a bare status

One shared helper decides the label, so the list and the console cannot diverge:

- Track the **last known idle reading and its age** per device.
- **Latch**: once the reading is past the idle threshold, keep rendering idle until a
  reading arrives that is positively *below* the threshold (active). An `unknown`
  reading changes nothing.
- Bound the latch: a reading older than the offline window falls back to `offline ·
  last seen …`, so a machine that vanishes still ends up in R3's state rather than
  displaying a frozen "idle" forever.
- **The bare-status fallback is deleted.** There must be no rendering path that shows
  `online` alone while a device is connected — that string is what reads as "active".
  If the state is genuinely unknown, say so (`online · activity unknown`), which is
  honest and still visibly different from `online · active now`.

### 2.4 Keying

Do not silently mis-key. At minimum normalise (trim + case-fold) the hostname and
**detect collisions** (two devices resolving to one key) and empties, then report them
rather than rendering one machine's activity against another. Keying idle by
`vantraAgentId` instead of hostname is the correct long-term fix but requires a Vantra
change — scope that as **N3**, do not attempt it inside N1/N2.

---

## 3. Tasks

Run in order. **N1** is server-only and may be verified with raw HTTP. **N2** is the
client half and must not start until N1's response shape is fixed. **N3** is a
clearly-marked, cross-repo follow-up and may be skipped without blocking the owner's fix.

### N1 — Server: idle readings carry provenance, and a mesh hiccup cannot blank them

**Files:** `lib/vantra-link.ts`, `app/api/devices/route.ts`, (type only) `lib/devices.ts`.

**Do:**
1. Add a short-TTL, org-keyed cache of the bulk idle map (a module-level `Map` in
   `lib/vantra-link.ts` is sufficient — do NOT add Redis or a new dependency, and do NOT
   add a second admission counter). On a successful read, store the map **and** the
   timestamp. On failure, return the last good map plus its `asOf`. A cold cache with a
   failing mesh is the only case that may return nothing.
2. TTL must be **>= the client poll interval** so a single 20 s poll can never be
   served by a cold read twice in a row. State the value you chose and why.
3. Change the per-row response so `null` is no longer overloaded. The client must be able
   to distinguish: a known reading (value + `asOf`), and genuinely unknown. Keep the
   existing `idleSeconds` field working for any other consumer. **There are more than the
   two files you expect**: `grep -rn 'idleSeconds' app lib components` currently returns
   hits in **seven** files — `app/api/devices/route.ts`, `lib/device-idle.ts`,
   `lib/vantra-link.ts`, `lib/admin-devices.ts`, `components/device-list.tsx`,
   `components/device-console.tsx`, and `app/admin/(protected)/admin-panel.tsx`. The
   admin device view is a real consumer and must not be broken; if you change the
   response shape, update every consumer in the same commit, or add a field rather than
   repurpose one.
4. Keep the whole thing best-effort: a mesh failure must NEVER turn `GET /api/devices`
   into a 500. The device list must always render.
5. Add a **rate-limited** `console.warn` when the mesh read fails and a cached/stale map
   is served. Rate-limited, or a sustained outage will flood the journal.
6. Do NOT change `deviceStatus()`'s offline logic (`lib/devices.ts:48-52`) — it is
   correct (R3) and is out of scope.

**Verify (raw):**
- Directly exercise the server helper against production Vantra with a real org, as in
  §1.4, and paste the response — proving the healthy path still returns real values.
- Then prove the tolerance: inject a mesh failure (a stub/throw) and show `GET
  /api/devices` still returns **200** with a usable (cached) idle value rather than
  blanking every row. Show the cache serving a value with an `asOf`.
- Show the rate-limited warning firing **once** across several successive failures.
- Show a cold cache + failing mesh degrades honestly (unknown), not to a guessed "active".
- `npx tsc --noEmit` clean; run the existing test suites and paste the tallies.

> **STATUS: ✅ DONE 2026-10-01 — commit `a64c702` (pushed, CI-green, NOT deployed).** Implemented
> exactly per the above: the cache is a module-level `Map` keyed **by org** in `lib/vantra-link.ts`
> (no Redis, no new dependency, no second admission counter); TTL default **25 s** (`DEVICE_IDLE_CACHE_TTL_MS`
> overridable), chosen because the client polls every **20 s** (`device-list.tsx`), so one poll can
> never be served by a cold read twice in a row; the shape is **additive** (`idleSeconds` untouched;
> new always-on top-level `idle: { asOf, state }`; new **opt-in** per-row `idle` via `?idle=provenance`)
> so no consumer — admin included — was broken; a mesh failure never 500s; the failure warning is
> **rate-limited** to once/org/60 s. Live healthy path re-proven against real Vantra (`{"I":104}`,
> HTTP 200 ×3). Raw evidence: `SENIOR_HANDOFF.md` §12 (2026-10-01 entry). Test: `npm run test:idle`
> (**8/8**; was RED 8/8 before the fix).

### N2 — Client: latch idle, and delete the "bare status" fallback

**Files:** `lib/device-idle.ts`, `components/device-list.tsx`, `components/device-console.tsx`.

**Do:**
1. Put the decision in **one** shared helper (in `lib/device-idle.ts`, which is
   already the client-safe module for exactly this). Both components call it. Do not
   implement the latch twice.
2. **Latch**: hold the last positive idle reading per device; clear it only on a reading
   that is positively active (`< 60 s`, matching `formatIdle`'s own `"active now"`
   boundary). An unknown/stale reading must not clear it.
3. Age-bound the latch: past the offline window the device is offline anyway and must
   render `offline · last seen …` (R3). Use `DEVICE_ONLINE_WINDOW_MS`'s value — do not
   invent a second window on the client; if the server sends it (it already sends
   `onlineWindowMs`, `app/api/devices/route.ts:52), use that.
4. **Remove the bare-status render** at `device-list.tsx:638` and the equivalent at
   `device-console.tsx:1393`. There must be no path that shows a connected device as
   just `online`. Unknown renders as an explicit "activity unknown" and never as active.
5. Keep `formatIdle`'s existing output strings for the known cases — the console also
   prints idle at `device-console.tsx:462` and `:1690`; make all three agree.
6. Do NOT add a second poll loop and do NOT change the 20 s cadence.

**Verify (this is the whole task — reproduce the flicker, then kill it):**
- Build the failing condition: a stub that returns a real idle map on one poll and
  throws on the next. Paste the rendered chip for **consecutive polls**, showing the
  BEFORE behaviour `online · idle 1 min` → `online` → `online · idle 1 min`, and the
  AFTER behaviour holding `online · idle 1 min` across the gap.
- Prove the latch **can** be cleared: a positively-active reading (`idleSeconds: 20`)
  must switch the chip back to `online · active now`, immediately, in the next render.
- Prove the age bound: a reading older than the offline window renders `offline · last
  seen …`, not a frozen idle.
- Prove an offline device still renders `offline · last seen …` (R3) unchanged.
- Rendered evidence from **both** the device list and the device console, plus a raw
  DOM/text check — not a code read.
- `npx tsc --noEmit` clean; run the existing test suites and paste the tallies.

> **STATUS: ✅ DONE 2026-10-01 — commit `e342578` (pushed, CI-green, NOT deployed).** All of the
> above met: one shared helper `idleChipLabel` in `lib/device-idle.ts` (module-global latch `Map`,
> keyed `id:` else `name:`; clears only on a positively-active reading `< 60 s`, matching
> `formatIdle`; self-bounds against the **server's** `onlineWindowMs` so a sustained outage cannot
> freeze an idle forever; cold+unknown → `online · activity unknown`, never a guessed "active").
> The old bare-status fallback is **deleted** from both `components/device-list.tsx`
> (`:625-642`) and `components/device-console.tsx`, and **all three** console print sites
> (`:462`, `:1398`, `:1700`) route through the helper. `deviceStatus()` /
> `DEVICE_ONLINE_WINDOW_MS` (`lib/devices.ts`), the 20 s poll cadence, `.env`, `browser-capture/`
> and `src-tauri/` were **not** touched; no schema change, no migration. **Rendered** before/after
> (real components in real Chromium; `/api/devices` bodies stubbed = **SIMULATION**):
> `["online · idle 1 min"], ["online"], ["online · idle 1 min"]` → all three `["online · idle 1 min"]`.
> `npm run test:idlechip` **10/10**; `tsc` clean; full 24-suite sweep 0 fail. Raw evidence:
> `SENIOR_HANDOFF.md` §12 (2026-10-01 N2 entry). **Not live — deploy N1 + N2 together.**

### N3 — (follow-up, cross-repo) key idle by agent id, not hostname

**Files:** the Vantra repo, plus the SW consumer. **Not required for the owner's fix.**
`lib/meshcentral-api.ts`'s `MeshCentralNode` carries `_id` (`node//<b64>`) and the SW
side already stores `vantraAgentId`. §1.4.2 shows the hostname key is a single character
(`"I"`) — it is fragile and collides silently. Changing the key to a stable identity
removes a whole class of mis-attribution. Scope it only after N1/N2 land, and only if
the owner wants it.

---

## 4. Non-negotiable rules

1. **Never let a missing reading read as "active".** This is the whole point of the task.
   If you find yourself writing a fallback that prints a bare `online` for a connected
   device, stop — that is the bug you are removing.
2. **Do not widen the offline window to hide the flicker.** R3 works; lengthening
   `DEVICE_ONLINE_WINDOW_MS` would make a switched-off machine linger as "online" — the
   exact complaint fixed on 2026-09-28 (`lib/devices.ts:30-47`). Do not touch it.
3. **Server tolerance, not client pretence.** The client must not paper over a server
   that returns nothing — N1 must reduce how often nothing is returned. A client-only
   latch with no cache would still blank on a cold start.
4. **Best-effort stays best-effort.** A mesh failure must never 500 the device list, and
   must never block the page. The list is the product; idle is enrichment.
5. **One label implementation.** The list and the console must call the same helper.
   Duplicating the branch is how they diverge — see `lib/devices.ts:56-63` for the
   precedent the codebase already set for this.
6. **No new polling loops, no new dependencies, no Redis, no second counter.** Extend
   the existing request. There is already one poll (`device-list.tsx:260`) and one
   admission authority (`lib/resource-governor.ts`).
7. **Do not change `deviceStatus()`** or the `asleep` semantics.
8. **Do not enable screen monitoring, or touch any device's consent flags**, to make a
   test pass. If your proof needs a monitored device, use a scratch DB.
9. `browser-capture/` and `src-tauri/` are out of scope. Do not edit `.env`.
10. Stage only your own files, by explicit path. Never `git add -A` / `git add .`.

## 5. Evidence standard

- Raw output only: rendered chip text per poll, HTTP responses, `psql` rows, logs.
  Before **and** after. No "works as expected", no invented numbers.
- **Reproduce the flicker first.** If you did not watch the chip drop the idle text on a
  stubbed mesh failure, you have not shown the bug and cannot claim the fix.
- A check that cannot fail is not evidence. Show the latch clearing on a genuinely
  active reading, and show the age bound firing.
- Label anything simulated a **SIMULATION**. §1.4 is the only live-production evidence in
  this document; do not present stubs as live.
- State explicitly what you could NOT verify. A false "verified live" is worse than an
  honest gap.


