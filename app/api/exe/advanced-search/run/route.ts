import { NextRequest, NextResponse } from "next/server";
import { isLocalExeRuntime } from "@/lib/exe-runtime";
import { roundQueries, MAX_TOTAL_QUERIES_SAFETY_CEILING } from "@/local-engine/src/query";
import {
  extractRootDomain,
  isDirectoryOrInfrastructureDomain,
  probeDomainForWebmail,
} from "@/local-engine/src/filters/webmail-platforms";
import { extractLeadPage, defaultFetcher } from "@/local-engine/src/crawl";
import type { SearchResult } from "@/local-engine/src/lead";
import { duckDuckGoSearch } from "../../extract/search";
import { appendLeadRow, newRunId } from "../../extract/storage";

// Owner-requested 2026-09-20: "we need all in the exe, build an equivalent
// in the exe that would run locally, no difference since they still can
// make http calls" — the background-job version (worker/automation.py's
// advanced_search_mode + run_advanced_search_target_domains) needs the
// worker's Postgres/dispatcher/lane system, which the EXE doesn't have.
// But the ACTUAL work per query/domain (DDG search, MX lookup, page crawl)
// is just outbound HTTP the EXE's own machine can make directly — this
// route is that local equivalent, SSE-streamed exactly like
// /api/exe/extract's Lead Search flow (same event shape, same client
// reading pattern), reusing the SAME query-expansion (roundQueries,
// already shared, not re-implemented) and probe/crawl functions already
// built for the standalone Advanced Search page's EXE-local routes.
//
// Gated by isLocalExeRuntime() exactly like every other /api/exe/* route.

const encoder = new TextEncoder();
type Event =
  | { type: "step"; message: string }
  | { type: "lead"; lead: Record<string, unknown> }
  | {
      type: "done";
      total: number;
      leadFile: string | null;
      stoppedReason: "minLeadsReached" | "deadline" | "maxTotalLeads" | "exhausted" | "stopped" | null;
    };

function sseFrame(ev: Event): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(ev)}\n\n`);
}

const QUERY_STAGGER_MS = 600;
const RESULTS_PER_QUERY = 30;
const DEFAULT_MAX_TOTAL_LEADS = 10000; // "go as long as getting 10000 leads"

export async function GET() {
  if (!isLocalExeRuntime()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ enabled: true });
}

export async function POST(req: NextRequest) {
  if (!isLocalExeRuntime()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: {
    queries?: unknown;
    targetDomains?: unknown;
    platformCodes?: unknown;
    minLeads?: unknown;
    maxTotalLeads?: unknown;
    maxDurationMinutes?: unknown;
    requireEmail?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // Accepts either a real array or one freeform string (comma/semicolon/
  // newline/pipe-separated) — matches /api/exe/extract's splitTerms
  // convention, since local-extract.tsx's form fields are plain text
  // inputs, not chip lists.
  function splitTerms(raw: unknown): string[] {
    if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
    if (typeof raw !== "string") return [];
    return raw.split(/[,\n;|]+/).map((s) => s.trim()).filter(Boolean);
  }

  const queries = splitTerms(body.queries);
  const targetDomains = splitTerms(body.targetDomains).map((d) => d.toLowerCase());
  const platformCodes = Array.isArray(body.platformCodes)
    ? body.platformCodes.filter((p): p is string => typeof p === "string")
    : undefined;
  const minLeads = typeof body.minLeads === "number" && body.minLeads > 0 ? body.minLeads : 0;
  const maxTotalLeads =
    typeof body.maxTotalLeads === "number" && body.maxTotalLeads > 0
      ? Math.min(body.maxTotalLeads, 10000)
      : DEFAULT_MAX_TOTAL_LEADS;
  const maxDurationMinutes =
    typeof body.maxDurationMinutes === "number" && body.maxDurationMinutes > 0
      ? Math.min(body.maxDurationMinutes, 180)
      : 30;
  // Bug fix (2026-09-20, same as the web/worker version): default true —
  // "we dont want empty spaces. if its empty then it should be deleted."
  const requireEmail = body.requireEmail !== false;

  if (queries.length === 0 && targetDomains.length === 0) {
    return NextResponse.json({ error: "Add at least one search query or domain" }, { status: 400 });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (ev: Event) => controller.enqueue(sseFrame(ev));
      const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

      const fetcher = defaultFetcher();
      const runId = newRunId();
      const seenDomains = new Set<string>();
      let total = 0;
      let stoppedReason: "minLeadsReached" | "deadline" | "maxTotalLeads" | "exhausted" | "stopped" | null = "exhausted";
      const deadline = Date.now() + maxDurationMinutes * 60_000;

      async function handleDomain(domain: string, sourceTitle: string): Promise<void> {
        if (seenDomains.has(domain)) return;
        seenDomains.add(domain);
        // Directory/infrastructure filtering only applies to domains found
        // via search — a caller-supplied target domain is never second-
        // guessed (they explicitly asked for exactly that one).
        if (targetDomains.length === 0 && isDirectoryOrInfrastructureDomain(domain, sourceTitle)) return;
        push({ type: "step", message: `Checking ${domain}…` });
        const platform = await probeDomainForWebmail(domain, platformCodes);
        if (!platform) return;
        push({ type: "step", message: `Confirmed ${platform} at ${domain} — looking for a contact email…` });
        let contacts: Array<{ email?: string | null; phone?: string | null; contactName?: string | null }> = [];
        try {
          const homepage: SearchResult = { title: domain, url: `https://${domain}/`, snippet: "" };
          const leads = await extractLeadPage(homepage, { fetcher });
          contacts = leads.map((l) => ({ email: l.email, phone: l.phone, contactName: l.contactName }));
        } catch {
          // A bad page must never fail the whole run — domain stays confirmed.
        }
        const emailed = contacts.filter((c) => c.email);
        if (emailed.length === 0 && requireEmail) return;
        const rows = emailed.length > 0 ? emailed : [{ email: null, phone: null, contactName: null }];
        for (const c of rows) {
          if (total >= maxTotalLeads) return;
          const lead = {
            email: c.email ?? null,
            phone: c.phone ?? null,
            contactName: c.contactName ?? null,
            businessName: domain,
            website: `https://${domain}`,
            sourceUrl: `https://${domain}`,
            snippet: `Detected: ${platform}`,
          };
          appendLeadRow(runId, lead);
          push({ type: "lead", lead });
          total += 1;
        }
      }

      try {
        if (targetDomains.length > 0) {
          push({ type: "step", message: `Checking ${targetDomains.length} domain(s)…` });
          for (const domain of targetDomains) {
            if (req.signal.aborted) {
              stoppedReason = "stopped";
              break;
            }
            if (total >= maxTotalLeads) {
              stoppedReason = "maxTotalLeads";
              break;
            }
            await handleDomain(domain, "");
          }
        } else {
          const expansionEnabled = minLeads > 0;
          const used = new Set<string>();
          const ordered: string[] = [];
          let nextRound = 0;
          const cap = expansionEnabled ? MAX_TOTAL_QUERIES_SAFETY_CEILING : queries.length;
          function grow(targetLen: number) {
            const effective = Math.min(targetLen, cap);
            while (ordered.length < effective) {
              const candidates = roundQueries(queries, nextRound);
              nextRound++;
              if (candidates.length === 0) break;
              for (const c of candidates) {
                if (!used.has(c)) {
                  used.add(c);
                  ordered.push(c);
                }
              }
              if (ordered.length >= cap) break;
            }
          }

          for (let qi = 0; ; qi++) {
            if (req.signal.aborted) {
              stoppedReason = "stopped";
              break;
            }
            if (total >= maxTotalLeads) {
              stoppedReason = "maxTotalLeads";
              break;
            }
            if (expansionEnabled && total >= minLeads) {
              stoppedReason = "minLeadsReached";
              break;
            }
            if (Date.now() >= deadline) {
              stoppedReason = "deadline";
              break;
            }
            grow(qi + 1);
            if (qi >= ordered.length) {
              stoppedReason = "exhausted";
              break;
            }
            const q = ordered[qi];
            push({ type: "step", message: `Searching: ${q}` });
            const { results, blocked } = await duckDuckGoSearch(q, RESULTS_PER_QUERY);
            if (blocked) {
              push({ type: "step", message: "DuckDuckGo blocked this request — moving on." });
              await delay(QUERY_STAGGER_MS);
              continue;
            }
            for (const r of results) {
              if (req.signal.aborted || total >= maxTotalLeads) break;
              const domain = extractRootDomain(r.url);
              if (!domain) continue;
              await handleDomain(domain, r.title);
            }
            await delay(QUERY_STAGGER_MS);
          }
        }
      } finally {
        push({ type: "done", total, leadFile: total > 0 ? runId : null, stoppedReason });
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
