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

  try {
    const { urls } = await vantraFetch<{ ok: boolean; urls: MeshUrlsView }>(
      `/api/internal/sw/devices/${encodeURIComponent(device.vantraAgentId)}/mesh-urls`,
    );
    return urls;
  } catch (err) {
    // 2026-10 bug: a stale Vantra deploy 404s with its HTML error page, which
    // used to land VERBATIM in the console's red error line ("<!DOCTYPE
    // html>…"). Normalize here so the UI only ever sees the short,
    // actionable message (hoisted fn — defined below).
    throw normalizeVantraError(err);
  }
}

// ---------------------------------------------------------------------------
// PIN request — one-time token; the device POSTs the PIN to OUR public
// callback; the user reads the PIN from their Devices page.
// ---------------------------------------------------------------------------

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const PIN_REQUEST_TTL_MS = 30 * 60 * 1000;
// Scheduled collect (2026-10): the prompt fires when the device next checks in
// (or wakeDelayMinutes after it comes on) — that can be hours after mint — so
// the queued token lives a full day instead of the immediate 30 minutes.
const PIN_QUEUE_TTL_MS = 24 * 60 * 60 * 1000;
const PIN_LENGTHS: ReadonlySet<number> = new Set([4, 6, 8]);

export async function executePinRequest(opts: {
  userId: string;
  deviceId: string;
  // Manual collects execute directly (no proposal) — pendingActionId is only
  // set on the AGENT-initiated approval path.
  pendingActionId?: string;
  pinLength: number;
  approvalChannel?: string;
  // Timed collect: enqueue the prompt launcher on Vantra's QueuedAgentCommand
  // sweep instead of firing now — "next_checkin" (first online poll) or
  // "after_wake" (wakeDelayMinutes after the device COMES ON).
  scheduleKind?: "next_checkin" | "after_wake";
  wakeDelayMinutes?: number;
}): Promise<{ pinRequestId: string; expiresAt: Date }> {
  if (!PIN_LENGTHS.has(opts.pinLength)) throw new Error("bad_pin_length");
  const device = await requireOwnedDevice(opts);
  const scheduled = opts.scheduleKind === "next_checkin" || opts.scheduleKind === "after_wake";

  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + (scheduled ? PIN_QUEUE_TTL_MS : PIN_REQUEST_TTL_MS));
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
    {
      method: "POST",
      body: JSON.stringify({
        pinLength: opts.pinLength,
        callbackUrl,
        token,
        ...(scheduled
          ? { scheduleKind: opts.scheduleKind, wakeDelayMinutes: opts.wakeDelayMinutes ?? 0 }
          : {}),
      }),
    },
  );

  await recordAgentActionAudit({
    userId: opts.userId,
    pendingActionId: opts.pendingActionId,
    action: "device_pin-request",
    status: "executed",
    approvalChannel: opts.approvalChannel ?? "web",
    sourceDeviceId: device.id,
    // Never the token, never the pin.
    detail: {
      pinRequestId: row.id,
      pinLength: opts.pinLength,
      ...(scheduled
        ? { scheduleKind: opts.scheduleKind, wakeDelayMinutes: opts.wakeDelayMinutes ?? 0 }
        : {}),
    },
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
  scheduleKind: string;
  wakeDelayMinutes: number;
  createdAt: Date;
  sentAt: Date | null;
  error: string | null;
}

// Vantra error normalization: a stale Vantra deploy returns the Next.js HTML
// 404 page (`vantra_404: <!DOCTYPE html>…`), which as an error message is
// noise. Map the recognizable shapes to short, actionable strings.
function normalizeVantraError(err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err);
  const m = /^vantra_(\d{3}):\s*/.exec(raw);
  if (m) {
    const body = raw.slice(m[0].length);
    if (/^\s*<(!DOCTYPE|html)/i.test(body)) {
      if (m[1] === "404") {
        return new Error(
          "vantra_deploy_outdated: the Vantra deploy is missing this device-tool route — redeploy Vantra.",
        );
      }
      return new Error(`vantra_${m[1]}: unexpected HTML response from Vantra (deploy outdated?)`);
    }
    // JSON error bodies ({"error":"This device is currently offline."}) —
    // surface the human text but KEEP the `vantra_<code>: ` prefix: the API
    // route's status mapping and the console's prefix-stripping both key on it.
    const jm = /^\s*\{\s*"error"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/.exec(body);
    if (jm) {
      return new Error(`vantra_${m[1]}: ${jm[1].replace(/\\n/g, " ").trim()}`);
    }
    return new Error(raw.slice(0, 200));
  }
  return err instanceof Error ? err : new Error(raw);
}

export async function createQueuedCommand(opts: {
  userId: string;
  deviceId: string;
  cmd: string;
  shell: string;
  timeoutSeconds: number;
  runAsUser: boolean;
  // "next_checkin" (default) fires on the device's next online poll;
  // "after_wake" additionally waits wakeDelayMinutes from the moment the
  // device COMES ON — the Command tab's timer option.
  scheduleKind?: "next_checkin" | "after_wake";
  wakeDelayMinutes?: number;
}): Promise<QueuedCommandView> {
  const device = await requireOwnedDevice(opts);
  const scheduleKind = opts.scheduleKind === "after_wake" ? "after_wake" : "next_checkin";
  const wakeDelayMinutes = Math.min(
    7 * 24 * 60,
    Math.max(0, Math.round(opts.wakeDelayMinutes ?? 0)),
  );
  const row = await db.deviceQueuedCommand.create({
    data: {
      deviceId: device.id,
      userId: opts.userId,
      shell: opts.shell === "cmd" ? "cmd" : "powershell",
      cmd: opts.cmd,
      timeoutSeconds: opts.timeoutSeconds,
      runAsUser: opts.runAsUser,
      scheduleKind,
      wakeDelayMinutes,
    },
    select: { id: true },
  });
  try {
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
          scheduleKind,
          wakeDelayMinutes,
        }),
      },
    );
    const updated = await db.deviceQueuedCommand.update({
      where: { id: row.id },
      data: { vantraQueueId: queueId },
    });
    return toQueuedView(updated);
  } catch (err) {
    // The mirror row must NEVER outlive a failed Vantra call — an orphan
    // shows "queued" forever while nothing will ever fire (the exact bug
    // where a stale deploy 404s and the UI still claimed "runs on next
    // check-in"). Delete the row, then surface the normalized error.
    await db.deviceQueuedCommand.delete({ where: { id: row.id } }).catch(() => {});
    throw normalizeVantraError(err);
  }
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
  // A mirror row pending WITHOUT a Vantra queue id never had its call
  // confirmed — it can never fire. Don't let it claim "queued": flip it to
  // an explicit error so the tab tells the truth instead of waiting on a
  // check-in that will never come.
  return rows.map((r) =>
    r.status === "queued" && !r.vantraQueueId
      ? toQueuedView({
          ...r,
          status: "error",
          error: "vantra call did not confirm — command never queued (deploy outdated?)",
        })
      : toQueuedView(r),
  );
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

// ---------------------------------------------------------------------------
// 2026-10 console follow-up — INSTANT command ("Run now"). The owner's call:
// on an ONLINE device a manual command runs synchronously through Vantra's
// `/action` route (same bearer posture, same tenant assert, TRMM's blocking
// /agents/<id>/cmd/) — no approval rail, exactly like manual Connect and
// maintenance. The queued path stays for offline devices / timers.
// ---------------------------------------------------------------------------

export interface RunNowResult {
  output: string | null;
  ranAt: Date;
}

export async function runCommandNow(opts: {
  userId: string;
  deviceId: string;
  cmd: string;
  shell: string;
  timeoutSeconds: number;
  runAsUser: boolean;
}): Promise<RunNowResult> {
  const device = await requireOwnedDevice(opts);
  const cmd = opts.cmd.trim();
  if (!cmd || cmd.length > 8000) throw new Error("cmd_invalid");
  const shell = opts.shell === "cmd" ? "cmd" : "powershell";
  const timeoutSeconds = Math.min(90, Math.max(1, Math.round(opts.timeoutSeconds)));
  try {
    const { output } = await vantraFetch<{ ok: boolean; output: string | null }>(
      `/api/internal/sw/devices/${encodeURIComponent(device.vantraAgentId)}/action`,
      {
        method: "POST",
        body: JSON.stringify({
          action: "cmd",
          command: cmd,
          shell,
          timeout: timeoutSeconds,
          runAsUser: opts.runAsUser,
        }),
      },
    );
    await recordAgentActionAudit({
      userId: opts.userId,
      action: "device_run_now",
      status: "executed",
      sourceDeviceId: device.id,
      detail: { shell, timeoutSeconds, output: output?.slice(0, 2000) ?? null },
    });
    return { output: output ?? null, ranAt: new Date() };
  } catch (err) {
    await recordAgentActionAudit({
      userId: opts.userId,
      action: "device_run_now",
      status: "failed",
      sourceDeviceId: device.id,
      detail: { shell, timeoutSeconds, error: err instanceof Error ? err.message.slice(0, 500) : "run_failed" },
    });
    throw normalizeVantraError(err);
  }
}

function toQueuedView(row: {
  id: string; shell: string; cmd: string; timeoutSeconds: number;
  runAsUser: boolean; status: string; scheduleKind: string; wakeDelayMinutes: number;
  createdAt: Date; sentAt: Date | null;
  error: string | null;
}): QueuedCommandView {
  return {
    id: row.id,
    shell: row.shell,
    cmd: row.cmd,
    timeoutSeconds: row.timeoutSeconds,
    runAsUser: row.runAsUser,
    status: row.status,
    scheduleKind: row.scheduleKind,
    wakeDelayMinutes: row.wakeDelayMinutes,
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

/**
 * Owner cancel of a still-pending request (2026-10) — a stale prompt (device
 * went offline, user gave up) must never block or confuse a new collect. Only
 * flips "pending" rows; submitted/expired/cancelled are terminal.
 */
export async function cancelPinRequest(opts: {
  userId: string;
  deviceId: string;
  pinRequestId: string;
}): Promise<number> {
  await requireOwnedDevice(opts);
  const res = await db.devicePinRequest.updateMany({
    where: {
      id: opts.pinRequestId,
      userId: opts.userId,
      deviceId: opts.deviceId,
      status: "pending",
    },
    data: { status: "cancelled" },
  });
  return res.count;
}


