import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminSession } from "@/lib/admin-auth";
import { getAdminSettings } from "@/lib/admin-settings";
import { CLOUDFLARE_HARD_ASSET_MB } from "@/lib/hosting/rules";
import { normalizeHostInput, universalSslCovered } from "@/lib/hosting/domains";
import { listProviders } from "@/lib/hosting/providers";
import { readWorkerToken } from "@/lib/hosting/credentials";
import type { CfCredential } from "@/lib/hosting/cloudflare";
import { listActiveZones, isReservedZone } from "@/lib/hosting/workers";
import { provisionPublicHost, teardownPublicHost } from "@/lib/hosting/public-proxy";
import {
  resolvePurposeAccount,
  zoneMatchesHost,
  type DomainPurpose,
  type PurposeAccountPins,
} from "@/lib/hosting/domain-select";
import { resetPublicBaseCache } from "@/lib/hosting/public-bases";

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
  // TASK_157 Phase 1 — the platform-premium DOMAIN REGISTRY (PLAN_TASK_157 §3).
  // `kind: "host"` is its own validation case because "" is a MEANINGFUL value
  // here — it means "premium off, fall back to the free Cloudflare dev host" —
  // whereas every numeric kind above rejects anything below 1. So this is the one
  // pair of dials an admin turns OFF by clearing the box.
  //
  //   siteDomain = the base zone premium SITES publish under, so a site becomes
  //                <slug>.<siteDomain>. Must be an apex in the SAME Cloudflare
  //                account as the Pages project, or the custom domain can never
  //                activate (PLAN_TASK_157 §2.1).
  //   linkDomain = the full HOST premium LINK redirects publish under, e.g.
  //                go.instaweb.top — a host, not a zone, because the host is
  //                exactly what becomes the Worker route.
  siteDomain: { column: "hostingPremiumSiteDomain", kind: "host" },
  linkDomain: { column: "hostingPremiumLinkDomain", kind: "host" },

  // TASK_157 Phase 2 — the per-purpose account PINS. `kind: "accountId"` validates
  // the SHAPE only ("" = unpinned, else Cloudflare's 32-hex account id); it
  // deliberately does NOT check that a roster row exists for it. Splitting the
  // two jobs is the point: a typo is caught here at SAVE time, while a
  // well-formed id whose row was later deleted is reported at USE time by the
  // resolver as `pinned_account_missing`. Validating existence here too would
  // make a healthy account impossible to configure before its row exists.
  //
  //   premiumLinksAccountId = the Cloudflare account dedicated to premium LINKS.
  //   premiumSitesAccountId = the Cloudflare account dedicated to premium SITES.
  premiumLinksAccountId: { column: "hostingPremiumLinksAccountId", kind: "accountId" },
  premiumSitesAccountId: { column: "hostingPremiumSitesAccountId", kind: "accountId" },

  // TASK_249 — the ONE public host behind /hf/* + /link/vantra/*, and the
  // Cloudflare account the public proxy publishes to.
  publicLinkHost: { column: "hostingPublicLinkHost", kind: "host" },
  publicLinksAccountId: { column: "hostingPublicLinksAccountId", kind: "accountId" },
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
  // TASK_157 Phase 1 — the premium domain registry (empty string = not set).
  hostingPremiumSiteDomain: string;
  hostingPremiumLinkDomain: string;
  // TASK_157 Phase 2 — the per-purpose Cloudflare account pins, by ACCOUNT id.
  // Empty string = unpinned = automatic priority rotation.
  hostingPremiumLinksAccountId: string;
  hostingPremiumSitesAccountId: string;
  // TASK_249 — the public proxy host + account pin (nullable, additive).
  hostingPublicLinkHost: string | null;
  hostingPublicLinksAccountId: string | null;
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
    // TASK_157 Phase 1 — the premium domain registry, plus the ONE derived fact
    // the panel cannot compute for itself: whether a site published under this
    // base domain would actually get a free certificate.
    domains: {
      siteDomain: settings.hostingPremiumSiteDomain,
      linkDomain: settings.hostingPremiumLinkDomain,
      // <slug>.<siteDomain> is only covered by Cloudflare's free Universal SSL
      // when the base IS an apex. Compute the depth of a REAL example host (not
      // the base itself) so the panel can warn before anyone publishes a
      // certificate-less site. True while unset — "off" is never a warning.
      siteDomainCoversSsl: settings.hostingPremiumSiteDomain
        ? universalSslCovered(`example.${normalizeHostInput(settings.hostingPremiumSiteDomain) ?? ""}`)
        : true,
      // TASK_157 Phase 2 — the per-purpose Cloudflare account pins, by ACCOUNT id.
      // "" means "not pinned": the panel renders that as "Automatic (priority
      // rotation)" so nobody mistakes an unpinned default for a chosen account.
      premiumLinksAccountId: settings.hostingPremiumLinksAccountId,
      premiumSitesAccountId: settings.hostingPremiumSitesAccountId,
      // TASK_249 — the public proxy host + account pin.
      publicLinkHost: settings.hostingPublicLinkHost,
      publicLinksAccountId: settings.hostingPublicLinksAccountId,
    },
    // The Cloudflare per-asset ceiling is a HARD platform limit, not a dial — the
    // panel shows it so nobody sets pagesMaxAssetMb above it expecting it to hold.
    hardPagesMaxAssetMb: CLOUDFLARE_HARD_ASSET_MB,
    live,
  };
}

// TASK_249 — the per-purpose Cloudflare account the domain selector lists
// zones for. Pure resolution lives in lib/hosting/domain-select.ts so the
// files-→-links-pin fallback is unit-tested instead of re-implemented here.
const PURPOSE_LABEL: Record<DomainPurpose, string> = {
  links: "premium links",
  sites: "premium sites",
  public: "files & installer",
};

function purposePins(settings: HostingSettingRow): PurposeAccountPins {
  return {
    links: settings.hostingPremiumLinksAccountId?.trim() || null,
    sites: settings.hostingPremiumSitesAccountId?.trim() || null,
    public: settings.hostingPublicLinksAccountId?.trim() || null,
  };
}

/**
 * GET /api/admin/hosting/zones?purpose=links|sites|public[&accountId=<cf id>]
 *
 * Lists the active zones in the pinned Cloudflare account for a domain-selector
 * purpose. `accountId` lets the panel preview the zones of an account it has
 * selected but not saved yet (switching account + domain in one Apply).
 * Tokens are decrypted on the fly and NEVER serialized in the response.
 *
 * Response shape: { accountId, label, zones[{id,name,status}], canListZones, error }
 */
async function handleZonesGet(
  purpose: DomainPurpose,
  requestedAccountId: string | null
): Promise<NextResponse> {
  const settings = await getAdminSettings();
  const accountId =
    requestedAccountId?.trim() ||
    resolvePurposeAccount(purpose, purposePins(settings));

  if (!accountId) {
    return NextResponse.json({
      accountId: null,
      label: null,
      zones: [],
      canListZones: false,
      error: `No Cloudflare account is pinned for ${PURPOSE_LABEL[purpose]}. Pick one, then Apply.`,
    });
  }

  const row = await prisma.hostingPlatformAccount.findFirst({
    where: { accountId },
  });
  if (!row) {
    return NextResponse.json({
      accountId,
      label: null,
      zones: [],
      canListZones: false,
      error: "The pinned Cloudflare account was not found.",
    });
  }

  // Require the Workers/DNS token — without it we cannot list zones.
  const workerToken = readWorkerToken(row);
  if (!workerToken) {
    return NextResponse.json({
      accountId,
      label: row.label,
      zones: [],
      canListZones: false,
      error:
        "This account has no Workers/DNS token. Add one in the admin panel to list zones.",
    });
  }

  const cred: CfCredential = { accountId, token: workerToken };
  const listed = await listActiveZones(cred);
  if (!listed.ok) {
    return NextResponse.json({
      accountId,
      label: row.label,
      zones: [],
      canListZones: false,
      error: listed.error ?? "Could not list zones from Cloudflare.",
    });
  }

  return NextResponse.json({
    accountId,
    label: row.label,
    zones: (listed.value ?? []).map((z) => ({
      id: z.id,
      name: z.name,
      status: z.status,
    })),
    canListZones: true,
    error: null,
  });
}

export async function GET(req?: Request) {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // TASK_249 — zone listing for the domain-selector dropdown. The request is
  // optional (unit tests and any no-URL caller still get the settings payload).
  let purpose: string | null = null;
  let requestedAccountId: string | null = null;
  try {
    if (req) {
      const params = new URL(req.url).searchParams;
      purpose = params.get("purpose");
      requestedAccountId = params.get("accountId");
    }
  } catch {
    purpose = null;
    requestedAccountId = null;
  }
  if (purpose === "links" || purpose === "sites" || purpose === "public") {
    return handleZonesGet(purpose, requestedAccountId);
  }

  const [settings, live] = await Promise.all([getAdminSettings(), liveCounts()]);
  return NextResponse.json(toPayload(settings, live));
}


/**
 * Validate that a host being saved sits under an active zone in the pinned
 * account for its purpose, and meets the depth/SSL rules for that purpose.
 * Returns null when valid, or a plain-language 400 message naming the account
 * and zone when it is not. Tokens are never in the message.
 */
async function validateHostZone(
  purpose: DomainPurpose,
  host: string,
  settings: HostingSettingRow
): Promise<string | null> {
  // RESERVED_ZONES is a hard refusal everywhere, including admin PATCH.
  if (isReservedZone(host)) {
    return `${host} belongs to a reserved domain and cannot be used for hosting. Pick another domain.`;
  }

  // `*.workers.dev` is Cloudflare's own free host, not a zone in any account.
  // TASK_157 Phase 3 supports it as the premium-LINK dev host (the admin value
  // is a SUFFIX: swdocs.workers.dev), so it stays valid without a zone check.
  const workersDev = normalizeHostInput(host);
  if (
    purpose === "links" &&
    (workersDev === "workers.dev" || workersDev?.endsWith(".workers.dev"))
  ) {
    return null;
  }

  // The pin is read from the settings that WILL be stored (the caller merges the
  // incoming pin over the saved one), so switching account + domain in one Apply
  // validates against the account the admin just chose.
  const accountId = resolvePurposeAccount(purpose, purposePins(settings));

  if (!accountId) {
    return `No Cloudflare account is pinned for ${PURPOSE_LABEL[purpose]}. Pick one, then Apply.`;
  }

  const row = await prisma.hostingPlatformAccount.findFirst({
    where: { accountId },
  });
  if (!row) {
    return `The pinned Cloudflare account (${accountId}) was not found.`;
  }

  const workerToken = readWorkerToken(row);
  if (!workerToken) {
    return `The pinned account (${accountId}) has no Workers/DNS token, so its zones cannot be checked. Add one in the admin panel.`;
  }

  const cred: CfCredential = { accountId, token: workerToken };
  const listed = await listActiveZones(cred);
  if (!listed.ok) {
    return `Could not list zones for account ${accountId}: ${listed.error ?? "Cloudflare error."}`;
  }

  // Suffix match, NOT a last-two-labels guess: a zone can be deeper than two
  // labels (example.co.uk), and the live zone list is the authority.
  const normalized = normalizeHostInput(host);
  if (!normalized) {
    return `"${host}" is not a valid domain name.`;
  }

  const activeZone = (listed.value ?? []).find((z) => {
    const name = z.name?.toLowerCase();
    return !!name && (normalized === name || normalized.endsWith(`.${name}`));
  });
  if (!activeZone) {
    return `${host} is not under an active zone in account ${accountId}. Add the domain to Cloudflare first, or choose a different domain.`;
  }

  const isApex = purpose === "sites";
  if (!zoneMatchesHost(normalized, activeZone.name, isApex)) {
    return isApex
      ? `A premium site domain must be the zone apex itself ("${activeZone.name}"), not "${normalized}".`
      : `A ${PURPOSE_LABEL[purpose]} host must be exactly one label under ${activeZone.name} (e.g. "go.${activeZone.name}"), not "${normalized}".`;
  }

  return null;
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

  // TASK_249 — read settings once so PATCH-time zone validation can resolve
  // the purpose's account pin without a second read.
  const settings = await getAdminSettings();

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
    } else if (kind === "host") {
      // "" is first-class here: it means "premium off, use the free dev host".
      // Anything else must be a real hostname, so a typo fails loudly at SAVE
      // time instead of silently publishing links to a host that never resolves.
      // The value is NORMALISED ("https://Go.InstaWeb.top/" -> "go.instaweb.top")
      // so the resolver and the panel never disagree about the stored string.
      if (typeof value !== "string") {
        return NextResponse.json({ error: `${key} must be a string` }, { status: 400 });
      }
      if (value.trim() === "") {
        data[column] = "";
      } else {
        const host = normalizeHostInput(value);
        if (!host) {
          return NextResponse.json(
            {
              error: `${key} must be a domain like instaweb.top — leave it empty to use the free Cloudflare host`,
            },
            { status: 400 }
          );
        }
        data[column] = host;
      }
    } else if (kind === "accountId") {
      // "" unpins, exactly like `kind: "host"`: an admin clears the box to go
      // back to automatic priority rotation.
      if (typeof value !== "string") {
        return NextResponse.json({ error: `${key} must be a string` }, { status: 400 });
      }
      const trimmed = value.trim();
      if (trimmed === "") {
        data[column] = "";
      } else if (!/^[0-9a-f]{32}$/i.test(trimmed)) {
        // Cloudflare account ids are exactly 32 hex chars. A truncated paste is by
        // far the most likely mistake (the dashboard and our own roster label both
        // show shortened ids), so report the length back: without it "must be 32
        // characters" is read as "this is broken" rather than "you pasted half of
        // it", and the admin has nothing to compare against.
        const looksTruncated = /^[0-9a-f]+$/i.test(trimmed);
        return NextResponse.json(
          {
            error: looksTruncated
              ? `${key} is ${trimmed.length} characters — a Cloudflare account ID is 32. Copy the whole ID from the account row.`
              : `${key} must be a Cloudflare account ID (32 hex characters) — or empty for automatic rotation`,
          },
          { status: 400 }
        );
      } else {
        data[column] = trimmed.toLowerCase();
      }
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

  // TASK_249 — the settings this PATCH will actually store: an incoming pin wins
  // over the saved one, so switching account + domain in one Apply validates
  // against the account the admin just chose (not the stale saved pin).
  const effectiveSettings: HostingSettingRow = {
    ...settings,
    ...(typeof data.hostingPremiumLinksAccountId === "string"
      ? { hostingPremiumLinksAccountId: data.hostingPremiumLinksAccountId }
      : {}),
    ...(typeof data.hostingPremiumSitesAccountId === "string"
      ? { hostingPremiumSitesAccountId: data.hostingPremiumSitesAccountId }
      : {}),
    ...(typeof data.hostingPublicLinksAccountId === "string"
      ? { hostingPublicLinksAccountId: data.hostingPublicLinksAccountId }
      : {}),
  };

  // TASK_249 — async zone validation for host fields being patched.
  // Runs after synchronous normalization so we validate the stored form.
  const HOST_FIELD_PURPOSE: Record<
    "publicLinkHost" | "siteDomain" | "linkDomain",
    DomainPurpose
  > = {
    publicLinkHost: "public",
    siteDomain: "sites",
    linkDomain: "links",
  };
  for (const [key, purpose] of Object.entries(HOST_FIELD_PURPOSE)) {
    const column = WRITABLE_FIELDS[key as keyof typeof WRITABLE_FIELDS].column;
    const host = data[column];
    if (typeof host !== "string" || host === "") continue;
    const err = await validateHostZone(purpose, host, effectiveSettings);
    if (err) {
      return NextResponse.json({ error: err }, { status: 400 });
    }
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  // TASK_249 — the public host change, if any. Provision BEFORE the upsert: a
  // host the Worker cannot serve must never be stored, or every new file and
  // installer link is born broken.
  const oldPublicLinkHost = settings.hostingPublicLinkHost?.trim() || null;
  const newPublicLinkHost =
    typeof data.hostingPublicLinkHost === "string"
      ? data.hostingPublicLinkHost
      : undefined;
  const oldPublicPin = settings.hostingPublicLinksAccountId?.trim() || null;
  const newPublicPin =
    typeof data.hostingPublicLinksAccountId === "string"
      ? data.hostingPublicLinksAccountId.trim() || null
      : oldPublicPin;
  const publicPinChanged = newPublicPin !== oldPublicPin;

  let provisionResult:
    | { ok: boolean; host: string; error: string | null; warning?: string }
    | null = null;
  if (
    newPublicLinkHost &&
    (newPublicLinkHost !== oldPublicLinkHost || publicPinChanged)
  ) {
    const result = await provisionPublicHost(newPublicLinkHost, {
      accountId: newPublicPin,
    });
    provisionResult = { ok: result.ok, host: result.host, error: result.error };
    if (!result.ok) {
      return NextResponse.json(
        {
          error: `Could not provision ${newPublicLinkHost}: ${result.error ?? "unknown error"}`,
          provisionResult,
        },
        { status: 400 }
      );
    }
  }

  // Same upsert-into-singleton pattern getAdminSettings() uses, so the very first
  // PATCH (before any GET created the row) works and nobody else's value is lost.
  const updated = await prisma.adminSetting.upsert({
    where: { id: "singleton" },
    update: data,
    create: data,
  });

  // The 60s base cache must not keep serving the old host after the admin
  // changed it in this same process.
  resetPublicBaseCache();

  // Detach the previous host only AFTER the new one is saved and live. Best
  // effort: a leftover route is harmless; failing the save over it is not.
  if (
    newPublicLinkHost !== undefined &&
    oldPublicLinkHost &&
    oldPublicLinkHost !== newPublicLinkHost
  ) {
    const torn = await teardownPublicHost(oldPublicLinkHost, {
      accountId: oldPublicPin,
    });
    if (!torn.ok && provisionResult) {
      provisionResult = {
        ...provisionResult,
        warning: `The old host ${oldPublicLinkHost} was not fully removed: ${
          torn.error ?? "unknown error"
        }`,
      };
    }
  }

  const live = await liveCounts();
  return NextResponse.json({
    ...toPayload(updated, live),
    provisionResult,
  });
}

