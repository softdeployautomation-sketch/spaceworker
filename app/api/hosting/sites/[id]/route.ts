import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/session-user";
import { deleteSite, getSite, listRevisions } from "@/lib/hosting/sites";

// TASK_155 P3 — GET    /api/hosting/sites/<id>  (the site + its revisions)
//                 DELETE /api/hosting/sites/<id>  (wipe the site + its trees)
//
// The GET is the per-site read the Hosting tab polls after an upload or a publish
// so it can render the §16.1 state machine (extracted → previewed → published)
// without a second round trip.
import { moduleToolsDenied } from "@/lib/module-gate";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params; // MUST await — async in Next.js 16
  const site = await getSite(user.id, id);
  if (!site) return NextResponse.json({ error: "Site not found." }, { status: 404 });

  const revisions = await listRevisions(user.id, id);
  return NextResponse.json({ site, revisions });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await moduleToolsDenied(user.id, "hosting");
  if (denied) return denied;

  const { id } = await params;
  const result = await deleteSite(user.id, id);
  if (!result.ok) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
  }
  return NextResponse.json({ ok: true, id: result.value.id });
}
