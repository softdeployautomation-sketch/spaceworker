// Task 106 (bit C1) — client-safe idle copy. Mirrors Vantra's
// `lib/meshcentral-api.ts` `formatIdle` (the canonical unit lives there as
// `MESHCENTRAL_IDLETIME_UNIT`; `/api/devices` already hands us seconds, so
// this file only formats — never converts units, never prints raw values).

/**
 *   formatIdle(null)  → "unknown"
 *   formatIdle(20)    → "active now"
 *   formatIdle(720)   → "idle 12 min"
 *   formatIdle(10800) → "idle 3 hr"
 */
export function formatIdle(idleSeconds: number | null | undefined): string {
  if (idleSeconds === null || idleSeconds === undefined) return "unknown";
  if (!Number.isFinite(idleSeconds) || idleSeconds < 0) return "unknown";
  if (idleSeconds < 60) return "active now";
  if (idleSeconds < 3600) return `idle ${Math.floor(idleSeconds / 60)} min`;
  return `idle ${Math.floor(idleSeconds / 3600)} hr`;
}

// ---------------------------------------------------------------------------
// TASK_154 N2 — the ONE status/idle chip every surface renders.
//
// WHY THIS LIVES HERE: the identical chip was hand-rolled twice — the Devices
// list (components/device-list.tsx) and the console header
// (components/device-console.tsx) — and BOTH deleted the idle text whenever the
// server sent `idleSeconds: null`:
//
//     if (d.idleSeconds === null) return statusWord(d.status);   // bare "online"
//
// A bare "online" is indistinguishable from "online · active now", so a single
// MeshCentral hiccup (the bulk idle read times out and every row blanks for one
// poll) made an idle machine read as ACTIVE — the owner's "it shows, and then it
// goes away, even if the user is still idle". Two divergent copies are exactly
// what a shared helper is meant to prevent (lib/devices.ts:56-63).
//
// Fix: one helper both surfaces call that (a) never prints a bare status while a
// device is connected, (b) LATCHES the last positive idle reading so a missing
// one cannot demote an idle machine to "active", and (c) ages the latch out past
// the SERVER's offline window so a machine that truly vanishes still lands in
// R3's "offline · last seen …" state instead of a frozen idle.
//
// Client-safe by construction: no imports, no I/O — only the clock.
// ---------------------------------------------------------------------------

/** Below this many seconds a reading is positively ACTIVE — formatIdle's own
 *  boundary. ONLY a reading strictly below it clears the latch. */
export const IDLE_ACTIVE_MAX_SECONDS = 60;

/** The bulk idle read's provenance, as `GET /api/devices` reports it (always
 *  present, N1's additive field). `asOf` is the observation time of the map the
 *  server served: "now" for `fresh`, the cache's timestamp for `stale`. */
export type IdleReadProvenance = {
  onlineWindowMs: number | null;
  state: "fresh" | "stale" | "unknown";
  asOf: string | null;
};

/** The device fields the chip needs. A Devices-list row and the console's
 *  DeviceView both satisfy this structurally, so neither imports the other. */
export type IdleChipDevice = {
  id?: string | null;
  name?: string | null;
  status: string;
  lastSeenAt: string | null;
  idleSeconds: number | null;
};

/** "online" / "asleep" / "offline" — the word the chip leads with. */
export function statusWord(status: string): string {
  if (status === "asleep") return "asleep";
  if (status === "online") return "online";
  return "offline";
}

/** Relative age of a timestamp, in the units the owner already sees elsewhere. */
export function relTime(iso: string | null): string {
  return relTimeAt(iso, Date.now());
}

/** `relTime` against an EXPLICIT clock. The chip must age `lastSeenAt` against
 *  the same `nowMs` it bounds the reading with, so a render and its test agree
 *  (a test cannot rely on the wall clock). */
function relTimeAt(iso: string | null, nowMs: number): string {
  if (!iso) return "never";
  const s = Math.floor((nowMs - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** The last positive (>= IDLE_ACTIVE_MAX_SECONDS) idle reading per device, and
 *  when it was observed. Module-level on purpose: the chip is a plain function
 *  called during render, so it cannot hold a ref; and the latch must SURVIVE the
 *  poll that dropped the reading — one poll is exactly the span a Map gives it. */
const idleLatch = new Map<string, { seconds: number; seenAtMs: number }>();

function latchKey(d: IdleChipDevice): string {
  if (d.id) return `id:${d.id}`;
  return `name:${(d.name ?? "").trim().toLowerCase()}`;
}

/**
 * The ONE status/idle label, shared by every surface (Devices list, console
 * header, console Summary, the agent page context). Never a bare status while a
 * device is connected:
 *
 *   offline             → "offline · last seen …"        (R3, unchanged)
 *   idle, reading       → "online · idle 12 min"
 *   active, reading     → "online · active now"          (clears the latch)
 *   no reading, latched → "online · idle 12 min"         (holds through a hiccup)
 *   no reading, cold    → "online · activity unknown"    (honest — never "active")
 *
 * `onlineWindowMs` is the server's window (GET /api/devices sends it). A reading
 * older than it is no longer evidence of anything, so the chip falls back to the
 * offline text and R3 owns the device. If the window is not known we do not
 * bound — we will not invent a second window on the client.
 */
export function idleChipLabel(
  device: IdleChipDevice,
  opts?: {
    onlineWindowMs?: number | null;
    nowMs?: number;
    readState?: IdleReadProvenance["state"];
    readAsOf?: string | null;
  },
): string {
  const nowMs = opts?.nowMs ?? Date.now();
  const word = statusWord(device.status);
  // R3 — a disconnected device is offline, full stop (lib/devices.ts deviceStatus
  // already ages lastSeenAt out). The latch never applies to it.
  if (device.status !== "online" && device.status !== "asleep") {
    return `offline · last seen ${relTimeAt(device.lastSeenAt, nowMs)}`;
  }

  const key = latchKey(device);
  const held = idleLatch.get(key);
  const windowMs = opts?.onlineWindowMs ?? null;

  const seconds = device.idleSeconds;
  const hasReading = typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0;

  // A positively-active reading is never stale: it CLEARS the latch and shows
  // as-is, whatever the bulk read's provenance.
  if (hasReading && seconds < IDLE_ACTIVE_MAX_SECONDS) {
    idleLatch.delete(key);
    return `${word} · ${formatIdle(seconds)}`;
  }

  // The observation time of the reading we would show: this poll's, or the one we
  // latched earlier if this poll gave none. A "stale" reading's true age is the
  // server cache's asOf — using it is what lets a sustained outage AGE the latch
  // instead of refreshing it to "now" forever.
  let observedAtMs: number | null = null;
  if (hasReading) {
    observedAtMs =
      opts?.readState === "stale" && opts?.readAsOf
        ? Date.parse(opts.readAsOf) || nowMs
        : nowMs;
  } else if (held) {
    observedAtMs = held.seenAtMs;
  }

  // Bound: an observation older than the offline window is no longer evidence of
  // anything — stop showing it and let R3 own the device.
  if (observedAtMs !== null && typeof windowMs === "number" && nowMs - observedAtMs > windowMs) {
    idleLatch.delete(key);
    return `offline · last seen ${relTimeAt(device.lastSeenAt, nowMs)}`;
  }

  if (hasReading) {
    idleLatch.set(key, { seconds: seconds as number, seenAtMs: observedAtMs as number });
    return `${word} · ${formatIdle(seconds)}`;
  }

  // No usable reading this poll. Hold the last positive one if we have it.
  // TASK_185 P1 — with neither a reading nor a latch, the OWNER'S RULE
  // (2026-10-08, "better it shows active instead of unknown"): a connected
  // device renders ACTIVE, never "activity unknown". The status half of the
  // chip is heartbeat-known either way; the idle half may simply not have
  // arrived yet (fresh online, mesh lag) — and for that case the owner's
  // instruction is explicit. "unknown" is retired from this chip.
  if (held) return `${word} · ${formatIdle(held.seconds)}`;
  return `${word} · active`;
}
/**
 * Read the always-on provenance off a `GET /api/devices` body: the bulk read's
 * `idle: { state, asOf }` (N1) and `onlineWindowMs`. Tolerant by design — an
 * older server, or a body without them, yields "unknown" rather than throwing, so
 * the list always renders.
 */
export function idleReadProvenanceFrom(data: unknown): IdleReadProvenance {
  const r = (data ?? {}) as {
    onlineWindowMs?: unknown;
    idle?: { state?: unknown; asOf?: unknown };
  };
  return {
    onlineWindowMs: typeof r.onlineWindowMs === "number" ? r.onlineWindowMs : null,
    state: r.idle?.state === "fresh" || r.idle?.state === "stale" ? r.idle.state : "unknown",
    asOf: typeof r.idle?.asOf === "string" ? r.idle.asOf : null,
  };
}

