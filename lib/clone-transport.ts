import "server-only";

import crypto from "node:crypto";

import { db } from "./db";
import { recordAgentActionAudit } from "./devices";
import { browserRuntime } from "./browser-runtime";

// TASK_108 (bit B2) — SpaceWorker side of the Browser Clone agent transport.
//
// The SpaceWorker layer speaks ONLY DeviceCapability / DeviceJob /
// DeviceAction / DeviceAudit (+ CloneJob/RelayHealth rows it owns) and calls
// Vantra's seven `/api/internal/sw/devices/[agentId]/clone|relay/*` routes.
// No TRMM/Mesh endpoint string may ever appear in this file or its diff —
// all TRMM specifics stay encapsulated inside those Vantra routes.
//
// Row discipline (so TASK_109 drives jobs by id and never shells out itself):
// - Mutating calls (capture, receive, launch, revoke, relay-install) create a
//   DeviceJob (`browser-clone:<step>`, running → succeeded/failed) and a
//   DeviceAction (`browser-clone`, executing → executed/failed) under the
//   stable CloneJob id carried in the payload — plus an AgentActionAudit row
//   (action "browser-clone") carrying sourceDeviceId, destinationDeviceId,
//   cloneId, the egress mode actually used and the script exit code.
// - Read-only calls (status, relay-probe) write the audit row only — polls
//   must not spam the job/action tables. probeCloneRelay writes NO RelayHealth
//   row either: TASK_109's refreshRelayHealth stamps that (documented seam).
// - Evidence only, everywhere: paths, ids, counts, codes. Never cookie
//   values, profile plaintext, job keys or tokens in any row, audit detail,
//   log line or thrown error.

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

// Same normaliser as lib/device-tools.ts (stale-deploy HTML → actionable
// string; JSON error bodies keep the `vantra_<code>: ` prefix the API routes
// and console prefix-stripping key on). Offline surfaces as `vantra_503: …`
// so TASK_110 can map it distinctly from relay failures.
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
    const jm = /^\s*\{\s*"error"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/.exec(body);
    if (jm) {
      return new Error(`vantra_${m[1]}: ${jm[1].replace(/\\n/g, " ").trim()}`);
    }
    return new Error(raw.slice(0, 200));
  }
  return err instanceof Error ? err : new Error(raw);
}

// Ownership helper — the single gate every transport call flows through.
// Ownership is ALWAYS resolved from OUR db (device.userId === session userId)
// — never from the request path.
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

export type CloneBrowser = "chrome" | "edge" | "firefox";
export type CloneEgress = "relay" | "direct";
export type CloneStep = "capture" | "receive" | "launch" | "status" | "revoke" | "relay-install" | "relay-probe";

const BROWSERS: ReadonlySet<string> = new Set(["chrome", "edge", "firefox"]);

/** DeviceCapability values this transport registers (schema-documented set). */
export const CLONE_CAPABILITIES = ["clone-capture", "clone-host", "relay", "live-capture"] as const;
export type CloneCapability = (typeof CLONE_CAPABILITIES)[number];

/**
 * Mint a fresh AES-256-GCM job key (base64, 32 bytes). Returned to the caller
 * in memory only — NEVER persisted: CloneJob/DeviceJob rows carry paths, ids,
 * counts and status, never key material. Key lifecycle across capture →
 * receive/inject (engine show-key/provision-key exchange) is TASK_109's
 * problem; this transport only carries a caller-supplied key to the capture
 * route, which injects it into the CHILD process env.
 */
export function mintCloneJobKey(): string {
  return crypto.randomBytes(32).toString("base64");
}

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isJobKey(value: string): boolean {
  if (!/^[A-Za-z0-9+/]{40,64}={0,2}$/.test(value)) return false;
  try {
    return Buffer.from(value, "base64").length === 32;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Audit — one row per transport call, evidence only.
// ---------------------------------------------------------------------------

async function auditCloneStep(opts: {
  userId: string;
  pendingActionId?: string;
  actionType?: string;
  status: "executed" | "failed";
  initiatingChannel?: string;
  approvalChannel?: string;
  sourceDeviceId?: string;
  destinationDeviceId?: string;
  cloneId?: string;
  egressMode?: CloneEgress;
  exitCode?: number | null;
  step?: CloneStep;
  error?: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  const detail: Record<string, unknown> = { ...(opts.detail ?? {}) };
  if (opts.step) detail.step = opts.step;
  if (opts.egressMode) detail.egressMode = opts.egressMode;
  if (opts.exitCode !== undefined) detail.exitCode = opts.exitCode;
  if (opts.error) detail.error = opts.error.slice(0, 500);
  await recordAgentActionAudit({
    userId: opts.userId,
    pendingActionId: opts.pendingActionId,
    action: "browser-clone",
    status: opts.status,
    initiatingChannel: opts.initiatingChannel ?? "web",
    approvalChannel: opts.approvalChannel,
    sourceDeviceId: opts.sourceDeviceId,
    destinationDeviceId: opts.destinationDeviceId,
    cloneId: opts.cloneId,
    detail,
  });
}

// ---------------------------------------------------------------------------
// Job/action rows — one pair per mutating step, under the stable CloneJob id
// ("stable job id": the CloneJob row id TASK_109 owns; the DeviceJob/
// DeviceAction rows carry it in their payload so sweeps can drive by id).
// ---------------------------------------------------------------------------

async function openStepRows(opts: {
  userId: string;
  deviceId: string;
  step: CloneStep;
  cloneJobId?: string;
  pendingActionId?: string;
  payload?: Record<string, unknown>;
}): Promise<{ jobId: string; actionId: string }> {
  const startedAt = new Date();
  const payload = { ...(opts.payload ?? {}), ...(opts.cloneJobId ? { cloneJobId: opts.cloneJobId } : {}) };
  const job = await db.deviceJob.create({
    data: {
      userId: opts.userId,
      deviceId: opts.deviceId,
      jobType: `browser-clone:${opts.step}`,
      status: "running",
      payload: payload as object,
      startedAt,
    },
    select: { id: true },
  });
  const action = await db.deviceAction.create({
    data: {
      userId: opts.userId,
      deviceId: opts.deviceId,
      pendingActionId: opts.pendingActionId,
      actionType: "browser-clone",
      status: "executing",
      payload: { ...payload, step: opts.step } as object,
    },
    select: { id: true },
  });
  return { jobId: job.id, actionId: action.id };
}

async function closeStepRows(opts: {
  jobId: string;
  actionId: string;
  ok: boolean;
  // Evidence-only result summary (exit codes, counts, paths) — never secrets.
  result?: Record<string, unknown>;
  error?: string;
}): Promise<void> {
  const now = new Date();
  await db.deviceJob.update({
    where: { id: opts.jobId },
    data: {
      status: opts.ok ? "succeeded" : "failed",
      result: opts.result ? (opts.result as object) : undefined,
      error: opts.ok ? null : (opts.error?.slice(0, 500) ?? "clone_step_failed"),
      finishedAt: now,
    },
  });
  await db.deviceAction.update({
    where: { id: opts.actionId },
    data: {
      status: opts.ok ? "executed" : "failed",
      result: opts.result ? (opts.result as object) : undefined,
      error: opts.ok ? null : (opts.error?.slice(0, 500) ?? "clone_step_failed"),
      executedAt: now,
    },
  });
}

// ---------------------------------------------------------------------------
// Capabilities — register/enable the clone roles a device plays.
// ---------------------------------------------------------------------------

/**
 * Register (or re-enable) a clone capability on an owner-scoped device:
 * `clone-capture` (source / work PC), `clone-host` (destination / hosted PC),
 * `relay` (egress-relay host). Metadata only — the ABILITY, not a queued
 * thing to do. TASK_109 calls this before driving a device's steps.
 */
export async function ensureCloneCapability(opts: {
  userId: string;
  deviceId: string;
  capability: CloneCapability;
  meta?: Record<string, unknown>;
}): Promise<{ deviceId: string; capability: string; enabled: boolean }> {
  const device = await requireOwnedDevice({ userId: opts.userId, deviceId: opts.deviceId });
  const row = await db.deviceCapability.upsert({
    where: { deviceId_capability: { deviceId: device.id, capability: opts.capability } },
    create: {
      deviceId: device.id,
      capability: opts.capability,
      enabled: true,
      meta: opts.meta ? (opts.meta as object) : undefined,
    },
    update: { enabled: true, ...(opts.meta ? { meta: opts.meta as object } : {}) },
    select: { capability: true, enabled: true },
  });
  await auditCloneStep({
    userId: opts.userId,
    status: "executed",
    sourceDeviceId: device.id,
    step: "status",
    detail: { op: "ensure-capability", capability: row.capability },
  });
  return { deviceId: device.id, capability: row.capability, enabled: row.enabled };
}

// ---------------------------------------------------------------------------
// The seven transport calls. Each resolves the owner-scoped device to its
// Vantra agent id, calls exactly one Vantra route, and audits. Mutating
// calls additionally open/close a DeviceJob + DeviceAction pair under the
// stable CloneJob id. Every call fails closed on a missing
// VANTRA_INTERNAL_TOKEN (vantra_not_configured, never unauthenticated).
// ---------------------------------------------------------------------------

export interface CloneCallBase {
  userId: string;
  /** Stable CloneJob id TASK_109 owns — carried in job/action payloads. */
  cloneJobId?: string;
  pendingActionId?: string;
  approvalChannel?: string;
}

export interface CloneCaptureResult {
  ok: boolean;
  partial: boolean;
  exitCode: number | null;
  results: unknown[];
  jobId: string;
  actionId: string;
}

/**
 * Source-side MT-1 capture (interactive session — runAsUser is set on the
 * VANTA route; capture from a service context silently yields zero cookies).
 * The job key travels to Vantra's route in the request body (VPS-to-VPS over
 * the bearer-authed internal route) and is injected there into the CHILD
 * process env only — never written to disk by either side.
 */
export async function runCloneCapture(opts: CloneCallBase & {
  sourceDeviceId: string;
  browser: CloneBrowser;
  outPath: string;
  profile?: string;
  jobKey: string;
  timeoutSeconds?: number;
}): Promise<CloneCaptureResult> {
  if (!BROWSERS.has(opts.browser)) throw new Error("bad_browser");
  if (!isJobKey(opts.jobKey)) throw new Error("bad_job_key");
  const device = await requireOwnedDevice({ userId: opts.userId, deviceId: opts.sourceDeviceId });
  const { jobId, actionId } = await openStepRows({
    userId: opts.userId,
    deviceId: device.id,
    step: "capture",
    cloneJobId: opts.cloneJobId,
    pendingActionId: opts.pendingActionId,
    payload: { browser: opts.browser, outPath: opts.outPath, ...(opts.profile ? { profile: opts.profile } : {}) },
  });
  try {
    const res = await vantraFetch<{ ok: boolean; partial: boolean; exitCode: number | null; results: unknown[] }>(
      `/api/internal/sw/devices/${encodeURIComponent(device.vantraAgentId)}/clone/capture`,
      {
        method: "POST",
        body: JSON.stringify({
          browser: opts.browser,
          outPath: opts.outPath,
          ...(opts.profile ? { profile: opts.profile } : {}),
          jobKey: opts.jobKey,
          timeout: Math.min(600, Math.max(30, Math.round(opts.timeoutSeconds ?? 300))),
        }),
      },
    );
    const ok = res.ok === true;
    await closeStepRows({
      jobId,
      actionId,
      ok,
      result: { exitCode: res.exitCode, partial: res.partial, resultCount: res.results?.length ?? 0 },
      error: ok ? undefined : `capture_exit_${res.exitCode ?? "unknown"}`,
    });
    // F2: a partial capture is never reported as success.
    await auditCloneStep({
      userId: opts.userId,
      pendingActionId: opts.pendingActionId,
      status: ok ? "executed" : "failed",
      approvalChannel: opts.approvalChannel,
      sourceDeviceId: device.id,
      cloneId: opts.cloneJobId,
      exitCode: res.exitCode,
      step: "capture",
      detail: { browser: opts.browser, outPath: opts.outPath, partial: res.partial },
    });
    return { ok, partial: res.partial === true, exitCode: res.exitCode ?? null, results: res.results ?? [], jobId, actionId };
  } catch (err) {
    const shaped = normalizeVantraError(err);
    await closeStepRows({ jobId, actionId, ok: false, error: shaped.message });
    await auditCloneStep({
      userId: opts.userId,
      pendingActionId: opts.pendingActionId,
      status: "failed",
      approvalChannel: opts.approvalChannel,
      sourceDeviceId: device.id,
      cloneId: opts.cloneJobId,
      step: "capture",
      error: shaped.message,
    });
    throw shaped;
  }
}

export interface CloneReceiveResult {
  ok: boolean;
  received: string;
  injected: string;
  jobId: string;
  actionId: string;
}

/** Destination-side `receive --parcel` then `inject --clone-id` (one command). */
export async function runCloneReceive(opts: CloneCallBase & {
  destinationDeviceId: string;
  cloneId: string;
  parcelDir: string;
  hostBrowser?: CloneBrowser;
  hostBrowserVersion?: string;
  timeoutSeconds?: number;
}): Promise<CloneReceiveResult> {
  if (opts.hostBrowser !== undefined && !BROWSERS.has(opts.hostBrowser)) throw new Error("bad_browser");
  const device = await requireOwnedDevice({ userId: opts.userId, deviceId: opts.destinationDeviceId });
  const { jobId, actionId } = await openStepRows({
    userId: opts.userId,
    deviceId: device.id,
    step: "receive",
    cloneJobId: opts.cloneJobId,
    pendingActionId: opts.pendingActionId,
    payload: { cloneId: opts.cloneId, parcelDir: opts.parcelDir },
  });
  try {
    const res = await vantraFetch<{ ok: boolean; received: string; injected: string }>(
      `/api/internal/sw/devices/${encodeURIComponent(device.vantraAgentId)}/clone/receive`,
      {
        method: "POST",
        body: JSON.stringify({
          cloneId: opts.cloneId,
          parcelDir: opts.parcelDir,
          ...(opts.hostBrowser ? { hostBrowser: opts.hostBrowser } : {}),
          ...(opts.hostBrowserVersion ? { hostBrowserVersion: opts.hostBrowserVersion } : {}),
          timeout: Math.min(600, Math.max(30, Math.round(opts.timeoutSeconds ?? 300))),
        }),
      },
    );
    const ok = res.ok === true;
    await closeStepRows({ jobId, actionId, ok, result: { received: res.received, injected: res.injected } });
    await auditCloneStep({
      userId: opts.userId,
      pendingActionId: opts.pendingActionId,
      status: ok ? "executed" : "failed",
      approvalChannel: opts.approvalChannel,
      destinationDeviceId: device.id,
      cloneId: opts.cloneId,
      step: "receive",
      detail: { received: res.received, injected: res.injected },
    });
    return { ok, received: res.received, injected: res.injected, jobId, actionId };
  } catch (err) {
    const shaped = normalizeVantraError(err);
    await closeStepRows({ jobId, actionId, ok: false, error: shaped.message });
    await auditCloneStep({
      userId: opts.userId,
      pendingActionId: opts.pendingActionId,
      status: "failed",
      approvalChannel: opts.approvalChannel,
      destinationDeviceId: device.id,
      cloneId: opts.cloneId,
      step: "receive",
      error: shaped.message,
    });
    throw shaped;
  }
}

export interface CloneLaunchResult {
  ok: boolean;
  exitCode: number | null;
  egressMode: CloneEgress;
  jobId: string;
  actionId: string;
}

/**
 * Destination-side launch. The egress mode ACTUALLY USED is written to the
 * audit (never inferred) — TASK_109 stamps it onto CloneJob as well.
 * Relay mode fails closed device-side ([IP CHECK 2]); direct is the labeled
 * `--proxy-optional` path only.
 */
export async function runCloneLaunch(opts: CloneCallBase & {
  sourceDeviceId: string;
  destinationDeviceId: string;
  cloneId: string;
  egress: CloneEgress;
  relayAddr?: string;
  timeoutSeconds?: number;
}): Promise<CloneLaunchResult> {
  if (opts.egress !== "relay" && opts.egress !== "direct") throw new Error("bad_egress");
  const destination = await requireOwnedDevice({ userId: opts.userId, deviceId: opts.destinationDeviceId });
  // Owner-scope the source too (never launch a clone off somebody else's PC).
  const source = await requireOwnedDevice({ userId: opts.userId, deviceId: opts.sourceDeviceId });
  const { jobId, actionId } = await openStepRows({
    userId: opts.userId,
    deviceId: destination.id,
    step: "launch",
    cloneJobId: opts.cloneJobId,
    pendingActionId: opts.pendingActionId,
    payload: { cloneId: opts.cloneId, egress: opts.egress },
  });
  try {
    const res = await vantraFetch<{ ok: boolean; exitCode: number | null; egressMode: CloneEgress }>(
      `/api/internal/sw/devices/${encodeURIComponent(destination.vantraAgentId)}/clone/launch`,
      {
        method: "POST",
        body: JSON.stringify({
          cloneId: opts.cloneId,
          egress: opts.egress,
          ...(opts.relayAddr ? { relayAddr: opts.relayAddr } : {}),
          timeout: Math.min(300, Math.max(15, Math.round(opts.timeoutSeconds ?? 120))),
        }),
      },
    );
    const ok = res.ok === true;
    await closeStepRows({ jobId, actionId, ok, result: { exitCode: res.exitCode, egressMode: res.egressMode } });
    await auditCloneStep({
      userId: opts.userId,
      pendingActionId: opts.pendingActionId,
      status: ok ? "executed" : "failed",
      approvalChannel: opts.approvalChannel,
      sourceDeviceId: source.id,
      destinationDeviceId: destination.id,
      cloneId: opts.cloneId,
      egressMode: res.egressMode,
      exitCode: res.exitCode,
      step: "launch",
    });
    return { ok, exitCode: res.exitCode ?? null, egressMode: res.egressMode, jobId, actionId };
  } catch (err) {
    const shaped = normalizeVantraError(err);
    await closeStepRows({ jobId, actionId, ok: false, error: shaped.message });
    await auditCloneStep({
      userId: opts.userId,
      pendingActionId: opts.pendingActionId,
      status: "failed",
      approvalChannel: opts.approvalChannel,
      sourceDeviceId: source.id,
      destinationDeviceId: destination.id,
      cloneId: opts.cloneId,
      egressMode: opts.egress,
      step: "launch",
      error: shaped.message,
    });
    throw shaped;
  }
}

export interface CloneStatusResult {
  ok: boolean;
  exitCode: number | null;
  entries: unknown[];
}

/**
 * Read-only status probe (either side). Writes the audit row but NO
 * job/action rows — polls must not spam the lifecycle tables.
 */
export async function getCloneStatus(opts: CloneCallBase & {
  deviceId: string;
  cloneId: string;
}): Promise<CloneStatusResult> {
  const device = await requireOwnedDevice({ userId: opts.userId, deviceId: opts.deviceId });
  try {
    const res = await vantraFetch<{ ok: boolean; exitCode: number | null; entries: unknown[] }>(
      `/api/internal/sw/devices/${encodeURIComponent(device.vantraAgentId)}/clone/status?${new URLSearchParams({ cloneId: opts.cloneId }).toString()}`,
      { method: "GET" },
    );
    await auditCloneStep({
      userId: opts.userId,
      pendingActionId: opts.pendingActionId,
      status: res.ok ? "executed" : "failed",
      approvalChannel: opts.approvalChannel,
      sourceDeviceId: device.id,
      cloneId: opts.cloneId,
      exitCode: res.exitCode,
      step: "status",
    });
    return { ok: res.ok === true, exitCode: res.exitCode ?? null, entries: res.entries ?? [] };
  } catch (err) {
    const shaped = normalizeVantraError(err);
    await auditCloneStep({
      userId: opts.userId,
      pendingActionId: opts.pendingActionId,
      status: "failed",
      approvalChannel: opts.approvalChannel,
      sourceDeviceId: device.id,
      cloneId: opts.cloneId,
      step: "status",
      error: shaped.message,
    });
    throw shaped;
  }
}

export interface CloneRevokeResult {
  ok: boolean;
  exitCode: number | null;
  browserProcessesRemaining: number | null;
  jobId: string;
  actionId: string;
}

/**
 * Teardown on either side (directive §11: stop browser, remove mounted
 * profile + staging + registry entry). Returns the Get-Process evidence that
 * the browser is gone. The staging path itself rides the status entry — this
 * response carries only codes + counts (records outlive material by design).
 */
export async function runCloneRevoke(opts: CloneCallBase & {
  deviceId: string;
  sourceDeviceId?: string;
  destinationDeviceId?: string;
  cloneId: string;
  browser: CloneBrowser;
  timeoutSeconds?: number;
}): Promise<CloneRevokeResult> {
  if (!BROWSERS.has(opts.browser)) throw new Error("bad_browser");
  const device = await requireOwnedDevice({ userId: opts.userId, deviceId: opts.deviceId });
  const { jobId, actionId } = await openStepRows({
    userId: opts.userId,
    deviceId: device.id,
    step: "revoke",
    cloneJobId: opts.cloneJobId,
    pendingActionId: opts.pendingActionId,
    payload: { cloneId: opts.cloneId, browser: opts.browser },
  });
  try {
    const res = await vantraFetch<{ ok: boolean; exitCode: number | null; browserProcessesRemaining: number | null }>(
      `/api/internal/sw/devices/${encodeURIComponent(device.vantraAgentId)}/clone/revoke`,
      {
        method: "POST",
        body: JSON.stringify({
          cloneId: opts.cloneId,
          browser: opts.browser,
          timeout: Math.min(300, Math.max(15, Math.round(opts.timeoutSeconds ?? 120))),
        }),
      },
    );
    const ok = res.ok === true;
    await closeStepRows({
      jobId,
      actionId,
      ok,
      result: { exitCode: res.exitCode, browserProcessesRemaining: res.browserProcessesRemaining },
    });
    await auditCloneStep({
      userId: opts.userId,
      pendingActionId: opts.pendingActionId,
      status: ok ? "executed" : "failed",
      approvalChannel: opts.approvalChannel,
      sourceDeviceId: opts.sourceDeviceId ?? device.id,
      destinationDeviceId: opts.destinationDeviceId,
      cloneId: opts.cloneId,
      exitCode: res.exitCode,
      step: "revoke",
      detail: { browser: opts.browser, browserProcessesRemaining: res.browserProcessesRemaining },
    });
    return {
      ok,
      exitCode: res.exitCode ?? null,
      browserProcessesRemaining: res.browserProcessesRemaining ?? null,
      jobId,
      actionId,
    };
  } catch (err) {
    const shaped = normalizeVantraError(err);
    await closeStepRows({ jobId, actionId, ok: false, error: shaped.message });
    await auditCloneStep({
      userId: opts.userId,
      pendingActionId: opts.pendingActionId,
      status: "failed",
      approvalChannel: opts.approvalChannel,
      sourceDeviceId: opts.sourceDeviceId ?? device.id,
      destinationDeviceId: opts.destinationDeviceId,
      cloneId: opts.cloneId,
      step: "revoke",
      error: shaped.message,
    });
    throw shaped;
  }
}

export interface RelayInstallResult {
  ok: boolean;
  exitCode: number | null;
  jobId: string;
  actionId: string;
}

/**
 * Source-side relay install (quarantine-first script). The raw relay token is
 * accepted here, stored ONLY as SHA-256 on the RelayHealth row, and forwarded
 * to Vantra's route as the installer's `-Token` PARAMETER — it lands in the
 * on-device scheduled-task registration only, never in our DB or logs, and
 * never in any audit detail.
 *
 * TASK_118 B8-2 — dial-out tunnel mode is now attempted by DEFAULT for every
 * install, not an opt-in: `-tunnel`/`-tunnel-key` were built (B8-3) but never
 * wired into this, the only production install path, which is why "clone
 * host is set up" never actually meant a hosted clone could reach the
 * device. The device's OWN id is used as the tunnel key (a stable, already-
 * unique, already-known value — no schema migration needed for it). The
 * shared ingress secret (RELAY_INGRESS_TOKEN) is fetched from browser-server
 * (the only place that holds it, see RELAY_INGRESS_PUBLIC_HOST's comment
 * there) and OVERRIDES any caller-supplied `token` — tunnel mode only works
 * when `-token` is that exact shared secret, so a caller-chosen value could
 * never have worked anyway. If browser-server can't be reached, the install
 * still proceeds loopback-only (today's existing behavior, not a new
 * failure mode) with a clear note in the audit detail — the later relay-
 * health probe (TASK_109) is what actually catches an unreachable device at
 * launch time, so degrading here doesn't hide anything from the user.
 */
export async function runRelayInstall(opts: CloneCallBase & {
  sourceDeviceId: string;
  newRelayExe: string;
  installDir?: string;
  addr?: string;
  token?: string;
  timeoutSeconds?: number;
}): Promise<RelayInstallResult> {
  const device = await requireOwnedDevice({ userId: opts.userId, deviceId: opts.sourceDeviceId });

  let tunnelHost: string | undefined;
  let tunnelToken = opts.token;
  let tunnelConfigNote = "not attempted";
  try {
    const cfg = await browserRuntime.relayTunnelConfig();
    if (cfg.ok && cfg.data && typeof cfg.data === "object") {
      const { tunnelHost: th, token: tk } = cfg.data as { tunnelHost?: string; token?: string };
      if (th && tk) {
        tunnelHost = th;
        tunnelToken = tk;
        tunnelConfigNote = "ok";
      } else {
        tunnelConfigNote = "malformed_response";
      }
    } else {
      tunnelConfigNote = `unavailable: ${cfg.ok ? "" : cfg.error}`;
    }
  } catch (e) {
    tunnelConfigNote = `error: ${e instanceof Error ? e.message : "unknown"}`;
  }

  const { jobId, actionId } = await openStepRows({
    userId: opts.userId,
    deviceId: device.id,
    step: "relay-install",
    cloneJobId: opts.cloneJobId,
    pendingActionId: opts.pendingActionId,
    payload: { addr: opts.addr, tunnel: tunnelConfigNote },
  });
  try {
    const res = await vantraFetch<{ ok: boolean; exitCode: number | null }>(
      `/api/internal/sw/devices/${encodeURIComponent(device.vantraAgentId)}/relay/install`,
      {
        method: "POST",
        body: JSON.stringify({
          newRelayExe: opts.newRelayExe,
          ...(opts.installDir ? { installDir: opts.installDir } : {}),
          ...(opts.addr ? { addr: opts.addr } : {}),
          ...(tunnelToken ? { token: tunnelToken } : {}),
          ...(tunnelHost ? { tunnelHost, tunnelKey: device.id } : {}),
          timeout: Math.min(600, Math.max(30, Math.round(opts.timeoutSeconds ?? 300))),
        }),
      },
    );
    const ok = res.ok === true;
    // RelayHealth registry touch (token HASH only — the raw token is never
    // persisted). Full health stamping (status/failures) is TASK_109's
    // refreshRelayHealth; the install only guarantees the row exists.
    // `addr` intentionally still reflects the loopback address (still bound,
    // per cmd/relay/main.go, even in tunnel mode) — it's the port-preflight
    // value, not the egress path; tunnelConfigNote in the DeviceJob payload
    // above is the record of which egress mode was actually attempted.
    await db.relayHealth.upsert({
      where: { deviceId: device.id },
      create: {
        userId: opts.userId,
        deviceId: device.id,
        addr: opts.addr ?? "127.0.0.1:8118",
        tokenHash: tunnelToken ? sha256Hex(tunnelToken) : sha256Hex(`unseeded:${device.id}`),
      },
      update: {
        ...(opts.addr ? { addr: opts.addr } : {}),
        ...(tunnelToken ? { tokenHash: sha256Hex(tunnelToken) } : {}),
      },
    });
    await closeStepRows({ jobId, actionId, ok, result: { exitCode: res.exitCode } });
    await auditCloneStep({
      userId: opts.userId,
      pendingActionId: opts.pendingActionId,
      status: ok ? "executed" : "failed",
      approvalChannel: opts.approvalChannel,
      sourceDeviceId: device.id,
      cloneId: opts.cloneJobId,
      exitCode: res.exitCode,
      step: "relay-install",
      detail: { addr: opts.addr ?? "127.0.0.1:8118" },
    });
    return { ok, exitCode: res.exitCode ?? null, jobId, actionId };
  } catch (err) {
    const shaped = normalizeVantraError(err);
    await closeStepRows({ jobId, actionId, ok: false, error: shaped.message });
    await auditCloneStep({
      userId: opts.userId,
      pendingActionId: opts.pendingActionId,
      status: "failed",
      approvalChannel: opts.approvalChannel,
      sourceDeviceId: device.id,
      cloneId: opts.cloneJobId,
      step: "relay-install",
      error: shaped.message,
    });
    throw shaped;
  }
}

export interface RelayProbeResult {
  ok: boolean;
  status: "up" | "down";
  lastCheckAt: string;
  exitCode: number | null;
  evidence: { open: boolean; taskPresent: unknown; port: number };
}

/**
 * Read-only relay health probe (either caller, source device). Writes the
 * audit row but NO job/action rows — and NO RelayHealth update: TASK_109's
 * refreshRelayHealth owns the in-place stamping (status / lastCheckAt /
 * consecutiveFailures). Documented seam, not an omission.
 */
export async function probeCloneRelay(opts: CloneCallBase & {
  sourceDeviceId: string;
  port?: number;
}): Promise<RelayProbeResult> {
  const device = await requireOwnedDevice({ userId: opts.userId, deviceId: opts.sourceDeviceId });
  try {
    const params = opts.port !== undefined ? `?${new URLSearchParams({ port: String(opts.port) }).toString()}` : "";
    const res = await vantraFetch<{
      ok: boolean;
      status: "up" | "down";
      lastCheckAt: string;
      exitCode: number | null;
      evidence: { open: boolean; taskPresent: unknown; port: number };
    }>(
      `/api/internal/sw/devices/${encodeURIComponent(device.vantraAgentId)}/relay/health${params}`,
      { method: "GET" },
    );
    await auditCloneStep({
      userId: opts.userId,
      pendingActionId: opts.pendingActionId,
      status: "executed",
      approvalChannel: opts.approvalChannel,
      sourceDeviceId: device.id,
      step: "relay-probe",
      detail: { status: res.status, port: res.evidence?.port },
    });
    return { ok: true, status: res.status, lastCheckAt: res.lastCheckAt, exitCode: res.exitCode ?? null, evidence: res.evidence };
  } catch (err) {
    const shaped = normalizeVantraError(err);
    await auditCloneStep({
      userId: opts.userId,
      pendingActionId: opts.pendingActionId,
      status: "failed",
      approvalChannel: opts.approvalChannel,
      sourceDeviceId: device.id,
      step: "relay-probe",
      error: shaped.message,
    });
    throw shaped;
  }
}

/**
 * TASK_119A V1 (second pass): the raw token is generated HERE, in memory,
 * with no DB write — the caller (clone-setup.ts) delivers it to the device
 * FIRST (writing live-capture.json) and only calls commitLiveCaptureToken
 * once that delivery is CONFIRMED. This ordering matters: minting used to
 * overwrite Device.liveCaptureTokenHash unconditionally before the device
 * ever saw the new token, so a device that was offline (or whose delivery
 * script failed) for that one setup run was left with a hash the device's
 * own live-capture.json could never match again — every future capture 401s
 * until the next successful setup. Write-then-commit means a failed delivery
 * leaves the OLD token (if any) valid instead of silently bricking the
 * device's live-capture ability.
 */
export function mintLiveCaptureToken(): string {
  // 32 random bytes, base64 (same primitive as the relay token).
  return crypto.randomBytes(32).toString("base64");
}

/**
 * Persists the hash of a token ALREADY confirmed delivered to the device.
 * The raw token itself is never passed to db/log/audit — only its hash.
 */
export async function commitLiveCaptureToken(opts: {
  userId: string;
  sourceDeviceId: string;
  rawToken: string;
}): Promise<void> {
  const device = await requireOwnedDevice({ userId: opts.userId, deviceId: opts.sourceDeviceId });
  const tokenHash = sha256Hex(opts.rawToken);
  await db.device.update({
    where: { id: device.id },
    data: { liveCaptureTokenHash: tokenHash },
  });
}

