import "server-only";

import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import path from "path";

// TASK_130 (§1) — local, server-side persistence for the self-hosted first-run
// setup wizard. Deliberately modeled EXACTLY on lib/license-state.ts: same
// SPACEWORKER_LOCAL_DATA_DIR override, same per-OS app-data fallback, same
// mkdir + readFile/writeFile shape, same `version: 1` envelope — only the
// filename differs. Not a customer-facing file; it's the "has this install
// been set up yet, and with what" marker the proxy gate and the wizard both
// read.
//
// Trust boundary: this file lives next to exe-license-state.json on the box
// the app runs on. The RMM Engine token is a genuine secret, so it's stored
// here (needed after a restart until .env.local is read) but is NEVER echoed
// back in an API response once saved — see the setup routes' `{ configured }`
// shapes. The AI/RMM/Telegram secrets are ALSO appended to .env.local at the
// wizard's final confirm step, which is what actually takes effect on restart
// (the running Node process cannot rewrite its own already-evaluated `env`).

export interface SelfHostedSetupState {
  version: 1;
  /** ISO (UTC) — presence = the wizard has been completed at least once. */
  completedAt?: string;
  license?: { key: string; validatedAt: string };
  rmmEngine?: { url: string; token: string; testedAt: string };
  aiProvider?: { configured: boolean; baseUrl?: string; model?: string; testedAt: string };
  email?: { configured: boolean };
  telegram?: { configured: boolean };
}

const DEFAULT_STATE: SelfHostedSetupState = { version: 1 };

/**
 * Resolves where this install's setup state lives. Honours the exact same
 * SPACEWORKER_LOCAL_DATA_DIR override lib/license-state.ts does (the Tauri
 * shell points at its own app-data dir), otherwise falls back to the same
 * per-OS app-data location, with the filename swapped.
 */
export function setupStatePath(): string {
  const override = process.env.SPACEWORKER_LOCAL_DATA_DIR;
  if (override) return path.join(override, "self-hosted-setup-state.json");

  const sys = process.platform; // win32 | darwin | linux | ...
  try {
    if (sys === "win32") {
      return path.join(
        process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"),
        "SpaceWorkerOS",
        "self-hosted-setup-state.json",
      );
    }
    if (sys === "darwin") {
      return path.join(
        homedir(),
        "Library",
        "Application Support",
        "SpaceWorkerOS",
        "self-hosted-setup-state.json",
      );
    }
    const dataHome = process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share");
    return path.join(dataHome, "spaceworker-os", "self-hosted-setup-state.json");
  } catch {
    return path.join(process.env.TMPDIR ?? "/tmp", "spaceworker-os", "self-hosted-setup-state.json");
  }
}

/** Reads the local setup state, returning defaults (never throwing) if absent/corrupt. */
export async function readSetupState(): Promise<SelfHostedSetupState> {
  try {
    const raw = await readFile(setupStatePath(), "utf8");
    const parsed = JSON.parse(raw) as SelfHostedSetupState;
    if (parsed && typeof parsed === "object" && parsed.version === 1) return parsed;
  } catch {
    // missing file / bad JSON → defaults
  }
  return { ...DEFAULT_STATE };
}

async function writeSetupState(state: SelfHostedSetupState): Promise<void> {
  const filePath = setupStatePath();
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(state, null, 2), "utf8");
}

/** Shallow-merges a patch into the stored state (never a blind overwrite of
 *  unrelated fields a previous wizard step already recorded). */
export async function updateSetupState(
  patch: Partial<Omit<SelfHostedSetupState, "version">>,
): Promise<SelfHostedSetupState> {
  const state = await readSetupState();
  const next: SelfHostedSetupState = { ...state, ...patch, version: 1 };
  await writeSetupState(next);
  return next;
}

/** True once the wizard has been completed at least once on this install. */
export async function isSetupComplete(): Promise<boolean> {
  const state = await readSetupState();
  return typeof state.completedAt === "string" && state.completedAt.length > 0;
}

/**
 * Best-effort append/update of `.env.local` in the project root. The running
 * Node process cannot rewrite its own already-evaluated `lib/env.ts` `env`
 * object, so this is how a wizard-collected value actually takes effect: on
 * the NEXT process start, Next loads `.env.local` and the new value is live.
 *
 * Never throws — a read-only install directory (or a packaged EXE tree) must
 * not turn "setup finished" into a 500. The caller surfaces `written:false`
 * so the UI can tell the user to set the value by hand instead.
 */
export async function upsertLocalEnv(
  vars: Record<string, string>,
): Promise<{ path: string; written: boolean; error?: string }> {
  const filePath = path.join(process.cwd(), ".env.local");
  try {
    let existing = "";
    try {
      existing = await readFile(filePath, "utf8");
    } catch {
      // no file yet — start empty
    }
    const lines = existing.length > 0 ? existing.split(/\r?\n/) : [];
    // Normalise trailing blank lines FIRST, so appended keys land immediately
    // after the file's real content instead of below an existing gap.
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    for (const [key, value] of Object.entries(vars)) {
      // Defensive: only ever write well-formed env keys.
      if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
      const line = `${key}=${formatEnvValue(value)}`;
      const idx = lines.findIndex((l) => l.trimStart().startsWith(`${key}=`));
      if (idx >= 0) lines[idx] = line;
      else lines.push(line);
    }
    await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
    return { path: filePath, written: true };
  } catch (err) {
    return {
      path: filePath,
      written: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function formatEnvValue(value: string): string {
  // Bare when dotenv's `/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/` line parser can't be
  // confused by it — note `=` is safe mid-value (only the FIRST `=` splits the
  // line), which matters because base64 license payloads end in `=` padding.
  // Anything else (spaces, `#`, quotes) gets quoted + escaped.
  if (/^[A-Za-z0-9_@./:+=+-]*$/.test(value)) return value;
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  return `"${escaped}"`;
}
