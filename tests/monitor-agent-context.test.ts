import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// TASK_152 M7 — the user's monitor summaries feed the agent's context.
//
// WHY THIS FILE EXISTS: the acceptance bar is "the agent's OWN turn carries the
// user's summaries, an unmonitored user's does not, and the AI cap still gates
// it" — none of which a single live run can show (there is no real relay here).
// So this file runs the REAL lib/monitor-agent-context.ts AND the REAL
// lib/agent.ts (not copies) through the house require hook (HOW_WE_MOVE_FAST
// §4), swapping only their own dependencies for fakes.
//
// THE METERING IS NOT FAKED. The per-user daily cap is decided by the same
// lib/ai-metering.ts the Automations agent has always used, reading the same
// AiUsageLog rows.
//
// THE RELAY IS FAKED (it is the network edge). The fake RECORDS the exact
// `messages` array runAgentTurn hands it, which is how the "raw agent-context
// fetch" below is captured: it is literally the system message the model would
// receive, printed verbatim. What it CANNOT prove is that the real relay honours
// a long system message; that stays an owner-run live check and is stated as
// such in the task writeup.

process.env.DATABASE_URL = "postgresql://t152m7:t152m7@localhost:5432/task152m7_placeholder";
process.env.SESSION_SECRET = "task152m7-test-session-secret";
process.env.RESEND_API_KEY = "task152m7-test-resend";
process.env.EMAIL_FROM = "t152m7@spaceworker.test";
process.env.APP_BASE_URL = "https://spaceworker.test";
(process.env as Record<string, string>).NODE_ENV = "test";

// ---------------------------------------------------------------------------
// In-memory stand-ins
// ---------------------------------------------------------------------------

interface DeviceRow {
  id: string;
  userId: string;
  name: string;
  screenshotMonitoringEnabled: boolean;
  createdAt: Date;
}

interface FrameRow {
  id: string;
  deviceId: string;
  userId: string;
  status: string;
  failureReason: string | null;
  summary: string | null;
  summaryError: string | null;
  summaryModel: string | null;
  summarisedAt: Date | null;
  imagePurgedAt: Date | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
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

interface ThreadRow {
  id: string;
  userId: string;
}

interface MessageRow {
  id: string;
  threadId: string;
  role: string;
  content: string;
  toolCall: unknown;
  inlineWidget: unknown;
  createdAt: Date;
}

let devices: DeviceRow[] = [];
let frames: FrameRow[] = [];
let usage: UsageRow[] = [];
let threads: ThreadRow[] = [];
let messages: MessageRow[] = [];
let users: Array<{ id: string; aiDailyCapHundredthsCent: number; agentActionsEnabled: boolean }> = [];
let idSeq = 0;
let clock = new Date("2026-10-01T12:00:00.000Z");

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
      if (cond.gte instanceof Date) {
        if (!(actual instanceof Date) || actual.getTime() < cond.gte.getTime()) return false;
        continue;
      }
      if (cond.lt instanceof Date) {
        if (!(actual instanceof Date) || actual.getTime() >= cond.lt.getTime()) return false;
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

/**
 * A write is a REFUSAL, not a no-op: TASK_152 M7 is read-only, so any attempt by
 * the context builder to touch a device or a frame makes the test FAIL loudly
 * rather than silently pass. This is the guard behind "no new device-mutation
 * path was introduced" — if it can't fire, it isn't evidence.
 */
function refuseWrite(model: string, op: string): never {
  throw new Error(`READ-ONLY VIOLATION: ${model}.${op} was called`);
}

const fakeDb = {
  device: {
    async findMany(args: {
      where?: Record<string, unknown>;
      orderBy?: { createdAt?: "asc" | "desc" };
      take?: number;
      select?: Record<string, boolean>;
    }) {
      let rows = devices.filter((d) => matches({ ...d }, args.where));
      if (args.orderBy?.createdAt === "asc") rows = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      if (args.orderBy?.createdAt === "desc") rows = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      if (typeof args.take === "number") rows = rows.slice(0, args.take);
      return rows.map((r) => pick({ ...r }, args.select));
    },
    async findFirst(args: { where?: Record<string, unknown> }) {
      return devices.find((d) => matches({ ...d }, args.where)) ?? null;
    },
    async create() {
      return refuseWrite("device", "create");
    },
    async update() {
      return refuseWrite("device", "update");
    },
    async updateMany() {
      return refuseWrite("device", "updateMany");
    },
    async delete() {
      return refuseWrite("device", "delete");
    },
    async deleteMany() {
      return refuseWrite("device", "deleteMany");
    },
  },
  deviceScreenshot: {
    async findMany(args: {
      where?: Record<string, unknown>;
      orderBy?: { createdAt?: "asc" | "desc" };
      take?: number;
      select?: Record<string, boolean>;
    }) {
      let rows = frames.filter((f) => matches({ ...f }, args.where));
      if (args.orderBy?.createdAt === "desc") rows = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      if (args.orderBy?.createdAt === "asc") rows = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      if (typeof args.take === "number") rows = rows.slice(0, args.take);
      return rows.map((r) => pick({ ...r }, args.select));
    },
    async count(args: { where?: Record<string, unknown> }) {
      return frames.filter((f) => matches({ ...f }, args.where)).length;
    },
    async create() {
      return refuseWrite("deviceScreenshot", "create");
    },
    async update() {
      return refuseWrite("deviceScreenshot", "update");
    },
    async updateMany() {
      return refuseWrite("deviceScreenshot", "updateMany");
    },
    async delete() {
      return refuseWrite("deviceScreenshot", "delete");
    },
    async deleteMany() {
      return refuseWrite("deviceScreenshot", "deleteMany");
    },
  },
  user: {
    async findUnique(args: { where: { id: string } }) {
      return users.find((u) => u.id === args.where.id) ?? null;
    },
  },
  aiUsageLog: {
    async aggregate(args: { where?: Record<string, unknown> }) {
      const rows = usage.filter((u) => matches({ ...u }, args.where));
      return { _sum: { costHundredthsCent: rows.reduce((a, r) => a + r.costHundredthsCent, 0) } };
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
  agentThread: {
    async findFirst(args: { where: { userId: string } }) {
      return threads.find((t) => t.userId === args.where.userId) ?? null;
    },
    async create(args: { data: { userId: string } }) {
      const row: ThreadRow = { id: nextId("thread"), userId: args.data.userId };
      threads.push(row);
      return { ...row };
    },
  },
  agentMessage: {
    async create(args: { data: Partial<MessageRow> }) {
      const row: MessageRow = {
        id: nextId("msg"),
        threadId: String(args.data.threadId),
        role: String(args.data.role),
        content: String(args.data.content ?? ""),
        toolCall: args.data.toolCall ?? null,
        inlineWidget: args.data.inlineWidget ?? null,
        createdAt: new Date(clock.getTime()),
      };
      messages.push(row);
      return { ...row };
    },
    async findMany(args: { where?: Record<string, unknown>; orderBy?: { createdAt?: "asc" | "desc" }; take?: number }) {
      let rows = messages.filter((m) => matches({ ...m }, args.where));
      if (args.orderBy?.createdAt === "asc") rows = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      if (args.orderBy?.createdAt === "desc") rows = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      if (typeof args.take === "number") rows = rows.slice(0, args.take);
      return rows.map((r) => ({ ...r }));
    },
    async update(args: { where: { id: string }; data: Partial<MessageRow> }) {
      const row = messages.find((m) => m.id === args.where.id);
      if (!row) throw new Error("message not found");
      Object.assign(row, args.data);
      return { ...row };
    },
  },
  agentPendingAction: {
    async create() {
      throw new Error("no tool call in these tests should persist a pending action");
    },
    async findMany() {
      return [];
    },
  },
};

// ---------------------------------------------------------------------------
// The fake relay: it RECORDS what it was sent so the test can print the raw
// system message the model would receive.
// ---------------------------------------------------------------------------

interface RecordedCall {
  messages: Array<{ role: string; content: string }>;
  opts: Record<string, unknown>;
}

let relayCalls: RecordedCall[] = [];

function fakeChannelryAiChat(opts: Record<string, unknown>) {
  relayCalls.push({
    messages: (opts.messages as Array<{ role: string; content: string }>) ?? [],
    opts,
  });
  // A plain, valid completion — NO tool_calls, so the turn is a pure conversation
  // with no pending action, exactly the "just answer with the context" case.
  return Promise.resolve({
    content: "Got it — here is what I can see from your monitor summaries.",
    usage: { mode: "chat", cost_hundredths_cent: 0 },
  });
}

class FakeChannelryAiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ChannelryAiError";
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Require hook — only the modules under test's own dependencies are swapped.
// ---------------------------------------------------------------------------

type Loader = {
  _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};

const SWAPPED_PARENTS = [
  "lib/agent.ts",
  "lib/monitor-agent-context.ts",
  "lib/device-screenshots.ts",
  "lib/resource-governor.ts",
  "lib/ai-metering.ts",
];

/** Does this raw request string name `name` (aliased, relative or absolute)? */
function isReq(request: string, name: string): boolean {
  return request === name || request.endsWith(`/${name}`) || request.endsWith(`\\${name}`);
}

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    const from = parent?.filename ?? "";
    if (SWAPPED_PARENTS.some((p) => from.endsWith(`/${p}`))) {
      // The DB for every swapped module — reads work, writes throw (see refuseWrite).
      if (isReq(request, "db") || isReq(request, "prisma")) {
        return { db: fakeDb, prisma: fakeDb };
      }
      if (isReq(request, "admin-settings")) {
        return { getAdminSettings: async () => ({}) };
      }
      if (isReq(request, "auth")) {
        return { createSessionToken: async () => "test-token", SESSION_COOKIE: "spaceworker_session" };
      }
      if (isReq(request, "entitlements")) {
        return { listEffectiveEntitlements: async () => ({ premium: false, keys: [], grants: [] }) };
      }
      if (isReq(request, "devices")) {
        return { recordAgentActionAudit: async () => {} };
      }
      if (isReq(request, "channelry-ai")) {
        return { channelryAiChat: fakeChannelryAiChat, ChannelryAiError: FakeChannelryAiError };
      }
      if (isReq(request, "agent-approval-notify")) {
        return { notifyPendingActionViaTelegram: async () => {} };
      }
      if (isReq(request, "mailbox-safe-select")) {
        return { MAILBOX_SAFE_SELECT: {} };
      }
      if (isReq(request, "lead-selectable")) {
        return { fetchSelectableData: async () => ({ jobs: [] }) };
      }
      if (isReq(request, "deliverability")) {
        return {
          DeliverabilityError: class extends Error {},
          runCampaignDiagnostics: async () => ({ results: [] }),
        };
      }
    }
    return original.call(this, request, parent, isMain);
  };
}

installRequireHook();

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  buildMonitorSummaryContext,
  collectMonitorSummaries,
  formatMonitorContext,
  MONITOR_CONTEXT_MAX_CHARS,
  MONITOR_CONTEXT_MAX_DEVICES,
  MONITOR_CONTEXT_MAX_FRAMES_PER_DEVICE,
} = require("../lib/monitor-agent-context") as typeof import("../lib/monitor-agent-context");
const { runAgentTurn } = require("../lib/agent") as typeof import("../lib/agent");
/* eslint-enable @typescript-eslint/no-require-imports */



// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addUser(id = "user_1", capHundredthsCent = 20000): void {
  users.push({ id, aiDailyCapHundredthsCent: capHundredthsCent, agentActionsEnabled: true });
}

function addDevice(
  id: string,
  opts: { userId?: string; name?: string; optIn?: boolean; createdAt?: Date } = {},
): void {
  devices.push({
    id,
    userId: opts.userId ?? "user_1",
    name: opts.name ?? id,
    screenshotMonitoringEnabled: opts.optIn ?? true,
    createdAt: opts.createdAt ?? new Date(clock.getTime()),
  });
}

/** A captured frame with a real summary (or, with summary:null, none yet). */
function addFrame(deviceId: string, over: Partial<FrameRow> = {}): string {
  const id = over.id ?? nextId("frame");
  frames.push({
    id,
    deviceId,
    userId: over.userId ?? "user_1",
    status: over.status ?? "captured",
    failureReason: over.failureReason ?? null,
    summary: over.summary ?? null,
    summaryError: over.summaryError ?? null,
    summaryModel: over.summaryModel ?? null,
    summarisedAt: over.summarisedAt ?? null,
    imagePurgedAt: over.imagePurgedAt ?? null,
    bytes: over.bytes ?? 4096,
    width: over.width ?? 1920,
    height: over.height ?? 1080,
    capturedAt: over.capturedAt ?? new Date(clock.getTime()),
    createdAt: over.createdAt ?? new Date(clock.getTime()),
  });
  return id;
}

beforeEach(() => {
  devices = [];
  frames = [];
  usage = [];
  threads = [];
  messages = [];
  users = [];
  relayCalls = [];
  idSeq = 0;
  clock = new Date("2026-10-01T12:00:00.000Z");
});

/** The single system message the last recorded relay call carried. */
function lastSystemMessage(): string {
  const call = relayCalls[relayCalls.length - 1];
  return call.messages.find((m) => m.role === "system")?.content ?? "";
}

// ---------------------------------------------------------------------------
// 1. The block itself: present with monitors, absent without.
// ---------------------------------------------------------------------------

test("buildMonitorSummaryContext: a monitored, summarised user gets a block naming the device and its summary", async () => {
  addUser("u_mon");
  addDevice("dev_1", { userId: "u_mon", name: "Studio PC" });
  addFrame("dev_1", { userId: "u_mon", summary: "Editing a budget spreadsheet in Excel." });

  const block = await buildMonitorSummaryContext("u_mon");
  assert.ok(block, "block must be non-null for a monitored user with a summary");
  assert.match(block, /Studio PC/);
  assert.match(block, /Editing a budget spreadsheet in Excel\./);
  // The in-band read-only line travels with the block.
  assert.match(block, /READ-ONLY/);
});

test("buildMonitorSummaryContext: a user with NO monitors gets null (nothing added to their prompt)", async () => {
  addUser("u_none");
  assert.equal(await buildMonitorSummaryContext("u_none"), null);
});

test("buildMonitorSummaryContext: a monitored device with no SUMMARISED frames yet is absent, not shown empty", async () => {
  addUser("u_pending");
  addDevice("dev_pending", { userId: "u_pending", name: "New Box" });
  // Captured but not summarised — the NORMAL state per DeviceScreenshot.summary.
  addFrame("dev_pending", { userId: "u_pending", summary: null, summaryError: "cap_exhausted" });

  assert.equal(await buildMonitorSummaryContext("u_pending"), null);
});

test("buildMonitorSummaryContext: a device whose monitoring is OPTED OUT is never read", async () => {
  addUser("u_optout");
  addDevice("dev_off", { userId: "u_optout", name: "Off Box", optIn: false });
  addFrame("dev_off", { userId: "u_optout", summary: "Should never appear." });

  assert.equal(await buildMonitorSummaryContext("u_optout"), null);
});

test("buildMonitorSummaryContext: another user's summary never leaks in (scoped by device ownership)", async () => {
  addUser("u_a");
  addUser("u_b");
  addDevice("dev_a", { userId: "u_a", name: "A" });
  addDevice("dev_b", { userId: "u_b", name: "B" });
  addFrame("dev_a", { userId: "u_a", summary: "A private screen." });
  addFrame("dev_b", { userId: "u_b", summary: "B private screen." });

  const blockB = await buildMonitorSummaryContext("u_b");
  assert.ok(blockB);
  assert.match(blockB, /B private screen\./);
  assert.doesNotMatch(blockB, /A private screen\./);
});

// ---------------------------------------------------------------------------
// 2. Bounds: the block can never grow without limit.
// ---------------------------------------------------------------------------

test("collectMonitorSummaries: keeps the newest MAX_FRAMES_PER_DEVICE summaries, newest first", async () => {
  addUser("u_frames");
  addDevice("dev_f", { userId: "u_frames", name: "Box" });
  for (let i = 0; i < MONITOR_CONTEXT_MAX_FRAMES_PER_DEVICE + 3; i += 1) {
    clock = new Date(clock.getTime() + 60_000);
    addFrame("dev_f", { userId: "u_frames", summary: `summary ${i}` });
  }
  const collected = await collectMonitorSummaries("u_frames");
  assert.equal(collected.length, 1);
  assert.equal(collected[0].frames.length, MONITOR_CONTEXT_MAX_FRAMES_PER_DEVICE);
  // Newest first: the last frame added must be the first one reported.
  assert.match(
    collected[0].frames[0].summary,
    new RegExp(`summary ${MONITOR_CONTEXT_MAX_FRAMES_PER_DEVICE + 2}$`),
  );
});

test("collectMonitorSummaries: caps the number of DEVICES it reports", async () => {
  addUser("u_many");
  const total = MONITOR_CONTEXT_MAX_DEVICES + 4;
  for (let d = 0; d < total; d += 1) {
    clock = new Date(clock.getTime() + 60_000);
    addDevice(`dev_${d}`, { userId: "u_many", name: `D${d}` });
    addFrame(`dev_${d}`, { userId: "u_many", summary: `d${d} summary` });
  }
  const collected = await collectMonitorSummaries("u_many");
  assert.equal(collected.length, MONITOR_CONTEXT_MAX_DEVICES);
});

test("formatMonitorContext: an EMPTY list is null (no header, no empty device line)", () => {
  assert.equal(formatMonitorContext([]), null);
});

test("formatMonitorContext: NEVER exceeds MAX_CHARS, and omissions are MARKED not silent", () => {
  const entries = Array.from({ length: MONITOR_CONTEXT_MAX_DEVICES }, (_, d) => ({
    deviceId: `d${d}`,
    deviceName: `Device ${d}`,
    frames: Array.from({ length: MONITOR_CONTEXT_MAX_FRAMES_PER_DEVICE }, (_, f) => ({
      at: `2026-10-01T12:0${f}:00.000Z`,
      summary: `device ${d} frame ${f} ` + "x".repeat(200),
    })),
  }));
  const block = formatMonitorContext(entries) as string;
  assert.ok(block);
  assert.ok(
    block.length <= MONITOR_CONTEXT_MAX_CHARS,
    `block ${block.length} must be <= ${MONITOR_CONTEXT_MAX_CHARS}`,
  );
  assert.match(block, /more summaries not shown/);
});

// ---------------------------------------------------------------------------
// 3. The agent's OWN turn: summaries ride the existing single system message,
//    the cap still gates it, and nothing new is mutable.
// ---------------------------------------------------------------------------

test("runAgentTurn: the user's monitor summaries ride the turn's single system message (RAW)", async () => {
  addUser("u_live");
  addDevice("dev_live", { userId: "u_live", name: "Editing Rig" });
  addFrame("dev_live", { userId: "u_live", summary: "Grading footage in DaVinci Resolve." });

  const result = await runAgentTurn({ userId: "u_live", message: "What was I working on?" });

  assert.equal(relayCalls.length, 1, "exactly one metered relay call");
  assert.equal(
    relayCalls[0].messages.filter((m) => m.role === "system").length,
    1,
    "ONE system message (never a second, which the relay ignores)",
  );
  // RAW EVIDENCE — the exact system message handed to the model, verbatim.
  console.log("[M7-EVIDENCE] monitored user — system message the model receives:\n" + lastSystemMessage());
  // The BLOCK's own header (distinct from the prompt's general mention of it).
  assert.match(lastSystemMessage(), /recent screen-activity summaries from this user's OWN/);
  assert.match(lastSystemMessage(), /Editing Rig/);
  assert.match(lastSystemMessage(), /Grading footage in DaVinci Resolve\./);
  // READ-ONLY: the turn produced no proposal and no widget.
  assert.equal(result.pendingAction, null);
  assert.equal(result.inlineWidget, null);
});

test("runAgentTurn: an UNMONITORED user's system message carries NO monitor block", async () => {
  addUser("u_plain");
  const result = await runAgentTurn({ userId: "u_plain", message: "hello" });
  console.log("[M7-EVIDENCE] unmonitored user — system message the model receives:\n" + lastSystemMessage());
  assert.doesNotMatch(lastSystemMessage(), /recent screen-activity summaries from this user's OWN/);
  assert.equal(result.pendingAction, null);
});

test("runAgentTurn: the per-user daily AI cap still gates the turn — over cap, zero relay calls", async () => {
  addUser("u_capped", 500);
  addDevice("dev_capped", { userId: "u_capped", name: "Box" });
  addFrame("dev_capped", { userId: "u_capped", summary: "Must never be sent while over cap." });
  // Spend exactly the cap today, through the REAL AiUsageLog row shape.
  usage.push({
    id: nextId("usage"),
    userId: "u_capped",
    costHundredthsCent: 500,
    eventType: "agent_turn",
    createdAt: new Date(),
  });

  const result = await runAgentTurn({ userId: "u_capped", message: "what did I do today?" });

  console.log(
    `[M7-EVIDENCE] over-cap: relay calls = ${relayCalls.length} ; reply = ${JSON.stringify(result.reply)}`,
  );
  assert.equal(relayCalls.length, 0, "cap short-circuits BEFORE any relay call (zero spend)");
  assert.match(result.reply, /AI usage limit/);
});

test("READ-ONLY guard: any attempt to WRITE a device or frame fails loudly (the guard fires)", async () => {
  addUser("u_guard");
  // Print the ACTUAL messages so the guard's firing is raw evidence, not an
  // assertion that could be vacuous: if lib/monitor-agent-context.ts ever wrote a
  // device or a frame, the real reads below would throw instead of returning.
  for (const attempt of [() => fakeDb.device.update(), () => fakeDb.deviceScreenshot.deleteMany()]) {
    try {
      await attempt();
      assert.fail("guard did NOT fire — a write was allowed");
    } catch (err) {
      console.log("[M7-EVIDENCE] guard fired: " + (err as Error).message);
      assert.match((err as Error).message, /READ-ONLY VIOLATION/);
    }
  }
  // The real context builder reads the same user without tripping either guard.
  addDevice("dev_g", { userId: "u_guard", name: "G" });
  addFrame("dev_g", { userId: "u_guard", summary: "read-only ok" });
  assert.ok(await buildMonitorSummaryContext("u_guard"));
});

