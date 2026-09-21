import "server-only";

import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import path from "path";

// Real local persistence for the EXE's extraction run history (replaces the
// "TEMPORARY... deliberately in-memory" design from Task 27 — see
// app/api/exe/extract/storage.ts and the top comment in local-extract.tsx.
// Confirmed live 2026-09-21: without this, closing and reopening the app
// silently loses every run's leads — the old temp-JSONL mirror was write-only
// (nothing ever read it back) and lived in os.tmpdir(), which several OSes
// clear on their own.
//
// Same per-OS app-data-dir convention as lib/license-state.ts (including the
// SPACEWORKER_LOCAL_DATA_DIR override the Tauri shell can set), sibling file
// in the same directory, so both stores move together if that directory is
// ever changed.

export const EXTRACT_RUNS_VERSION = 1;

// A run's leads/steps are unbounded during a live run (up to MAX_TOTAL_LEADS,
// currently 5000+) — cap how much run HISTORY we keep on disk so this file
// can't grow without bound across weeks of use. Oldest runs are dropped first.
const MAX_PERSISTED_RUNS = 25;

export interface PersistedExtractState {
  version: 1;
  runs: unknown[]; // opaque RunRecord[] — this module doesn't need the shape
  nextRunId: number;
}

const DEFAULT_STATE: PersistedExtractState = { version: 1, runs: [], nextRunId: 1 };

/** Resolves where this machine's extraction run history lives. */
export function extractRunsStatePath(): string {
  const override = process.env.SPACEWORKER_LOCAL_DATA_DIR;
  if (override) return path.join(override, "exe-extract-runs.json");

  const sys = process.platform;
  try {
    if (sys === "win32") {
      return path.join(
        process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"),
        "SpaceWorkerOS",
        "exe-extract-runs.json",
      );
    }
    if (sys === "darwin") {
      return path.join(
        homedir(),
        "Library",
        "Application Support",
        "SpaceWorkerOS",
        "exe-extract-runs.json",
      );
    }
    const dataHome = process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share");
    return path.join(dataHome, "spaceworker-os", "exe-extract-runs.json");
  } catch {
    return path.join(process.env.TMPDIR ?? "/tmp", "spaceworker-os", "exe-extract-runs.json");
  }
}

/** Reads persisted run history, returning defaults (never throwing) if absent/corrupt. */
export async function readExtractRuns(): Promise<PersistedExtractState> {
  try {
    const raw = await readFile(extractRunsStatePath(), "utf8");
    const parsed = JSON.parse(raw) as PersistedExtractState;
    if (parsed && typeof parsed === "object" && parsed.version === 1 && Array.isArray(parsed.runs)) {
      return parsed;
    }
  } catch {
    // missing file / bad JSON -> defaults
  }
  return { ...DEFAULT_STATE };
}

/**
 * Persists run history, best-effort. Never throws — a storage failure must
 * never break the extractor UI (same posture as the old temp-JSONL writer).
 * Keeps only the most recent MAX_PERSISTED_RUNS runs (by array order, which
 * the client already keeps newest-last) to bound file growth.
 */
export async function writeExtractRuns(runs: unknown[], nextRunId: number): Promise<boolean> {
  try {
    const trimmed = runs.length > MAX_PERSISTED_RUNS ? runs.slice(runs.length - MAX_PERSISTED_RUNS) : runs;
    const state: PersistedExtractState = { version: 1, runs: trimmed, nextRunId };
    const filePath = extractRunsStatePath();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(state), "utf8");
    return true;
  } catch {
    return false;
  }
}
