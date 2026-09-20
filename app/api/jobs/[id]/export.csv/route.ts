import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { encodeCsvRow } from "@/lib/csv";

// Normalizes a lead's email or website into its comparable domain, using the
// same rule as extractRootDomain() in local-engine (hostname, strip leading
// "www.", lowercase, trim). Unlike extractRootDomain — which does `new URL()`
// and therefore returns "" for a bare email like "foo@gmail.com" — this also
// pulls the domain out of an email address, since the filter matches against
// BOTH the lead.email and lead.website columns.
function leadDomain(email?: string | null, website?: string | null): string {
  const emailDomain = (email ?? "").trim().split("@").pop()?.trim() ?? "";
  const parsed =
    emailDomain || website
      ? (() => {
          try {
            return new URL(
              emailDomain || website!,
            ).hostname
              .replace(/^www\./, "")
              .trim()
              .toLowerCase();
          } catch {
            return "";
          }
        })()
      : "";
  // Prefer the email's domain when present; fall back to the website hostname.
  const raw = emailDomain || parsed;
  return raw.replace(/^www\./, "").trim().toLowerCase();
}

// Auth-gated lead export. Same ownership-check pattern as GET /api/jobs/[id]:
// the user may only download their own job's leads, and a job that exists but
// belongs to someone else reads as 404 (never leak existence).
//
// Serves a real RFC 4180 CSV (header row + one row per Lead) using the encoder
// in lib/csv.ts, which mirrors the parser's quoting discipline — a business
// name like "Smith, Johnson & Sons" or a snippet containing quotes/newlines is
// quoted/escaped correctly instead of corrupting the file.
//
// Task 54 — optional domain filter, applied at EXPORT time only (never mutates
// the job's stored leads). &domains=a.com,b.com keeps only leads whose email or
// website hostname ends in (or equals) one of the listed domains. This is the
// lowest-risk variant of the owner's "domain filter" ask — the job/leads rows
// are untouched, only the downloaded CSV is narrowed.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const { id } = await params;
  // ?emailsOnly=1 — a one-column export for when only the address matters
  // (e.g. handing it to something other than this app's own mailer, which
  // already reads leads directly — see POST /api/campaigns's searchJobId path).
  const emailsOnly = new URL(req.url).searchParams.get("emailsOnly") === "1";

  // Task 54 — &domains=comma-separated allowlist. Empty/missing = no filter.
  const domainsParam = new URL(req.url).searchParams.get("domains") ?? "";
  const filterDomains = domainsParam
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^www\./, ""))
    .filter(Boolean);

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

  const filteredLeads = filterDomains.length
    ? leads.filter((lead) => {
        const domain = leadDomain(lead.email, lead.website);
        if (!domain) return false;
        // Match if the lead's domain equals or is a subdomain of an allowlisted
        // domain (so filtering "acme.com" also captures "shop.acme.com").
        return filterDomains.some(
          (d) => domain === d || domain.endsWith(`.${d}`),
        );
      })
    : leads;

  const rows: string[] = [];
  if (emailsOnly) {
    rows.push(encodeCsvRow(["email"]));
    const seen = new Set<string>();
    for (const lead of filteredLeads) {
      const email = (lead.email ?? "").trim();
      if (!email || seen.has(email.toLowerCase())) continue;
      seen.add(email.toLowerCase());
      rows.push(encodeCsvRow([email]));
    }
  } else {
    // Header row mirrors the actual `Lead` schema fields (see prisma/schema.prisma).
    rows.push(
      encodeCsvRow([
        "businessName", "contactName", "email", "phone",
        "website", "sourceUrl", "snippet", "createdAt",
      ]),
    );
    for (const lead of filteredLeads) {
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
  }

  return new Response(rows.join(""), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="spaceworker-leads-${id}${emailsOnly ? "-emails" : ""}.csv"`,
    },
  });
}