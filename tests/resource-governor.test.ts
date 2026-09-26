import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// TASK_105 — the resource governor.
//
// WHY THIS FILE EXISTS: the acceptance list ("a standard request queues, a
// premium request is granted while healthy, BOTH queue at hard pressure, FIFO
// within a class, starvation promotion fires, nothing changes while the governor
// is off") is otherwise only provable by saturating the real VPS. Every case
// below exercises the REAL `lib/resource-governor.ts` — not a copy of its logic
// — loaded through the house require hook (HOW_WE_MOVE_FAST §4) that swaps its
// `./db`, `./admin-settings`, `./entitlements` and `./devices` dependencies for
// recording fakes. Pressure is INJECTED (SlotRequest.pressure) so no test has to
// fake /proc or load a Linux box.
//
// What this file cannot prove (said plainly, per the task contract): that a
// queued row survives `systemctl restart spaceworker` on the real VPS, and that
// the systemd timer is installed. Those are owner-run live checks; the schema,
// the migration and the sweep route are what make them possible.

process.env.DATABASE_URL = "postgresql://t105:t105@localhost:5432/task105_placeholder";
process.env.SESSION_SECRET = "task105-test-session-secret";
process.env.RESEND_API_KEY = "task105-test-resend";
process.env.EMAIL_FROM = "t105@spaceworker.test";
process.env.APP_BASE_URL = "https://spaceworker.test";
(process.env as Record<string, string>).NODE_ENV = "test";

// ---------------------------------------------------------------------------
// The in-memory stand-ins the module under test talks to.
// ---------------------------------------------------------------------------

interface DbArgs {
  where?: Record<string, never> | Record<string, unknown>;
  data?: Record<string, unknown>;
  select?: Record<string, boolean>;
  orderBy?: Record<string, string>;
  distinct?: string[];
  by?: string[];
  _count?: Record<string, boolean>;
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

interface AuditRow {
  action: string;
  status: string;
  detail: Record<string, unknown> | null;
  userId?: string;
  createdAt?: Date;
}

/** Prisma-ish equality/subset match for the where shapes the module uses. */
function matches(row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [key, expected] of Object.entries(where)) {
    const actual = row[key];
    if (expected instanceof Date) {
      if (!(actual instanceof Date) || actual.getTime() !== expected.getTime()) return false;
      continue;
    }
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      const cond = expected as Record<string, unknown>;
      if ("in" in cond && !(cond.in as unknown[]).includes(actual)) return false;
      if ("notIn" in cond && (cond.notIn as unknown[]).includes(actual)) return false;
      if ("not" in cond && actual === cond.not) return false;
      if ("lt" in cond) {
        if (!(actual instanceof Date) || actual.getTime() >= (cond.lt as Date).getTime()) return false;
      }
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}

function sortRows(rows: QueueRow[], orderBy?: Record<string, string>): QueueRow[] {
  if (!orderBy) return rows;
  const [field, direction] = Object.entries(orderBy)[0] ?? [];
  if (!field) return rows;
  const sign = direction === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = a[field as keyof QueueRow];
    const bv = b[field as keyof QueueRow];
    const an = av instanceof Date ? av.getTime() : (av as number);
    const bn = bv instanceof Date ? bv.getTime() : (bv as number);
    return an === bn ? 0 : an < bn ? -sign : sign;
  });
}

const USER = "user-t105";
const OTHER = "user-t105b";

let rows: QueueRow[];
let audits: AuditRow[];
let seq: number;
let adminRow: Record<string, unknown>;
let priorityFacts = { premium: false, grants: false };
let live: {
  light: number;
  heavy: number;
  browserSessions: number;
  vantraLinks: number;
  deviceActions: number;
  clones: number;
  clonesByUser: Record<string, number>;
  hostedDevices: number;
};

beforeEach(() => {
  rows = [];
  audits = [];
  seq = 0;
  priorityFacts = { premium: false, grants: false };
  // Governor OFF by default, with the documented schema defaults — exactly what
  // production has after the migration.
  adminRow = {
    cloneSessionsEnabled: true,
    cloneMaxConcurrent: 2,
    clonePerUserCap: 1,
    hostedPoolSize: 1,
    dispatchLightEnabled: true,
    dispatchLightMaxConcurrent: 1,
    dispatchHeavyEnabled: true,
    dispatchHeavyMaxConcurrent: 1,
    browserSessionsEnabled: true,
    browserSessionsMaxConcurrent: 3,
    vantraLinksEnabled: true,
    vantraLinksMax: 100,
    deviceActionsEnabled: true,
    deviceActionsMaxConcurrent: 3,
    governorEnabled: false,
    governorRamWarnPct: 75,
    governorRamHardPct: 90,
    governorSwapHardMb: 1024,
    governorQueueTimeoutSec: 900,
    governorStarvationPromoteMin: 10,
  };
  live = {
    light: 0,
    heavy: 0,
    browserSessions: 0,
    vantraLinks: 0,
    deviceActions: 0,
    clones: 0,
    clonesByUser: {},
    hostedDevices: 0,
  };
});

const fakeDb = {
  searchJob: {
    count: async ({ where }: DbArgs) => (where?.lane === "light" ? live.light : live.heavy),
  },
  browserSession: { count: async () => live.browserSessions },
  vantraLink: { count: async () => live.vantraLinks },
  deviceAction: { count: async () => live.deviceActions },
  cloneJob: {
    count: async ({ where }: DbArgs) =>
      where?.userId ? live.clonesByUser[where.userId as string] ?? 0 : live.clones,
  },
  hostedBrowserSession: {
    findMany: async () => Array.from({ length: live.hostedDevices }, (_, i) => ({ deviceId: `hosted-${i}` })),
  },
  governorQueueEntry: {
    create: async (args: DbArgs) => {
      const data = args.data ?? {};
      seq += 1;
      const row: QueueRow = {
        id: `q${seq}`,
        feature: String(data.feature),
        userId: String(data.userId),
        ref: (data.ref as string | null) ?? null,
        priority: (data.priority as string) ?? "standard",
        status: (data.status as string) ?? "queued",
        position: (data.position as number) ?? 0,
        promotedAt: (data.promotedAt as Date | null) ?? null,
        reason: (data.reason as string | null) ?? null,
        requestedAt: (data.requestedAt as Date) ?? new Date(),
        grantedAt: (data.grantedAt as Date | null) ?? null,
        expiresAt: (data.expiresAt as Date | null) ?? null,
        expiredAt: (data.expiredAt as Date | null) ?? null,
      };
      rows.push(row);
      return { ...row };
    },
    findFirst: async ({ where, orderBy }: DbArgs) => {
      const found = sortRows(rows.filter((r) => matches(r as unknown as Record<string, unknown>, where)), orderBy);
      return found[0] ? { ...found[0] } : null;
    },
    findMany: async ({ where, orderBy }: DbArgs) =>
      sortRows(rows.filter((r) => matches(r as unknown as Record<string, unknown>, where)), orderBy).map((r) => ({
        ...r,
      })),
    update: async ({ where, data }: DbArgs) => {
      const row = rows.find((r) => r.id === (where as { id?: string }).id);
      assert.ok(row, `update targeted a missing row: ${JSON.stringify(where)}`);
      Object.assign(row, data as Partial<QueueRow>);
      return { ...row };
    },
    updateMany: async ({ where, data }: DbArgs) => {
      const targeted = rows.filter((r) => matches(r as unknown as Record<string, unknown>, where));
      for (const row of targeted) Object.assign(row, data as Partial<QueueRow>);
      return { count: targeted.length };
    },
    count: async ({ where }: DbArgs) =>
      rows.filter((r) => matches(r as unknown as Record<string, unknown>, where)).length,
  },
  agentActionAudit: {
    findFirst: async ({ where, orderBy }: DbArgs) => {
      // Newest first (the module asks for createdAt desc), then the first row
      // whose action matches — this is how it reads back the previous level.
      const sign = orderBy?.createdAt === "desc" ? -1 : 1;
      const sorted = [...audits].sort(
        (a, b) => ((a.createdAt ?? new Date(0)).getTime() - (b.createdAt ?? new Date(0)).getTime()) * sign
      );
      const found = sorted.find((a) => matches(a as unknown as Record<string, unknown>, where));
      return found ? { detail: found.detail } : null;
    },
    create: async ({ data }: DbArgs) => {
      audits.push(data as unknown as AuditRow);
      return data;
    },
  },
};


// ---------------------------------------------------------------------------
// Require hook: only the module under test's OWN dependencies are swapped.
// ---------------------------------------------------------------------------

type Loader = {
  _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};

const MODULE_UNDER_TEST = "lib/resource-governor.ts";

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    const from = parent?.filename ?? "";
    if (from.endsWith(`/${MODULE_UNDER_TEST}`)) {
      if (request === "./db") return { db: fakeDb };
      if (request === "./admin-settings") return { getAdminSettings: async () => ({ ...adminRow }) };
      // resolvePriority's source. Premium/grant facts are set per test.
      if (request === "./entitlements") {
        return {
          listEffectiveEntitlements: async () => ({
            keys: priorityFacts.grants ? ["assistant"] : [],
            premium: priorityFacts.premium,
            grants: [],
          }),
        };
      }
      // Only touched by the sweep's pressure-transition logging (lazy import).
      if (request === "./devices") {
        return {
          recordAgentActionAudit: async (call: AuditRow) => {
            // Monotonic timestamps so "latest audit row" is deterministic even
            // when two writes land inside the same millisecond.
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
  requestSlot,
  drainQueue,
  sweepGovernor,
  cancelQueuedSlots,
  resolveGovernorSettings,
  classifyPressure,
  parseMemInfo,
  priorityFromFacts,
  effectivePriority,
  isStarved,
  orderQueue,
  queuePosition,
  estimateEtaSeconds,
  normalizePriority,
  getGovernorFeatureStatuses,
  getQueuePositions,
  GOVERNOR_DEFAULTS,
  GOVERNOR_FEATURES,
  FEATURE_REGISTRY,
} = require("../lib/resource-governor") as typeof import("../lib/resource-governor");
/* eslint-enable @typescript-eslint/no-require-imports */

/** A forced pressure snapshot — no /proc, no Linux box. */
function pressure(level: "normal" | "warn" | "hard", reason = level === "hard" ? "ram 95.0% >= 90%" : "") {
  return {
    level,
    measured: true,
    ramUsedPct: level === "hard" ? 95 : level === "warn" ? 80 : 20,
    ramTotalMb: 24000,
    ramAvailableMb: 4000,
    swapUsedMb: level === "hard" ? 2048 : 0,
    swapTotalMb: 4096,
    load1: 1.5,
    cpuCount: 4,
    reason,
  } as import("../lib/resource-governor").PressureSnapshot;
}

const at = (minutesAgo: number, now: Date) => new Date(now.getTime() - minutesAgo * 60_000);

// ---------------------------------------------------------------------------
// Pure: settings + pressure model
// ---------------------------------------------------------------------------

test("resolveGovernorSettings: defaults when the row is missing, and clamps nonsense", () => {
  assert.deepEqual(resolveGovernorSettings(null), GOVERNOR_DEFAULTS);
  assert.equal(GOVERNOR_DEFAULTS.enabled, false, "the governor must default OFF");

  const clamped = resolveGovernorSettings({
    governorEnabled: true,
    // A warn BEYOND hard would invert the escalation — hard wins.
    governorRamWarnPct: 95,
    governorRamHardPct: 50,
    governorSwapHardMb: 0, // 0 is meaningful: no swap signal
    governorQueueTimeoutSec: 0, // unusable → default
    governorStarvationPromoteMin: -3, // unusable → default
  });
  assert.equal(clamped.enabled, true);
  assert.equal(clamped.ramWarnPct, 95);
  assert.equal(clamped.ramHardPct, 95, "hard is clamped up to warn, never below it");
  assert.equal(clamped.swapHardMb, 0);
  assert.equal(clamped.queueTimeoutSec, GOVERNOR_DEFAULTS.queueTimeoutSec);
  assert.equal(clamped.starvationPromoteMin, GOVERNOR_DEFAULTS.starvationPromoteMin);
});

test("classifyPressure: normal → warn → hard, with swap able to force hard", () => {
  const settings = { ramWarnPct: 75, ramHardPct: 90, swapHardMb: 1024 };
  assert.equal(classifyPressure({ ramUsedPct: 20, swapUsedMb: 0 }, settings).level, "normal");
  assert.equal(classifyPressure({ ramUsedPct: 75, swapUsedMb: 0 }, settings).level, "warn");
  assert.equal(classifyPressure({ ramUsedPct: 90, swapUsedMb: 0 }, settings).level, "hard");
  const viaSwap = classifyPressure({ ramUsedPct: 10, swapUsedMb: 1024 }, settings);
  assert.equal(viaSwap.level, "hard");
  assert.match(viaSwap.reason, /swap 1024MB >= 1024MB/);
  // 0 disables the swap signal entirely.
  assert.equal(classifyPressure({ ramUsedPct: 10, swapUsedMb: 99999 }, { ...settings, swapHardMb: 0 }).level, "normal");
});

test("parseMemInfo: reads MB from the kernel's kB, prefers MemAvailable, rejects junk", () => {
  const parsed = parseMemInfo(
    ["MemTotal:       24000000 kB", "MemFree:         1000000 kB", "MemAvailable:    4000000 kB", "SwapTotal:       1000000 kB", "SwapFree:         500000 kB"].join("\n")
  );
  assert.ok(parsed);
  assert.equal(parsed.totalMb, 24000000 / 1024);
  assert.equal(parsed.availableMb, 4000000 / 1024, "MemAvailable wins over MemFree");
  assert.equal(parsed.swapTotalMb, 1000000 / 1024);
  assert.equal(parsed.swapFreeMb, 500000 / 1024);

  // Older kernels without MemAvailable fall back to MemFree.
  assert.equal(parseMemInfo("MemTotal: 2000000 kB\nMemFree: 500000 kB")?.availableMb, 500000 / 1024);
  // No MemTotal → not a meminfo file.
  assert.equal(parseMemInfo("hello: world"), null);
});

test("priorityFromFacts: premium > standard (any live grant) > trial", () => {
  assert.equal(priorityFromFacts({ premium: true, hasGrant: false }), "premium");
  assert.equal(priorityFromFacts({ premium: false, hasGrant: true }), "standard");
  assert.equal(priorityFromFacts({ premium: false, hasGrant: false }), "trial");
  assert.equal(normalizePriority("garbage"), "standard");
});


// ---------------------------------------------------------------------------
// Pure: FIFO, promotion, position, ETA
// ---------------------------------------------------------------------------

test("orderQueue: premium first, FIFO inside a class, and a starved free request is promoted", () => {
  const now = new Date("2026-09-26T12:00:00Z");
  const standardOld = { id: "s1", priority: "standard", requestedAt: at(5, now) };
  const standardNew = { id: "s2", priority: "standard", requestedAt: at(2, now) };
  const trialOld = { id: "t1", priority: "trial", requestedAt: at(30, now) };
  const premium = { id: "p1", priority: "premium", requestedAt: at(1, now) };

  // No promotion yet (5 min < 10): premium, then FIFO standard, then trial.
  assert.deepEqual(
    orderQueue([standardNew, premium, standardOld, { ...trialOld, requestedAt: at(9, now) }], 10, now).map((e) => e.id),
    ["p1", "s1", "s2", "t1"]
  );

  // t1 has now waited 30 min > promoteMin → promoted into the premium class and
  // sorted ahead of a NEWER premium request (arrival decides inside the class).
  const promoted = orderQueue([standardNew, premium, trialOld], 10, now);
  assert.deepEqual(promoted.map((e) => e.id), ["t1", "p1", "s2"]);

  assert.equal(effectivePriority(standardOld, 10, now), "standard");
  assert.equal(isStarved(trialOld, 10, now), true);
  assert.equal(isStarved(premium, 10, now), false, "an actual premium entry is never 'starved'");
  assert.equal(isStarved(standardOld, 10, now), false, "only entries past the promote window");
});

test("queuePosition reports 1-based place; estimateEtaSeconds spreads the timeout across the cap", () => {
  assert.equal(queuePosition([{ id: "a" }, { id: "b" }], "b"), 2);
  assert.equal(queuePosition([{ id: "a" }], "zzz"), 0);
  assert.equal(estimateEtaSeconds(0, 2, 900), 0);
  assert.equal(estimateEtaSeconds(1, 2, 900), 450);
  assert.equal(estimateEtaSeconds(2, 2, 900), 900);
});

test("the registry covers every high-RAM consumer, including the clone pair", () => {
  assert.deepEqual(Object.keys(FEATURE_REGISTRY).sort(), [...GOVERNOR_FEATURES].sort());
  for (const key of GOVERNOR_FEATURES) {
    const def = FEATURE_REGISTRY[key];
    assert.equal(def.key, key);
    assert.equal(typeof def.liveCount, "function");
    assert.ok(def.maxDefault >= 1);
  }
  assert.equal(FEATURE_REGISTRY.cloneSessions.perUserColumn, "clonePerUserCap");
  assert.equal(FEATURE_REGISTRY.hostedPool.enforceWhenDisabled, false);
  assert.equal(FEATURE_REGISTRY.vantraLinks.queueable, false, "a total-count cap cannot queue");
  assert.equal(
    FEATURE_REGISTRY.deviceActions.queueable,
    false,
    "a per-user proposal cap on the user's own PC is not something this box's queue can relieve"
  );
  // The four features that genuinely hold VPS RAM are the queueable ones.
  assert.deepEqual(
    GOVERNOR_FEATURES.filter((key) => FEATURE_REGISTRY[key].queueable),
    ["dispatchLight", "dispatchHeavy", "browserSessions", "cloneSessions", "hostedPool"]
  );
});

// ---------------------------------------------------------------------------
// Acceptance: governor OFF changes nothing
// ---------------------------------------------------------------------------

test("governor OFF: the plain cap check with today's exact reasons, and NOTHING persisted", async () => {
  live.clones = 1;
  let decision = await requestSlot("cloneSessions", { userId: USER, priority: "standard" });
  assert.equal(decision.status, "granted");
  assert.equal(rows.length, 0);

  live.clones = 2; // == cloneMaxConcurrent
  decision = await requestSlot("cloneSessions", { userId: USER, priority: "standard" });
  assert.deepEqual(decision, {
    status: "queued",
    feature: "cloneSessions",
    priority: "standard",
    reason: "at_capacity (2/2)",
    position: 0,
    etaSeconds: 0,
    persisted: false,
  });
  assert.equal(rows.length, 0, "the governor-off path must write no queue row");

  live.clones = 0;
  live.clonesByUser[USER] = 1; // global room, this user at their own cap
  decision = await requestSlot("cloneSessions", { userId: USER, priority: "standard" });
  assert.equal(decision.status, "queued");
  assert.equal(decision.status === "queued" && decision.reason, "per_user_cap (1/1)");

  adminRow.cloneSessionsEnabled = false;
  decision = await requestSlot("cloneSessions", { userId: USER, priority: "standard" });
  assert.equal(decision.status === "queued" && decision.reason, "clone_sessions_paused");
  assert.equal(rows.length, 0);
});

test("governor OFF: hostedPool keeps granting — nothing enforced that cap before TASK_105", async () => {
  live.hostedDevices = 5; // far past hostedPoolSize = 1
  const decision = await requestSlot("hostedPool", { userId: USER, priority: "standard" });
  assert.equal(decision.status, "granted");
  assert.equal(rows.length, 0);
});

// ---------------------------------------------------------------------------
// Acceptance: standard queues, premium bypasses while healthy, BOTH queue at hard
// ---------------------------------------------------------------------------

test("governor ON + healthy box: a standard request at the cap QUEUES and is persisted", async () => {
  adminRow.governorEnabled = true;
  live.clones = 2;
  const decision = await requestSlot("cloneSessions", {
    userId: USER,
    ref: "clone-1",
    priority: "standard",
    pressure: pressure("normal"),
  });
  assert.equal(decision.status, "queued");
  if (decision.status !== "queued") return;
  assert.equal(decision.persisted, true);
  assert.equal(decision.position, 1);
  assert.equal(decision.reason, "at_capacity (2/2)");
  assert.ok(decision.etaSeconds > 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "queued");
  assert.equal(rows[0].ref, "clone-1");
  assert.ok(rows[0].expiresAt instanceof Date, "expiry is stamped at enqueue");
});


test("governor ON + healthy box: premium BYPASSES the soft queue (no row, bypassed=true)", async () => {
  adminRow.governorEnabled = true;
  live.clones = 2;
  const decision = await requestSlot("cloneSessions", {
    userId: USER,
    ref: "clone-premium",
    priority: "premium",
    pressure: pressure("normal"),
  });
  assert.equal(decision.status, "granted");
  if (decision.status === "granted") assert.equal(decision.bypassed, true);
  assert.equal(rows.length, 0, "a bypass is not a queue entry");
});

test("governor ON + warned box: premium STOPS bypassing a full feature", async () => {
  adminRow.governorEnabled = true;
  live.clones = 2;
  const decision = await requestSlot("cloneSessions", {
    userId: USER,
    priority: "premium",
    pressure: pressure("warn", "ram 80.0% >= 75%"),
  });
  assert.equal(decision.status, "queued");
  if (decision.status !== "queued") return;
  assert.equal(decision.reason, "at_capacity (2/2)");
  assert.equal(decision.persisted, true);
});

test("governor ON + HARD pressure: EVERYONE queues, premium included, even below the cap", async () => {
  adminRow.governorEnabled = true;
  live.clones = 0; // the feature has room — the MACHINE does not
  const decision = await requestSlot("cloneSessions", {
    userId: USER,
    priority: "premium",
    pressure: pressure("hard"),
  });
  assert.equal(decision.status, "queued");
  if (decision.status !== "queued") return;
  assert.match(decision.reason, /^hard_pressure \(ram 95\.0% >= 90%\)$/);
  assert.equal(rows[0].status, "queued");
});

test("requestSlot resolves the class from entitlements when none is passed", async () => {
  adminRow.governorEnabled = true;
  live.clones = 2;

  priorityFacts = { premium: false, grants: false }; // tier 1, no grant
  const trial = await requestSlot("cloneSessions", { userId: USER, pressure: pressure("normal") });
  assert.equal(trial.status, "queued");
  if (trial.status === "queued") assert.equal(trial.priority, "trial");

  priorityFacts = { premium: true, grants: false };
  const premium = await requestSlot("cloneSessions", { userId: OTHER, pressure: pressure("normal") });
  assert.equal(premium.status, "granted");
  if (premium.status === "granted") assert.equal(premium.priority, "premium");
});

test("a grant survives a later per-user cap: a queued ref the sweep admitted stays admitted", async () => {
  adminRow.governorEnabled = true;
  const now = new Date("2026-09-26T12:00:00Z");
  live.clones = 2; // cap 2, both taken → this request waits

  const queued = await requestSlot("cloneSessions", {
    userId: USER,
    ref: "clone-live",
    priority: "standard",
    pressure: pressure("normal"),
    now,
  });
  assert.equal(queued.status, "queued");

  // The sweep drains the head once a slot frees; the grant is persisted.
  live.clones = 1;
  const drained = await drainQueue("cloneSessions", { pressure: pressure("normal"), now });
  assert.equal(drained.granted, 1);
  assert.equal(rows[0].status, "granted");

  // That clone is now live and is this user's ONE allowed clone (per-user cap 1).
  live.clones = 2;
  live.clonesByUser[USER] = 1;
  const again = await requestSlot("cloneSessions", {
    userId: USER,
    ref: "clone-live",
    priority: "standard",
    pressure: pressure("normal"),
    now,
  });
  assert.equal(again.status, "granted", "its own admission is not re-decided");

  // A DIFFERENT clone for the same user does hit the per-user cap.
  const second = await requestSlot("cloneSessions", {
    userId: USER,
    ref: "clone-second",
    priority: "standard",
    pressure: pressure("normal"),
    now,
  });
  assert.equal(second.status === "queued" && second.reason, "per_user_cap (1/1)");
});

// ---------------------------------------------------------------------------
// Acceptance: FIFO inside a class, idempotent refs, no queue-jumping
// ---------------------------------------------------------------------------

test("FIFO inside a class, and a repeated request with the same ref keeps ONE place", async () => {
  adminRow.governorEnabled = true;
  live.clones = 2;
  const now = new Date("2026-09-26T12:00:00Z");

  const first = await requestSlot("cloneSessions", {
    userId: USER,
    ref: "clone-a",
    priority: "standard",
    pressure: pressure("normal"),
    now: at(2, now),
  });
  const second = await requestSlot("cloneSessions", {
    userId: OTHER,
    ref: "clone-b",
    priority: "standard",
    pressure: pressure("normal"),
    now: at(1, now),
  });
  assert.equal(first.status === "queued" && first.position, 1);
  assert.equal(second.status === "queued" && second.position, 2);
  assert.equal(rows.length, 2);

  // The clone pipeline polls with the same ref: no duplicate row, same place.
  const poll = await requestSlot("cloneSessions", {
    userId: USER,
    ref: "clone-a",
    priority: "standard",
    pressure: pressure("normal"),
    now,
  });
  assert.equal(poll.status === "queued" && poll.position, 1);
  assert.equal(rows.length, 2, "a poll must not add a second queue row");

  // A fresh STANDARD request cannot jump the line.
  const jumper = await requestSlot("cloneSessions", {
    userId: "user-t105c",
    ref: "clone-c",
    priority: "standard",
    pressure: pressure("normal"),
    now,
  });
  assert.equal(jumper.status === "queued" && jumper.position, 3);

  // A premium request DOES outrank queued standards while the box is healthy —
  // that is the documented priority, not a fairness bug.
  const premium = await requestSlot("cloneSessions", {
    userId: "user-t105d",
    ref: "clone-d",
    priority: "premium",
    pressure: pressure("normal"),
    now,
  });
  assert.equal(premium.status, "granted");
});

test("a queued clone polling again is granted once a slot frees — one row, not two", async () => {
  adminRow.governorEnabled = true;
  live.clones = 2;
  const now = new Date("2026-09-26T12:00:00Z");

  const queued = await requestSlot("cloneSessions", {
    userId: USER,
    ref: "clone-42",
    priority: "standard",
    pressure: pressure("normal"),
    now,
  });
  assert.equal(queued.status, "queued");

  live.clones = 1; // the session ahead of it ended
  const grantedNow = await requestSlot("cloneSessions", {
    userId: USER,
    ref: "clone-42",
    priority: "standard",
    pressure: pressure("normal"),
    now,
  });
  assert.equal(grantedNow.status, "granted");
  assert.equal(rows.length, 1, "still ONE row for this clone");
  assert.equal(rows[0].status, "granted");

  // Granted is terminal for that ref: later polls (even under hard pressure)
  // report the admission rather than re-queueing the same job.
  const again = await requestSlot("cloneSessions", {
    userId: USER,
    ref: "clone-42",
    priority: "standard",
    pressure: pressure("hard"),
    now,
  });
  assert.equal(again.status, "granted");
});

test("a total-count cap REFUSES instead of queueing (waiting could never relieve it)", async () => {
  adminRow.governorEnabled = true;
  live.vantraLinks = 100; // == vantraLinksMax
  const decision = await requestSlot("vantraLinks", {
    userId: USER,
    priority: "standard",
    pressure: pressure("normal"),
  });
  assert.equal(decision.status, "refused");
  if (decision.status === "refused") assert.equal(decision.reason, "at_capacity (100/100)");
  assert.equal(rows.length, 0);
});


// ---------------------------------------------------------------------------
// Acceptance: starvation promotion + the sweep
// ---------------------------------------------------------------------------

test("starvation promotion fires: a long-waiting free request is promoted and granted ahead", async () => {
  adminRow.governorEnabled = true;
  adminRow.governorStarvationPromoteMin = 10;
  adminRow.cloneMaxConcurrent = 1; // ONE clone slot on this box…
  const now = new Date("2026-09-26T12:00:00Z");
  live.clones = 1; // …and it is already taken

  // An old STANDARD waiter and a fresh STANDARD waiter.
  await requestSlot("cloneSessions", {
    userId: USER,
    ref: "old",
    priority: "standard",
    pressure: pressure("normal"),
    now: at(30, now), // waited 30 min > promoteMin
  });
  await requestSlot("cloneSessions", {
    userId: OTHER,
    ref: "new",
    priority: "standard",
    pressure: pressure("normal"),
    now,
  });

  // Only ONE can win (cap 1): the promoted old one, via the premium-class bypass.
  const drained = await drainQueue("cloneSessions", { pressure: pressure("normal"), now });
  assert.equal(drained.granted, 1);
  assert.equal(drained.promoted, 1);
  assert.equal(rows[0].ref, "old");
  assert.equal(rows[0].status, "granted", "the starved request goes first");
  assert.ok(rows[0].promotedAt instanceof Date, "the promotion is stamped");
  assert.equal(rows[1].ref, "new");
  assert.equal(rows[1].status, "queued", "the newer request keeps waiting");
});

test("drainQueue grants the head only, one at a time, and stops at the cap", async () => {
  adminRow.governorEnabled = true;
  const now = new Date("2026-09-26T12:00:00Z");
  live.clones = 2;
  await requestSlot("cloneSessions", {
    userId: USER,
    ref: "a",
    priority: "standard",
    pressure: pressure("normal"),
    now: at(2, now),
  });
  await requestSlot("cloneSessions", {
    userId: OTHER,
    ref: "b",
    priority: "standard",
    pressure: pressure("normal"),
    now: at(1, now),
  });

  live.clones = 1; // exactly one slot freed
  const drained = await drainQueue("cloneSessions", { pressure: pressure("normal"), now });
  assert.equal(drained.granted, 1);
  assert.equal(rows[0].status, "granted");
  assert.equal(rows[1].status, "queued");

  // Hard pressure freezes the line entirely — no grants, no promotion.
  rows[1].status = "queued";
  const frozen = await drainQueue("cloneSessions", { pressure: pressure("hard"), now });
  assert.equal(frozen.granted, 0);
  assert.equal(rows[1].status, "queued");
});

test("sweepGovernor: expires timed-out waiters and logs ONE transition per change", async () => {
  adminRow.governorEnabled = true;
  const now = new Date("2026-09-26T12:00:00Z");
  live.clones = 2;

  // Requested 30 min before `now` with a 900s (15 min) timeout → already expired.
  await requestSlot("cloneSessions", {
    userId: USER,
    ref: "stale",
    priority: "standard",
    pressure: pressure("normal"),
    now: at(30, now),
  });
  assert.equal(rows[0].status, "queued");

  const first = await sweepGovernor({ now, pressure: pressure("hard") });
  assert.equal(first.expired, 1);
  assert.equal(rows[0].status, "expired");
  assert.equal(rows[0].reason, "queue_timeout");
  assert.equal(first.granted, 0, "hard pressure freezes the line");
  assert.equal(first.transitions.logged, true);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "resource-governor");
  assert.equal((audits[0].detail as { level: string }).level, "hard");

  // Same level again → silent (no duplicate trail entries).
  const second = await sweepGovernor({ now, pressure: pressure("hard") });
  assert.equal(second.transitions.logged, false);
  assert.equal(audits.length, 1);

  // Back to normal is a transition too.
  const third = await sweepGovernor({ now, pressure: pressure("normal") });
  assert.equal(third.transitions.logged, true);
  assert.equal(audits.length, 2);
  assert.equal((audits[1].detail as { level: string }).level, "normal");
  assert.equal((audits[1].detail as { previous: string }).previous, "hard");
});


test("sweepGovernor drains a freed slot in FIFO order and reports counts per feature", async () => {
  adminRow.governorEnabled = true;
  const now = new Date("2026-09-26T12:00:00Z");
  live.clones = 2;
  await requestSlot("cloneSessions", {
    userId: USER,
    ref: "a",
    priority: "standard",
    pressure: pressure("normal"),
    now: at(2, now),
  });
  await requestSlot("cloneSessions", {
    userId: OTHER,
    ref: "b",
    priority: "standard",
    pressure: pressure("normal"),
    now: at(1, now),
  });

  live.clones = 1;
  const result = await sweepGovernor({ now, pressure: pressure("normal") });
  assert.equal(result.granted, 1);
  assert.deepEqual(result.byFeature, { cloneSessions: 1 });
  assert.equal(result.queued, 1);
  assert.equal(rows[0].status, "granted");
  assert.equal(rows[1].status, "queued");
});

test("sweepGovernor housekeeping runs even with the governor OFF (no wedged rows)", async () => {
  const now = new Date("2026-09-26T12:00:00Z");
  adminRow.governorEnabled = false;
  rows.push({
    id: "leftover",
    feature: "cloneSessions",
    userId: USER,
    ref: null,
    priority: "standard",
    status: "queued",
    position: 1,
    promotedAt: null,
    reason: "at_capacity (1/1)",
    requestedAt: at(60, now),
    grantedAt: null,
    expiresAt: at(45, now),
    expiredAt: null,
  });

  const result = await sweepGovernor({ now, pressure: pressure("normal") });
  assert.equal(result.enabled, false);
  assert.equal(result.expired, 1);
  assert.equal(rows[0].status, "expired");
  assert.equal(result.granted, 0, "nothing is granted while the governor is off");
});

test("cancelQueuedSlots withdraws only the named user's waiting rows", async () => {
  adminRow.governorEnabled = true;
  live.clones = 2;
  await requestSlot("cloneSessions", {
    userId: USER,
    ref: "a",
    priority: "standard",
    pressure: pressure("normal"),
  });
  await requestSlot("cloneSessions", {
    userId: OTHER,
    ref: "b",
    priority: "standard",
    pressure: pressure("normal"),
  });

  const cancelled = await cancelQueuedSlots({ userId: USER });
  assert.equal(cancelled, 1);
  assert.equal(rows.find((r) => r.ref === "a")?.status, "cancelled");
  assert.equal(rows.find((r) => r.ref === "a")?.reason, "cancelled");
  assert.equal(rows.find((r) => r.ref === "b")?.status, "queued");
});

test("getQueuePositions: live place in line for a list view, renumbering as it drains", async () => {
  adminRow.governorEnabled = true;
  const now = new Date("2026-09-26T12:00:00Z");
  live.clones = 2; // full, so both requests wait
  await requestSlot("cloneSessions", {
    userId: USER,
    ref: "clone-a",
    priority: "standard",
    pressure: pressure("normal"),
    now: at(2, now),
  });
  await requestSlot("cloneSessions", {
    userId: OTHER,
    ref: "clone-b",
    priority: "standard",
    pressure: pressure("normal"),
    now: at(1, now),
  });

  const positions = await getQueuePositions("cloneSessions", ["clone-a", "clone-b", "unknown"]);
  assert.equal(positions.get("clone-a")?.position, 1);
  assert.equal(positions.get("clone-b")?.position, 2);
  assert.equal(positions.has("unknown"), false, "a handle that is not waiting has no position");
  assert.ok((positions.get("clone-a")?.etaSeconds ?? 0) > 0);

  // The clone ahead of it starts → the waiting clone's number drops on its own,
  // which is exactly what the console's poll renders.
  rows.find((r) => r.ref === "clone-a")!.status = "granted";
  const drained = await getQueuePositions("cloneSessions", ["clone-a", "clone-b"]);
  assert.equal(drained.has("clone-a"), false);
  assert.equal(drained.get("clone-b")?.position, 1);

  // With the governor OFF nothing is ever queued, so this is a clean no-op.
  adminRow.governorEnabled = false;
  rows.length = 0;
  assert.equal((await getQueuePositions("cloneSessions", ["clone-b"])).size, 0);
});

// ---------------------------------------------------------------------------
// Acceptance: the admin panel's read model
// ---------------------------------------------------------------------------

test("the admin read model reports cap, live and QUEUED counts for every feature", async () => {
  adminRow.governorEnabled = true;
  live.clones = 2;
  live.light = 1;
  live.browserSessions = 2;
  await requestSlot("cloneSessions", {
    userId: USER,
    ref: "a",
    priority: "standard",
    pressure: pressure("normal"),
  });

  const statuses = await getGovernorFeatureStatuses();
  assert.deepEqual(
    statuses.map((s) => s.key),
    [...GOVERNOR_FEATURES]
  );

  const clone = statuses.find((s) => s.key === "cloneSessions");
  assert.ok(clone);
  assert.equal(clone.cap, 2);
  assert.equal(clone.live, 2);
  assert.equal(clone.queued, 1);
  assert.equal(clone.perUserCap, 1);

  const pool = statuses.find((s) => s.key === "hostedPool");
  assert.ok(pool);
  assert.equal(pool.enabled, true, "no on/off column → reported enabled");
  assert.equal(pool.queueable, true);

  const light = statuses.find((s) => s.key === "dispatchLight");
  assert.ok(light);
  assert.equal(light.cap, 1);
  assert.equal(light.live, 1);
  assert.equal(light.queued, 0);

  const sessions = statuses.find((s) => s.key === "browserSessions");
  assert.ok(sessions);
  assert.equal(sessions.live, 2);
  assert.equal(sessions.cap, 3);
});

