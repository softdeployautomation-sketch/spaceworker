import { NextRequest, NextResponse } from "next/server";
import { isLocalExeRuntime } from "@/lib/exe-runtime";
import { probeDomainForWebmail } from "@/local-engine/src/filters/webmail-platforms";
import { appendLeadRow, newRunId } from "../../extract/storage";

// Advanced Search Stage 2 — "Verify", running entirely inside the EXE's own
// bundled local runtime. Probes exactly the domains the caller selected from
// Stage 1's candidate list (never re-searches), same mechanics as the hosted
// web version's worker-backed route, but calling probeDomainForWebmail
// directly (local HTTP fetch + MX lookup — see that function's docstring for
// why no VPS worker is needed at all).
//
// Persistence: same TEMPORARY local JSONL pattern the Extract page's local
// runtime already uses (appendLeadRow/newRunId, see ../extract/storage.ts) —
// not the hosted Postgres Lead table, which isn't reachable/appropriate to
// write to directly from a customer's own machine. When the EXE's real
// SQLite schema lands (see storage.ts's own note), this moves with it.
//
// Gated by isLocalExeRuntime() exactly like /api/exe/extract.

const MAX_DOMAINS_PER_REQUEST = 50;

export async function POST(req: NextRequest) {
  if (!isLocalExeRuntime()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { domains?: unknown; platformCodes?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const domains = Array.isArray(body.domains)
    ? body.domains.filter((d): d is string => typeof d === "string" && d.trim().length > 0).slice(0, MAX_DOMAINS_PER_REQUEST)
    : [];
  const platformCodes = Array.isArray(body.platformCodes)
    ? body.platformCodes.filter((p): p is string => typeof p === "string")
    : undefined;

  if (domains.length === 0) return NextResponse.json({ error: "domains is required." }, { status: 400 });

  const results: Array<{ domain: string; platform: string | null }> = [];
  for (const domain of domains) {
    const platform = await probeDomainForWebmail(domain, platformCodes);
    results.push({ domain, platform });
  }

  const confirmed = results.filter((r) => r.platform !== null);
  let runId: string | null = null;
  if (confirmed.length > 0) {
    runId = newRunId();
    for (const r of confirmed) {
      appendLeadRow(runId, {
        email: null,
        phone: null,
        contactName: null,
        businessName: r.domain,
        website: `https://${r.domain}`,
        sourceUrl: `https://${r.domain}`,
        snippet: `Detected: ${r.platform}`,
      });
    }
  }

  return NextResponse.json({ results, confirmedCount: confirmed.length, runId });
}
