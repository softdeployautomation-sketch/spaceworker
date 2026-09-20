import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";

// Advanced Search Stage 2 — "Verify": probes exactly the domains the caller
// selected from Stage 1's candidate list (never re-searches) via the
// worker's POST /verify-domains, then persists confirmed matches as a real
// SearchJob + Lead rows — same modeling as app/api/leads/upload/route.ts's
// "upload" template: nothing to run (results already exist), so
// status: "done" immediately, workerJobId: null. This is what makes
// Advanced Search results show up in the normal leads table, exports, and
// mailer flows like every other job.

const MAX_DOMAINS_PER_REQUEST = 50;

// Self-hosted platform labels, exactly as worker/filters/webmail_platforms.py's
// WEBMAIL_PLATFORMS labels them — used only to decide whether a confirmed
// result's snippet needs " webmail" appended (see below). Hosted providers
// and the dynamic "Other (<mx host>)" fallback read correctly without it.
const SELF_HOSTED_LABELS = new Set([
  "RoundCube", "SquirrelMail", "RainLoop", "Zimbra", "Open-Xchange", "cPanel Webmail",
]);

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { query?: unknown; domains?: unknown; platformCodes?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const query = typeof body.query === "string" ? body.query.trim() : "";
  const domains = Array.isArray(body.domains)
    ? body.domains.filter((d): d is string => typeof d === "string" && d.trim().length > 0).slice(0, MAX_DOMAINS_PER_REQUEST)
    : [];
  const platformCodes = Array.isArray(body.platformCodes)
    ? body.platformCodes.filter((p): p is string => typeof p === "string")
    : null;

  if (!query) return NextResponse.json({ error: "query is required." }, { status: 400 });
  if (domains.length === 0) return NextResponse.json({ error: "domains is required." }, { status: 400 });

  if (!process.env.WORKER_BASE_URL) {
    return NextResponse.json({ error: "Search worker is not configured." }, { status: 503 });
  }

  let res: Response;
  try {
    res = await fetch(`${process.env.WORKER_BASE_URL}/verify-domains`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.WORKER_AUTH_TOKEN}`,
      },
      body: JSON.stringify({ domains, platformCodes, findContactInfo: true }),
    });
  } catch {
    return NextResponse.json({ error: "Could not reach the search worker." }, { status: 502 });
  }

  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    return NextResponse.json({ error: detail?.detail ?? "Verification failed." }, { status: 500 });
  }

  const data = (await res.json()) as {
    results: Array<{
      domain: string;
      platform: string | null;
      contacts?: Array<{ email?: string | null; phone?: string | null; contactName?: string | null }>;
    }>;
  };
  const confirmed = data.results.filter((r) => r.platform !== null);

  const { searchJob: job, leadsCreated } = await prisma.$transaction(async (tx) => {
    const searchJob = await tx.searchJob.create({
      data: {
        userId: session.userId,
        query: `Advanced Search: ${query}`,
        template: "advanced-search",
        params: {
          template: "advanced-search",
          platformCodes,
          candidatesChecked: domains.length,
          candidatesConfirmed: confirmed.length,
        } as Prisma.InputJsonValue,
        status: "done",
        lane: "light",
        workerJobId: null,
      },
      select: { id: true },
    });

    // Owner-requested 2026-09-20: a domain confirmed to run real mail has
    // no email of its own to extract (the webmail login page has none) —
    // same gap every lead-gen tool has, solved the same way they solve it
    // (confirmed via research: Hunter.io's own stated methodology): crawl
    // the business's own site for real, published emails. worker/api.py's
    // findContactInfo does exactly that (reusing the same extract_lead_page
    // crawl the normal Extract flow uses) before this route ever runs.
    //
    // "one domain can have multiple users" (owner, 2026-09-20): a
    // contact/team page can legitimately list several people at one
    // domain, each a real, separately-reachable lead — one Lead row PER
    // crawled email, not collapsed to one per domain.
    //
    // Bug fix (2026-09-20): a domain with no crawlable email used to still
    // get ONE domain-only blank row "so a confirmed-but-quiet domain isn't
    // lost". Confirmed live this reads as broken, not a feature: a real
    // 41-lead run showed only 3 with an actual email, 38 blank. Owner: "we
    // dont want empty spaces. if its empty then it should be deleted."
    // Blank rows are dropped now, not saved — a confirmed-but-quiet domain
    // still shows up in results.platform for the UI's badge, it just isn't
    // persisted as a Lead with nothing in it.
    const rows = confirmed.flatMap((r) => {
      const snippet = `Detected: ${r.platform}${SELF_HOSTED_LABELS.has(r.platform as string) ? " webmail" : ""}`;
      const base = {
        userId: session.userId,
        searchJobId: searchJob.id,
        website: `https://${r.domain}`,
        sourceUrl: `https://${r.domain}`,
        snippet,
        businessName: r.domain,
      };
      const contacts = (r.contacts ?? []).filter((c) => c.email);
      return contacts.map((c) => ({
        ...base,
        email: c.email ?? null,
        phone: c.phone ?? null,
        contactName: c.contactName ?? null,
      }));
    });

    if (rows.length > 0) {
      await tx.lead.createMany({ data: rows, skipDuplicates: true });
    }

    return { searchJob, leadsCreated: rows.length };
  });

  return NextResponse.json({
    searchJobId: job.id,
    results: data.results,
    confirmedCount: confirmed.length,
    leadsCreated,
  });
}
