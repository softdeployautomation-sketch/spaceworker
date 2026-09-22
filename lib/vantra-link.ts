import "server-only";

import crypto from "node:crypto";

import { db } from "./db";
import { getAdminSettings } from "./admin-settings";
import { hasEntitlement } from "./entitlements";
import { recordAgentActionAudit } from "./devices";

// Task 93 — the Vantra plugin provisioning + device-action service.
//
// ENV (server-side only, NEVER committed / NEVER rsynced — HOW_WE_MOVE_FAST §2):
//   VANTRA_INTERNAL_TOKEN — bearer for Vantra's /api/internal/sw/* routes.
//     Added to /opt/spaceworker/.env BY HAND over ssh (and the SAME value as
//     SW_INTERNAL_TOKEN in /opt/vantra/.env). Deploys must never clobber it
//     (rsync --exclude='.env' is mandatory).
//   VANTRA_INTERNAL_URL   — Vantra's private base URL
//     (default https://vantra.spaceworker.top).
//
// Every mutating path is entitlement-gated ("assistant"), admin-settings-gated
// (vantraLinks* / deviceActions* — CROSS-TRACK RULE 7), and audited through
// the shared Task 92 layer (recordAgentActionAudit / DeviceAction).

const VANTRA_URL =
  process.env.VANTRA_INTERNAL_URL?.replace(/\/$/, "") || "https://vantra.spaceworker.top";

function swHeaders(): Record<string, string> {
  const token = process.env.VANTRA_INTERNAL_TOKEN;
  // Fail closed: a missing token throws here rather than ever calling Vantra
  // unauthenticated (mirrors lib/internal-auth.ts's posture, inverted).
  if (!token || token.trim().length === 0) {
    throw new Error("vantra_not_configured");
  }
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

async function vantraFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${VANTRA_URL}${path}`, {
    ...init,
    headers: { ...swHeaders(), ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`vantra_${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export interface VantraLinkView {
  id: string;
  orgId: string;
  orgName: string;
  status: string;
  installUrl: string | null;
  installTokenExpiresAt: Date | null;
  lastSyncedAt: Date | null;
  lastError: string | null;
}

function toView(link: {
  id: string; orgId: string; orgName: string; status: string;
  installUrl: string | null; installTokenExpiresAt: Date | null;
  lastSyncedAt: Date | null; lastError: string | null;
}): VantraLinkView {
  return {
    id: link.id,
    orgId: link.orgId,
    orgName: link.orgName,
    status: link.status,
    installUrl: link.installUrl,
    installTokenExpiresAt: link.installTokenExpiresAt,
    lastSyncedAt: link.lastSyncedAt,
    lastError: link.lastError,
  };
}

/**
 * Idempotent provisioning (TASK_93 acceptance: exactly one link + org per
 * user). Checks: "assistant" entitlement (C1 — capabilities, never tiers),
 * admin settings (vantraLinksEnabled + vantraLinksMax live count). The
 * Vantra side is itself idempotent by org name `sw-<userId>`.
 */
export async function ensureVantraLink(userId: string): Promise<VantraLinkView> {
  const existing = await db.vantraLink.findUnique({ where: { userId } });
  if (existing && existing.status !== "error") return toView(existing);

  const decision = await hasEntitlement(userId, "assistant");
  if (!decision.allowed) throw new Error("entitlement_required");

  const settings = await getAdminSettings();
  if (!settings.vantraLinksEnabled) throw new Error("vantra_links_disabled");
  if (!existing) {
    const count = await db.vantraLink.count({ where: { status: { not: "revoked" } } });
    if (count >= settings.vantraLinksMax) throw new Error("vantra_links_limit");
  }

  const provisioned = await vantraFetch<{ ok: boolean; org: { id: string; name: string } }>(
    "/api/internal/sw/orgs",
    { method: "POST", body: JSON.stringify({ swUserId: userId }) },
  );

  const link = await db.vantraLink.upsert({
    where: { userId },
    update: {
      orgId: provisioned.org.id,
      orgName: provisioned.org.name,
      status: "pending_install",
      lastError: null,
    },
    create: {
      userId,
      orgId: provisioned.org.id,
      orgName: provisioned.org.name,
      status: "pending_install",
    },
  });
  await recordAgentActionAudit({
    userId,
    action: "vantra_link_provisioned",
    status: "executed",
    initiatingChannel: "system",
    detail: { orgId: link.orgId, orgName: link.orgName },
  });
  return toView(link);
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * One-time install link: mints a fresh TRMM deployment via Vantra and stores
 * a SHA-256 of the one-time token in the link row. The URL is OUR wrapper
 * (/link/vantra/<token>), which resolves the real download server-side so
 * the raw TRMM deployment URL never needs to be re-shared or stay valid.
 */
export async function mintInstallLink(userId: string): Promise<VantraLinkView> {
  const link = await db.vantraLink.findUnique({ where: { userId } });
  if (!link || link.status === "revoked") throw new Error("no_link");

  await vantraFetch<{ ok: boolean; downloadUrl: string }>(
    `/api/internal/sw/orgs/${link.orgId}/install-link`,
    { method: "POST", body: "{}" },
  );
  const token = crypto.randomBytes(24).toString("hex");
  const updated = await db.vantraLink.update({
    where: { id: link.id },
    data: {
      installTokenHash: sha256(token),
      installTokenExpiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
      installUrl: `/link/vantra/${token}`,
      lastError: null,
    },
  });
  await recordAgentActionAudit({
    userId,
    action: "vantra_install_link_minted",
    status: "executed",
    detail: { orgId: link.orgId },
  });
  return toView(updated);
}

/** Resolves a one-time install token to the real (server-only) download URL. */
export async function resolveInstallToken(token: string): Promise<string | null> {
  const link = await db.vantraLink.findFirst({
    where: { installTokenHash: sha256(token), status: { not: "revoked" } },
    select: { orgId: true, installTokenExpiresAt: true },
  });
  if (!link) return null;
  if (link.installTokenExpiresAt && link.installTokenExpiresAt.getTime() < Date.now()) {
    return null;
  }
  const minted = await vantraFetch<{ ok: boolean; downloadUrl: string }>(
    `/api/internal/sw/orgs/${link.orgId}/install-link`,
    { method: "POST", body: "{}" },
  );
  return minted.downloadUrl;
}

export interface SyncedDevice {
  vantraAgentId: string;
  name: string;
  online: boolean;
}

/**
 * Device sync: pulls the org's agent list from Vantra and upserts SpaceWorker
 * Device rows (identity = vantraAgentId, Task 92 layer). Also flips the link
 * to "active" the first time any device shows up.
 */
export async function syncDevices(userId: string): Promise<{ devices: SyncedDevice[] }> {
  const link = await db.vantraLink.findUnique({ where: { userId } });
  if (!link || link.status === "revoked") throw new Error("no_link");
  try {
    const list = await vantraFetch<{
      ok: boolean;
      devices: Array<{
        vantraAgentId: string; name: string; online: boolean; status: string;
        osName: string | null; operatingSystem: string | null; lastSeen: string;
      }>;
    }>(`/api/internal/sw/devices?orgId=${encodeURIComponent(link.orgId)}`);

    const now = new Date();
    for (const d of list.devices) {
      await db.device.upsert({
        where: { vantraAgentId: d.vantraAgentId },
        update: {
          userId,
          name: d.name,
          osName: d.osName,
          status: d.online ? "online" : "offline",
          lastSeenAt: d.lastSeen ? new Date(d.lastSeen) : now,
        },
        create: {
          userId,
          vantraAgentId: d.vantraAgentId,
          name: d.name,
          osName: d.osName,
          status: d.online ? "online" : "offline",
          lastSeenAt: d.lastSeen ? new Date(d.lastSeen) : now,
        },
      });
    }
    await db.vantraLink.update({
      where: { id: link.id },
      data: {
        lastSyncedAt: now,
        lastError: null,
        ...(list.devices.length > 0 && link.status === "pending_install"
          ? { status: "active" }
          : {}),
      },
    });
    return {
      devices: list.devices.map((d) => ({
        vantraAgentId: d.vantraAgentId,
        name: d.name,
        online: d.online,
      })),
    };
  } catch (err) {
    await db.vantraLink.update({
      where: { id: link.id },
      data: { lastError: err instanceof Error ? err.message.slice(0, 300) : "sync_failed" },
    });
    throw err;
  }
}

export type DeviceActionKind = "wake" | "reboot" | "shutdown" | "run-script" | "cmd";

/**
 * Creates a gated device-action proposal (DeviceAction "requested" +
 * AgentPendingAction kind "device"). Admin limits checked LIVE: enabled flag
 * + per-user open count < deviceActionsMaxConcurrent (CROSS-TRACK RULE 7).
 */
export async function createDeviceActionProposal(opts: {
  userId: string;
  deviceId: string;
  kind: DeviceActionKind;
  payload?: Record<string, unknown>;
  channel?: string;
}): Promise<{ actionId: string; pendingActionId: string }> {
  const settings = await getAdminSettings();
  if (!settings.deviceActionsEnabled) throw new Error("device_actions_disabled");

  const device = await db.device.findFirst({
    where: { id: opts.deviceId, userId: opts.userId },
    select: { id: true, vantraAgentId: true, name: true },
  });
  if (!device?.vantraAgentId) throw new Error("device_not_linked");

  const open = await db.deviceAction.count({
    where: { userId: opts.userId, status: { in: ["requested", "approved", "executing"] } },
  });
  if (open >= settings.deviceActionsMaxConcurrent) {
    throw new Error("device_actions_limit");
  }

  const [action, pending] = await db.$transaction([
    db.deviceAction.create({
      data: {
        deviceId: device.id,
        userId: opts.userId,
        actionType: opts.kind,
        status: "requested",
        payload: (opts.payload ?? {}) as object,
      },
    }),
    db.agentPendingAction.create({
      data: {
        userId: opts.userId,
        kind: "device",
        payload: {
          deviceId: device.id,
          deviceName: device.name,
          vantraAgentId: device.vantraAgentId,
          action: opts.kind,
          ...(opts.payload ?? {}),
        } as object,
        proposal: `${opts.kind} on ${device.name}`,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    }),
  ]);
  // Cross-link AFTER the transaction (the ids don't both exist inside it).
  await db.deviceAction.update({
    where: { id: action.id },
    data: { pendingActionId: pending.id },
  });

  await recordAgentActionAudit({
    userId: opts.userId,
    pendingActionId: pending.id,
    action: `device_${opts.kind}`,
    status: "created",
    initiatingChannel: opts.channel ?? "web",
    sourceDeviceId: device.id,
    detail: { deviceActionId: action.id, ...(opts.payload ?? {}) },
  });
  return { actionId: action.id, pendingActionId: pending.id };
}

/**
 * ONE-TIME approval + execution (approved → executed/failed; a second approve
 * hits the status guard and throws "not_pending" → 409 — TASK_93 acceptance).
 * Executes through Vantra's internal action route (server-only token).
 */
export async function approveDeviceAction(opts: {
  userId: string;
  pendingActionId: string;
  approvalChannel?: string;
}): Promise<{ output: string | null }> {
  const pending = await db.agentPendingAction.findFirst({
    where: {
      id: opts.pendingActionId,
      userId: opts.userId,
      kind: "device",
      status: "pending",
      expiresAt: { gt: new Date() },
    },
  });
  if (!pending) throw new Error("not_pending");

  const payload = pending.payload as {
    deviceId?: string; vantraAgentId?: string; action?: DeviceActionKind;
    scriptId?: number; args?: string[]; timeout?: number; command?: string;
  };
  if (!payload.vantraAgentId || !payload.action || !payload.deviceId) {
    throw new Error("bad_payload");
  }

  // Claim atomically: pending → approved. A racing second approve gets 0 rows.
  const claimed = await db.agentPendingAction.updateMany({
    where: { id: pending.id, status: "pending" },
    data: { status: "approved" },
  });
  if (claimed.count === 0) throw new Error("not_pending");

  await db.deviceAction.updateMany({
    where: { pendingActionId: pending.id, status: "requested" },
    data: { status: "approved", approvedAt: new Date() },
  });
  await recordAgentActionAudit({
    userId: opts.userId,
    pendingActionId: pending.id,
    action: `device_${payload.action}`,
    status: "approved",
    approvalChannel: opts.approvalChannel ?? "web",
    sourceDeviceId: payload.deviceId,
  });

  try {
    const result = await vantraFetch<{ ok: boolean; output: string | null }>(
      `/api/internal/sw/devices/${encodeURIComponent(payload.vantraAgentId)}/action`,
      {
        method: "POST",
        body: JSON.stringify({
          action: payload.action,
          scriptId: payload.scriptId,
          args: payload.args,
          timeout: payload.timeout,
          command: payload.command,
        }),
      },
    );
    const now = new Date();
    await db.agentPendingAction.update({ where: { id: pending.id }, data: { status: "executed" } });
    await db.deviceAction.updateMany({
      where: { pendingActionId: pending.id, status: "approved" },
      data: {
        status: "executed",
        executedAt: now,
        result: { output: result.output?.slice(0, 2000) ?? null } as object,
      },
    });
    await recordAgentActionAudit({
      userId: opts.userId,
      pendingActionId: pending.id,
      action: `device_${payload.action}`,
      status: "executed",
      approvalChannel: opts.approvalChannel ?? "web",
      sourceDeviceId: payload.deviceId,
      detail: { output: result.output?.slice(0, 2000) ?? null },
    });
    return { output: result.output };
  } catch (err) {
    await db.agentPendingAction.updateMany({
      where: { id: pending.id, status: "approved" },
      data: { status: "expired" },
    });
    await db.deviceAction.updateMany({
      where: { pendingActionId: pending.id, status: "approved" },
      data: { status: "failed", error: err instanceof Error ? err.message.slice(0, 300) : "exec_failed" },
    });
    await recordAgentActionAudit({
      userId: opts.userId,
      pendingActionId: pending.id,
      action: `device_${payload.action}`,
      status: "failed",
      approvalChannel: opts.approvalChannel ?? "web",
      sourceDeviceId: payload.deviceId,
      detail: { error: err instanceof Error ? err.message.slice(0, 500) : "exec_failed" },
    });
    throw err;
  }
}

/** Admin revoke: tears the link down (org left in Vantra; marked revoked). */
export async function revokeVantraLink(linkId: string, actor: string): Promise<void> {
  const link = await db.vantraLink.findUnique({ where: { id: linkId } });
  if (!link) throw new Error("no_link");
  await db.vantraLink.update({
    where: { id: link.id },
    data: { status: "revoked", installUrl: null, installTokenHash: null, installTokenExpiresAt: null },
  });
  await recordAgentActionAudit({
    userId: link.userId,
    action: "vantra_link_revoked",
    status: "executed",
    initiatingChannel: actor === "admin" ? "web" : "system",
    approvalChannel: actor === "admin" ? "admin" : undefined,
    detail: { orgId: link.orgId, revokedBy: actor },
  });
}