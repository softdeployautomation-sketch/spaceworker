import "server-only";

import { db } from "./db";
import { env } from "./env";
import { notifyUser } from "./notify";

// ---------------------------------------------------------------------------
// TASK_152 M5 — screen-monitoring notifications: user-defined TRIGGERS and the
// periodic DIGEST.
// ---------------------------------------------------------------------------
//
// WHY THIS MODULE EXISTS: before M5 nothing ever notified for screen monitoring
// (TASK_152 G4). The M3 frame summaries made the screen READABLE; this is what
// makes it SPEAK. It deliberately adds NO new delivery channel and NO new log:
// both features fan out through the existing lib/notify.ts `notifyUser`, which
// already honours the user's own notifyEmail / notifyTelegram / notifyAgent
// preferences, and every send records on the existing NotificationLog (email →
// lib/email.ts, telegram → lib/telegram.ts, agent → lib/notify.ts itself). The
// periodic digest is modelled on lib/digest.ts (Task 92), down to the
// "unique key makes a re-fired sweep a no-op" idempotency.
//
// TWO FEATURES, TWO MASTER SWITCHES (both default FALSE — User.screenTrigger-
// NotificationsEnabled / User.screenDigestEnabled). A notification feature that
// switches itself on is how trust is lost, so nothing here fires until the owner
// turns it on for their account, and a per-trigger `enabled` flag is a second,
// narrower off switch beneath it.
//
// SCOPE OF TRIGGERS — TEXT/KEYWORD ONLY. This first version matches a keyword
// case-insensitively as a plain substring of the AI-written frame SUMMARY
// (the owner's own example: "the screen shows a balance"). There is NO visual
// matching, NO OCR-side object detection, and NO complex/multi-condition event
// logic here — those are explicitly out of scope for this version and are called
// out as such in the writeup rather than half-built.
//
// INDEPENDENCE: like the summary pass, nothing here can fail a capture. A
// trigger/digest error is contained by the sweep route's per-user try/catch.

// ---------------------------------------------------------------------------
// Bounds and defaults (all overridable at the API edge, all enforced here too)
// ---------------------------------------------------------------------------

/** Default gap between two firings of the same trigger on the same device. */
export const SCREEN_TRIGGER_DEFAULT_COOLDOWN_MINUTES = 120;
/** A trigger that fires faster than once a minute is a spam cannon. */
export const SCREEN_TRIGGER_MIN_COOLDOWN_MINUTES = 1;
/** Cooldown never needs to exceed a day. */
export const SCREEN_TRIGGER_MAX_COOLDOWN_MINUTES = 1440;
/** Longest keyword we accept — a "keyword" the length of an essay is not one. */
export const SCREEN_TRIGGER_MAX_KEYWORD_LENGTH = 120;

/** Default digest cadence: every 2 hours, the owner's own example. */
export const SCREEN_DIGEST_DEFAULT_INTERVAL_MINUTES = 120;
export const SCREEN_DIGEST_MIN_INTERVAL_MINUTES = 15;
export const SCREEN_DIGEST_MAX_INTERVAL_MINUTES = 1440;

/** How many un-evaluated frames one trigger pass will look at. */
export const SCREEN_TRIGGER_PASS_FRAME_LIMIT = 500;

/** The event types recorded on every NotificationLog row these features write. */
export const SCREEN_TRIGGER_EVENT_TYPE = "screen_trigger";
export const SCREEN_DIGEST_EVENT_TYPE = "screen_digest";

// ---------------------------------------------------------------------------
// Pure helpers (exported so a test can pin the exact matching/cooldown rule)
// ---------------------------------------------------------------------------

/**
 * The WHOLE trigger rule, in one place: a keyword matches a frame summary when it
 * appears as a case-insensitive substring. Deliberately NOT a regex — a
 * user-supplied regex is a cost/ReDoS foot-gun that buys nothing for "the screen
 * shows a balance". A blank keyword matches nothing (never everything).
 */
export function matchTriggerKeyword(summary: string | null, keyword: string): boolean {
  if (!summary) return false;
  const needle = keyword.trim().toLowerCase();
  if (needle.length === 0) return false;
  return summary.toLowerCase().includes(needle);
}

/** True when `cooldownMinutes` have elapsed since `lastFiredAt`. */
export function cooldownElapsed(
  lastFiredAt: Date | null,
  cooldownMinutes: number,
  now: Date,
): boolean {
  if (!lastFiredAt) return true; // never fired => not in cooldown
  return now.getTime() - lastFiredAt.getTime() >= cooldownMinutes * 60 * 1000;
}

/** Floor `now` to the nearest whole digest interval boundary (UTC epoch based). */
export function digestWindowEnd(now: Date, intervalMinutes: number): Date {
  const intervalMs = intervalMinutes * 60 * 1000;
  return new Date(Math.floor(now.getTime() / intervalMs) * intervalMs);
}

/** The label shown in a notification for a trigger: its own label, else keyword. */
export function triggerDisplayName(trigger: { label: string | null; keyword: string }): string {
  const label = trigger.label?.trim();
  return label && label.length > 0 ? label : trigger.keyword;
}

// ---------------------------------------------------------------------------
// Trigger pass
// ---------------------------------------------------------------------------

export interface TriggerPassResult {
  /** Frames whose summary was checked this pass. */
  scanned: number;
  /** Notification deliveries actually attempted (one per trigger/device match). */
  fired: number;
  results: Array<{
    frameId: string;
    deviceId: string;
    triggerId: string;
    keyword: string;
    status: "fired" | "cooldown";
  }>;
}

interface EvaluatableFrame {
  id: string;
  deviceId: string;
  userId: string;
  summary: string | null;
}

/**
 * Claim a firing of (trigger, device) for `now`, honouring the cooldown.
 *
 * Claim-then-fire, not read-then-fire: the conditional `updateMany` only matches
 * a row whose `lastFiredAt` is already outside the cooldown, so two passes racing
 * on the same trigger/device cannot both win. A missing row is created (the very
 * first firing); if creation loses a race, the loser simply doesn't fire. Returns
 * true only when THIS call owns the firing.
 */
async function claimFiring(
  triggerId: string,
  deviceId: string,
  cooldownMinutes: number,
  now: Date,
): Promise<boolean> {
  const cutoff = new Date(now.getTime() - cooldownMinutes * 60 * 1000);
  const updated = await db.screenTriggerState.updateMany({
    where: { triggerId, deviceId, lastFiredAt: { lte: cutoff } },
    data: { lastFiredAt: now },
  });
  if (updated.count > 0) return true;

  const existing = await db.screenTriggerState.findUnique({
    where: { triggerId_deviceId: { triggerId, deviceId } },
    select: { id: true },
  });
  if (existing) return false; // present and still inside its cooldown

  try {
    await db.screenTriggerState.create({ data: { triggerId, deviceId, lastFiredAt: now } });
    return true;
  } catch {
    // Lost the create race to a concurrent pass — that pass owns the firing.
    return false;
  }
}

/**
 * Evaluate ONE frame against its owner's triggers and deliver any that fire.
 */
async function evaluateFrame(
  frame: EvaluatableFrame,
  now: Date,
  result: TriggerPassResult,
): Promise<void> {
  const user = await db.user.findUnique({
    where: { id: frame.userId },
    select: { screenTriggerNotificationsEnabled: true },
  });
  // Master switch OFF => this account asked for no screen alerts. Nothing fires;
  // the frame is still marked evaluated by the caller (no repeated work).
  if (!user?.screenTriggerNotificationsEnabled) return;

  const triggers = await db.screenTrigger.findMany({
    where: {
      userId: frame.userId,
      enabled: true,
      OR: [{ deviceId: null }, { deviceId: frame.deviceId }],
    },
    select: { id: true, keyword: true, label: true, cooldownMinutes: true },
  });

  for (const trigger of triggers) {
    if (!matchTriggerKeyword(frame.summary, trigger.keyword)) continue;

    const won = await claimFiring(trigger.id, frame.deviceId, trigger.cooldownMinutes, now);
    if (!won) {
      result.results.push({
        frameId: frame.id,
        deviceId: frame.deviceId,
        triggerId: trigger.id,
        keyword: trigger.keyword,
        status: "cooldown",
      });
      continue;
    }

    await deliverTriggerNotification(frame, trigger, now);
    result.fired += 1;
    result.results.push({
      frameId: frame.id,
      deviceId: frame.deviceId,
      triggerId: trigger.id,
      keyword: trigger.keyword,
      status: "fired",
    });
  }
}

/** Send one trigger notification through notifyUser (prefs honoured). */
async function deliverTriggerNotification(
  frame: EvaluatableFrame,
  trigger: { keyword: string; label: string | null },
  capturedAt: Date,
): Promise<void> {
  const device = await db.device.findUnique({
    where: { id: frame.deviceId },
    select: { name: true },
  });
  const deviceName = device?.name ?? "your device";
  const name = triggerDisplayName(trigger);
  const when = capturedAt.toISOString().replace("T", " ").slice(0, 16);

  const text =
    `🔎 Screen alert — "${name}"\n\n` +
    `${deviceName} showed text matching "${trigger.keyword}" at ${when} UTC.\n\n` +
    (frame.summary ? `What was on screen: ${frame.summary}` : "");

  await notifyUser(frame.userId, {
    eventType: SCREEN_TRIGGER_EVENT_TYPE,
    subject: `Screen alert: "${name}" on ${deviceName}`,
    emailHtml:
      `<p>Your screen-monitoring trigger <strong>${escapeHtml(name)}</strong> matched on ` +
      `<strong>${escapeHtml(deviceName)}</strong> at ${escapeHtml(when)} UTC.</p>` +
      `<p>Matched text: <code>${escapeHtml(trigger.keyword)}</code></p>` +
      (frame.summary ? `<p>What was on screen: ${escapeHtml(frame.summary)}</p>` : ""),
    telegramText: text,
    agentText: text,
    link: `${env.appBaseUrl}/console/${frame.deviceId}?tab=monitoring`,
  });
}

/**
 * Run the trigger pass once. Selects every frame that has a summary but has not
 * yet been checked against its owner's triggers (the `triggerEvaluatedAt` work
 * marker), evaluates each, then marks it evaluated — so a summary is examined
 * exactly once and the pass never re-scans yesterday's frames.
 */
export async function runTriggerPass(
  now: Date = new Date(),
  limit: number = SCREEN_TRIGGER_PASS_FRAME_LIMIT,
): Promise<TriggerPassResult> {
  const rows = await db.deviceScreenshot.findMany({
    where: { summary: { not: null }, triggerEvaluatedAt: null },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true, deviceId: true, userId: true, summary: true },
  });

  const result: TriggerPassResult = { scanned: 0, fired: 0, results: [] };
  for (const frame of rows) {
    result.scanned += 1;
    try {
      await evaluateFrame(frame, now, result);
    } catch (err) {
      // A single frame's failure must not stop the pass (and must not re-fire:
      // we still mark it evaluated below).
      console.error(`[screen-trigger] frame ${frame.id} failed:`, err);
    }
    await db.deviceScreenshot.update({
      where: { id: frame.id },
      data: { triggerEvaluatedAt: now },
    });
  }
  return result;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Periodic digest — "every N minutes, a summary of every monitored device"
// ---------------------------------------------------------------------------
//
// Modelled on lib/digest.ts: one rollup per (userId, windowStart), so a sweep
// that fires twice over the same window sends ONCE. Unlike the assistant digest,
// there is NO extra AI call here — the M3 summaries are already AI-written prose,
// so the digest is a plain aggregation of that existing text across ALL of the
// user's monitored devices for the window, in ONE message. That keeps the money
// bounded (the AI was paid once, at capture time) and makes the cadence a pure
// delivery choice rather than a new cost.

/** How many frame summaries one device contributes to a digest before we trim. */
export const SCREEN_DIGEST_SUMMARIES_PER_DEVICE = 6;

export interface ScreenDigestResult {
  status: "generated" | "already_done" | "skipped";
  reason?: string;
  rollupId?: string;
  deviceCount?: number;
}

/** Clamp a stored/requested cadence into the supported range. */
export function clampDigestIntervalMinutes(minutes: number): number {
  return Math.min(
    Math.max(Math.round(minutes), SCREEN_DIGEST_MIN_INTERVAL_MINUTES),
    SCREEN_DIGEST_MAX_INTERVAL_MINUTES,
  );
}

/**
 * Build (or return the existing) screen-monitoring digest for `user` covering the
 * most recently COMPLETED cadence window. Called by the screen-notify sweep.
 */
export async function buildScreenDigest(
  userId: string,
  now: Date = new Date(),
): Promise<ScreenDigestResult> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { screenDigestEnabled: true, screenDigestIntervalMinutes: true },
  });
  if (!user) return { status: "skipped", reason: "user_not_found" };
  if (!user.screenDigestEnabled) return { status: "skipped", reason: "digest_disabled" };

  // Clamp the stored cadence so a bad value can never make the window degenerate.
  const intervalMinutes = clampDigestIntervalMinutes(user.screenDigestIntervalMinutes);
  const intervalMs = intervalMinutes * 60 * 1000;
  const windowEnd = digestWindowEnd(now, intervalMinutes);
  const windowStart = new Date(windowEnd.getTime() - intervalMs);

  const existing = await db.screenDigestRollup.findUnique({
    where: { userId_windowStart: { userId, windowStart } },
    select: { id: true },
  });
  if (existing) return { status: "already_done", rollupId: existing.id };

  // Only devices whose owner has actually switched monitoring ON contribute — a
  // digest must never describe a machine that captured nothing for consent.
  const devices = await db.device.findMany({
    where: { userId, screenshotMonitoringEnabled: true },
    select: { id: true, name: true },
  });
  if (devices.length === 0) return { status: "skipped", reason: "no_monitored_devices" };

  const frames = await db.deviceScreenshot.findMany({
    where: {
      userId,
      deviceId: { in: devices.map((d) => d.id) },
      status: "captured",
      summary: { not: null },
      createdAt: { gte: windowStart, lt: windowEnd },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, deviceId: true, summary: true },
  });
  // No summarised frames in the window => no empty digest (same rule lib/digest.ts
  // applies for a day with no activity).
  if (frames.length === 0) return { status: "skipped", reason: "no_activity" };

  const nameById = new Map(devices.map((d) => [d.id, d.name]));
  const byDevice = new Map<string, string[]>();
  for (const frame of frames) {
    if (!frame.summary) continue;
    const list = byDevice.get(frame.deviceId) ?? [];
    list.push(frame.summary);
    byDevice.set(frame.deviceId, list);
  }

  const lines: string[] = [];
  for (const [deviceId, summaries] of byDevice) {
    const deviceName = nameById.get(deviceId) ?? "Unknown device";
    lines.push(`${deviceName} — ${summaries.length} frame${summaries.length === 1 ? "" : "s"}`);
    for (const s of summaries.slice(0, SCREEN_DIGEST_SUMMARIES_PER_DEVICE)) lines.push(`  • ${s}`);
    if (summaries.length > SCREEN_DIGEST_SUMMARIES_PER_DEVICE) {
      lines.push(`  … and ${summaries.length - SCREEN_DIGEST_SUMMARIES_PER_DEVICE} more`);
    }
  }
  const digestText = lines.join("\n");
  const deviceCount = byDevice.size;

  const windowLabel =
    `${windowStart.toISOString().slice(0, 16).replace("T", " ")}–` +
    `${windowEnd.toISOString().slice(11, 16)} UTC`;
  const header = `🖥 Screen monitoring digest — ${windowLabel}`;

  // notifyUser fans out per the user's OWN prefs — a Telegram-disabled user gets
  // no Telegram, exactly like every other notification in this codebase.
  await notifyUser(userId, {
    eventType: SCREEN_DIGEST_EVENT_TYPE,
    subject: `Screen monitoring digest (${deviceCount} device${deviceCount === 1 ? "" : "s"})`,
    emailHtml: `<p>${escapeHtml(header)}</p><pre>${escapeHtml(digestText)}</pre>`,
    telegramText: `${header}\n\n${digestText}`,
    agentText: `${header}\n\n${digestText}`,
  });

  const rollup = await db.screenDigestRollup.create({
    data: { userId, windowStart, windowEnd, deviceCount, digestText },
  });
  return { status: "generated", rollupId: rollup.id, deviceCount };
}

/** Whether this user is due for a digest right now (interval since last rollup). */
export async function screenDigestDue(userId: string, now: Date = new Date()): Promise<boolean> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { screenDigestEnabled: true, screenDigestIntervalMinutes: true },
  });
  if (!user?.screenDigestEnabled) return false;

  const intervalMinutes = clampDigestIntervalMinutes(user.screenDigestIntervalMinutes);
  const last = await db.screenDigestRollup.findFirst({
    where: { userId },
    orderBy: { windowStart: "desc" },
    select: { windowStart: true },
  });
  if (!last) return true;
  return now.getTime() - last.windowStart.getTime() >= intervalMinutes * 60 * 1000;
}
