import { NextResponse } from "next/server";

import { isLocalExeRuntime } from "@/lib/exe-runtime";
import { readExtractRuns, writeExtractRuns } from "@/lib/extract-runs-state";

// Real local persistence for the EXE's extraction run history (see
// lib/extract-runs-state.ts's top comment for why this replaces the old
// temp-JSONL-only design). GET loads on mount; POST is called (debounced) by
// the client whenever its in-memory `runs` state changes.

export async function GET() {
  if (!isLocalExeRuntime()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const state = await readExtractRuns();
  // A run persisted mid-stream as "running" cannot actually still be running —
  // the process that was streaming it is gone (the app closed). Surface it as
  // stopped rather than lying about live progress that will never resume.
  const runs = state.runs.map((r) => {
    if (r && typeof r === "object" && (r as { status?: unknown }).status === "running") {
      return { ...r, status: "failed", stoppedReason: "app_closed" };
    }
    return r;
  });
  return NextResponse.json({ runs, nextRunId: state.nextRunId });
}

export async function POST(req: Request) {
  if (!isLocalExeRuntime()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { runs?: unknown; nextRunId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!Array.isArray(body.runs) || typeof body.nextRunId !== "number") {
    return NextResponse.json({ error: "runs (array) and nextRunId (number) are required." }, { status: 400 });
  }

  const ok = await writeExtractRuns(body.runs, body.nextRunId);
  return NextResponse.json({ ok });
}
