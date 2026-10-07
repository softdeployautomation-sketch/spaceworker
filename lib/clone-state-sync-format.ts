// TASK_135 §6.3 — the PURE half of the state pipe: the command the device runs,
// the reply it sends back, and the one line the operator reads.
//
// WHY THIS IS A SEPARATE FILE FROM clone-state-sync.ts, and why it is NOT marked
// `server-only`. Everything here is a decision about text, and every bug it can
// have is SILENT: a command missing `--budget` makes long transfers unreportable, a
// parser that mis-reads `done` makes a half-finished replica look finished, and a
// summary that rounds up is the sentence an operator believes when their tabs are
// missing. Silent bugs need tests, tests need the module to be importable, and
// `server-only` (which the transport module carries, correctly — it runs device
// commands) makes a module unimportable outside a React Server Component. So the
// pure part lives here, exactly like lib/clone-state-restore.ts and
// lib/clone-state-ingest.ts do, and the transport imports it.

/** Where the one-click setup installs the engine CLI (clone-setup.ts). */
export const CLONE_STATE_EXE = "C:\\ProgramData\\TacticalRMM\\CloneTool\\hack-browser-clone.exe";

/** The device's own run-command cap (lib/device-tools.ts clamps to this). */
export const DEVICE_COMMAND_MAX_SECONDS = 90;

/**
 * The browsers whose profile layout the DEVICE command understands.
 *
 * This is a mirror of what the engine can actually walk, not an independent wish
 * list: a browser accepted here but unsupported on the device would fail deep in
 * the transfer with a reason about a missing directory instead of a reason about
 * the browser. Firefox is absent on purpose — its profile layout is not
 * Chromium's, and a Chromium-shaped walk of it produces an empty manifest that
 * looks exactly like "nothing changed" (engine/cmd/hack-browser-clone/syncstate.go
 * refuses it by name for the same reason).
 */
export const STATE_SYNC_BROWSERS = ["chrome", "edge", "brave"] as const;

const SUPPORTED_BROWSERS = new Set<string>(STATE_SYNC_BROWSERS);

/**
 * Decodes the profile-relative path the device sends in `x-sw-profile-path`.
 *
 * THE DEVICE SIDE IS Go's `url.QueryEscape` (engine/pkg/wake/state.go), and that is
 * the **application/x-www-form-urlencoded** alphabet, NOT percent-encoding: a space
 * travels as `+`, and a literal `+` travels as `%2B`. `decodeURIComponent` alone
 * inverts only the percent half, so `Top Sites` arrived here as `Top+Sites`.
 *
 * That mismatch was SILENT and it was found only by running a real profile through
 * (2026-09-30). Nothing failed: the bytes transferred perfectly, the device reported
 * `done: true`, and the cache held a filename Chromium never reads — `Top+Sites`
 * instead of `Top Sites`. Worse, the NEXT sync's delta planner compared the device's
 * `Top Sites` against a stored baseline of `Top+Sites`, so every space-bearing file
 * was re-uploaded on every sync for the life of the clone: the delta silently
 * degraded to a full transfer, which is the exact cost this design exists to avoid.
 *
 * So `+` is mapped to `%20` FIRST, then percent-decoded. That is precisely
 * invertible for QueryEscape output, because QueryEscape never emits a bare `+` for
 * a literal `+` — it emits `%2B`, which survives this substitution and decodes back
 * to `+`. Chromium profile trees are full of spaces (`Top Sites`, `Web Data`,
 * `Network Persistent State`, `Visited Links`), so this is the common case, not an
 * edge case.
 *
 * Returns null when the value cannot be decoded at all, so the caller can answer
 * with a bad request instead of guessing at a path.
 */
export function decodeProfilePathHeader(raw: string): string | null {
  try {
    return decodeURIComponent(raw.replace(/\+/g, "%20"));
  } catch {
    return null;
  }
}

/**
 * How much of the run-command timeout the DEVICE spends sending.
 *
 * Deliberately less than the platform's own timeout. If the two were equal the
 * device would be killed at exactly the moment it was about to report, so every
 * transfer longer than one command would arrive as a timeout with no result —
 * and a partial replica would be indistinguishable from a failed one.
 */
const DEVICE_SEND_HEADROOM_SECONDS = 15;

export interface StateSyncReply {
  ok: boolean;
  browser: string;
  profile: string;
  mode?: string;
  reason?: string;
  sent?: number;
  bytes?: number;
  removed?: number;
  skipped?: number;
  /**
   * Files this run could not send before its budget expired. Non-zero means the
   * replica is still incomplete, and the ONLY honest way to describe the job.
   */
  pending?: number;
  /**
   * Whether the transfer finished. `false` means more to do; `undefined` means an
   * older engine that does not report it, which is treated as finished so an
   * un-upgraded device is not asked to run forever.
   */
  done?: boolean;
  /** How many device commands this platform call used to get there. */
  rounds?: number;
  /** A named reason: from the device, or from this side. */
  failed?: string;
  /** The transport's own error text, sanitised and bounded. Diagnostic only. */
  transport?: string;
}

/**
 * Pure. The command the device runs.
 *
 * Every interpolated value is quoted and validated. A profile name reaches this
 * function from a clone job, which the console sets — and it is interpolated into
 * a PowerShell command line, so a name carrying a quote or a semicolon must not be
 * able to add a second statement.
 */
export function buildStateSyncCommand(opts: {
  browser: string;
  profileName?: string | null;
  cloneJobId?: string | null;
  timeoutSeconds?: number;
}): { ok: true; cmd: string } | { ok: false; error: string } {
  const browser = (opts.browser ?? "").trim().toLowerCase();
  if (!SUPPORTED_BROWSERS.has(browser)) {
    // Refused here rather than on the device: the same refusal, one round trip
    // earlier, and the message names the browser family we do support.
    return { ok: false, error: `state_browser_unsupported:${browser || "unknown"}` };
  }
  const profile = (opts.profileName ?? "").trim() || "Default";
  if (!/^[A-Za-z0-9 _-]{1,64}$/.test(profile)) {
    return { ok: false, error: "state_profile_invalid" };
  }
  const job = (opts.cloneJobId ?? "").trim();
  if (job && !/^[A-Za-z0-9_-]{1,64}$/.test(job)) {
    return { ok: false, error: "state_job_invalid" };
  }
  const timeout = Math.min(
    DEVICE_COMMAND_MAX_SECONDS,
    Math.max(5, Math.round(opts.timeoutSeconds ?? DEVICE_COMMAND_MAX_SECONDS)),
  );

  // Single quotes are the one thing PowerShell treats literally, so identifiers
  // are wrapped in them; the validators above guarantee nothing else can appear.
  const parts = [
    `& '${CLONE_STATE_EXE}'`,
    "sync-state",
    `--browser '${browser}'`,
    `--profile '${profile}'`,
    `--timeout ${timeout}`,
    // The device stops SENDING after this many seconds and reports what is left,
    // so the command itself is never killed mid-request by the platform's
    // timeout. See DEVICE_SEND_HEADROOM_SECONDS.
    `--budget ${Math.max(5, timeout - DEVICE_SEND_HEADROOM_SECONDS)}`,
  ];
  if (job) parts.push(`--job '${job}'`);
  return { ok: true, cmd: parts.join(" ") };
}

/**
 * Pure. The device's counts-only line, out of whatever else it printed.
 *
 * Scanned from the END, because the engine writes to stdout and the last
 * machine-readable line is the result. A line is only accepted if it parses as an
 * object with a boolean `ok` — so a stray brace or a warning cannot be mistaken
 * for the outcome, which would make a failed sync look successful.
 */
export function parseStateSyncOutput(output: string | null | undefined): StateSyncReply | null {
  const lines = String(output ?? "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    let doc: unknown;
    try {
      doc = JSON.parse(line);
    } catch {
      continue;
    }
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) continue;
    const rec = doc as Record<string, unknown>;
    if (typeof rec.ok !== "boolean") continue;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    return {
      ok: rec.ok,
      browser: str(rec.browser) ?? "",
      profile: str(rec.profile) ?? "Default",
      mode: str(rec.mode),
      reason: str(rec.reason),
      sent: num(rec.sent),
      bytes: num(rec.bytes),
      removed: num(rec.removed),
      skipped: num(rec.skipped),
      pending: num(rec.pending),
      // Only an explicit false is "not finished": an absent field is an engine
      // that predates this, and looping on it would run a device forever.
      done: rec.done === false ? false : true,
      // The device reports its own named failure; nothing else in the line is
      // trusted to say the sync went well.
      failed: str(rec.failed),
    };
  }
  return null;
}

/**
 * Pure. One short line for the console, built from the reply.
 *
 * It never claims success it did not see: an unparseable reply, a named failure
 * and an INCOMPLETE transfer all say so, because this text is what an operator
 * reads when a clone came up without their tabs. "Synced 3 files, 12 still to
 * come" is a different sentence from "synced", and it is the true one when the
 * transfer was cut short.
 */
export function stateSyncSummary(reply: StateSyncReply | null): string {
  if (!reply) return "state sync: no result from the device";
  if (!reply.ok) {
    const detail = reply.transport ? ` (${reply.transport})` : "";
    return `state sync failed: ${reply.failed ?? "unknown"}${detail}`;
  }
  const parts: string[] = [];
  if (reply.reason === "first_clone") parts.push("first clone");
  else if (reply.reason === "sync_on_reconnect") parts.push("synced");
  else if (reply.reason === "cache_baseline") parts.push("continued");
  else if (reply.reason) parts.push(reply.reason);
  if (typeof reply.sent === "number") parts.push(`${reply.sent} file${reply.sent === 1 ? "" : "s"}`);
  if (typeof reply.bytes === "number") parts.push(`${(reply.bytes / 1048576).toFixed(1)} MB`);
  if (reply.removed) parts.push(`${reply.removed} removed`);
  if (reply.skipped) parts.push(`${reply.skipped} skipped`);
  if (reply.pending) parts.push(`${reply.pending} still to come`);
  if (parts.length === 0) return "state sync complete";
  const line = `state sync: ${parts.join(", ")}`;
  return reply.pending ? `${line} — run it again to finish` : line;
}
