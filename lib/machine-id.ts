import "server-only";

import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { readFile } from "fs/promises";
import { hostname, networkInterfaces, platform } from "os";

// Machine-ID — a faithful port of ~/lead-extractor/app/license/machine_id.py,
// reusing Node 20.19's native modules (node:os, node:child_process, node:crypto)
// so the desktop EXE derives the SAME stable 16-char hex hardware ID the proven
// standalone does. Used by the licensing gate to bind an activated license to
// the machine it was first activated on.
//
//   Windows -> wmic/system BIOS uuid, then disk serial
//   macOS   -> IOPlatformUUID via `ioreg`
//   Linux   -> /etc/machine-id (fallback /var/lib/dbus/machine-id)
//   else    -> a weaker hash of hostname/platform/processor/mac (VMs/sandboxes
//              where no stable ID exists) — the same degraded fallback the
//              standalone accepts.

export const MACHINE_ID_LENGTH = 16;

export interface MachineIdOptions {
  /** Test seam — override the OS the module thinks it's running on. */
  platformOverride?: string;
  /** Test seam — override the derived MAC used in the fallback hash. */
  macOverride?: string;
  /** Test seam — short-circuit with a known value (mirrors validator.py's
   *  `current_machine_id` param without ever touching real hardware). */
  currentMachineId?: string;
}

/**
 * Derives a stable 16-char hex machine ID from hardware characteristics that
 * survive reboots and app restarts. Falls back to a weaker hash only when no
 * stable ID is available (VMs / sandboxes).
 */
export async function getMachineId(opts: MachineIdOptions = {}): Promise<string> {
  if (opts.currentMachineId) return opts.currentMachineId.toLowerCase();

  const system = opts.platformOverride ?? currentPlatform();
  let stableIds: string[] = [];
  if (system === "win32") {
    stableIds = await windowsStableIds();
  } else if (system === "darwin") {
    stableIds = await darwinStableIds();
  } else if (system === "linux") {
    stableIds = await linuxStableIds();
  }

  // Use ONLY stable IDs when available — don't mix with hostname/MAC (those
  // change across reboots / restarts).
  let parts: string;
  if (stableIds.length > 0) {
    parts = JSON.stringify(stableIds);
  } else {
    parts = buildFallbackJson(system, opts);
  }

  return sha256Hex(parts).slice(0, MACHINE_ID_LENGTH);
}

/**
 * True when the license's bound machine ID matches the current machine —
 * the same comparison validator.py's validate_machine_id() performs.
 */
export function validateMachineId(
  licenseMachineId: string,
  currentMachineId: string,
): boolean {
  const a = licenseMachineId.toLowerCase();
  const b = currentMachineId.toLowerCase();
  return a.length > 0 && a === b;
}

// ── platform collectors ─────────────────────────────────────────────────

async function windowsStableIds(): Promise<string[]> {
  const ids: string[] = [];

  // 1. System UUID (motherboard/BIOS) — most stable on Windows. Try `wmic`
  //    first (older Windows), then PowerShell (Windows 11+ — wmic deprecated).
  const wmic = await execCapture("wmic", ["csproduct", "get", "uuid"]);
  if (wmic.code === 0 && wmic.stdout) {
    const uuidVal = parseWmicUuid(wmic.stdout);
    if (uuidVal && uuidVal.length > 10) {
      ids.push(uuidVal.toUpperCase());
    }
  }
  if (ids.length === 0) {
    const ps = await execCapture("powershell", [
      "-NoProfile",
      "-Command",
      "(Get-WmiObject Win32_ComputerSystemProduct).UUID",
    ]);
    const psVal = ps.stdout.trim();
    if (ps.code === 0 && psVal.length > 10) ids.push(psVal.toUpperCase());
  }

  // 2. Disk drive serial — stable unless the disk is replaced.
  const disk = await execCapture("wmic", ["diskdrive", "get", "serialnumber"]);
  if (disk.code === 0 && disk.stdout) {
    for (const raw of disk.stdout.trim().split(/\r?\n/)) {
      const line = raw.trim();
      if (line && line.toUpperCase() !== "SERIALNUMBER" && line.length > 4) {
        ids.push(line);
        break;
      }
    }
  }

  return ids;
}

function parseWmicUuid(stdout: string): string | null {
  for (const raw of stdout.trim().split(/\r?\n/)) {
    const line = raw.trim().toUpperCase();
    if (line && line !== "UUID" && line.length > 10) return line;
  }
  return null;
}

async function darwinStableIds(): Promise<string[]> {
  const ids: string[] = [];
  const res = await execCapture("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
  if (res.code === 0 && res.stdout.includes("IOPlatformUUID")) {
    for (const line of res.stdout.split(/\r?\n/)) {
      if (!line.includes("IOPlatformUUID")) continue;
      const firstQuote = line.indexOf('"', line.indexOf("IOPlatformUUID"));
      if (firstQuote < 0) continue;
      const endQuote = line.indexOf('"', firstQuote + 1);
      if (endQuote > firstQuote) {
        ids.push(line.slice(firstQuote + 1, endQuote));
        break;
      }
    }
  }
  return ids;
}

async function linuxStableIds(): Promise<string[]> {
  const ids: string[] = [];
  // Statically-scoped reads (unrolled rather than looping over a path variable)
  // so Turbopack's node-file-trace can reason about them.
  for (const mid of [await tryRead("/etc/machine-id"), await tryRead("/var/lib/dbus/machine-id")]) {
    if (mid && ids.length === 0) ids.push(mid);
  }
  return ids;
}

async function tryRead(p: string): Promise<string> {
  try {
    return (await readFile(p, "utf8")).trim();
  } catch {
    return "";
  }
}
// ── fallback (VMs / sandboxes with no stable IDs) ────────────────────────

function buildFallbackJson(system: string, opts: MachineIdOptions): string {
  // Keys sorted ALPHABETICALLY to match Python's json.dumps(sort_keys=True).
  const info: Record<string, string> = {
    hostname: safeHostname(),
    mac: opts.macOverride ?? firstRealMac(),
    platform: system,
    processor: process.arch,
    system,
  };
  const keys = Object.keys(info).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}: ${JSON.stringify(info[k])}`);
  return `{${parts.join(", ")}}`;
}

function safeHostname(): string {
  try {
    return process.env.HOSTNAME ?? hostname();
  } catch {
    return "unknown-host";
  }
}

function currentPlatform(): string {
  try {
    if (typeof platform === "function") return platform();
    return platform ?? "unknown";
  } catch {
    return "unknown";
  }
}

function firstRealMac(): string {
  try {
    const ifaces = networkInterfaces();
    for (const key of Object.keys(ifaces)) {
      const addrs = ifaces[key] as unknown;
      if (!Array.isArray(addrs)) continue;
      for (const addr of addrs as Array<{ mac?: string; internal?: boolean }>) {
        const mac = addr.mac;
        if (mac && mac !== "00:00:00:00:00:00" && !addr.internal) return mac;
      }
    }
  } catch {
    return "unknown";
  }
  return "unknown";
}

// ── small helpers ────────────────────────────────────────────────────────

async function execCapture(
  file: string,
  args: string[],
): Promise<{ code: number; stdout: string }> {
  try {
    const res = spawnSync(file, args, { encoding: "utf8" });
    return { code: res.status ?? -1, stdout: res.stdout };
  } catch {
    return { code: 1, stdout: "" };
  }
}

function sha256Hex(text: string): string {
  const hash = createHash("sha256");
  hash.update(text, "utf8");
  return Buffer.from(hash.digest()).toString("hex");
}