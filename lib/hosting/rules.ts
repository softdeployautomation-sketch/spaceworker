import { createHash } from "node:crypto";

// TASK_155 P1 — the FILES engine's PURE rules. No prisma, no fs, no network, so
// the P1 acceptance list ("hash unchanged by rename", "a quota breach returns a
// clear message not a 500", "oversize for Cloudflare is caught BEFORE the upload")
// is provable with a unit test instead of only on the VPS. Everything stateful
// (the DB rows, the bytes on disk) lives in lib/hosting/files.ts and
// lib/hosting/providers.ts and is live-verified separately.

// ---------------------------------------------------------------------------
// Storage providers — the owner's "multi options available" (2026-10-01):
// host on our own metal, push directly to Cloudflare, or add an external
// service. The interface is identical for all three; which one is used is an
// AdminSetting (hostingProvider), never a hardcoded choice.
// ---------------------------------------------------------------------------
export const HOSTING_PROVIDER_IDS = ["local", "cloudflare", "external"] as const;
export type HostingProviderId = (typeof HOSTING_PROVIDER_IDS)[number];

export function isHostingProviderId(value: unknown): value is HostingProviderId {
  return typeof value === "string" && (HOSTING_PROVIDER_IDS as readonly string[]).includes(value);
}

// Human labels for the admin picker + the Connection pane.
export const HOSTING_PROVIDER_LABELS: Record<HostingProviderId, string> = {
  local: "This server (free, no third party)",
  cloudflare: "Cloudflare Pages (direct upload)",
  external: "External service (bring your own)",
};

// ---------------------------------------------------------------------------
// Caps — resolved from AdminSetting (CROSS-TRACK RULE 7; owner 2026-10-01:
// "we can add to the admin where those limits can be easily changed").
// ---------------------------------------------------------------------------

/** The AdminSetting fields the resolver reads — a plain shape so a test can pass
 *  a literal and not a whole prisma row. */
export interface HostingCapSource {
  hostingEnabled: boolean;
  hostingProvider: string;
  hostingFreeStorageQuotaMb: number;
  hostingFreeMaxFileSizeMb: number;
  hostingFreeMaxFiles: number;
  hostingFreeMaxBandwidthGbPerMonth: number;
  hostingPremiumStorageQuotaMb: number;
  hostingPagesMaxAssetMb: number;
  hostingPlatformTokenTtlHours: number;
  /** TASK_155 P2 — per-user cap on user-owned redirect links (AdminSetting). */
  hostingFreeMaxLinks: number;
  // TASK_155 P3 — the premium/site dials (§16.3/§16.6).
  hostingPremiumMaxProjects: number;
  hostingPremiumMaxFilesPerProject: number;
  hostingPremiumMaxBandwidthGbPerMonth: number;
  hostingPremiumDeploymentsPerDay: number;
  hostingPreviewTtlHours: number;
  hostingMaxZipMb: number;
  hostingMaxZipEntries: number;
  hostingMaxHeavyJobsPerUser: number;
  hostingPublishedRevisionsKept: number;
}

export interface HostingCaps {
  /** The master switch (PLAN §9 P1: dark until the owner turns it on). */
  enabled: boolean;
  /** Which engine serves NEW uploads (known id, else "local"). */
  provider: HostingProviderId;
  /** Per-user TOTAL bytes allowed, resolved free-vs-premium. */
  storageQuotaMb: number;
  /** Per-file ceiling. */
  maxFileSizeMb: number;
  /** Per-user file COUNT ceiling. */
  maxFiles: number;
  /** Per-user downloads served per calendar month. */
  maxBandwidthGbPerMonth: number;
  /** Cloudflare Pages per-asset ceiling — MUST stay < 25 (see §9 R3). */
  pagesMaxAssetMb: number;
  /** How long a platform-token project lives before reclaim. */
  platformTokenTtlHours: number;
  /** TASK_155 P2 — per-user redirect-link count ceiling. */
  maxLinks: number;
  // TASK_155 P3 — the premium/site caps (§16.3/§16.6).
  /** Premium projects per user. */
  premiumMaxProjects: number;
  /** Files per project. */
  premiumMaxFilesPerProject: number;
  /** Premium bandwidth soft-alert threshold (GB/month). */
  premiumMaxBandwidthGbPerMonth: number;
  /** Preview + publish deployments per user per day. */
  premiumDeploymentsPerDay: number;
  /** How long an unpublished preview lives before it is swept. */
  previewTtlHours: number;
  /** Upload archive ceiling (MB). */
  maxZipMb: number;
  /** Entries per archive (the Direct-Upload ceiling). */
  maxZipEntries: number;
  /** Concurrent heavy jobs per user (the §16.6 single-slot lock). */
  maxHeavyJobsPerUser: number;
  /** Published revisions kept per project (one-click undo). */
  publishedRevisionsKept: number;
}

export const MB = 1024 * 1024;
export const GB = 1024 * MB;

// The hard Cloudflare Pages per-asset ceiling WITNESSED live (TASK_155 §9: a
// 26 MiB asset returns a raw 500). We never forward a file at/over this — we
// reject it ourselves with a clear message, so the 500 can't happen.
export const CLOUDFLARE_HARD_ASSET_MB = 25;

/**
 * Resolve the caps for one user. `premium` swaps the storage quota for the
 * (larger) premium figure; every other dial is shared so free and premium can't
 * drift apart on the numbers that matter for abuse (file size, count, bandwidth).
 * An unknown stored provider falls back to "local" (schema contract) — a typo in
 * admin must never break uploads.
 */
export function resolveHostingCaps(src: HostingCapSource, opts: { premium: boolean }): HostingCaps {
  return {
    enabled: src.hostingEnabled,
    provider: isHostingProviderId(src.hostingProvider) ? src.hostingProvider : "local",
    storageQuotaMb: opts.premium ? src.hostingPremiumStorageQuotaMb : src.hostingFreeStorageQuotaMb,
    maxFileSizeMb: src.hostingFreeMaxFileSizeMb,
    maxFiles: src.hostingFreeMaxFiles,
    maxBandwidthGbPerMonth: src.hostingFreeMaxBandwidthGbPerMonth,
    pagesMaxAssetMb: Math.min(src.hostingPagesMaxAssetMb, CLOUDFLARE_HARD_ASSET_MB),
    platformTokenTtlHours: src.hostingPlatformTokenTtlHours,
    maxLinks: src.hostingFreeMaxLinks,
    // TASK_155 P3 — the premium/site dials (shared; premium only swaps the quota).
    premiumMaxProjects: src.hostingPremiumMaxProjects,
    premiumMaxFilesPerProject: src.hostingPremiumMaxFilesPerProject,
    premiumMaxBandwidthGbPerMonth: src.hostingPremiumMaxBandwidthGbPerMonth,
    premiumDeploymentsPerDay: src.hostingPremiumDeploymentsPerDay,
    previewTtlHours: src.hostingPreviewTtlHours,
    maxZipMb: src.hostingMaxZipMb,
    maxZipEntries: src.hostingMaxZipEntries,
    maxHeavyJobsPerUser: src.hostingMaxHeavyJobsPerUser,
    publishedRevisionsKept: src.hostingPublishedRevisionsKept,
  };
}

// ---------------------------------------------------------------------------
// Quota checks. A breach is a typed verdict with a user-facing message — the
// route turns it into a 4xx, never a 500 (P1 acceptance).
// ---------------------------------------------------------------------------

export interface QuotaState {
  /** Sum of active assets' bytes for the user. */
  usedBytes: number;
  /** Count of active assets for the user. */
  fileCount: number;
  /** Bytes served (downloaded) this calendar month. */
  usedBandwidthBytes: number;
}

export type QuotaCode =
  | "disabled"
  | "quota_storage"
  | "quota_files"
  | "quota_file_size"
  | "quota_bandwidth"
  | "too_large_for_provider";

export type QuotaVerdict = { ok: true } | { ok: false; code: QuotaCode; message: string };

function mb(n: number): string {
  return `${n} MB`;
}
function gb(n: number): string {
  return `${n} GB`;
}

/**
 * Can this user upload this file right now? `providerCeilingMb` is the engine's
 * own per-asset limit (undefined for providers with none, e.g. local metal).
 */
export function checkUpload(
  caps: HostingCaps,
  state: QuotaState,
  file: { bytes: number },
  providerCeilingMb?: number
): QuotaVerdict {
  if (!caps.enabled) {
    return { ok: false, code: "disabled", message: "Hosting is not enabled on this account yet." };
  }
  const sizeLimitMb =
    providerCeilingMb !== undefined ? Math.min(caps.maxFileSizeMb, providerCeilingMb) : caps.maxFileSizeMb;
  if (file.bytes > sizeLimitMb * MB) {
    // A provider ceiling that is the binding one gets its own message, so a user
    // who hits Cloudflare's 25 MiB rule is told the real reason (not "512 MB").
    if (
      providerCeilingMb !== undefined &&
      providerCeilingMb < caps.maxFileSizeMb &&
      file.bytes > providerCeilingMb * MB
    ) {
      return {
        ok: false,
        code: "too_large_for_provider",
        message: `This file is larger than ${mb(providerCeilingMb)}, the limit for the selected hosting engine. Try a smaller file or switch engines.`,
      };
    }
    return { ok: false, code: "quota_file_size", message: `Files are limited to ${mb(sizeLimitMb)} each.` };
  }
  if (state.fileCount + 1 > caps.maxFiles) {
    return {
      ok: false,
      code: "quota_files",
      message: `You have reached your limit of ${caps.maxFiles} files. Delete one to upload another.`,
    };
  }
  if (state.usedBytes + file.bytes > caps.storageQuotaMb * MB) {
    return {
      ok: false,
      code: "quota_storage",
      message: `This upload would exceed your ${mb(caps.storageQuotaMb)} storage limit. Free up space or upgrade.`,
    };
  }
  if (state.usedBandwidthBytes >= caps.maxBandwidthGbPerMonth * GB) {
    return {
      ok: false,
      code: "quota_bandwidth",
      message: `Your files have been downloaded ${gb(caps.maxBandwidthGbPerMonth)} this month — the monthly limit. It resets next month.`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Upload safety scan (PLAN §11.1). We host executables on purpose, so the policy
// is: NEVER host active web content or OS-runnable scripts; ALLOW executables as
// a GATED class (the caller can require an explicit acknowledgement); allow
// everything else by extension.
// ---------------------------------------------------------------------------

// Denied outright: server-side script/webshell extensions and browser-active
// content that would render/execute if a link were ever opened inline rather than
// downloaded. Hosting a *page* is the Pages engine's job (P3), not this one.
export const BLOCKED_EXTENSIONS = new Set<string>([
  // server-side script / webshell
  "php", "php3", "php4", "php5", "phtml", "pht",
  "jsp", "jspx", "asp", "aspx", "ashx", "cgi", "pl", "py", "rb",
  // shell scripts
  "sh", "bash", "zsh", "ps1", "psm1", "bat", "cmd", "com", "scr", "vbs", "vbe", "wsf", "wsh", "hta", "lnk",
  // browser-active content (would run if served inline)
  "html", "htm", "xhtml", "svg", "js", "mjs", "cjs",
  // java archive
  "jar",
]);

// Allowed but flagged: the caller can demand an explicit acknowledgement before
// publishing an executable (PLAN §11.1 "EXE uploads are a distinct, gated class").
export const GATED_EXTENSIONS = new Set<string>([
  "exe", "msi", "msix", "appx", "dmg", "appimage", "deb", "rpm", "apk",
]);

export type ScanVerdict =
  | { ok: true; gated: boolean; extension: string }
  | { ok: false; code: "blocked_extension"; message: string };

/** Lowercased extension WITHOUT the dot, or "" when there is none. */
export function extensionOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function scanUpload(filename: string): ScanVerdict {
  const extension = extensionOf(filename);
  if (BLOCKED_EXTENSIONS.has(extension)) {
    return {
      ok: false,
      code: "blocked_extension",
      // Deliberately plain: say what happened, not which list matched.
      message: `Files of type “.${extension}” can’t be hosted as downloads. Rename it or host it as a page instead.`,
    };
  }
  return { ok: true, gated: GATED_EXTENSIONS.has(extension), extension };
}

// TASK_155 P3 — the SITE scan (a folder that becomes a Pages site). This is a
// DIFFERENT policy from scanUpload: a site is *made of* html/js/css/svg, so those
// are allowed here (they were denied for downloads because a download must never
// render inline). What a static site must NEVER carry is SERVER-SIDE executable
// content — a `.php`/`.jsp`/`.cgi`/`.sh` that a misconfigured host could run — so
// only that class is refused, by name, before extraction completes (§16.1).
export const SITE_BLOCKED_EXTENSIONS = new Set<string>([
  "php", "php3", "php4", "php5", "phtml", "pht",
  "jsp", "jspx", "asp", "aspx", "ashx", "cgi", "pl", "py", "rb",
  "sh", "bash", "zsh", "ps1", "psm1", "bat", "cmd", "com", "scr", "vbs", "vbe", "wsf", "wsh", "hta", "lnk",
  "jar",
]);

export function scanSiteFile(filename: string): ScanVerdict {
  const extension = extensionOf(filename);
  if (SITE_BLOCKED_EXTENSIONS.has(extension)) {
    return {
      ok: false,
      code: "blocked_extension",
      message: `Files of type “.${extension}” can’t be published in a site — a site is static content only. Remove it and try again.`,
    };
  }
  return { ok: true, gated: false, extension };
}

// ---------------------------------------------------------------------------
// Filename handling. The served name is a header value, so it must be free of
// control characters, quotes/backslashes and path separators — otherwise a
// crafted name could corrupt the Content-Disposition header.
// ---------------------------------------------------------------------------
export function sanitizeDispositionFilename(input: string): string {
  const stripped = input
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]/g, "_")
    .replace(/["]/g, "'")
    .trim();
  const base = stripped.split(/[\\/]/).pop() ?? stripped;
  const safe = base.slice(0, 200) || "download";
  // Never let the name be just dots (would be an odd "..\.." artifact).
  return /^\.+$/.test(safe) ? "download" : safe;
}

// ---------------------------------------------------------------------------
// Tokens & slugs.
// ---------------------------------------------------------------------------

/** Opaque, url-safe public lookup key (base64url of 18 random bytes = 24 chars).
 *  NOT a secret (mirrors LinkRedirect.token) — an unknown token 404s cleanly. */
export function newHostingToken(): string {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  return base64url(bytes);
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

/**
 * TASK_155 P2 — a redirect target must be an absolute http(s) URL. This is the
 * only thing stopping a user link from becoming a `javascript:` or `data:` XSS
 * vector on the world-readable /r/<key> route, so it is deliberately strict: any
 * scheme other than http/https is refused, not "sanitized".
 */
export function isValidLinkTarget(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Hashing + time.
// ---------------------------------------------------------------------------
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** "YYYY-MM" in UTC — the HostingUsageMonthly key (no TZ maths needed). */
export function monthPeriod(at: Date = new Date()): string {
  const y = at.getUTCFullYear();
  const m = String(at.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

