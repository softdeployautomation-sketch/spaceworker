import { NextRequest, NextResponse } from "next/server";
import { isLocalExeRuntime } from "@/lib/exe-runtime";
import { extractRootDomain, isDirectoryOrInfrastructureDomain } from "@/local-engine/src/filters/webmail-platforms";
import { duckDuckGoSearch } from "../../extract/search";

// Advanced Search Stage 1 — "Discover", running entirely inside the EXE's own
// bundled local runtime (see app/api/advanced-search/discover/route.ts for
// the hosted-web equivalent, which calls the VPS worker instead — that
// worker is bound to 127.0.0.1 only and unreachable from a customer's own
// machine). Same plain, unbiased query the hosted version uses — reuses the
// EXE's own duckDuckGoSearch (already bundled for the Extract page's local
// search-to-leads path), no VPS dependency at all.
//
// Gated by isLocalExeRuntime() exactly like /api/exe/extract (fail-closed,
// 404 on the hosted web app — that surface uses the worker-backed route).

const MAX_CANDIDATES_DEFAULT = 20;
const MAX_CANDIDATES_CAP = 50;

export async function GET() {
  if (!isLocalExeRuntime()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ enabled: true });
}

export async function POST(req: NextRequest) {
  if (!isLocalExeRuntime()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { query?: unknown; maxCandidates?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) return NextResponse.json({ error: "query is required." }, { status: 400 });

  const maxCandidates =
    typeof body.maxCandidates === "number" && Number.isFinite(body.maxCandidates)
      ? Math.max(1, Math.min(Math.floor(body.maxCandidates), MAX_CANDIDATES_CAP))
      : MAX_CANDIDATES_DEFAULT;

  // Over-fetch (3x) since several results often share one root domain.
  const { results, blocked } = await duckDuckGoSearch(query, maxCandidates * 3);
  if (blocked && results.length === 0) {
    return NextResponse.json(
      { error: "Search engine blocked this request — try again shortly." },
      { status: 502 },
    );
  }

  const seen = new Set<string>();
  const candidates: Array<{ domain: string; sourceUrl: string; title: string }> = [];
  for (const r of results) {
    const domain = extractRootDomain(r.url);
    if (!domain || seen.has(domain)) continue;
    if (isDirectoryOrInfrastructureDomain(domain, r.title)) continue;
    seen.add(domain);
    candidates.push({ domain, sourceUrl: r.url, title: r.title });
    if (candidates.length >= maxCandidates) break;
  }

  return NextResponse.json({ candidates });
}
