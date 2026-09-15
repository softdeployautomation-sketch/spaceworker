import { NextRequest, NextResponse } from "next/server";

import { isLocalExeRuntime } from "@/lib/exe-runtime";
import { roundQueries, biasQueryTowardPdfs } from "@/local-engine/src/query";
import { isPdfResult, defaultProbe } from "@/local-engine/src/pdf";
import { extractLeadPage, extractLeadPdf, defaultFetcher } from "@/local-engine/src/crawl";
import { fetchPdfText, defaultPdfTextDeps } from "@/local-engine/src/pdf-text";
import type { Lead } from "@/local-engine/src/lead";
import { duckDuckGoSearch } from "./search";
import { appendLeadRow, newRunId } from "./storage";

// ─────────────────────────────────────────────────────────────────────────────
// Task 27 licensing slice — a runnable search-to-leads path inside the Extractor
// EXE. This route is the server half of the EXE's Extract-page "Search" action:
//
//   GET  /api/exe/extract -> { enabled:true } in local-EXE mode (404 otherwise).
//                            The Extract page pings this to pick web-UI vs local-UI.
//   POST /api/exe/extract -> run the full pipeline and STREAM results back as SSE:
//                            query expansion -> DDG search -> isPdfResult dispatch
//                            -> extractLeadPage / extractLeadPdf -> leads.
//
// Gated by isLocalExeRuntime() exactly like /api/exe-license/* (fail-closed,
// 404 on the hosted web app). SSE lets the UI render leads "as they come in".
//
// Bounded, deliberately, for this slice: a handful of expanded queries, a small
// results-per-query cap, a total-lead ceiling, and no concurrency — a real, demo
// grade search→extract run that a proper (resilient, multi-engine, exit-node)
// search layer replaces later.
// ─────────────────────────────────────────────────────────────────────────────

// Slice-temporary bounds (see top-of-file note — not the final search design).
const MAX_QUERIES_PER_RUN = 5;
const MAX_RESULTS_PER_QUERY = 6;
const MAX_TOTAL_LEADS = 40;
const QUERY_STAGGER_MS = 600; // be polite to DDG between plain-HTTP requests

/** Parse freeform find/location input (commas, semicolons, newlines, pipes). */
function splitTerms(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(/[,\n;|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildBaseTerms(findTerms: string[], locationTerms: string[]): string[] {
  const out: string[] = [];
  for (const f of findTerms) {
    if (!locationTerms.length) {
      out.push(f);
      continue;
    }
    for (const l of locationTerms) out.push(`${f} in ${l}`);
  }
  return Array.from(new Set(out));
}

/** Drain candidate queries from roundQueries(round=0,1,2,...) up to the cap. */
function expandQueries(baseTerms: string[], cap: number): string[] {
  const out: string[] = [];
  outer: for (let round = 0; round < 8; round++) {
    for (const q of roundQueries(baseTerms, round)) {
      if (out.length >= cap) break outer;
      out.push(q);
    }
  }
  return out;
}

// SSE helpers — each event is a single `data: {json}\n\n` frame with a `type`.
const encoder = new TextEncoder();
type Event =
  | { type: "step"; message: string }
  | { type: "lead"; lead: Lead }
  | { type: "done"; total: number; leadFile: string | null };

function sseFrame(ev: Event): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(ev)}\n\n`);
}

/** The actual search → extract pipeline; pushes events into the SSE stream. */
async function runExtraction(
  payload: { findTerms: string[]; locationTerms: string[]; pdfOnly: boolean; maxResults: number },
  push: (ev: Event) => void,
  delay: (ms: number) => Promise<void>,
): Promise<{ total: number; leadFile: string | null }> {
  const baseTerms = buildBaseTerms(payload.findTerms, payload.locationTerms);
  if (!baseTerms.length) throw new Error("No search terms.");

  const queries = expandQueries(baseTerms, Math.max(1, Math.min(payload.maxResults, MAX_QUERIES_PER_RUN)));
  const queryForDisplay = queries.length === 0 ? baseTerms[0] : queries[0];
  push({ type: "step", message: `Expanded ${baseTerms.length} base term(s) into ${queries.length} query(ies); starting with “${queryForDisplay}”.` });

  const probe = defaultProbe();
  const pdfDeps = defaultPdfTextDeps();
  const pageFetcher = defaultFetcher();
  // Give the page crawler a PDF-text source too, so embedded-PDF links on a found
  // page also contribute text (matches extractLeadPage's optional fetchPdfText).
  pageFetcher.fetchPdfText = (u) => fetchPdfText(u, pdfDeps);

  const runId = newRunId();
  const seenUrls = new Set<string>();
  let total = 0;
  let leadFile: string | null = null;

  for (let qi = 0; qi < queries.length; qi++) {
    let q = queries[qi];
    if (payload.pdfOnly) q = biasQueryTowardPdfs(q);
    push({ type: "step", message: `Searching ${qi + 1}/${queries.length}: “${q}”` });

    const { results, blocked } = await duckDuckGoSearch(q, MAX_RESULTS_PER_QUERY);
    if (blocked) {
      push({
        type: "step",
        message: "DuckDuckGo answered with its anti-bot challenge page (anomaly) — no results for this query; moving on.",
      });
      if (qi < queries.length - 1) await delay(QUERY_STAGGER_MS);
      continue;
    }
    if (!results.length) {
      push({ type: "step", message: "No results for this query." });
      if (qi < queries.length - 1) await delay(QUERY_STAGGER_MS);
      continue;
    }
    push({ type: "step", message: `${results.length} result(s); extracting contact details…` });

    for (const result of results) {
      if (total >= MAX_TOTAL_LEADS) break;
      if (!result.url || seenUrls.has(result.url)) continue;
      seenUrls.add(result.url);

      let leads: Lead[] = [];
      try {
        if (await isPdfResult(result.url, probe)) {
          push({ type: "step", message: `PDF result — extracting: ${result.url}` });
          leads = await extractLeadPdf(result, { fetchPdfText: (u) => fetchPdfText(u, pdfDeps) });
        } else {
          leads = await extractLeadPage(result, {
            fetcher: pageFetcher,
            onStep: (step) => push({ type: "step", message: `${result.url.slice(0, 44)}… ${step}` }),
          });
        }
      } catch {
        leads = []; // a bad page/PDF must never abort the run
      }

      for (const lead of leads) {
        if (total >= MAX_TOTAL_LEADS) break;
        total++;
        const file = appendLeadRow(runId, lead); // temp local JSONL — replaced by SQLite fork later
        if (file) leadFile = file;
        push({ type: "lead", lead });
      }
    }

    if (qi < queries.length - 1) await delay(QUERY_STAGGER_MS);
  }

  return { total, leadFile };
}

export async function GET() {
  if (!isLocalExeRuntime()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ enabled: true, buildTarget: "extractor" });
}

export async function POST(req: NextRequest) {
  if (!isLocalExeRuntime()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const findTerms = splitTerms(body.findTerms);
  if (!findTerms.length) {
    return NextResponse.json({ error: "Enter at least one find term (e.g. “roofing contractor”)." }, { status: 400 });
  }
  const locationTerms = splitTerms(body.locationTerms);
  const pdfOnly = body.pdfOnly === true;
  const maxResults = typeof body.maxResults === "number" ? Math.floor(body.maxResults) : MAX_QUERIES_PER_RUN;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (ev: Event) => {
        try {
          controller.enqueue(sseFrame(ev));
        } catch {
          /* client went away — stop pushing; the async run below still finishes */
        }
      };
      const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

      try {
        const { total, leadFile } = await runExtraction(
          { findTerms, locationTerms, pdfOnly, maxResults },
          push,
          delay,
        );
        push({ type: "done", total, leadFile });
      } catch (err) {
        push({ type: "step", message: `Error: ${err instanceof Error ? err.message : String(err)}` });
        push({ type: "done", total: 0, leadFile: null });
      } finally {
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}