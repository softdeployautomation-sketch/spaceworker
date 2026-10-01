import "server-only";

import { mkdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import { db } from "./db";
import { env } from "./env";
import { getAdminSettings } from "./admin-settings";
import { createSessionToken, SESSION_COOKIE } from "./auth";
import { requestSlot, type PressureSnapshot } from "./resource-governor";

// ---------------------------------------------------------------------------
// TASK_127 Phase 1 — device screenshot monitoring: CAPTURE.
// ---------------------------------------------------------------------------
// Phase 1 only. There is deliberately NO AI here: the end-of-day vision summary
// is Phase 2 and ships as its own change (see the task doc). What this module
// owns is everything except the browser itself:
//
//   - the admin dials (master switch, concurrency cap, per-device interval,
//     retention) and the per-DEVICE opt-in consent boundary;
//   - where a frame lives on disk, and how a row references it;
//   - the capture pass: which devices are DUE, asking the governor (TASK_105)
//     for a slot, creating the `capturing` row that HOLDS that slot, and
//     recording the outcome;
//   - retention: reaping captures whose worker died, and deleting expired
//     frames from disk as well as from the table.
//
// WHY PLAYWRIGHT IS NOT IMPORTED HERE: the actual browser sequence lives in
// browser-capture/, a SEPARATE process. This module is imported by the admin
// API and (later) the UI, and importing Playwright into the Next server would
// drag a browser automation stack into the app process — the exact footprint
// the repo's own spaceworker-browser.service exists to keep out. The capture
// function is therefore INJECTED (see runCapturePass), which also makes the
// whole pass testable without launching a browser.

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface ScreenshotSettings {
  enabled: boolean;
  maxConcurrent: number;
  intervalMinutes: number;
  retentionDays: number;
}

/** Structural subset of AdminSetting this module reads. */
export interface ScreenshotSettingsRow {
  screenshotMonitoringEnabled?: boolean | null;
  screenshotCapturesMaxConcurrent?: number | null;
  screenshotCaptureIntervalMinutes?: number | null;
  screenshotRetentionDays?: number | null;
}

function rowInt(value: number | null | undefined, fallback: number, min: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min
    ? Math.floor(value)
    : fallback;
}

/**
 * Resolve the admin dials, falling back to the schema defaults when a value is
 * missing/unusable — same discipline as the governor's own resolvers, so a
 * half-written row can never produce a nonsensical cadence (e.g. an interval of
 * 0, which would try to capture every device on every tick).
 *
 * Defaults mirror the schema exactly: OFF, 2 at a time, hourly, 14 days.
 */
export function resolveScreenshotSettings(
  row: ScreenshotSettingsRow | null | undefined,
): ScreenshotSettings {
  return {
    enabled: typeof row?.screenshotMonitoringEnabled === "boolean"
      ? row.screenshotMonitoringEnabled
      : false,
    // Floor of 1: a cap of 0 would mean "monitoring on, but never capture".
    maxConcurrent: rowInt(row?.screenshotCapturesMaxConcurrent, 2, 1),
    // Floor of 1 MINUTE so the owner can compress a test window without code.
    intervalMinutes: rowInt(row?.screenshotCaptureIntervalMinutes, 60, 1),
    // Floor of 1 DAY: a retention of 0 would delete each frame as it was taken.
    retentionDays: rowInt(row?.screenshotRetentionDays, 14, 1),
  };
}

// ---------------------------------------------------------------------------
// Where frames live
// ---------------------------------------------------------------------------

// A frame is a picture of somebody's screen, so these two rules are deliberate:
//
//  1. The root is OUTSIDE the application directory. The repo's .gitignore
//     already documents why (a `next build` dies on the first file it cannot
//     read; the deploy user and the build user are not the same). Frames are
//     also 0600-ish sensitive artefacts and must never be reachable as static
//     assets — nothing under /opt/spaceworker is.
//  2. Rows store a path RELATIVE to that root, never an absolute one, so the
//     root can move (or differ between machines) without rewriting every row.
//
// Resolved LAZILY (function, not module constant): importing this module must
// never depend on the env being present, or an unrelated importer would throw
// at import time the way lib/browser-profiles.ts deliberately does.
export function screenshotBaseDir(): string {
  const configured = process.env.SCREENSHOT_BASE_DIR;
  if (configured && configured.trim().length > 0) return resolve(configured);
  // Same state root as BROWSER_PROFILE_BASE_DIR's documented sibling usage.
  return process.env.NODE_ENV === "production"
    ? "/var/spaceworker/screenshots"
    : join(tmpdir(), "spaceworker-screenshots");
}

/** The UTC day a frame belongs to (stamped on the row as `summaryDate`). */
export function startOfUtcDay(at: Date): Date {
  const day = new Date(at.getTime());
  day.setUTCHours(0, 0, 0, 0);
  return day;
}

/**
 * Relative path for a frame: `<deviceId>/<YYYY-MM-DD>/<frameId>.png`.
 *
 * Grouping by device and day is what makes both consumers cheap: the retention
 * purge deletes whole directories per day, and a human looking for "what was on
 * this device yesterday" finds one folder rather than a flat hash dump.
 */
export function frameRelPath(deviceId: string, at: Date, frameId: string): string {
  const day = startOfUtcDay(at).toISOString().slice(0, 10);
  return join(deviceId, day, `${frameId}.png`);
}

/** Absolute path for a stored relative frame path. */
export function frameAbsPath(relPath: string): string {
  return resolve(screenshotBaseDir(), relPath);
}

/**
 * The inverse of frameAbsPath: turn an absolute frame path back into the
 * RELATIVE form a row must store, validating it on the way through.
 *
 * Needed because the capture service is given an absolute path (it writes the
 * file) while the database stores only the relative form, so the two must be
 * converted in exactly one place rather than by string surgery at the call site.
 */
export function frameRelPathFromAbs(absPath: string): string {
  assertSafeFramePath(absPath);
  return relative(screenshotBaseDir(), absPath);
}

/**
 * Guard before any fs write/delete, mirroring lib/browser-profiles.ts's
 * assertSafePath: a row's stored path is data, and data must never be able to
 * address a file outside the screenshot root.
 */
export function assertSafeFramePath(absPath: string): void {
  const base = resolve(screenshotBaseDir());
  const normalized = resolve(absPath);
  if (normalized !== base && !normalized.startsWith(base + sep)) {
    throw new Error("Path traversal detected");
  }
}

/** Create the frame's directory and return the ABSOLUTE path to write to. */
export async function prepareFramePath(relPath: string): Promise<string> {
  const abs = frameAbsPath(relPath);
  assertSafeFramePath(abs);
  await mkdir(dirname(abs), { recursive: true });
  return abs;
}

// ---------------------------------------------------------------------------
// The capture pass
// ---------------------------------------------------------------------------

/**
 * A device whose owner opted it in AND which is due for a capture.
 * Deliberately a small, structural shape so a test can build one by hand.
 */
export interface CaptureTarget {
  id: string;
  userId: string;
  name: string;
}

/** What the injected capture function reports back. */
export interface CaptureOutcome {
  /** Relative path of the frame it wrote (required for a success). */
  filePath?: string;
  bytes?: number;
  width?: number;
  height?: number;
  /** Set instead of filePath when the capture could not produce a frame. */
  failureReason?: string;
}

/**
 * The browser half, injected. `framePath` is the PREPARED absolute path the
 * implementation should write its PNG to; returning its relative form is the
 * implementation's job so the row and the disk agree.
 */
export type CaptureFn = (device: CaptureTarget, framePath: string) => Promise<CaptureOutcome>;

/** Never let an unexpected upstream body become a row's failure reason. */
function shortReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, " ").slice(0, 300);
}

/**
 * The real CaptureFn — delegates each frame to browser-capture/server.ts over
 * loopback Bearer, so this side (and everything that calls it: the sweep,
 * the manual "capture now" trigger) does all the database work and owns no
 * browser footprint. Moved here (not the sweep route) so both real callers
 * share the exact same tested implementation instead of two copies drifting.
 *
 * Authority to act: this runs as the DEVICE'S OWNER, because that is honestly
 * what it is doing — viewing that owner's device through that owner's own
 * console. The token comes from the app's own `createSessionToken` (the same
 * call the login route makes), is used once, and is never logged or persisted.
 */
export const captureViaService: CaptureFn = async (device, framePath): Promise<CaptureOutcome> => {
  // Re-check liveness at capture time, not just when the caller decided to
  // ask: the device can go offline in between, and the console's own Connect
  // button is disabled for an offline machine — so the only possible outcomes
  // would be a confusing failure row and a wasted slot.
  const fresh = await db.device.findUnique({
    where: { id: device.id },
    select: { status: true, user: { select: { email: true, emailVerified: true } } },
  });
  if (!fresh || fresh.status !== "online") return { failureReason: "device_offline" };

  const token = await createSessionToken({
    sub: device.userId,
    email: fresh.user.email,
    emailVerified: fresh.user.emailVerified,
    scope: "full",
  });

  const base = new URL(env.appBaseUrl);
  const serviceUrl = process.env.SCREENSHOT_CAPTURE_URL ?? "http://127.0.0.1:3403";
  const serviceToken = process.env.SCREENSHOT_CAPTURE_TOKEN;
  if (!serviceToken) {
    return { failureReason: "capture_service_token_not_set" };
  }

  let response: Response;
  try {
    response = await fetch(`${serviceUrl}/capture`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceToken}`,
      },
      body: JSON.stringify({
        consoleUrl: `${env.appBaseUrl}/console/${device.id}`,
        cookieName: SESSION_COOKIE,
        cookieValue: token,
        cookieDomain: base.hostname,
        secureCookie: base.protocol === "https:",
        outputPath: framePath,
      }),
      // Slightly longer than the service's own 75s watchdog so the service's
      // specific failure reason wins the race instead of a bare client abort.
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    return { failureReason: `capture_service_unreachable: ${shortReason(err)}` };
  }

  if (!response.ok) {
    return { failureReason: `capture_service_http_${response.status}: ${shortReason(await response.text())}` };
  }

  const body = (await response.json()) as {
    ok?: boolean;
    failureReason?: string;
    bytes?: number;
    width?: number;
    height?: number;
  };
  if (!body.ok) return { failureReason: body.failureReason ?? "capture_failed" };

  return {
    filePath: frameRelPathFromAbs(framePath),
    bytes: body.bytes,
    width: body.width,
    height: body.height,
  };
};

export interface CapturePassOptions {
  now?: Date;
  /** Injected pressure (tests/diagnostics); production omits it. */
  pressure?: PressureSnapshot;
}

export interface CapturePassResult {
  /** Set when the whole pass did nothing: "disabled" or "no_devices". */
  skipped: string | null;
  attempted: number;
  captured: number;
  failed: number;
  /** Devices the governor put in line instead of admitting (next tick retries). */
  queued: number;
  reaped: number;
  purged: number;
  results: Array<{ deviceId: string; status: string; reason?: string }>;
}

// A capture that has not finished in this long is treated as a dead worker and
// reaped. The investigation measured the real sequence at tens of seconds, and
// the implementation enforces its own shorter per-step timeout — this is the
// backstop for a worker that was SIGKILLed and never wrote anything back, which
// matters because a stuck `capturing` row would otherwise hold a governor slot
// forever.
export const CAPTURE_STUCK_MS = 5 * 60 * 1000;

/**
 * Mark captures whose worker vanished as failed, releasing their governor slot.
 * Returns how many rows were reaped.
 */
export async function reapStuckCaptures(now: Date, stuckMs = CAPTURE_STUCK_MS): Promise<number> {
  const cutoff = new Date(now.getTime() - stuckMs);
  const res = await db.deviceScreenshot.updateMany({
    where: { status: "capturing", createdAt: { lt: cutoff } },
    data: { status: "failed", failureReason: "worker_timeout" },
  });
  return res.count;
}

/**
 * Delete frames older than the retention window — the FILE first, then the row.
 *
 * Order matters: unlinking first means a crash between the two steps leaves a
 * row whose file is gone (harmless — the row is past retention and gets retried
 * next pass), whereas deleting the row first would strand an unreferenced image
 * of somebody's screen on disk with nothing left to find it by. An unlink that
 * fails because the file is already gone is treated as success, not an error.
 *
 * TASK_152 M3 — WHAT HAPPENS TO A SUMMARY WHEN ITS IMAGE EXPIRES (the deliberate
 * decision, not an accident):
 *
 *   A summary is the owner's own record of what a machine was doing. Deleting it
 *   the moment the PNG ages out would destroy the only thing that outlives the
 *   picture, so the TEXT OUTLIVES THE PIXELS:
 *
 *     step 1 (image expiry, at `retentionDays`):
 *       - the file is unlinked and the row's filePath/bytes/width/height are
 *         NULLED, and `imagePurgedAt` is stamped;
 *       - if the row HAS a summary it is KEPT (marked, never destroyed);
 *       - if it has NO summary it is deleted outright, exactly as before, so a
 *         failed frame leaves nothing behind.
 *
 *     step 2 (summary expiry, one further `retentionDays` after `imagePurgedAt`):
 *       the kept row is finally deleted. Total lifetime is therefore at most
 *       2 x retentionDays — image for R days, then its kept summary for R more.
 *
 * The console renders an image-purged frame as its summary with no thumbnail
 * (there is no file to fetch), so the owner sees the text, not a broken image.
 *
 * Returns the number of expired rows processed (image purged and/or row deleted).
 */
export async function purgeExpiredFrames(now: Date, retentionDays: number): Promise<number> {
  const cutoff = startOfUtcDay(new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000));

  // ---- Step 1: the image expires -------------------------------------------------
  const expired = await db.deviceScreenshot.findMany({
    where: { summaryDate: { lt: cutoff }, status: { not: "capturing" } },
    select: { id: true, filePath: true, summary: true, imagePurgedAt: true },
  });
  let purged = 0;
  for (const row of expired) {
    // Already handled on an earlier pass — its kept summary is step 2's business.
    if (row.imagePurgedAt) continue;

    if (row.filePath) {
      try {
        const abs = frameAbsPath(row.filePath);
        assertSafeFramePath(abs);
        await unlink(abs);
      } catch {
        // Missing file (or a path that fails the traversal guard) must never
        // stop the purge — the row still goes (or is kept, if it has a summary).
      }
    }

    if (row.summary) {
      await db.deviceScreenshot.update({
        where: { id: row.id },
        data: {
          filePath: null,
          bytes: null,
          width: null,
          height: null,
          imagePurgedAt: now,
        },
      });
    } else {
      await db.deviceScreenshot.delete({ where: { id: row.id } });
    }
    purged++;
  }

  // ---- Step 2: the kept summary expires R days after its image -------------------
  const staleSummaries = await db.deviceScreenshot.findMany({
    where: { imagePurgedAt: { lt: cutoff } },
    select: { id: true },
  });
  if (staleSummaries.length > 0) {
    await db.deviceScreenshot.deleteMany({
      where: { id: { in: staleSummaries.map((r) => r.id) } },
    });
  }

  return purged;
}

/**
 * Devices that are opted in, online, and past their capture interval.
 *
 * OFFLINE DEVICES ARE SKIPPED, NOT FAILED: the console's own Connect button is
 * disabled when the machine is not online, so a capture attempt there could only
 * ever produce a confusing failure row and burn a slot. Skipping is also what
 * satisfies the acceptance rule that one sleeping device never breaks the sweep
 * for the others.
 */
export async function listDueDevices(
  now: Date,
  intervalMinutes: number,
): Promise<CaptureTarget[]> {
  // Wake-delay bookkeeping runs for every opted-in device, online or not —
  // an OFFLINE device with a stale "online since" anchor must have it cleared
  // (it went back offline since we last looked), so the NEXT time it wakes,
  // the delay is measured from that fresh wake, never a stale one.
  const offlineWithAnchor = await db.device.findMany({
    where: { screenshotMonitoringEnabled: true, status: { not: "online" }, screenshotOnlineSinceAt: { not: null } },
    select: { id: true },
  });
  if (offlineWithAnchor.length > 0) {
    await db.device.updateMany({
      where: { id: { in: offlineWithAnchor.map((d) => d.id) } },
      data: { screenshotOnlineSinceAt: null },
    });
  }

  const candidates = await db.device.findMany({
    where: { screenshotMonitoringEnabled: true, status: "online" },
    select: {
      id: true,
      userId: true,
      name: true,
      screenshotIntervalMinutesOverride: true,
      screenshotWakeDelayMinutes: true,
      screenshotOnlineSinceAt: true,
    },
    orderBy: { id: "asc" },
  });
  if (candidates.length === 0) return [];

  // First time this pass sees a candidate online since it last went offline
  // (anchor still null): stamp it now — this IS the wake this device's delay
  // (if any) is measured from.
  const needsAnchor = candidates.filter((d) => d.screenshotOnlineSinceAt === null);
  if (needsAnchor.length > 0) {
    await db.device.updateMany({
      where: { id: { in: needsAnchor.map((d) => d.id) } },
      data: { screenshotOnlineSinceAt: now },
    });
    for (const d of needsAnchor) d.screenshotOnlineSinceAt = now;
  }

  // A device with a capture ALREADY IN FLIGHT is never due again. Without this
  // an overlapping pass (a manual run beside the timer, or a capture still
  // running when the next tick fires) could ask for the same device twice and
  // photograph it twice — the governor would grant both, because each request is
  // individually within the cap. Skipping in-flight devices is what makes "one
  // capture per device at a time" true rather than merely likely.
  const inFlight = await db.deviceScreenshot.findMany({
    where: { status: "capturing" },
    select: { deviceId: true },
    distinct: ["deviceId"],
  });
  const busy = new Set(inFlight.map((row) => row.deviceId));
  const eligible = candidates.filter((device) => !busy.has(device.id));
  if (eligible.length === 0) return [];

  // One grouped read for the last attempt per device (uses the
  // deviceId+summaryDate index) instead of a query per candidate.
  const latest = await db.deviceScreenshot.groupBy({
    by: ["deviceId"],
    where: { deviceId: { in: eligible.map((d) => d.id) } },
    _max: { createdAt: true },
  });
  const lastAttempt = new Map<string, Date>();
  for (const row of latest) {
    const at = row._max.createdAt;
    if (at) lastAttempt.set(row.deviceId, at);
  }

  return eligible.filter((device) => {
    // The wake delay gates the FIRST capture after each fresh wake — before
    // it elapses, this device is never due, regardless of the interval.
    if (
      typeof device.screenshotWakeDelayMinutes === "number" &&
      device.screenshotWakeDelayMinutes > 0 &&
      device.screenshotOnlineSinceAt
    ) {
      const delayMs = device.screenshotWakeDelayMinutes * 60 * 1000;
      if (now.getTime() - device.screenshotOnlineSinceAt.getTime() < delayMs) return false;
    }

    // A per-device override (if set) replaces the global interval entirely
    // for THIS device — e.g. compressing a test window to 1 minute without
    // touching every other opted-in device's schedule.
    const effectiveMinutes =
      typeof device.screenshotIntervalMinutesOverride === "number" &&
      device.screenshotIntervalMinutesOverride > 0
        ? device.screenshotIntervalMinutesOverride
        : intervalMinutes;
    const intervalMs = effectiveMinutes * 60 * 1000;
    const last = lastAttempt.get(device.id);
    return !last || now.getTime() - last.getTime() >= intervalMs;
  });
}

/**
 * Run one capture pass.
 *
 * The browser work is INJECTED (`capture`) so this function is testable without
 * Chromium, and so the Playwright stack stays in its own process. Everything
 * else — the master switch, the due list, the governor admission, the slot-holding
 * row, the outcome record, reaping and retention — is real here.
 *
 * HOW THE CONCURRENCY CAP IS ENFORCED: each admitted device gets its `capturing`
 * row CREATED BEFORE the next device is asked, and the governor's live count for
 * `deviceScreenshots` is exactly the number of `capturing` rows. So the loop
 * naturally admits at most `screenshotCapturesMaxConcurrent` captures per pass
 * even though the captures themselves run in parallel — and, because the count
 * comes from the database rather than from memory, a pass that overlaps a
 * previous pass's still-running capture cannot over-admit either.
 */
export async function runCapturePass(
  capture: CaptureFn,
  opts: CapturePassOptions = {},
): Promise<CapturePassResult> {
  const now = opts.now ?? new Date();
  const settings = resolveScreenshotSettings(await getAdminSettings());

  const result: CapturePassResult = {
    skipped: null,
    attempted: 0,
    captured: 0,
    failed: 0,
    queued: 0,
    reaped: 0,
    purged: 0,
    results: [],
  };

  // Master switch first — with monitoring off nothing is read, nothing is
  // deleted and no browser is ever considered (today's behaviour exactly).
  if (!settings.enabled) {
    result.skipped = "disabled";
    return result;
  }

  // Housekeeping runs even on a pass with nothing due, so a dead worker's slot
  // is released and expired frames do not accumulate while the box is idle.
  result.reaped = await reapStuckCaptures(now);
  result.purged = await purgeExpiredFrames(now, settings.retentionDays);

  const due = await listDueDevices(now, settings.intervalMinutes);
  if (due.length === 0) {
    result.skipped = "no_devices";
    return result;
  }

  const inflight: Array<Promise<void>> = [];

  for (const device of due) {
    // `ref: device.id` makes a re-ask idempotent: a device that is already in
    // line keeps ONE governor row and ONE position across ticks rather than
    // pushing a new entry every minute.
    const decision = await requestSlot("deviceScreenshots", {
      userId: device.userId,
      ref: device.id,
      pressure: opts.pressure,
      now,
    });

    if (decision.status !== "granted") {
      if (decision.status === "queued") result.queued++;
      result.results.push({
        deviceId: device.id,
        status: decision.status,
        reason: decision.reason,
      });
      continue;
    }

    // Admitted: create the slot-holding row BEFORE touching the browser, so the
    // governor's live count reflects reality for the next candidate.
    const frame = await db.deviceScreenshot.create({
      data: {
        deviceId: device.id,
        userId: device.userId,
        status: "capturing",
        summaryDate: startOfUtcDay(now),
      },
      select: { id: true },
    });

    const relPath = frameRelPath(device.id, now, frame.id);
    const absPath = await prepareFramePath(relPath);
    result.attempted++;

    // Started immediately, awaited at the end: this is what lets up to `cap`
    // captures overlap while the loop above still enforces the cap.
    inflight.push(
      capture(device, absPath)
        .then(async (outcome) => {
          if (outcome.filePath && !outcome.failureReason) {
            await db.deviceScreenshot.update({
              where: { id: frame.id },
              data: {
                status: "captured",
                filePath: outcome.filePath,
                bytes: outcome.bytes ?? null,
                width: outcome.width ?? null,
                height: outcome.height ?? null,
                capturedAt: new Date(),
              },
            });
            result.captured++;
            result.results.push({ deviceId: device.id, status: "captured" });
            return;
          }
          // A capture that produced nothing is a FAILED row, never a silent
          // skip: the owner must be able to see that monitoring is not working.
          await db.deviceScreenshot.update({
            where: { id: frame.id },
            data: {
              status: "failed",
              failureReason: outcome.failureReason ?? "no_frame",
            },
          });
          result.failed++;
          result.results.push({
            deviceId: device.id,
            status: "failed",
            reason: outcome.failureReason ?? "no_frame",
          });
        })
        .catch(async (err: unknown) => {
          // The implementation threw (browser launch failure, navigation
          // timeout, ...). Same rule: record it, never leave the row in
          // "capturing" holding a slot.
          const reason = err instanceof Error ? err.message : "capture_error";
          try {
            await db.deviceScreenshot.update({
              where: { id: frame.id },
              data: { status: "failed", failureReason: reason.slice(0, 500) },
            });
          } catch {
            // Nothing more we can do; the reaper will clear it.
          }
          result.failed++;
          result.results.push({ deviceId: device.id, status: "failed", reason });
        }),
    );
  }

  await Promise.allSettled(inflight);
  return result;
}

export interface CaptureNowResult {
  status: "captured" | "failed" | "queued" | "refused";
  reason?: string;
  frameId?: string;
}

/**
 * Manual, on-demand capture of ONE specific device — an explicit ask, not a
 * scheduled one, so it bypasses `listDueDevices`'s interval/"due" check. Every
 * OTHER real gate still applies: the master switch, this device's own opt-in,
 * an online check, "not already mid-capture," and the exact same governor
 * admission a scheduled capture goes through. Exists so an owner can verify
 * monitoring works (or grab one fresh frame right now) without waiting for,
 * or holding a device online through, a full interval window.
 */
export async function captureDeviceNow(
  deviceId: string,
  capture: CaptureFn,
  now: Date = new Date(),
): Promise<CaptureNowResult> {
  const settings = resolveScreenshotSettings(await getAdminSettings());
  if (!settings.enabled) return { status: "refused", reason: "monitoring_disabled" };

  const device = await db.device.findUnique({
    where: { id: deviceId },
    select: { id: true, userId: true, name: true, status: true, screenshotMonitoringEnabled: true },
  });
  if (!device) return { status: "refused", reason: "device_not_found" };
  if (!device.screenshotMonitoringEnabled) return { status: "refused", reason: "not_opted_in" };
  if (device.status !== "online") return { status: "refused", reason: "device_offline" };

  const alreadyCapturing = await db.deviceScreenshot.findFirst({
    where: { deviceId, status: "capturing" },
    select: { id: true },
  });
  if (alreadyCapturing) return { status: "refused", reason: "already_capturing" };

  const decision = await requestSlot("deviceScreenshots", {
    userId: device.userId,
    ref: device.id,
    now,
  });
  if (decision.status !== "granted") {
    return { status: decision.status === "queued" ? "queued" : "refused", reason: decision.reason };
  }

  const frame = await db.deviceScreenshot.create({
    data: {
      deviceId: device.id,
      userId: device.userId,
      status: "capturing",
      summaryDate: startOfUtcDay(now),
    },
    select: { id: true },
  });
  const relPath = frameRelPath(device.id, now, frame.id);
  const absPath = await prepareFramePath(relPath);

  try {
    const outcome = await capture({ id: device.id, userId: device.userId, name: device.name }, absPath);
    if (outcome.filePath && !outcome.failureReason) {
      await db.deviceScreenshot.update({
        where: { id: frame.id },
        data: {
          status: "captured",
          filePath: outcome.filePath,
          bytes: outcome.bytes ?? null,
          width: outcome.width ?? null,
          height: outcome.height ?? null,
          capturedAt: new Date(),
        },
      });
      return { status: "captured", frameId: frame.id };
    }
    await db.deviceScreenshot.update({
      where: { id: frame.id },
      data: { status: "failed", failureReason: outcome.failureReason ?? "no_frame" },
    });
    return { status: "failed", reason: outcome.failureReason ?? "no_frame", frameId: frame.id };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "capture_error";
    try {
      await db.deviceScreenshot.update({
        where: { id: frame.id },
        data: { status: "failed", failureReason: reason.slice(0, 500) },
      });
    } catch {
      // Nothing more we can do; the reaper will clear it.
    }
    return { status: "failed", reason, frameId: frame.id };
  }
}

// ---------------------------------------------------------------------------
// Read helpers (the owner-facing views)
// ---------------------------------------------------------------------------

export interface FrameView {
  id: string;
  status: string;
  /** Why the CAPTURE failed. Independent of `summaryError` — see below. */
  failureReason: string | null;
  // TASK_152 M3 — the SUMMARY axis, deliberately separate from failureReason.
  // A captured frame with `summary === null` is NORMAL (not summarised yet, or
  // the budget/cap ran out); the UI must never render that as a capture failure.
  summary: string | null;
  summaryError: string | null;
  summaryModel: string | null;
  summarisedAt: string | null;
  /** Set when the raw image was deleted by retention but the summary was KEPT. */
  imagePurgedAt: string | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
  capturedAt: string | null;
  createdAt: string;
}

/**
 * Recent frames for one device, newest first — what the owner's UI lists.
 *
 * TASK_152 M3 raised the console's call site to 50: the Screen monitoring tab
 * renders a SCROLLABLE timeline, so "20" (a strip worth) is no longer the right
 * amount. The default stays 20 for any other caller.
 */
export async function listRecentFrames(deviceId: string, limit = 20): Promise<FrameView[]> {
  const rows = await db.deviceScreenshot.findMany({
    where: { deviceId },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      status: true,
      failureReason: true,
      summary: true,
      summaryError: true,
      summaryModel: true,
      summarisedAt: true,
      imagePurgedAt: true,
      bytes: true,
      width: true,
      height: true,
      capturedAt: true,
      createdAt: true,
    },
  });
  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    failureReason: row.failureReason ?? null,
    summary: row.summary ?? null,
    summaryError: row.summaryError ?? null,
    summaryModel: row.summaryModel ?? null,
    summarisedAt: iso(row.summarisedAt),
    imagePurgedAt: iso(row.imagePurgedAt),
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    capturedAt: iso(row.capturedAt),
    createdAt: row.createdAt.toISOString(),
  }));
}

/** In-flight captures right now — the same number the governor's cap counts. */
export async function countCapturing(): Promise<number> {
  return db.deviceScreenshot.count({ where: { status: "capturing" } });
}

/** Remove a stored frame from disk (used when a device or opt-in is removed). */
export async function deleteFrameFile(relPath: string): Promise<void> {
  try {
    const abs = frameAbsPath(relPath);
    assertSafeFramePath(abs);
    await unlink(abs);
  } catch {
    // Already gone (or unsafe) — nothing to do.
  }
}

/** Delete a device's whole frame tree from disk. */
export async function deleteDeviceFrameTree(deviceId: string): Promise<void> {
  try {
    const abs = frameAbsPath(deviceId);
    assertSafeFramePath(abs);
    await rm(abs, { recursive: true, force: true });
  } catch {
    // Nothing to remove.
  }
}
