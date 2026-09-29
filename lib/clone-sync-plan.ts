// TASK_135 — first-time clone vs sync on reconnect (server side).
//
// The device can produce a manifest, but it must not be trusted to decide what to
// send: a device (or a bug, or a tampered agent) could claim "delta, nothing
// changed" and the replica would silently freeze. So the SERVER owns this
// decision, and it owns it twice over —
//
//   1. it is the side that holds the PREVIOUS manifest, so it is the only side
//      that can compute a delta at all; and
//   2. it re-enforces the sensitive-path and path-safety rules on the receiving
//      end, so a hostile manifest cannot get `Local State` (the ABE key store)
//      or `..\..\Windows\System32` copied into a clone.
//
// The rules mirror the device's Go package (michael/browser-clone/engine/pkg/wake,
// sync.go + sensitives.go). The duplication is deliberate: the two sides sit on
// opposite ends of a trust boundary, and a shared library would mean a single
// mistake disabling both. The constants below are the contract between them.
//
// The two flows it serves:
//
//   - FIRST-TIME CLONE — no usable previous manifest: everything is transferred,
//     mode "full", reason "first_clone". Cookies are captured as well.
//   - SYNC ON RECONNECT — a recent manifest for the same browser and profile:
//     only added/changed/removed files move, mode "delta", reason
//     "sync_on_reconnect". Cookies are captured in FULL every time, because they
//     are read in-process (milliseconds) and are the whole point of the session
//     carry; diffing them would need the old values kept somewhere, which the
//     contract forbids (TASK_119A A5).

export const SYNC_MODE_FULL = "full";
export const SYNC_MODE_DELTA = "delta";

export type SyncMode = typeof SYNC_MODE_FULL | typeof SYNC_MODE_DELTA;

/** Named reasons. A sync decision is never reported without one. */
export const SYNC_REASONS = {
  firstClone: "first_clone",
  syncOnReconnect: "sync_on_reconnect",
  manifestStale: "manifest_stale",
  browserChanged: "browser_changed",
  profileChanged: "profile_changed",
  versionChanged: "browser_version_changed",
  deviceChanged: "device_changed",
} as const;

export type SyncReason =
  | (typeof SYNC_REASONS)[keyof typeof SYNC_REASONS]
  /**
   * The receiving end refused a decision it had just computed (a delta with no
   * delta, or a delta asking for a path it excluded) and fell back to a full
   * transfer instead. The detail follows the colon so a logger can say WHY without
   * a second field — and the prefix keeps it from ever being mistaken for a normal
   * reason. Modelled as a real member of the type rather than cast into it: a
   * reasreason a caller cannot see is one they cannot handle.
   */
  | `sync_decision_invalid:${string}`;

/**
 * How long a stored manifest stays usable as a delta baseline. Beyond it a delta
 * is refused and a full transfer is done: a week of drift can rewrite a browsing
 * history database in place, and a delta against a stale fingerprint list would
 * silently omit that change — the one failure a replica must never have.
 */
export const MANIFEST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** A fingerprint is incapable of carrying user data: names, sizes, times only. */
export interface FileFingerprint {
  /** Relative to the profile root, so it is portable between the two machines. */
  path: string;
  size: number;
  /** Unix seconds. With size it is the fallback comparison. */
  mtime: number;
  /** Optional. When both sides carry one it is authoritative. */
  sha256?: string;
}

export interface StateManifest {
  deviceId?: string;
  browser: string;
  version?: string;
  profile: string;
  /** ISO 8601. */
  capturedAt: string;
  files: FileFingerprint[];
}

export interface SyncDelta {
  added: FileFingerprint[];
  changed: FileFingerprint[];
  /** A replica must delete these, or it is no longer a replica. */
  removed: string[];
  unchanged: number;
}

export interface SyncDecision {
  mode: SyncMode;
  reason: SyncReason;
  delta?: SyncDelta;
  /** Stated on the decision so no caller has to infer it from the mode. */
  cookiesAlwaysFull: true;
  /**
   * The exact profile-relative paths the device is asked to send. Empty for a
   * full sync (the device sends everything it can read).
   */
  requestedPaths: string[];
  /** Every file refused, with a reason. Nothing is skipped silently. */
  excluded: Array<{ path: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// Sensitive files — never carried into a clone
// ---------------------------------------------------------------------------
//
// The state half must not become a second, useless and far more sensitive channel
// for what the CDP route already handles:
//
//   * Cookies / Cookies-journal — ABE-bound on Chrome/Edge/Brave 127+ (F10), and a
//     relocated profile has its rows deleted outright (F11). Carrying them moves a
//     credential file that can never be read on the destination. Cookies reach the
//     clone over CDP, which is the mechanism proven to work (F6).
//   * Login Data (+ variants, + journal) — password rows, ABE/DPAPI-bound. The
//     highest-value secret in a profile, and unusable in the clone.
//   * Local State — holds the App-Bound-Encryption key. It is the key to the first
//     two, so it is the worst of the three to move.
const CLONE_STATE_EXCLUSIONS: Record<string, string> = {
  cookies: "cookies_abe_bound_use_cdp",
  "cookies-journal": "cookies_abe_bound_use_cdp",
  "login data": "passwords_abe_bound_unusable_in_clone",
  "login data for account": "passwords_abe_bound_unusable_in_clone",
  "login data-journal": "passwords_abe_bound_unusable_in_clone",
  "login data for account-journal": "passwords_abe_bound_unusable_in_clone",
  "local state": "abe_key_store_never_transferred",
  "app_bound_encrypted_key": "abe_key_store_never_transferred",
  // Not a secret, but it carries signed-in identity metadata and no clone
  // feature needs it, so it is not carried. Kept identical to the device's
  // engine/pkg/wake/sensitives.go list — see scripts/check-clone-contract.mjs,
  // which fails if the two ever drift apart.
  "affiliation database": "unused_by_clone",
  "preferences-journal": "journal_transient",
  "secure preferences-journal": "journal_transient",
  // TASK_135 §3 — Chromium's own lock files. They are host-specific (a
  // SingletonLock is a link to `<hostname>-<pid>`), so carrying them is at best
  // noise and at worst a launch that refuses with "profile appears to be in use
  // by another Chromium process" on a machine where nothing is running. The
  // container scrub removes them at the profile root anyway; this rule makes
  // both ends agree that they are never part of a replica.
  singletonlock: "stale_browser_lock",
  singletoncookie: "stale_browser_lock",
  singletonsocket: "stale_browser_lock",
};

/** Lower-cased final path segment, treating either separator as a separator. */
function basename(p: string): string {
  const slashed = p.replace(/\\/g, "/");
  const idx = slashed.lastIndexOf("/");
  return (idx === -1 ? slashed : slashed.slice(idx + 1)).trim().toLowerCase();
}

/**
 * Returns the reason a path must not be carried, or null when it may be. Case
 * insensitive, and the BASENAME decides, so Chrome's `Network/Cookies` is caught
 * by the same rule as an older root-level `Cookies`.
 */
export function cloneStateExclusion(path: string): string | null {
  return CLONE_STATE_EXCLUSIONS[basename(path)] ?? null;
}

/**
 * Refuses a profile-relative path that escapes the profile root or names a
 * drive/UNC/absolute location. Enforced on the RECEIVING side: a manifest is a
 * device's description of what it would like copied, so it is untrusted input.
 * Returns a named reason, or null when the path is safe.
 */
export function cloneStatePathProblem(path: string): string | null {
  const raw = (path ?? "").trim();
  if (raw === "") return "state_path_empty";
  if (raw.includes("\u0000")) return "state_path_nul";

  const slashed = raw.replace(/\\/g, "/");
  // UNC first, purely so the reason names the real problem.
  if (slashed.startsWith("//")) return "state_path_unc";
  if (slashed.startsWith("/")) return "state_path_absolute";
  // A drive-relative form such as `C:History` is absolute in effect.
  if (slashed.length >= 2 && slashed[1] === ":") return "state_path_drive_relative";

  // Normalise the dot segments, then refuse anything that ends up outside.
  const parts: string[] = [];
  for (const segment of slashed.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return "state_path_escapes_profile";
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  if (parts.length === 0) return "state_path_empty";
  return null;
}

/**
 * Splits a manifest into what may be carried and what may not, each refusal with a
 * reason. Nothing is dropped silently: the caller accounts for every file.
 */
export function filterCloneStateFiles(files: FileFingerprint[]): {
  kept: FileFingerprint[];
  excluded: Array<{ path: string; reason: string }>;
} {
  const kept: FileFingerprint[] = [];
  const excluded: Array<{ path: string; reason: string }> = [];
  for (const f of files ?? []) {
    const problem = cloneStatePathProblem(f?.path ?? "");
    if (problem) {
      excluded.push({ path: String(f?.path ?? ""), reason: problem });
      continue;
    }
    const reason = cloneStateExclusion(f.path);
    if (reason) {
      excluded.push({ path: f.path, reason });
      continue;
    }
    kept.push(f);
  }
  return { kept, excluded };
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

/** Case-insensitive, separator-insensitive key: Windows paths are one file. */
function normalizePath(p: string): string {
  return (p ?? "").trim().replace(/\\/g, "/").toLowerCase();
}

/**
 * Keeps the LAST fingerprint per path and sorts, so a device that scanned a file
 * twice — or a manifest that arrived reordered — cannot make the plan flap.
 */
function dedupe(files: FileFingerprint[]): FileFingerprint[] {
  const byPath = new Map<string, FileFingerprint>();
  for (const f of files ?? []) {
    const key = normalizePath(f?.path ?? "");
    if (!key) continue;
    byPath.set(key, f);
  }
  return [...byPath.values()].sort((a, b) => (normalizePath(a.path) < normalizePath(b.path) ? -1 : 1));
}

/**
 * Whether a file needs transferring.
 *
 * A hash WINS whenever both sides carry one, and it is checked FIRST. Size+mtime
 * is only the fallback, because in practice it is wrong in both directions:
 * Chrome rewrites files at every launch without changing them (mtime moves, so
 * size+mtime re-sends the whole profile), and a rewrite can preserve both size and
 * mtime (so size+mtime misses a real change).
 */
function sameFile(a: FileFingerprint, b: FileFingerprint): boolean {
  if (a.sha256 && b.sha256) return a.sha256.toLowerCase() === b.sha256.toLowerCase();
  return a.size === b.size && a.mtime === b.mtime;
}

/** What a reconnect actually has to send. Either side may be empty. */
export function diffManifests(prev: FileFingerprint[], next: FileFingerprint[]): SyncDelta {
  const previous = dedupe(prev);
  const current = dedupe(next);
  const byPath = new Map(previous.map((f) => [normalizePath(f.path), f]));

  const delta: SyncDelta = { added: [], changed: [], removed: [], unchanged: 0 };
  for (const f of current) {
    const old = byPath.get(normalizePath(f.path));
    if (!old) {
      delta.added.push(f);
      continue;
    }
    if (sameFile(old, f)) {
      delta.unchanged += 1;
      continue;
    }
    delta.changed.push(f);
  }

  const present = new Set(current.map((f) => normalizePath(f.path)));
  for (const f of previous) {
    if (!present.has(normalizePath(f.path))) delta.removed.push(f.path);
  }
  delta.removed.sort();
  return delta;
}

/** Transfer size of a delta. Removals cost nothing to send. */
export function deltaBytes(delta: SyncDelta): number {
  let total = 0;
  for (const f of delta.added) total += f.size;
  for (const f of delta.changed) total += f.size;
  return total;
}

/**
 * True when nothing has to move. The caller can then skip the transfer entirely
 * and go straight to cookie injection — the fastest possible reconnect.
 */
export function isDeltaEmpty(delta: SyncDelta): boolean {
  return delta.added.length === 0 && delta.changed.length === 0 && delta.removed.length === 0;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export interface PlanSyncOptions {
  /** Injected so the staleness rule is testable without waiting a week. */
  now?: Date;
  /** Overrides MANIFEST_MAX_AGE_MS. */
  maxAgeMs?: number;
}

function majorVersion(version: string | undefined): number {
  const m = /^(\d+)/.exec((version ?? "").trim());
  return m ? Number(m[1]) : 0;
}

/**
 * Decides between a first-time clone and a sync on reconnect.
 *
 * A delta is only used when the stored manifest is genuinely usable for THIS
 * device, browser and profile. Everything else is a full transfer with a named
 * reason, because a delta against the wrong baseline is how a replica silently
 * loses data.
 */
export function planSync(
  prev: StateManifest | null | undefined,
  next: StateManifest,
  options: PlanSyncOptions = {},
): SyncDecision {
  const now = options.now ?? new Date();
  const maxAgeMs = options.maxAgeMs && options.maxAgeMs > 0 ? options.maxAgeMs : MANIFEST_MAX_AGE_MS;

  // Sensitive and unsafe paths are refused whichever mode is chosen — this is the
  // receiving end, so it does not get to trust the manifest it was handed.
  const { kept, excluded } = filterCloneStateFiles(next?.files ?? []);

  const full = (reason: SyncReason): SyncDecision => ({
    mode: SYNC_MODE_FULL,
    reason,
    cookiesAlwaysFull: true,
    // A full sync sends everything readable, so there is nothing to enumerate.
    requestedPaths: [],
    excluded,
  });

  if (!prev || (prev.files ?? []).length === 0) return full(SYNC_REASONS.firstClone);

  // The baseline must describe the same thing we are about to sync.
  const prevDevice = (prev.deviceId ?? "").trim();
  const nextDevice = (next.deviceId ?? "").trim();
  if (prevDevice && nextDevice && prevDevice !== nextDevice) return full(SYNC_REASONS.deviceChanged);
  if ((prev.browser ?? "").toLowerCase() !== (next.browser ?? "").toLowerCase()) {
    return full(SYNC_REASONS.browserChanged);
  }
  if ((prev.profile ?? "").toLowerCase() !== (next.profile ?? "").toLowerCase()) {
    return full(SYNC_REASONS.profileChanged);
  }
  const prevMajor = majorVersion(prev.version);
  const nextMajor = majorVersion(next.version);
  // A major upgrade reshapes the profile (new stores, moved files), so a delta
  // computed across it would hunt for paths that no longer exist.
  if (prevMajor !== 0 && nextMajor !== 0 && prevMajor !== nextMajor) {
    return full(SYNC_REASONS.versionChanged);
  }

  const captured = Date.parse(prev.capturedAt ?? "");
  if (Number.isNaN(captured)) return full(SYNC_REASONS.firstClone);
  if (now.getTime() - captured > maxAgeMs) return full(SYNC_REASONS.manifestStale);

  // The stored manifest is filtered too: a sensitive path that was accepted once
  // (before this rule existed) must never be resurrected as a baseline.
  const { kept: previousKept } = filterCloneStateFiles(prev.files ?? []);
  const delta = diffManifests(previousKept, kept);
  const requestedPaths = [...delta.added, ...delta.changed].map((f) => f.path);

  return {
    mode: SYNC_MODE_DELTA,
    reason: SYNC_REASONS.syncOnReconnect,
    delta,
    cookiesAlwaysFull: true,
    requestedPaths,
    excluded,
  };
}

/**
 * Rejects a decision that could under-send: a delta with no computed delta would
 * transfer nothing and look like it worked, and a full sync carrying one would
 * make the two modes ambiguous.
 */
export function validateSyncDecision(decision: SyncDecision): string | null {
  if (decision.mode === SYNC_MODE_FULL) {
    if (decision.delta) return "sync_full_carries_a_delta";
  } else if (decision.mode === SYNC_MODE_DELTA) {
    if (!decision.delta) return "sync_delta_missing_delta";
  } else {
    return `sync_mode_unknown:${String(decision.mode)}`;
  }
  if (!decision.reason) return "sync_reason_missing";
  if (decision.cookiesAlwaysFull !== true) return "sync_cookies_rule_missing";
  // A delta must never ask for a path it refused to carry.
  const refused = new Set(decision.excluded.map((e) => normalizePath(e.path)));
  for (const p of decision.requestedPaths) {
    if (refused.has(normalizePath(p))) return `sync_requests_excluded_path:${p}`;
  }
  return null;
}
