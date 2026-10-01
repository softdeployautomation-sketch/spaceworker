import { prisma } from "../prisma";
import { getAdminSettings } from "../admin-settings";
import { isPremiumWithReversion } from "../premium";
import {
  checkUpload,
  isValidSlug,
  monthPeriod,
  newHostingToken,
  resolveHostingCaps,
  sanitizeDispositionFilename,
  scanUpload,
  type HostingCaps,
} from "./rules";
import { resolveProvider, type HostingProvider } from "./providers";

// TASK_155 P1 — the FILES engine, stateful half: DB rows + provider calls. The
// pure rules (quota, scan, filename, hashing) live in ./rules.ts so they are
// unit-testable; this file is the part that needs Postgres + the disk and is
// live-verified. Every function returns TYPED results — nothing here throws for a
// user-caused condition, so a quota breach or a blocked file becomes a clean 4xx
// at the route, never a 500 (P1 acceptance).

export const HOSTED_FILE_KIND = "file";

export interface HostedFileView {
  id: string;
  name: string;
  token: string;
  slug: string | null;
  mime: string;
  bytes: number;
  sha256: string;
  dispositionFilename: string;
  visibility: string;
  status: string;
  provider: string;
  url: string | null;
  expiresAt: string | null;
  downloadCount: number;
  bytesServed: number;
  createdAt: string;
  updatedAt: string;
}

type HostedAssetRow = {
  id: string;
  name: string;
  token: string;
  slug: string | null;
  mime: string;
  bytes: number;
  sha256: string;
  dispositionFilename: string;
  visibility: string;
  status: string;
  provider: string;
  url: string | null;
  expiresAt: Date | null;
  downloadCount: number;
  bytesServed: bigint;
  createdAt: Date;
  updatedAt: Date;
};

export function toHostedFileView(row: HostedAssetRow): HostedFileView {
  return {
    id: row.id,
    name: row.name,
    token: row.token,
    slug: row.slug,
    mime: row.mime,
    bytes: row.bytes,
    sha256: row.sha256,
    dispositionFilename: row.dispositionFilename,
    visibility: row.visibility,
    status: row.status,
    provider: row.provider,
    url: row.url,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    downloadCount: row.downloadCount,
    // BIGINT in the DB, plain number over the wire (a 50 GB cap fits a double).
    bytesServed: Number(row.bytesServed),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// A result the routes translate directly: `ok:false` carries the HTTP status.
export type HostingResult<T> = { ok: true; value: T } | { ok: false; status: number; code: string; message: string };

/** Resolve caps for one user (free vs premium storage quota; everything else shared). */
export async function resolveCapsForUser(userId: string): Promise<{ caps: HostingCaps; premium: boolean }> {
  const [settings, user] = await Promise.all([
    getAdminSettings(),
    prisma.user.findUnique({ where: { id: userId }, select: { tier: true, premiumExpiresAt: true } }),
  ]);
  const premium = user ? isPremiumWithReversion(user) : false;
  return { caps: resolveHostingCaps(settings, { premium }), premium };
}

export interface HostingUsage {
  storageBytes: number;
  fileCount: number;
  bandwidthBytes: number;
  period: string;
}

export async function readUsage(userId: string, at: Date = new Date()): Promise<HostingUsage> {
  const period = monthPeriod(at);
  const [agg, fileCount, bandwidth] = await Promise.all([
    prisma.hostedAsset.aggregate({ where: { userId, status: "active" }, _sum: { bytes: true, bytesServed: true } }),
    prisma.hostedAsset.count({ where: { userId, status: "active" } }),
    prisma.hostingUsageMonthly.findUnique({ where: { userId_period: { userId, period } } }),
  ]);
  return {
    storageBytes: agg._sum.bytes ?? 0,
    fileCount,
    bandwidthBytes: Number(bandwidth?.bytesServed ?? 0),
    period,
  };
}

export async function listHostedFiles(userId: string): Promise<HostedFileView[]> {
  const rows = await prisma.hostedAsset.findMany({
    where: { userId, status: "active" },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toHostedFileView);
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}

export interface CreateHostedFileInput {
  userId: string;
  ip: string | null;
  filename: string;
  mime: string;
  /** The browser-reported size, used for the pre-flight quota check. The REAL
   *  size is re-measured while streaming and checked again before the row lands. */
  declaredBytes: number;
  body: ReadableStream<Uint8Array>;
  /** An executable class (§11.1) must be explicitly acknowledged, not implicit. */
  acknowledgeGated: boolean;
}

export async function createHostedFile(input: CreateHostedFileInput): Promise<HostingResult<HostedFileView>> {
  const { caps } = await resolveCapsForUser(input.userId);
  if (!caps.enabled) {
    return { ok: false, status: 403, code: "disabled", message: "Hosting is not enabled on this account yet." };
  }

  const scan = scanUpload(input.filename);
  if (!scan.ok) {
    return { ok: false, status: 400, code: scan.code, message: scan.message };
  }
  if (scan.gated && !input.acknowledgeGated) {
    return {
      ok: false,
      status: 400,
      code: "gated_ack_required",
      message: "This is an executable file. Confirm you intend to publish it, then try again.",
    };
  }

  const provider = resolveProvider(caps.provider);
  if (!provider.implemented) {
    return {
      ok: false,
      status: 400,
      code: "provider_not_ready",
      message: `The “${provider.label}” engine is not available yet. Switch back to “This server” to keep hosting.`,
    };
  }

  const usage = await readUsage(input.userId);
  const verdict = checkUpload(
    caps,
    { usedBytes: usage.storageBytes, fileCount: usage.fileCount, usedBandwidthBytes: usage.bandwidthBytes },
    { bytes: input.declaredBytes },
    provider.maxAssetMb
  );
  if (!verdict.ok) {
    return { ok: false, status: 400, code: verdict.code, message: verdict.message };
  }

  const token = newHostingToken();
  let stored;
  try {
    stored = await provider.put({
      token,
      userId: input.userId,
      filename: input.filename,
      mime: input.mime,
      body: input.body,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "The storage engine failed while saving the file.";
    return { ok: false, status: 502, code: "store_failed", message };
  }

  // Re-check against the REAL size we just wrote (declared size is a hint only).
  const ceilingMb =
    provider.maxAssetMb !== undefined ? Math.min(caps.maxFileSizeMb, provider.maxAssetMb) : caps.maxFileSizeMb;
  if (
    stored.bytes > ceilingMb * 1024 * 1024 ||
    usage.storageBytes + stored.bytes > caps.storageQuotaMb * 1024 * 1024
  ) {
    await provider.remove({ storagePath: stored.storagePath, externalId: stored.externalId }).catch(() => {});
    return {
      ok: false,
      status: 413,
      code: "quota_storage",
      message: "That file is larger than your remaining allowance, so it was not stored.",
    };
  }

  const dispositionFilename = sanitizeDispositionFilename(input.filename);
  const data = {
    userId: input.userId,
    kind: HOSTED_FILE_KIND,
    name: input.filename || dispositionFilename,
    token,
    provider: caps.provider,
    storagePath: stored.storagePath,
    externalId: stored.externalId,
    sha256: stored.sha256,
    bytes: stored.bytes,
    mime: input.mime || "application/octet-stream",
    dispositionFilename,
    visibility: "public",
    status: "active",
    url: stored.url,
    uploadIp: input.ip,
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const row = await prisma.hostedAsset.create({
        data: { ...data, token: attempt === 0 ? token : newHostingToken() },
      });
      return { ok: true, value: toHostedFileView(row) };
    } catch (err) {
      if (!isUniqueViolation(err) || attempt === 1) {
        await provider.remove({ storagePath: stored.storagePath, externalId: stored.externalId }).catch(() => {});
        throw err;
      }
    }
  }
  return { ok: false, status: 500, code: "unknown", message: "Could not save the file record." };
}



export interface RenameHostedFileInput {
  userId: string;
  id: string;
  /** New served filename (Content-Disposition). Does NOT touch the bytes. */
  displayName?: string;
  /** New slug for the P2 short link; null clears it. */
  slug?: string | null;
  visibility?: "public" | "private";
  /** New expiry; null clears it. */
  expiresAt?: Date | null;
}

/**
 * Rename / re-label / re-scope an asset WITHOUT touching the stored bytes. The
 * acceptance anchor: `sha256`, `bytes`, `storagePath` and `provider` are never in
 * the update payload, so the content hash is provably unchanged.
 */
export async function renameHostedFile(input: RenameHostedFileInput): Promise<HostingResult<HostedFileView>> {
  const row = await prisma.hostedAsset.findFirst({ where: { id: input.id, userId: input.userId, status: "active" } });
  if (!row) return { ok: false, status: 404, code: "not_found", message: "File not found." };

  const data: Record<string, unknown> = {};

  if (input.displayName !== undefined) {
    const name = sanitizeDispositionFilename(input.displayName);
    data.dispositionFilename = name;
    data.name = input.displayName.trim() || name;
  }
  if (input.slug !== undefined) {
    if (input.slug === null || input.slug === "") {
      data.slug = null;
    } else {
      const slug = input.slug.trim().toLowerCase();
      if (!isValidSlug(slug)) {
        return {
          ok: false,
          status: 400,
          code: "invalid_slug",
          message: "A link name can use letters, numbers and dashes only (max 63 characters).",
        };
      }
      data.slug = slug;
    }
  }
  if (input.visibility !== undefined) {
    if (input.visibility !== "public" && input.visibility !== "private") {
      return { ok: false, status: 400, code: "invalid_visibility", message: "Visibility must be public or private." };
    }
    data.visibility = input.visibility;
  }
  if (input.expiresAt !== undefined) {
    data.expiresAt = input.expiresAt;
  }

  if (Object.keys(data).length === 0) {
    return { ok: true, value: toHostedFileView(row) };
  }

  try {
    const updated = await prisma.hostedAsset.update({ where: { id: row.id }, data });
    return { ok: true, value: toHostedFileView(updated) };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { ok: false, status: 409, code: "slug_taken", message: "That link name is already taken. Pick another." };
    }
    throw err;
  }
}

/** Soft-delete (status "deleted"), then best-effort remove the bytes on disk. */
export async function deleteHostedFile(userId: string, id: string): Promise<HostingResult<{ id: string }>> {
  const row = await prisma.hostedAsset.findFirst({ where: { id, userId, status: "active" } });
  if (!row) return { ok: false, status: 404, code: "not_found", message: "File not found." };

  await prisma.hostedAsset.update({ where: { id: row.id }, data: { status: "deleted", deletedAt: new Date() } });
  // A failed unlink must not fail the delete — the row is already gone from the
  // user's view, and a sweep can reconcile orphans later.
  await resolveProvider(row.provider)
    .remove({ storagePath: row.storagePath, externalId: row.externalId })
    .catch(() => {});
  return { ok: true, value: { id: row.id } };
}

export interface ServableAsset {
  id: string;
  userId: string;
  provider: string;
  storagePath: string | null;
  externalId: string | null;
  dispositionFilename: string;
  mime: string;
  bytes: number;
  sha256: string;
}

/**
 * Resolve a public token for SERVING. Enforces the master switch, soft-delete,
 * visibility, expiry and the monthly bandwidth cap — returning a typed refusal so
 * the route answers 404/429, never a stack trace.
 */
export async function resolveServe(token: string): Promise<HostingResult<ServableAsset>> {
  const settings = await getAdminSettings();
  if (!settings.hostingEnabled) {
    return { ok: false, status: 404, code: "not_found", message: "Not found." };
  }

  const row = await prisma.hostedAsset.findFirst({ where: { token, status: "active" } });
  if (!row) return { ok: false, status: 404, code: "not_found", message: "Not found." };
  if (row.visibility !== "public") {
    // P1: private assets are not served on the public route. (Authorised
    // download arrives with the Connection/premium work.)
    return { ok: false, status: 404, code: "not_found", message: "Not found." };
  }
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    return { ok: false, status: 404, code: "expired", message: "This link has expired." };
  }

  const provider = resolveProvider(row.provider);
  if (!provider.implemented) {
    return { ok: false, status: 404, code: "not_found", message: "Not found." };
  }

  const caps = resolveHostingCaps(settings, { premium: false });
  const period = monthPeriod();
  const bandwidth = await prisma.hostingUsageMonthly.findUnique({
    where: { userId_period: { userId: row.userId, period } },
  });
  if (Number(bandwidth?.bytesServed ?? 0) >= caps.maxBandwidthGbPerMonth * 1024 * 1024 * 1024) {
    return {
      ok: false,
      status: 429,
      code: "quota_bandwidth",
      message: "This file has reached its monthly download limit.",
    };
  }

  return {
    ok: true,
    value: {
      id: row.id,
      userId: row.userId,
      provider: row.provider,
      storagePath: row.storagePath,
      externalId: row.externalId,
      dispositionFilename: row.dispositionFilename,
      mime: row.mime,
      bytes: row.bytes,
      sha256: row.sha256,
    },
  };
}

/** Best-effort: count a download for the asset and the user's monthly bandwidth.
 *  A failure here must never break the download the recipient clicked. */
export async function recordServe(asset: ServableAsset, servedBytes: number): Promise<void> {
  try {
    await prisma.$transaction([
      prisma.hostedAsset.update({
        where: { id: asset.id },
        data: { downloadCount: { increment: 1 }, bytesServed: { increment: BigInt(servedBytes) } },
      }),
      prisma.hostingUsageMonthly.upsert({
        where: { userId_period: { userId: asset.userId, period: monthPeriod() } },
        create: { userId: asset.userId, period: monthPeriod(), bytesServed: BigInt(servedBytes) },
        update: { bytesServed: { increment: BigInt(servedBytes) } },
      }),
    ]);
  } catch {
    // ignore — the download proceeds regardless
  }
}

