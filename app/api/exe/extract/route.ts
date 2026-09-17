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

// Task 27 #1 — minimum-leads auto-expansion. These mirror worker/automation.py:
//   - DEFAULT_MAX_DURATION_MINUTES is the wall-clock deadline applied when the UI
//     doesn't send one (the worker's own default; a never-satisfiable minimum can
//     never loop forever because the deadline is checked every query).
//   - MAX_TOTAL_QUERIES_SAFETY_CEILING mirrors the worker's namesake: a pure
//     safety valve against pathological base-term counts, NOT a design target.
const DEFAULT_MAX_DURATION_MINUTES = 30;
const MAX_TOTAL_QUERIES_SAFETY_CEILING = 20000;

/** Clamp an integer-like number to [lo, hi], or `dflt` when not a finite number. */
function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return dflt;
  return Math.min(hi, Math.max(lo, Math.floor(v)));
}

/** Parse freeform find/location input (commas, semicolons, newlines, pipes). */
function splitTerms(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(/[,\n;|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parse the email-domain allowlist sent by the UI. Accepts a string
 * ("gmail.com, *.edu") or an array; normalizes to lowercase, trimmed, deduped.
 */
function parseEmailDomains(raw: unknown): string[] {
  const parts: string[] = typeof raw === "string" ? splitTerms(raw) : Array.isArray(raw) ? raw.map(String) : [];
  const out: string[] = [];
  for (const p of parts) {
    const d = p.trim().toLowerCase();
    if (!d) continue;
    if (!out.includes(d)) out.push(d);
  }
  return out;
}

/**
 * True when `email` matches the domain allowlist: exact domain ("gmail.com"),
 * or suffix pattern (".edu" / "*.edu" → any *.edu address). With an empty
 * allowlist every lead is kept; with a non-empty list a lead is kept only if its
 * email domain matches (a lead with no usable email fails the filter, matching
 * the web UI's "only keep leads whose email matches any listed domain").
 */
function emailDomainMatches(domains: string[], email: unknown): boolean {
  if (!domains.length) return true;
  const e = typeof email === "string" ? email.trim().toLowerCase() : "";
  const at = e.lastIndexOf("@");
  if (at < 0 || at === e.length - 1) return false;
  const d = e.slice(at + 1);
  return domains.some((pat) =>
    pat.startsWith("*.") ? d.endsWith(pat.slice(1)) : pat.startsWith(".") ? d.endsWith(pat) : d === pat,
  );
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

/**
 * Lazy on-demand query growth — the Task 27 #1 port of the worker's `_grow_queries`
 * (worker/automation.py ~1546). Mirrors it exactly: `orderedQueries` starts empty
 * and is extended round-by-round (roundQueries(round=0,1,2,...)) only as far as the
 * main loop actually needs, and never beyond the safety ceiling.
 *
 * When expansion is disabled (no minLeads set), only round 0 — the bare base
 * terms — plus whatever extra rounds fit within the caller's `scope` cap are ever
 * generated, preserving this route's original "Scope = how many queries this run"
 * behavior while still drawing those queries from real expansion rounds.
 */
interface QueryGrower {
  ordered: string[];
  /** Extend `ordered` until it has at least `targetLen` entries, generation runs
   *  out, or the applicable cap (scope when expansion is off, safety ceiling when
   *  on) is hit. Idempotent and cheap to call on every iteration. */
  grow(targetLen: number): void;
  expansionEnabled: boolean;
}

function makeQueryGrower(
  baseTerms: string[],
  opts: { expansionEnabled: boolean; scope: number },
): QueryGrower {
  const used = new Set<string>();
  let nextRound = 0;
  const cap = opts.expansionEnabled ? MAX_TOTAL_QUERIES_SAFETY_CEILING : opts.scope;
  return {
    ordered: [],
    expansionEnabled: opts.expansionEnabled,
    grow(targetLen: number) {
      const effective = Math.min(targetLen, cap);
      while (this.ordered.length < effective) {
        const candidates = roundQueries(baseTerms, nextRound);
        nextRound++;
        if (candidates.length === 0) break; // every combination is exhausted
        for (const c of candidates) {
          if (!used.has(c)) {
            used.add(c);
            this.ordered.push(c);
          }
        }
        if (this.ordered.length >= cap) break;
      }
    },
  };
}

// SSE helpers — each event is a single `data: {json}\n\n` frame with a `type`.
const encoder = new TextEncoder();
type Event =
  | { type: "step"; message: string }
  | { type: "lead"; lead: Lead }
  | {
      type: "done";
      total: number;
      leadFile: string | null;
      /** Why the run stopped — lets the UI show an honest status (minimum met,
       *  deadline hit, lead cap, query space exhausted) instead of silently
       *  reporting a bare "done" that can read as success when the minimum wasn't
       *  reached. Mirrors the worker's done-vs-paused status distinction. */
      stoppedReason: "minLeadsReached" | "deadline" | "maxTotalLeads" | "exhausted" | null;
    };

function sseFrame(ev: Event): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(ev)}\n\n`);
}

/** The actual search → extract pipeline; pushes events into the SSE stream. */
async function runExtraction(
  payload: {
    findTerms: string[];
    locationTerms: string[];
    pdfOnly: boolean;
    maxResults: number; // per-run query scope when min-leads expansion is OFF (this slice's MAX_QUERIES_PER_RUN stand-in)
    resultsPerQuery: number;
    maxTotalLeads: number; // hard ceiling — guaranteed >= minLeads
    minLeads: number; // floor; 0 disables auto-expansion
    maxDurationMinutes: number; // wall-clock deadline
    emailDomains: string[];
  },
  push: (ev: Event) => void,
  delay: (ms: number) => Promise<void>,
): Promise<{ total: number; leadFile: string | null; stoppedReason: "minLeadsReached" | "deadline" | "maxTotalLeads" | "exhausted" | null }> {
  const baseTerms = buildBaseTerms(payload.findTerms, payload.locationTerms);
  if (!baseTerms.length) throw new Error("No search terms.");

  // Task 27 #1 — real minimum-leads auto-expansion, ported from worker/automation.py.
  // When a minLeads floor is set, the query list GREWS on demand (round by round)
  // past the initial "Scope" until the floor is met or the wall-clock deadline hits,
  // so a run like the real customer's ("Max leads 40, got 10, nothing expanded to
  // look for more") keeps inventing new query text instead of stopping dead at the
  // end of a small fixed list. The deadline is checked every query, exactly like
  // the worker's batch-boundary check, so an unreachable minimum (e.g. 10000) can
  // never loop forever.
  const expansionEnabled = payload.minLeads > 0;
  const grower = makeQueryGrower(baseTerms, {
    expansionEnabled,
    scope: payload.maxResults,
  });
  const deadline = Date.now() + payload.maxDurationMinutes * 60_000;

  const firstQuery = baseTerms[0];
  push({
    type: "step",
    message: expansionEnabled
      ? `Expanded ${baseTerms.length} base term(s) — will keep generating query rounds until the ${payload.minLeads}-lead minimum is met, the ${payload.maxDurationMinutes}-minute deadline, or the ${payload.maxTotalLeads}-lead cap. Starting with “${firstQuery}”.`
      : `Expanded ${baseTerms.length} base term(s); starting with “${firstQuery}”.`,
  });

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
  let stoppedReason: "minLeadsReached" | "deadline" | "maxTotalLeads" | "exhausted" | null = "exhausted";
  let queriesRun = 0;

  for (let qi = 0; ; qi++) {
    // Stop checks — checked at every query boundary, mirroring the worker's
    // batch-boundary checks. These are the REAL stopping conditions; growing the
    // query list can only continue while none of them fires.
    if (total >= payload.maxTotalLeads) {
      stoppedReason = "maxTotalLeads";
      break;
    }
    if (expansionEnabled && total >= payload.minLeads) {
      stoppedReason = "minLeadsReached";
      break;
    }
    if (Date.now() >= deadline) {
      stoppedReason = "deadline";
      push({
        type: "step",
        message: expansionEnabled
          ? `Reached the ${payload.maxDurationMinutes}-minute deadline with ${total} lead(s) (target: ${payload.minLeads}) — stopping.`
          : `Reached the ${payload.maxDurationMinutes}-minute deadline with ${total} lead(s) — stopping.`,
      });
      break;
    }

    // Grow the list on demand so a minLeads run keeps inventing new query text
    // instead of stopping the moment a small pre-built list runs out.
    grower.grow(qi + 1);
    if (qi >= grower.ordered.length) {
      if (expansionEnabled) {
        push({
          type: "step",
          message: `Generated every possible query variation (${grower.ordered.length} queries) with ${total} lead(s) — stopping short of the ${payload.minLeads}-lead minimum.`,
        });
      }
      stoppedReason = "exhausted";
      break;
    }

    let q = grower.ordered[qi];
    queriesRun = qi + 1;
    if (payload.pdfOnly) q = biasQueryTowardPdfs(q);
    push({ type: "step", message: `Searching ${queriesRun}: “${q}”` });

    const { results, blocked } = await duckDuckGoSearch(q, payload.resultsPerQuery);
    if (blocked) {
      push({
        type: "step",
        message: "DuckDuckGo answered with its anti-bot challenge page (anomaly) — no results for this query; moving on.",
      });
      await delay(QUERY_STAGGER_MS);
      continue;
    }
    if (!results.length) {
      push({ type: "step", message: "No results for this query." });
      await delay(QUERY_STAGGER_MS);
      continue;
    }
    push({ type: "step", message: `${results.length} result(s); extracting contact details…` });

    for (const result of results) {
      if (total >= payload.maxTotalLeads) break;
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
        if (total >= payload.maxTotalLeads) break;
        // Email-domain allowlist: only keep leads whose email matches the filter
        // (exact domain, or ".suffix"/"*.suffix" pattern). With no filter, keep all.
        if (!emailDomainMatches(payload.emailDomains, lead.email)) continue;
        total++;
        const file = appendLeadRow(runId, lead); // temp local JSONL — replaced by SQLite fork later
        if (file) leadFile = file;
        push({ type: "lead", lead });
      }
    }

    await delay(QUERY_STAGGER_MS);
  }

  return { total, leadFile, stoppedReason };
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
  // Wire the UI's advanced controls to this slice's bounds. Wide but safe ranges so
  // the advertised options (Scope 3/5/10 queries, results-per-query, lead caps) are
  // real — the constants remain the defaults when a field is absent.
  const maxResults = clampInt(body.maxResults, 1, 10, MAX_QUERIES_PER_RUN);
  const resultsPerQuery = clampInt(body.resultsPerQuery, 1, 10, MAX_RESULTS_PER_QUERY);
  // Task 27 #1 — minLeads is the FLOOR (web's minResults semantics); maxTotalLeads is
  // the hard ceiling. The ceiling is normalized to never sit below the floor, so a
  // user asking for a 80-lead minimum can't be silently capped at the 40 default.
  const minLeads = clampInt(body.minLeads, 0, 100_000, 0);
  const rawCeiling = clampInt(body.maxTotalLeads, 1, 1_000_000, MAX_TOTAL_LEADS);
  const maxTotalLeads = Math.max(rawCeiling, minLeads);
  const maxDurationMinutes = clampInt(body.maxDurationMinutes, 1, 480, DEFAULT_MAX_DURATION_MINUTES);
  const emailDomains = parseEmailDomains(body.emailDomains);

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
        const { total, leadFile, stoppedReason } = await runExtraction(
          { findTerms, locationTerms, pdfOnly, maxResults, resultsPerQuery, maxTotalLeads, minLeads, maxDurationMinutes, emailDomains },
          push,
          delay,
        );
        push({ type: "done", total, leadFile, stoppedReason });
      } catch (err) {
        push({ type: "step", message: `Error: ${err instanceof Error ? err.message : String(err)}` });
        push({ type: "done", total: 0, leadFile: null, stoppedReason: null });
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