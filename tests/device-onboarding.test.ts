import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

import {
  ONBOARDING_MAX_ATTEMPTS,
  formatOnboardingCountdown,
  formatOnboardingEta,
  isOnboardingTerminal,
  nextOnboardingAction,
  onboardingView,
} from "../lib/device-onboarding";
import { DEFAULT_AGENT_LABEL, buildHideAgentScript } from "../lib/agent-visibility";

// TASK_128 — device onboarding quarantine.
//
// WHY THIS FILE EXISTS: the acceptance is a 20-minute window whose stages fire
// on a 5-minute sweep against a real device (hide@5, stay-on@10, move@15 on
// Vantra's clock, released@20). Everything below instead exercises the REAL
// rule module (lib/device-onboarding.ts) and the REAL sweep route
// (app/api/internal/device-onboarding-sweep/route.ts) through the house require
// hook, swapping only their own dependencies for recording fakes — never a copy
// of the logic and never a mocked module under test. Nothing here touches a real
// database, Vantra, or a device.

// ---------------------------------------------------------------------------
// The in-memory store + recording fakes
// ---------------------------------------------------------------------------

interface DeviceRow {
  id: string;
  userId: string;
  name: string;
  tier: string;
  lastSeenAt: Date | null;
}

interface OnboardingRow {
  id: string;
  deviceId: string;
  userId: string;
  vantraAgentId: string;
  sourceOrgId: string;
  destinationOrgId: string | null;
  timerStartedAt: Date;
  hideLabel: string | null;
  hideDoneAt: Date | null;
  hideOutput: string | null;
  stayOnDoneAt: Date | null;
  movedAt: Date | null;
  releasedAt: Date | null;
  status: string;
  attempts: number;
  lastError: string | null;
  claimAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const devices = new Map<string, DeviceRow>();
let rows: OnboardingRow[] = [];
let idSeq = 0;

/** Structural matcher covering exactly the where-clauses the sweep uses. */
function matches(row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [key, expected] of Object.entries(where)) {
    const actual = row[key];
    if (expected === undefined) continue;
    if (expected !== null && typeof expected === "object") {
      const cond = expected as Record<string, unknown>;
      if (Array.isArray(cond.in) && !(cond.in as unknown[]).some((v) => v === actual)) return false;
      if (Array.isArray(cond.notIn) && (cond.notIn as unknown[]).some((v) => v === actual)) return false;
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}

function applyData(row: Record<string, unknown>, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === "object" && "increment" in (value as object)) {
      const by = (value as { increment: number }).increment;
      row[key] = ((row[key] as number) ?? 0) + by;
    } else {
      row[key] = value;
    }
  }
}

function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}_${idSeq}`;
}

/** Set ONLY when the sweep records "move in flight" — proves "once". */
let movingWrites = 0;
/** A row id whose `update` throws — proves one device cannot abort the sweep. */
let failUpdateId: string | null = null;

const fakePrisma = {
  deviceOnboarding: {
    async findMany(args: { where?: Record<string, unknown>; include?: unknown }) {
      return rows
        .filter((r) => matches(r as unknown as Record<string, unknown>, args.where))
        .map((r) => ({ ...r, device: { ...devices.get(r.deviceId) } }));
    },
    async updateMany(args: { where?: Record<string, unknown>; data: Record<string, unknown> }) {
      const hit = rows.filter((r) => matches(r as unknown as Record<string, unknown>, args.where));
      for (const row of hit) {
        if (args.data.status === "moving") movingWrites++;
        applyData(row as unknown as Record<string, unknown>, args.data);
      }
      return { count: hit.length };
    },
    async update(args: { where: { id: string }; data: Record<string, unknown> }) {
      if (failUpdateId && args.where.id === failUpdateId) throw new Error("db down");
      const row = rows.find((r) => r.id === args.where.id);
      if (!row) throw new Error("onboarding not found");
      applyData(row as unknown as Record<string, unknown>, args.data);
      return { ...row };
    },
  },
};

let hideCalls: Array<Record<string, unknown>> = [];
let stayOnCalls: Array<Record<string, unknown>> = [];
let hideBehavior: "ok" | "fail_output" | "throw" = "ok";
let stayOnBehavior: "ok" | "throw" = "ok";
let bearerOk = true;

const fakeRunCommandNow = async (opts: Record<string, unknown>) => {
  hideCalls.push(opts);
  if (hideBehavior === "throw") throw new Error("agent_unreachable");
  if (hideBehavior === "fail_output") {
    return { output: "STEP:agent_service FAIL:agent_service_missing", ranAt: new Date() };
  }
  return {
    output: "STEP:agent_service OK:tacticalrmm\nSTEP:rename:tacticalrmm OK\nVERIFY:service:tacticalrmm",
    ranAt: new Date(),
  };
};

const fakeSetPowerPolicy = async (opts: Record<string, unknown>) => {
  stayOnCalls.push(opts);
  if (stayOnBehavior === "throw") throw new Error("keep_awake_apply_failed");
  return { mode: "indefinite", until: null };
};

type Loader = {
  _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};

const ROUTE = "app/api/internal/device-onboarding-sweep/route.ts";

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    const from = (parent?.filename ?? "").replace(/\\/g, "/");
    if (from.endsWith(`/${ROUTE}`)) {
      if (request === "next/server") {
        return {
          NextResponse: {
            json: (body: unknown, init?: { status?: number }) => ({
              status: init?.status ?? 200,
              body,
              json: async () => body,
            }),
          },
        };
      }
      if (request === "@/lib/prisma") return { prisma: fakePrisma };
      if (request === "@/lib/internal-auth") return { requireInternalBearer: () => bearerOk };
      if (request === "@/lib/devices") {
        return {
          isDeviceOnline: (d: Date | null) => !!d && Date.now() - d.getTime() < 10 * 60_000,
        };
      }
      if (request === "@/lib/device-tools") {
        return { runCommandNow: fakeRunCommandNow, setPowerPolicy: fakeSetPowerPolicy };
      }
      // The rule module and the script builders are REAL — the route's own
      // decisions are what these tests are about.
      if (request === "@/lib/device-onboarding") return realOnboarding;
      if (request === "@/lib/agent-visibility") return realAgentVisibility;
    }
    return original.call(this, request, parent, isMain);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
const realOnboarding = require("../lib/device-onboarding") as typeof import("../lib/device-onboarding");
const realAgentVisibility = require("../lib/agent-visibility") as typeof import("../lib/agent-visibility");
installRequireHook();
const routeModule = require("../app/api/internal/device-onboarding-sweep/route") as {
  POST: (req: Request) => Promise<{ status: number; body: { checked: number; acted: number } }>;
};
/* eslint-enable @typescript-eslint/no-require-imports */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE = new Date("2026-09-27T12:00:00.000Z");
const T0 = BASE.getTime();
const at = (minutes: number, seconds = 0): number => T0 + (minutes * 60 + seconds) * 1000;
const minutesAgo = (m: number): Date => new Date(Date.now() - m * 60_000);

/** A device for the store; `online` sets lastSeenAt relative to the real now. */
function addDevice(id: string, opts: { tier?: string; online?: boolean } = {}): DeviceRow {
  const device: DeviceRow = {
    id,
    userId: "user_1",
    name: `Device ${id}`,
    tier: opts.tier ?? "public",
    lastSeenAt: opts.online === false ? minutesAgo(30) : new Date(),
  };
  devices.set(id, device);
  return device;
}

/** An onboarding row; defaults to t=6 min ago (hide due, not done). */
function addOnboarding(deviceId: string, over: Partial<OnboardingRow> = {}): OnboardingRow {
  const started = over.timerStartedAt ?? minutesAgo(6);
  const row: OnboardingRow = {
    id: nextId("onb"),
    deviceId,
    userId: "user_1",
    vantraAgentId: `agent_${deviceId}`,
    sourceOrgId: "org_public",
    destinationOrgId: "org_private",
    timerStartedAt: started,
    hideLabel: DEFAULT_AGENT_LABEL,
    hideDoneAt: null,
    hideOutput: null,
    stayOnDoneAt: null,
    movedAt: null,
    releasedAt: null,
    status: "pending",
    attempts: 0,
    lastError: null,
    claimAt: null,
    createdAt: started,
    updatedAt: started,
    ...over,
  };
  rows.push(row);
  return row;
}

function post(): Promise<{ status: number; body: { checked: number; acted: number } }> {
  return routeModule.POST(new Request("https://spaceworker.test/api/internal/device-onboarding-sweep", { method: "POST" }));
}

beforeEach(() => {
  devices.clear();
  rows = [];
  hideCalls = [];
  stayOnCalls = [];
  hideBehavior = "ok";
  stayOnBehavior = "ok";
  bearerOk = true;
  movingWrites = 0;
  failUpdateId = null;
});

// ---------------------------------------------------------------------------
// nextOnboardingAction — the pure rule (thresholds, order, terminal)
// ---------------------------------------------------------------------------

const baseInput = (over: Partial<Parameters<typeof nextOnboardingAction>[0]> = {}) => ({
  status: "pending",
  tier: "public",
  timerStartedAt: BASE,
  hideDoneAt: null,
  stayOnDoneAt: null,
  ...over,
});

test("hide fires at exactly 5 minutes, not a second earlier", () => {
  assert.equal(nextOnboardingAction(baseInput(), at(5, -1)), "wait");
  assert.equal(nextOnboardingAction(baseInput(), at(5)), "hide");
});

test("stay_on fires at exactly 10 minutes once hide is done, not a second earlier", () => {
  const done = { hideDoneAt: new Date(T0 + 5 * 60_000) };
  assert.equal(nextOnboardingAction(baseInput(done), at(10, -1)), "wait");
  assert.equal(nextOnboardingAction(baseInput(done), at(10)), "stay_on");
});

test("release fires at exactly 20 minutes once both stages are done, not a second earlier", () => {
  const done = {
    hideDoneAt: new Date(T0 + 5 * 60_000),
    stayOnDoneAt: new Date(T0 + 10 * 60_000),
  };
  assert.equal(nextOnboardingAction(baseInput(done), at(20, -1)), "wait");
  assert.equal(nextOnboardingAction(baseInput(done), at(20)), "release");
});

test("order is hide -> stay_on -> release, and stay_on cannot fire before hide is done", () => {
  // 12 min in with hide still not done: the decision is STILL hide, never stay_on.
  assert.equal(nextOnboardingAction(baseInput(), at(12)), "hide");
  const hideDone = { hideDoneAt: new Date(T0 + 6 * 60_000) };
  assert.equal(nextOnboardingAction(baseInput(hideDone), at(6)), "wait"); // 5..10 gap
  assert.equal(nextOnboardingAction(baseInput(hideDone), at(11)), "stay_on");
  const bothDone = { ...hideDone, stayOnDoneAt: new Date(T0 + 11 * 60_000) };
  assert.equal(nextOnboardingAction(baseInput(bothDone), at(16)), "wait"); // 15..20 = moving, not an action
  assert.equal(nextOnboardingAction(baseInput(bothDone), at(20)), "release");
});

test("tier private releases early, whatever the clock", () => {
  assert.equal(nextOnboardingAction(baseInput({ tier: "private" }), at(0)), "release");
  assert.equal(nextOnboardingAction(baseInput({ tier: "private" }), at(25)), "release");
});

test("a released or failed row always returns terminal — the never-fires-twice guarantee", () => {
  for (const status of ["released", "failed"]) {
    assert.equal(nextOnboardingAction(baseInput({ status }), at(25)), "terminal");
    assert.equal(nextOnboardingAction(baseInput({ status, tier: "private" }), at(25)), "terminal");
  }
});

test("a stage with its *DoneAt set never re-fires (the crash-safe claim)", () => {
  const hideDone = { hideDoneAt: new Date(T0 + 5 * 60_000) };
  assert.notEqual(nextOnboardingAction(baseInput(hideDone), at(6)), "hide");
  const bothDone = { ...hideDone, stayOnDoneAt: new Date(T0 + 10 * 60_000) };
  assert.notEqual(nextOnboardingAction(baseInput(bothDone), at(11)), "stay_on");
});

test("a DEAD claim (hiding / staying_on with *DoneAt null) is re-adopted next sweep", () => {
  // The in-flight status is not a gate; the missing *DoneAt is.
  assert.equal(nextOnboardingAction(baseInput({ status: "hiding" }), at(6)), "hide");
  assert.equal(
    nextOnboardingAction(
      baseInput({ status: "staying_on", hideDoneAt: new Date(T0 + 5 * 60_000) }),
      at(12),
    ),
    "stay_on",
  );
});


// ---------------------------------------------------------------------------
// onboardingView — the exact copy (a copy regression must fail this test)
// ---------------------------------------------------------------------------

const viewInput = (over: Partial<Parameters<typeof onboardingView>[0]> = {}) => ({
  status: "pending",
  tier: "public",
  timerStartedAt: BASE,
  hideDoneAt: null,
  stayOnDoneAt: null,
  destinationOrgId: "org_private",
  isOnline: true,
  ...over,
});

test("step 1 copy is exactly the spec's", () => {
  const v = onboardingView(viewInput(), at(2));
  assert.deepEqual(
    { step: v.step, title: v.title, detail: v.detail, next: v.next },
    { step: 1, title: "Quarantined", detail: "waiting for the first check-in", next: "hide" },
  );
});

test("step 2 copy is exactly the spec's", () => {
  const v = onboardingView(viewInput(), at(6));
  assert.deepEqual(
    { step: v.step, title: v.title, detail: v.detail, next: v.next },
    {
      step: 2,
      title: "Hiding the agent",
      detail: "so it can't be stopped from the machine",
      next: "stay on",
    },
  );
});

test("step 3 copy is exactly the spec's", () => {
  const v = onboardingView(viewInput({ hideDoneAt: new Date(T0 + 5 * 60_000) }), at(12));
  assert.deepEqual(
    { step: v.step, title: v.title, detail: v.detail, next: v.next },
    { step: 3, title: "Staying awake", detail: "keeping it reachable for the move", next: "move" },
  );
});

test("step 4 copy is exactly the spec's", () => {
  const v = onboardingView(
    viewInput({ hideDoneAt: new Date(T0 + 5 * 60_000), stayOnDoneAt: new Date(T0 + 10 * 60_000) }),
    at(16),
  );
  assert.deepEqual(
    { step: v.step, title: v.title, detail: v.detail, next: v.next },
    { step: 4, title: "Moving to your private agent", detail: "almost done", next: null },
  );
});

test("no private destination: step 4 says so, and the window still ends at 20", () => {
  const v = onboardingView(viewInput({ destinationOrgId: null }), at(16));
  assert.equal(v.detail, "stays on your public agent — no private agent on this plan");
  assert.equal(
    nextOnboardingAction(
      {
        status: "pending",
        tier: "public",
        timerStartedAt: BASE,
        hideDoneAt: new Date(T0 + 5 * 60_000),
        stayOnDoneAt: new Date(T0 + 10 * 60_000),
      },
      at(20),
    ),
    "release",
  );
});

test("waitingForDevice is true only when a due stage's device is not online", () => {
  assert.equal(onboardingView(viewInput({ isOnline: false }), at(6)).waitingForDevice, true);
  assert.equal(onboardingView(viewInput({ isOnline: true }), at(6)).waitingForDevice, false);
  // Nothing is due at step 1, so it is never "waiting".
  assert.equal(onboardingView(viewInput({ isOnline: false }), at(2)).waitingForDevice, false);
  // Hide done, stay-on due, box offline.
  const v = onboardingView(
    viewInput({ hideDoneAt: new Date(T0 + 5 * 60_000), isOnline: false }),
    at(12),
  );
  assert.equal(v.waitingForDevice, true);
});

test("the countdown text never promises an exact minute", () => {
  assert.equal(formatOnboardingCountdown(6 * 60_000), "~6 min left");
  assert.equal(formatOnboardingCountdown(30_000), "in a few minutes");
  assert.equal(formatOnboardingCountdown(0), "any moment now");
  assert.equal(formatOnboardingEta(2 * 60_000), "~2 min");
});

test("isOnboardingTerminal only covers released/failed", () => {
  assert.equal(isOnboardingTerminal("released"), true);
  assert.equal(isOnboardingTerminal("failed"), true);
  for (const s of ["pending", "hiding", "staying_on", "moving"]) {
    assert.equal(isOnboardingTerminal(s), false);
  }
});


// ---------------------------------------------------------------------------
// The sweep route — claims, retries, offline skip, release
// ---------------------------------------------------------------------------

test("401 when the bearer is wrong, and nothing runs", async () => {
  bearerOk = false;
  const res = await post();
  assert.equal(res.status, 401);
  assert.equal(hideCalls.length, 0);
});

test("offline at a due threshold: skip, retry next cycle, NO attempt burned", async () => {
  addDevice("d1", { online: false });
  addOnboarding("d1");
  const res = await post();
  assert.equal(res.body.checked, 1);
  assert.equal(hideCalls.length, 0, "never runs the hide on a sleeping box");
  assert.equal(rows[0].attempts, 0, "an asleep box is not a failed attempt");
  assert.equal(rows[0].status, "pending");
});

test("hide: the exact existing transport is called, then hideDoneAt is set", async () => {
  addDevice("d1");
  addOnboarding("d1");
  const res = await post();
  assert.equal(hideCalls.length, 1);
  assert.deepEqual(hideCalls[0], {
    userId: "user_1",
    deviceId: "d1",
    cmd: buildHideAgentScript(DEFAULT_AGENT_LABEL),
    shell: "powershell",
    timeoutSeconds: 90,
    runAsUser: false,
  });
  assert.ok(rows[0].hideDoneAt);
  assert.equal(rows[0].status, "pending");
  assert.equal(rows[0].claimAt, null);
  assert.match(String(rows[0].hideOutput), /STEP:agent_service OK/);
  assert.equal(res.body.acted, 1);
});

test("hide never fires twice once hideDoneAt is set — the *DoneAt is the claim", async () => {
  addDevice("d1");
  addOnboarding("d1", { hideDoneAt: new Date() });
  await post();
  assert.equal(hideCalls.length, 0);
});

test("a DEAD hide claim (status hiding, hideDoneAt null) is re-adopted and re-run", async () => {
  addDevice("d1");
  addOnboarding("d1", { status: "hiding", claimAt: minutesAgo(4) });
  await post();
  assert.equal(hideCalls.length, 1, "a dead claim is re-claimed, not skipped");
  assert.ok(rows[0].hideDoneAt);
});

test("a hide script that reports FAIL: retries, then goes terminal at the cap", async () => {
  addDevice("d1");
  addOnboarding("d1");
  hideBehavior = "fail_output";
  await post();
  assert.equal(rows[0].status, "pending");
  assert.equal(rows[0].attempts, 1);
  assert.equal(rows[0].hideDoneAt, null);
  assert.match(String(rows[0].lastError), /FAIL:/);

  rows[0].attempts = ONBOARDING_MAX_ATTEMPTS - 1;
  await post();
  assert.equal(rows[0].attempts, ONBOARDING_MAX_ATTEMPTS);
  assert.equal(rows[0].status, "failed");
});

test("a thrown hide error (agent unreachable) is capped at 6 too", async () => {
  addDevice("d1");
  addOnboarding("d1", { attempts: ONBOARDING_MAX_ATTEMPTS - 1 });
  hideBehavior = "throw";
  await post();
  assert.equal(rows[0].status, "failed");
  assert.equal(rows[0].lastError, "agent_unreachable");
});

test("stay_on cannot fire before hide is done", async () => {
  addDevice("d1");
  addOnboarding("d1", { timerStartedAt: minutesAgo(12) });
  await post();
  assert.equal(hideCalls.length, 1);
  assert.equal(stayOnCalls.length, 0, "hide must land first");
});

test("stay_on applies the EXISTING indefinite keep-awake after hide", async () => {
  addDevice("d1");
  addOnboarding("d1", { timerStartedAt: minutesAgo(12), hideDoneAt: minutesAgo(7) });
  const res = await post();
  assert.equal(hideCalls.length, 0);
  assert.equal(stayOnCalls.length, 1);
  assert.deepEqual(stayOnCalls[0], { userId: "user_1", deviceId: "d1", mode: "indefinite" });
  assert.ok(rows[0].stayOnDoneAt);
  assert.equal(rows[0].status, "pending");
  assert.equal(res.body.acted, 1);
});

test("a keep-awake failure retries and is capped at 6 -> failed", async () => {
  addDevice("d1");
  addOnboarding("d1", {
    timerStartedAt: minutesAgo(12),
    hideDoneAt: minutesAgo(7),
    attempts: ONBOARDING_MAX_ATTEMPTS - 1,
  });
  stayOnBehavior = "throw";
  await post();
  assert.equal(rows[0].status, "failed");
  assert.equal(rows[0].lastError, "keep_awake_apply_failed");
});


test("the window records `moving` once at 15 min, then releases at 20", async () => {
  addDevice("d1");
  addOnboarding("d1", {
    timerStartedAt: minutesAgo(16),
    hideDoneAt: minutesAgo(11),
    stayOnDoneAt: minutesAgo(6),
  });
  await post();
  assert.equal(rows[0].status, "moving");
  await post();
  assert.equal(movingWrites, 1, "recorded once, not on every sweep");

  rows[0].timerStartedAt = minutesAgo(21);
  const res = await post();
  assert.equal(rows[0].status, "released");
  assert.ok(rows[0].releasedAt);
  assert.equal(rows[0].movedAt, null, "still public, so no movedAt is claimed");
  assert.equal(res.body.acted, 1);
});

test("tier private releases immediately and records movedAt", async () => {
  addDevice("d1", { tier: "private" });
  addOnboarding("d1", { timerStartedAt: minutesAgo(2) });
  await post();
  assert.equal(rows[0].status, "released");
  assert.ok(rows[0].movedAt);
});

test("no private destination: the window still releases at 20 with the device public", async () => {
  addDevice("d1");
  addOnboarding("d1", {
    destinationOrgId: null,
    timerStartedAt: minutesAgo(21),
    hideDoneAt: minutesAgo(16),
    stayOnDoneAt: minutesAgo(11),
  });
  await post();
  assert.equal(rows[0].status, "released");
  assert.equal(rows[0].movedAt, null);
  assert.equal(devices.get("d1")!.tier, "public");
});

test("a terminal row is never loaded or acted on", async () => {
  addDevice("d1");
  addOnboarding("d1", { status: "released", releasedAt: new Date() });
  const res = await post();
  assert.equal(res.body.checked, 0);
  assert.equal(hideCalls.length, 0);
  assert.equal(stayOnCalls.length, 0);
});

test("one device's failure never aborts the sweep for the rest", async () => {
  addDevice("bad");
  addDevice("good");
  const bad = addOnboarding("bad");
  addOnboarding("good");
  failUpdateId = bad.id;
  const res = await post();
  assert.equal(res.status, 200);
  assert.equal(res.body.checked, 2);
  const good = rows.find((r) => r.deviceId === "good")!;
  assert.ok(good.hideDoneAt, "the second device was still processed");
});

