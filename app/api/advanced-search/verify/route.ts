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
      body: JSON.stringify({ domains, platformCodes }),
    });
  } catch {
    return NextResponse.json({ error: "Could not reach the search worker." }, { status: 502 });
  }

  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    return NextResponse.json({ error: detail?.detail ?? "Verification failed." }, { status: 500 });
  }

  const data = (await res.json()) as { results: Array<{ domain: string; platform: string | null }> };
  const confirmed = data.results.filter((r) => r.platform !== null);

  const job = await prisma.$transaction(async (tx) => {
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

    if (confirmed.length > 0) {
      await tx.lead.createMany({
        data: confirmed.map((r) => ({
          userId: session.userId,
          searchJobId: searchJob.id,
          email: null,
          website: `https://${r.domain}`,
          sourceUrl: `https://${r.domain}`,
          // Self-hosted platforms read naturally with "webmail" appended
          // ("Detected: RoundCube webmail"); hosted providers and the
          // "Other (<mx host>)" fallback already read correctly on their
          // own ("Detected: Google Workspace", "Detected: Other
          // (mx1.example.com)") — appending "webmail" to those would be
          // wrong/awkward, so only self-hosted platforms (WEBMAIL_PLATFORM_OPTIONS'
          // last 6 entries) get the suffix.
          snippet: `Detected: ${r.platform}${SELF_HOSTED_LABELS.has(r.platform as string) ? " webmail" : ""}`,
          businessName: r.domain,
        })),
        skipDuplicates: true,
      });
    }

    return searchJob;
  });

  return NextResponse.json({
    searchJobId: job.id,
    results: data.results,
    confirmedCount: confirmed.length,
  });
}
