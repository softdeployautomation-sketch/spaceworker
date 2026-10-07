// TASK_135 §5 — the STATE half of a clone, on the HOST side.
//
// A clone carries two different things by two different routes:
//
//   - the SESSION (cookies): captured inside the browser on the work PC and
//     injected into the running clone over CDP — see lib/clone-live-capture.ts.
//   - the STATE (history, bookmarks, tabs, preferences, extensions): FILES, which
//     is what this module handles: staging them when they arrive, and
//     materialising them into the profile the container will mount.
//
// WHY FILES MUST BE FILTERED ON THIS SIDE TOO. The device decides what to send,
// but the receiving end does not get to trust that decision — the manifest and
// the payload both cross a trust boundary. So every path is re-checked with the
// SAME rules the device uses (lib/clone-sync-plan.ts's `cloneStatePathProblem`
// and `cloneStateExclusion`, kept in sync with the Go engine by
// scripts/check-clone-contract.mjs), and a refused path is reported with its
// reason rather than dropped quietly.
//
// NOTHING HERE TOUCHES THE WORK PC. It is all hosted-side filesystem work, and
// no part of it can raise anything a user of the work PC would see.
//
// Deliberately NOT marked `server-only`: this module is imported by server code
// only, but it must also be importable by its own tests (unlike the db-importing
// modules, it has no server-only dependency chain to protect).

import { chmod, copyFile, mkdir, readFile, readdir, stat, writeFile } from "fs/promises";
import { dirname, join, resolve, sep } from "path";

import { cloneStateExclusion, cloneStatePathProblem } from "./clone-sync-plan";

/** Chromium's primary profile directory name inside a user-data-dir. */
export const CLONE_PROFILE_NAME_DEFAULT = "Default";

/**
 * A profile directory name, as Chromium names them: `Default`, `Profile 1`,
 * `Profile 23`. Letters, digits, space, underscore, dash.
 */
const SAFE_PROFILE_NAME = /^[A-Za-z0-9 _-]{1,64}$/;

/**
 * Pure. The profile directory a manifest's state belongs in, or null when the
 * name could not be a profile directory at all.
 *
 * An ABSENT name resolves to `Default` rather than refusing: on a Chromium
 * source the primary profile really is `Default`, so refusing would fail a
 * perfectly good clone over a missing optional field. A name that looks like a
 * PATH (`../x`, `a/b`) is refused — that is not a missing field, that is an
 * attempt to place files somewhere else, and it must never be guessed at.
 */
export function normalizeProfileName(name: string | null | undefined): string | null {
  const raw = (name ?? "").trim();
  if (!raw) return CLONE_PROFILE_NAME_DEFAULT;
  if (raw === "." || raw === "..") return null;
  if (!SAFE_PROFILE_NAME.test(raw)) return null;
  return raw;
}

/**
 * Pure. A profile-relative path in the form the filesystem wants: forward
 * slashes, no drive prefix, no leading separator. Windows paths arrive with
 * backslashes, and the same file must land at the same place whichever spelling
 * the device used (the manifest's own comparison is case- and
 * separator-insensitive for exactly this reason).
 */
export function normalizeRelPath(relPath: string): string {
  return (relPath ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

/** Pure. Why this path must not be materialised, or null when it may be. */
export function stateFileProblem(relPath: string): string | null {
  const problem = cloneStatePathProblem(relPath);
  if (problem) return problem;
  const exclusion = cloneStateExclusion(relPath);
  if (exclusion) return exclusion;
  return null;
}

/**
 * Pure. True when a carried path is a Chromium session (tab) file, which is what
 * makes the `--restore-last-session` flag meaningful. Chromium keeps these in
 * `Sessions/Session_<ts>` and `Sessions/Tabs_<ts>`; older builds had a single
 * `Current Session` / `Current Tabs` pair at the profile root, and those are
 * matched too so an older source still restores.
 */
export function isSessionFilePath(relPath: string): boolean {
  const p = normalizeRelPath(relPath).toLowerCase();
  if (p.startsWith("sessions/")) return true;
  const base = p.slice(p.lastIndexOf("/") + 1);
  return base === "current session" || base === "current tabs" || base === "last session" || base === "last tabs";
}

/**
 * Modes for the materialised tree.
 *
 * These are the SAME broad modes the profile directory has carried since
 * 2026-09-04 (lib/browser-profiles.ts, live-verified): the container's browser
 * runs as an unprivileged in-container user whose uid is not this process's, so
 * a root-owned 0644 file is unreadable to it and Chromium crash-loops. The
 * directory is per-job and path-asserted, and browser-server's own start path
 * already normalises the whole tree the same way, so nothing here widens what
 * the profile already exposes.
 */
const PROFILE_FILE_MODE = 0o666;
const PROFILE_DIR_MODE = 0o777;

export interface StageResult {
  ok: boolean;
  error?: string;
  bytes?: number;
}

/**
 * Writes ONE inbound state file into the staging area.
 *
 * Paths are PROFILE-relative (`History`, `Sessions/Session_123`), matching the
 * manifest the device produced, and the profile directory they ultimately belong
 * in is applied at materialisation time from the same manifest's `profile`
 * field. Staging deliberately does NOT bake the profile name in, so a transfer
 * can proceed before that field is known and the tree stays a faithful copy of
 * the source profile.
 */
export async function stageIncomingFile(opts: {
  stagingDir: string;
  relPath: string;
  content: Buffer;
}): Promise<StageResult> {
  if (opts.content.length === 0) {
    return { ok: false, error: "state_file_empty" };
  }
  const problem = stateFileProblem(opts.relPath);
  if (problem) {
    return { ok: false, error: problem };
  }
  const root = resolve(opts.stagingDir);
  const dest = resolve(join(root, normalizeRelPath(opts.relPath)));
  if (!dest.startsWith(root + sep)) {
    return { ok: false, error: "state_path_escapes_profile" };
  }
  try {
    await mkdir(dirname(dest), { recursive: true });
    await chmod(dirname(dest), PROFILE_DIR_MODE).catch(() => {});
    await writeFile(dest, opts.content, { mode: PROFILE_FILE_MODE });
  } catch (e) {
    return { ok: false, error: `state_write_failed: ${e instanceof Error ? e.message : "unknown"}` };
  }
  return { ok: true, bytes: opts.content.length };
}

interface StagedEntry {
  /** Profile-relative, forward-slashed. */
  rel: string;
  abs: string;
  size: number;
  regular: boolean;
}

/**
 * Every file in the staged tree, in a deterministic order.
 *
 * Only REGULAR files are ever materialised. A symlink in a staged tree could
 * point anywhere on the host, and a device has no legitimate reason to send one —
 * but such an entry is REPORTED (as a skip, with a reason) rather than ignored,
 * because "nothing is skipped silently" is the whole contract of this half.
 */
async function listStaged(dir: string, prefix = ""): Promise<StagedEntry[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: StagedEntry[] = [];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await listStaged(abs, rel)));
      continue;
    }
    const info = await stat(abs).catch(() => null);
    out.push({ rel, abs, size: info?.size ?? 0, regular: entry.isFile() });
  }
  return out;
}

export interface MaterializeResult {
  ok: boolean;
  error?: string;
  profileName: string;
  copied: number;
  bytes: number;
  /** Every file refused, with a reason. Nothing is skipped silently. */
  skipped: Array<{ path: string; reason: string }>;
  /**
   * True when a Chromium session (tab) file was carried. This is what makes
   * `--restore-last-session` an honest flag: the caller sets it from THIS, never
   * from a hope that tabs came across.
   */
  tabsStaged: boolean;
  /** True when Preferences was rewritten so Chromium offers the tab restore. */
  restoreNudged: boolean;
}

/**
 * Copies the staged state into the profile the container is about to mount.
 *
 * Called AFTER the profile directory exists and BEFORE the container starts —
 * there is no window in between, which is why a restored profile is never
 * half-written by a browser that got there first.
 *
 * Every file is re-validated here (see the module header), and every refusal is
 * reported. A path that fails validation is not a reason to abandon the clone:
 * the rest of the state is still worth carrying, and the caller records both the
 * count and the reasons.
 */
export async function materializeCloneState(opts: {
  stagingDir: string;
  profileDir: string;
  profileName?: string | null;
}): Promise<MaterializeResult> {
  const profileName = normalizeProfileName(opts.profileName);
  const empty: MaterializeResult = {
    ok: false,
    profileName: profileName ?? "",
    copied: 0,
    bytes: 0,
    skipped: [],
    tabsStaged: false,
    restoreNudged: false,
  };
  if (profileName === null) {
    // Guessing would scatter a profile's files into a directory Chromium would
    // never read, which looks exactly like "the clone worked but my tabs are
    // gone" — the failure this feature exists to remove.
    return { ...empty, error: "state_profile_unknown" };
  }

  const profileRoot = resolve(join(resolve(opts.profileDir), profileName));
  const entries = await listStaged(resolve(opts.stagingDir));
  const skipped: Array<{ path: string; reason: string }> = [];
  let copied = 0;
  let bytes = 0;
  let tabsStaged = false;

  for (const entry of entries) {
    if (!entry.regular) {
      skipped.push({ path: entry.rel, reason: "state_path_not_a_regular_file" });
      continue;
    }
    const problem = stateFileProblem(entry.rel);
    if (problem) {
      skipped.push({ path: entry.rel, reason: problem });
      continue;
    }
    const dest = resolve(join(profileRoot, normalizeRelPath(entry.rel)));
    if (!dest.startsWith(profileRoot + sep)) {
      skipped.push({ path: entry.rel, reason: "state_path_escapes_profile" });
      continue;
    }
    try {
      await mkdir(dirname(dest), { recursive: true });
      await chmod(dirname(dest), PROFILE_DIR_MODE).catch(() => {});
      await copyFile(entry.abs, dest);
      await chmod(dest, PROFILE_FILE_MODE).catch(() => {});
      copied++;
      bytes += entry.size;
      if (isSessionFilePath(entry.rel)) tabsStaged = true;
    } catch (e) {
      skipped.push({
        path: entry.rel,
        reason: `state_copy_failed: ${e instanceof Error ? e.message : "unknown"}`,
      });
    }
  }

  // Tabs only reopen if Chromium believes the previous exit was NOT clean. The
  // carried `Preferences` says whatever the source's last shutdown looked like,
  // so it is rewritten here — the one edit this module makes to a carried file,
  // and the reason a restored `Sessions/` directory does not show an empty
  // window. A Preferences that cannot be parsed is left ALONE rather than
  // overwritten with something invented: a malformed Preferences is a real
  // (if unusual) source state, and inventing one would be worse than not nudging.
  const restoreNudged = tabsStaged ? await nudgeSessionRestore(join(profileRoot, "Preferences")) : false;

  return { ok: true, profileName, copied, bytes, skipped, tabsStaged, restoreNudged };
}

/**
 * Sets the two fields that make Chromium offer the previous session's tabs.
 * Returns false when the file is missing or not the JSON object it should be —
 * never throws, because a nudge that cannot be applied must not fail the launch
 * that has already staged a correct profile.
 */
async function nudgeSessionRestore(preferencesPath: string): Promise<boolean> {
  const raw = await readFile(preferencesPath, "utf8").catch(() => null);
  if (raw === null) return false;
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return false;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return false;
  const root = doc as Record<string, unknown>;
  const profile =
    root.profile !== null && typeof root.profile === "object" && !Array.isArray(root.profile)
      ? (root.profile as Record<string, unknown>)
      : {};
  profile.exit_type = "Crashed";
  profile.exited_cleanly = false;
  root.profile = profile;
  try {
    await writeFile(preferencesPath, JSON.stringify(root), { mode: PROFILE_FILE_MODE });
  } catch {
    return false;
  }
  return true;
}


