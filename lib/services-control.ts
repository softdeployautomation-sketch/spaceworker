import "server-only";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Lets the admin panel stop/start/restart the standalone browser subsystem
 * (spaceworker-browser.service — Neko/Chrome/Docker, NOT the main Next.js
 * app or extraction-worker) without shelling into the VPS. Deliberately
 * scoped to exactly this one unit, matching the actual ask ("the browser
 * part alone, so I can stop it if necessary") rather than a general
 * service-control panel — restarting the main app or worker from this same
 * surface is a much easier way to cause an outage than the "stop a
 * heavyweight, non-critical subsystem" lever this is meant to be.
 *
 * Note: spaceworker.service (and this admin route) currently run as `trmm`,
 * which already carries a pre-existing, broader `NOPASSWD:ALL` sudo grant
 * (a known gap — same class of issue Vantra's own admin panel had before
 * its V5 hardening pass moved it to a dedicated unprivileged user with a
 * narrow sudoers allowlist). That migration is a separate, bigger task and
 * out of scope here — this module still enforces its OWN allowlist in code
 * (CONTROLLABLE_UNITS, fixed argument arrays, no shell) as defense in depth
 * regardless of how broad the underlying OS grant happens to be today.
 */

export type ServiceAction = "start" | "stop" | "restart";

export const CONTROLLABLE_UNITS = ["spaceworker-browser.service"] as const;
export type ControllableUnit = (typeof CONTROLLABLE_UNITS)[number];

// Exported so callers (the API route, the client-side type below) share this
// as the single source of truth rather than each keeping their own copy that
// could silently drift if a future action is added here and not there.
export const SERVICE_ACTIONS: readonly ServiceAction[] = ["start", "stop", "restart"];

export interface ServiceState {
  unit: string;
  activeState: string;
  subState: string;
  memoryMb: number | null;
}

function isControllableUnit(unit: string): unit is ControllableUnit {
  return (CONTROLLABLE_UNITS as readonly string[]).includes(unit);
}

export async function getServiceState(unit: ControllableUnit): Promise<ServiceState> {
  // The ControllableUnit type is erased at runtime — re-check for real so
  // this function is actually safe to call with a value that only TYPE-
  // CHECKS as ControllableUnit (e.g. via an `as` cast at a future call site),
  // matching the same defense-in-depth controlService already does below.
  if (!isControllableUnit(unit)) {
    throw new Error(`Unit is not controllable: ${unit}`);
  }
  const { stdout } = await execFileAsync(
    "/usr/bin/systemctl",
    ["show", unit, "-p", "Id", "-p", "ActiveState", "-p", "SubState", "-p", "MemoryCurrent"],
    { timeout: 10_000 }
  );
  // Property order in `systemctl show` output is not guaranteed stable —
  // parse into a map and key off the property name, never position.
  const map: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    map[line.slice(0, idx)] = line.slice(idx + 1);
  }
  const memRaw = map.MemoryCurrent;
  const memoryMb =
    memRaw && memRaw !== "[not set]" && memRaw !== "18446744073709551615"
      ? Math.round(Number(memRaw) / 1024 / 1024)
      : null;
  return {
    unit: map.Id ?? unit,
    activeState: map.ActiveState ?? "unknown",
    subState: map.SubState ?? "unknown",
    memoryMb,
  };
}

export async function controlService(unit: string, action: string): Promise<void> {
  if (!isControllableUnit(unit)) {
    throw new Error(`Unit is not controllable: ${unit}`);
  }
  if (!SERVICE_ACTIONS.includes(action as ServiceAction)) {
    throw new Error(`Invalid action: ${action}`);
  }
  // stop/restart wait on systemd's own stop job, which (for this specific
  // unit) now tears down every live Neko/Chrome container on SIGTERM — under
  // load that can genuinely take longer than a short timeout, and killing
  // the `sudo systemctl` CLI wrapper on timeout doesn't necessarily abort the
  // stop job systemd already dispatched, just makes this call falsely report
  // failure for something that actually succeeds moments later. -n
  // (non-interactive): fail fast instead of hanging if sudo ever needs a
  // password it doesn't have (e.g. the trmm grant is ever narrowed later).
  await execFileAsync("sudo", ["-n", "/usr/bin/systemctl", action, unit], { timeout: 60_000 });
}
