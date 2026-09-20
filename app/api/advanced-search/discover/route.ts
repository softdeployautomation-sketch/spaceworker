import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";

// Advanced Search Stage 1 — "Discover": a plain, unbiased business search
// (the caller's real query text, verbatim) proxied straight to the worker's
// POST /discover-domains. Returns candidate domains for the UI to render as
// a checkbox list; nothing is persisted here — Stage 2 (POST
// /api/advanced-search/verify) is what actually saves leads, and only for
// whichever domains the caller goes on to select.

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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
      ? Math.max(1, Math.min(Math.floor(body.maxCandidates), 50))
      : 20;

  if (!process.env.WORKER_BASE_URL) {
    return NextResponse.json({ error: "Search worker is not configured." }, { status: 503 });
  }

  let res: Response;
  try {
    res = await fetch(`${process.env.WORKER_BASE_URL}/discover-domains`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.WORKER_AUTH_TOKEN}`,
      },
      body: JSON.stringify({ query, maxCandidates }),
    });
  } catch {
    return NextResponse.json({ error: "Could not reach the search worker." }, { status: 502 });
  }

  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    return NextResponse.json(
      { error: detail?.detail ?? "Search failed." },
      { status: res.status === 502 ? 502 : 500 },
    );
  }

  const data = (await res.json()) as { candidates: Array<{ domain: string; sourceUrl: string; title: string }> };
  return NextResponse.json(data);
}
