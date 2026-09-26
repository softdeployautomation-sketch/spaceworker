# TASK_123B — Wake-on-LAN PATH B (Vantra side)

**Status: RECORDED · READY FOR BUILD.** Companion to `TASK_123_WAKE_ON_LAN.md` (PATH A, assigned to Claude).
**Read `TASK_123_WAKE_ON_LAN.md` §2–§4 first — the root cause and decisions D1–D6 are settled there and
must not be re-litigated.** This file covers only the Vantra half. Read `HOW_WE_MOVE_FAST.md` and the
standard agent contract in `PIPELINE_CONSOLE_BROWSER_CLONE.md`.

---

## Why this path exists

PATH A (SpaceWorker) decides **whether** a wake is possible and **which peer** should send the packet.
PATH B is the transport that actually puts the packet on the wire, and the keep-awake executor. Neither
halves work alone. The only coupling is the request/response shape frozen in §3 below.

## 1. What is wrong today (the part that is yours)

`lib/trmm.ts`:

```ts
export const wakeAgent = (agentId: string) => trmmPostOk(`/agents/${agentId}/wol/`);
```

- It calls TRMM's `/wol/`, whose MeshCentral handler reads the MAC from the **target's own** `if<node>`
  record (it asks the sleeping machine for its own MAC) and relays **same-mesh, not same-subnet**.
- `trmmPostOk` discards the response — MeshCentral's own `result: 'Used N device(s) to send wake packets'`
  is thrown away, so a **zero-packet** wake is indistinguishable from a real one.
- `case "wake"` in `app/api/internal/sw/devices/[agentId]/action/route.ts` therefore cannot report truth.

**Do not delete `wakeAgent`.** It is the only working path when the *target itself* is awake-but-Windows-
asleep and a same-mesh peer exists. Keep it, and **read its count** so it can be surfaced or retired
deliberately (decision **D6**).

## 2. Deliverables

### V1 — `sendWolPacket(peerAgentId, mac, subnetBroadcast)` in `lib/trmm.ts`
Runs on a **peer** agent, not the target, over the existing `sendRawCmd` transport. The PowerShell must:
- broadcast a magic packet (6× `FF` + the MAC ×16) over **UDP port 9**, to **both**
  `255.255.255.255` and the supplied subnet broadcast address;
- send it **3×** with a short gap (packet loss on a sleeping NIC is common);
- emit a **parseable count line** (e.g. `SW_WOL_SENT=<n>`) so the caller can verify, never assume.

**The MAC is validated server-side** (strict `^([0-9A-F]{2}:){5}[0-9A-F]{2}$`, upper-cased) and may
**never** be an arbitrary caller-supplied value — it must match the `Device.powerMac` PATH A recorded.
A caller that can broadcast to an arbitrary MAC from a customer's machine is a network-abuse primitive.

### V2 — read the count from the existing path (D6)
Wrap the existing `wakeAgent` so its MeshCentral `result` string is parsed to an integer and returned.
If the string cannot be parsed, treat it as **unknown, not success**.

### V3 — keep-awake executor (decision D4 — ship this first)
Script builders for the **already-present but unused** `DevicePowerPolicy`
(`mode off|timed|indefinite`, `until`, `prisma/schema.prisma:1190`):
- **apply** — a keep-awake helper (`powercfg /requestsoverride` + a small awake loop, or the equivalent
  documented approach) that holds the machine awake;
- **clear** — stops and removes the helper, restoring the previous state (idempotent — clearing twice
  must be safe);
- **status** — so the UI can show whether the machine is currently held awake.
The timed→off sweep is PATH A's (SpaceWorker); Vantra only applies and clears.

### V4 — the action route
`app/api/internal/sw/devices/[agentId]/action/route.ts` gains:
- a **peer-send** action that takes a **target device id** (not a raw MAC) and the peer inferred by the
  caller — Vantra re-validates the MAC against its own record before sending;
- **keep-awake** apply/clear actions;
- and it must **return the real counts**, never `ok` without one (**D6** / acceptance 4).

## 3. Frozen contract (the only coupling with PATH A)

```
POST /api/internal/sw/devices/<peerAgentId>/action        (existing route, new actions)
Authorization: <existing SW internal bearer>

{ "action": "wol",        "targetDeviceId": "<sw device id>" }
{ "action": "keepawake",  "mode": "off" | "timed" | "indefinite", "until": "<ISO8601|null>" }

200 { "ok": true,  "sent": <int>, "method": "peer" | "trmm-mesh", "via": "<peer name>" }
200 { "ok": false, "reason": "no_power_mac" | "no_same_subnet_peer" | "peer_unreachable" | "unsupported" }
```

## 4. Files — exactly these

| File | Change |
|---|---|
| `lib/trmm.ts` | `sendWolPacket()`, `parseMeshWolCount()`, keep-awake apply/clear builders, MAC validation |
| `app/api/internal/sw/devices/[agentId]/action/route.ts` | the three new actions + the honest return shape |
| `tests/wol-scripts.test.ts` (new) | Node's built-in runner (`npx tsx --test`), matching `tests/install-link-zip.test.ts`'s convention in this repo |

**Do not touch any SpaceWorker file.** PATH A owns `lib/wol.ts`, the power route, the schema and the console.

## 5. Acceptance

1. **Script-builder tests, no device needed:** the magic packet contains the MAC repeated 16× after six
   `FF` bytes; it targets UDP 9 and **both** broadcast addresses; it is sent 3×; the emitted count line is
   parseable. A malformed MAC is **rejected before any command is built**.
2. **An unparseable MeshCentral `result` yields `unknown`, never `sent > 0`.**
3. Clearing keep-awake twice is safe (idempotent); apply-then-clear restores the prior state.
4. **`sent: 0` + `ok: true` cannot be produced** — asserted in a test (this is decision D6 and the
   original complaint).
5. `npx tsc --noEmit` clean; `npx eslint` clean on the changed files (a pre-existing, unrelated finding
   elsewhere is acceptable if you prove it is pre-existing by running the same rule at HEAD).
6. **Device tests are `Sc` only. `WilkSF9` is a customer device — never test on it, never use it as a
   fallback or a probe.**

## 6. Rules

- Commit only. Branch **`agent/task-123b-wol-vantra`**. No deploy, no ssh, no `.env`.
- No heredocs for commit messages or file writes — use the editor; explicit paths; **never `git add -A`**.
- Never log, print or persist a secret or a bearer.

## 7. Honest limits — do not claim these

- **Whether real hardware wakes** depends on the target's BIOS/NIC ("Wake on Magic Packet" + "Wake on LAN"
  enabled, and *not* "fast startup"). That is a **machine setting**, owner-verified, and cannot be proven
  from code or from a cloud runner.
- **`Sc` has no same-subnet peer today** (measured: our fleet spans 184.174.20.92 / 192.168.0.103 /
  10.100.153.185 / 192.168.122.222, all in one mesh). So the magic-packet path is **correct but
  unexercisable on `Sc`** until a second machine exists on 192.168.0.x. **Keep-awake (V3) is the part that
  works today** — build and verify that first, and report the peer case as untested rather than passing.
- An external relay for singleton-LAN devices is **`GATE-WOL-1`** in the tracker — owner decision, not
  built here.

