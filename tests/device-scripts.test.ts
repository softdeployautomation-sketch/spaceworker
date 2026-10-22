import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// 2026-10-22 — saved device scripts.
//
// Exercises the REAL dispatcher (lib/device-scripts.ts) against an in-memory
// fake Prisma + recording runCommandNow, so the invariants that keep scripts
// safe on BOTH transports are tested, not copies of them:
//   (1) a run is claimed exactly once (queued -> running compare-and-set), so
//       the inline "Run now" path and the 60s sweep can never double-execute;
//   (2) an offline/removed device is SKIPPED, never burned as failed;
//   (3) ownership of script and devices is re-checked from the DB;
//   (4) the enrollment trigger fires once per (rule, device), only for devices
//       that appeared after the rule, only for public devices.

type Row = Record<string, unknown>;

interface FakeDevice {
  id: string;
  userId: string;
  name: string;
  tier: string;
  status: string;
  lastSeenAt: Date | null;
  removedAt: Date | null;
  vantraAgentId: string | null;
}

const devices: FakeDevice[] = [];
const scripts: Row[] = [];
const rules: Row[] = [];
let runs: Row[] = [];
const runCalls: Array<{ deviceId: string; cmd: string }> = [];
let nextId = 1;
/** When set, the next run's transport throws this message. */
let commandError: string | null = null;
/** When set, the next run reports this exit code. */
let commandExit: number | null = 0;

function matcher(where: Row | undefined) {
  return (rowLike: object) => {
    const row = rowLike as Row;
    if (!where) return true;
    return Object.entries(where).every(([key, expected]) => {
      const actual = row[key];
      if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
        const cond = expected as Row;
        if (Array.isArray(cond.in)) return (cond.in as unknown[]).includes(actual);
        if (cond.lte instanceof Date) return actual instanceof Date && actual <= cond.lte;
        return true;
      }
      return actual === expected;
    });
  };
}

const fakeDb = {
  deviceScript: {
    async findMany(args: { where?: Row }) {
      return scripts.filter(matcher(args?.where));
    },
    async findFirst(args: { where?: Row }) {
      return scripts.find(matcher(args?.where)) ?? null;
    },
    async create(args: { data: Row }) {
      const row = { id: `s${nextId++}`, archivedAt: null, ...args.data };
      scripts.push(row);
      return row;
    },
  },
  deviceScriptAutoRule: {
    async findMany(args: { where?: Row }) {
      return rules.filter(matcher(args?.where));
    },
    async findFirst(args: { where?: Row }) {
      return rules.find(matcher(args?.where)) ?? null;
    },
  },
  device: {
    async findMany(args: { where?: Row }) {
      return devices.filter(matcher(args?.where));
    },
  },
  deviceScriptRun: {
    async createMany(args: { data: Row[]; skipDuplicates?: boolean }) {
      let count = 0;
      for (const data of args.data) {
        const dup = runs.some(
          (r) => r.autoRuleId === data.autoRuleId && r.deviceId === data.deviceId,
        );
        if (dup && args.skipDuplicates) continue;
        runs.push({ id: `r${nextId++}`, status: "queued", ...data });
        count++;
      }
      return { count };
    },
    async create(args: { data: Row }) {
      const row = {
        id: `r${nextId++}`,
        status: "queued",
        exitCode: null,
        output: null,
        error: null,
        finishedAt: null,
        ...args.data,
      };
      runs.push(row);
      return { id: row.id };
    },
    async updateMany(args: { where: Row; data: Row }) {
      const hit = runs.filter(matcher(args.where));
      for (const row of hit) Object.assign(row, args.data);
      return { count: hit.length };
    },
    async findUnique(args: { where: { id: string }; include?: unknown }) {
      const row = runs.find((r) => r.id === args.where.id);
      if (!row) return null;
      const script = scripts.find((s) => s.id === row.scriptId) ?? null;
      const device = devices.find((d) => d.id === row.deviceId) ?? null;
      return { ...row, script, device };
    },
    async update(args: { where: { id: string }; data: Row }) {
      const row = runs.find((r) => r.id === args.where.id);
      if (!row) throw new Error("run not found");
      Object.assign(row, args.data);
      return { ...row };
    },
    async findMany(args: { where?: Row; take?: number; orderBy?: unknown }) {
      let hit = runs.filter(matcher(args?.where));
      if (typeof args?.take === "number") hit = hit.slice(0, args.take);
      return hit.map((r) => ({ ...r }));
    },
  },
};

type Loader = {
  _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};

const loader = Module as unknown as Loader;
const original = loader._load;
loader._load = function patched(request, parent, isMain) {
  if (request === "server-only") return {};
  const from = (parent?.filename ?? "").replace(/\\/g, "/");
  if (from.endsWith("/lib/device-scripts.ts")) {
    if (request === "./db") return { db: fakeDb };
    if (request === "./devices") {
      return { deviceStatus: (d: { status: string }) => d.status };
    }
    if (request === "./device-tools") {
      return {
        async runCommandNow(opts: { deviceId: string; cmd: string }) {
          if (commandError) throw new Error(commandError);
          runCalls.push({ deviceId: opts.deviceId, cmd: opts.cmd });
          return { output: "ok output", ranAt: new Date(), exitCode: commandExit };
        },
      };
    }
  }
  return original.call(this, request, parent, isMain);
};

// Require AFTER the hook so the fakes win (tsx runs these tests as CJS, so a
// top-level `await import` is not available — same house pattern as
// tests/device-onboarding.test.ts).
/* eslint-disable @typescript-eslint/no-require-imports */
const {
  normalizeScriptInput,
  ScriptInputError,
  createScriptRuns,
  dispatchScriptRun,
  enqueueAutoScriptRuns,
  MAX_RUN_DEVICES,
} = require("../lib/device-scripts") as typeof import("../lib/device-scripts");
/* eslint-enable @typescript-eslint/no-require-imports */

const NOW = new Date("2026-10-22T12:00:00Z");

function reset() {
  devices.length = 0;
  scripts.length = 0;
  rules.length = 0;
  runs = [];
  runCalls.length = 0;
  commandError = null;
  commandExit = 0;
}

function seedDevice(over: Partial<FakeDevice> = {}) {
  const d: FakeDevice = {
    id: `d${devices.length + 1}`,
    userId: "u1",
    name: `PC-${devices.length + 1}`,
    tier: "public",
    status: "online",
    lastSeenAt: NOW,
    removedAt: null,
    vantraAgentId: `agent-${devices.length + 1}`,
    ...over,
  };
  devices.push(d);
  return d;
}

function seedScript(over: Row = {}) {
  const row: Row = {
    id: `s${nextId++}`,
    userId: "u1",
    name: "Rotate logs",
    shell: "powershell",
    body: "Write-Output hi",
    timeoutSeconds: 30,
    archivedAt: null,
    ...over,
  };
  scripts.push(row);
  return row;
}

test("normalizeScriptInput: defaults, validation, timeout clamp", () => {
  const ok = normalizeScriptInput({ name: " x ", shell: "cmd", body: " whoami " });
  assert.equal(ok.name, "x");
  assert.equal(ok.shell, "cmd");
  assert.equal(ok.timeoutSeconds, 90);

  assert.throws(() => normalizeScriptInput({ name: "", shell: "cmd", body: "x" }), ScriptInputError);
  assert.throws(() => normalizeScriptInput({ name: "a", shell: "cmd", body: "  " }), ScriptInputError);
  assert.throws(
    () => normalizeScriptInput({ name: "a", shell: "bash" as never, body: "x" }),
    ScriptInputError,
  );
  assert.equal(
    normalizeScriptInput({ name: "a", shell: "cmd", body: "x", timeoutSeconds: 9999 }).timeoutSeconds,
    90,
  );
  assert.equal(
    normalizeScriptInput({ name: "a", shell: "cmd", body: "x", timeoutSeconds: 0 }).timeoutSeconds,
    90,
  );
});

test("createScriptRuns: re-checks ownership of script and every device", async () => {
  reset();
  const device = seedDevice();
  seedScript({ id: "s-own" });
  seedScript({ id: "s-other", userId: "u2" });

  await assert.rejects(
    createScriptRuns({
      userId: "u1",
      scriptId: "s-other",
      deviceIds: [device.id],
      trigger: "manual",
    }),
    ScriptInputError,
  );
  await assert.rejects(
    createScriptRuns({
      userId: "u1",
      scriptId: "s-own",
      deviceIds: ["nope"],
      trigger: "manual",
    }),
    ScriptInputError,
  );

  const ids = await createScriptRuns({
    userId: "u1",
    scriptId: "s-own",
    deviceIds: [device.id, device.id],
    trigger: "manual",
  });
  assert.equal(ids.length, 1, "duplicate device ids collapse to one run");
});

test("createScriptRuns: caps the fan-out", async () => {
  reset();
  seedScript({ id: "s1" });
  const ids = Array.from({ length: MAX_RUN_DEVICES + 1 }, (_, i) =>
    seedDevice({ id: `dev-${i}` }).id,
  );
  await assert.rejects(
    createScriptRuns({ userId: "u1", scriptId: "s1", deviceIds: ids, trigger: "manual" }),
    ScriptInputError,
  );
});

test("dispatchScriptRun: offline device is skipped, never sent", async () => {
  reset();
  const device = seedDevice({ status: "offline" });
  seedScript({ id: "s1" });
  const [runId] = await createScriptRuns({
    userId: "u1",
    scriptId: "s1",
    deviceIds: [device.id],
    trigger: "manual",
  });

  await dispatchScriptRun(runId);
  assert.equal(runCalls.length, 0);
  const row = runs.find((r) => r.id === runId)!;
  assert.equal(row.status, "skipped");
  assert.equal(row.error, "device_offline");
});

test("dispatchScriptRun: success stores output + exit code; non-zero exit fails", async () => {
  reset();
  const device = seedDevice();
  seedScript({ id: "s1" });
  const [runId] = await createScriptRuns({
    userId: "u1",
    scriptId: "s1",
    deviceIds: [device.id],
    trigger: "manual",
  });
  await dispatchScriptRun(runId);
  let row = runs.find((r) => r.id === runId)!;
  assert.equal(row.status, "succeeded");
  assert.equal(row.output, "ok output");
  assert.equal(row.exitCode, 0);
  assert.equal(runCalls[0].cmd, "Write-Output hi");

  // Non-zero exit = failed, with the code preserved for the UI.
  reset();
  const d2 = seedDevice();
  seedScript({ id: "s2" });
  commandExit = 2;
  const [run2] = await createScriptRuns({
    userId: "u1",
    scriptId: "s2",
    deviceIds: [d2.id],
    trigger: "manual",
  });
  await dispatchScriptRun(run2);
  row = runs.find((r) => r.id === run2)!;
  assert.equal(row.status, "failed");
  assert.equal(row.exitCode, 2);
  assert.equal(row.error, "exit_code_2");
});

test("dispatchScriptRun: the queued -> running claim runs each run once", async () => {
  reset();
  const device = seedDevice();
  seedScript({ id: "s1" });
  const [runId] = await createScriptRuns({
    userId: "u1",
    scriptId: "s1",
    deviceIds: [device.id],
    trigger: "manual",
  });

  await Promise.all([dispatchScriptRun(runId), dispatchScriptRun(runId)]);
  assert.equal(runCalls.length, 1, "two dispatchers must not both send the command");
});

test("dispatchScriptRun: transport errors are recorded, not thrown", async () => {
  reset();
  const device = seedDevice();
  seedScript({ id: "s1" });
  const [runId] = await createScriptRuns({
    userId: "u1",
    scriptId: "s1",
    deviceIds: [device.id],
    trigger: "manual",
  });
  commandError = "vantra_502";
  await dispatchScriptRun(runId);
  const row = runs.find((r) => r.id === runId)!;
  assert.equal(row.status, "failed");
  assert.equal(row.error, "vantra_502");
});

test("enqueueAutoScriptRuns: public devices only, rule must predate the device", async () => {
  reset();
  const device = seedDevice();

  rules.push(
    {
      id: "rule-old",
      userId: "u1",
      scriptId: "s1",
      enabled: true,
      targetTier: "public",
      delayMinutes: 10,
      createdAt: new Date("2026-10-20T00:00:00Z"),
    },
    {
      id: "rule-new",
      userId: "u1",
      scriptId: "s2",
      enabled: true,
      targetTier: "public",
      delayMinutes: 10,
      createdAt: new Date("2026-10-23T00:00:00Z"),
    },
    {
      id: "rule-any",
      userId: "u1",
      scriptId: "s3",
      enabled: true,
      targetTier: "any",
      delayMinutes: 5,
      createdAt: new Date("2026-10-20T00:00:00Z"),
    },
  );

  const fired = await enqueueAutoScriptRuns({
    userId: "u1",
    deviceId: device.id,
    tier: "public",
    deviceCreatedAt: NOW,
  });
  assert.equal(fired, 2, "old + any fire; the rule saved after the device does not");
  assert.deepEqual(
    runs.map((r) => r.autoRuleId).sort(),
    ["rule-any", "rule-old"],
  );
  assert.ok(runs.every((r) => r.trigger === "auto_enroll" && r.status === "queued"));
  const soonest = Math.min(...runs.map((r) => (r.scheduledFor as Date).getTime()));
  assert.ok(soonest >= Date.now() + 4 * 60_000, "runs wait for the rule's delay");

  // Re-sync: idempotent, the unique (autoRuleId, deviceId) key absorbs it.
  const again = await enqueueAutoScriptRuns({
    userId: "u1",
    deviceId: device.id,
    tier: "public",
    deviceCreatedAt: NOW,
  });
  assert.equal(again, 0);
  assert.equal(runs.length, 2);

  // Private tiers never fire.
  const priv = seedDevice({ tier: "private" });
  assert.equal(
    await enqueueAutoScriptRuns({
      userId: "u1",
      deviceId: priv.id,
      tier: "private",
      deviceCreatedAt: NOW,
    }),
    0,
  );
});

test("enqueueAutoScriptRuns: never throws, even if the rule query explodes", async () => {
  reset();
  const original = fakeDb.deviceScriptAutoRule.findMany;
  fakeDb.deviceScriptAutoRule.findMany = async () => {
    throw new Error("db down");
  };
  const n = await enqueueAutoScriptRuns({
    userId: "u1",
    deviceId: "d1",
    tier: "public",
    deviceCreatedAt: NOW,
  });
  assert.equal(n, 0);
  fakeDb.deviceScriptAutoRule.findMany = original;
});
