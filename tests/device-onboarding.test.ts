import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

import {
  ONBOARDING_MAX_ATTEMPTS,
  nextOnboardingAction,
  onboardingRowLabel,
} from "../lib/device-onboarding";

// TASK_228 — hide-only onboarding (quarantine retired 2026-10-19).
//
// WHY THIS FILE EXISTS: the owner's redesign has exactly two behaviours that
// must never regress: (1) the hide fires ~60s after a new device appears and
// NEVER touches the agent process; (2) an offline device — including the
// vantra_503 transport error — burns NO attempt and sets NO lastError (the old
// sweep burned attempts on 503s and rows died red while the box was fine).
// Everything below exercises the REAL rule module (lib/device-onboarding.ts)
// and the REAL sweep route (app/api/internal/device-onboarding-sweep/route.ts)
// through the house require hook, swapping only their dependencies for
// recording fakes — never a copy of the logic. Nothing touches a real database,
// Vantra, or a device.

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
  hideLabel: string | null;
  timerStartedAt: Date;
  hideDoneAt: Date | null;
  hideOutput: string | null;
  releasedAt: Date | null;
  status: string;
  attempts: number;
  lastError: string | null;
  claimAt: Date | null;
}

const devices = new Map<string, DeviceRow>();
let rows: OnboardingRow[] = [];

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

const fakeDb = {
  deviceOnboarding: {
    async findMany(args: { where?: Record<string, unknown>; include?: unknown }) {
      return rows
        .filter((r) => matches(r as unknown as Record<string, unknown>, args.where))
        .map((r) => ({ ...r, device: { ...devices.get(r.deviceId) } }));
    },
    async updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
      // Test hook: simulate the claim race — findMany saw the row, but by the
      // time updateMany runs another sweep pass already claimed it (count 0).
      if (claimCountOverride !== null) {
        const c = claimCountOverride;
        claimCountOverride = null;
        return { count: c };
      }
      const hit = rows.filter((r) => matches(r as unknown as Record<string, unknown>, args.where));
      for (const row of hit) {
        applyData(row as unknown as Record<string, unknown>, args.data);
      }
      return { count: hit.length };
    },
    async update(args: { where: { id: string }; data: Record<string, unknown> }) {
      const row = rows.find((r) => r.id === args.where.id);
      if (!row) throw new Error("onboarding not found");
      applyData(row as unknown as Record<string, unknown>, args.data);
      return { ...row };
    },
  },
  vantraLink: {
    async findMany() {
      return vantraLinks.filter((l) => l.status !== "revoked");
    },
  },
};

let vantraLinks: Array<{ userId: string; status: string }> = [];
let syncCalls: string[] = [];
/** A userId whose sync throws — proves one broken link cannot abort the sweep. */
let failSyncUser: string | null = null;


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
    if (request === "next/server" && from.endsWith(`/${ROUTE}`)) {
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
    // The sweep route AND lib/devices (for isDeviceOnline) both import the real
    // prisma singleton; give every in-repo parent the fake store so nothing can
    // ever reach a real database from a test.
    if (request === "@/lib/prisma" && from.includes("/sw-t228/")) {
      return { prisma: fakeDb };
    }
    if (from.endsWith(`/${ROUTE}`)) {
      if (request === "@/lib/internal-auth") {
        return { requireInternalBearer: () => bearerOk };
      }
      if (request === "@/lib/device-tools") {
        return { runCommandNow: fakeRunCommandNow };
      }
      if (request === "@/lib/vantra-link") {
        return { syncDevices: fakeSyncDevices };
      }
    }
    return original(request, parent, isMain);
  } as Loader["_load"];
}

installRequireHook();

type PostFn = (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;

function loadRoute(): PostFn {
  // Fresh module instance per test — the route is stateless anyway, but this
  // keeps future module-level state from leaking between tests.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const resolved = require.resolve("../app/api/internal/device-onboarding-sweep/route.ts");
  delete require.cache[resolved];
  const mod = require("../app/api/internal/device-onboarding-sweep/route.ts") as { POST: PostFn };
  /* eslint-enable @typescript-eslint/no-require-imports */
  return mod.POST;
}

const T0 = Date.parse("2026-10-19T12:00:00Z");

function seedDevice(opts: { id: string; userId: string; lastSeenAt: Date | null }): void {
  devices.set(opts.id, {
    id: opts.id,
    userId: opts.userId,
    name: `box-${opts.id}`,
    tier: "public",
    lastSeenAt: opts.lastSeenAt,
  });
}

function seedRow(opts: {
  id: string;
  deviceId: string;
  userId: string;
  timerStartedAt: Date;
  status?: string;
  hideDoneAt?: Date | null;
  attempts?: number;
  lastError?: string | null;
}): void {
  rows.push({
    id: opts.id,
    deviceId: opts.deviceId,
    userId: opts.userId,
    hideLabel: `box-${opts.deviceId}`,
    timerStartedAt: opts.timerStartedAt,
    hideDoneAt: opts.hideDoneAt ?? null,
    hideOutput: null,
    releasedAt: null,
    status: opts.status ?? "pending",
    attempts: opts.attempts ?? 0,
    lastError: opts.lastError ?? null,
    claimAt: null,
  });
}

function getRow(id: string): OnboardingRow {
  const row = rows.find((r) => r.id === id);
  assert.ok(row, `row ${id} exists`);
  return row;
}

beforeEach(() => {
  devices.clear();
  rows = [];
  vantraLinks = [];
  syncCalls = [];
  failSyncUser = null;
  hideCalls = [];
  hideBehavior = "ok";
  bearerOk = true;
  claimCountOverride = null;
});

function authedReq(): Request {
  return new Request("http://test", {
    method: "POST",
    headers: { authorization: "Bearer test-token" },
  });
}

const fakeSyncDevices = async (userId: string) => {
  syncCalls.push(userId);
  if (failSyncUser && userId === failSyncUser) throw new Error("no_link");
  return { devices: [] as unknown[] };
};

let hideCalls: Array<Record<string, unknown>> = [];
let hideBehavior: "ok" | "fail_output" | "throw" | "throw_503" = "ok";
let bearerOk = true;
/** When non-null, the next updateMany (the claim) returns this count untouched. */
let claimCountOverride: number | null = null;

const fakeRunCommandNow = async (opts: Record<string, unknown>) => {
  hideCalls.push(opts);
  if (hideBehavior === "throw") throw new Error("trmm_500_dispatch_failed");
  if (hideBehavior === "throw_503") {
    throw new Error("vantra_503: {\"error\":\"This device is currently offline.\"}");
  }
  if (hideBehavior === "fail_output") {
    return { output: "STEP:agent_service FAIL:agent_service_missing", shell: "powershell" };
  }
  return {
    output: "STEP:agent_service OK:tacticalrmm\nSTEP:rename:tacticalrmm OK\nVERIFY:service:tacticalrmm",
    shell: "powershell",
  };
};

// ---------------------------------------------------------------------------
// The rule (lib/device-onboarding.ts) — pure, no DB
// ---------------------------------------------------------------------------

test("quiet first minute: nothing before +60s, hide due at +60s", () => {
  assert.equal(
    nextOnboardingAction(
      { status: "pending", hideDoneAt: null, attempts: 0, timerStartedAt: new Date(T0) },
      T0 + 59_000,
    ),
    null,
    "59s after the device appeared: total silence — nothing renders, nothing runs",
  );
  assert.deepEqual(
    nextOnboardingAction(
      { status: "pending", hideDoneAt: null, attempts: 0, timerStartedAt: new Date(T0) },
      T0 + 60_000,
    ),
    { action: "hide" },
    "the hide is due exactly at +60s",
  );
});

test("terminal/dead rows never act again", () => {
  for (const row of [
    { status: "released", hideDoneAt: new Date(T0), attempts: 0 },
    { status: "failed", hideDoneAt: null, attempts: 0 },
    { status: "failed", hideDoneAt: null, attempts: ONBOARDING_MAX_ATTEMPTS },
    { status: "pending", hideDoneAt: new Date(T0), attempts: 0 },
  ]) {
    assert.equal(
      nextOnboardingAction(
        { ...row, timerStartedAt: new Date(T0) } as Parameters<typeof nextOnboardingAction>[0],
        T0 + 60 * 60_000,
      ),
      null,
      `row ${JSON.stringify(row)} must stay dead an hour later`,
    );
  }
});

test("onboardingRowLabel — released gone, failed red, due amber", () => {
  assert.equal(
    onboardingRowLabel(
      { status: "released", hideDoneAt: new Date(T0), attempts: 0, timerStartedAt: new Date(T0) },
      T0 + 60_000,
    ),
    null,
    "released row renders NOTHING — the badge disappears",
  );
  const failed = onboardingRowLabel(
    { status: "failed", hideDoneAt: null, attempts: ONBOARDING_MAX_ATTEMPTS, timerStartedAt: new Date(T0) },
    T0 + 60_000,
  );
  assert.equal(failed?.tone, "failed");
  assert.equal(failed?.text, "Hide failed");
  assert.equal(
    onboardingRowLabel(
      { status: "pending", hideDoneAt: null, attempts: 0, timerStartedAt: new Date(T0) },
      T0 + 59_000,
    ),
    null,
    "first minute: no badge at all",
  );
  assert.equal(
    onboardingRowLabel(
      { status: "pending", hideDoneAt: null, attempts: 0, timerStartedAt: new Date(T0) },
      T0 + 60_000,
    )?.text,
    "Hiding agent…",
  );
  assert.equal(
    onboardingRowLabel(
      { status: "pending", hideDoneAt: null, attempts: 2, timerStartedAt: new Date(T0) },
      T0 + 60_000,
    )?.text,
    "Hiding agent · retry 2",
    "genuine failures only — an offline wait never shows a retry number",
  );
});

// ---------------------------------------------------------------------------
// The sweep (app/api/internal/device-onboarding-sweep/route.ts)
// ---------------------------------------------------------------------------

test("401 without the internal bearer", async () => {
  bearerOk = false;
  const POST = loadRoute();
  const res = await POST(new Request("http://test", { method: "POST" }));
  assert.equal(res.status, 401);
});

test("syncs every linked user first; one broken link cannot abort the sweep", async () => {
  seedDevice({ id: "dev-ok", userId: "u-ok", lastSeenAt: new Date() });
  seedRow({ id: "r1", deviceId: "dev-ok", userId: "u-ok", timerStartedAt: new Date(Date.now() - 61_000) });
  seedDevice({ id: "dev-bad", userId: "u-bad", lastSeenAt: new Date() });
  seedRow({ id: "r2", deviceId: "dev-bad", userId: "u-bad", timerStartedAt: new Date(Date.now() - 61_000) });
  vantraLinks = [{ userId: "u-ok", status: "active" }, { userId: "u-bad", status: "active" }];
  failSyncUser = "u-bad";

  const POST = loadRoute();
  const res = await POST(authedReq());
  assert.equal(res.status, 200);
  assert.deepEqual([...syncCalls].sort(), ["u-bad", "u-ok"], "both syncs ATTEMPTED, bad one included");
  assert.equal((res.body as { synced: number }).synced, 1);
  const errs = (res.body as { syncErrors: string[] }).syncErrors;
  assert.equal(errs.length, 1, "exactly one error recorded");
  assert.ok(String(errs[0]).startsWith("u-bad:"), String(errs[0]));
  assert.equal(
    (res.body as { hid: number }).hid,
    2,
    "a broken sync link does not cancel that user's hide either — only device freshness does",
  );
  assert.equal(getRow("r1").status, "released");
  assert.equal(getRow("r2").status, "released");
});

test("fresh + due + online → hide runs (hideLabel name, powershell, runAsUser:false) and the row releases", async () => {
  seedDevice({ id: "dev-7", userId: "u-1", lastSeenAt: new Date() });
  seedRow({ id: "r1", deviceId: "dev-7", userId: "u-1", timerStartedAt: new Date(Date.now() - 61_000) });
  vantraLinks = [{ userId: "u-1", status: "active" }];

  const POST = loadRoute();
  const res = await POST(authedReq());
  assert.equal(res.status, 200);
  assert.equal((res.body as { hid: number }).hid, 1);
  assert.equal(hideCalls.length, 1);
  const call = hideCalls[0]!;
  assert.equal(call.userId, "u-1");
  assert.equal(call.deviceId, "dev-7");
  assert.equal(call.shell, "powershell");
  assert.equal(call.runAsUser, false, "system-level — the agent service is being renamed");
  assert.equal(call.timeoutSeconds, 90);
  assert.ok(
    String(call.cmd).includes("box-dev-7"),
    "the hide targets the DEVICE NAME from hideLabel (the vantra_404 regression)",
  );
  const row = getRow("r1");
  assert.equal(row.status, "released");
  assert.ok(row.hideDoneAt, "hideDoneAt stamped");
  assert.ok(row.releasedAt, "releasedAt stamped");
  assert.equal(row.lastError, null);
});

test("OFFLINE device → NO hide call, NO attempt burn, NO lastError", async () => {
  seedDevice({ id: "dev-8", userId: "u-1", lastSeenAt: new Date(Date.now() - 10 * 60_000) });
  seedRow({ id: "r1", deviceId: "dev-8", userId: "u-1", timerStartedAt: new Date(Date.now() - 61_000) });
  vantraLinks = [{ userId: "u-1", status: "active" }];

  const POST = loadRoute();
  const res = await POST(authedReq());
  assert.equal(res.status, 200);
  assert.equal(hideCalls.length, 0, "never dispatch to a box dark for 10 minutes");
  const row = getRow("r1");
  assert.equal(row.attempts, 0, "offline is NOT a failure — no burn");
  assert.equal(row.lastError, null, "no error surface for a quiet wait");
  assert.equal(row.status, "pending");
  assert.equal((res.body as { skippedOffline: number }).skippedOffline, 1);
});

test("vantra_503 (agent offline at dispatch) → claim released, NO burn, row stays pending", async () => {
  seedDevice({ id: "dev-9", userId: "u-1", lastSeenAt: new Date() });
  seedRow({ id: "r1", deviceId: "dev-9", userId: "u-1", timerStartedAt: new Date(Date.now() - 61_000) });
  vantraLinks = [{ userId: "u-1", status: "active" }];
  hideBehavior = "throw_503";

  const POST = loadRoute();
  const res = await POST(authedReq());
  assert.equal(res.status, 200);
  assert.equal(hideCalls.length, 1, "the attempt WAS made (freshness gate had passed)");
  const row = getRow("r1");
  assert.equal(row.attempts, 0, "THE 503 BUG REGRESSION: a transport 'offline' burns nothing");
  assert.equal(row.lastError, null, "no red error from a device that is merely off");
  assert.equal(row.status, "pending", "retry next sweep");
  assert.equal(row.claimAt, null, "claim released for the next pass");
});

test("genuine transport error (non-503) → attempts++ with STEP:transport_error", async () => {
  seedDevice({ id: "dev-a", userId: "u-1", lastSeenAt: new Date() });
  seedRow({ id: "r1", deviceId: "dev-a", userId: "u-1", timerStartedAt: new Date(Date.now() - 61_000) });
  vantraLinks = [{ userId: "u-1", status: "active" }];
  hideBehavior = "throw";

  const POST = loadRoute();
  const res = await POST(authedReq());
  assert.equal(res.status, 200);
  const row = getRow("r1");
  assert.equal(row.attempts, 1, "a real failure burns exactly one attempt");
  assert.ok(String(row.lastError).includes("STEP:transport_error"), String(row.lastError));
  assert.ok(String(row.lastError).includes("trmm_500_dispatch_failed"), "the real error text survives");
});

test("hide script FAIL output → attempts++ with hide_script_fail:", async () => {
  seedDevice({ id: "dev-b", userId: "u-1", lastSeenAt: new Date() });
  seedRow({ id: "r1", deviceId: "dev-b", userId: "u-1", timerStartedAt: new Date(Date.now() - 61_000) });
  vantraLinks = [{ userId: "u-1", status: "active" }];
  hideBehavior = "fail_output";

  const POST = loadRoute();
  await POST(authedReq());
  const row = getRow("r1");
  assert.equal(row.attempts, 1);
  assert.ok(String(row.lastError).includes("hide_script_fail:"), String(row.lastError));
  assert.ok(String(row.lastError).includes("FAIL:agent_service_missing"), "the failing step is named");
});

test("attempts reaching the max → status failed (the red 'Hide failed' badge)", async () => {
  seedDevice({ id: "dev-c", userId: "u-1", lastSeenAt: new Date() });
  seedRow({
    id: "r1", deviceId: "dev-c", userId: "u-1",
    timerStartedAt: new Date(Date.now() - 61_000),
    attempts: ONBOARDING_MAX_ATTEMPTS - 1,
  });
  vantraLinks = [{ userId: "u-1", status: "active" }];
  hideBehavior = "throw";

  const POST = loadRoute();
  await POST(authedReq());
  const row = getRow("r1");
  assert.equal(row.attempts, ONBOARDING_MAX_ATTEMPTS);
  assert.equal(row.status, "failed", "terminal — no more dispatches, ever");
  assert.equal(nextOnboardingAction(row, Date.now()), null, "rule agrees the row is dead");
});

test("a released row is never re-run (claim exactly-once)", async () => {
  seedDevice({ id: "dev-d", userId: "u-1", lastSeenAt: new Date() });
  seedRow({
    id: "r1", deviceId: "dev-d", userId: "u-1",
    timerStartedAt: new Date(Date.now() - 5 * 60_000),
    status: "released",
    hideDoneAt: new Date(Date.now() - 4 * 60_000),
  });
  vantraLinks = [{ userId: "u-1", status: "active" }];

  const POST = loadRoute();
  const res = await POST(authedReq());
  assert.equal((res.body as { hid: number }).hid, 0);
  assert.equal(hideCalls.length, 0, "released rows are invisible to the sweep");
});

test("claim race: another sweep pass claimed the row first → nothing runs", async () => {
  seedDevice({ id: "dev-e", userId: "u-1", lastSeenAt: new Date() });
  seedRow({ id: "r1", deviceId: "dev-e", userId: "u-1", timerStartedAt: new Date(Date.now() - 61_000) });
  vantraLinks = [{ userId: "u-1", status: "active" }];
  claimCountOverride = 0; // findMany saw it; updateMany lost the race

  const POST = loadRoute();
  const res = await POST(authedReq());
  assert.equal((res.body as { hid: number }).hid, 0);
  assert.equal(hideCalls.length, 0, "loser of the race dispatches nothing");
  assert.equal(getRow("r1").claimAt, null, "row not even claimed by us");
});
