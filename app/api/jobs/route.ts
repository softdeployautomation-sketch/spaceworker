import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";

const TEMPLATES = ["lead", "hr", "plain"] as const;
type Template = (typeof TEMPLATES)[number];

function isTemplate(value: unknown): value is Template {
  return typeof value === "string" && (TEMPLATES as readonly string[]).includes(value);
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const jobs = await prisma.searchJob.findMany({
    where: { userId: session.userId },
    select: {
      id: true, query: true, template: true, params: true, status: true,
      lane: true, error: true, createdAt: true, currentStep: true,
      currentStepAt: true,
      _count: { select: { leads: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(jobs);
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    query?: unknown; queries?: unknown; template?: unknown; params?: unknown; lane?: unknown;
  };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const lane = body.lane === "heavy" ? "heavy" : "light";

  // The multi-item "Find" list is the real shape now (Task 11): a user adds
  // "plumber", "carpenter", ... as separate chips. Accept either `queries: string[]`
  // (preferred) or a single legacy `query` string.
  const queryList: string[] = [];
  if (Array.isArray(body.queries)) {
    for (const q of body.queries) {
      if (typeof q === "string" && q.trim()) queryList.push(q.trim());
    }
  }
  if (typeof body.query === "string" && body.query.trim()) {
    queryList.push(body.query.trim());
  }
  // Capped server-side too (defense in depth) — the Find x Location
  // cross-multiply in the UI caps at 300 (matching worker/automation.py's own
  // MAX_TOTAL_QUERIES ceiling on the total query budget one job will ever
  // process), but this route has no way to know whether a request actually
  // came from that UI.
  const MAX_QUERIES = 300;
  const uniqueQueries = [...new Set(queryList)].slice(0, MAX_QUERIES);
  if (uniqueQueries.length === 0) {
    return NextResponse.json({ error: "At least one search term is required" }, { status: 400 });
  }

  const template = isTemplate(body.template) ? body.template : "lead";
  if (template !== "lead") {
    // HR/Plain Search have no automation backend yet (per PLAN.md Addendum 5 they
    // need their own pipeline, not this lead engine). Refuse to run the lead engine
    // against their input — never silently run the wrong engine.
    return NextResponse.json(
      { error: `The "${template}" template is coming soon and cannot be submitted yet.` },
      { status: 400 }
    );
  }

  const rawParams =
    body.params && typeof body.params === "object" && !Array.isArray(body.params)
      ? (body.params as Record<string, unknown>)
      : {};
  const engine = rawParams.engine === "google" ? "google" : "ddg";

  // Clamp maxResults server-side. Accept number or numeric string. Google runs in
  // the heavy lane (it needs a real browser); DDG is the light lane.
  // Ceiling raised 200 -> 50000: 200 was silently chopping down a user-set
  // value (e.g. 50000) with no indication anywhere, and worker/automation.py's
  // own independent clamp used to be even lower (50) — both fixed together.
  // This number is a theoretical ceiling only; no single search page will
  // ever return anywhere near it, so raising it doesn't change real behavior
  // except no longer lying about what was actually requested.
  const rawMax = rawParams.maxResults;
  const coercedMax =
    typeof rawMax === "number" ? rawMax
    : typeof rawMax === "string" && rawMax.trim() !== "" ? Number(rawMax)
    : undefined;
  const maxResults =
    coercedMax !== undefined && !isNaN(coercedMax)
      ? Math.min(Math.max(10, coercedMax), 50000)
      : undefined;

  // Email-domain allowlist (Task 13): worker/automation.py reads
  // params.emailDomains as a comma-separated string. This was previously
  // dropped here — the client sent it, but nothing forwarded it into the
  // stored params, so the whole filter silently did nothing.
  const rawEmailDomains = rawParams.emailDomains;
  const emailDomains =
    typeof rawEmailDomains === "string" && rawEmailDomains.trim() !== ""
      ? rawEmailDomains.trim().slice(0, 500)
      : undefined;

  // Minimum-results auto-expansion: worker/automation.py reads
  // params.minResults and, if the first search pass falls short, generates
  // related query variants and keeps searching (bounded rounds/query count)
  // until it's met. 0/absent disables expansion entirely.
  // Ceiling raised 500 -> 50000: confirmed a user requesting minResults=30000
  // got silently rounded down to 500 with no indication why, then the job
  // legitimately (if confusingly) reported "done" once the actual, much
  // smaller 500-target's query/page budget was exhausted. The worker already
  // reports an honest "found X of your Y-lead minimum, ran out of budget"
  // message when it falls short (see extract/page.tsx) — that's the correct
  // way to communicate a shortfall, not silently changing what Y was.
  const rawMinResults = rawParams.minResults;
  const coercedMin =
    typeof rawMinResults === "number" ? rawMinResults
    : typeof rawMinResults === "string" && rawMinResults.trim() !== "" ? Number(rawMinResults)
    : undefined;
  const minResults =
    coercedMin !== undefined && !isNaN(coercedMin) && coercedMin > 0
      ? Math.min(coercedMin, 50000)
      : undefined;

  // Real crawler (Task 13): pagesPerQuery = how many Google result pages to visit
  // per query (1-20); maxDurationMinutes = wall-clock cap before the job pauses at
  // a query boundary (1-180, i.e. up to 3 hours per the user's explicit ask —
  // default stays 30 in the UI). Same clamp-and-conditionally-include convention
  // as minResults above.
  //
  // Capacity note: each lane allows exactly ONE concurrent job platform-wide
  // (see app/api/internal/dispatch/route.ts's advisory-lock claim) — a job that
  // legitimately runs the full 3 hours occupies one of only two total slots for
  // that whole window, queuing every other job in the same lane behind it.
  // Acceptable for now at current volume; worth revisiting (more lanes, or a
  // duration-aware lane) if a 3-hour job ever visibly blocks other users.
  const rawPages = rawParams.pagesPerQuery;
  const coercedPages =
    typeof rawPages === "number" ? rawPages
    : typeof rawPages === "string" && rawPages.trim() !== "" ? Number(rawPages)
    : undefined;
  const pagesPerQuery =
    coercedPages !== undefined && !isNaN(coercedPages)
      ? Math.min(Math.max(1, coercedPages), 20)
      : undefined;

  const rawDuration = rawParams.maxDurationMinutes;
  const coercedDuration =
    typeof rawDuration === "number" ? rawDuration
    : typeof rawDuration === "string" && rawDuration.trim() !== "" ? Number(rawDuration)
    : undefined;
  const maxDurationMinutes =
    coercedDuration !== undefined && !isNaN(coercedDuration)
      ? Math.min(Math.max(1, coercedDuration), 180)
      : undefined;

  // Display-only preference (which columns the results table renders) — never
  // affects extraction, which always captures every field regardless. Validated
  // against the fixed set the frontend actually offers; anything else silently
  // falls back to the default rather than storing junk in params.
  const RESULT_MODES = ["namesEmails", "full", "emailsOnly"] as const;
  const rawResultMode = rawParams.resultMode;
  const resultMode = RESULT_MODES.includes(rawResultMode as (typeof RESULT_MODES)[number])
    ? (rawResultMode as (typeof RESULT_MODES)[number])
    : "namesEmails";

  // findTerms/locationTerms: the ORIGINAL, un-cross-multiplied Find/Location
  // chips, stored purely so the dashboard's "Load" action can reconstruct the
  // exact original split later — the worker never reads either field, only
  // `queries` (the already-combined list) drives the actual search. Without
  // this, loading a past 2-Find x 5-Location run back into the form flattened
  // all 10 combined strings into the Find column alone (confirmed live —
  // real user report). Same string-array sanitization as `queries` above,
  // capped generously since these are pure display/reload metadata, not a
  // real query budget.
  function sanitizeStringArray(value: unknown, max: number): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const v of value) {
      if (typeof v === "string" && v.trim()) out.push(v.trim());
      if (out.length >= max) break;
    }
    return out;
  }
  const findTerms = sanitizeStringArray(rawParams.findTerms, 300);
  const locationTerms = sanitizeStringArray(rawParams.locationTerms, 300);

  const params = {
    engine,
    ...(maxResults !== undefined ? { maxResults } : {}),
    ...(emailDomains !== undefined ? { emailDomains } : {}),
    ...(minResults !== undefined ? { minResults } : {}),
    ...(pagesPerQuery !== undefined ? { pagesPerQuery } : {}),
    ...(maxDurationMinutes !== undefined ? { maxDurationMinutes } : {}),
    resultMode,
    queries: uniqueQueries,
    ...(findTerms.length > 0 ? { findTerms } : {}),
    ...(locationTerms.length > 0 ? { locationTerms } : {}),
    template,
  };
  const displayQuery = uniqueQueries.length === 1 ? uniqueQueries[0] : uniqueQueries.join(" | ");
  const resolvedLane = lane === "heavy" || engine === "google" ? "heavy" : "light";

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { tier: true },
  });
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const job = await prisma.$transaction(async (tx) => {
    const searchJob = await tx.searchJob.create({
      data: {
        userId: session.userId,
        query: displayQuery,
        template,
        params: params as Prisma.InputJsonValue,
        lane: resolvedLane,
        status: "queued",
      },
    });
    await tx.jobQueueEntry.create({
      data: {
        searchJobId: searchJob.id,
        priorityTier: user.tier,
        lane: resolvedLane,
        status: "queued",
      },
    });
    return searchJob;
  });

  return NextResponse.json(job, { status: 201 });
}