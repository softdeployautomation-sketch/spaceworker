import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/session-user";
import { reconcileUserDomain, removeUserDomain } from "@/lib/hosting/domain-registry";
import { getDefaultHostingCredential } from "@/lib/hosting/credentials";
import { getZoneByName } from "@/lib/hosting/workers";

// TASK_157 Phase 4 — DELETE /api/hosting/domains/<id>   (remove one of your own)
//                  POST   /api/hosting/domains/<id>/verify  (re-check with Cloudflare)
//
// Ownership is enforced in `removeUserDomain` against the row itself, and a
// non-owner gets 404 — NOT 403 — so the status code cannot be used to discover that
// somebody else's domain exists.

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params; // MUST await — async in Next.js 16
  const result = await removeUserDomain(user.id, id);
  if (!result.ok) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
  }
  return NextResponse.json({ ok: true, id: result.value.id });
}

/**
 * Re-read this domain's status from Cloudflare.
 *
 * Needed because "is my domain ready?" changes outside the app — the user sets the
 * nameservers at their registrar and Cloudflare flips the zone to `active` some time
 * later. Polling this endpoint is how the picker stops saying "pending" without the
 * user having to re-add the domain.
 *
 * Failing to reach Cloudflare is NOT an error: the caller's own domains are returned
 * as they stand, plus a note. The screen must keep rendering during a Cloudflare
 * outage, because the stored list is still correct — only its freshness is not.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const cred = await getDefaultHostingCredential(user.id);
  if (!cred) {
    return NextResponse.json(
      { error: "Connect your Cloudflare account to finish setting up your domains.", code: "no_credential" },
      { status: 400 }
    );
  }

  const result = await reconcileUserDomain(user.id, id, async (name) => {
    const zone = await getZoneByName(cred, name);
    if (!zone.ok) return { ok: false, message: zone.error ?? "Could not reach Cloudflare." };
    if (!zone.value) {
      // Not an error either: the user may simply not have added it to Cloudflare yet.
      return { ok: false, message: "Not in this Cloudflare account yet." };
    }
    return { ok: true, zoneId: zone.value.zoneId, status: zone.value.status, nameservers: zone.value.nameservers };
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
  }
  return NextResponse.json({ domain: result.value });
}