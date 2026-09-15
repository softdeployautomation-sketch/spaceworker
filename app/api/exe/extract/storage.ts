/**
 * TEMPORARY local persistence for EXE extraction runs (Task 27 licensing slice
 * 4). The plan calls for a SQLite schema fork eventually; this pass deliberately
 * holds a run's leads in a simple local JSONL file so there's a tangible on-disk
 * record of what the EXE found, without blocking this slice on a schema.
 *
 * Location: os.tmpdir()/spaceworker-exe-leads/<runId>.jsonl — a throwaway
 * temp location, NOT the app's real data dir. It's purely to make the demo real;
 * when the SQLite fork lands this whole file is replaced by real schema'd writes.
 * Writes are wrapped in try/catch so a storage failure can never take down an
 * otherwise-working extraction.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** Resolve a temp dir without depending on new node:os APIs (works on all supported Nodes). */
function osTmpDir(): string {
  return process.env.TMPDIR || process.env.TEMP || process.env.TMP || "/tmp";
}

/** A stable-ish temp dir for this slice's demo lead files. */
export function exeLeadDir(): string {
  return join(osTmpDir(), "spaceworker-exe-leads");
}

/** Generate a short run id for the output file name. */
export function newRunId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

/** Ensure the temp lead dir exists (best-effort; never throws). */
export function ensureLeadDir(): void {
  try {
    mkdirSync(exeLeadDir(), { recursive: true });
  } catch {
    /* best-effort only */
  }
}

/**
 * Append one lead as a JSONL line to <runId>.jsonl. Returns the path written on
 * success, or null on any failure (storage must never break extraction).
 */
export function appendLeadRow(runId: string, lead: unknown): string | null {
  try {
    ensureLeadDir();
    const file = join(exeLeadDir(), `${runId}.jsonl`);
    writeFileSync(file, JSON.stringify(lead) + "\n", { flag: "a", encoding: "utf8" });
    return file;
  } catch {
    return null;
  }
}