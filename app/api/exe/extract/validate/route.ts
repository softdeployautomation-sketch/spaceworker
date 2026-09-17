import { NextResponse } from "next/server";
import { isLocalExeRuntime } from "@/lib/exe-runtime";
import { validateEmailsBatch } from "@/lib/email-validator";

// Task 27 EXE feature-parity — local batch email validation for the Extractor EXE.
//
// The web validates one job's leads server-side (POST /api/jobs/[id]/validate)
// because that validation needs node:dns MX lookups (lib/email-validator.ts is
// marked server-only and can't run in the browser). The EXE keeps the SAME contract
// but locally: this route runs inside the Tauri-bundled standalone Next server on
// the customer's own machine, gated by isLocalExeRuntime() exactly like
// /api/exe/extract (fail-closed, 404 on the hosted web app).
//
// The one intentional difference from the web route: the web WRITES
// validationStatus back to its Postgres rows. The EXE has no Postgres on the
// customer's machine, so this route deliberately returns the raw results instead and
// lets the client fold them into the in-memory RunRecord.leads array — the validator
// itself is byte-for-byte the same lib/email-validator.ts.

// Generous guard (imports + extraction runs are both well under this); mirrors the
// web's bounded-concurrency batch behavior for arbitrarily large inputs.
const MAX_BATCH = 5000;

interface ValidationResultRow {
  email: string;
  isValid: boolean;
  reason?: "invalid_format" | "no_mx_records";
}

export async function POST(req: Request) {
  if (!isLocalExeRuntime()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body: { emails?: unknown };
  try {
    body = (await req.json()) as { emails?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const emails = (Array.isArray(body.emails) ? body.emails : [])
    .filter((e): e is string => typeof e === "string")
    .map((e) => e.trim())
    .filter((e) => e.length > 0)
    .slice(0, MAX_BATCH);

  if (emails.length === 0) {
    return NextResponse.json({ validated: 0, results: [] });
  }

  const results = await validateEmailsBatch(emails);
  // validateEmailsBatch returns results in input order, so the client can match
  // each result back to its email by the returned `email` field regardless.
  return NextResponse.json({
    validated: results.length,
    results: results as ValidationResultRow[],
  });
}