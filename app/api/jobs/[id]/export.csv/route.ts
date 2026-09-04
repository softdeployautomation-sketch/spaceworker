import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { encodeCsvRow } from "@/lib/csv";

// Auth-gated lead export. Same ownership-check pattern as GET /api/jobs/[id]:
// the user may only download their own job's leads, and a job that exists but
// belongs to someone else reads as 404 (never leak existence).
//
// Serves a real RFC 4180 CSV (header row + one row per Lead) using the encoder
// in lib/csv.ts, which mirrors the parser's quoting discipline — a business
// name like "Smith, Johnson & Sons" or a snippet containing quotes/newlines is
// quoted/escaped correctly instead of corrupting the file.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const { id } = await params;

  const job = await prisma.searchJob.findFirst({
    where: { id, userId: session.userId },
    select: { query: true },
  });
  if (!job) return new Response("Not found", { status: 404 });

  const leads = await prisma.lead.findMany({
    where: { searchJobId: id, userId: session.userId },
    orderBy: { createdAt: "asc" },
    select: {
      businessName: true, contactName: true, email: true, phone: true,
      website: true, sourceUrl: true, snippet: true, createdAt: true,
    },
  });

  // Header row mirrors the actual `Lead` schema fields (see prisma/schema.prisma).
  const rows: string[] = [
    encodeCsvRow([
      "businessName", "contactName", "email", "phone",
      "website", "sourceUrl", "snippet", "createdAt",
    ]),
  ];
  for (const lead of leads) {
    rows.push(
      encodeCsvRow([
        lead.businessName,
        lead.contactName,
        lead.email,
        lead.phone,
        lead.website,
        lead.sourceUrl,
        lead.snippet,
        lead.createdAt.toISOString(),
      ])
    );
  }

  return new Response(rows.join(""), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="spaceworker-leads-${id}.csv"`,
    },
  });
}