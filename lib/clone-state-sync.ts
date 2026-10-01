// TASK_135 §6.2 — the platform end of the state pipe: ask a device to carry its
// browser profile's state to the clone.
//
// WHERE THIS SITS. The device command (`hack-browser-clone.exe sync-state`) reads
// the profile and POSTs it to `/api/devices/clone-state`, which stages it into the
// target's cache and records the decision on the clone job. So this module does
// NOT transfer anything itself — it starts the device half and reads back the
// counts-only line it prints. The authority for what was transferred is the
// server's own cache, never this reply.
//
// WHY SYNCHRONOUSLY, WITH A BOUNDED WAIT. The device's own run-command path caps
// a command at 90 seconds, and a whole profile can take longer than that. So one
// call here drives SEVERAL bounded device commands: the device is told to spend
// less than the command timeout SENDING (--budget) and to report how many files
// are still outstanding, and each following command is a delta over what already
// landed. The loop is bounded by rounds AND by wall clock, so a clone's advance
// path is never held open indefinitely. Whatever is still outstanding when the
// budget runs out is reported as a pending count on the job — visible, and
// continued by the next clone or by the console's own re-sync button — never
// described as a completed sync.
//
// NO SECRET CROSSES THIS BOUNDARY. The device reads its own token from its config
// file; nothing here builds a command line containing a token, so none of it can
// end up in a process listing or in the record of what was run.

import "server-only";

import { runCommandNow } from "./device-tools";
import {
  DEVICE_COMMAND_MAX_SECONDS,
  buildStateSyncCommand,
  parseStateSyncOutput,
  type StateSyncReply,
} from "./clone-state-sync-format";

// The PURE half of this pipe — the command, the reply parser and the operator's
// one-line summary — lives in lib/clone-state-sync-format.ts, which is importable
// by tests. Everything below runs a device command, which is why THIS module is
// `server-only` and that one is not.
export {
  CLONE_STATE_EXE,
  DEVICE_COMMAND_MAX_SECONDS,
  STATE_SYNC_BROWSERS,
  buildStateSyncCommand,
  parseStateSyncOutput,
  stateSyncSummary,
  type StateSyncReply,
} from "./clone-state-sync-format";

/**
 * How many times one platform call will ask the device to continue.
 *
 * Bounded on purpose: each round is a full device command (up to
 * DEVICE_COMMAND_MAX_SECONDS), and this runs inside a clone's advance path. Three
 * rounds covers a first clone of a real profile over an ordinary office uplink,
 * and whatever is still outstanding afterwards is a delta the next clone — or the
 * console's own "Sync profile state" — completes without re-sending anything.
 */
export const STATE_SYNC_MAX_ROUNDS = 3;

/**
 * The wall-clock ceiling for one platform call, across all rounds. Reached first
 * when the device is answering slowly, in which case stopping is better than
 * holding a clone's advance open.
 */
export const STATE_SYNC_DEADLINE_MS = 150_000;

export interface StateSyncRequest {
  userId: string;
  deviceId: string;
  browser: string;
  /** Chromium profile directory name ("Default", "Profile 1"). */
  profileName?: string | null;
  cloneJobId?: string | null;
  timeoutSeconds?: number;
}

/**
 * Asks a device to carry its state, and reads back the counts-only reply.
 *
 * A command that cannot be built, a device that does not answer, and a reply that
 * is not the shape we expect are three SEPARATE named outcomes. Collapsing them
 * into "failed" is what makes a bug report useless — and this runs unattended, so
 * the name in the record is the only diagnostic anyone will ever get.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS LOOPS. A real profile does not fit in one device command. The command
 * is capped by the platform's own timeout, so the device is told to spend less
 * than that SENDING and to report what it did not get to (see the `--budget` flag
 * in buildStateSyncCommand). One call here therefore drives up to
 * STATE_SYNC_MAX_ROUNDS device commands, and every round after the first is cheap:
 * the server has already recorded the bytes that landed, so the next plan asks for
 * exactly what is still missing.
 *
 * The loop is bounded twice — by rounds AND by wall clock — because it runs inside
 * a clone's advance path and must never hold that open indefinitely. Stopping early
 * is not a failure: the reply says how many files are still outstanding, and the
 * next clone (or the console's own "Sync profile state") continues from where this
 * stopped without re-sending anything.
 *
 * An engine that predates `done` reports nothing about it, and is treated as
 * finished after one command — the old behaviour, unchanged, rather than a device
 * being asked to run forever.
 */
export async function requestDeviceStateSync(opts: StateSyncRequest): Promise<StateSyncReply> {
  const built = buildStateSyncCommand(opts);
  const base: StateSyncReply = {
    ok: false,
    browser: (opts.browser ?? "").trim().toLowerCase(),
    profile: (opts.profileName ?? "").trim() || "Default",
  };
  if (!built.ok) return { ...base, failed: built.error };

  const timeoutSeconds = Math.min(
    DEVICE_COMMAND_MAX_SECONDS,
    Math.max(5, Math.round(opts.timeoutSeconds ?? DEVICE_COMMAND_MAX_SECONDS)),
  );
  const startedAt = Date.now();

  // Totals across rounds: files that actually crossed the wire this call. skips,
  // removals and pending are taken from the LAST round instead, because each round
  // re-reports the same standing facts and summing them would multiply a count
  // that did not happen twice.
  let sent = 0;
  let bytes = 0;
  let rounds = 0;
  let last: StateSyncReply | null = null;

  for (let round = 1; round <= STATE_SYNC_MAX_ROUNDS; round++) {
    rounds = round;
    const outcome = await runStateSyncCommand({ userId: opts.userId, deviceId: opts.deviceId }, built.cmd, timeoutSeconds);
    if (!outcome.reply) {
      // The command did not produce a result line: either the device never ran it
      // (unreachable, refused) or it was killed. Reported by name with the
      // transport's own words alongside, because "which of those two" is the
      // first question anyone asks and the platform can answer it here.
      return {
        ...base,
        sent,
        bytes,
        rounds,
        failed: outcome.failed,
        ...(outcome.transport ? { transport: outcome.transport } : {}),
      };
    }
    last = outcome.reply;
    sent += last.sent ?? 0;
    bytes += last.bytes ?? 0;

    if (!last.ok) {
      // A refusal from the device is final — repeating it just repeats the
      // refusal. The named reason travels as-is.
      return { ...base, sent, bytes, rounds, failed: last.failed ?? "state_sync_device_refused" };
    }
    if (last.done !== false) break;
    if (round === STATE_SYNC_MAX_ROUNDS) break;
    if (Date.now() - startedAt >= STATE_SYNC_DEADLINE_MS) break;
  }

  const reply = last as StateSyncReply;
  return {
    ...reply,
    ok: true,
    sent,
    bytes,
    rounds,
  };
}

/**
 * One device command. Returns the parsed reply, or a NAMED failure with the
 * transport's own sanitised words when no result line came back.
 *
 * The two failures are kept apart on purpose: `state_sync_unreadable_reply` means
 * the device answered with something that is not a result (an engine older than
 * `sync-state`, or a command that never ran), while `state_sync_timeout` means the
 * transport itself gave up. They have different remedies, so they get different
 * names.
 */
async function runStateSyncCommand(
  opts: { userId: string; deviceId: string },
  cmd: string,
  timeoutSeconds: number,
): Promise<{ reply: StateSyncReply | null; failed: string; transport?: string }> {
  try {
    const res = await runCommandNow({
      userId: opts.userId,
      deviceId: opts.deviceId,
      cmd,
      shell: "powershell",
      timeoutSeconds,
      // ==========================================================================
      // AS THE INTERACTIVE USER, NOT AS SYSTEM — and this is not a preference.
      // ==========================================================================
      //
      // The profile being carried lives under the user's own AppData. Run from a
      // service context, `%LOCALAPPDATA%` is the SERVICE's profile, so the command
      // would either find nothing or find an empty profile and report a missing
      // one — on a machine whose real profile is full of history. The device's
      // locator (pkg/browser/source.go) now finds the real profile either way, but
      // running in the user's own session is still what makes the environment
      // right, the file ACLs readable without privilege tricks, and the result
      // match what the cookie capture does: lib/clone-transport.ts's capture is
      // documented as an interactive-session step for exactly this reason.
      runAsUser: true,
    });
    const reply = parseStateSyncOutput(res.output);
    if (!reply) {
      return { reply: null, failed: "state_sync_unreadable_reply" };
    }
    return { reply, failed: "" };
  } catch (err) {
    const detail = transportDetail(err);
    return { reply: null, failed: "state_sync_timeout", ...(detail ? { transport: detail } : {}) };
  }
}

/**
 * The transport's own error, reduced to something safe to store and show.
 *
 * Bounded and single-line: this lands in an audit detail and possibly in console
 * copy, and an upstream body (HTML, a stack trace) must never travel through
 * either. Returns null when there is nothing worth saying, so the caller can omit
 * the field rather than store an empty one.
 */
function transportDetail(err: unknown): string | null {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const clean = raw.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!clean) return null;
  if (/<!DOCTYPE|<html/i.test(clean)) return "upstream_html_reply";
  return clean;
}

