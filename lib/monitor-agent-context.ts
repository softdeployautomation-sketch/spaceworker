import "server-only";

import { db } from "./db";
import { listRecentFrames } from "./device-screenshots";

// ---------------------------------------------------------------------------
// TASK_152 M7 — the user's screen-monitoring summaries, as AGENT CONTEXT.
// ---------------------------------------------------------------------------
//
// The owner's end goal: "talking to the agent who got all context of the user's
// summaries." This module assembles the block of the user's OWN monitor
// summaries that lib/agent.ts folds into the ONE system message of an agent
// turn — the SAME mechanism the floating widget's `pageContext` already uses
// (see runAgentTurn). It does not invent a second context channel, and the agent
// still reaches the model through the one metered call in lib/agent.ts.
//
// THREE THINGS THIS MODULE IS DELIBERATELY NOT:
//
//   1. NOT a second store of summaries. It reads the SAME DeviceScreenshot.summary
//      rows the Screen monitoring tab shows, through the SAME read helper that
//      tab uses (listRecentFrames) — so the agent can never see a summary the
//      owner cannot, and the two can never drift.
//   2. NOT a new AI call. It performs plain indexed reads and returns text; the
//      text rides out on the turn's existing (metered) relay call, so nothing
//      here can spend past the per-user daily cap — lib/agent.ts builds this
//      only AFTER the cap gate has already passed.
//   3. NOT a capability. It is READ-ONLY. It hands the agent no tool, no
//      proposal and no device authority of any kind (TASK_152 §7 / M8 are out of
//      scope): it can talk about what was on screen, it still cannot start,
//      stop, pause or change monitoring, or control a device.
//
// SCOPE is the consent boundary itself: only devices that are the caller's OWN
// and that have screen monitoring opted IN are read. A device with monitoring
// off, or another user's device, is never visible to the agent.

/** At most this many of the user's devices appear in one turn's context. */
export const MONITOR_CONTEXT_MAX_DEVICES = 5;

/** At most this many of a device's most recent summaries appear, newest first. */
export const MONITOR_CONTEXT_MAX_FRAMES_PER_DEVICE = 5;

/**
 * A hard character ceiling on the whole block. Context is paid for on EVERY
 * turn, so it must be bounded regardless of how many devices/frames a user has.
 * ~1800 chars is a few hundred tokens — a rounding error next to the turn itself,
 * and small enough that a heavy user cannot inflate every future prompt.
 */
export const MONITOR_CONTEXT_MAX_CHARS = 1800;

/**
 * How many of a device's recent frames are examined to find ones that carry a
 * summary. A frame is only summarised a little later than it is captured, so the
 * newest frames can legitimately have no summary yet; looking a few deeper finds
 * the real ones without scanning the whole retention window.
 */
const FRAMES_SCANNED_PER_DEVICE = MONITOR_CONTEXT_MAX_FRAMES_PER_DEVICE * 4;

/**
 * Devices examined before the per-turn device cap is applied. Bounded so a user
 * with hundreds of devices cannot turn one turn's context read into an
 * unbounded scan; generous enough that a few opted-in devices with no summaries
 * yet never hide a device that does have them.
 */
const DEVICES_SCANNED = MONITOR_CONTEXT_MAX_DEVICES * 5;

/**
 * The header every block starts with. It states, in-band, that the summaries are
 * the user's own, that they are READ-ONLY, and that the agent has no device
 * authority — the prompt repeats this, but a model reads the last thing it is
 * given most closely, so the line lives here too.
 */
const MONITOR_CONTEXT_HEADER =
  "Monitor summaries — recent screen-activity summaries from this user's OWN " +
  "opted-in devices (READ-ONLY context: you cannot start, stop, pause or change " +
  "screen monitoring, and you cannot control, wake or act on any device):";

export interface MonitorContextFrame {
  /** ISO timestamp of the frame whose summary this is. */
  at: string;
  summary: string;
}

export interface MonitorContextDevice {
  deviceId: string;
  deviceName: string;
  frames: MonitorContextFrame[];
}

/**
 * The user's own opted-in devices, each with up to
 * MONITOR_CONTEXT_MAX_FRAMES_PER_DEVICE of its most recent summaries (newest
 * first). Read-only: two plain reads (devices, then frames per device).
 *
 * A device that has no summarised frames is simply absent from the result — a
 * frame with no summary is the NORMAL state (see DeviceScreenshot's summary
 * comment), never an error.
 */
export async function collectMonitorSummaries(userId: string): Promise<MonitorContextDevice[]> {
  const devices = await db.device.findMany({
    where: { userId, screenshotMonitoringEnabled: true },
    orderBy: { createdAt: "asc" },
    take: DEVICES_SCANNED,
    select: { id: true, name: true },
  });

  const out: MonitorContextDevice[] = [];
  for (const device of devices) {
    // REUSE the monitoring tab's own read model rather than re-deriving a
    // summary shape — the agent sees exactly what the owner sees.
    const frames = await listRecentFrames(device.id, FRAMES_SCANNED_PER_DEVICE);
    const withSummary: MonitorContextFrame[] = [];
    for (const frame of frames) {
      if (!frame.summary) continue;
      withSummary.push({
        at: frame.capturedAt ?? frame.createdAt,
        summary: frame.summary,
      });
      if (withSummary.length >= MONITOR_CONTEXT_MAX_FRAMES_PER_DEVICE) break;
    }
    if (withSummary.length === 0) continue;
    out.push({ deviceId: device.id, deviceName: device.name, frames: withSummary });
    if (out.length >= MONITOR_CONTEXT_MAX_DEVICES) break;
  }
  return out;
}

/** One summary must stay on one line — a newline in it would forge a fake entry. */
function onOneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Render collected summaries into the block folded into the system message, or
 * `null` when there is nothing to say (no monitored devices, or none summarised
 * yet). Pure, so the exact text a turn will carry is directly testable.
 *
 * A device header is only emitted once at least one of its lines fits, so a
 * truncated block never shows an empty "Device "X":" with nothing under it.
 */
export function formatMonitorContext(entries: MonitorContextDevice[]): string | null {
  if (entries.length === 0) return null;

  const lines: string[] = [MONITOR_CONTEXT_HEADER];
  let used = MONITOR_CONTEXT_HEADER.length;
  let omitted = 0;

  for (const device of entries) {
    const deviceLine = `Device "${onOneLine(device.deviceName)}":`;
    let deviceOpen = false;
    for (const frame of device.frames) {
      const line = `  - ${frame.at}: ${onOneLine(frame.summary)}`;
      // Reserve 24 chars for a possible trailing "(+N more summaries not shown)".
      const extra = (deviceOpen ? 0 : deviceLine.length + 1) + line.length + 1;
      if (used + extra + 24 > MONITOR_CONTEXT_MAX_CHARS) {
        omitted += 1;
        continue;
      }
      if (!deviceOpen) {
        lines.push(deviceLine);
        used += deviceLine.length + 1;
        deviceOpen = true;
      }
      lines.push(line);
      used += line.length + 1;
    }
  }

  if (omitted > 0) lines.push(`  (+${omitted} more summaries not shown)`);
  const block = lines.join("\n");
  // Belt-and-braces: the arithmetic above keeps us under the ceiling, but never
  // emit a block larger than the declared bound even if that ever changes.
  return block.length > MONITOR_CONTEXT_MAX_CHARS ? block.slice(0, MONITOR_CONTEXT_MAX_CHARS) : block;
}

/**
 * The block an agent turn folds into its single system message, or `null` when
 * this user has no monitor summaries to share. Reads only — see the module note.
 */
export async function buildMonitorSummaryContext(userId: string): Promise<string | null> {
  return formatMonitorContext(await collectMonitorSummaries(userId));
}

