import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

// TASK_127 Phase 1 — device screen capture.
//
// WHY THIS FILE EXISTS: Phase 1's real acceptance is "a real device produces
// real frames on a schedule, and one offline device never breaks the sweep for
// the others" — which otherwise can only be proven by opting a real machine in
// and waiting an hour. Everything below instead exercises the REAL
// `lib/device-screenshots.ts` AND the REAL `lib/resource-governor.ts` (not
// copies of their logic), loaded through the house require hook
// (HOW_WE_MOVE_FAST §4) that swaps only their own dependencies for recording
// fakes.
//
// The governor is NOT faked on purpose: the concurrency cap is enforced by the
// governor reading `capturing` rows, so if this file faked the governor it would
// be testing its own mock instead of the mechanism that actually protects the
// box. `runCapturePass` → `requestSlot` → `deviceScreenshots.liveCount` is the
// real chain under test.
//
// The BROWSER is faked (it is injected — see CaptureFn): no Chromium is launched
// here, and nothing in this file can prove the Playwright sequence works against
// MeshCentral. That is the one acceptance step that stays owner-run, and the
// task doc says so.

process.env.DATABASE_URL = "postgresql://t127:t127@localhost:5432/task127_placeholder";
process.env.SESSION_SECRET = "task127-test-session-secret";
process.env.RESEND_API_KEY = "task127-test-resend";
process.env.EMAIL_FROM = "t127@spaceworker.test";
process.env.APP_BASE_URL = "https://spaceworker.test";
(process.env as Record<string, string>).NODE_ENV = "test";

// Real files really get written and purged: the screenshot root is a real temp
// directory, so the retention rules are tested against an actual filesystem
// rather than a mocked fs.
const SCREENSHOT_ROOT = mkdtempSync(join(tmpdir(), "t127-frames-"));
process.env.SCREENSHOT_BASE_DIR = SCREENSHOT_ROOT;

// ---------------------------------------------------------------------------
// The in-memory stand-ins
// ---------------------------------------------------------------------------

interface DeviceRow {
  id: string;
  userId: string;
  name: string;
  status: string;
  screenshotMonitoringEnabled: boolean;
  screenshotIntervalMinutesOverride: number | null;
  screenshotWakeDelayMinutes: number | null;
  screenshotOnlineSinceAt: Date | null;
}

interface FrameRow {
  id: string;
  deviceId: string;
  userId: string;
  status: string;
  filePath: string | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
  failureReason: string | null;
  summaryDate: Date;
  capturedAt: Date | null;
  createdAt: Date;
}

interface QueueRow {
  id: string;
  feature: string;
  userId: string;
  ref: string | null;
  priority: string;
  status: string;
  position: number;
  promotedAt: Date | null;
  reason: string | null;
  requestedAt: Date;
  grantedAt: Date | null;
  expiresAt: Date | null;
  expiredAt: Date | null;
}

// TASK_152 M6 — the persisted per-user rotation cursor (one row per user).
interface CursorRow {
  id: string;
  userId: string;
  cursorDeviceId: string | null;
  rotatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

let devices: DeviceRow[] = [];
let frames: FrameRow[] = [];
let queue: QueueRow[] = [];
let cursors: CursorRow[] = [];
let audits: Array<Record<string, unknown>> = [];
let idSeq = 0;
let clock = new Date("2026-09-27T12:00:00.000Z");

/** The AdminSetting singleton this test can rewrite per case. */
let adminRow: Record<string, unknown> = {};

/** How many times the injected capture was asked to run. */
let captureCalls: string[] = [];

function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}_${idSeq}`;
}

/** Structural matcher covering exactly the where-clauses the code under test uses. */
function matches(row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [key, expected] of Object.entries(where)) {
    const actual = row[key];
    if (expected === undefined) continue;
    if (expected instanceof Date) {
      if (!(actual instanceof Date) || actual.getTime() !== expected.getTime()) return false;
      continue;
    }
    if (expected !== null && typeof expected === "object") {
      const cond = expected as Record<string, unknown>;
      if (Array.isArray(cond.in)) {
        if (!(cond.in as unknown[]).some((v) => v === actual)) return false;
        continue;
      }
      if ("not" in cond) {
        if (actual === cond.not) return false;
        continue;
      }
      if (cond.lt instanceof Date) {
        if (!(actual instanceof Date) || actual.getTime() >= cond.lt.getTime()) return false;
        continue;
      }
      if (cond.gte instanceof Date) {
        if (!(actual instanceof Date) || actual.getTime() < cond.gte.getTime()) return false;
        continue;
      }
      if (cond.lte instanceof Date) {
        if (!(actual instanceof Date) || actual.getTime() > cond.lte.getTime()) return false;
        continue;
      }
      if (cond.gt instanceof Date) {
        if (!(actual instanceof Date) || actual.getTime() <= cond.gt.getTime()) return false;
        continue;
      }
    }
    if (actual !== expected) return false;
  }
  return true;
}

function pick<T extends Record<string, unknown>>(row: T, select?: Record<string, boolean>): T {
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(select)) if (select[key]) out[key] = row[key];
  return out as T;
}


const fakeDb = {
  device: {
    async findMany(args: { where?: Record<string, unknown>; select?: Record<string, boolean> }) {
      return devices
        .filter((d) => matches({ ...d }, args.where))
        .map((d) => pick({ ...d }, args.select));
    },
    async updateMany(args: { where?: Record<string, unknown>; data: Partial<DeviceRow> }) {
      let count = 0;
      for (const d of devices) {
        if (matches({ ...d }, args.where)) {
          Object.assign(d, args.data);
          count++;
        }
      }
      return { count };
    },
  },
  deviceScreenshot: {
    async create(args: { data: Partial<FrameRow>; select?: Record<string, boolean> }) {
      const row: FrameRow = {
        id: nextId("frame"),
        deviceId: String(args.data.deviceId),
        userId: String(args.data.userId),
        status: String(args.data.status ?? "capturing"),
        filePath: args.data.filePath ?? null,
        bytes: args.data.bytes ?? null,
        width: args.data.width ?? null,
        height: args.data.height ?? null,
        failureReason: args.data.failureReason ?? null,
        summaryDate: args.data.summaryDate ?? clock,
        capturedAt: args.data.capturedAt ?? null,
        createdAt: args.data.createdAt ?? new Date(clock.getTime()),
      };
      frames.push(row);
      return pick({ ...row }, args.select);
    },
    async update(args: { where: { id: string }; data: Partial<FrameRow> }) {
      const row = frames.find((f) => f.id === args.where.id);
      if (!row) throw new Error("frame not found");
      Object.assign(row, args.data);
      return { ...row };
    },
    async updateMany(args: { where?: Record<string, unknown>; data: Partial<FrameRow> }) {
      const hit = frames.filter((f) => matches({ ...f }, args.where));
      for (const row of hit) Object.assign(row, args.data);
      return { count: hit.length };
    },
    async findMany(args: {
      where?: Record<string, unknown>;
      select?: Record<string, boolean>;
      orderBy?: { createdAt?: "asc" | "desc"; capturedAt?: "asc" | "desc" };
      take?: number;
      distinct?: string[];
    }) {
      let rows = frames.filter((f) => matches({ ...f }, args.where));
      if (args.orderBy?.createdAt === "desc") {
        rows = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      }
      if (args.orderBy?.createdAt === "asc") {
        rows = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      }
      if (args.distinct?.includes("deviceId")) {
        const seen = new Set<string>();
        rows = rows.filter((r) => (seen.has(r.deviceId) ? false : (seen.add(r.deviceId), true)));
      }
      // TASK_152 M6 — the scheduler asks for the distinct OWNERS holding a
      // capture right now (to count "active users" for the fair-share split).
      if (args.distinct?.includes("userId")) {
        const seen = new Set<string>();
        rows = rows.filter((r) => (seen.has(r.userId) ? false : (seen.add(r.userId), true)));
      }
      if (typeof args.take === "number") rows = rows.slice(0, args.take);
      return rows.map((r) => pick({ ...r }, args.select));
    },
    async groupBy(args: {
      by: string[];
      where?: Record<string, unknown>;
      _max?: Record<string, boolean>;
    }) {
      const rows = frames.filter((f) => matches({ ...f }, args.where));
      const byDevice = new Map<string, Date>();
      for (const row of rows) {
        const prev = byDevice.get(row.deviceId);
        if (!prev || row.createdAt.getTime() > prev.getTime()) {
          byDevice.set(row.deviceId, row.createdAt);
        }
      }
      return [...byDevice.entries()].map(([deviceId, createdAt]) => ({
        deviceId,
        _max: { createdAt },
      }));
    },
    async count(args: { where?: Record<string, unknown> }) {
      return frames.filter((f) => matches({ ...f }, args.where)).length;
    },
    async delete(args: { where: { id: string } }) {
      const idx = frames.findIndex((f) => f.id === args.where.id);
      if (idx === -1) throw new Error("frame not found");
      return frames.splice(idx, 1)[0];
    },
    async deleteMany(args: { where?: Record<string, unknown> }) {
      const before = frames.length;
      frames = frames.filter((f) => !matches({ ...f }, args.where));
      return { count: before - frames.length };
    },
  },
  // TASK_152 M6 — the persisted rotation cursor. `upsert` is the real call the
  // post-loop write makes; `findMany` is the pre-loop read. Narrow on purpose:
  // only the where/select shapes the scheduler actually uses.
  screenshotRotationCursor: {
    async findMany(args: { where?: Record<string, unknown> }) {
      return cursors.filter((c) => matches({ ...c }, args.where)).map((c) => ({ ...c }));
    },
    async upsert(args: {
      where: { userId: string };
      create: { userId: string; cursorDeviceId: string; rotatedAt: Date };
      update: { cursorDeviceId: string; rotatedAt: Date };
    }) {
      const existing = cursors.find((c) => c.userId === args.where.userId);
      if (existing) {
        existing.cursorDeviceId = args.update.cursorDeviceId;
        existing.rotatedAt = args.update.rotatedAt;
        existing.updatedAt = new Date(clock.getTime());
        return { ...existing };
      }
      const row: CursorRow = {
        id: nextId("cursor"),
        userId: args.create.userId,
        cursorDeviceId: args.create.cursorDeviceId,
        rotatedAt: args.create.rotatedAt,
        createdAt: new Date(clock.getTime()),
        updatedAt: new Date(clock.getTime()),
      };
      cursors.push(row);
      return { ...row };
    },
  },
};

const fakeQueue = {
  async findFirst(args: { where?: Record<string, unknown>; orderBy?: { requestedAt?: "asc" | "desc" } }) {
    const rows = queue.filter((q) => matches({ ...q }, args.where));
    if (args.orderBy?.requestedAt === "desc") {
      rows.sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime());
    }
    return rows[0] ? { ...rows[0] } : null;
  },
  async findMany(args: { where?: Record<string, unknown> }) {
    return queue.filter((q) => matches({ ...q }, args.where)).map((q) => ({ ...q }));
  },
  async create(args: { data: Partial<QueueRow> }) {
    const row: QueueRow = {
      id: nextId("q"),
      feature: String(args.data.feature),
      userId: String(args.data.userId),
      ref: args.data.ref ?? null,
      priority: String(args.data.priority ?? "standard"),
      status: String(args.data.status ?? "queued"),
      position: args.data.position ?? 0,
      promotedAt: args.data.promotedAt ?? null,
      reason: args.data.reason ?? null,
      requestedAt: args.data.requestedAt ?? new Date(clock.getTime()),
      grantedAt: args.data.grantedAt ?? null,
      expiresAt: args.data.expiresAt ?? null,
      expiredAt: args.data.expiredAt ?? null,
    };
    queue.push(row);
    return { ...row };
  },
  async update(args: { where: { id: string }; data: Partial<QueueRow> }) {
    const row = queue.find((q) => q.id === args.where.id);
    if (row) Object.assign(row, args.data);
    return { ...(row as QueueRow) };
  },
  async updateMany(args: { where?: Record<string, unknown>; data: Partial<QueueRow> }) {
    const hit = queue.filter((q) => matches({ ...q }, args.where));
    for (const row of hit) Object.assign(row, args.data);
    return { count: hit.length };
  },
};

// ---------------------------------------------------------------------------
// Require hook: only the module under test's own dependencies are swapped.
// ---------------------------------------------------------------------------

type Loader = {
  _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};

// The governor is deliberately NOT swapped — it is the real one, so the cap
// being tested is the real cap. Its OWN deps must therefore be swapped too,
// which is why both files are listed as parents.
const SWAPPED_PARENTS = ["lib/device-screenshots.ts", "lib/resource-governor.ts"];

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    const from = parent?.filename ?? "";
    if (SWAPPED_PARENTS.some((p) => from.endsWith(`/${p}`))) {
      if (request === "./db") return { db: { ...fakeDb, governorQueueEntry: fakeQueue } };
      if (request === "./admin-settings") return { getAdminSettings: async () => ({ ...adminRow }) };
      // Non-premium, no grants => priority "trial": the strictest class, so a
      // grant in these tests can only come from real capacity, never a bypass.
      if (request === "./entitlements") {
        return { listEffectiveEntitlements: async () => ({ premium: false, keys: [], grants: [] }) };
      }
      if (request === "./devices") {
        return {
          recordAgentActionAudit: async (call: Record<string, unknown>) => {
            audits.push({ ...call, createdAt: new Date(1_700_000_000_000 + audits.length) });
          },
        };
      }
    }
    return original.call(this, request, parent, isMain);
  };
}

installRequireHook();

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  resolveScreenshotSettings,
  runCapturePass,
  reapStuckCaptures,
  purgeExpiredFrames,
  listDueDevices,
  listRecentFrames,
  resolveEffectiveIntervalMinutes,
  frameRelPath,
  frameAbsPath,
  frameRelPathFromAbs,
  assertSafeFramePath,
  startOfUtcDay,
  screenshotBaseDir,
  CAPTURE_STUCK_MS,
  countCapturing,
  SCREENSHOT_ROTATION_SLICE_MIN_MINUTES,
  SCREENSHOT_ROTATION_SLICE_MAX_MINUTES,
  SCREENSHOT_HEADROOM_MIN_PCT,
  SCREENSHOT_HEADROOM_MAX_PCT,
} = require("../lib/device-screenshots") as typeof import("../lib/device-screenshots");
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * TASK_152 M6 — simulate a PROCESS RESTART: drop `lib/device-screenshots` from
 * the require cache and re-require it, yielding a genuinely fresh module instance
 * (a DIFFERENT function object) that shares nothing with the first but the
 * injected fake DB. Because the scheduler keeps no in-memory scheduling state,
 * anything that survives this is, by construction, the persisted cursor.
 */
function reloadRunCapturePass(): typeof runCapturePass {
  const key = require.resolve("../lib/device-screenshots");
  delete require.cache[key];
  /* eslint-disable @typescript-eslint/no-require-imports */
  const fresh = require("../lib/device-screenshots") as typeof import("../lib/device-screenshots");
  /* eslint-enable @typescript-eslint/no-require-imports */
  return fresh.runCapturePass;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A forced pressure snapshot — no /proc, no Linux box (same shape as TASK_105's). */
const NORMAL = {
  level: "normal",
  measured: true,
  ramUsedPct: 20,
  ramTotalMb: 24000,
  ramAvailableMb: 8000,
  swapUsedMb: 0,
  swapTotalMb: 0,
  load1: 0.2,
  cpuCount: 4,
  reason: "",
} as import("../lib/resource-governor").PressureSnapshot;

/**
 * A forced HARD snapshot — the box is out of headroom. The governor refuses the
 * soft queue and holds work in line; the scheduler must NOT treat this as
 * parallelism (TASK_152 M6 headroom rule).
 */
const HARD = {
  ...NORMAL,
  level: "hard",
  ramUsedPct: 95,
  reason: "test_hard",
} as import("../lib/resource-governor").PressureSnapshot;

function addDevice(
  id: string,
  opts: {
    userId?: string;
    status?: string;
    optIn?: boolean;
    name?: string;
    intervalOverride?: number | null;
    wakeDelayMinutes?: number | null;
    onlineSinceAt?: Date | null;
  } = {},
): void {
  devices.push({
    id,
    userId: opts.userId ?? "user_1",
    name: opts.name ?? `Device ${id}`,
    status: opts.status ?? "online",
    screenshotMonitoringEnabled: opts.optIn ?? true,
    screenshotIntervalMinutesOverride: opts.intervalOverride ?? null,
    screenshotWakeDelayMinutes: opts.wakeDelayMinutes ?? null,
    screenshotOnlineSinceAt: opts.onlineSinceAt ?? null,
  });
}

/** A capture that "succeeds": writes a real file, exactly like the real one. */
function okCapture() {
  return async (device: { id: string }, framePath: string) => {
    captureCalls.push(device.id);
    await writeFile(framePath, Buffer.from("PNGDATA"));
    return {
      filePath: relative(screenshotBaseDir(), framePath),
      bytes: 7,
      width: 1440,
      height: 900,
    };
  };
}

/**
 * A capture that succeeds but TAKES TIME — use this for every concurrency test.
 *
 * The cap is enforced against the number of `capturing` rows, so it is only
 * observable while a capture is genuinely in flight. A real capture takes tens
 * of seconds (browser launch + navigation + settle), and `runCapturePass` starts
 * each admitted capture immediately, so an INSTANT fake resolves before the loop
 * has even considered the next device — and then the cap looks broken when it is
 * not. 300ms is orders of magnitude longer than the in-memory work the loop does
 * per device, which is what makes these assertions deterministic rather than
 * timing-dependent.
 */
function slowCapture(ms = 300) {
  return async (device: { id: string }, framePath: string) => {
    captureCalls.push(device.id);
    await new Promise((resolve) => setTimeout(resolve, ms));
    await writeFile(framePath, Buffer.from("PNGDATA"));
    return {
      filePath: relative(screenshotBaseDir(), framePath),
      bytes: 7,
      width: 1440,
      height: 900,
    };
  };
}

function frame(deviceId: string, over: Partial<FrameRow> = {}): FrameRow {
  const row: FrameRow = {
    id: nextId("frame"),
    deviceId,
    userId: "user_1",
    status: "captured",
    filePath: null,
    bytes: null,
    width: null,
    height: null,
    failureReason: null,
    summaryDate: startOfUtcDay(clock),
    capturedAt: new Date(clock.getTime()),
    createdAt: new Date(clock.getTime()),
    ...over,
  };
  frames.push(row);
  return row;
}

const capturedFrames = () => frames.filter((f) => f.status === "captured");
const capturingFrames = () => frames.filter((f) => f.status === "capturing");
const deviceQueue = () => queue.filter((q) => q.feature === "deviceScreenshots");
/** TASK_152 M6 — the persisted rotation cursor for a user, or undefined. */
const cursorFor = (userId: string) => cursors.find((c) => c.userId === userId);
/** Devices captured so far, in order. */
const capturedIds = () => capturedFrames().map((f) => f.deviceId);
/** Move the shared clock forward, so rotation slice windows can elapse. */
const advanceMinutes = (m: number): void => {
  clock = new Date(clock.getTime() + m * 60_000);
};

beforeEach(() => {
  devices = [];
  frames = [];
  queue = [];
  cursors = [];
  audits = [];
  idSeq = 0;
  captureCalls = [];
  clock = new Date("2026-09-27T12:00:00.000Z");
  // Default to ENABLED with the schema's own defaults (cap 2, hourly, 14 days)
  // so each test overrides only what it is actually about. Note the GOVERNOR's
  // own master switch is left at its default (off) — the capture cap must bind
  // either way, and that is asserted explicitly below.
  adminRow = {
    screenshotMonitoringEnabled: true,
    screenshotCapturesMaxConcurrent: 2,
    screenshotCaptureIntervalMinutes: 60,
    screenshotRetentionDays: 14,
  };
});

// ---------------------------------------------------------------------------
// Settings + paths (pure)
// ---------------------------------------------------------------------------

test("settings fall back to the schema defaults and clamp nonsense to sane floors", () => {
  const defaults = resolveScreenshotSettings({});
  assert.equal(defaults.enabled, false, "monitoring is opt-in");
  assert.equal(defaults.maxConcurrent, 2, "owner decision: start at 2");
  assert.equal(defaults.intervalMinutes, 60);
  assert.equal(defaults.retentionDays, 14);
  // TASK_152 M6 — the scheduler dials resolve to "inherit the governor's warn
  // line" (75) and the owner's 25-minute rotation slice.
  assert.equal(defaults.headroomRamPct, 75, "0 = inherit governorRamWarnPct (75)");
  assert.equal(defaults.rotationSliceMinutes, 25, "owner figure: every 20-30 min");
  // TASK_168 Bug B — the summary budget dial at the old hardcoded default.
  assert.equal(defaults.summaryMaxCalls, 8, "8 calls = 24 frames/day, the old hardcode");

  // A missing row must be as safe as an empty one.
  assert.deepEqual(resolveScreenshotSettings(null), defaults);

  // A stored 0/negative is never allowed to mean "capture constantly" or
  // "delete each frame immediately".
  const silly = resolveScreenshotSettings({
    screenshotMonitoringEnabled: true,
    screenshotCapturesMaxConcurrent: 0,
    screenshotCaptureIntervalMinutes: 0,
    screenshotRetentionDays: 0,
    screenshotSummaryMaxCallsPerDevicePerDay: 0,
  });
  assert.equal(silly.enabled, true);
  assert.equal(silly.maxConcurrent, 2);
  assert.equal(silly.intervalMinutes, 60);
  assert.equal(silly.retentionDays, 14);
  assert.equal(silly.summaryMaxCalls, 8, "a 0 budget falls back, never means summarise-nothing");

  // A real value is honoured — including 1 (the RAM-measuring setting).
  const one = resolveScreenshotSettings({
    screenshotMonitoringEnabled: true,
    screenshotCapturesMaxConcurrent: 1,
    screenshotCaptureIntervalMinutes: 1,
    screenshotRetentionDays: 1,
    screenshotSummaryMaxCallsPerDevicePerDay: 2,
  });
  assert.deepEqual(one, {
    enabled: true,
    maxConcurrent: 1,
    intervalMinutes: 1,
    retentionDays: 1,
    // M6 fields, at their resolved defaults (no governor row => warn 75).
    headroomRamPct: 75,
    rotationSliceMinutes: 25,
    // TASK_168 Bug B — the dial is honoured, not clamped to the old hardcode.
    summaryMaxCalls: 2,
  });
});

test("frame paths are relative, grouped by device and UTC day, and traversal-proof", () => {
  // 23:30 UTC is the interesting case: the day bucket must be UTC, not local.
  const late = new Date("2026-09-27T23:30:00.000Z");
  assert.equal(frameRelPath("dev1", late, "frame9"), join("dev1", "2026-09-27", "frame9.png"));
  assert.equal(
    startOfUtcDay(late).toISOString(),
    "2026-09-27T00:00:00.000Z",
    "the day boundary is UTC",
  );

  // The stored path is RELATIVE — an absolute path in a row would break the
  // moment the screenshot root moved.
  assert.equal(frameRelPath("dev1", late, "f"), frameRelPath("dev1", late, "f"));
  assert.ok(!frameRelPath("dev1", late, "f").startsWith("/"));

  const good = frameAbsPath(join("dev1", "2026-09-27", "f.png"));
  assert.doesNotThrow(() => assertSafeFramePath(good));

  // A row is DATA: it must never be able to address a file outside the root.
  assert.throws(
    () => assertSafeFramePath(resolve(SCREENSHOT_ROOT, "..", "escaped.png")),
    /Path traversal/,
  );
  assert.throws(
    () => assertSafeFramePath(resolve(SCREENSHOT_ROOT, "..", "..", "etc", "passwd")),
    /Path traversal/,
  );
});

test("an absolute frame path converts back to the ONE relative form a row stores", () => {
  // The capture service is handed an absolute path (it writes the file) while the
  // row stores only the relative form, so this conversion has to be exact —
  // otherwise the row would point at a file that is not where it claims.
  const rel = join("dev1", "2026-09-27", "f.png");
  assert.equal(frameRelPathFromAbs(frameAbsPath(rel)), rel);
  assert.ok(!frameRelPathFromAbs(frameAbsPath(rel)).startsWith("/"));

  // And the traversal guard applies on the way BACK too: a path outside the root
  // cannot be laundered into a row by asking for its relative form.
  assert.throws(
    () => frameRelPathFromAbs(resolve(SCREENSHOT_ROOT, "..", "escaped.png")),
    /Path traversal/,
  );
});

// ---------------------------------------------------------------------------
// The capture pass
// ---------------------------------------------------------------------------

test("with monitoring OFF nothing is captured, nothing is persisted, nothing is deleted", async () => {
  adminRow.screenshotMonitoringEnabled = false;
  addDevice("d1");
  addDevice("d2");
  // An old frame that WOULD be purged if the pass did any housekeeping. Note it
  // is a previously-CAPTURED frame, so "nothing captured" must be judged by the
  // pass adding no row — not by counting captured frames in the fixture.
  frame("d1", { summaryDate: startOfUtcDay(new Date(clock.getTime() - 40 * 86_400_000)) });
  const rowsBefore = frames.length;

  const result = await runCapturePass(okCapture(), { now: clock, pressure: NORMAL });

  assert.equal(result.skipped, "disabled");
  assert.equal(result.attempted, 0);
  assert.equal(result.purged, 0, "off means off — not even retention runs");
  assert.equal(captureCalls.length, 0, "no browser was ever launched");
  assert.equal(frames.length, rowsBefore, "the pass added no row at all");
  assert.equal(queue.length, 0, "a disabled feature never takes a place in line");
});

test("the cap admits two captures and ROTATES the rest — the excess waits its turn (start at 2, per the owner)", async () => {
  adminRow.screenshotCapturesMaxConcurrent = 2;
  addDevice("d1");
  addDevice("d2");
  addDevice("d3");

  const result = await runCapturePass(slowCapture(), { now: clock, pressure: NORMAL });

  assert.equal(result.attempted, 2);
  assert.equal(result.captured, 2);
  assert.equal(result.failed, 0);
  // TASK_152 M6 — 3 eligible devices against 2 granted slots is now ROTATION, so
  // the third device is DEFERRED (not yet its turn), never offered to — and so
  // never queued by — the governor. It is NOT a failure and it produces no row.
  assert.equal(result.queued, 0, "a deferred device is never put in the governor queue");
  assert.equal(result.deferred, 1, "the third device waits for a later rotation slice");
  assert.equal(result.rotatingUsers, 1, "one user is rotating");
  // The cap is on the BROWSER, so it must be visible as exactly 2 launched.
  assert.equal(captureCalls.length, 2);
  assert.equal(capturedFrames().length, 2);

  // The third device was never touched: no browser, no row, no slot.
  assert.ok(!captureCalls.includes("d3"), "the third device must not be captured");
  assert.equal(frames.filter((f) => f.deviceId === "d3").length, 0);
});

test("cap 1 admits exactly one capture — the setting the owner will use to measure RAM", async () => {
  adminRow.screenshotCapturesMaxConcurrent = 1;
  addDevice("d1");
  addDevice("d2");
  addDevice("d3");

  const result = await runCapturePass(slowCapture(), { now: clock, pressure: NORMAL });

  assert.equal(result.attempted, 1);
  assert.equal(result.captured, 1);
  assert.equal(captureCalls.length, 1);
  assert.equal(capturedFrames().length, 1);
});

test("the capture cap binds even with the governor's master switch OFF, and persists nothing", async () => {
  // This is the default state of the box: governor off, monitoring on.
  adminRow.governorEnabled = false;
  adminRow.screenshotCapturesMaxConcurrent = 1;
  addDevice("d1");
  addDevice("d2");

  const result = await runCapturePass(slowCapture(), { now: clock, pressure: NORMAL });

  assert.equal(result.attempted, 1, "the feature cap still protects the box");
  // TASK_152 M6 — the second device is ROTATED (deferred), not queued: with the
  // governor off there is no queue at all, and rotation is what keeps it alive to
  // run on a later slice.
  assert.equal(result.deferred, 1);
  assert.equal(result.queued, 0);
  assert.equal(
    queue.length,
    0,
    "with the governor off it must not write queue rows — that is exactly the pre-TASK_105 behaviour",
  );
});

test("with the governor ON a queued device gets ONE durable row that a later pass reuses", async () => {
  // TASK_152 M6 — a SINGLE device whose user's roster fits their slots is offered
  // to the governor even when the box is under hard pressure: it is the governor,
  // not the scheduler, that then holds it in line. (A user whose roster EXCEEDS
  // their slots is served by ROTATION instead and never reaches the queue — that is
  // asserted by the rotation tests.) This keeps TASK_105's idempotent-queue-row
  // behaviour under test on the path M6 leaves open.
  adminRow.governorEnabled = true;
  adminRow.screenshotCapturesMaxConcurrent = 1;
  addDevice("d1");

  const pass1 = await runCapturePass(slowCapture(), { now: clock, pressure: HARD });
  assert.equal(pass1.queued, 1, "hard pressure puts the device in line");
  assert.equal(pass1.captured, 0, "nothing is captured under hard pressure");

  const pass2 = await runCapturePass(slowCapture(), { now: clock, pressure: HARD });
  assert.equal(pass2.queued, 1, "the still-due device is offered again");

  const waiting = deviceQueue().filter((q) => q.status === "queued");
  assert.equal(waiting.length, 1, "a re-ask must REUSE d1's one queue row, not add another");
  assert.equal(waiting[0].ref, "d1", "the row is keyed by device id, which is what makes it idempotent");
  assert.equal(captureCalls.length, 0, "a queued device launches no browser");
});

test("a capture that records a real frame stores its path and true size", async () => {
  addDevice("d1");

  const result = await runCapturePass(okCapture(), { now: clock, pressure: NORMAL });

  assert.equal(result.captured, 1);
  const row = capturedFrames()[0];
  assert.ok(row.filePath, "the row must point at the frame");
  assert.ok(!row.filePath!.startsWith("/"), "the stored path is relative to the screenshot root");
  assert.equal(row.bytes, 7);
  assert.equal(row.width, 1440);
  assert.equal(row.height, 900);
  assert.ok(row.capturedAt, "capturedAt is stamped on completion");
  assert.equal(row.summaryDate.toISOString(), startOfUtcDay(clock).toISOString());

  // The FILE is really on disk at the path the row claims — the whole point of
  // storing a path instead of the bytes.
  assert.ok(existsSync(frameAbsPath(row.filePath!)), "the frame exists where the row says it does");
  assert.equal((await readFile(frameAbsPath(row.filePath!))).toString(), "PNGDATA");
});

test("a capture that throws becomes a FAILED row and never leaves a slot held", async () => {
  addDevice("d1");
  const boom = async () => {
    captureCalls.push("d1");
    throw new Error("chromium_launch_failed");
  };

  const result = await runCapturePass(boom, { now: clock, pressure: NORMAL });

  assert.equal(result.failed, 1);
  assert.equal(capturedFrames().length, 0);
  assert.equal(capturingFrames().length, 0, "the slot must be released, not leaked");
  const row = frames[0];
  assert.equal(row.status, "failed");
  assert.match(String(row.failureReason), /chromium_launch_failed/);

  // A failure is not retried on the very next tick: the failed row counts as the
  // last attempt, so a permanently broken device cannot hot-loop the browser.
  const again = await runCapturePass(boom, { now: clock, pressure: NORMAL });
  assert.equal(again.skipped, "no_devices");
  assert.equal(captureCalls.length, 1);
});

test("a capture that reports a reason (device went offline) records it without a file", async () => {
  addDevice("d1");
  const wentOffline = async () => {
    captureCalls.push("d1");
    return { failureReason: "device_offline" };
  };

  const result = await runCapturePass(wentOffline, { now: clock, pressure: NORMAL });

  assert.equal(result.failed, 1);
  assert.equal(frames[0].status, "failed");
  assert.equal(frames[0].failureReason, "device_offline");
  assert.equal(frames[0].filePath, null, "no frame was written, so no path is claimed");
  assert.equal(capturingFrames().length, 0);
});

test("an offline device is skipped, never failed — and never breaks the others", async () => {
  addDevice("sleepy", { status: "offline" });
  addDevice("awake", { status: "online" });

  const due = await listDueDevices(clock, 60);
  assert.deepEqual(due.map((d) => d.id), ["awake"]);

  const result = await runCapturePass(okCapture(), { now: clock, pressure: NORMAL });

  assert.equal(result.captured, 1);
  assert.deepEqual(captureCalls, ["awake"]);
  assert.equal(
    frames.filter((f) => f.deviceId === "sleepy").length,
    0,
    "a sleeping device gets no row at all — not even a failure",
  );
});

test("a device is only due once its interval has actually elapsed", async () => {
  addDevice("d1");
  // Captured 59 minutes ago, interval is 60 => not due yet.
  frame("d1", { createdAt: new Date(clock.getTime() - 59 * 60_000) });
  assert.deepEqual(await listDueDevices(clock, 60), [], "not due one minute early");

  // Captured 61 minutes ago => due.
  frames = [];
  frame("d1", { createdAt: new Date(clock.getTime() - 61 * 60_000) });
  assert.deepEqual((await listDueDevices(clock, 60)).map((d) => d.id), ["d1"]);

  // A device that has NEVER been captured is due immediately.
  frames = [];
  assert.deepEqual((await listDueDevices(clock, 60)).map((d) => d.id), ["d1"]);
});

// ---------------------------------------------------------------------------
// TASK_152 M4 — user-configurable cadence (the admin global is a CEILING)
// ---------------------------------------------------------------------------

test("effective cadence resolver: the global is a default with no override and a ceiling with one", () => {
  // No override / non-positive override => the global, exactly as before.
  assert.equal(resolveEffectiveIntervalMinutes(60, null), 60);
  assert.equal(resolveEffectiveIntervalMinutes(60, undefined), 60);
  assert.equal(resolveEffectiveIntervalMinutes(60, 0), 60);
  // An override may make a device LESS frequent (a larger interval)...
  assert.equal(resolveEffectiveIntervalMinutes(60, 120), 120);
  // ...or match the admin's cadence exactly...
  assert.equal(resolveEffectiveIntervalMinutes(60, 60), 60);
  // ...but NEVER more frequent than the admin allows: a smaller value is capped
  // to the ceiling here too, so a legacy/hand-written row cannot out-run the
  // admin's bound even if the edge validation were ever bypassed.
  assert.equal(resolveEffectiveIntervalMinutes(60, 5), 60);
});

test("a per-device override SLOWS a device: not due when the global cadence would be due", async () => {
  // Two devices, both last captured 90 minutes ago. The plain device's global
  // cadence (60) has elapsed, so it IS due; the 120-minute override has not.
  addDevice("slow", { intervalOverride: 120 });
  addDevice("plain");
  frame("slow", { createdAt: new Date(clock.getTime() - 90 * 60_000) });
  frame("plain", { createdAt: new Date(clock.getTime() - 90 * 60_000) });

  const due = await listDueDevices(clock, 60);

  assert.deepEqual(
    due.map((d) => d.id),
    ["plain"],
    "the override really changes WHO is due, not just what is stored",
  );
});

test("a per-device override cannot make a device due EARLIER than the global (ceiling enforced at schedule time)", async () => {
  // A stored 30-minute override while the admin cadence is 60. 45 minutes have
  // elapsed: if the stored override were honoured this device would be due, but
  // the admin ceiling says not yet.
  addDevice("fast", { intervalOverride: 30 });
  frame("fast", { createdAt: new Date(clock.getTime() - 45 * 60_000) });
  assert.deepEqual(await listDueDevices(clock, 60), [], "30 < global 60 is capped to the global");

  // Once the GLOBAL interval has elapsed it becomes due, exactly like a device
  // with no override — the ceiling, not the stored value, drives the schedule.
  frames = [];
  frame("fast", { createdAt: new Date(clock.getTime() - 61 * 60_000) });
  assert.deepEqual((await listDueDevices(clock, 60)).map((d) => d.id), ["fast"]);
});

test("a device with no override is unchanged by M4 (default path)", async () => {
  addDevice("d1"); // no override, no wake delay
  frame("d1", { createdAt: new Date(clock.getTime() - 59 * 60_000) });
  assert.deepEqual(await listDueDevices(clock, 60), [], "not due one minute early");
  frames = [];
  frame("d1", { createdAt: new Date(clock.getTime() - 61 * 60_000) });
  assert.deepEqual((await listDueDevices(clock, 60)).map((d) => d.id), ["d1"], "due after the global cadence");
});

test("a wake delay holds a device back even though it never captured before", async () => {
  // Just came online this exact tick (no onlineSinceAt stamped yet) and wants
  // a 10-minute grace period before its first capture.
  addDevice("d1", { wakeDelayMinutes: 10 });
  const firstPass = await listDueDevices(clock, 60);
  assert.deepEqual(firstPass, [], "not due the instant it's first seen online — the anchor just got stamped");

  // 5 minutes later: still inside the 10-minute delay.
  const soon = new Date(clock.getTime() + 5 * 60_000);
  assert.deepEqual(await listDueDevices(soon, 60), [], "still inside the wake delay");

  // 11 minutes after the ORIGINAL pass (which is when the anchor was stamped):
  // past the delay, and no prior capture, so it's due.
  const later = new Date(clock.getTime() + 11 * 60_000);
  assert.deepEqual((await listDueDevices(later, 60)).map((d) => d.id), ["d1"]);
});

test("wake delay is measured from the MOST RECENT wake, not a stale one", async () => {
  addDevice("d1", { wakeDelayMinutes: 10, onlineSinceAt: new Date(clock.getTime() - 60 * 60_000) });
  // If the stale anchor (an hour ago) were honoured, this would already be due.
  // But the device is now OFFLINE, so a pass must clear that anchor first.
  devices[0].status = "offline";
  await listDueDevices(clock, 60);
  assert.equal(devices[0].screenshotOnlineSinceAt, null, "the stale anchor is cleared while offline");

  // Now it comes back online: a fresh pass re-stamps the anchor to NOW, so the
  // 10-minute delay starts over, not from the hour-old anchor.
  devices[0].status = "online";
  assert.deepEqual(await listDueDevices(clock, 60), [], "freshly re-anchored — the delay starts again from now");
  assert.deepEqual(
    (await listDueDevices(new Date(clock.getTime() + 11 * 60_000), 60)).map((d) => d.id),
    ["d1"],
    "due once the FRESH delay has elapsed",
  );
});

test("no wake delay set behaves exactly like today — due as soon as online and past interval", async () => {
  addDevice("d1"); // wakeDelayMinutes defaults to null
  assert.deepEqual((await listDueDevices(clock, 60)).map((d) => d.id), ["d1"]);
});

test("a device whose capture is still in flight is never asked twice", async () => {
  addDevice("d1");
  frame("d1", { status: "capturing" });

  assert.deepEqual(await listDueDevices(clock, 60), [], "in-flight devices are not due");

  const result = await runCapturePass(okCapture(), { now: clock, pressure: NORMAL });
  assert.equal(result.skipped, "no_devices");
  assert.equal(captureCalls.length, 0, "no second browser for the same device");
  assert.equal(capturingFrames().length, 1, "the original in-flight row is untouched");
});

test("reaping releases the slot of a capture whose worker died", async () => {
  addDevice("d1");
  // Started two hours ago: past BOTH the reaper's 5-minute stuck threshold AND
  // the 60-minute capture interval, so the device is due the moment the slot
  // frees. (A row only 6 minutes old is reaped but still not due — which is
  // correct behaviour, and is why this fixture is deliberately older.)
  const deadAt = new Date(clock.getTime() - 2 * 60 * 60 * 1000);
  const dead = frame("d1", { status: "capturing", createdAt: deadAt });
  assert.ok(deadAt.getTime() < clock.getTime() - CAPTURE_STUCK_MS, "past the stuck threshold");
  // And a healthy in-flight row that must NOT be touched.
  const live = frame("d2", { status: "capturing", createdAt: new Date(clock.getTime()) });

  const reaped = await reapStuckCaptures(clock);

  assert.equal(reaped, 1);
  assert.equal(dead.status, "failed");
  assert.equal(dead.failureReason, "worker_timeout");
  assert.equal(live.status, "capturing", "a young capture is left alone");

  // The slot really is free again: the device becomes due.
  assert.deepEqual((await listDueDevices(clock, 60)).map((d) => d.id), ["d1"]);
});

test("a pass reaps a dead worker before deciding who is due", async () => {
  adminRow.screenshotCapturesMaxConcurrent = 1;
  addDevice("dead");
  // Same reasoning as the reaping test: two hours old, so it is both reapable
  // AND due, which is what lets this test prove the freed slot is reused by the
  // very same pass rather than on some later tick.
  frame("dead", {
    status: "capturing",
    createdAt: new Date(clock.getTime() - 2 * 60 * 60 * 1000),
  });

  const result = await runCapturePass(okCapture(), { now: clock, pressure: NORMAL });

  assert.equal(result.reaped, 1);
  assert.equal(result.captured, 1, "the freed slot was used by the same pass");
  assert.deepEqual(captureCalls, ["dead"]);
});

test("retention deletes the file AND the row, and leaves fresh frames alone", async () => {
  addDevice("d1");
  // An expired frame with a REAL file on disk.
  const rel = join("d1", "2026-08-01", "old.png");
  const abs = frameAbsPath(rel);
  await mkdir(frameAbsPath(join("d1", "2026-08-01")), { recursive: true });
  await writeFile(abs, Buffer.from("OLDPNG"));
  const old = frame("d1", {
    summaryDate: startOfUtcDay(new Date(clock.getTime() - 20 * 86_400_000)),
    filePath: rel,
  });
  const freshRel = join("d1", "2026-09-27", "new.png");
  const freshAbs = frameAbsPath(freshRel);
  await writeFile(freshAbs, Buffer.from("NEWPNG"));
  const fresh = frame("d1", { summaryDate: startOfUtcDay(clock), filePath: freshRel });

  const purged = await purgeExpiredFrames(clock, 14);

  assert.equal(purged, 1);
  assert.ok(!existsSync(abs), "the expired frame's FILE is gone, not just its row");
  assert.ok(!frames.some((f) => f.id === old.id));
  assert.ok(existsSync(freshAbs), "a frame inside the window is kept");
  assert.ok(frames.some((f) => f.id === fresh.id));
});

test("retention never deletes a row that is still capturing", async () => {
  addDevice("d1");
  const inFlight = frame("d1", {
    status: "capturing",
    summaryDate: startOfUtcDay(new Date(clock.getTime() - 60 * 86_400_000)),
  });

  const purged = await purgeExpiredFrames(clock, 14);

  assert.equal(purged, 0);
  assert.ok(frames.some((f) => f.id === inFlight.id), "an old in-flight row is still waiting to finish");
});

test("listRecentFrames returns a device's frames newest first", async () => {
  addDevice("d1");
  frame("d1", { createdAt: new Date(clock.getTime() - 120_000) });
  frame("d1", { createdAt: new Date(clock.getTime()) });
  frame("d2", { createdAt: new Date(clock.getTime()) });

  const view = await listRecentFrames("d1", 10);

  assert.equal(view.length, 2, "only this device's frames");
  assert.ok(
    new Date(view[0].createdAt).getTime() > new Date(view[1].createdAt).getTime(),
    "newest first",
  );
  assert.equal(typeof view[0].createdAt, "string", "timestamps are serialised for the API");
});

test("the screenshot root is outside the application directory", () => {
  // Documented invariant, asserted so a careless default cannot move frames back
  // inside the app dir (where `next build` would choke on unreadable files and
  // where they could be served as static assets).
  const root = screenshotBaseDir();
  assert.ok(!root.includes("/spaceworker/"), `screenshot root must be outside the repo: ${root}`);
});

// ---------------------------------------------------------------------------
// TASK_152 M6 — the capture scheduler: headroom concurrency, fairness, rotation
// ---------------------------------------------------------------------------
//
// SCOPE: these drive the REAL scheduler and the REAL governor against the
// in-memory stand-ins above. There is no real device VM or browser here, so
// nothing below proves a capture actually reached a real machine — that step is
// owner-run and is labelled as such in the task doc. What IS proven here is the
// scheduling DECISION (who is offered, deferred, rotated, throttled) and the
// persisted cursor, with raw counts asserted at every step.

test("rotation: one slot, four devices — every device gets its turn and none is failed", async () => {
  adminRow.screenshotCapturesMaxConcurrent = 1;
  addDevice("d1");
  addDevice("d2");
  addDevice("d3");
  addDevice("d4");

  // Slice 1 (t0): the first device is served; the rest are DEFERRED, not failed.
  const p1 = await runCapturePass(slowCapture(), { now: clock, pressure: NORMAL });
  assert.equal(p1.captured, 1);
  assert.equal(p1.failed, 0, "a device that has not had its turn is NOT a failure");
  assert.equal(p1.deferred, 3, "the other three wait for a later slice");
  assert.equal(p1.rotatingUsers, 1);
  assert.deepEqual(captureCalls, ["d1"]);
  assert.equal(cursorFor("user_1")!.cursorDeviceId, "d1", "the cursor records the LAST device served");

  // WITHIN the slice window nothing else is captured — the owner's 20-30 min
  // per-device turn, not "capture everyone at once".
  advanceMinutes(5);
  const hold = await runCapturePass(slowCapture(), { now: clock, pressure: NORMAL });
  assert.equal(hold.captured, 0, "within the slice the user HOLDS");
  assert.equal(hold.deferred, 3);
  assert.equal(cursorFor("user_1")!.cursorDeviceId, "d1", "a held pass does not advance the cursor");

  // Each elapsed window serves exactly ONE more device and advances the cursor.
  advanceMinutes(20); // t0 + 25 = one full slice
  await runCapturePass(slowCapture(), { now: clock, pressure: NORMAL });
  assert.deepEqual(captureCalls.slice(1), ["d2"]);
  assert.equal(cursorFor("user_1")!.cursorDeviceId, "d2");

  advanceMinutes(25); // t0 + 50
  await runCapturePass(slowCapture(), { now: clock, pressure: NORMAL });
  advanceMinutes(25); // t0 + 75 — d1 is due again by now, so the cycle wraps
  await runCapturePass(slowCapture(), { now: clock, pressure: NORMAL });
  advanceMinutes(25); // t0 + 100
  await runCapturePass(slowCapture(), { now: clock, pressure: NORMAL });

  // Every device was served at least once — none starves.
  assert.deepEqual(
    [...new Set(capturedIds())].sort(),
    ["d1", "d2", "d3", "d4"],
    "every device got a turn",
  );
  assert.equal(capturedIds().length, 5, "the cycle wrapped and d1 came round again");
});


test("raising the cap mid-run switches a rotating user to PARALLEL without a restart", async () => {
  adminRow.screenshotCapturesMaxConcurrent = 1;
  addDevice("d1");
  addDevice("d2");
  addDevice("d3");
  addDevice("d4");

  const p1 = await runCapturePass(slowCapture(), { now: clock, pressure: NORMAL });
  assert.equal(p1.rotatingUsers, 1, "one slot against four devices rotates");
  assert.deepEqual(captureCalls, ["d1"]);
  assert.equal(cursorFor("user_1")!.cursorDeviceId, "d1");

  // The admin raises the cap to 4 — read on the NEXT pass, same process, NO restart.
  adminRow.screenshotCapturesMaxConcurrent = 4;
  advanceMinutes(1); // deliberately still INSIDE the old slice window
  const p2 = await runCapturePass(slowCapture(), { now: clock, pressure: NORMAL });

  assert.equal(p2.parallel, true, "idle box + nobody else => parallel");
  assert.equal(p2.rotatingUsers, 0, "rotation STOPPED");
  assert.equal(p2.deferred, 0, "nothing is held back when everything fits");
  assert.deepEqual(captureCalls.slice(1).sort(), ["d2", "d3", "d4"], "the rest run at once");
  assert.equal(cursorFor("user_1")!.cursorDeviceId, "d1", "parallel mode leaves the cursor untouched");
});

test("lowering the cap mid-run degrades to rotation and LOSES NO QUEUED DEVICE", async () => {
  adminRow.screenshotCapturesMaxConcurrent = 2;
  addDevice("d1");
  addDevice("d2");
  addDevice("d3");
  addDevice("d4");

  const p1 = await runCapturePass(slowCapture(), { now: clock, pressure: NORMAL });
  // Two slots against four devices: the first slice serves d1+d2, defers d3+d4.
  assert.deepEqual(captureCalls, ["d1", "d2"]);
  assert.equal(p1.deferred, 2);
  assert.equal(cursorFor("user_1")!.cursorDeviceId, "d2", "cursor = LAST device of the slice");

  // Lower the cap to 1 mid-run, then run the NEXT slice.
  adminRow.screenshotCapturesMaxConcurrent = 1;
  advanceMinutes(25);
  const p2 = await runCapturePass(slowCapture(), { now: clock, pressure: NORMAL });
  // CRITICAL: the fresh one-slot slice resumes ONE STEP PAST d2 — it must not
  // re-serve d2 (already done) nor jump to d4 (which would lose d3).
  assert.deepEqual(captureCalls.slice(2), ["d3"], "resumes right after the last served device");
  assert.equal(p2.deferred, 1, "d4 still waits its turn");

  advanceMinutes(25);
  await runCapturePass(slowCapture(), { now: clock, pressure: NORMAL });
  const served = new Set(capturedIds());
  assert.ok(served.has("d3") && served.has("d4"), "no deferred device was dropped by the cap change");
  assert.equal(
    capturedIds().filter((id) => id === "d2").length,
    1,
    "the cap change did not duplicate a device's capture",
  );
});


test("fairness: a many-device user does not starve a single-device user", async () => {
  adminRow.screenshotCapturesMaxConcurrent = 2;
  for (const id of ["a1", "a2", "a3", "a4"]) addDevice(id, { userId: "user_a" });
  addDevice("b1", { userId: "user_b" });

  const p1 = await runCapturePass(slowCapture(), { now: clock, pressure: NORMAL });

  const byUser = (uid: string) => capturedFrames().filter((f) => f.userId === uid).length;
  assert.equal(p1.parallel, false, "two users competing is not the parallel case");
  assert.equal(p1.rotatingUsers, 1, "only the many-device user rotates");
  assert.equal(byUser("user_a"), 1, "the big user is held to its fair SHARE (1)");
  assert.equal(byUser("user_b"), 1, "the single-device user is NOT starved");
});

test("fairness at a cap of ONE: the busy user's rotation frees the slot for the other", async () => {
  adminRow.screenshotCapturesMaxConcurrent = 1;
  for (const id of ["a1", "a2", "a3", "a4"]) addDevice(id, { userId: "user_a" });
  addDevice("b1", { userId: "user_b" });

  const p1 = await runCapturePass(slowCapture(), { now: clock, pressure: NORMAL });
  const p2 = await runCapturePass(slowCapture(), { now: clock, pressure: NORMAL });

  const byUser = (uid: string) => capturedFrames().filter((f) => f.userId === uid).length;
  assert.equal(byUser("user_a"), 1, "one slot: the big user still takes just one turn");
  assert.equal(byUser("user_b"), 1, "the single-device user then runs — it is not starved");
  assert.equal(p1.captured + p2.captured, 2, "both users got exactly one capture across two passes");
});

test("the rotation cursor is PERSISTED: rotation survives a process restart", async () => {
  adminRow.screenshotCapturesMaxConcurrent = 1;
  addDevice("d1");
  addDevice("d2");
  addDevice("d3");

  await runCapturePass(slowCapture(), { now: clock, pressure: NORMAL });
  assert.deepEqual(captureCalls, ["d1"]);
  const persisted = cursorFor("user_1");
  assert.ok(persisted, "the cursor is a DB row, not module state");
  assert.equal(persisted.cursorDeviceId, "d1");

  // Simulate a NEW PROCESS: a fresh module instance (a DIFFERENT function object).
  const restarted = reloadRunCapturePass();
  assert.notEqual(restarted, runCapturePass, "this is genuinely a different instance");

  advanceMinutes(25);
  await restarted(slowCapture(), { now: clock, pressure: NORMAL });
  assert.deepEqual(
    captureCalls.slice(1),
    ["d2"],
    "after the restart the rotation resumed AFTER d1, from the persisted row",
  );

  // A second restart still resumes correctly — the row is durable, not cached.
  const restartedAgain = reloadRunCapturePass();
  advanceMinutes(25);
  await restartedAgain(slowCapture(), { now: clock, pressure: NORMAL });
  assert.deepEqual(capturedIds(), ["d1", "d2", "d3"]);
});


test("headroom: an idle box runs a lone user's devices SIMULTANEOUSLY", async () => {
  adminRow.screenshotCapturesMaxConcurrent = 4;
  for (const id of ["d1", "d2", "d3", "d4"]) addDevice(id);

  const calm = await runCapturePass(slowCapture(), {
    now: clock,
    pressure: { ...NORMAL, ramUsedPct: 50 },
  });
  assert.equal(calm.parallel, true, "below the warn line with nobody else => parallel");
  assert.equal(calm.captured, 4, "all four run at once");
  assert.equal(calm.deferred, 0);
  assert.equal(calm.rotatingUsers, 0);
});

test("the headroom DIAL fires: a box above it throttles the lone user to rotation", async () => {
  adminRow.screenshotCapturesMaxConcurrent = 4;
  adminRow.screenshotHeadroomRamPct = 60; // the owner's ~60% figure, as a dial
  for (const id of ["d1", "d2", "d3", "d4"]) addDevice(id);

  // 50% < the 60% dial => headroom => parallel, all four at once.
  const calm = await runCapturePass(slowCapture(), {
    now: clock,
    pressure: { ...NORMAL, ramUsedPct: 50 },
  });
  assert.equal(calm.parallel, true, "below the dial IS headroom");
  assert.equal(calm.captured, 4);

  // 65% > the 60% dial => NO headroom => one at a time, the rest rotate. Move the
  // clock on so the devices are due again for this second observation.
  advanceMinutes(60);
  const hot = await runCapturePass(slowCapture(), {
    now: clock,
    pressure: { ...NORMAL, ramUsedPct: 65 },
  });
  assert.equal(hot.parallel, false, "above the dial there is no headroom");
  assert.equal(hot.captured, 1, "out of headroom => ONE at a time");
  assert.equal(hot.deferred, 3);
  assert.equal(hot.rotatingUsers, 1);
});

test("an offline device is skipped; one merely waiting its turn is DEFERRED — never failed", async () => {
  adminRow.screenshotCapturesMaxConcurrent = 1;
  addDevice("d1");
  addDevice("d2", { status: "offline" }); // the real, existing failure mode: not online
  addDevice("d3");

  const r = await runCapturePass(slowCapture(), { now: clock, pressure: NORMAL });
  const statusOf = (id: string) => r.results.find((x) => x.deviceId === id)?.status;

  assert.equal(r.captured, 1);
  assert.equal(r.failed, 0, "neither an offline device nor a waiting one is a failure");
  assert.equal(statusOf("d3"), "deferred", "online-but-not-yet-its-turn is deferral, not failure");
  assert.notEqual(statusOf("d2"), "failed", "the offline device never appears as a failure");
});


test.after(async () => {
  await rm(SCREENSHOT_ROOT, { recursive: true, force: true });
});
