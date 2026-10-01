// TASK_135 §6 — the STATE pipe, server side: what a device is asked for, what
// arrives, and where it is kept between clones.
//
// WHY A PERSISTENT CACHE AND NOT PER-JOB STAGING. The hosted profile directory is
// created per SESSION and destroyed when the session ends (lib/browser-profiles.ts
// `profileDirPath(sessionId)`, and the launch deletes it on every exit path). If a
// reconnect sent only a DELTA into a fresh profile, that profile would be missing
// every unchanged file — a replica with no history and no bookmarks, which is the
// exact failure this feature exists to remove. So the bytes that survive between
// clones live HERE, in a cache keyed by clone TARGET (device + browser + profile),
// and each session's profile is materialised from the whole cache. A delta then
// only ever changes bytes on the wire; the materialised tree is always complete.
//
// NOT marked `server-only`, deliberately: the cache directory comes from the
// caller (the route), so this module is pure-plus-filesystem and can be tested
// without a database, exactly like lib/clone-state-restore.ts.
//
// NOTHING HERE TOUCHES THE WORK PC.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { normalizeProfileName, normalizeRelPath, stageIncomingFile, stateFileProblem } from "./clone-state-restore";
import {
  SYNC_MODE_DELTA,
  SYNC_MODE_FULL,
  planSync,
  validateSyncDecision,
  type FileFingerprint,
  type StateManifest,
  type SyncDecision,
} from "./clone-sync-plan";

/**
 * The same spelling comparison the planner uses (lib/clone-sync-plan.ts keeps its
 * `normalizePath` private). Duplicated rather than exported so the planner's
 * public surface does not grow for one caller — but it must STAY identical: two
 * spellings of one file must never become two entries in a manifest.
 */
function normKey(p: string): string {
  return (p ?? "").trim().replace(/\\/g, "/").toLowerCase();
}

/**
 * The cache key for one clone target.
 *
 * A plain concatenation is not safe as a directory name (a profile name may hold
 * spaces, and `chrome`+`Default` must never collide with `chromedefault`+empty),
 * so the parts are sanitised for readability and a short hash of the RAW tuple is
 * appended for uniqueness. Two different targets can therefore never share a
 * cache directory, which would silently merge two users' state.
 */
export function stateTargetKey(parts: {
  deviceId: string;
  browser: string;
  profileName: string;
}): string {
  const raw = [parts.deviceId, parts.browser, parts.profileName].join("\u0000");
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  const label = [parts.deviceId, parts.browser, parts.profileName]
    .map((p) => (p ?? "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24))
    .filter(Boolean)
    .join("__");
  return `${label || "clone"}__${hash}`;
}

/** The cache root for one target, under the caller-provided base directory. */
export function stateCacheDirPath(baseDir: string, targetKey: string): string {
  const root = resolve(baseDir);
  const key = (targetKey ?? "").trim();
  // A KEY IS A DIRECTORY NAME, never a path. The keys this module generates hold
  // only `[A-Za-z0-9._-]`, so a separator, a drive letter or a `..` component means
  // something built this key that should not have — and a `..` component resolves
  // to a location the containment check below CANNOT catch, because joining
  // `../escape` onto `<base>/clone-state` still lands inside `<base>`.
  if (
    key === "" ||
    key === "." ||
    key === ".." ||
    /^[.]+$/.test(key) ||
    /[/\\]/.test(key) ||
    key.includes(":")
  ) {
    throw new Error("state_target_key_unsafe");
  }
  const dir = resolve(join(root, "clone-state", key));
  // Second layer: whatever the key, the result must be INSIDE the profile store.
  if (!dir.startsWith(root + sep)) {
    throw new Error("state_target_key_unsafe");
  }
  return dir;
}

/**
 * The cache directory for a target, resolved from the environment.
 *
 * ONE function for both writers and readers of the cache — the ingest route and
 * the launch — because the two MUST agree on the directory or the state that
 * arrived is never materialised and the clone silently opens empty. The profile
 * name is normalised HERE, through the same validator the materialiser uses, so
 * `Default` and an absent name can never resolve to two different directories.
 */
export function stateCacheDirForTarget(parts: {
  deviceId: string;
  browser: string;
  profileName: string | null | undefined;
}): string {
  const base = process.env.BROWSER_PROFILE_BASE_DIR;
  if (!base) throw new Error("BROWSER_PROFILE_BASE_DIR is not set");
  const profileName = normalizeProfileName(parts.profileName);
  if (profileName === null) throw new Error("state_profile_unknown");
  return stateCacheDirPath(
    base,
    stateTargetKey({ deviceId: parts.deviceId, browser: parts.browser.trim().toLowerCase(), profileName }),
  );
}

/** Profile name from a manifest, for the target key. Absent means `Default`. */
export function profileNameOfManifest(manifest: unknown): string {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) return "Default";
  const profile = (manifest as { profile?: unknown }).profile;
  const raw = typeof profile === "string" ? profile.trim() : "";
  return raw || "Default";
}

export interface ManifestValidation {
  /** Fingerprints that may be carried. */
  kept: FileFingerprint[];
  /** Every file refused, with a reason. Nothing is dropped silently. */
  excluded: Array<{ path: string; reason: string }>;
  bytes: number;
}

/**
 * Validates a manifest's file list with the SAME rules as the device
 * (lib/clone-sync-plan.ts → scripts/check-clone-contract.mjs keeps the two
 * exclusion lists identical), and de-duplicates by normalised path.
 *
 * A file with no usable size or mtime is refused rather than guessed at: the
 * fingerprint is what makes a delta safe, so a file that cannot be fingerprinted
 * must not silently become "unchanged".
 */
export function validateManifestFiles(files: unknown): ManifestValidation {
  const kept: FileFingerprint[] = [];
  const excluded: Array<{ path: string; reason: string }> = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const entry of Array.isArray(files) ? files : []) {
    const f = entry as Partial<FileFingerprint> | null;
    const path = typeof f?.path === "string" ? f.path.trim() : "";
    const problem = stateFileProblem(path);
    if (problem) {
      excluded.push({ path: path || "(empty)", reason: problem });
      continue;
    }
    const key = normKey(path);
    if (seen.has(key)) {
      excluded.push({ path, reason: "state_path_duplicate" });
      continue;
    }
    const size = typeof f?.size === "number" && Number.isFinite(f.size) && f.size >= 0 ? f.size : null;
    const mtime = typeof f?.mtime === "number" && Number.isFinite(f.mtime) ? f.mtime : null;
    if (size === null || mtime === null) {
      excluded.push({ path, reason: "state_fingerprint_incomplete" });
      continue;
    }
    seen.add(key);
    kept.push({ path, size, mtime, ...(typeof f?.sha256 === "string" && f.sha256 ? { sha256: f.sha256 } : {}) });
    bytes += size;
  }
  return { kept, excluded, bytes };
}

/**
 * The sync decision for one target, checked before it is returned.
 *
 * A decision that fails `validateSyncDecision` is a BUG, not a condition: it would
 * mean a delta asking for a path it refused, or a delta with no delta. Rather than
 * hand that to a device, the caller is told and the safe full transfer is used —
 * over-sending is recoverable, a silently incomplete replica is not.
 */
export function decideStateSync(opts: {
  previous: StateManifest | null | undefined;
  next: StateManifest;
  now?: Date;
  maxAgeMs?: number;
}): SyncDecision {
  const decision = planSync(opts.previous, opts.next, {
    now: opts.now ?? new Date(),
    maxAgeMs: opts.maxAgeMs,
  });
  const problem = validateSyncDecision(decision);
  if (!problem) return decision;
  return {
    mode: SYNC_MODE_FULL,
    reason: `sync_decision_invalid:${problem}`,
    cookiesAlwaysFull: true,
    requestedPaths: [],
    excluded: decision.excluded,
  };
}

/**
 * Stages ONE inbound file into the target's cache.
 *
 * An empty body is refused by `stageIncomingFile` and reported with its reason.
 * The content is never logged, and this function returns counts and bytes only —
 * a state file can hold a browsing history, and none of it belongs in a log line.
 */
export async function ingestStateFile(opts: {
  cacheDir: string;
  relPath: string;
  content: Buffer;
}): Promise<{ ok: boolean; error?: string; bytes: number }> {
  const res = await stageIncomingFile({
    stagingDir: opts.cacheDir,
    relPath: opts.relPath,
    content: opts.content,
  });
  return { ok: res.ok, error: res.error, bytes: res.ok ? (res.bytes ?? 0) : 0 };
}

/**
 * Deletes the paths a delta reported as removed — a replica that keeps a deleted
 * bookmark file is not a replica.
 *
 * Every path is re-validated before it is deleted, and deletion is confined to
 * the cache directory. A path that escapes it is refused BY NAME rather than
 * skipped, because this is the one operation in the pipe that destroys data.
 */
export async function applyStateRemovals(opts: {
  cacheDir: string;
  paths: string[];
}): Promise<{ removed: string[]; refused: Array<{ path: string; reason: string }> }> {
  const root = resolve(opts.cacheDir);
  const removed: string[] = [];
  const refused: Array<{ path: string; reason: string }> = [];

  for (const raw of opts.paths ?? []) {
    const problem = stateFileProblem(raw);
    if (problem) {
      refused.push({ path: String(raw ?? ""), reason: problem });
      continue;
    }
    const target = resolve(join(root, normalizeRelPath(raw)));
    if (!target.startsWith(root + sep)) {
      refused.push({ path: raw, reason: "state_path_escapes_profile" });
      continue;
    }
    try {
      const info = await stat(target).catch(() => null);
      if (!info) {
        // Already absent. Reported by name so device/manifest drift becomes
        // visible instead of silent.
        refused.push({ path: raw, reason: "state_remove_not_found" });
        continue;
      }
      await rm(target, { force: true });
      removed.push(raw);
    } catch (e) {
      refused.push({ path: raw, reason: `state_remove_failed: ${e instanceof Error ? e.message : "unknown"}` });
    }
  }
  return { removed, refused };
}

/**
 * What the cache currently holds, as a fingerprint list.
 *
 * The cache IS the replica's state, so this is also the manifest to store as the
 * next baseline. Reading it back rather than trusting the manifest the device sent
 * means a file that failed to stage can never be recorded as transferred — which
 * would make the NEXT clone skip it and lose it for good.
 *
 * ============================================================================
 * WHY EVERY FILE IS HASHED HERE, WHICH IS EXPENSIVE AND STILL RIGHT.
 * ============================================================================
 *
 * The planner compares two fingerprints with the hash when BOTH sides carry one,
 * and with size+mtime otherwise (lib/clone-sync-plan.ts `sameFile`). A staged file
 * is written when it arrives, so its mtime is a SERVER clock value that can never
 * equal the source's — meaning a size+mtime comparison would declare every cached
 * file "changed" and the device would be asked for the whole profile again. That
 * is not just wasteful: it is the reason a transfer bigger than one device command
 * could never finish, because each run would start over instead of continuing.
 *
 * With the hash on both sides the comparison is about CONTENT, an already-landed
 * file is recognised, and a run that was cut short is completed by asking for
 * exactly the files that are still missing. The cost is one read of the cache,
 * on the server, at plan time — no work on the work PC.
 *
 * A file that cannot be read or hashed keeps its size+mtime entry rather than
 * being dropped: dropping it would claim the cache does not hold a file it does,
 * and the device would be asked to send it forever.
 */
export async function fingerprintCache(cacheDir: string): Promise<FileFingerprint[]> {
  const out: FileFingerprint[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(abs).catch(() => null);
      if (!info) continue;
      const digest = await hashFile(abs);
      out.push({
        path: rel,
        size: info.size,
        mtime: Math.floor(info.mtimeMs / 1000),
        ...(digest ? { sha256: digest } : {}),
      });
    }
  };
  await walk(resolve(cacheDir), "");
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The file's SHA-256, or null when it cannot be read. Never throws.
 *
 * Streamed, not slurped: a fingerprint pass runs over the whole cache, and the
 * largest carried files (a History database, an extension bundle) are exactly the
 * ones that must not be loaded into memory to be compared.
 */
async function hashFile(abs: string): Promise<string | null> {
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(abs)) hash.update(chunk as Buffer);
    return hash.digest("hex");
  } catch {
    return null;
  }
}

export { SYNC_MODE_DELTA, SYNC_MODE_FULL };

