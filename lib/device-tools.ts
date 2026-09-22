import "server-only";

import crypto from "node:crypto";

import { db } from "./db";
import { env } from "./env";
import { getAdminSettings } from "./admin-settings";
import { recordAgentActionAudit } from "./devices";

// Task 95 — Devices v2 tool parity. Every device tool (remote control,
// maintenance overlay, PIN request, queued commands) is a GATED proposal:
// create → approve → execute through Vantra's internal sw routes (same
// fail-closed bearer posture as lib/vantra-link.ts, TASK_93). Ownership is
// ALWAYS resolved from OUR db (device.userId === session userId) — never from
// the request path. The TRMM-keyed executor lives on Vantra; it refuses any
// agent outside the caller's `sw-<userId>` org.

const VANTRA_URL =
  process.env.VANTRA_INTERNAL_URL?.replace(/\/$/, "") || "https://vantra.spaceworker.top";

function swHeaders(): Record<string, string> {
  const token = process.env.VANTRA_INTERNAL_TOKEN;
  // Fail closed (TASK_93 posture): no token = throw, never call unauthenticated.
  if (!token || token.trim().length === 0) {
    throw new Error("vantra_not_configured");
  }
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

async function vantraFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${VANTRA_URL}${path}`, {
    ...init,
    headers: { ...swHeaders(), ...init?.headers },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`vantra_${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}


// ---------------------------------------------------------------------------
// Ownership helper — the single gate every tool flows through.
// ---------------------------------------------------------------------------

async function requireOwnedDevice(opts: {
  userId: string;
  deviceId: string;
}): Promise<{ id: string; vantraAgentId: string; name: string; deviceKind: string }> {
  const deviceRow = await db.device.findFirst({
    where: { id: opts.deviceId, userId: opts.userId },
    select: { id: true, vantraAgentId: true, name: true, deviceKind: true },
  });
  if (!deviceRow?.vantraAgentId) throw new Error("device_not_linked");
  return { id: deviceRow.id, vantraAgentId: deviceRow.vantraAgentId, name: deviceRow.name, deviceKind: deviceRow.deviceKind };
}

// ---------------------------------------------------------------------------
// Remote control (MeshCentral) — approval-scoped URL fetch. The approve call
// returns the URLs once; GET mesh-urls re-fetches ONLY for an action the same
// user approved on this device within the TTL (status executed, recent).
// ---------------------------------------------------------------------------

export interface MeshUrlsView {
  hostname: string;
  control: string;
  terminal: string;
  file: string;
  status: string;
  client: string;
  site: string;
  controlViewOnly?: string;
}

const MESH_REFETCH_TTL_MS = 10 * 60 * 1000;

export async function fetchMeshUrls(opts: {
  userId: string;
  deviceId: string;
  pendingActionId?: string;
}): Promise<MeshUrlsView> {
  const device = await requireOwnedDevice(opts);
  if (opts.pendingActionId) {
    const pending = await db.agentPendingAction.findFirst({
      where: {
        id: opts.pendingActionId,
        userId: opts.userId,
        kind: "device",
        status: "executed",
        createdAt: { gt: new Date(Date.now() - MESH_REFETCH_TTL_MS) },
      },
      select: { id: true },
    });
    if (!pending) throw new Error("no_active_grant");
  }

  const { urls } = await vantraFetch<{ ok: boolean; urls: MeshUrlsView }>(
    `/api/internal/sw/devices/${encodeURIComponent(device.vantraAgentId)}/mesh-urls`,
  );
  return urls;
}

// ---------------------------------------------------------------------------
// PIN request — one-time token; the device POSTs the PIN to OUR public
// callback; the user reads the PIN from their Devices page.
// ---------------------------------------------------------------------------

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const PIN_REQUEST_TTL_MS = 30 * 60 * 1000;
const PIN_LENGTHS: ReadonlySet<number> = new Set([4, 6, 8]);

export async function executePinRequest(opts: {
  userId: string;
  deviceId: string;
  pendingActionId: string;
  pinLength: number;
  approvalChannel?: string;
}): Promise<{ pinRequestId: string; expiresAt: Date }> {
  if (!PIN_LENGTHS.has(opts.pinLength)) throw new Error("bad_pin_length");
  const device = await requireOwnedDevice(opts);

  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + PIN_REQUEST_TTL_MS);
  const row = await db.devicePinRequest.create({
    data: {
      deviceId: device.id,
      userId: opts.userId,
      pinLength: opts.pinLength,
      tokenHash: sha256(token),
      expiresAt,
    },
    select: { id: true },
  });

  // The callback URL is OUR public endpoint; the raw token travels to the
  // device inside the prompt script (one-time, stored only as a hash here).
  const callbackUrl = `${env.appBaseUrl.replace(/\/$/, "")}/api/devices/pin-callback`;
  await vantraFetch(
    `/api/internal/sw/devices/${encodeURIComponent(device.vantraAgentId)}/pin-request`,
    { method: "POST", body: JSON.stringify({ pinLength: opts.pinLength, callbackUrl, token }) },
  );

  await recordAgentActionAudit({
    userId: opts.userId,
    pendingActionId: opts.pendingActionId,
    action: "device_pin-request",
    status: "executed",
    approvalChannel: opts.approvalChannel ?? "web",
    sourceDeviceId: device.id,
    detail: { pinRequestId: row.id, pinLength: opts.pinLength }, // never the token, never the pin
  });
  return { pinRequestId: row.id, expiresAt };
}

/** Public-callback processor: one-time token → store the PIN, mark submitted. */
export async function submitPinCallback(opts: {
  token: string;
  pin: string;
  sourceIp?: string;
}): Promise<{ ok: true; pinLength: number }> {
  if (!opts.pin || opts.pin.length < 4 || opts.pin.length > 8) {
    throw new Error("bad_pin");
  }
  const row = await db.devicePinRequest.findUnique({
    where: { tokenHash: sha256(opts.token) },
  });
  if (!row || row.status !== "pending" || row.expiresAt.getTime() < Date.now()) {
    // Same response for unknown token / wrong state / expired — no oracle.
    throw new Error("invalid_token");
  }
  if (opts.pin.length !== row.pinLength) throw new Error("bad_pin");
  await db.devicePinRequest.update({
    where: { id: row.id },
    data: {
      status: "submitted",
      pin: opts.pin,
      submittedAt: new Date(),
      sourceIp: opts.sourceIp?.slice(0, 64) ?? null,
    },
  });
  return { ok: true, pinLength: row.pinLength };
}


// ---------------------------------------------------------------------------
// Maintenance overlay — start/stop as a gated action.
// ---------------------------------------------------------------------------

export async function startMaintenanceOverlayAction(opts: {
  userId: string;
  deviceId: string;
  pendingActionId: string;
  customImageBase64?: string;
  customImageExt?: string;
  approvalChannel?: string;
}): Promise<void> {
  const device = await requireOwnedDevice(opts);
  await vantraFetch(
    `/api/internal/sw/devices/${encodeURIComponent(device.vantraAgentId)}/maintenance`,
    {
      method: "POST",
      body: JSON.stringify({
        action: "start",
        ...(opts.customImageBase64 && opts.customImageExt
          ? { customImageBase64: opts.customImageBase64, customImageExt: opts.customImageExt }
          : {}),
      }),
    },
  );
  await recordAgentActionAudit({
    userId: opts.userId,
    pendingActionId: opts.pendingActionId,
    action: "device_maintenance-start",
    status: "executed",
    approvalChannel: opts.approvalChannel ?? "web",
    sourceDeviceId: device.id,
  });
}

export async function stopMaintenanceOverlayAction(opts: {
  userId: string;
  deviceId: string;
  pendingActionId: string;
  approvalChannel?: string;
}): Promise<void> {
  const device = await requireOwnedDevice(opts);
  await vantraFetch(
    `/api/internal/sw/devices/${encodeURIComponent(device.vantraAgentId)}/maintenance`,
    { method: "POST", body: JSON.stringify({ action: "stop" }) },
  );
  await recordAgentActionAudit({
    userId: opts.userId,
    pendingActionId: opts.pendingActionId,
    action: "device_maintenance-stop",
    status: "executed",
    approvalChannel: opts.approvalChannel ?? "web",
    sourceDeviceId: device.id,
  });
}

// ---------------------------------------------------------------------------
// Queued commands — the "timed command for an offline device" tool. Vantra
// owns the ONE queue + online-transition sweep (fires the moment the device
// checks in); SpaceWorker mirrors rows for ownership/cancel and polls status.
// NO second sweep here — that would double-fire commands.
// ---------------------------------------------------------------------------

export interface QueuedCommandView {
  id: string;
  shell: string;
  cmd: string;
  timeoutSeconds: number;
  runAsUser: boolean;
  status: string;
  createdAt: Date;
  sentAt: Date | null;
  error: string | null;
}

export async function createQueuedCommand(opts: {
  userId: string;
  deviceId: string;
  cmd: string;
  shell: string;
  timeoutSeconds: number;
  runAsUser: boolean;
}): Promise<QueuedCommandView> {
  const device = await requireOwnedDevice(opts);
  const row = await db.deviceQueuedCommand.create({
    data: {
      deviceId: device.id,
      userId: opts.userId,
      shell: opts.shell === "cmd" ? "cmd" : "powershell",
      cmd: opts.cmd,
      timeoutSeconds: opts.timeoutSeconds,
      runAsUser: opts.runAsUser,
    },
    select: { id: true },
  });
  const { queueId } = await vantraFetch<{ ok: boolean; queueId: string }>(
    `/api/internal/sw/devices/${encodeURIComponent(device.vantraAgentId)}/queued-commands`,
    {
      method: "POST",
      body: JSON.stringify({
        cmd: opts.cmd,
        shell: opts.shell === "cmd" ? "cmd" : "powershell",
        timeout: opts.timeoutSeconds,
        runAsUser: opts.runAsUser,
        swRef: row.id,
      }),
    },
  );
  const updated = await db.deviceQueuedCommand.update({
    where: { id: row.id },
    data: { vantraQueueId: queueId },
  });
  return toQueuedView(updated);
}

export async function listQueuedCommands(opts: {
  userId: string;
  deviceId: string;
}): Promise<QueuedCommandView[]> {
  await requireOwnedDevice(opts);
  const rows = await db.deviceQueuedCommand.findMany({
    where: { deviceId: opts.deviceId, userId: opts.userId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  // Refresh terminal states from Vantra's queue (the sweep flips rows there).
  const vantra = await listVantraQueued(opts.deviceId).catch(() => null);
  if (vantra) {
    const byVantraId = new Map(vantra.map((c) => [c.id, c]));
    for (const row of rows) {
      if (!row.vantraQueueId) continue;
      const remote = byVantraId.get(row.vantraQueueId);
      if (remote && remote.status !== row.status) {
        await db.deviceQueuedCommand.update({
          where: { id: row.id },
          data: { status: remote.status, sentAt: remote.sentAt, error: remote.error },
        });
        row.status = remote.status;
        row.sentAt = remote.sentAt;
        row.error = remote.error;
      }
    }
  }
  return rows.map(toQueuedView);
}

async function listVantraQueued(deviceId: string) {
  const device = await db.device.findUnique({
    where: { id: deviceId },
    select: { vantraAgentId: true },
  });
  if (!device?.vantraAgentId) throw new Error("device_not_linked");
  const { commands } = await vantraFetch<{
    ok: boolean;
    commands: Array<{
      id: string; shell: string; cmd: string; timeoutSeconds: number;
      runAsUser: boolean; status: string; createdAt: string; sentAt: string | null;
      error: string | null;
    }>;
  }>(`/api/internal/sw/devices/${encodeURIComponent(device.vantraAgentId)}/queued-commands`);
  return commands.map((c) => ({
    id: c.id,
    status: c.status,
    sentAt: c.sentAt ? new Date(c.sentAt) : null,
    error: c.error,
  }));
}

export async function cancelQueuedCommand(opts: {
  userId: string;
  deviceId: string;
  queuedCommandId: string;
}): Promise<void> {
  const device = await requireOwnedDevice(opts);
  const row = await db.deviceQueuedCommand.findFirst({
    where: {
      id: opts.queuedCommandId,
      deviceId: device.id,
      userId: opts.userId,
      status: "queued",
    },
  });
  if (!row) throw new Error("not_queued");
  if (row.vantraQueueId) {
    await vantraFetch(
      `/api/internal/sw/devices/${encodeURIComponent(device.vantraAgentId)}/queued-commands`,
      { method: "DELETE", body: JSON.stringify({ queueId: row.vantraQueueId }) },
    ).catch((err) => {
      // 409 = the sweep fired it between click and call — mirror shows sent.
      if (!String(err).includes("vantra_409")) throw err;
    });
  }
  await db.deviceQueuedCommand.update({ where: { id: row.id }, data: { status: "cancelled" } });
}

function toQueuedView(row: {
  id: string; shell: string; cmd: string; timeoutSeconds: number;
  runAsUser: boolean; status: string; createdAt: Date; sentAt: Date | null;
  error: string | null;
}): QueuedCommandView {
  return {
    id: row.id,
    shell: row.shell,
    cmd: row.cmd,
    timeoutSeconds: row.timeoutSeconds,
    runAsUser: row.runAsUser,
    status: row.status,
    createdAt: row.createdAt,
    sentAt: row.sentAt,
    error: row.error,
  };
}

// ---------------------------------------------------------------------------
// PIN request — user-side status (the device POSTs the PIN to OUR public
// callback; the owner reads it here, once, from their own session).
// ---------------------------------------------------------------------------

export async function listPinRequests(opts: {
  userId: string;
  deviceId: string;
}): Promise<
  Array<{ id: string; pinLength: number; status: string; pin: string | null; expiresAt: Date; createdAt: Date }>
> {
  await requireOwnedDevice(opts);
  const rows = await db.devicePinRequest.findMany({
    where: { deviceId: opts.deviceId, userId: opts.userId },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return rows.map((r) => ({
    id: r.id,
    pinLength: r.pinLength,
    status: r.status,
    pin: r.pin, // owner-only read, session-authed; row is prunable
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
  }));
}


