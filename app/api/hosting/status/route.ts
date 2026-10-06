import { NextResponse } from "next/server";

import { getAdminSettings } from "@/lib/admin-settings";
import { hasEntitlement } from "@/lib/entitlements";
import { env } from "@/lib/env";
import { getCurrentUser } from "@/lib/session-user";
import { readUsage, resolveCapsForUser } from "@/lib/hosting/files";
import { listHostingCredentials, countSitesByCredential } from "@/lib/hosting/credentials";
import { listProviders } from "@/lib/hosting/providers";
import { hostingPublicBase } from "@/lib/hosting/providers";
import { listHostedLinks } from "@/lib/hosting/links";
import { healthyPlatformAccountCount } from "@/lib/hosting/platform-accounts";

// TASK_155 P1 — GET /api/hosting/status.
//
// The Hosting tab's single "what am I allowed to do right now" read. Always 200
// for an authenticated user so the tab can render an honest state (upgrade
// prompt vs live surface) instead of an error. `enabled` is the platform master
// switch (AdminSetting.hostingEnabled, OFF by default — PLAN §9 P1 "dark");
// `entitled` is the per-user `hosting` entitlement (premium tier 5 passes it too).
export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [settings, decision] = await Promise.all([getAdminSettings(), hasEntitlement(user.id, "hosting")]);
  const entitled = decision.allowed;
  const { caps, premium } = await resolveCapsForUser(user.id);
  const [usage, links, credentials, siteCounts, platformHealthy] = await Promise.all([
    readUsage(user.id),
    listHostedLinks(user.id),
    listHostingCredentials(user.id),
    countSitesByCredential(user.id),
    // TASK_155 P6a (PLAN §19.4) — the picker must not OFFER a Premium option we
    // cannot honour. `premiumAvailable` is therefore the AND of "the user is
    // premium" and "at least one platform account is healthy right now".
    healthyPlatformAccountCount(),
  ]);

  return NextResponse.json({
    enabled: settings.hostingEnabled,
    entitled,
    entitlementReason: decision.reason,
    provider: caps.provider,
    providers: listProviders(),
    publicBase: hostingPublicBase(),
    // TASK_155 P2 — where a user-owned /r/<slug|token> short link resolves. This
    // is the APP host (the same base Task 30 campaign links use), NOT the file
    // host: files are served from `publicBase`, short links from here.
    linksBase: env.publicLinkBaseUrl,
    caps: {
      storageQuotaMb: caps.storageQuotaMb,
      maxFileSizeMb: caps.maxFileSizeMb,
      maxFiles: caps.maxFiles,
      maxBandwidthGbPerMonth: caps.maxBandwidthGbPerMonth,
      pagesMaxAssetMb: caps.pagesMaxAssetMb,
      // TASK_155 P2.
      maxLinks: caps.maxLinks,
      // TASK_155 P3 — the site/premium dials (PLAN §16.3/§16.6).
      premiumMaxProjects: caps.premiumMaxProjects,
      premiumMaxFilesPerProject: caps.premiumMaxFilesPerProject,
      premiumDeploymentsPerDay: caps.premiumDeploymentsPerDay,
      maxZipMb: caps.maxZipMb,
      previewTtlHours: caps.previewTtlHours,
      publishedRevisionsKept: caps.publishedRevisionsKept,
    },
    usage: {
      storageBytes: usage.storageBytes,
      fileCount: usage.fileCount,
      bandwidthBytes: usage.bandwidthBytes,
      period: usage.period,
      linkCount: links.length,
    },
    // TASK_155 P2 — the caller's own hosting credentials (never the token; each
    // row carries only a 4-char hint) so the tab can render the switcher.
    // TASK_155 P3 — §16.4 adds the per-account project count + the verify stamp
    // (lastVerifiedAt/verifyError) so the chooser is one honest row per account.
    credentials: credentials.map((c) => ({ ...c, projectCount: siteCounts[c.id] ?? 0 })),
    // TASK_155 P6a (PLAN §19.4) — the three-option picker (Free / Premium /
    // Yours). It needs two facts, and the client must not guess either:
    //   premium       — is this user premium (BYO is not gated, the platform is)
    //   platformReady — is at least one platform account healthy right now
    // Together they let the tab render an honest, non-dead-end option list: a
    // non-premium user with no account of their own sees "Free" plus an upgrade
    // prompt, never a Premium row that fails at deploy time.
    premium,
    platformReady: platformHealthy > 0,
    // TASK_175 — the Desktop-only link gate is a premium-tier perk: the tab
    // renders the checkbox only when this is true (same boolean that decides
    // the premium engine options — no new fetch). Free users see today's mint
    // UI byte-identical, and the server drops a forged `desktopOnly: true`
    // for non-premium minters anyway.
    desktopOnlyAllowed: premium,
  });
}
