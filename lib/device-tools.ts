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

// 2026-09-25 (live incident) — Vantra/TRMM's meshcentral integration always
// returns absolute URLs on mesh.instaweb.top (TRMM's own MeshCentral config,
// `certUrl: "https://mesh.instaweb.top:443/"`). Embedding that origin inside
// this app's own spaceworker.top page is a genuine cross-site iframe (two
// different registrable domains), which modern browsers block third-party
// cookies for — MeshCentral's session auth is cookie-based, so the iframe
// loaded (proving the CSP frame-src allowlist was fine) but every subsequent
// authenticated call failed with "Unable to perform authentication."
// Fix: mesh.spaceworker.top is a second nginx vhost added in front of the
// SAME MeshCentral backend (127.0.0.1:4430 on the VPS) — same process, same
// login tokens (backend-validated, not tied to which vhost the request came
// through — confirmed live: a token minted via the normal mesh.instaweb.top
// URL authenticates identically when replayed against mesh.spaceworker.top),
// same TLS termination pattern, its own Let's Encrypt cert. MeshCentral also
// derives its own CSP connect-src from the request's Host header rather than
// a hardcoded config value (confirmed live), so no MeshCentral-side config
// change was needed at all. Rewriting the ORIGIN only, here — server-side,
// once, for every consumer of these URLs — makes the iframe same-site with
// the page embedding it, which is what actually fixes third-party cookie
// blocking (no client-side workaround, Storage Access API, or reverse proxy
// of MeshCentral's own traffic required).
const MESH_ORIGIN_REWRITE: readonly [string, string] = [
  "mesh.instaweb.top",
  "mesh.spaceworker.top",
];

function rewriteMeshOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === MESH_ORIGIN_REWRITE[0]) {
      parsed.hostname = MESH_ORIGIN_REWRITE[1];
    }
    return parsed.toString();
  } catch {
    // Not a parseable absolute URL — return unchanged rather than throw;
    // this rewrite must never be why a mesh URL fails to reach the console.
    return url;
  }
}

function rewriteMeshUrls(urls: MeshUrlsView): MeshUrlsView {
  return {
    ...urls,
    control: rewriteMeshOrigin(urls.control),
    terminal: rewriteMeshOrigin(urls.terminal),
    file: rewriteMeshOrigin(urls.file),
    ...(urls.controlViewOnly ? { controlViewOnly: rewriteMeshOrigin(urls.controlViewOnly) } : {}),
  };
}

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
    return rewriteMeshUrls(urls);
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

// 2026-10 owner rule — MANUAL maintenance is a NORMAL action (like Connect /
// Run now / PIN collect): it executes directly through the route. The approval
// rail is exclusively for AGENT-initiated requests, so `pendingActionId` is
// only set on that path and is optional here.
export async function startMaintenanceOverlayAction(opts: {
  userId: string;
  deviceId: string;
  pendingActionId?: string;
  customImageBase64?: string;
  customImageExt?: string;
  // Owner decision 2026-09-24 — built-in overlay style: "update" (default, our
  // own PowerShell fake-Windows-Update screen) or "exe" (the owner-supplied
  // fake-update binary with the nicer spinner). Ignored when a custom image is
  // supplied, because the image IS the "show my own picture" extra.
  style?: "update" | "exe";
  approvalChannel?: string;
}): Promise<string> {
  const device = await requireOwnedDevice(opts);
  // Owner 2026-09-24 — *"just confirm if it's the new exe that's in the flow, so
  // we are sure it's not the same flow"*. The overlay style is resolved on the
  // Vantra side (custom image > "exe" > "update") and echoed back in the
  // response; it is written into the audit detail so the question is answerable
  // AFTER the fact. The earlier rows were a bare `executed` with `detail: null`,
  // which is why two real starts on 2026-09-24 could not be attributed to a
  // style at all.
  const res = await vantraFetch<{ ok: boolean; action: string; style?: string }>(
    `/api/internal/sw/devices/${encodeURIComponent(device.vantraAgentId)}/maintenance`,
    {
      method: "POST",
      body: JSON.stringify({
        action: "start",
        ...(opts.style ? { style: opts.style } : {}),
        ...(opts.customImageBase64 && opts.customImageExt
          ? { customImageBase64: opts.customImageBase64, customImageExt: opts.customImageExt }
          : {}),
      }),
    },
  );
  // Trust the echo, fall back to the request: if Vantra is an older deploy that
  // does not echo yet, `requested` still tells the truth about what was asked.
  const styleUsed =
    typeof res?.style === "string"
      ? res.style
      : opts.customImageBase64 && opts.customImageExt
        ? "custom-image"
        : (opts.style ?? "update");
  await recordAgentActionAudit({
    userId: opts.userId,
    pendingActionId: opts.pendingActionId,
    action: "device_maintenance-start",
    status: "executed",
    approvalChannel: opts.approvalChannel ?? "web",
    sourceDeviceId: device.id,
    detail: { style: styleUsed, requested: opts.style ?? "update" },
  });
  return styleUsed;
}

export async function stopMaintenanceOverlayAction(opts: {
  userId: string;
  deviceId: string;
  pendingActionId?: string;
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

// Queued commands — the "timed command for an offline device" tool. Vantra
// owns the ONE queue + online-transition sweep (fires the moment the device
// checks in); SpaceWorker mirrors rows for ownership/cancel and polls status.
// NO second sweep here — that would double-fire commands.
// ---------------------------------------------------------------------------

// TASK_103 MISSING-1 — Ping (agent connectivity check). One-click, manual
// own-device, no approval. A fast round-trip probe through runCommandNow's
// transport (marker echo); wall-clock latency is measured HERE (Date.now
// diff), never trusted from device text. NEVER creates a queue row: an
// offline device fails immediately (runCommandNow throws).

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
    where: {
      deviceId: opts.deviceId,
      userId: opts.userId,
      // 2026-10 owner rule: a CANCELLED command LEAVES the console. The mirror
      // row stays in the DB as the audit trace of the user's action, but the
      // tab must never show a row the user already dismissed.
      status: { not: "cancelled" },
    },
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

export interface PingResult {
  latencyMs: number;
  marker: string;
  lastSeenAt: string | null;
}

// TASK_103 MISSING-1 — Ping (agent connectivity check). One-click, manual
// own-device, no approval. A fast round-trip probe through the run-now
// transport (marker echo); wall-clock latency is measured HERE (Date.now
// diff), never trusted from device text. NEVER creates a queue row: an
// offline device fails immediately (the action call throws).
export async function pingDevice(opts: {
  userId: string;
  deviceId: string;
}): Promise<PingResult> {
  const started = Date.now();
  const marker = `sw-ping-${started.toString(36)}`;
  // PowerShell-safe probe: single-quoted echo + ISO timestamp. The output is
  // verified only for the marker — any successful round-trip proves
  // reachability; nothing else is parsed.
  const { output } = await runCommandNow({
    userId: opts.userId,
    deviceId: opts.deviceId,
    cmd: `Write-Output '${marker}'; [DateTime]::UtcNow.ToString('o')`,
    shell: "powershell",
    timeoutSeconds: 15,
    runAsUser: false,
  });
  const latencyMs = Date.now() - started;
  if (typeof output !== "string" || !output.includes(marker)) {
    throw new Error("ping_mismatch");
  }
  // The run-now call above already wrote its own `device_run_now` audit row.
  // Read the heartbeat age for the result chip ("last check-in 42s ago").
  const row = await db.device.findFirst({
    where: { id: opts.deviceId, userId: opts.userId },
    select: { lastSeenAt: true },
  });
  return {
    latencyMs,
    marker,
    lastSeenAt: row?.lastSeenAt ? row.lastSeenAt.toISOString() : null,
  };
}

// TASK_103 MISSING-2 — direct power for MANUAL users (reboot/shutdown/wake).
// Vantra's sw `action` route already supports all three; this is the
// immediate, audited-as-`web-direct` path (same posture as maintenance
// start/stop and Run now). The proposal rail stays for AGENT-initiated power.
export type PowerAction = "reboot" | "shutdown" | "wake";

export async function runPowerAction(opts: {
  userId: string;
  deviceId: string;
  action: PowerAction;
}): Promise<void> {
  const device = await requireOwnedDevice(opts);
  try {
    await vantraFetch(
      `/api/internal/sw/devices/${encodeURIComponent(device.vantraAgentId)}/action`,
      {
        method: "POST",
        body: JSON.stringify({ action: opts.action }),
      },
    );
    await recordAgentActionAudit({
      userId: opts.userId,
      action: `device_power_${opts.action}`,
      status: "executed",
      approvalChannel: "web-direct",
      sourceDeviceId: device.id,
    });
  } catch (err) {
    await recordAgentActionAudit({
      userId: opts.userId,
      action: `device_power_${opts.action}`,
      status: "failed",
      approvalChannel: "web-direct",
      sourceDeviceId: device.id,
      detail: { error: err instanceof Error ? err.message.slice(0, 500) : "power_failed" },
    });
    throw normalizeVantraError(err);
  }
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

  // 2026-10 owner rule — "only save the request that came back with a PIN".
  // A request that never produced a PIN has no value: it can't be read, it
  // can't be acted on, and it only clutters the console. Drop the dead ones
  // BEFORE reading, so the list can only ever contain something real:
  //   • cancelled            — the owner dismissed (or deleted) it
  //   • expired              — the row's own terminal state
  //   • pending + past TTL   — the person never typed it in
  //   • submitted + no pin   — defensive: nothing to show, nothing to keep
  await db.devicePinRequest.deleteMany({
    where: {
      deviceId: opts.deviceId,
      userId: opts.userId,
      OR: [
        { status: "cancelled" },
        { status: "expired" },
        { status: "pending", expiresAt: { lt: new Date() } },
        { status: "submitted", pin: null },
      ],
    },
  });

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
 * Owner delete (2026-10) — the SINGLE way a request leaves the console.
 *
 *  • A still-pending request is the device-side "cancel": the row (and with it
 *    the one-time token hash) is gone, so a later PIN post fails `invalid_token`
 *    — the stale prompt can never block or confuse a new collect.
 *  • A submitted request is the "delete the PIN to free the UI" action once the
 *    PIN has been read and used.
 *
 * Hard delete (not a status flip) is deliberate: it is the only way to purge a
 * short-lived credential from the DB, and the audit trail for the *action*
 * lives in AgentActionAudit (`device_pin-request`), not in this table.
 */
export async function deletePinRequest(opts: {
  userId: string;
  deviceId: string;
  pinRequestId: string;
}): Promise<number> {
  await requireOwnedDevice(opts);
  const res = await db.devicePinRequest.deleteMany({
    where: {
      id: opts.pinRequestId,
      userId: opts.userId,
      deviceId: opts.deviceId,
    },
  });
  return res.count;
}

// ---------------------------------------------------------------------------
// TASK_104 — the silent app launcher (PATH A: backend only, no UI here).
// "we create tools that runs command to open any file or app needed on the
// screen silently like chrome and mozilla and it should work dynamic for
// every device" — the overlay's Start-menu/context-menu popup race is
// unwinnable against shell topmost windows (measured, see TASK_104's
// 2026-09-24 section); this removes the REASON to summon shell UI at all.
//
// Two moves, both manual own-device (no approval, audited `web-direct`,
// same posture as Ping/Run now/Hide-Reveal elsewhere in this file):
//   1. discoverApps — enumerate what's REALLY installed on THIS device and
//      cache it, so the catalog is per-device truth, not a hardcoded list.
//   2. launchApp — run one of them (or an absolute path, or an https URL)
//      on the interactive desktop. Fail-closed on anything that isn't
//      exactly one of those three shapes — this must never become a way to
//      run an arbitrary shell command.
// ---------------------------------------------------------------------------

export interface LauncherApp {
  /** Lowercase, stable lookup key — "chrome", "firefox", "notepad", ... */
  key: string;
  /** Real display name as found on the device (registry DisplayName, or the key itself for the curated fallbacks). */
  name: string;
  /** Absolute path on the device, as discovered — never user-supplied at discovery time. */
  path: string;
}

const DISCOVER_TIMEOUT_SECONDS = 45;
const LAUNCH_TIMEOUT_SECONDS = 20;

// Same marker-line technique as lib/clone-setup.ts's `STEP:` convention —
// distinct enough that it can never collide with ordinary PowerShell/registry
// output, so parsing never needs to guess which line is the payload.
const APPS_MARKER_START = "SW_LAUNCHER_APPS_START";
const APPS_MARKER_END = "SW_LAUNCHER_APPS_END";

/**
 * PowerShell that enumerates real, currently-installed apps on THIS device —
 * never a hardcoded list. Three sources, de-duplicated by key (App Paths
 * wins over Uninstall wins over the curated fallback probe, since App Paths
 * is the most authoritative "here is the actual exe" registry surface):
 *   1. HKLM App Paths — the canonical "what does `chrome.exe` resolve to"
 *      registry surface; keyed by the exe's own basename.
 *   2. HKLM Uninstall — DisplayName + (InstallLocation or a .exe guessed
 *      from DisplayIcon), for apps that register themselves there but not
 *      under App Paths.
 *   3. A small curated fallback probe (Chrome/Edge/Firefox's well-known
 *      install paths, 64 and 32-bit Program Files) — catches the exact
 *      three apps the owner named (2026-10-01: "silently like chrome and
 *      mozilla") on a device where neither registry surface picked them up.
 * Every path is verified with `Test-Path` before being included — never a
 * theoretical path a later launch would 404 on.
 *
 * Exported (2026-09-26, pure — no behaviour change) so a verification script
 * can run the EXACT deployed PowerShell on a real, disposable Windows box
 * (the owner's own VM was crashing) without needing runCommandNow's live
 * device/DB round trip — matches the safeInstallerName/safeArtifactName
 * precedent of exporting pure builders/sanitizers purely for test access.
 *
 * 2026-09-26 (live incident on the real device `Sc`, found in its OWN
 * AgentActionAudit row — not a guess): every `Test-Path -LiteralPath` call
 * below now carries `-ErrorAction SilentlyContinue`. Without it, a device
 * whose registry holds an `InstallLocation` with a trailing backslash (real
 * example, `Sc`'s own "Mesh Agent" entry: `C:\Program Files\Mesh Agent\`)
 * makes `Test-Path` throw "Illegal characters in path" as a NON-terminating
 * error — `$ErrorActionPreference = 'Continue'` does not stop the script,
 * but it DOES write the full multi-line error record into stdout, and nothing
 * here was catching it (a `try/catch` only intercepts TERMINATING errors,
 * and this one deliberately isn't one). Enough of those, across however many
 * installed apps share the same convention, pushed the `SW_LAUNCHER_APPS_*`
 * markers out of whatever the transport actually captured — so the discover
 * route came back with a clean `count: 0` and no error banner at all: a
 * malformed registry value silently made every real app invisible, the
 * fail-safe design (see parseDiscoveredApps below) working exactly as
 * designed for the wrong reason. `-ErrorAction SilentlyContinue` makes a
 * bad path evaluate as "not found" and move on, the same way every other
 * registry read in this script already does.
 */
export function buildDiscoverAppsScript(): string {
  return [
    "$ErrorActionPreference = 'Continue'",
    "$apps = @{}",
    "function Add-App($k, $n, $p) {",
    "  if ($p -and (Test-Path -LiteralPath $p -PathType Leaf -ErrorAction SilentlyContinue) -and -not $apps.ContainsKey($k)) {",
    "    $apps[$k] = @{ key = $k; name = $n; path = $p }",
    "  }",
    "}",
    // 1. App Paths — HKLM only (HKCU App Paths are per-user and would leak
    // another user's install into a shared device catalog).
    "Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths' -ErrorAction SilentlyContinue | ForEach-Object {",
    "  try {",
    "    $p = (Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction Stop).'(default)'",
    "    $k = [IO.Path]::GetFileNameWithoutExtension($_.PSChildName).ToLower()",
    "    if ($k) { Add-App $k $_.PSChildName $p }",
    "  } catch {}",
    "}",
    // 2. Uninstall registry (both hives — 32-bit apps on a 64-bit OS live
    // under WOW6432Node), DisplayName keyed by a lowercased, space-stripped
    // slug so "Google Chrome" -> "googlechrome" (distinct from App Paths'
    // "chrome" — the caller sees both if both exist, never silently merged).
    "foreach ($root in @(",
    "  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
    "  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'",
    ")) {",
    "  Get-ItemProperty -Path $root -ErrorAction SilentlyContinue | ForEach-Object {",
    "    try {",
    "      $dn = $_.DisplayName",
    "      if (-not $dn) { return }",
    "      $exe = $null",
    "      if ($_.InstallLocation -and (Test-Path -LiteralPath $_.InstallLocation -ErrorAction SilentlyContinue)) {",
    "        $exe = Get-ChildItem -LiteralPath $_.InstallLocation -Filter *.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName",
    "      }",
    "      if (-not $exe -and $_.DisplayIcon) {",
    "        $cand = ($_.DisplayIcon -split ',')[0].Trim('\"')",
    "        if ($cand -and (Test-Path -LiteralPath $cand -PathType Leaf -ErrorAction SilentlyContinue)) { $exe = $cand }",
    "      }",
    "      if ($exe) {",
    "        $k = ($dn.ToLower() -replace '[^a-z0-9]', '')",
    "        if ($k) { Add-App $k $dn $exe }",
    "      }",
    "    } catch {}",
    "  }",
    "}",
    // 3. Curated fallback probe — only fills a key that's STILL missing
    // after the two registry passes above.
    "$known = @{",
    "  chrome  = @('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe')",
    "  firefox = @('C:\\Program Files\\Mozilla Firefox\\firefox.exe', 'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe')",
    "  edge    = @('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe')",
    "  notepad = @('C:\\Windows\\System32\\notepad.exe')",
    "  explorer = @('C:\\Windows\\explorer.exe')",
    "}",
    "foreach ($k in $known.Keys) { foreach ($p in $known[$k]) { Add-App $k $k $p } }",
    `Write-Output '${APPS_MARKER_START}'`,
    "Write-Output (@($apps.Values) | ConvertTo-Json -Compress)",
    `Write-Output '${APPS_MARKER_END}'`,
  ].join("\n");
}

function parseDiscoveredApps(output: string | null): LauncherApp[] {
  if (typeof output !== "string") return [];
  const start = output.indexOf(APPS_MARKER_START);
  const end = output.indexOf(APPS_MARKER_END);
  if (start === -1 || end === -1 || end < start) return [];
  const jsonText = output.slice(start + APPS_MARKER_START.length, end).trim();
  if (!jsonText) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  // ConvertTo-Json emits a single object (not an array) when there is
  // exactly one result — normalize both shapes.
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const out: LauncherApp[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const key = typeof rec.key === "string" ? rec.key.trim().toLowerCase() : "";
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    const path = typeof rec.path === "string" ? rec.path.trim() : "";
    if (!key || !path) continue;
    out.push({ key, name: name || key, path });
  }
  return out;
}

/**
 * Re-runs discovery on the device and caches the result as this device's
 * `launcher_apps` DeviceCapability (§1 of TASK_104's fallback toolbelt).
 * Manual own-device, no approval — same posture as every other tool in this
 * file. Offline device fails immediately (runCommandNow throws; no queue).
 */
export async function discoverApps(opts: {
  userId: string;
  deviceId: string;
}): Promise<LauncherApp[]> {
  const device = await requireOwnedDevice(opts);
  const { output } = await runCommandNow({
    userId: opts.userId,
    deviceId: opts.deviceId,
    cmd: buildDiscoverAppsScript(),
    shell: "powershell",
    timeoutSeconds: DISCOVER_TIMEOUT_SECONDS,
    runAsUser: false,
  });
  const apps = parseDiscoveredApps(output);
  await db.deviceCapability.upsert({
    where: { deviceId_capability: { deviceId: device.id, capability: "launcher_apps" } },
    create: {
      deviceId: device.id,
      capability: "launcher_apps",
      enabled: true,
      meta: { apps, discoveredAt: new Date().toISOString() } as object,
    },
    update: {
      enabled: true,
      meta: { apps, discoveredAt: new Date().toISOString() } as object,
    },
  });
  await recordAgentActionAudit({
    userId: opts.userId,
    action: "device_launcher_discover",
    status: "executed",
    approvalChannel: "web-direct",
    sourceDeviceId: device.id,
    detail: { count: apps.length, keys: apps.map((a) => a.key).slice(0, 50) },
  });
  return apps;
}

/** Reads the last-discovered catalog without re-running discovery (no device round trip). */
export async function getLauncherApps(opts: {
  userId: string;
  deviceId: string;
}): Promise<{ apps: LauncherApp[]; discoveredAt: string | null }> {
  const device = await requireOwnedDevice(opts);
  const cap = await db.deviceCapability.findUnique({
    where: { deviceId_capability: { deviceId: device.id, capability: "launcher_apps" } },
    select: { meta: true },
  });
  const meta = (cap?.meta ?? null) as { apps?: unknown; discoveredAt?: string } | null;
  const apps = Array.isArray(meta?.apps) ? (meta!.apps as LauncherApp[]) : [];
  return { apps, discoveredAt: meta?.discoveredAt ?? null };
}

export type LaunchTargetKind = "app" | "path" | "url";

export interface LaunchResult {
  ok: boolean;
  kind: LaunchTargetKind;
  error?: string;
}

// https only (never http — this only ever opens the device's OWN default
// browser, and a plaintext URL from a web form is not worth the downgrade).
// No userinfo (`user:pass@host`), no shell metacharacters in the path/query
// — Start-Process receives this as a single quoted PowerShell argument, so
// this regex is the actual security boundary, not a UX nicety.
const LAUNCH_URL_RE =
  /^https:\/\/[a-z0-9.-]+(:[0-9]{1,5})?(\/[a-z0-9\-._~:/?#[\]@!$&'()*+,;=%]*)?$/i;

// Absolute Windows path, drive-letter rooted, no shell metacharacters and no
// ".." traversal — the same shape as lib/clone.ts's isWindowsPath, kept as
// its own copy here rather than an import: that module is clone-pipeline
// internal state, this is a generic device tool with no other relationship
// to it, and a shared helper would couple two things that should stay free
// to diverge.
const LAUNCH_PATH_RE = /^[A-Za-z]:\\[^"'`$;&|<>(){}[\]\r\n]{1,240}$/;

function classifyLaunchTarget(raw: string): { kind: "url" | "path"; value: string } | null {
  if (LAUNCH_URL_RE.test(raw)) return { kind: "url", value: raw };
  if (LAUNCH_PATH_RE.test(raw) && !raw.includes("..")) return { kind: "path", value: raw };
  return null;
}

/**
 * Builds the PowerShell that actually launches `resolvedPath` (already
 * classified/validated by the caller — this function trusts it completely).
 * Single-quoted PowerShell literal; the only single quote it could ever
 * contain is escaped, and both LAUNCH_URL_RE/LAUNCH_PATH_RE already reject
 * backtick/`$`/`;`/`&`/`|`/`<`/`>` etc. before a value ever reaches here, so
 * this can never break out of the literal.
 *
 * Exported (2026-09-26, pure — no behaviour change) for the same reason as
 * buildDiscoverAppsScript above: a verification script can run the EXACT
 * deployed command on a real disposable Windows box.
 */
export function buildLaunchCommand(kind: LaunchTargetKind, resolvedPath: string): string {
  const psLiteral = `'${resolvedPath.replace(/'/g, "''")}'`;
  return [
    "$ErrorActionPreference = 'Continue'",
    kind === "url"
      ? `Start-Process ${psLiteral}; Write-Output 'LAUNCH_OK'`
      : [
          `if (Test-Path -LiteralPath ${psLiteral} -PathType Leaf -ErrorAction SilentlyContinue) {`,
          `  Start-Process ${psLiteral}; Write-Output 'LAUNCH_OK'`,
          "} else {",
          "  Write-Output 'LAUNCH_FAIL:not_found'",
          "}",
        ].join("\n"),
  ].join("\n");
}

/**
 * Launches exactly one of: a discovered app key (looked up against THIS
 * device's own cached catalog — never an arbitrary caller-supplied path
 * disguised as a key), an absolute Windows path, or an https:// URL. Manual
 * own-device, no approval, audited `web-direct`. Anything else — a bare
 * word that isn't a known key, shell metacharacters, extra arguments, a
 * relative path, "..", http:// — is refused before any command is built;
 * this must never become a way to run an arbitrary shell command via a
 * launcher meant only to open apps.
 */
export async function launchApp(opts: {
  userId: string;
  deviceId: string;
  target: string;
}): Promise<LaunchResult> {
  const raw = opts.target.trim();
  if (!raw || raw.length > 500) throw new Error("bad_target");

  const device = await requireOwnedDevice(opts);

  const classified = classifyLaunchTarget(raw);
  let kind: LaunchTargetKind;
  let resolvedPath: string;
  if (classified) {
    kind = classified.kind;
    resolvedPath = classified.value;
  } else {
    // Not a URL or an absolute path — the only remaining legal shape is a
    // key from THIS device's own discovered catalog. Anything else (an
    // unknown word, a relative path, a command with arguments) is refused
    // here, never forwarded to the device.
    const cap = await db.deviceCapability.findUnique({
      where: { deviceId_capability: { deviceId: device.id, capability: "launcher_apps" } },
      select: { meta: true },
    });
    const meta = (cap?.meta ?? null) as { apps?: LauncherApp[] } | null;
    const apps = Array.isArray(meta?.apps) ? meta!.apps : [];
    const match = apps.find((a) => a.key === raw.toLowerCase());
    if (!match) throw new Error("unknown_launch_target");
    kind = "app";
    resolvedPath = match.path;
  }

  const cmd = buildLaunchCommand(kind, resolvedPath);

  let output: string | null;
  try {
    const res = await runCommandNow({
      userId: opts.userId,
      deviceId: opts.deviceId,
      // Launched on the INTERACTIVE desktop (runAsUser: true) — the whole
      // point is a window the logged-in person (or the technician watching
      // the Remote control viewer) can see, unlike every other tool in this
      // file which runs SYSTEM-side.
      cmd,
      shell: "powershell",
      timeoutSeconds: LAUNCH_TIMEOUT_SECONDS,
      runAsUser: true,
    });
    output = res.output;
  } catch (err) {
    await recordAgentActionAudit({
      userId: opts.userId,
      action: "device_launch",
      status: "failed",
      approvalChannel: "web-direct",
      sourceDeviceId: device.id,
      detail: { kind, error: err instanceof Error ? err.message.slice(0, 300) : "launch_failed" },
    });
    throw err;
  }

  const ok = typeof output === "string" && output.includes("LAUNCH_OK");
  await recordAgentActionAudit({
    userId: opts.userId,
    action: "device_launch",
    status: ok ? "executed" : "failed",
    approvalChannel: "web-direct",
    sourceDeviceId: device.id,
    // Evidence only — kind + which discovered key, never the raw path/URL
    // (not a secret, but not evidence anyone needs either; matches this
    // file's "counts/kinds, not values" audit convention elsewhere).
    detail: { kind, key: kind === "app" ? raw.toLowerCase() : undefined },
  });
  if (!ok) return { ok: false, kind, error: "not_found" };
  return { ok: true, kind };
}


