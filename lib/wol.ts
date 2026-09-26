// TASK_123 (B12) — Wake-on-LAN, PATH A (P1/P2/P4 minus the Vantra transport).
//
// Root cause (TASK_123.md §2, verified against the live fleet, not assumed):
// MeshCentral's `wakedevices` handler reads the TARGET's own `if<node>`
// record for its MAC (R1 — asking a sleeping machine for its own MAC), then
// relays to every OTHER agent in the same MESH (R2 — not the same SUBNET),
// and never reads back how many packets were actually sent (R3 — fire-and-
// forget "success"). This file is the pure, unit-testable half of the fix:
//   - record the device's OWN power identity (MAC/IP/subnet) — D1, no
//     dependency on MeshCentral's `if` records at all;
//   - pick a same-subnet, online peer to relay through — D2;
//   - a frozen wire contract for PATH B (Vantra's `lib/trmm.ts`) to send the
//     actual magic packet FROM that peer and report back a packet count — D6.
// Nothing here talks to the DB or the network; every caller (lib/device-tools.ts,
// lib/clone-setup.ts) supplies plain data in and reads plain data out.

// ---------------------------------------------------------------------------
// MAC / IP / subnet helpers
// ---------------------------------------------------------------------------

const MAC_RE = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/;

/** Canonical form: uppercase, colon-separated. Returns null for anything else — never throws. */
export function normalizeMac(raw: string): string | null {
  const trimmed = raw.trim();
  if (!MAC_RE.test(trimmed)) return null;
  return trimmed.replace(/-/g, ":").toUpperCase();
}

/** "192.168.0.103" -> "192.168.0.0/24". Returns null for anything that isn't a plain IPv4 dotted quad. */
export function subnetOf(ip: string): string | null {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
}

// ---------------------------------------------------------------------------
// P1 — power-identity capture script (run SYSTEM-side, same posture as
// lib/clone-setup.ts's live-capture-token step: we are ON the machine, so we
// read its adapter directly instead of trusting anything MeshCentral reports).
// ---------------------------------------------------------------------------

const POWER_IDENTITY_MARKER = "STEP:power-identity";

/**
 * `Get-NetIPConfiguration` bundles the adapter, its IPv4 address and its MAC
 * in one call — no registry parsing, and (2026-09-26 lesson, device-tools.ts)
 * no `Test-Path` on a value we don't control, so the trailing-backslash class
 * of bug that silently broke app discovery has no equivalent surface here.
 * Picks the adapter that actually has a default gateway and is Up — the
 * active LAN/Wi-Fi adapter, not a virtual/disconnected one.
 */
export function buildPowerIdentityScript(): string {
  return [
    "$ErrorActionPreference = 'Continue'",
    "try {",
    "  $cfg = Get-NetIPConfiguration -ErrorAction SilentlyContinue | Where-Object {",
    "    $_.IPv4DefaultGateway -ne $null -and $_.NetAdapter -and $_.NetAdapter.Status -eq 'Up'",
    "  } | Select-Object -First 1",
    `  if (-not $cfg) { Write-Output '${POWER_IDENTITY_MARKER} FAIL:no_active_adapter'; exit 0 }`,
    "  $addrObj = $cfg.IPv4Address | Select-Object -First 1",
    "  $addr = if ($addrObj) { $addrObj.IPAddress } else { $null }",
    "  $mac = $cfg.NetAdapter.MacAddress",
    `  if (-not $addr -or -not $mac) { Write-Output '${POWER_IDENTITY_MARKER} FAIL:no_ip_or_mac'; exit 0 }`,
    "  $macNorm = ($mac -replace '-', ':').ToUpper()",
    "  $octets = $addr.Split('.')",
    `  if ($octets.Count -ne 4) { Write-Output '${POWER_IDENTITY_MARKER} FAIL:bad_ip_format'; exit 0 }`,
    '  $subnet = "$($octets[0]).$($octets[1]).$($octets[2]).0/24"',
    `  Write-Output ('${POWER_IDENTITY_MARKER} OK:' + $macNorm + '|' + $addr + '|' + $subnet)`,
    "} catch {",
    `  Write-Output ('${POWER_IDENTITY_MARKER} FAIL:' + ($_.Exception.Message -replace '\\s+', ' '))`,
    "}",
  ].join("\n");
}

export interface PowerIdentity {
  mac: string;
  lanIp: string;
  lanSubnet: string;
}

/** Parses `buildPowerIdentityScript`'s output. Malformed/missing ⇒ null, never throw. */
export function parsePowerIdentityOutput(output: string | null): PowerIdentity | null {
  if (typeof output !== "string") return null;
  const m = new RegExp(`${POWER_IDENTITY_MARKER} OK:([0-9A-Fa-f:]{17})\\|([0-9.]+)\\|([0-9.]+/24)`).exec(
    output,
  );
  if (!m) return null;
  const mac = normalizeMac(m[1]);
  const subnet = subnetOf(m[2]);
  if (!mac || !subnet || subnet !== m[3]) return null;
  return { mac, lanIp: m[2], lanSubnet: subnet };
}

// ---------------------------------------------------------------------------
// P2 — same-subnet peer selection (pure — no DB, no network).
// ---------------------------------------------------------------------------

export interface WolPeerCandidate {
  id: string;
  vantraAgentId: string | null;
  status: string;
  powerLanSubnet: string | null;
}

/**
 * D2 — relay through a peer on the SAME SUBNET, never "any agent in the
 * mesh" (R2). A peer must be online (asleep/offline machines can't relay)
 * and must itself have a linked Vantra agent. Deterministic: first match in
 * caller-supplied order — callers pass the fleet ordered by most-recently-
 * seen first so the freshest peer wins ties.
 */
export function selectWolPeer(opts: {
  targetDeviceId: string;
  targetSubnet: string | null;
  fleet: WolPeerCandidate[];
}): WolPeerCandidate | null {
  if (!opts.targetSubnet) return null;
  return (
    opts.fleet.find(
      (c) =>
        c.id !== opts.targetDeviceId &&
        c.status === "online" &&
        !!c.vantraAgentId &&
        c.powerLanSubnet === opts.targetSubnet,
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// P3/P4 wire contract — FROZEN in `TASK_123B_WOL_VANTRA.md` §3, **version 2**
// (corrected 2026-09-26: Vantra addresses devices by `agentId`, holds no
// `swDeviceId` mapping and no MAC column anywhere — the original draft's
// `{ action: "wol", targetDeviceId }` had no possible server implementation).
// Reproduced verbatim here so neither side needs to re-derive it:
//
//   POST /api/internal/sw/devices/<peerAgentId>/action   (existing route, new actions)
//
//   { "action": "wol",
//     "targetAgentId":   "<target vantraAgentId>",  -- MANDATORY, lets Vantra sw-org-check the target too
//     "targetMac":       "<AA:BB:CC:DD:EE:FF>",     -- MANDATORY, this record exists ONLY on the SW side
//     "subnetBroadcast": "192.168.0.255",           -- optional, derived from the target's recorded /24
//     "targetDeviceId":  "<sw device id>" }         -- optional, audit/logging only; Vantra cannot resolve it
//   -- sent to the PEER's own agentId (the URL agent), never the sleeping target.
//
//   { "action": "keepawake", "mode": "off"|"timed"|"indefinite", "until": "<ISO8601|null>" }
//   -- sent to the DEVICE's OWN agentId.
//
//   200 { "ok": true,  "sent": <int>, "method": "peer"|"trmm-mesh", "via": "<peer name>" }
//   200 { "ok": false, "reason": "no_power_mac"|"no_same_subnet_peer"|"peer_unreachable"|"unsupported" }
//
// Who validates the MAC (verified against the real Vantra code, not assumed):
// SpaceWorker is AUTHORITATIVE — `targetMac` must equal `Device.powerMac` for
// the target (the only place that record exists), peer != target, and same
// /24 (P2's own selectWolPeer already enforces the latter two before this
// request is ever built). Vantra's own check is defence in depth only: MAC
// format + assertAgentInSwOrg on both agent ids + peer != target — never a
// cross-check against "the recorded value", because no such record exists on
// that side.
//
// PATH B (Vantra `lib/trmm.ts` + its action route) implements the receiving
// end; PATH A only ever constructs this request and reads this response.
// Until PATH B ships, both actions are wired but INERT — Vantra doesn't
// recognize them yet, so a call 404s (surfaced as `vantra_deploy_outdated`
// by normalizeVantraError, same honest-failure path every other tool in this
// file already uses for an outdated Vantra deploy) rather than silently
// pretending to succeed.
// ---------------------------------------------------------------------------

export const WOL_ACTION = "wol" as const;
export const KEEPAWAKE_ACTION = "keepawake" as const;

export type WolRefusalReason =
  | "no_power_mac"
  | "no_same_subnet_peer"
  | "peer_unreachable"
  | "unsupported";

export interface WolActionRequest {
  action: typeof WOL_ACTION;
  targetAgentId: string;
  targetMac: string;
  subnetBroadcast?: string;
  targetDeviceId?: string;
}

export interface WolActionResponse {
  ok: boolean;
  sent?: number;
  method?: "peer" | "trmm-mesh";
  via?: string;
  reason?: WolRefusalReason;
}

export interface KeepAwakeActionResponse {
  ok: boolean;
  reason?: WolRefusalReason;
}

/** "192.168.0.0/24" -> "192.168.0.255". Returns null for anything not shaped like our own subnetOf() output. */
export function broadcastAddressOf(subnet: string): string | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.0\/24$/.exec(subnet.trim());
  if (!m) return null;
  const octets = [m[1], m[2], m[3]].map(Number);
  if (octets.some((n) => n < 0 || n > 255)) return null;
  return `${octets[0]}.${octets[1]}.${octets[2]}.255`;
}
