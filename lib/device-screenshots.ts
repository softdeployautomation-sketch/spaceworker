import "server-only";

import { mkdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import { db } from "./db";
import { env } from "./env";
import { getAdminSettings } from "./admin-settings";
import { createSessionToken, SESSION_COOKIE } from "./auth";
import {
  requestSlot,
  resolvePriority,
  governorPriorityRank,
  readPressure,
  resolveGovernorSettings,
  type PressureSnapshot,
  type GovernorPriority,
} from "./resource-governor";

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
  // TASK_152 M6 — the scheduler's two resolved dials.
  /**
   * RAM used % below which the box counts as having headroom, so a lone
   * monitoring user may run captures SIMULTANEOUSLY up to the cap. RESOLVED
   * from `screenshotHeadroomRamPct` (0 = inherit `governorRamWarnPct`) and
   * clamped to <= the hard line — see resolveScreenshotSettings.
   */
  headroomRamPct: number;
  /** How long one rotation slice holds before the per-user cursor advances. */
  rotationSliceMinutes: number;
  // TASK_168 Bug B — the SUMMARY budget dial: metered relay calls allowed per
  // device per UTC day. Default 8 (= 24 frames/day at 3/call) reproduces the
  // old hardcoded behaviour. The frames/day figure is DERIVED (× 3), never a
  // second dial, so the two can never drift apart. Short name matches the
  // admin API/UI key (same 1:1:1 discipline as maxConcurrent etc.).
  summaryMaxCalls: number;
}

/** Structural subset of AdminSetting this module reads. */
export interface ScreenshotSettingsRow {
  screenshotMonitoringEnabled?: boolean | null;
  screenshotCapturesMaxConcurrent?: number | null;
  screenshotCaptureIntervalMinutes?: number | null;
  screenshotRetentionDays?: number | null;
  // TASK_152 M6 — the scheduler's dials, plus the governor's RAM dials it
  // RECONCILES against. Same AdminSetting row, so no second settings read.
  screenshotHeadroomRamPct?: number | null;
  screenshotRotationSliceMinutes?: number | null;
  // TASK_168 Bug B — the summary budget dial lives on the same AdminSetting
  // row, so no second settings read.
  screenshotSummaryMaxCallsPerDevicePerDay?: number | null;
  governorRamWarnPct?: number | null;
  governorRamHardPct?: number | null;
}

function rowInt(value: number | null | undefined, fallback: number, min: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min
    ? Math.floor(value)
    : fallback;
}

/** A percentage clamped into 1..100 (mirrors the governor's own `pct`). */
function pctClamp(value: number | null | undefined, fallback: number): number {
  return Math.min(100, Math.max(1, rowInt(value, fallback, 1)));
}

// TASK_152 M6 — the bounds shared by the scheduler and the admin dial, so the
// two can never drift apart (same discipline as M4's interval bounds).
export const SCREENSHOT_ROTATION_SLICE_MIN_MINUTES = 1;
export const SCREENSHOT_ROTATION_SLICE_MAX_MINUTES = 1440;
export const SCREENSHOT_HEADROOM_MIN_PCT = 0; // 0 is meaningful: "inherit the warn line"
export const SCREENSHOT_HEADROOM_MAX_PCT = 100;

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
  // TASK_152 M6 — resolve the headroom line against the governor's OWN dials.
  // The governor guarantees warn <= hard; mirror that here so a warn/hard pair
  // written out of order can never invert the comparison.
  const ramWarnPct = pctClamp(row?.governorRamWarnPct, 75);
  const ramHardPct = Math.max(ramWarnPct, pctClamp(row?.governorRamHardPct, 90));
  // 0 (the default) = INHERIT the warn line: that is the exact "box still
  // healthy" boundary the governor already uses (premium bypass runs only at
  // `level === normal`), so the default introduces no third threshold. A
  // positive dial is the owner's explicit ~60% and is clamped to <= the hard
  // line, because a headroom line above the hard line would be meaningless.
  const rawHeadroom = rowInt(row?.screenshotHeadroomRamPct, 0, 0);
  const headroomRamPct = rawHeadroom > 0 ? Math.min(rawHeadroom, ramHardPct) : ramWarnPct;

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
    headroomRamPct,
    rotationSliceMinutes: rowInt(
      row?.screenshotRotationSliceMinutes,
      25,
      SCREENSHOT_ROTATION_SLICE_MIN_MINUTES,
    ),
    // TASK_168 Bug B — floor of 1 call: 0 would mean "summarise nothing, ever",
    // which is the OFF switch's job, not the budget dial's.
    summaryMaxCalls: rowInt(
      row?.screenshotSummaryMaxCallsPerDevicePerDay,
      8,
      1,
    ),
  };
}

// TASK_152 M4 — cadence bounds shared by the admin dial and the per-device
// override, so the two can never drift apart.
export const SCREENSHOT_INTERVAL_MIN_MINUTES = 1;
export const SCREENSHOT_INTERVAL_MAX_MINUTES = 1440;

/**
 * TASK_152 M4 — the ONE place the effective cadence is decided.
 *
 * POLICY (decided here and enforced server-side; never the UI's job to enforce):
 * the admin's global `screenshotCaptureIntervalMinutes` is a CEILING on capture
 * FREQUENCY, i.e. a FLOOR on the interval. Concretely, a device may be captured
 * at the admin's cadence or LESS often — a per-device override can only SLOW a
 * device down, never make it MORE frequent than the admin allows:
 *
 *     effective = max(globalIntervalMinutes, override)
 *
 * WHY THE CEILING POINTS THIS WAY: RAM is the scarce, admin-owned resource here
 * (each capture is a real headless Chromium — see the governor's
 * `deviceScreenshots` slot). Only the admin can see the whole box, so "faster
 * than the admin's value" must not be a per-user freedom; an owner who needs a
 * finer cadence lowers the admin global, which keeps the admin the single
 * authority over how hard the box may be driven.
 *
 * A null / non-positive override means "use the global as-is" — the exact
 * behaviour a device with no override has always had (additive: unchanged).
 */
export function resolveEffectiveIntervalMinutes(
  globalIntervalMinutes: number,
  override: number | null | undefined,
): number {
  const global = Math.floor(globalIntervalMinutes);
  if (typeof override !== "number" || !Number.isFinite(override) || override <= 0) {
    return global;
  }
  return Math.max(global, Math.floor(override));
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
        // TASK_153 S2 — observation never ticks the mesh Input toggle. Sent
        // EXPLICITLY (not merely omitted) and always `false`, so the sweep's
        // intent is on the wire and cannot be changed by accident. captureScreen
        // refuses `true` anyway; see browser-capture/capture.ts.
        enableInput: false,
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
  // TASK_152 M6 — scheduling observability, and the honesty split the task doc
  // demands: a device that has merely not had its turn yet is `deferred`, NOT a
  // failure. It stays eligible and is served on a later rotation slice.
  /** Devices NOT offered this pass because it was not their turn in the rotation. */
  deferred: number;
  /** Users that rotated this pass (eligible devices exceeded granted slots). */
  rotatingUsers: number;
  /** Whether cross-user parallelism was allowed this pass (idle box, one user). */
  parallel: boolean;
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

    // TASK_152 M4 — the per-device override goes through the ONE shared
    // resolver: the admin's global cadence is a CEILING on frequency (a floor on
    // the interval), so an override can only make THIS device LESS frequent than
    // the global, never more often. Null/0 = the global, exactly as before.
    const effectiveMinutes = resolveEffectiveIntervalMinutes(
      intervalMinutes,
      device.screenshotIntervalMinutesOverride,
    );
    const intervalMs = effectiveMinutes * 60 * 1000;
    const last = lastAttempt.get(device.id);
    return !last || now.getTime() - last.getTime() >= intervalMs;
  });
}
/**
 * TASK_152 M6 — a user's STABLE rotation ROSTER: every opted-in, ONLINE device,
 * sorted by id.
 *
 * WHY THIS IS SEPARATE FROM `listDueDevices`: rotation must anchor on a set that
 * does NOT move underneath it. The DUE set shrinks the instant a device is
 * captured (it is no longer due), so rotating by index over the due set would
 * SKIP a device every time one dropped out — e.g. capture d1, then index into the
 * shrunken due list and land on d3 instead of d2. The roster (opted-in + online)
 * only changes when the fleet or a consent flag changes, so a cursor stored
 * against it stays valid and the slice advances one device at a time.
 *
 * In-flight devices are deliberately NOT excluded: the roster is an ORDERING, not
 * a work list, and a device mid-capture must keep its place or the ordering would
 * shift every time a capture is running.
 *
 * The DUE set returned by listDueDevices is always a SUBSET of this roster, so
 * `slice ∩ due` is well defined.
 */
export async function listRotationRoster(): Promise<CaptureTarget[]> {
  return db.device.findMany({
    where: { screenshotMonitoringEnabled: true, status: "online" },
    select: { id: true, userId: true, name: true },
    orderBy: { id: "asc" },
  });
}


/**
 * TASK_152 M6 — ONE user's plan for the current pass: which of their due devices
 * to OFFER the governor now, which to DEFER to a later rotation slice, and the
 * cursor write (if any) to persist once the slice has actually been offered.
 *
 * This is a planning structure only. It never admits anything: every offer still
 * goes through `requestSlot`, which is the single admission authority.
 */
interface UserSlicePlan {
  userId: string;
  /** Devices this pass will ASK the governor about (the current slice). */
  offers: CaptureTarget[];
  /** Due devices held back this pass — "not had its turn yet", NOT a failure. */
  deferred: CaptureTarget[];
  /** Cursor row to persist after this slice is served (null = hold, don't advance). */
  cursorUpdate: { cursorDeviceId: string; rotatedAt: Date } | null;
  /** True when this user is rotating (roster exceeded granted slots). */
  rotating: boolean;
}

/** Stable device order (by id) so rotation is deterministic and reproducible. */
function byDeviceId(a: CaptureTarget, b: CaptureTarget): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
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
 *
 * TASK_152 M6 — WHO gets asked changed; the cap did not. Before asking the
 * governor, the pass now plans each user's slice:
 *   - FAIRNESS: the cap is divided across the users competing RIGHT NOW, so one
 *     user's many devices cannot take a quiet user's share. Users are ordered by
 *     the governor's own premium/standard/trial classes (then by how long they
 *     have waited), and their offers are interleaved round-robin.
 *   - ROTATION: when a user's due devices exceed their granted slots, only a
 *     bounded slice is offered and the rest are DEFERRED (never failed). A
 *     persisted per-user cursor (ScreenshotRotationCursor) advances the slice on
 *     the admin's cadence, so every device is sampled and none starves.
 *   - HEADROOM: parallelism (a user taking their full cap) is allowed only while
 *     the box has headroom AND nobody else is competing; otherwise every user is
 *     held to their fair share and rotates. Both this and the cap are re-derived
 *     from the CURRENT AdminSetting + pressure on EVERY pass, so raising/lowering
 *     the cap or the pressure switching mid-run takes effect WITHOUT a restart.
 */
export async function runCapturePass(
  capture: CaptureFn,
  opts: CapturePassOptions = {},
): Promise<CapturePassResult> {
  const now = opts.now ?? new Date();
  const adminRow = await getAdminSettings();
  const settings = resolveScreenshotSettings(adminRow);
  // TASK_152 M6 — ONE pressure snapshot for the whole pass. It decides headroom
  // AND is handed to every `requestSlot`, so the pass can never read a "normal"
  // box for its planning and a "hard" box for an admission (or vice versa). The
  // governor reads the same snapshot itself when the caller omits it, so passing
  // ours in changes nothing except that it can no longer drift mid-pass.
  const pressure: PressureSnapshot =
    opts.pressure ?? readPressure(resolveGovernorSettings(adminRow));

  const result: CapturePassResult = {
    skipped: null,
    attempted: 0,
    captured: 0,
    failed: 0,
    queued: 0,
    deferred: 0,
    rotatingUsers: 0,
    parallel: false,
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

  // Group this pass's due devices by owner, in the stable order rotation uses.
  const dueByUser = new Map<string, CaptureTarget[]>();
  for (const device of due) {
    const list = dueByUser.get(device.userId);
    if (list) list.push(device);
    else dueByUser.set(device.userId, [device]);
  }
  for (const list of dueByUser.values()) list.sort(byDeviceId);

  // TASK_152 M6 — the STABLE rotation roster per user (opted-in + online). This
  // is what the cursor indexes into, so a device dropping out of the DUE set
  // (because it was just captured) cannot shift the slice onto its neighbour.
  const rosterByUser = new Map<string, CaptureTarget[]>();
  for (const device of await listRotationRoster()) {
    if (!dueByUser.has(device.userId)) continue; // only users with work this pass
    const list = rosterByUser.get(device.userId);
    if (list) list.push(device);
    else rosterByUser.set(device.userId, [device]);
  }
  for (const list of rosterByUser.values()) list.sort(byDeviceId);

  // A user is "active" if they have a due device OR a capture already in flight
  // from a pass that is still running. The cap is divided across ACTIVE users —
  // that division IS the fairness rule, and it needs no new counter: it reads the
  // same `capturing` rows the governor's liveCount counts.
  const inFlightUsers = await db.deviceScreenshot.findMany({
    where: { status: "capturing" },
    select: { userId: true },
    distinct: ["userId"],
  });
  const activeUserIds = new Set<string>(dueByUser.keys());
  for (const row of inFlightUsers) activeUserIds.add(row.userId);
  const activeUsers = Math.max(1, activeUserIds.size);

  // HEADROOM (owner: "if the box is idle and others are not monitoring, run
  // simultaneously, else queue"). `headroomRamPct` IS governorRamWarnPct unless
  // an admin overrode it, so this adds no third threshold. Parallelism also
  // requires that nobody else is competing.
  const headroomOk = pressure.level !== "hard" && pressure.ramUsedPct < settings.headroomRamPct;
  const parallelAllowed = headroomOk && activeUsers <= 1;
  result.parallel = parallelAllowed;

  // How many devices ONE user may OFFER this pass. This bounds offers, never
  // grants — the governor still decides the real concurrency. Three states,
  // which is exactly the owner's rule:
  //   * idle box, nobody else monitoring  -> the whole cap, i.e. SIMULTANEOUS.
  //   * box has headroom but others compete -> the user's FAIR SHARE of the cap.
  //   * box is out of headroom (any users) -> ONE at a time per user, i.e. QUEUE
  //     (rotate), so captures never pile onto a loaded box.
  // Every branch is re-derived from the CURRENT settings + pressure, so raising
  // the cap or pressure clearing mid-run takes effect on the very next pass with
  // no restart — there is no cached "mode".
  const perUserSlots = parallelAllowed
    ? settings.maxConcurrent
    : headroomOk
      ? Math.max(1, Math.floor(settings.maxConcurrent / activeUsers))
      : 1;

  // Order users by the governor's OWN class (premium > standard > trial), then by
  // staleness of their rotation cursor (the user whose cursor has not moved in
  // longest is served first — the starvation tiebreak, the same idea as
  // governorStarvationPromoteMin, reusing the governor's persisted state rather
  // than inventing a second priority system).
  const priorityByUser = new Map<string, GovernorPriority>();
  for (const userId of dueByUser.keys()) {
    priorityByUser.set(userId, await resolvePriority(userId));
  }
  const cursorRows = await db.screenshotRotationCursor.findMany({
    where: { userId: { in: [...dueByUser.keys()] } },
  });
  const cursorByUser = new Map(cursorRows.map((c) => [c.userId, c]));
  const orderedUsers = [...dueByUser.keys()].sort((a, b) => {
    const byClass =
      governorPriorityRank(priorityByUser.get(a) ?? "trial") -
      governorPriorityRank(priorityByUser.get(b) ?? "trial");
    if (byClass !== 0) return byClass;
    const byStarvation =
      (cursorByUser.get(a)?.rotatedAt.getTime() ?? 0) -
      (cursorByUser.get(b)?.rotatedAt.getTime() ?? 0);
    if (byStarvation !== 0) return byStarvation;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const sliceMs = settings.rotationSliceMinutes * 60_000;
  const plans: UserSlicePlan[] = [];
  for (const userId of orderedUsers) {
    const dueForUser = dueByUser.get(userId)!;
    // The ROSTER is the stable set rotation indexes into; fall back to the due set
    // if a roster read somehow missed this user (never expected — due ⊆ roster).
    const roster = rosterByUser.get(userId) ?? dueForUser;

    // Fits inside the granted slots: PARALLEL — offer every due device at once and
    // never touch the cursor, so the user runs simultaneously up to the cap.
    // Because `perUserSlots` is re-derived from the CURRENT AdminSetting every pass,
    // an admin raising the cap (or contention clearing) flips a rotating user
    // straight back to parallel — no restart and no cached "rotating" flag.
    if (roster.length <= perUserSlots) {
      plans.push({ userId, offers: dueForUser, deferred: [], cursorUpdate: null, rotating: false });
      continue;
    }

    // ROTATION. The cursor names the LAST device the previous slice served, so the
    // next slice always resumes one step after it — an advance that is CORRECT no
    // matter how the granted slot count changes between slices (advancing by "one
    // slice width" would re-serve or skip devices the moment the cap moved). The
    // slice is taken from the ROSTER (not the shrunken due set) so capturing a
    // device cannot shift the slice onto its neighbour.
    const cursor = cursorByUser.get(userId);
    const windowElapsed = !cursor || now.getTime() - cursor.rotatedAt.getTime() >= sliceMs;

    // WITHIN the window the user HOLDS: it has already had its turn, so its other
    // devices wait (deferred, never failed) until the slice elapses. This is the
    // owner's 20-30 min per-device turn, and it is why a fresh capture cannot be
    // followed one minute later by its neighbour.
    if (!windowElapsed) {
      plans.push({ userId, offers: [], deferred: dueForUser, cursorUpdate: null, rotating: true });
      continue;
    }

    const anchorIdx = cursor?.cursorDeviceId
      ? roster.findIndex((d) => d.id === cursor.cursorDeviceId)
      : -1;
    // A missing anchor (first slice, or the cursor device left the roster) starts at
    // the top of the roster; otherwise resume one step past the last served device.
    const startIdx = anchorIdx < 0 ? 0 : (anchorIdx + 1) % roster.length;
    const slice = new Set<string>();
    for (let i = 0; i < perUserSlots && i < roster.length; i++) {
      slice.add(roster[(startIdx + i) % roster.length].id);
    }
    // The cursor advances to the LAST device of this slice (the next window resumes
    // after it). Gated on the slice actually being served below, so a slice whose
    // whole turn was queued is retried rather than skipped — no lost turn.
    const lastServed = roster[(startIdx + Math.min(perUserSlots, roster.length) - 1) % roster.length];
    plans.push({
      userId,
      // Offer only the slice devices that are DUE; the rest of the slice simply has
      // nothing to do yet and keeps its place on a later pass.
      offers: dueForUser.filter((d) => slice.has(d.id)),
      deferred: dueForUser.filter((d) => !slice.has(d.id)),
      cursorUpdate: { cursorDeviceId: lastServed.id, rotatedAt: now },
      rotating: true,
    });
  }

  // Round-robin the offers across users so submission ORDER is fair too: the
  // governor admits head-first, so without this one user's burst could still own
  // the head of the line.
  const offers: CaptureTarget[] = [];
  const maxOffers = plans.reduce((max, plan) => Math.max(max, plan.offers.length), 0);
  for (let i = 0; i < maxOffers; i++) {
    for (const plan of plans) {
      if (i < plan.offers.length) offers.push(plan.offers[i]);
    }
  }

  // Deferred devices are reported honestly as "not their turn yet" — never as a
  // failure — so the owner can tell "not sampled this slice" from "monitoring is
  // broken".
  for (const plan of plans) {
    if (plan.rotating) result.rotatingUsers += 1;
    for (const device of plan.deferred) {
      result.deferred += 1;
      result.results.push({ deviceId: device.id, status: "deferred", reason: "rotation_slice" });
    }
  }

  const inflight: Array<Promise<void>> = [];
  const grantedUsers = new Set<string>();

  for (const device of offers) {
    // `ref: device.id` makes a re-ask idempotent: a device that is already in
    // line keeps ONE governor row and ONE position across ticks rather than
    // pushing a new entry every minute.
    const decision = await requestSlot("deviceScreenshots", {
      userId: device.userId,
      ref: device.id,
      pressure,
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

    // TASK_152 M6 — this user really had its slice served, so its cursor may
    // advance after the loop (a slice whose whole turn was queued must NOT be
    // skipped, or a device could lose its turn to contention).
    grantedUsers.add(device.userId);

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

  // TASK_152 M6 — persist each advanced cursor NOW that the slice was offered.
  // Only users who actually had a device ADMITTED are advanced: if the whole
  // slice was queued behind other work, the cursor holds, so that slice is
  // retried next pass instead of being skipped — nothing loses its turn to
  // contention. Deriving this from `grantedUsers` (not from a fresh read) keeps
  // the write consistent with what this pass truly did.
  for (const plan of plans) {
    if (!plan.cursorUpdate || !grantedUsers.has(plan.userId)) continue;
    await db.screenshotRotationCursor.upsert({
      where: { userId: plan.userId },
      create: {
        userId: plan.userId,
        cursorDeviceId: plan.cursorUpdate.cursorDeviceId,
        rotatedAt: plan.cursorUpdate.rotatedAt,
      },
      update: {
        cursorDeviceId: plan.cursorUpdate.cursorDeviceId,
        rotatedAt: plan.cursorUpdate.rotatedAt,
      },
    });
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
  // TASK_157 — the FREE extraction. Written before any AI call, so it survives a
  // dead relay, an exhausted cap, or an unconfigured key. `ocrText === null`
  // means "never read"; `ocrText === ""` WITH `ocrAt` set means "read, and the
  // screen genuinely had no words" — the UI must say those two things
  // differently rather than showing a blank card forever.
  ocrText: string | null;
  ocrAt: string | null;
  ocrConfidence: number | null;
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
      ocrText: true,
      ocrAt: true,
      ocrConfidence: true,
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
    ocrText: row.ocrText ?? null,
    ocrAt: iso(row.ocrAt),
    ocrConfidence: row.ocrConfidence ?? null,
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

/**
 * TASK_157 — delete ONE frame, permanently, for its owner.
 *
 * Returns "not_found" for a frame that does not exist OR belongs to somebody
 * else. Those two are deliberately indistinguishable: a caller must not be able
 * to probe for the existence of another user's frame id.
 *
 * The ownership gate is the SAME shape as the GET that serves the image — the row
 * is matched on its id AND the device's userId. There is no "admin can delete any
 * frame" path here, because there is no such need and it widens the blast radius.
 *
 * Order matters: the file goes first, then the row. If the unlink fails we still
 * delete the row, because the user's intent is "this frame is gone from my
 * timeline" and a stale row pointing at a missing file would render as a
 * permanently broken thumbnail. (The reverse order would leak the image forever
 * if the row delete then failed.)
 */
export async function deleteFrameForUser(
  frameId: string,
  userId: string,
): Promise<"deleted" | "not_found"> {
  const frame = await db.deviceScreenshot.findFirst({
    where: { id: frameId, device: { userId } },
    select: { id: true, filePath: true },
  });
  if (!frame) return "not_found";

  if (frame.filePath) {
    try {
      const abs = frameAbsPath(frame.filePath);
      assertSafeFramePath(abs);
      await unlink(abs);
    } catch {
      // Already gone, or an unsafe stored path — either way the row must still
      // go, so the user stops seeing a frame they asked us to remove.
    }
  }

  await db.deviceScreenshot.delete({ where: { id: frame.id } });
  return "deleted";
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
