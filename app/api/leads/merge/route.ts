import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";

// Task 26, Piece 2 — merge leads. A user selects 2+ leads (e.g. near-duplicates
// surfaced by different documents/queries) and combines them into a single lead,
// choosing which field values to keep. No new table needed: we create ONE new
// Lead with the chosen values, and delete the N source rows — all in a single
// transaction so the operation is all-or-nothing.
//
// POST /api/leads/merge
// Body: { leadIds: string[] (>=2), merged: { email, phone, contactName,
//        businessName, website, sourceUrl?, snippet? } }

// Trim to null for empty/blank strings so an untouched optional field doesn't
// persist as a stray empty string instead of a clean null.
function nullOrString(v: unknown): string | null {
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  return null;
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { leadIds?: unknown; merged?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const rawIds = body?.leadIds;
  if (!Array.isArray(rawIds)) {
    return NextResponse.json({ error: "Select at least two leads to merge." }, { status: 400 });
  }
  // Dedupe + drop anything that isn't a non-empty string id.
  const leadIds = Array.from(
    new Set(
      rawIds
        .filter((x): x is string => typeof x === "string")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  );
  if (leadIds.length < 2) {
    return NextResponse.json({ error: "Select at least two leads to merge." }, { status: 400 });
  }

  const m = (body?.merged && typeof body.merged === "object" ? body.merged : {}) as Record<string, unknown>;
  const merged = {
    email: nullOrString(m.email),
    phone: nullOrString(m.phone),
    contactName: nullOrString(m.contactName),
    businessName: nullOrString(m.businessName),
    website: nullOrString(m.website),
    sourceUrl: nullOrString(m.sourceUrl),
    snippet: typeof m.snippet === "string" ? m.snippet.trim() : null,
  };
  if (!merged.email) {
    return NextResponse.json({ error: "A merged lead needs an email address." }, { status: 400 });
  }

  // Load every source lead at once, then verify ownership. Any id that doesn't
  // resolve — because it's gone, or because it belongs to another user — is a
  // 404, NOT a 403: same "don't leak existence" convention used across this app.
  const sourceLeads = await prisma.lead.findMany({
    where: { id: { in: leadIds } },
    select: { id: true, userId: true, searchJobId: true },
  });
  if (sourceLeads.length !== leadIds.length) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (sourceLeads.some((l) => l.userId !== session.userId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // Merging across two different jobs isn't a supported case for v1 — the merged
  // row needs a single home. Surface a clear error rather than guessing.
  const searchJobId = sourceLeads[0].searchJobId;
  if (sourceLeads.some((l) => l.searchJobId !== searchJobId)) {
    return NextResponse.json(
      { error: "Selected leads come from different jobs and can't be merged together." },
      { status: 400 },
    );
  }

  try {
    const created = await prisma.$transaction(async (tx) => {
      // Delete the sources BEFORE creating the merged row. The Lead unique
      // constraint (@@unique([searchJobId, sourceUrl, email]), Task 25) means the
      // merged email — which is usually one of the source leads' OWN — would
      // collide with that very source row if we created first. Deleting sources
      // first lets the common case (merge picks an existing source's email with
      // that same source's sourceUrl) go through cleanly; the P2002 catch below
      // still guards the genuinely-impossible case of colliding with a DIFFERENT
      // surviving lead.
      await tx.lead.deleteMany({ where: { id: { in: leadIds } } });
      return tx.lead.create({
        data: {
          userId: session.userId,
          searchJobId,
          email: merged.email,
          phone: merged.phone,
          contactName: merged.contactName,
          businessName: merged.businessName,
          website: merged.website,
          sourceUrl: merged.sourceUrl,
          snippet: merged.snippet,
        },
      });
    });
    return NextResponse.json(created);
  } catch (err) {
    if (typeof err === "object" && err && typeof (err as { code?: unknown }).code === "string" &&
        (err as { code: string }).code === "P2002") {
      return NextResponse.json(
        { error: "A lead with this email already exists in this job, so it can't be merged again." },
        { status: 409 },
      );
    }
    throw err;
  }
}