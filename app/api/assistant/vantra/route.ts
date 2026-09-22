import { NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import { db } from "@/lib/db";
import { ensureVantraLink, getVantraLinkView, syncDevices } from "@/lib/vantra-link";

export const dynamic = "force-dynamic";

// Task 93 — the user-facing Vantra-plugin surface (org provisioning + health).
//   POST — enable the Assistant's device link: idempotent provisioning of the
//          hidden `sw-<userId>` Vantra org (entitlement + admin-limit gated).
//   GET  — link status + a live device sync from Vantra (upserts Device rows).

export async function POST() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const view = await ensureVantraLink(session.userId);
    return NextResponse.json({ ok: true, link: view });
  } catch (err) {
    const code = err instanceof Error ? err.message : "provision_failed";
    const status =
      code === "entitlement_required" ? 403
      : code === "vantra_links_disabled" || code === "vantra_links_limit" ? 429
      : code === "vantra_not_configured" ? 503
      : 502;
    return NextResponse.json({ error: code }, { status });
  }
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const link = await db.vantraLink.findUnique({ where: { userId: session.userId } });
  if (!link || link.status === "revoked") {
    return NextResponse.json({ link: null, devices: [] });
  }
  try {
    const { devices } = await syncDevices(session.userId);
    // Enriched dual-tier view (public + private companion + entitlement) —
    // the Add-a-device panel's Public/Private toggle reads this.
    const view = await getVantraLinkView(session.userId);
    return NextResponse.json({ link: view, devices });
  } catch (err) {
    const view = await getVantraLinkView(session.userId).catch(() => null);
    return NextResponse.json({
      link: view ?? link,
      devices: [],
      syncError: err instanceof Error ? err.message : "sync_failed",
    });
  }
}