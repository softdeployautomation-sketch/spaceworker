import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";

// ---------------------------------------------------------------------------
// TASK_190 S5 — routes + wiring gate for owner presence (the LIB layer lives
// in tests/user-presence.test.ts; this file runs the REAL lib through the
// routes it wires up).
//
// Two layers, each proving what the layer above it cannot:
//   2. ROUTES  — POST /api/presence is 401 without a session; GET
//                /api/admin/users is 403 without admin and derives `presence`
//                with the same lib helper; GET .../presence is 403/404/200.
//   3. STATIC  — beacon cadence + pagehide/visibility wiring; beacon mounted
//                ONCE in the hosted dashboard branch only (never localExe,
//                never admin panel); logout stamps best-effort BEFORE cookie
//                clear; sweep has its own try/catch; devices dot + Users chip
//                exist and their 90/300 windows match the lib constants.
// ---------------------------------------------------------------------------

(process.env as Record<string, string>).NODE_ENV = "test";
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";

const LIB = "/lib/user-presence.ts";
const PRESENCE_ROUTE = "/app/api/presence/route.ts";
const USERS_ROUTE = "/app/api/admin/users/route.ts";
const EVENTS_ROUTE = "/app/api/admin/users/[id]/presence/route.ts";
const LAYOUT = "app/dashboard/layout.tsx";
const BEACON = "components/presence-beacon.tsx";
const LOGOUT = "app/api/auth/logout/route.ts";
const SWEEP = "app/api/internal/retention-sweep/route.ts";
const DEVICES_TAB = "components/admin/devices-tab.tsx";
const ADMIN_PANEL = "app/admin=topsecret6199/(protected)/admin-panel.tsx";
const PROTECTED_PAGE = "app/admin=topsecret6199/(protected)/page.tsx";
const SCHEMA = "prisma/schema.prisma";

const ROOT = path.join(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** Minimal NextResponse stand-in — every return here is `.json(...)`. */
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

// The users-list route reads prisma directly — same fake, different handle.
const fakePrisma = {
  user: {
    findMany: async (args: Record<string, unknown>) => {
      calls.userFindManyArgs = args;
      return store.userList;
    },
    findUnique: async (args: { where: { id: string } }) =>
      args.where.id === "u_found" ? { id: "u_found" } : null,
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

type Result = { status: number; body: unknown };

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

// The REAL lib, loaded once against the fake db — routes import it verbatim so
// route tests exercise the same window math the lib tests pin.
const lib = loadFresh(LIB, { "./db": { db: fakeDb } }) as unknown as Record<string, unknown>;

// Session / admin values the route tests flip (reset in beforeEach).
let userValue: { id: string } | null;
let adminValue: { sub: string } | null;

const SESSION_DEP = { getCurrentUser: async () => userValue };
const ADMIN_DEP = { getAdminSession: async () => adminValue };

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
  userValue = null;
  adminValue = null;
});


// ===========================================================================
// Layer 2 — ROUTES
// ===========================================================================

const presencePost = async (body: unknown, jsonThrows = false): Promise<Result> => {
  const mod = loadFresh(PRESENCE_ROUTE, {
    "@/lib/session-user": SESSION_DEP,
    "@/lib/user-presence": lib,
  });
  const req = {
    json: async () => {
      if (jsonThrows) throw new Error("no body");
      return body;
    },
  } as never;
  return (await (mod.POST as (r: unknown) => Promise<Result>)(req)) as Result;
};

test("POST /api/presence: 401 without a session", async () => {
  userValue = null;
  const res = await presencePost({ page: "/dashboard", active: true });
  assert.equal(res.status, 401);
  assert.equal(calls.updates.length, 0, "no stamp for anonymous callers");
});

test("POST /api/presence: stamps the real lib and answers { ok, state }", async () => {
  userValue = { id: "u1" };
  seedUser();
  const t0 = Date.now();
  const res = await presencePost({ page: "/dashboard/devices", active: true });
  const t1 = Date.now();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body as object, { ok: true, state: "online" });
  assert.equal(calls.updates.length, 1);
  assert.ok((calls.updates[0].lastSeenPage as string).length <= 120, "route-side truncation");
  // The ROUTE builds `new Date()` itself — assert the wall-clock window, not a
  // fixed constant (the lib tests own the fixed-clock math).
  const seenAt = (calls.updates[0].lastSeenAt as Date).getTime();
  assert.ok(seenAt >= t0 && seenAt <= t1, "lastSeenAt stamped with route-now");
  assert.equal(calls.updates[0].lastActiveAt, calls.updates[0].lastSeenAt, "active=true stamps both");
});

test("POST /api/presence: garbage body ⇒ plain inactive pageless ping (never 500s)", async () => {
  userValue = { id: "u1" };
  seedUser();
  const t0 = Date.now();
  const res = await presencePost(undefined, true);
  const t1 = Date.now();
  assert.equal(res.status, 200);
  const seenAt = (calls.updates[0].lastSeenAt as Date).getTime();
  assert.ok(seenAt >= t0 && seenAt <= t1, "lastSeenAt stamped with route-now");
  assert.equal(calls.updates[0].lastSeenPage, null, "no page ⇒ null");
  assert.ok(!("lastActiveAt" in calls.updates[0]), "inactive ping must not touch lastActiveAt");
});

test("GET /api/admin/users: 403 without the admin session", async () => {
  adminValue = null;
  const mod = loadFresh(USERS_ROUTE, {
    "@/lib/admin-auth": ADMIN_DEP,
    "@/lib/prisma": { prisma: fakePrisma },
    "@/lib/user-presence": lib,
  });
  const res = (await (mod.GET as () => Promise<Result>)()) as Result;
  assert.equal(res.status, 403);
  assert.equal(calls.userFindManyArgs, null, "no query without admin");
});

test("GET /api/admin/users: derives presence with the lib helper + ships raw stamps", async () => {
  adminValue = { sub: "admin" };
  // The ROUTE derives with ITS OWN new Date() — seed relative to real now.
  const rAgo = (s: number) => new Date(Date.now() - s * 1000);
  store.userList = [
    { id: "u1", email: "a@x.com", lastSeenAt: rAgo(30), lastActiveAt: rAgo(30), lastSeenPage: "/d" },
    { id: "u2", email: "b@x.com", lastSeenAt: null, lastActiveAt: null, lastSeenPage: null },
    { id: "u3", email: "c@x.com", lastSeenAt: rAgo(600), lastActiveAt: rAgo(600), lastSeenPage: null },
  ];
  const mod = loadFresh(USERS_ROUTE, {
    "@/lib/admin-auth": ADMIN_DEP,
    "@/lib/prisma": { prisma: fakePrisma },
    "@/lib/user-presence": lib,
  });
  const res = (await (mod.GET as () => Promise<Result>)()) as Result;
  assert.equal(res.status, 200);
  const body = res.body as { count: number; users: Array<Record<string, unknown>> };
  assert.equal(body.count, 3);
  assert.equal(body.users[0].presence, "online");
  assert.equal(body.users[1].presence, "offline");
  assert.equal(body.users[2].presence, "offline", "stale >90s beacon ⇒ offline");
  assert.equal(body.users[0].lastSeenAt, (store.userList[0].lastSeenAt as Date).toISOString());
  assert.equal(body.users[0].lastSeenPage, "/d");
  const select = (calls.userFindManyArgs as { select: Record<string, unknown> }).select;
  assert.ok(select.lastSeenAt && select.lastActiveAt && select.lastSeenPage, "three stamps selected");
  assert.deepEqual(calls.userFindManyArgs!.orderBy, { email: "asc" });
});


const loadEventsRoute = () =>
  loadFresh(EVENTS_ROUTE, {
    "@/lib/admin-auth": ADMIN_DEP,
    "@/lib/prisma": { prisma: fakePrisma },
    "@/lib/user-presence": lib,
  });

const callEvents = async (mod: Record<string, unknown>, id: string): Promise<Result> =>
  (await (mod.GET as (r: unknown, c: unknown) => Promise<Result>)({}, {
    params: Promise.resolve({ id }),
  })) as Result;

test("GET /api/admin/users/[id]/presence: 403 without admin; 404 for an unknown id", async () => {
  adminValue = null;
  const mod = loadEventsRoute();
  assert.equal((await callEvents(mod, "u_found")).status, 403);

  adminValue = { sub: "admin" };
  assert.equal((await callEvents(mod, "ghost")).status, 404, "id-guessing probe ⇒ deep 404");
  assert.equal(calls.listArgs, null, "no history query for a ghost id");
});

test("GET /api/admin/users/[id]/presence: newest-first rows over the 7-day window, ≤100", async () => {
  adminValue = { sub: "admin" };
  store.events.push(
    { userId: "u_found", state: "login", page: "/d", createdAt: ago(60) },
    { userId: "u_found", state: "logout", page: "/d", createdAt: ago(30) },
  );
  const mod = loadEventsRoute();
  const before = Date.now();
  const res = await callEvents(mod, "u_found");
  const after = Date.now();
  assert.equal(res.status, 200);
  const body = res.body as { events: Array<{ state: string; createdAt: string }> };
  assert.equal(body.events.length, 2);
  assert.equal(body.events[0].state, "logout", "newest first");
  assert.equal(typeof body.events[0].createdAt, "string", "dates serialized as ISO");

  const args = calls.listArgs!;
  assert.equal(args.take, 100);
  const since = (args.where as { createdAt: { gte: Date } }).createdAt.gte.getTime();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  assert.ok(
    since >= before - sevenDays - 5000 && since <= after - sevenDays + 5000,
    `since ≈ now-7d, got ${new Date(since).toISOString()}`,
  );
});

// ===========================================================================
// Layer 3 — STATIC (wiring no unit test can reach without a browser)
// ===========================================================================

test("beacon: mount-ping + 60s interval + visibility + pagehide + active folding", () => {
  const src = read(BEACON);
  assert.match(src, /^"use client"/m, "client component");
  assert.match(src, /fetch\("\/api\/presence"/);
  assert.match(src, /setInterval\(ping, 60_000\)/, "60s cadence (verify §4.1)");
  assert.match(src, /ping\(\); \/\/ mount/, "immediate ping on mount");
  assert.match(src, /visibilitychange/, "instant ping when tab visible again");
  assert.match(src, /pagehide[\s\S]*sendBeacon/, "pagehide uses sendBeacon (survives navigation)");
  assert.match(src, /keepalive: true/);
  assert.match(src, /"pointermove"/, "input listeners flip the active flag");
  assert.match(src, /sawInputRef\.current = false/, "active resets per ping");
  assert.match(src, /return null/, "renders nothing");
});

test("beacon is mounted ONCE — hosted dashboard branch only; never the admin panel", () => {
  const layout = read(LAYOUT);
  const mounts = layout.match(/<PresenceBeacon \/>/g) ?? [];
  assert.equal(mounts.length, 1, "exactly one mount point");
  const beaconIdx = layout.indexOf("<PresenceBeacon />");
  const localExeIdx = layout.indexOf("localExe");
  assert.ok(localExeIdx > -1 && beaconIdx > localExeIdx, "mount sits in the hosted (final) branch");
  assert.match(layout, /import \{ PresenceBeacon \}/);

  const panel = read(ADMIN_PANEL);
  assert.ok(!panel.includes("PresenceBeacon"), "admin panel never mounts the beacon (verify §4.7)");
  assert.ok(!panel.includes("/api/presence"), "no presence pings from admin pages");
});

test("logout route: stampLogout runs BEST-EFFORT before the cookie clear", () => {
  const src = read(LOGOUT);
  const stamp = src.indexOf("stampLogout(session.sub)");
  const clear = src.indexOf("await clearSessionCookie()");
  assert.ok(stamp > 0, "logout route stamps presence");
  assert.ok(clear > stamp, "stamp BEFORE clearing (session still readable)");
  const tryIdx = src.lastIndexOf("try {", stamp);
  const catchIdx = src.indexOf("catch", stamp);
  assert.ok(tryIdx > -1 && tryIdx < stamp && catchIdx > stamp, "stamp inside try/catch — sign-out can never fail");
  assert.ok(catchIdx < clear, "catch precedes the clear");
});

test("retention sweep: sweepPresenceEvents in its OWN try/catch, reported as presenceSwept", () => {
  const src = read(SWEEP);
  assert.match(
    src,
    /try \{\s*presenceSwept = await sweepPresenceEvents\(\);[\s\S]*?\} catch/,
    "isolated from the SearchJob sweep",
  );
  assert.match(src, /presenceSwept,/, "count surfaces in the response");
  assert.ok(
    src.indexOf("sweepPresenceEvents()") > src.indexOf("older than 30d"),
    "presence pass runs AFTER the job sweep",
  );
});


test("devices tab: owner dot lives under the email, separate from device Status", () => {
  const src = read(DEVICES_TAB);
  assert.match(src, /ownerPresence: "online" \| "idle" \| "offline"/, "row type carries it");
  assert.match(src, /owner \{device.ownerPresence\}/, "worded chip, not just a bare dot");
  assert.match(src, /bg-emerald-500[\s\S]{0,300}bg-amber-500/, "own dot palette");
  // The chip must sit in the Owner cell, before the Status badge renders.
  assert.ok(
    src.indexOf("owner {device.ownerPresence}") < src.indexOf("<DeviceStatusBadge"),
    "chip renders in the Owner column, not as device status",
  );
  // Server-side derivation exists in the list lib (both tabs agree).
  const libSrc = read(LIB);
  assert.match(read("/lib/admin-devices.ts"), /deriveUserPresence\(r\.user\.lastActiveAt/);
  assert.ok(libSrc.includes("deriveUserPresence"), "lib exports the shared helper");
});

test("admin Users tab: chip + drawer exist and the 90/300 windows match the lib", () => {
  const src = read(ADMIN_PANEL);
  assert.match(src, /function PresenceChip\(/);
  assert.match(src, /`\/api\/admin\/users\/\$\{user\.id\}\/presence`/, "drawer fetches the events route");
  assert.match(src, /<th className="px-4 py-3 font-medium">Presence<\/th>/, "dedicated column");
  assert.match(src, /lastSeenPage: string \| null/, "raw stamps land on AdminUser");

  const libSrc = read(LIB);
  const online = Number(/ONLINE_WINDOW_S = (\d+)/.exec(libSrc)?.[1]);
  const idle = Number(/IDLE_WINDOW_S = (\d+)/.exec(libSrc)?.[1]);
  const clientOnline = Number(/PRESENCE_ONLINE_WINDOW_S = (\d+)/.exec(src)?.[1]);
  const clientIdle = Number(/PRESENCE_IDLE_WINDOW_S = (\d+)/.exec(src)?.[1]);
  assert.ok(online === 90 && idle === 300, "lib windows are 90/300");
  assert.equal(clientOnline, online, "client mirror matches lib (no flicker drift)");
  assert.equal(clientIdle, idle, "client mirror matches lib");
  assert.match(src, /idle, never offline/, "clamp rule documented + implemented client-side");
});

test("protected page: ships lastSeen/lastActive/lastSeenPage stamps into the panel", () => {
  const src = read(PROTECTED_PAGE);
  assert.match(src, /lastSeenAt: u\.lastSeenAt \? u\.lastSeenAt\.toISOString\(\) : null/);
  assert.match(src, /lastActiveAt: u\.lastActiveAt \? u\.lastActiveAt\.toISOString\(\) : null/);
  assert.match(src, /lastSeenPage: u\.lastSeenPage/);
});

test("schema: UserPresenceEvent + the three User columns exist (verify §4.5)", () => {
  const schema = read(SCHEMA);
  assert.match(schema, /model UserPresenceEvent \{/);
  assert.match(schema, /@@index\(\[userId, createdAt\]\)/, "drawer query is indexed");
  assert.ok(schema.includes("lastSeenPage"), "User.lastSeenPage exists");
  assert.match(schema, /lastActiveAt +DateTime\?/);
  // State stays an unchecked String so an unknown value fails safe in readers.
  assert.match(schema, /state +String/);
});

