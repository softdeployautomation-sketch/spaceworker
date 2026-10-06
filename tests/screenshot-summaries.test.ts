import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

// TASK_152 M3 — per-frame screen summaries + the cost gate.
//
// WHY THIS FILE EXISTS: the acceptance bar is "a summary is persisted against a
// real frame, the money is bounded, and a summarisation failure never fails a
// capture" — none of which can be shown by a single live run (there is no real
// vision relay here). So this file exercises the REAL
// `lib/screenshot-summaries.ts` AND the REAL `lib/ai-metering.ts` (not copies)
// through the house require hook (HOW_WE_MOVE_FAST §4), swapping only their own
// dependencies for recording fakes.
//
// THE METERING IS NOT FAKED. The per-user daily cap is decided by the same
// `aiCapReached` / `getUsedAiTodayHundredthsCent` / `recordAiUsage` the
// Automations agent uses, reading the same AiUsageLog rows. If this file faked
// that, it would be testing its own mock instead of the mechanism that protects
// the owner's money.
//
// THE AI CALL IS FAKED (it is injected — see SummariseFn) and so is OCR (see
// OcrFn): no network, no Chromium, no tesseract. What they CANNOT prove is that
// the pooled relay accepts the call, nor that tesseract reads a real desktop
// screenshot correctly; both stay owner-run live checks on the box.

import type {
  SummariseCallInput,
  SummariseCallResult,
  SummariseFn,
} from "../lib/screenshot-summaries";
import type { OcrFn } from "../lib/screenshot-ocr";

process.env.DATABASE_URL = "postgresql://t152:t152@localhost:5432/task152_placeholder";
process.env.SESSION_SECRET = "task152-test-session-secret";
process.env.RESEND_API_KEY = "task152-test-resend";
process.env.EMAIL_FROM = "t152@spaceworker.test";
process.env.APP_BASE_URL = "https://spaceworker.test";
(process.env as Record<string, string>).NODE_ENV = "test";

// Real files really get written and read — the summary path reads frame bytes
// off the real filesystem, so this is a real temp root, not a mocked fs.
const SCREENSHOT_ROOT = mkdtempSync(join(tmpdir(), "t152-frames-"));
process.env.SCREENSHOT_BASE_DIR = SCREENSHOT_ROOT;

// ---------------------------------------------------------------------------
// In-memory stand-ins
// ---------------------------------------------------------------------------

interface DeviceRow {
  id: string;
  userId: string;
  screenshotMonitoringEnabled: boolean;
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
  summary: string | null;
  summaryError: string | null;
  summaryModel: string | null;
  summarisedAt: Date | null;
  imagePurgedAt: Date | null;
  // TASK_157 — the free extraction, written before any AI call.
  ocrText: string | null;
  ocrAt: Date | null;
  ocrConfidence: number | null;
  summaryDate: Date;
  capturedAt: Date | null;
  createdAt: Date;
}

interface UsageRow {
  id: string;
  userId: string;
  costHundredthsCent: number;
  eventType: string;
  createdAt: Date;
}

let devices: DeviceRow[] = [];
let frames: FrameRow[] = [];
let usage: UsageRow[] = [];
let users: Array<{ id: string; aiDailyCapHundredthsCent: number }> = [];
let idSeq = 0;
// The test clock is pinned to NOON OF THE REAL CURRENT UTC DAY, never a fixed
// date. `getUsedAiTodayHundredthsCent()` sums against the real clock's "today"
// (lib/ai-metering.ts:startOfTodayUTC), so a fixed date silently rots: the day
// after the hard-coded date, usage rows stop counting as "today" and the
// mid-pass cap test stops tripping. Every other test computes retention
// relative to `clock`, so anchoring it to today is safe everywhere.
const TODAY_NOON_UTC = `${new Date().toISOString().slice(0, 10)}T12:00:00.000Z`;
let clock = new Date(TODAY_NOON_UTC);
let adminRow: Record<string, unknown> = {};

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
  user: {
    async findUnique(args: { where: { id: string } }) {
      return users.find((u) => u.id === args.where.id) ?? null;
    },
  },
  device: {
    async findMany(args: { where?: Record<string, unknown>; select?: Record<string, boolean> }) {
      return devices
        .filter((d) => matches({ ...d }, args.where))
        .map((d) => pick({ ...d }, args.select));
    },
  },
  deviceScreenshot: {
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
      orderBy?: { createdAt?: "asc" | "desc" };
      take?: number;
    }) {
      let rows = frames.filter((f) => matches({ ...f }, args.where));
      if (args.orderBy?.createdAt === "asc") {
        rows = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      }
      if (args.orderBy?.createdAt === "desc") {
        rows = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      }
      if (typeof args.take === "number") rows = rows.slice(0, args.take);
      return rows.map((r) => pick({ ...r }, args.select));
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
  aiUsageLog: {
    async aggregate(args: { where?: Record<string, unknown> }) {
      const rows = usage.filter((u) => matches({ ...u }, args.where));
      return {
        _sum: { costHundredthsCent: rows.reduce((a, r) => a + r.costHundredthsCent, 0) },
      };
    },
    async create(args: { data: Partial<UsageRow> }) {
      const row: UsageRow = {
        id: nextId("usage"),
        userId: String(args.data.userId),
        costHundredthsCent: args.data.costHundredthsCent ?? 0,
        eventType: String(args.data.eventType ?? ""),
        createdAt: args.data.createdAt ?? new Date(clock.getTime()),
      };
      usage.push(row);
      return { ...row };
    },
  },
};

// ---------------------------------------------------------------------------
// Require hook: only the modules under test's own dependencies are swapped.
// ---------------------------------------------------------------------------

type Loader = {
  _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};

// The real lib/device-screenshots.ts is used for its path/retention helpers, so
// it — and the real governor it pulls in — must be listed as parents too, or
// their OWN `./db` import would reach the real Prisma client.
const SWAPPED_PARENTS = [
  "lib/device-screenshots.ts",
  "lib/resource-governor.ts",
  "lib/screenshot-summaries.ts",
  "lib/ai-metering.ts",
];

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    const from = parent?.filename ?? "";
    if (SWAPPED_PARENTS.some((p) => from.endsWith(`/${p}`))) {
      if (request === "./db") return { db: { ...fakeDb, governorQueueEntry: {} } };
      if (request === "./admin-settings") return { getAdminSettings: async () => ({ ...adminRow }) };
      if (request === "./entitlements") {
        return { listEffectiveEntitlements: async () => ({ premium: false, keys: [], grants: [] }) };
      }
      if (request === "./devices") {
        return { recordAgentActionAudit: async () => {} };
      }
    }
    return original.call(this, request, parent, isMain);
  };
}

installRequireHook();

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  runSummaryPass,
  listPendingSummaryFrames,
  countSummarisedToday,
  parseSummaries,
  summariseCostPerCallHundredthsCent,
  summariseCostPerDevicePerDayHundredthsCent,
  summariseCostReport,
  SCREENSHOT_SUMMARY_IMAGES_PER_CALL,
  SCREENSHOT_SUMMARY_MAX_CALLS_PER_DEVICE_PER_DAY,
  SCREENSHOT_SUMMARY_MAX_FRAMES_PER_DEVICE_PER_DAY,
  SCREENSHOT_SUMMARY_MODEL,
  RETRYABLE_SUMMARY_ERRORS,
} = require("../lib/screenshot-summaries") as typeof import("../lib/screenshot-summaries");

const {
  purgeExpiredFrames,
  frameAbsPath,
  startOfUtcDay,
  listRecentFrames,
} = require("../lib/device-screenshots") as typeof import("../lib/device-screenshots");
/* eslint-enable @typescript-eslint/no-require-imports */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addDevice(id: string, opts: { userId?: string; optIn?: boolean } = {}): void {
  devices.push({
    id,
    userId: opts.userId ?? "user_1",
    screenshotMonitoringEnabled: opts.optIn ?? true,
  });
}

function addUser(id = "user_1", capHundredthsCent = 20000): void {
  users.push({ id, aiDailyCapHundredthsCent: capHundredthsCent });
}

/** A captured frame with a REAL file on disk, exactly like a real capture. */
async function makeFrame(deviceId: string, over: Partial<FrameRow> = {}): Promise<FrameRow> {
  const id = over.id ?? nextId("frame");
  const day = startOfUtcDay(clock).toISOString().slice(0, 10);
  const rel = join(deviceId, day, `${id}.png`);
  if (over.filePath === undefined) {
    await mkdir(frameAbsPath(join(deviceId, day)), { recursive: true });
    await writeFile(frameAbsPath(rel), Buffer.from("PNGDATA"));
  }
  const row: FrameRow = {
    id,
    deviceId,
    userId: "user_1",
    status: "captured",
    filePath: rel,
    bytes: 7,
    width: 1440,
    height: 900,
    failureReason: null,
    summary: null,
    summaryError: null,
    summaryModel: null,
    summarisedAt: null,
    imagePurgedAt: null,
    ocrText: null,
    ocrAt: null,
    ocrConfidence: null,
    summaryDate: startOfUtcDay(clock),
    capturedAt: new Date(clock.getTime()),
    createdAt: new Date(clock.getTime()),
    ...over,
  };
  frames.push(row);
  return row;
}

/** Every batch the pass actually asked the model to summarise. */
let calls: Array<{ userId: string; model: string; ids: string[] }> = [];

/** A summariser that answers every frame, and reports a realistic real cost. */
function okSummarise(costHundredthsCent = 62): SummariseFn {
  return async ({ userId, model, frames: callFrames }: SummariseCallInput): Promise<SummariseCallResult> => {
    calls.push({ userId, model, ids: callFrames.map((f) => f.id) });
    const summaries = new Map(
      callFrames.map((f, i) => [f.id, `Frame ${i + 1} of ${callFrames.length}: a report was open.`]),
    );
    return { summaries, costHundredthsCent };
  };
}

/** A summariser that DIES — to prove a dead AI leg cannot hurt the frames. */
function deadSummarise(): SummariseFn {
  return async () => {
    const err = new Error("AI service temporarily unavailable.") as Error & { code: string };
    err.code = "temporarily_unavailable";
    throw err;
  };
}

// ---------------------------------------------------------------------------
// TASK_157 — OCR. Always injected, never the real tesseract: tests must be
// deterministic and offline. The real engine is exercised on the box instead.
// ---------------------------------------------------------------------------

/** OCR text recorded per frame, so a test can assert exactly what was stored. */
const ocrTexts = new Map<string, string>();

/** An OCR stub that reads canned text keyed by the frame id it is asked about. */
function stubOcr(defaultText = "Visible text on screen"): OcrFn {
  return async (png: Buffer) => ({ text: ocrTexts.get(png.toString("base64")) ?? defaultText, confidence: 92 });
}

beforeEach(() => {
  devices = [];
  frames = [];
  usage = [];
  users = [];
  idSeq = 0;
  calls = [];
  ocrTexts.clear();
  clock = new Date(TODAY_NOON_UTC);
  adminRow = {
    screenshotMonitoringEnabled: true,
    screenshotCapturesMaxConcurrent: 2,
    screenshotCaptureIntervalMinutes: 60,
    screenshotRetentionDays: 14,
    // TASK_168 Bug B — the dial's default reproduces the old hardcode. The
    // hook returns a copy of this row, so a test sets the DIAL here.
    screenshotSummaryMaxCallsPerDevicePerDay: 8,
  };
  users.push({ id: "user_1", aiDailyCapHundredthsCent: 20000 });
});

// ---------------------------------------------------------------------------
// The cost gate — the number itself
// ---------------------------------------------------------------------------

test("the cost gate is stated in code: 3 frames/call, <=8 calls/device/day, <=524 hc/device/day", () => {
  // The batching ceiling is the vision model's own API limit, not a taste call.
  assert.equal(SCREENSHOT_SUMMARY_IMAGES_PER_CALL, 3);
  assert.equal(SCREENSHOT_SUMMARY_MAX_CALLS_PER_DEVICE_PER_DAY, 8);
  assert.equal(SCREENSHOT_SUMMARY_MAX_FRAMES_PER_DEVICE_PER_DAY, 24);
  assert.equal(SCREENSHOT_SUMMARY_MODEL, "qwen/qwen3.8-27b");

  // 3*2048 + 160 = 6304 input tokens @0.008 hc  +  3*90 + 30 = 300 output @0.04 hc
  const perCall = summariseCostPerCallHundredthsCent();
  assert.equal(perCall, 6304 * 0.008 + 300 * 0.04);
  assert.equal(perCall, 62.432);

  // The headline: cost per DEVICE per DAY, worst case.
  const perDevice = summariseCostPerDevicePerDayHundredthsCent();
  assert.equal(perDevice, perCall * 8);
  assert.equal(Math.round(perDevice), 499);

  // The report is derived, not hand-written, so it can never drift from the code.
  const report = summariseCostReport();
  assert.match(report, /qwen\/qwen3\.8-27b/);
  assert.match(report, /8 calls\/device\/day/);
  assert.match(report, /499 hc\/device\/day/);
  assert.match(report, /covers ~40 summarised devices/);
});

// ---------------------------------------------------------------------------
// The model's reply
// ---------------------------------------------------------------------------

test("parseSummaries maps 1-based indices back to frames and tolerates chatty JSON", () => {
  // TASK_157 — frames now carry OCR text, not an image data URL.
  const callFrames = [
    { id: "f1", text: "Gmail inbox" },
    { id: "f2", text: "Yahoo Expedia" },
  ];

  // The shape the prompt asked for.
  assert.deepEqual(
    [...parseSummaries('{"summaries":[{"index":1,"summary":"A"},{"index":2,"summary":"B"}]}', callFrames)],
    [["f1", "A"], ["f2", "B"]],
  );

  // A model that wraps the JSON in prose still produces usable summaries.
  assert.deepEqual(
    [...parseSummaries('Sure!\n{"summaries":[{"index":1,"summary":"A"}]}\nHope that helps.', callFrames)],
    [["f1", "A"]],
  );

  // A bare array (no envelope) is accepted too.
  assert.deepEqual([...parseSummaries('[{"index":1,"summary":"A"}]', callFrames)], [["f1", "A"]]);

  // Junk in, nothing out — never a half-written map.
  assert.equal(parseSummaries("not json at all", callFrames).size, 0);
  assert.equal(parseSummaries('{"summaries":[{"index":9,"summary":"A"}]}', callFrames).size, 0);
});

// ---------------------------------------------------------------------------
// The pass persists summaries, batches them, and meters the real cost
// ---------------------------------------------------------------------------

test("a pass summarises a device's frames IN BATCHES OF 3 and writes each summary to its own frame", async () => {
  addUser();
  addDevice("d1");
  await makeFrame("d1");
  await makeFrame("d1");
  await makeFrame("d1");
  await makeFrame("d1");
  await makeFrame("d1");

  const result = await runSummaryPass(okSummarise(62), { now: clock }, stubOcr());

  // 5 frames / 3 per call = 2 metered calls, never 5 (the whole point of M3's
  // cost gate: the owner wanted a summary PER IMAGE, not a call per image).
  assert.equal(calls.length, 2, "5 frames must be 2 batched calls, not 5");
  assert.deepEqual(calls[0].ids.length, 3);
  assert.deepEqual(calls[1].ids.length, 2);
  assert.equal(calls[0].model, "qwen/qwen3.8-27b", "the cheap vision model is requested");
  assert.equal(result.calls, 2);
  assert.equal(result.summarised, 5);

  // Every frame really carries the text the model returned for IT.
  assert.ok(frames.every((f) => f.summary !== null), "each frame has its own summary");
  assert.equal(frames.length, 5);
  assert.ok(frames.every((f) => f.summaryModel === "qwen/qwen3.8-27b"));
  assert.ok(frames.every((f) => f.summarisedAt instanceof Date));
  assert.ok(frames.every((f) => f.summaryError === null));

  // The REAL cost was written through the shared AiUsageLog path — 2 * 62.
  assert.equal(result.costHundredthsCent, 124);
  assert.equal(usage.length, 2);
  assert.equal(usage[0].eventType, "screenshot_summary");
  assert.equal(usage.reduce((a, u) => a + u.costHundredthsCent, 0), 124);
});

test("a frame with NO summary yet is NORMAL: it is pending, not failed, and capture fields are untouched", async () => {
  addUser();
  addDevice("d1");
  const frame = await makeFrame("d1");

  // BEFORE: the frame is captured with a real image and NO text at all.
  // (deepEqual on a fresh array, NOT assert.equal on frame.summary — the latter
  //  is typed `asserts actual is T` and would narrow frame.summary to `null`
  //  for the rest of the scope, breaking the read-back below.)
  assert.deepEqual(
    [frame.summary, frame.summaryError, frame.status, frame.failureReason],
    [null, null, "captured", null],
  );

  const pending = await listPendingSummaryFrames(clock, 14);
  assert.equal(pending.length, 1, "a captured, unsummarised frame is the normal pending state");

  await runSummaryPass(okSummarise(62), { now: clock }, stubOcr());

  // AFTER: it has text, and the capture record is exactly as the capture left it.
  assert.equal(frame.status, "captured");
  assert.equal(frame.failureReason, null);
  assert.equal(frame.filePath !== null, true, "the image is still referenced");
  assert.ok(frame.summary && frame.summary.length > 0);
});

test("the per-device daily budget caps a device at 24 frames/day and MARKS the rest, never dropping them silently", async () => {
  addUser();
  addDevice("d1");
  // 30 frames in one day — a 1-minute cadence would produce far more.
  for (let i = 0; i < 30; i++) await makeFrame("d1");

  const result = await runSummaryPass(okSummarise(62), { now: clock }, stubOcr());

  // 24 frames / 3 = 8 calls, the documented worst case.
  assert.equal(SCREENSHOT_SUMMARY_MAX_FRAMES_PER_DEVICE_PER_DAY, 24);
  assert.equal(calls.length, 8, "exactly the daily call budget");
  assert.equal(result.summarised, 24);
  assert.equal(result.deferred, 6, "the over-budget frames are accounted for");

  const summarised = frames.filter((f) => f.summary !== null);
  const marked = frames.filter((f) => f.summaryError === "daily_call_budget");
  assert.equal(summarised.length, 24);
  assert.equal(marked.length, 6);
  // Nothing was deleted to make a count look right.
  assert.equal(frames.length, 30);
  // And the over-budget frames are RETRYABLE, so tomorrow they get summarised.
  assert.ok(RETRYABLE_SUMMARY_ERRORS.has("daily_call_budget"));
});

test("2026-10-04: the frames left over by the local cap are picked up again after the UTC-day reset", async () => {
  // The live incident in miniature: 30 frames arrive, the local 24/day cap marks
  // 6 as `daily_call_budget`, and the next day's pass must actually SUMMARISE
  // those 6 rather than skip them forever. This is the behaviour that proved
  // the whole thing was a transient local limit and not a Channelry budget.
  // Yesterday: 30 frames arrive, the local 24/day cap summarises 24 and marks 6.
  clock = new Date(new Date(TODAY_NOON_UTC).getTime() - 24 * 60 * 60 * 1000);
  addUser();
  addDevice("d1");
  for (let i = 0; i < 30; i++) await makeFrame("d1");

  const day1 = await runSummaryPass(okSummarise(62), { now: clock }, stubOcr());
  assert.equal(day1.summarised, 24);
  assert.equal(frames.filter((f) => f.summaryError === "daily_call_budget").length, 6);

  // Simulate the day rolling over. NOTE: writeSummaries stamps `summarisedAt` with
  // the REAL wall clock (`new Date()`), never the injected `now` — correct in
  // production, and it means a test cannot roll the day just by moving `clock`.
  // Ageing day 1's stamps by 24h is what a real rollover produces: those frames
  // are now summarised *yesterday*, so today's count starts at 0 again.
  const oneDayEarlier = new Date(new Date(TODAY_NOON_UTC).getTime() - 24 * 60 * 60 * 1000);
  for (const f of frames) {
    if (f.summarisedAt !== null) f.summarisedAt = oneDayEarlier;
  }

  // A pass the next UTC day, with nothing else changed: the budget has reset, so
  // the 6 deferred frames must be picked up and actually summarised.
  clock = new Date(TODAY_NOON_UTC);
  const day2 = await runSummaryPass(okSummarise(62), { now: clock }, stubOcr());

  assert.equal(day2.summarised, 6, "the 6 deferred frames are summarised the next day");
  assert.equal(frames.filter((f) => f.summary === null).length, 0, "nothing is left unsummarised");
  assert.equal(
    frames.filter((f) => f.summaryError !== null).length,
    0,
    "a successful retry CLEARS the stale daily_call_budget error",
  );
  // Same 30 frames throughout — nothing was deleted or duplicated to get here.
  assert.equal(frames.length, 30);
});

test("2026-10-04: over_cap and rate_limited are RETRYABLE, so neither strands a frame forever", async () => {
  // "over_cap" was absent from the retryable set, so a frame that hit a REAL
  // Channelry cap was treated as terminal and skipped by every later sweep —
  // even though the cap resets at the relay's day boundary. "rate_limited" is
  // new and is Cloudflare back-pressure, transient by definition. Neither may
  // strand a perfectly good frame.
  assert.ok(RETRYABLE_SUMMARY_ERRORS.has("over_cap"), "a real cap resets daily, so retry");
  assert.ok(RETRYABLE_SUMMARY_ERRORS.has("rate_limited"), "back-pressure clears itself");
  // Still terminal: a file that is gone from disk will never yield text.
  assert.equal(RETRYABLE_SUMMARY_ERRORS.has("image_missing"), false);
});

test("TASK_168 Bug B: the daily budget BINDS at the admin dial, not the old hardcoded 24", async () => {
  // The dial is 2 calls/day = 6 frames/day. 9 frames arrive: 6 summarised in
  // 2 calls, 3 marked daily_call_budget. Under the old hardcode all 9 would
  // have been summarised (9 <= 24) — so this proves the DIAL binds.
  adminRow.screenshotSummaryMaxCallsPerDevicePerDay = 2;
  addUser();
  addDevice("d1");
  for (let i = 0; i < 9; i++) await makeFrame("d1");

  const result = await runSummaryPass(okSummarise(62), { now: clock }, stubOcr());

  assert.equal(calls.length, 2, "6 frames at 3/call = 2 calls, the dial's allowance");
  assert.equal(result.summarised, 6);
  assert.equal(result.deferred, 3);
  assert.equal(frames.filter((f) => f.summary !== null).length, 6);
  assert.equal(frames.filter((f) => f.summaryError === "daily_call_budget").length, 3);
  assert.equal(frames.length, 9, "nothing deleted to make the count look right");
});

test("TASK_168 Bug B: raising the dial above the old 24 actually summarises more", async () => {
  // The dial is 16 calls/day = 48 frames/day. 30 frames arrive: under the old
  // hardcode 6 would have been deferred (30 > 24) — here all 30 summarise in
  // 10 calls. The dial is a ceiling that moves BOTH ways.
  adminRow.screenshotSummaryMaxCallsPerDevicePerDay = 16;
  addUser();
  addDevice("d1");
  for (let i = 0; i < 30; i++) await makeFrame("d1");

  const result = await runSummaryPass(okSummarise(62), { now: clock }, stubOcr());

  assert.equal(calls.length, 10, "30 frames at 3/call = 10 calls, within the 16-call dial");
  assert.equal(result.summarised, 30);
  assert.equal(result.deferred, 0);
  assert.equal(frames.filter((f) => f.summaryError !== null).length, 0);
});

// ---------------------------------------------------------------------------
// The cap-exhaustion path and failure independence
// ---------------------------------------------------------------------------

test("when the per-user daily cap is exhausted, frames are left UNSUMMARISED, marked with why, and NO call is made", async () => {
  users[0].aiDailyCapHundredthsCent = 0; // the account is already at/over its cap
  addDevice("d1");
  await makeFrame("d1");
  await makeFrame("d1");
  await makeFrame("d1");
  await makeFrame("d1");

  const result = await runSummaryPass(okSummarise(62), { now: clock }, stubOcr());

  // The guard FIRED: no model call at all, and every frame records the reason.
  assert.equal(calls.length, 0, "an exhausted cap must spend nothing");
  assert.equal(result.calls, 0);
  assert.equal(result.summarised, 0);
  assert.equal(result.deferred, 4);
  assert.equal(usage.length, 0, "no usage row is written when nothing was spent");

  const marked = frames.filter((f) => f.summaryError === "cap_exhausted");
  assert.equal(marked.length, 4);
  assert.ok(frames.every((f) => f.summary === null), "frames are left unsummarised, not failed");
  // The frames themselves are still perfectly good captures.
  assert.ok(frames.every((f) => f.status === "captured" && f.failureReason === null));

  // "cap_exhausted" is RETRYABLE: the cap resets at UTC midnight, so tomorrow's
  // pass picks these frames up again rather than abandoning them forever.
  assert.ok(RETRYABLE_SUMMARY_ERRORS.has("cap_exhausted"));
});

test("a cap that is crossed MID-pass is caught: the first call spends, the rest are deferred", async () => {
  // Room for exactly one 62 hc call: used(0) < 62 passes, then used(62) == 62
  // trips aiCapReached before the SECOND call. A once-per-pass cap read would
  // let call 2 through and overspend.
  users[0].aiDailyCapHundredthsCent = 62;
  addDevice("d1");
  for (let i = 0; i < 6; i++) await makeFrame("d1");

  const result = await runSummaryPass(okSummarise(62), { now: clock }, stubOcr());

  assert.equal(calls.length, 1, "the cap is re-read before EVERY call");
  assert.equal(result.summarised, 3);
  assert.equal(result.deferred, 3);
  assert.equal(usage.length, 1);
  assert.equal(frames.filter((f) => f.summaryError === "cap_exhausted").length, 3);
});

test("a summarisation failure NEVER fails the capture: the frames keep their images and only gain a summaryError", async () => {
  addUser();
  addDevice("d1");
  const a = await makeFrame("d1");
  const b = await makeFrame("d1");
  const pathsBefore = [a.filePath, b.filePath];

  // The AI leg dies. runSummaryPass must still RESOLVE (never throw to the sweep).
  const result = await runSummaryPass(deadSummarise(), { now: clock }, stubOcr());

  assert.equal(result.calls, 0, "a failed call is not a metered call");
  assert.equal(result.summarised, 0);
  assert.equal(result.deferred, 2);

  // The CAPTURE record is completely untouched — this is the independence rule.
  assert.equal(a.status, "captured");
  assert.equal(b.status, "captured");
  assert.equal(a.failureReason, null);
  assert.equal(b.failureReason, null);
  assert.deepEqual([a.filePath, b.filePath], pathsBefore, "no file reference was disturbed");
  assert.ok(existsSync(frameAbsPath(a.filePath as string)), "the real image is still on disk");

  // The failure is recorded on the SUMMARY axis only, with the relay's own code.
  assert.equal(a.summary, null);
  assert.equal(a.summaryError, "temporarily_unavailable");
  assert.equal(b.summaryError, "temporarily_unavailable");
  assert.equal(usage.length, 0, "a call that failed charges nothing");
});

test("a frame whose image file is missing is marked TERMINAL and is not retried forever", async () => {
  addUser();
  addDevice("d1");
  // A row that claims an image which is not on disk.
  await makeFrame("d1", { filePath: join("d1", "missing", "gone.png") });

  const result = await runSummaryPass(okSummarise(62), { now: clock }, stubOcr());

  assert.equal(result.unreadable, 1);
  assert.equal(calls.length, 0, "an unreadable image never reaches the paid model");
  assert.equal(frames[0].summaryError, "image_missing");
  // Terminal: it is NOT retryable, so it is excluded from future passes.
  assert.equal(RETRYABLE_SUMMARY_ERRORS.has("image_missing"), false);
  const pending = await listPendingSummaryFrames(clock, 14);
  assert.equal(pending.length, 0, "a terminally-marked frame drops out of the queue");
});

test("summaries are only ever written inside the retention window", async () => {
  addUser();
  addDevice("d1");
  // Fresh frame (inside the window) and an expired one (outside it).
  const fresh = await makeFrame("d1");
  const stale = await makeFrame("d1", {
    summaryDate: startOfUtcDay(new Date(clock.getTime() - 60 * 86_400_000)),
    filePath: join("d1", "2026-08-02", "old.png"),
  });
  await mkdir(frameAbsPath(join("d1", "2026-08-02")), { recursive: true });
  await writeFile(frameAbsPath(stale.filePath as string), Buffer.from("OLD"));

  const pending = await listPendingSummaryFrames(clock, 14);
  assert.deepEqual(
    pending.map((f) => f.id),
    [fresh.id],
    "a frame about to be purged is never sent to a paid model",
  );

  const result = await runSummaryPass(okSummarise(62), { now: clock }, stubOcr());
  assert.equal(result.summarised, 1);
  assert.equal(stale.summary, null);
});

// ---------------------------------------------------------------------------
// Retention: the text outlives the pixels (the deliberate decision)
// ---------------------------------------------------------------------------

test("retention deletes an expired frame's IMAGE and row when it has no summary (unchanged behaviour)", async () => {
  addUser();
  addDevice("d1");
  const rel = join("d1", "2026-08-01", "old.png");
  await mkdir(frameAbsPath(join("d1", "2026-08-01")), { recursive: true });
  await writeFile(frameAbsPath(rel), Buffer.from("OLDPNG"));
  const old = await makeFrame("d1", {
    filePath: rel,
    summaryDate: startOfUtcDay(new Date(clock.getTime() - 20 * 86_400_000)),
  });

  const purged = await purgeExpiredFrames(clock, 14);

  assert.equal(purged, 1);
  assert.ok(!existsSync(frameAbsPath(rel)), "the file is gone");
  assert.ok(!frames.some((f) => f.id === old.id), "the summary-less row is gone too");
});

test("retention KEEPS a summary after its image expires — the text outlives the pixels, marked not destroyed", async () => {
  addUser();
  addDevice("d1");
  const rel = join("d1", "2026-08-05", "kept.png");
  await mkdir(frameAbsPath(join("d1", "2026-08-05")), { recursive: true });
  await writeFile(frameAbsPath(rel), Buffer.from("KEPTPNG"));
  const kept = await makeFrame("d1", {
    filePath: rel,
    summary: "Excel was open on a staffing spreadsheet.",
    summaryModel: "qwen/qwen3.8-27b",
    summarisedAt: new Date(clock.getTime() - 20 * 86_400_000),
    summaryDate: startOfUtcDay(new Date(clock.getTime() - 20 * 86_400_000)),
  });

  const purged = await purgeExpiredFrames(clock, 14);

  assert.equal(purged, 1);
  // The IMAGE is gone — that is what retention means.
  assert.ok(!existsSync(frameAbsPath(rel)), "the raw image was deleted");
  assert.equal(kept.filePath, null, "the row no longer points at a file that is gone");
  assert.equal(kept.bytes, null);
  assert.equal(kept.imagePurgedAt instanceof Date, true, "the row is MARKED as image-expired");

  // …but the OWNER'S OWN TEXT is kept, not destroyed to make a count look tidy.
  assert.equal(kept.summary, "Excel was open on a staffing spreadsheet.");
  assert.ok(frames.some((f) => f.id === kept.id), "the row survives for its summary");

  // The UI read model exposes it as text-with-no-image, so the console renders
  // the summary and a placeholder instead of a broken <img>.
  const view = await listRecentFrames("d1", 10);
  assert.equal(view.length, 1);
  assert.equal(view[0].summary, "Excel was open on a staffing spreadsheet.");
  assert.equal(view[0].imagePurgedAt !== null, true);

  // A SECOND pass at the same time does not re-count it (it is already handled).
  assert.equal(await purgeExpiredFrames(clock, 14), 0);
});

test("a kept summary is finally deleted once it is a FULL window past its image (total lifetime <= 2x retention)", async () => {
  addUser();
  addDevice("d1");
  const kept = await makeFrame("d1", {
    filePath: null,
    summary: "An old note.",
    imagePurgedAt: new Date(clock.getTime() - 20 * 86_400_000), // purged 20 days ago
    summaryDate: startOfUtcDay(new Date(clock.getTime() - 40 * 86_400_000)),
  });

  await purgeExpiredFrames(clock, 14);

  assert.ok(!frames.some((f) => f.id === kept.id), "the kept summary expires R days after its image");
});

test("the read model keeps the SUMMARY axis separate from the CAPTURE axis for the timeline", async () => {
  addUser();
  addDevice("d1");
  // One good frame that GETS a summary, one captured frame left without one,
  // and one genuine capture failure — the three states the timeline must
  // distinguish. limit:1 means the pass only reaches the oldest captured frame,
  // so the newer captured frame stays in the normal "no summary yet" state.
  const oldest = await makeFrame("d1", { createdAt: new Date(clock.getTime() - 3000) });
  await makeFrame("d1", { createdAt: new Date(clock.getTime() - 2000) });
  await makeFrame("d1", {
    createdAt: new Date(clock.getTime()),
    status: "failed",
    failureReason: "device_offline",
    filePath: null,
  });
  await runSummaryPass(okSummarise(62), { now: clock, limit: 1 }, stubOcr());

  const view = await listRecentFrames("d1", 50);
  assert.equal(view.length, 3);
  // Newest first — the timeline is reverse-chronological.
  assert.ok(new Date(view[0].createdAt).getTime() > new Date(view[1].createdAt).getTime());

  const withSummary = view.find((f) => f.summary !== null);
  assert.ok(withSummary, "a summary was written against a real frame");
  assert.equal(withSummary.id, oldest.id);
  assert.equal(withSummary.summaryError, null);

  const noSummary = view.find((f) => f.status === "captured" && f.summary === null);
  assert.ok(noSummary, "an unsummarised captured frame is still listed, and not as an error");
  assert.equal(noSummary.failureReason, null, "it is NOT a capture failure");
  assert.equal(noSummary.summaryError, null, "it is NOT a summary failure either — just pending");

  const failed = view.find((f) => f.status === "failed");
  assert.ok(failed);
  assert.equal(failed.failureReason, "device_offline");
  assert.equal(failed.summary, null, "a failed capture has no summary …");
  assert.equal(failed.summaryError, null, "… and no summaryError: the axes stay separate");
});

test("the pass is a no-op when monitoring is off, and 401s are the route's job not the pass's", async () => {
  addUser();
  addDevice("d1");
  await makeFrame("d1");
  adminRow.screenshotMonitoringEnabled = false;

  const result = await runSummaryPass(okSummarise(62), { now: clock }, stubOcr());
  assert.equal(result.skipped, "disabled");
  assert.equal(calls.length, 0, "off means off — no AI is asked to look at anything");
  assert.equal(frames[0].summary, null);

  // And a device that is NOT opted in is never summarised even with the global
  // switch on — consent is per device.
  adminRow.screenshotMonitoringEnabled = true;
  devices[0].screenshotMonitoringEnabled = false;
  const result2 = await runSummaryPass(okSummarise(62), { now: clock }, stubOcr());
  assert.equal(result2.skipped, "no_frames");
  assert.equal(calls.length, 0);
});

after(async () => {
  await rm(SCREENSHOT_ROOT, { recursive: true, force: true });
});





