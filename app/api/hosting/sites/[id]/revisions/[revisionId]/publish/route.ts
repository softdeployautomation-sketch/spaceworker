import { NextResponse } from "next/server";

import { hasEntitlement } from "@/lib/entitlements";
import { getCurrentUser } from "@/lib/session-user";
import { publishRevision } from "@/lib/hosting/sites";

// TASK_155 P3 — POST /api/hosting/sites/<id>/revisions/<revisionId>/publish.
//
// §16.1 state 4: promote a PREVIEWED revision to the site's live URL. On the local
// engine this mints the site's stable /hs/<token>/ and flips the revision to
// "published"; on the premium engine it re-runs the Direct-Upload deploy on the
// "main" branch (a manifest-only call — the bytes moved at preview). Publishing is
// deliberate and one-click reversible: the last N published revisions are kept.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; revisionId: string }> }
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const decision = await hasEntitlement(user.id, "hosting");
  if (!decision.allowed) {
    return NextResponse.json(
      { error: "Hosting isn’t included on your account yet.", code: "not_entitled" },
      { status: 403 }
    );
  }

  const { id, revisionId } = await params; // MUST await — async in Next.js 16

  const result = await publishRevision({ userId: user.id, siteId: id, revisionId });
  if (!result.ok) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
  }
  return NextResponse.json({ revision: result.value });
}
