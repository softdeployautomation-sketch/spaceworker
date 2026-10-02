import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminSession } from "@/lib/admin-auth";
import { getAdminSettings } from "@/lib/admin-settings";
import { CLOUDFLARE_HARD_ASSET_MB } from "@/lib/hosting/rules";
import { listProviders } from "@/lib/hosting/providers";

// TASK_155 P1 (PLAN §14) — the admin dials for the FILES/hosting engine, mirroring
// app/api/admin/clone-limits: master switch + every cap + LIVE counts, so the owner
// can see how much is in use while deciding a limit instead of only the static
// number (CROSS-TRACK RULE 7 — every limit is an AdminSetting, nothing hardwired).
//
// PATCH is a SUBSET update: the panel sends only the field it changed, so editing
// one dial can never clobber another. No hosting behaviour is driven from here —
// lib/hosting/files.ts reads the same settings through lib/admin-settings.ts, so a
// change here changes server behaviour without a redeploy.

type LiveCounts = {
  /** Active (not soft-deleted) hosted assets across every user. */
  activeFiles: number;
  /** Total stored bytes across those assets. */
  storageBytes: number;
  /** Distinct users currently holding at least one active asset. */
  owners: number;
  /** TASK_155 P3 — hosted sites (the folder→preview→publish flow). */
  sites: number;
};

async function liveCounts(): Promise<LiveCounts> {
  const [activeFiles, agg, owners, sites] = await Promise.all([
    prisma.hostedAsset.count({ where: { status: "active" } }),
    prisma.hostedAsset.aggregate({ where: { status: "active" }, _sum: { bytes: true } }),
    prisma.hostedAsset.findMany({ where: { status: "active" }, select: { userId: true }, distinct: ["userId"] }),
    prisma.hostingSite.count(),
  ]);
  return { activeFiles, storageBytes: agg._sum.bytes ?? 0, owners: owners.length, sites };
}

// The writable subset, mapped to its AdminSetting column. Field names here match
// the panel (not the column names), so the API and the UI speak one language.
// `kind` decides the validation: bool, provider (enum), int (positive integer),
// capped (positive integer <= the engine's hard ceiling) or money.
const PROVIDER_IDS = listProviders().map((p) => p.id);

const WRITABLE_FIELDS = {
  enabled: { column: "hostingEnabled", kind: "bool" },
  provider: { column: "hostingProvider", kind: "provider" },
  freeStorageQuotaMb: { column: "hostingFreeStorageQuotaMb", kind: "int" },
  freeMaxFileSizeMb: { column: "hostingFreeMaxFileSizeMb", kind: "int" },
  freeMaxFiles: { column: "hostingFreeMaxFiles", kind: "int" },
  freeMaxBandwidthGbPerMonth: { column: "hostingFreeMaxBandwidthGbPerMonth", kind: "int" },
  premiumStorageQuotaMb: { column: "hostingPremiumStorageQuotaMb", kind: "int" },
  pagesMaxAssetMb: { column: "hostingPagesMaxAssetMb", kind: "capped" },
  platformTokenTtlHours: { column: "hostingPlatformTokenTtlHours", kind: "int" },
  modulePriceUsd: { column: "hostingModulePriceUsd", kind: "money" },
  // TASK_155 P2 — the per-user redirect-link cap.
  freeMaxLinks: { column: "hostingFreeMaxLinks", kind: "int" },
  // TASK_155 P4 — the premium twin (PLAN §17.2): premium links swap to this dial.
  premiumMaxLinks: { column: "hostingPremiumMaxLinks", kind: "int" },
  // TASK_155 P3 — the §16.3 premium cap family + the §16.6 heavy-load dials, so
  // the later resource-governor task has knobs to turn WITHOUT a schema change.
  premiumMaxProjects: { column: "hostingPremiumMaxProjects", kind: "int" },
  premiumMaxFilesPerProject: { column: "hostingPremiumMaxFilesPerProject", kind: "int" },
  premiumMaxBandwidthGbPerMonth: { column: "hostingPremiumMaxBandwidthGbPerMonth", kind: "int" },
  premiumDeploymentsPerDay: { column: "hostingPremiumDeploymentsPerDay", kind: "int" },
  previewTtlHours: { column: "hostingPreviewTtlHours", kind: "int" },
  maxZipMb: { column: "hostingMaxZipMb", kind: "int" },
  maxZipEntries: { column: "hostingMaxZipEntries", kind: "int" },
  maxHeavyJobsPerUser: { column: "hostingMaxHeavyJobsPerUser", kind: "int" },
  publishedRevisionsKept: { column: "hostingPublishedRevisionsKept", kind: "int" },
} as const;

const WRITABLE_KEYS = Object.keys(WRITABLE_FIELDS) as Array<keyof typeof WRITABLE_FIELDS>;

type HostingSettingRow = {
  hostingEnabled: boolean;
  hostingProvider: string;
  hostingFreeStorageQuotaMb: number;
  hostingFreeMaxFileSizeMb: number;
  hostingFreeMaxFiles: number;
  hostingFreeMaxBandwidthGbPerMonth: number;
  hostingPremiumStorageQuotaMb: number;
  hostingPagesMaxAssetMb: number;
  hostingPlatformTokenTtlHours: number;
  hostingModulePriceUsd: number;
  hostingFreeMaxLinks: number;
  hostingPremiumMaxLinks: number;
  hostingPremiumMaxProjects: number;
  hostingPremiumMaxFilesPerProject: number;
  hostingPremiumMaxBandwidthGbPerMonth: number;
  hostingPremiumDeploymentsPerDay: number;
  hostingPreviewTtlHours: number;
  hostingMaxZipMb: number;
  hostingMaxZipEntries: number;
  hostingMaxHeavyJobsPerUser: number;
  hostingPublishedRevisionsKept: number;
};

// The full state the panel renders, always returned fresh from both GET and PATCH
// so the UI can swap its state wholesale instead of merging field by field.
function toPayload(settings: HostingSettingRow, live: LiveCounts) {
  return {
    enabled: settings.hostingEnabled,
    provider: settings.hostingProvider,
    providers: listProviders(),
    caps: {
      freeStorageQuotaMb: settings.hostingFreeStorageQuotaMb,
      freeMaxFileSizeMb: settings.hostingFreeMaxFileSizeMb,
      freeMaxFiles: settings.hostingFreeMaxFiles,
      freeMaxBandwidthGbPerMonth: settings.hostingFreeMaxBandwidthGbPerMonth,
      premiumStorageQuotaMb: settings.hostingPremiumStorageQuotaMb,
      pagesMaxAssetMb: settings.hostingPagesMaxAssetMb,
      platformTokenTtlHours: settings.hostingPlatformTokenTtlHours,
      modulePriceUsd: settings.hostingModulePriceUsd,
      // TASK_155 P2 — the per-user redirect-link cap (see the write hook below).
      freeMaxLinks: settings.hostingFreeMaxLinks,
      premiumMaxLinks: settings.hostingPremiumMaxLinks,
      // TASK_155 P3 — the premium/site dials (§16.3) + heavy-load dials (§16.6).
      premiumMaxProjects: settings.hostingPremiumMaxProjects,
      premiumMaxFilesPerProject: settings.hostingPremiumMaxFilesPerProject,
      premiumMaxBandwidthGbPerMonth: settings.hostingPremiumMaxBandwidthGbPerMonth,
      premiumDeploymentsPerDay: settings.hostingPremiumDeploymentsPerDay,
      previewTtlHours: settings.hostingPreviewTtlHours,
      maxZipMb: settings.hostingMaxZipMb,
      maxZipEntries: settings.hostingMaxZipEntries,
      maxHeavyJobsPerUser: settings.hostingMaxHeavyJobsPerUser,
      publishedRevisionsKept: settings.hostingPublishedRevisionsKept,
    },
    // The Cloudflare per-asset ceiling is a HARD platform limit, not a dial — the
    // panel shows it so nobody sets pagesMaxAssetMb above it expecting it to hold.
    hardPagesMaxAssetMb: CLOUDFLARE_HARD_ASSET_MB,
    live,
  };
}

export async function GET() {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [settings, live] = await Promise.all([getAdminSettings(), liveCounts()]);
  return NextResponse.json(toPayload(settings, live));
}

// PATCH — body: a SUBSET of { enabled?, provider?, freeStorageQuotaMb?,
// freeMaxFileSizeMb?, freeMaxFiles?, freeMaxBandwidthGbPerMonth?,
// premiumStorageQuotaMb?, pagesMaxAssetMb?, platformTokenTtlHours?, modulePriceUsd? }.
// Counts must be whole numbers >= 1 (a 0 cap would read as "hosting never works"
// and is rejected rather than stored). pagesMaxAssetMb is additionally bounded by
// Cloudflare's hard ceiling (§9).
export async function PATCH(req: Request) {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const data: Record<string, boolean | number | string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!WRITABLE_KEYS.includes(key as keyof typeof WRITABLE_FIELDS)) {
      return NextResponse.json({ error: `Unknown setting: ${key}` }, { status: 400 });
    }
    const { column, kind } = WRITABLE_FIELDS[key as keyof typeof WRITABLE_FIELDS];
    if (kind === "bool") {
      if (typeof value !== "boolean") {
        return NextResponse.json({ error: `${key} must be a boolean` }, { status: 400 });
      }
      data[column] = value;
    } else if (kind === "provider") {
      if (typeof value !== "string" || !(PROVIDER_IDS as readonly string[]).includes(value)) {
        return NextResponse.json({ error: `${key} must be one of: ${PROVIDER_IDS.join(", ")}` }, { status: 400 });
      }
      data[column] = value;
    } else if (kind === "money") {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) {
        return NextResponse.json({ error: `${key} must be a number >= 0` }, { status: 400 });
      }
      data[column] = n;
    } else {
      const n = Number(value);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
        return NextResponse.json({ error: `${key} must be a positive integer` }, { status: 400 });
      }
      if (kind === "capped" && n > CLOUDFLARE_HARD_ASSET_MB) {
        return NextResponse.json(
          { error: `${key} cannot exceed ${CLOUDFLARE_HARD_ASSET_MB} MB (the hosting engine's hard per-asset limit)` },
          { status: 400 }
        );
      }
      data[column] = n;
    }
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  // Same upsert-into-singleton pattern getAdminSettings() uses, so the very first
  // PATCH (before any GET created the row) works and nobody else's value is lost.
  const updated = await prisma.adminSetting.upsert({
    where: { id: "singleton" },
    update: data,
    create: data,
  });

  const live = await liveCounts();
  return NextResponse.json(toPayload(updated, live));
}

