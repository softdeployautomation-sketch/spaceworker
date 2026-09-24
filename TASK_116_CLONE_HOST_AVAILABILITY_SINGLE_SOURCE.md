# Task 116 (bit B4-fu) — "clone host is ready" but Start says no host

**Repos:** `spaceworker` only.
**Written:** 2026-09-24.
**Pipeline:** `PIPELINE_CONSOLE_BROWSER_CLONE.md` (bit **B4-fu** — follow-up to
B4 clone gating; discovered on top of `TASK_114`'s one-click setup).

## Owner's report (2026-09-24)

> "clone host is ready, and i clicked start clone, and its still say no host"

With a screenshot: the Device-setup card showing **`This PC` · ready** *and*
**`Clone host` · ready** on the same device, and Start still refusing:

> No hosted clone PC is available — every clone runs its browser on one. In the
> Device setup card above, click "Set up as clone host" on a PC you keep online,
> then start the clone again.

Both halves of that screen were true, and that is the bug: **the card and the
gate did not mean the same thing by "ready".**

## Diagnosis — read from the live DB, not inferred

Ground truth on the owner's account (`myrate619@gmail.com`, tier 5):

| Device | Raw `status` | `lastSeenAt` age at read | `vantraAgentId` | Capabilities |
| --- | --- | --- | --- | --- |
| `Sc` | `online` | **1247 s (20.8 min)** | yes | `relay`, `clone-capture`, `clone-host` |
| `WilkSF9` | `offline` | 13872 s | yes | *(none)* |

Plus: `RelayHealth` for `Sc` = `status=up`, checked **2 minutes earlier**, and a
relay-health probe is a real round-trip to the agent (`sendRawCmd` → TRIMM). So
`Sc` was **provably reachable** while its stored heartbeat was 20 minutes old.

### Defect 1 — two definitions of "a host is available"

| Side | What it read | Freshness rule |
| --- | --- | --- |
| `CloneSetupCard` badge (`hostedReady`) | the raw `Device.status` **column** | none — whatever the last sync wrote |
| `pickHostedCloneDevice` (the gate) | `deviceStatus()` → `lastSeenAt` | **10-minute** window (`DEVICE_ONLINE_WINDOW_MS`) |

The two could disagree precisely when it mattered, and both under-reported for
the same underlying reason.

### Defect 2 — the snapshot has no timer

`Device.status` / `lastSeenAt` are written in exactly ONE place:
`syncDevices()` in `lib/vantra-link.ts`. Nothing schedules it — it runs when a
human loads the **device list** (`components/device-list.tsx` → `loadLink()`).
The console's Setup card and the clone gate then apply a *freshness window* to a
snapshot of unknown age. The owner opened the console, hit Refresh, saw "ready",
waited a few minutes, pressed Start — and the window had already expired on data
that was never going to update on its own.

### Defect 3 — the copy sent the owner round a loop they had completed

The only `clone-host` on the account **was the device being cloned from**
(`Sc`). `pickHostedCloneDevice` correctly excludes the source, so the pool was
empty — but the refusal told them to click **"Set up as clone host"**, i.e. the
button they had just pressed, on the PC they had just pressed it on. One PC can
never host a clone of itself, and nothing on screen said so.

Worse, the pre-Start warning had the same blind spot in reverse: it already told
the truth ("clone hosts are counted **apart from this PC**") but it was rendered
only when `!hostedAvailable`, so a user reading the two `ready` badges above it
had no reason to connect them.

## What ships

| # | Piece | Where |
| --- | --- | --- |
| 1 | `lib/clone-hosts.ts` — **one** `hostAvailability()` used by BOTH the gate and the Setup card; returns `reason` (`ok` / `no_host` / `self_only` / `offline`), the picked host id, other-host counts, `selfIsHost`, and offline host names | new module |
| 2 | `refreshDeviceLiveness(userId)` — pulls agent state from Vantra **at each decision point**, throttled to one call per user per 20 s, best-effort, never throws | same |
| 3 | Liveness is accepted from EITHER signal: the raw `status` column *or* `deviceStatus()`'s heartbeat window. A false **positive** costs one clear "device offline" from the device RPC (which fails closed anyway); a false **negative** produces "no host available" with nothing to click — the exact dead end this task removes. `asleep` is never accepted | same |
| 4 | `requestClone` refreshes liveness **before** the source lookup, then refuses through `hostAvailability()` with reason-specific copy: `self_only` names the one-PC loop, `offline` names the offline hosts, `no_host` keeps the original actionable line | `lib/clone.ts` |

## What this does NOT fix (so nobody re-litigates it here)

- **The hosted pool is still not provisioned.** Per
  `DESIGN_BROWSER_CLONE_UI_AND_FLOW.md` §7 the hosted PC is meant to be
  **pooled/SpaceWorker-run**; today the pool is only ever *counted*
  (`app/api/admin/clone-limits/route.ts`) and never created. With one online PC
  the honest answer is `self_only`, and that is what the console now says
  instead of pointing at a button the owner already pressed.
- **`WilkSF9` is offline and carries no capabilities.** It needs the one-click
  **"Set up as clone host"** (`TASK_114`) once it is online. That is owner
  action on hardware, not a code path.
- **A clone still needs two devices.** Removing that requirement would mean
  either same-device hosting (rejected: capture runs in the interactive session
  whose profile is being copied, and `install-hosted.ps1`/`install-relay.ps1`
  own the same `%ProgramData%\TacticalRMM\CloneTool` tree) or a real pool.

## Verification plan

Server-side (no device needed):
1. `tsc --noEmit` clean.
2. `POST /api/devices/<Sc>/clones` with `egress:"relay"` on an account whose
   only `clone-host` is the source → expect **409 `no_hosted_clone_device`**
   whose message is the **`self_only`** sentence (proves reason routing).
3. `GET /api/devices/<Sc>/clone-setup` → `hostBlockReason:"self_only"`,
   `selfIsHost:true`, `hostedAvailable:false` — and the card renders the amber
   note rather than two bare `ready` badges.
4. Confirm the liveness refresh actually fires: `Sc`'s `lastSeenAt` should move
   forward after a console poll even with no device-list visit.

Owner-side (needs hardware):
5. With a **second** online PC set up as clone host, Start succeeds and
   `hostBlockReason` flips to `ok`.

## Rollback

The refresh is throttled, best-effort and non-throwing; removing
`refreshDeviceLiveness()` calls restores the previous behaviour exactly. No
schema change, no `.env` key, no Vantra change.

| 5 | `cloneSetupStatus` refreshes liveness too, and returns `hostBlockReason` / `selfIsHost` / `offlineHostNames` so the card can explain itself | `lib/clone-setup.ts` |
| 6 | Console: pre-Start warning branches on the reason (`self_only` → "one PC is not enough, set up a **second** PC"); the Clone-host row gains an amber note when this PC is a host but cannot host its own clone; **Start stays ENABLED** (this flag can be a false negative and the server is the real gate, which now refuses with matching copy) | `components/device-console.tsx` |
| 7 | `same_device` refusal rewritten in plain language; `REFUSALS` pattern extended to keep mapping it to `400 clone_refused` | `app/api/devices/[deviceId]/clones/route.ts` |

`hostAvailability` is deliberately the SAME function for both callers. That is
the actual fix: the class of bug here is two places answering one question.
