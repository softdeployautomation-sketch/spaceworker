# TASK_123 — Wake-on-LAN: make "Wake" actually wake a machine (B12)

**Status: RECORDED · READY FOR BUILD.** Assigned to **Path A (Claude)** — see §7.
**Supersedes/absorbs TASK_96 deliverables 2-5.** TASK_96's `DevicePowerPolicy` schema already exists
(`prisma/schema.prisma:1190`) and is **unused**; this task is where it gets used.
Read first: `HOW_WE_MOVE_FAST.md` and the standard agent contract in `PIPELINE_CONSOLE_BROWSER_CLONE.md`.

---

## 1. Owner report

> "all of the functions are working.. until wake on lan. dont think we have done anything on that."

Correct, and it is worse than "not built": the Wake button **exists, reports success, and cannot wake a machine.**

## 2. Root cause — verified, not assumed

The call chain:

```
console Power → Wake
  → lib/device-tools.ts runPowerAction(action:"wake")
  → Vantra app/api/internal/sw/devices/[agentId]/action/route.ts  case "wake"
  → lib/trmm.ts wakeAgent()          = POST /agents/{id}/wol/
  → TRMM agents/views.py:1355 wol()
  → core/utils.py:201 wake_on_lan()  = MeshCentral WS { action: "wakedevices" }
```

Everything forwards. The defect is at the far end, in MeshCentral
(`/meshcentral/node_modules/meshcentral/meshuser.js:2951-3031`). Its `wakedevices` handler:

1. `db.Get('if' + node._id)` — reads the **target machine's own** interface record to learn its MACs.
2. `parent.parent.meshScanner.wakeOnLan(macs, node.host)` — the server sends a raw packet.
   **MeshCentral's own source comment on this line: `// Have the server send a wake-on-lan packet (Will not work in WAN-only)`**
   — and our MeshCentral runs on a cloud VPS (`164.68.105.96`), so it is WAN-only. Layer-2 broadcast
   cannot cross the internet; this line is a no-op for every customer LAN.
3. Then it relays `{ action: 'wakeonlan', macs }` to **other authenticated agents in the same mesh**.

Three independent reasons the current button cannot wake a sleeping machine:

| # | Why it fails |
|---|---|
| R1 | The MACs come from the **target's own** `if<node>` record — i.e. MeshCentral asks the sleeping machine for its own MAC. |
| R2 | The relay target list is **same-mesh**, not **same-subnet**. A magic packet broadcast from a machine on a *different* LAN never reaches the target. |
| R3 | It is **fire-and-forget**: the console's route returns `{ ok: true, action }` and Vantra's `wakeAgent` is `trmmPostOk` — neither reads MeshCentral's `result: 'Used N device(s) to send wake packets'`. Even `N = 0` reports success. |

## 3. Our live fleet — measured (`/meshcentral/meshcentral-data/meshcentral.db.json`)

5 `if` records, **all in one mesh `mesh//lhHk`**, on **four different subnets**:

| Node | Reported LAN IP | Recorded MAC |
|---|---|---|
| `WIN-8OA3CCQAE4D` (the VPS itself) | 184.174.20.92 | `00:16:3E:16:8D:D2` |
| `Sc` | 192.168.0.103 | `C6:9D:43:00:AB:EA` |
| `WilkSF9` | 10.100.153.185 | `74:04:F1:3B:63:35`, `74:04:F1:3B:63:34` |
| `I` | 192.168.122.222 | `52:54:00:4E:0E:87` |

**Consequence (this is the honest headline): only `WilkSF9` has two NICs; every other device is a
singleton on its own subnet.** So even after fixing R2, **`Sc` currently has no same-subnet peer for
anyone to relay through** — a peer-relay design is correct but not yet sufficient for the owner's test
box. That is a topology fact, not a bug, and it must be surfaced in the UI rather than papered over.


## 4. Decisions already made — do not re-litigate

| # | Decision | Why |
|---|---|---|
| **D1** | **Record the MAC ourselves at setup time.** New `Device.powerMac` (+ `powerLanIp`, `powerLanSubnet`, `powerMacUpdatedAt`). We are *on the machine* during one-click setup, so we do not need MeshCentral's `if` records at all — and we must not, because R1 needs the target awake. | Removes dependency on the broken input path |
| **D2** | **Relay through a peer on the SAME SUBNET**, chosen by us from the recorded `/24` of each device's last-seen LAN IP — never "any agent in the mesh" (R2). | The only relay that can physically reach the target |
| **D3** | **Fail closed and name the reason.** If no recorded MAC → `no_power_mac`; if no online same-subnet peer → `no_same_subnet_peer`. **Never** report "Wake sent" in those cases. | R3 is a dishonest success; that is the real complaint |
| **D4** | **Keep-awake ships first** (§5 P4). It needs no peer, works on every device, and is the higher-value reachability feature. Use the existing `DevicePowerPolicy` (`mode off\|timed\|indefinite`, `until`). | Always achievable; delivers value today |
| **D5** | **Defer the external relay** (a small WoL receiver on the customer LAN). It needs hardware/a consent story; recorded as **GATE** in the tracker, not built here. | Outside the code |
| **D6** | **Stop double-reporting.** Either our own path replaces `wakeAgent`, or `wakeAgent` is kept only as an explicit fallback with its result *read* (`Used N device(s)…`) and surfaced. No path may claim success without a count. | Same class as the earlier "honest refusal" work |

## 5. Deliverables

### P1 — Record power identity (SpaceWorker)
New nullable columns on `Device`: `powerMac String?`, `powerLanIp String?`, `powerLanSubnet String?`,
`powerMacUpdatedAt DateTime?` + **one hand-written migration**. Populated in the existing setup block
(`lib/clone-setup.ts`, the same block that writes `live-capture.json`), with a small PowerShell step that
resolves the active adapter's MAC + IPv4 + `/24` and prints them in a **parseable** form. Idempotent.

### P2 — Same-subnet peer selection (SpaceWorker)
Pure function in a new `lib/wol.ts`: given the target `Device` and the fleet, return candidate peers whose
`powerLanSubnet` equals the target's **and** which are online. Unit-testable with no device. Add
`no_power_mac` / `no_same_subnet_peer` to the power route's refusal vocabulary.

### P3 — Magic-packet sender (Vantra)
`lib/trmm.ts` gains a `sendWolPacket(agentId, mac)` path that runs on a **peer** agent: PowerShell UDP
broadcast to port 9 (`255.255.255.255` plus the subnet broadcast address), sent 3× with a small gap. The
existing TRMM `cmd`/`run-script` transport is reused. **Server-side validates the target MAC against the
recorded value** — a caller may never supply an arbitrary MAC to broadcast.

### P4 — Keep-awake (SpaceWorker + Vantra)
Wire the **already-present** `DevicePowerPolicy`. One-tap buttons in the device panel:
**Stay on (indefinite)** / **Stay on for… (timed)** / **Stop**. Vantra applies `powercfg /requestsoverride`
+ a keep-awake helper per policy and clears it on stop; a sweep flips `timed` → `off` at `until` and clears
the helper. Status visible in the UI. Audited both ways (user-initiated, so no proposal gate).

### P5 — Honest UI
Wake is only enabled when `powerMac` is known. When it is known but no same-subnet peer is online, the menu
item is present but annotated with the real reason and the fix ("keep a second PC on this network online,
or use keep-awake"). The success notice carries the **packet count** actually sent.

## 6. Acceptance

1. `Sc`: **keep-awake** — Stay on (indefinite) holds the machine awake; **Stop** releases; a timed policy
   expires on schedule and the helper is cleared. Verified via `powercfg /requests` before/after.
2. Wake **fails closed with the right reason** — no peer online → `no_same_subnet_peer`; no MAC →
   `no_power_mac`. **Neither may return `ok: true`.**
3. Wake **succeeds** where a same-subnet peer exists: sleep a device, wake it, confirm the peer sent the
   packet and the target returns — with the count in the notice.
4. No path reports success without a count (R3 regression guard, asserted in a test).
5. `npx tsc --noEmit` clean; migration hand-written and reversible; journalctl clean.
6. **Never test on `WilkSF9`.** Device work happens on `Sc` only.

## 7. Paths

| Path | Owner | Files |
|---|---|---|
| **PATH A (Claude)** — P1-P4 minus the Vantra PowerShell | Claude | `prisma/schema.prisma` + migration · `lib/wol.ts` (new) · `lib/device-tools.ts` · `app/api/devices/[deviceId]/power/route.ts` · `lib/clone-setup.ts` · `components/device-console.tsx` · a test file |
| **PATH B** — Vantra side (P3 transport + P4 application) | next agent | `lib/trmm.ts` · `app/api/internal/sw/devices/[agentId]/action/route.ts` · keep-awake script builder |

**Owner-only (do not claim):** whether the hardware actually wakes — that is a BIOS/NIC setting on the real
machine ("Wake on Magic Packet" + "Wake on LAN" enabled, and *not* "fast startup"). Record it as an
instruction; it cannot be verified from code.

## 8. GATE

- **GATE-WOL-1** — external relay for singleton-LAN devices (a small receiver on the customer LAN, or a
  supported LAN bridge). Owner decision; not built here.
