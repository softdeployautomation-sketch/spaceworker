import "server-only";

import crypto from "node:crypto";

import { db } from "./db";
import { deviceStatus } from "./devices";
import { adminRunDeviceCommand } from "./device-tools";
import { fetchUserIdle } from "./vantra-link";

// TASK_146 — the ADMIN side of the shared device layer.
//
// Read models for the /admin Devices surface plus the bulk fan-out. This module
// is the only place a device list is assembled WITHOUT a session user filter:
// every customer-facing list (app/api/devices/route.ts) scopes by
// `session.userId`, and here the whole point is to see across owners.
// Consequently EVERY function in this file must be reachable only from a route
// that has already asserted the admin session first (`app/api/admin/**`).
//
// Nothing written from here touches a customer-visible table — see the model
// comment on AdminDeviceCommand in prisma/schema.prisma for why.

/** The one shape every admin device list returns (all-devices + per-user). */
export interface AdminDeviceRow {
  id: string;
  name: string;
  deviceKind: string;
  /** Derived with the SAME rule the customer console uses (lib/devices.ts). */
  status: string;
  osName: string | null;
  osVersion: string | null;
  tier: string;
  lastSeenAt: string | null;
  createdAt: string;
  agentId: string | null;
  /** Best-effort MeshCentral idle (seconds); null when not looked up. */
  idleSeconds: number | null;
  owner: { id: string; email: string; tier: number };
}

const ADMIN_DEVICE_SELECT = {
  id: true,
  name: true,
  deviceKind: true,
  status: true,
  osName: true,
  osVersion: true,
  tier: true,
  lastSeenAt: true,
  createdAt: true,
  vantraAgentId: true,
  user: { select: { id: true, email: true, tier: true } },
} as const;

/**
 * Every device across every owner — the admin's top-level view.
 *
 * Filters:
 *  • `q`      — substring of the device name OR the owner's email
 *    (case-insensitive), which is how an admin finds "that machine for
 *    cameron.fruin@…" without knowing a device id.
 *  • `status` — "online" / "offline", matched against the DERIVED status, so it
 *    cannot disagree with the badge rendered next to it. Applied in JS on
 *    purpose: `deviceStatus()` is freshness math (status + lastSeenAt age) and
 *    re-implementing it in SQL is exactly how the two drift apart.
 *  • `userId` — pins the list to one owner (the Users-tab drill-down).
 *
 * `idleSeconds` is deliberately only filled when the list is pinned to ONE
 * owner: MeshCentral idle is fetched per Vantra org (one call per user), so
 * enriching the all-devices view would fan out to about one call per customer
 * on every page load. The per-user view is where "is this person even sitting
 * at the machine?" actually matters.
 */
export async function listAdminDevices(opts: {
  q?: string;
  status?: string;
  userId?: string;
  limit?: number;
}): Promise<{ devices: AdminDeviceRow[]; truncated: boolean }> {
  const q = opts.q?.trim() ?? "";
  const where = {
    // TASK_118 B8-1 — our own clone-destination browser is infrastructure, not a
    // machine: same exclusion as the customer list, so it can never be picked as
    // a command target from the admin surface either.
    deviceKind: { not: "hosted" },
    // TASK_128 §15 — a removed device leaves no ghost row.
    removedAt: null,
    ...(opts.userId ? { userId: opts.userId } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            { user: { email: { contains: q, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };

  const rows = await db.device.findMany({
    where,
    orderBy: [{ createdAt: "asc" }],
    select: ADMIN_DEVICE_SELECT,
  });

  const limit = Math.min(1000, Math.max(1, Math.round(opts.limit ?? 500)));
  const filtered = rows
    .map((r) => ({
      id: r.id,
      name: r.name,
      deviceKind: r.deviceKind,
      status: deviceStatus(r),
      osName: r.osName,
      osVersion: r.osVersion,
      tier: r.tier,
      lastSeenAt: r.lastSeenAt ? r.lastSeenAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
      agentId: r.vantraAgentId,
      idleSeconds: null as number | null,
      owner: { id: r.user.id, email: r.user.email, tier: r.user.tier },
    }))
    .filter((d) =>
      opts.status === "online" || opts.status === "offline" ? d.status === opts.status : true,
    );

  const truncated = filtered.length > limit;
  const devices = filtered.slice(0, limit);

  if (opts.userId && devices.length > 0) {
    let idleByHostname: Record<string, number | null> = {};
    try {
      idleByHostname = await fetchUserIdle(opts.userId);
    } catch {
      // Best-effort, exactly like the customer list: Vantra unreachable or no
      // linked org must never fail the list.
      idleByHostname = {};
    }
    for (const d of devices) d.idleSeconds = idleByHostname[d.name] ?? null;
  }

  return { devices, truncated };
}

/** One owner's devices — the "enter a user, see their machines" drill-down. */
export async function listAdminDevicesForUser(userId: string): Promise<{
  owner: { id: string; email: string; tier: number } | null;
  devices: AdminDeviceRow[];
}> {
  const owner = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, tier: true },
  });
  if (!owner) return { owner: null, devices: [] };
  const { devices } = await listAdminDevices({ userId });
  return { owner, devices };
}

/**
 * Vantra failure text → HTTP status, kept IDENTICAL to the customer run-command
 * route (app/api/devices/[deviceId]/run-command/route.ts:64-70) so one device
 * layer has one error contract. Callers pass the FIRST ":"-delimited token of
 * the normalized message ("vantra_404", "device_not_linked", …).
 */
export function adminCommandErrorStatus(code: string): number {
  if (code === "device_not_found") return 404;
  if (code === "device_not_linked") return 404;
  if (code === "device_not_commandable") return 400;
  if (code === "cmd_invalid") return 400;
  if (code === "vantra_not_configured") return 503;
  if (code === "vantra_deploy_outdated") return 503;
  if (code.startsWith("vantra_4")) return 400;
  return 502;
}

/** Split a normalized device error into (short code, full text). */
export function splitDeviceError(err: unknown): { code: string; message: string } {
  const message = err instanceof Error ? err.message : "run_failed";
  const code = message.split(":")[0]?.trim() || "run_failed";
  return { code, message };
}

/**
 * Shared body parse for the single + bulk run-command routes. Mirrors the
 * customer route's rules exactly (app/api/devices/[deviceId]/run-command/
 * route.ts:28-50): same 8000-char command ceiling, same 1–90s timeout with a 30s
 * default, same `cmd` shell opt-in. An admin must not be able to exceed a limit
 * the customer console enforces — the executor behind both is one machine.
 */
export function parseAdminCommandBody(body: {
  cmd?: unknown;
  shell?: unknown;
  timeout?: unknown;
  runAsUser?: unknown;
}):
  | { ok: true; cmd: string; shell: string; timeoutSeconds: number; runAsUser: boolean }
  | { ok: false; error: string } {
  const cmd = typeof body.cmd === "string" ? body.cmd.trim() : "";
  if (!cmd || cmd.length > 8000) {
    return { ok: false, error: "cmd is required (max 8000 chars)." };
  }
  const shell = body.shell === "cmd" ? "cmd" : "powershell";
  const timeoutSeconds =
    typeof body.timeout === "number" &&
    Number.isInteger(body.timeout) &&
    body.timeout >= 1 &&
    body.timeout <= 90
      ? body.timeout
      : 30;
  return { ok: true, cmd, shell, timeoutSeconds, runAsUser: body.runAsUser === true };
}


/** The admin-only command log for one device (or one owner). */
export async function listAdminCommandLog(opts: {
  deviceId?: string;
  userId?: string;
  limit?: number;
}) {
  const limit = Math.min(200, Math.max(1, Math.round(opts.limit ?? 50)));
  const rows = await db.adminDeviceCommand.findMany({
    where: {
      ...(opts.deviceId ? { deviceId: opts.deviceId } : {}),
      ...(opts.userId ? { userId: opts.userId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      batchId: true,
      deviceId: true,
      userId: true,
      shell: true,
      cmd: true,
      timeoutSeconds: true,
      runAsUser: true,
      status: true,
      output: true,
      error: true,
      createdAt: true,
    },
  });
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

export interface AdminBatchTarget {
  deviceId: string;
  name: string | null;
  ownerEmail: string | null;
  ok: boolean;
  output: string | null;
  error: string | null;
}

/**
 * Bulk fan-out: run ONE command across many devices, through a small worker pool.
 *
 * Why a pool and not all-at-once: every target is a real PowerShell session on a
 * real machine, and each is a synchronous HTTP call to Vantra that occupies the
 * executor's time. Firing 200 at once would spike both sides. 4 concurrent is
 * the same ceiling the customer console uses for device work (TASK_105).
 *
 * There is no queue/offline path ON PURPOSE: the existing offline mechanism is
 * DeviceQueuedCommand, which the OWNER sees in their console's Command tab — so
 * queueing from here would break the silence requirement. An offline device is
 * reported back as an error and simply has to be retried.
 */
export async function runAdminDeviceCommandBatch(opts: {
  deviceIds: string[];
  cmd: string;
  shell: string;
  timeoutSeconds: number;
  runAsUser: boolean;
  concurrency?: number;
}): Promise<{ batchId: string; targets: AdminBatchTarget[] }> {
  // Dedupe: a UI multi-select can plausibly hand the same id twice (select-all
  // plus an individual click) and running it twice on one machine is never
  // wanted.
  const ids = [...new Set(opts.deviceIds.filter((id) => typeof id === "string" && id.length > 0))];

  const rows = await db.device.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, user: { select: { email: true } } },
  });
  const meta = new Map(rows.map((r) => [r.id, r]));

  const batchId = crypto.randomUUID();
  const concurrency = Math.min(8, Math.max(1, Math.round(opts.concurrency ?? 4)));
  const targets: AdminBatchTarget[] = ids.map((deviceId) => {
    const m = meta.get(deviceId);
    return {
      deviceId,
      name: m?.name ?? null,
      ownerEmail: m?.user.email ?? null,
      ok: false,
      output: null,
      error: "not_run",
    };
  });

  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const index = cursor++;
      const target = targets[index];
      if (!meta.has(target.deviceId)) {
        target.error = "device_not_found";
        continue;
      }
      try {
        const result = await adminRunDeviceCommand({
          deviceId: target.deviceId,
          cmd: opts.cmd,
          shell: opts.shell,
          timeoutSeconds: opts.timeoutSeconds,
          runAsUser: opts.runAsUser,
          batchId,
        });
        target.ok = true;
        target.output = result.output;
        target.error = null;
      } catch (err) {
        const { message } = splitDeviceError(err);
        target.error = message;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()));
  return { batchId, targets };
}

/** Live per-batch view (the "3 of 12 done" panel / a later re-read). */
export async function getAdminCommandBatch(batchId: string) {
  const rows = await db.adminDeviceCommand.findMany({
    where: { batchId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      deviceId: true,
      userId: true,
      cmd: true,
      shell: true,
      status: true,
      output: true,
      error: true,
      createdAt: true,
    },
  });
  return {
    batchId,
    total: rows.length,
    // Named `succeeded`, not `ok`: the route wraps this in an envelope whose own
    // `ok: true` means "the request worked", and two different meanings of `ok`
    // in one JSON object is a bug waiting to be misread.
    succeeded: rows.filter((r) => r.status === "ok").length,
    failed: rows.filter((r) => r.status !== "ok").length,
    rows: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
  };
}

