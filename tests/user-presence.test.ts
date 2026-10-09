import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// ---------------------------------------------------------------------------
// TASK_190 S5 — the LIB gate for owner presence (tests/user-presence.test.ts;
// the routes + admin-UI wiring live in tests/admin-users-presence.test.ts).
//
// Against a fake db the REAL lib runs: window math (90/300 boundaries,
// clamp-to-idle of verify §4.2), heartbeat's transition-only writes (steady
// ping ⇒ ZERO rows; gap ⇒ offline+login pair; first ping ⇒ single login;
// idle→online on interaction), stampLogout, the drawer list (take ≤ 100, desc,
// since) and the 90-day retention sweep.
// ---------------------------------------------------------------------------

(process.env as Record<string, string>).NODE_ENV = "test";
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";

const LIB = "/lib/user-presence.ts";

/** Minimal NextResponse stand-in — the loader stubs next/server with it. */
const fakeNextResponse = {
  json: (data: unknown, init?: { status?: number }) => ({
    status: init?.status ?? 200,
    body: data,
    json: async () => data,
  }),
};

// ---------------------------------------------------------------------------
// Fake db — every create/update/delete is recorded: a heartbeat that starts
// writing rows on steady state, an update that sneaks a third column in, or a
// take that exceeds 100 shows up here even when the return looks right.
// ---------------------------------------------------------------------------
interface FakeUserRow {
  id: string;
  lastSeenAt: Date | null;
  lastActiveAt: Date | null;
  lastSeenPage: string | null;
}

interface FakeEvent {
  userId: string;
  state: string;
  page: string | null;
  createdAt: Date;
}

const store = {
  user: null as FakeUserRow | null,
  events: [] as FakeEvent[],
  userList: [] as Array<Record<string, unknown>>,
};

const calls = {
  updates: [] as Array<Record<string, unknown>>,
  creates: [] as Array<Record<string, unknown>>,
  listArgs: null as Record<string, unknown> | null,
  deleteWhere: null as Record<string, unknown> | null,
  userFindManyArgs: null as Record<string, unknown> | null,
  deleteCount: 3,
};


const fakeDb = {
  user: {
    findUnique: async (args: { where: { id: string } }) => {
      const u = store.user;
      if (!u || args.where.id !== u.id) return null;
      return { lastSeenAt: u.lastSeenAt, lastActiveAt: u.lastActiveAt, lastSeenPage: u.lastSeenPage };
    },
    update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      calls.updates.push(args.data);
      const u = store.user!;
      if ("lastSeenAt" in args.data) u.lastSeenAt = args.data.lastSeenAt as Date;
      if ("lastSeenPage" in args.data) u.lastSeenPage = args.data.lastSeenPage as string | null;
      if ("lastActiveAt" in args.data) u.lastActiveAt = args.data.lastActiveAt as Date;
      return u;
    },
  },
  userPresenceEvent: {
    create: async (args: { data: FakeEvent }) => {
      calls.creates.push(args.data as unknown as Record<string, unknown>);
      store.events.push(args.data);
      return args.data;
    },
    findMany: async (args: Record<string, unknown>) => {
      calls.listArgs = args;
      const where = args.where as { userId: string; createdAt?: { gte: Date } };
      const take = (args.take as number) ?? store.events.length;
      return store.events
        .filter(
          (e) =>
            e.userId === where.userId &&
            (!where.createdAt || e.createdAt.getTime() >= where.createdAt.gte.getTime()),
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, take)
        .map((e) => ({ state: e.state, page: e.page, createdAt: e.createdAt }));
    },
    deleteMany: async (args: { where: Record<string, unknown> }) => {
      calls.deleteWhere = args.where;
      return { count: calls.deleteCount };
    },
  },
};

// ---------------------------------------------------------------------------
// Module loader — same machinery as tests/admin-notify.test.ts.
// ---------------------------------------------------------------------------
interface Overrides {
  [request: string]: unknown;
}

let overrides: Overrides = {};
const loader = Module as unknown as {
  _load: (r: string, p: NodeModule | undefined, m: boolean) => unknown;
};
const originalLoad = loader._load;

loader._load = function patched(request, parent, isMain) {
  if (parent?.filename && request in overrides) return overrides[request];
  if (request === "server-only") return {};
  if (request === "next/server") return { NextResponse: fakeNextResponse };
  return originalLoad.call(this, request, parent, isMain);
};

/** Require a module fresh with `deps` substituted for its imports. */
function loadFresh(file: string, deps: Overrides = {}) {
  const abs = require.resolve(`..${file}`);
  delete require.cache[abs];
  overrides = deps;
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    return require(abs) as Record<string, unknown>;
    /* eslint-enable @typescript-eslint/no-require-imports */
  } finally {
    overrides = {};
  }
}

// The REAL lib, loaded once against the fake db — tests/admin-users-presence
// loads this same lib so route tests exercise the window math pinned here.
// Typed surface so tsc checks every call against the real signatures.
type PresenceLib = {
  derivePresence: (lastSeenAt: Date | null | undefined, now: Date) => "online" | "idle" | "offline";
  deriveUserPresence: (
    lastActiveAt: Date | null | undefined,
    lastSeenAt: Date | null | undefined,
    now: Date,
  ) => "online" | "idle" | "offline";
  heartbeat: (
    userId: string,
    page: string | null,
    now: Date,
    opts?: { active?: boolean },
  ) => Promise<{ state: "online" | "idle" | "offline"; transition: string | null }>;
  stampLogout: (userId: string) => Promise<void>;
  listUserPresenceEvents: (
    userId: string,
    limit?: number,
    since?: Date,
  ) => Promise<Array<{ state: string; page: string | null; createdAt: Date }>>;
  sweepPresenceEvents: (now?: Date) => Promise<number>;
  ONLINE_WINDOW_S: number;
  IDLE_WINDOW_S: number;
  PRESENCE_PAGE_MAX_CHARS: number;
  PRESENCE_LIST_LIMIT: number;
  PRESENCE_EVENT_RETENTION_DAYS: number;
};
const lib = loadFresh(LIB, { "./db": { db: fakeDb } }) as unknown as PresenceLib;

const NOW = new Date("2026-10-09T12:00:00.000Z");
const ago = (s: number) => new Date(NOW.getTime() - s * 1000);

function seedUser(row: Partial<FakeUserRow> = {}): void {
  store.user = { id: "u1", lastSeenAt: null, lastActiveAt: null, lastSeenPage: null, ...row };
}

beforeEach(() => {
  store.user = null;
  store.events.length = 0;
  store.userList.length = 0;
  calls.updates.length = 0;
  calls.creates.length = 0;
  calls.listArgs = null;
  calls.deleteWhere = null;
  calls.userFindManyArgs = null;
});


// ===========================================================================
// Layer 1 — LIB
// ===========================================================================

test("derivePresence: exact window boundaries (89/90 online, 91/300 idle, 301/never offline)", () => {
  const d = lib.derivePresence as (l: Date | null, n: Date) => string;
  assert.equal(d(null, NOW), "offline", "no stamp ⇒ offline");
  assert.equal(d(ago(-5), NOW), "offline", "future stamp (clock skew) ⇒ offline");
  assert.equal(d(ago(0), NOW), "online");
  assert.equal(d(ago(89), NOW), "online");
  assert.equal(d(ago(90), NOW), "online", "boundary inclusive");
  assert.equal(d(ago(91), NOW), "idle");
  assert.equal(d(ago(300), NOW), "idle", "boundary inclusive");
  assert.equal(d(ago(301), NOW), "offline");
});

test("deriveUserPresence: stale heartbeat ⇒ offline regardless of input; alive ⇒ input decides", () => {
  const d = lib.deriveUserPresence as (a: Date | null, s: Date | null, n: Date) => string;
  assert.equal(d(null, null, NOW), "offline", "never seen ⇒ offline");
  // lastSeenAt stale past 90s: the tab is GONE even though input was 10s ago
  // (a closed tab can't ping; verify §4.3's ~2.5min offline).
  assert.equal(d(ago(10), ago(100), NOW), "offline");
  // Fresh ping + fresh input ⇒ online.
  assert.equal(d(ago(30), ago(30), NOW), "online");
  // Fresh ping + input in the idle band ⇒ idle (open but untouched).
  assert.equal(d(ago(120), ago(30), NOW), "idle");
  // THE §4.2 CLAMP: pings alive but input ancient ⇒ IDLE, NEVER offline.
  assert.equal(d(ago(6000), ago(30), NOW), "idle");
  // lastActiveAt absent falls back to lastSeenAt (pings count as activity
  // until we learn otherwise).
  assert.equal(d(null, ago(30), NOW), "online");
  // Exact boundaries.
  assert.equal(d(ago(90), ago(90), NOW), "online");
  assert.equal(d(ago(91), ago(90), NOW), "idle");
});

test("heartbeat: unknown user ⇒ offline/no-op, nothing written", async () => {
  store.user = null;
  const r = (await lib.heartbeat("ghost", "/x", NOW, { active: true })) as {
    state: string;
    transition: string | null;
  };
  assert.deepEqual(r, { state: "offline", transition: null });
  assert.equal(calls.updates.length, 0, "no update for a deleted user");
  assert.equal(calls.creates.length, 0, "no event for a deleted user");
});

test("heartbeat: first ping ever ⇒ single 'login' row + stamps both columns when active", async () => {
  seedUser();
  const r = (await lib.heartbeat("u1", "/dashboard", NOW, { active: true })) as {
    state: string;
    transition: string | null;
  };
  assert.deepEqual(r, { state: "online", transition: "login" });
  assert.deepEqual(calls.updates, [
    { lastSeenAt: NOW, lastSeenPage: "/dashboard", lastActiveAt: NOW },
  ]);
  assert.equal(calls.creates.length, 1, "cold start writes login ONLY (not offline+login)");
  assert.deepEqual(calls.creates[0], { userId: "u1", state: "login", page: "/dashboard" });
});

test("heartbeat: steady state ⇒ ZERO event rows (60s ping storm adds nothing)", async () => {
  seedUser({ lastSeenAt: ago(30), lastActiveAt: ago(30), lastSeenPage: "/dashboard" });
  const r = (await lib.heartbeat("u1", "/dashboard", NOW, { active: false })) as {
    state: string;
    transition: string | null;
  };
  assert.deepEqual(r, { state: "online", transition: null });
  assert.equal(calls.creates.length, 0, "steady ping must not grow the history table");
  // Inactive ping refreshes ONLY the verify-§4.5 columns: no lastActiveAt.
  assert.deepEqual(calls.updates, [{ lastSeenAt: NOW, lastSeenPage: "/dashboard" }]);
});

test("heartbeat: input already stale + non-active ping ⇒ dedupe, NO row (chip-side idle only)", async () => {
  // Pings alive (seen 30s) but input ancient: prev=idle, next=idle ⇒ nothing
  // written — the CHIP goes idle purely on the admin's read-time clock
  // (STEPS §734-754 resolution), the history table stays transition-only.
  seedUser({ lastSeenAt: ago(30), lastActiveAt: ago(600), lastSeenPage: "/d" });
  const r = (await lib.heartbeat("u1", "/d", NOW, {})) as {
    state: string;
    transition: string | null;
  };
  assert.deepEqual(r, { state: "idle", transition: null });
  assert.equal(calls.creates.length, 0, "idle steady state must not grow the table");
  assert.deepEqual(calls.updates, [{ lastSeenAt: NOW, lastSeenPage: "/d" }]);
});

test("heartbeat: idle→online on interaction ⇒ exactly one 'online' row (STEPS §299)", async () => {
  // Pings alive, input ancient (chip reads idle); a real input ping returns
  // the user — THE reachable online transition of the heartbeat.
  seedUser({ lastSeenAt: ago(30), lastActiveAt: ago(600), lastSeenPage: "/d" });
  const r = (await lib.heartbeat("u1", "/d", NOW, { active: true })) as {
    state: string;
    transition: string | null;
  };
  assert.deepEqual(r, { state: "online", transition: "online" });
  assert.equal(calls.creates.length, 1);
  assert.deepEqual(calls.creates[0], { userId: "u1", state: "online", page: "/d" });
  assert.equal(calls.updates[0].lastActiveAt, NOW, "interaction bumps lastActiveAt");
});

test("heartbeat: gap discovery ⇒ stale 'offline' + 'login' pair (verify §4.3/§4.4)", async () => {
  // Beacon silent 10min (prev=offline, chip showed offline), returning now.
  seedUser({ lastSeenAt: ago(600), lastActiveAt: ago(600), lastSeenPage: "/old-page" });
  const r = (await lib.heartbeat("u1", "/new-page", NOW, {})) as {
    state: string;
    transition: string | null;
  };
  assert.equal(r.transition, "login");
  assert.equal(calls.creates.length, 2, "gap writes BOTH rows");
  assert.deepEqual(calls.creates[0], { userId: "u1", state: "offline", page: "/old-page" });
  assert.deepEqual(calls.creates[1], { userId: "u1", state: "login", page: "/new-page" });
});

test("heartbeat: page is truncated to PRESENCE_PAGE_MAX_CHARS (120)", async () => {
  seedUser();
  await lib.heartbeat("u1", `/${"p".repeat(400)}`, NOW, { active: false });
  const stamped = calls.updates[0].lastSeenPage as string;
  assert.equal(stamped.length, lib.PRESENCE_PAGE_MAX_CHARS as number);
});


test("stampLogout: always a row, page = wherever the beacon last saw them", async () => {
  seedUser({ lastSeenPage: "/settings/billing" });
  await lib.stampLogout("u1");
  assert.deepEqual(calls.creates, [{ userId: "u1", state: "logout", page: "/settings/billing" }]);

  // Unknown user still stamps (page null) — sign-out may race a delete.
  calls.creates.length = 0;
  await lib.stampLogout("ghost");
  assert.deepEqual(calls.creates, [{ userId: "ghost", state: "logout", page: null }]);
});

test("listUserPresenceEvents: desc order, since filter, take clamped to 100", async () => {
  store.events.push(
    { userId: "u1", state: "login", page: null, createdAt: ago(10) },
    { userId: "u2", state: "login", page: null, createdAt: ago(20) }, // other user
  );
  const since = ago(7 * 24 * 3600);
  const rows = (await lib.listUserPresenceEvents("u1", 999, since)) as Array<{ state: string }>;
  assert.equal(rows.length, 1, "only u1's rows");
  const args = calls.listArgs!;
  assert.deepEqual(args.where, { userId: "u1", createdAt: { gte: since } });
  assert.deepEqual(args.orderBy, { createdAt: "desc" });
  assert.equal(args.take, lib.PRESENCE_LIST_LIMIT as number, "cap enforced at 100");
});

test("sweepPresenceEvents: deleteMany older than the 90-day cutoff, returns the count", async () => {
  const count = (await lib.sweepPresenceEvents(NOW)) as number;
  assert.equal(count, calls.deleteCount);
  const cutoff = (calls.deleteWhere as { createdAt: { lt: Date } }).createdAt.lt;
  const days = (NOW.getTime() - cutoff.getTime()) / (24 * 60 * 60 * 1000);
  assert.ok(Math.abs(days - 90) < 1e-9, `cutoff is exactly 90d, got ${days}`);
  assert.equal(lib.PRESENCE_EVENT_RETENTION_DAYS, 90);
});

