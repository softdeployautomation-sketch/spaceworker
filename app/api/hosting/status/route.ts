import { NextResponse } from "next/server";

import { getAdminSettings } from "@/lib/admin-settings";
import { hasEntitlement } from "@/lib/entitlements";
import { env } from "@/lib/env";
import { getCurrentUser } from "@/lib/session-user";
import { readUsage, resolveCapsForUser } from "@/lib/hosting/files";
import { listHostingCredentials } from "@/lib/hosting/credentials";
import { listProviders } from "@/lib/hosting/providers";
import { hostingPublicBase } from "@/lib/hosting/providers";
import { listHostedLinks } from "@/lib/hosting/links";

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
  const { caps } = await resolveCapsForUser(user.id);
  const [usage, links, credentials] = await Promise.all([
    readUsage(user.id),
    listHostedLinks(user.id),
    listHostingCredentials(user.id),
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
    credentials,
  });
}
