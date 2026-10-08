import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// TASK_184 A4 — THE WEB MODULE GATE AT THE ROUTE, end to end.
//
// tests/xdevice-route-gate.test.ts proves the DEVICE gate (lib/device-gate);
// this suite proves the WEB MODULE gate (lib/module-gate.ts) across Phase A's
// surfaces — extractor (POST /api/jobs + PATCH extract-region), hosting (an
// [id] mutation), cyberlab (consent) — plus owner addendum 1: the private
// browser (A6, `browser_required`). Same house pattern: require hook + fake db
// + `server-only` stub; REAL lib/module-gate + REAL lib/entitlements under test.
//
// Truth table (the owner's binding model):
//   free tier 1            → 403 *_required on every mutation; GETs stay open
//   tier 3 live XDevice    → the SAME 403s (carries `devices` ONLY — C2/C4),
//                            while a device route still passes (positive control)
//   tier 5                 → passes
//   free + live grant row  → passes (the grant IS the purchase record)
//   no session             → 401 before any entitlement read
// ---------------------------------------------------------------------------

(process.env as Record<string, string>).NODE_ENV = "test";
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";

const JOBS_ROUTE = "/app/api/jobs/route.ts";
const EXTRACT_REGION_ROUTE = "/app/api/settings/extract-region/route.ts";
const HOSTING_FILE_ROUTE = "/app/api/hosting/files/[id]/route.ts";
const CONSENT_ROUTE = "/app/api/cyberlab/consent/route.ts";
const BROWSER_SESSIONS_ROUTE = "/app/api/browser-sessions/route.ts";
const BROWSER_PROFILES_ROUTE = "/app/api/browser-profiles/route.ts";
const DEVICE_RUN_ROUTE = "/app/api/devices/[deviceId]/run-command/route.ts";

/** Minimal NextResponse stand-in — every return here is `.json(...)`. */
const fakeNextResponse = {
  json: (data: unknown, init?: { status?: number }) => ({
    status: init?.status ?? 200,
    body: data,
    json: async () => data,
  }),
};

interface FakeUser {
  id: string;
  tier: number;
  premiumExpiresAt: Date | null;
  extractProxyRegion?: string | null;
}

interface FakeGrant {
  userId: string;
  key: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

const store: { users: FakeUser[]; grants: FakeGrant[] } = {
  users: [],
  grants: [],
};

const past = new Date(Date.now() - 60_000);
const future = new Date(Date.now() + 60 * 60_000);

/**
 * applyPremiumReversion's write: honor the two filters the real code relies
 * on (`tier: { in: [...] }`, `premiumExpiresAt: { not, lt }`) — a fake that
 * ignored them would let a reversion "succeed" against a row it must miss.
 */
function reversionUpdateMany(
  where: Record<string, unknown>,
  data: Record<string, unknown>,
): { count: number } {
  const u = store.users.find((x) => x.id === where.id);
  if (!u) return { count: 0 };
  const tierFilter = where.tier;
  if (tierFilter !== undefined) {
    const inList = Array.isArray(tierFilter)
      ? tierFilter
      : (tierFilter as { in?: number[] }).in;
    if (Array.isArray(inList) && !inList.includes(u.tier)) return { count: 0 };
  }
  const expFilter = where.premiumExpiresAt as
    | { not?: unknown; lt?: Date }
    | undefined;
  if (expFilter) {
    if (expFilter.not === null && u.premiumExpiresAt === null) return { count: 0 };
    if (expFilter.lt) {
      if (u.premiumExpiresAt === null || u.premiumExpiresAt >= expFilter.lt) {
        return { count: 0 };
      }
    }
  }
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) (u as unknown as Record<string, unknown>)[k] = v;
  }
  return { count: 1 };
}

/** The db lib/entitlements.ts sees (imported relatively as `./db`). */
const fakeDb = {
  user: {
    findUnique: async (args: {
      where: { id: string };
      select?: Record<string, boolean>;
    }): Promise<FakeUser | null> => {
      const u = store.users.find((x) => x.id === args.where.id);
      if (!u) return null;
      if (!args.select) return { ...u };
      const picked: Record<string, unknown> = {};
      for (const k of Object.keys(args.select)) {
        if (args.select[k]) picked[k] = (u as unknown as Record<string, unknown>)[k];
      }
      return picked as unknown as FakeUser;
    },
    updateMany: async (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => reversionUpdateMany(args.where, args.data),
  },
  userEntitlement: {
    findUnique: async (args: {
      where: { userId_key: { userId: string; key: string } };
    }): Promise<FakeGrant | null> => {
      const { userId, key } = args.where.userId_key;
      return store.grants.find((g) => g.userId === userId && g.key === key) ?? null;
    },
    // Lazy grant-expiry stamp — never exercised here (no expired grant rows
    // are seeded), so a safe no-op is the honest fake.
    updateMany: async () => ({ count: 0 }),
  },
};

/**
 * The db the ROUTES see (`@/lib/prisma` — the app-wide singleton). Separate
 * from fakeDb on purpose: route-level reads (user, searchJob, …) must not be
 * confused with the entitlement reads lib/entitlements makes through ./db.
 */
const fakePrisma = {
  user: {
    findUnique: async () => ({ extractProxyRegion: null }),
    update: async (args: {
      data: Record<string, unknown>;
      select?: Record<string, boolean>;
    }) => {
      const row = {
        extractProxyRegion: (args.data.extractProxyRegion as string | null) ?? null,
      };
      if (!args.select) return row;
      const picked: Record<string, unknown> = {};
      for (const k of Object.keys(args.select)) {
        if (args.select[k]) picked[k] = (row as Record<string, unknown>)[k];
      }
      return picked;
    },
  },
  searchJob: { findMany: async () => [] },
  lead: { groupBy: async () => [] },
  browserProfile: {
    count: async () => 0,
    findMany: async () => [],
    create: async (args: { data: Record<string, unknown> }) => ({
      id: "bp_test",
      ...args.data,
    }),
    update: async () => ({}),
    findUnique: async () => ({
      id: "bp_test",
      name: "P",
      status: "idle",
      lastUsedAt: null,
      createdAt: new Date(),
    }),
    findFirst: async () => null,
    delete: async () => ({}),
  },
  browserSession: {
    count: async () => 0,
    create: async () => ({ id: "bs_test" }),
    findFirst: async () => null,
    findMany: async () => [],
    update: async () => ({}),
    updateMany: async () => ({ count: 0 }),
  },
  $transaction: async (arg: unknown) => (typeof arg === "function" ? null : arg),
};

/** Device-tool recorders — the positive control must actually reach them. */
let deviceCalls: Array<Record<string, unknown>>;
const DEVICE_TOOLS = {
  runCommandNow: async (input: Record<string, unknown>) => {
    deviceCalls.push(input);
    return { output: "ok", ranAt: new Date() };
  },
  runPowerAction: async () => ({ packetsSent: 0 }),
  getDevicePowerView: async () => ({ policy: { mode: "off" } }),
  setPowerPolicy: async () => ({ mode: "off" }),
};

/** Consent recorder — a denied caller must never reach recordConsent. */
let consentCalls: number;

/** The session each scenario answers with (null ⇒ 401 path). */
let sessionValue: { userId: string } | null;

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
  const from = parent?.filename ?? "";
  // lib/entitlements.ts + lib/premium.ts both import the db singleton
  // relatively — both must see the SAME fake store (xdevice-route-gate pattern).
  if (
    (from.endsWith("/lib/entitlements.ts") || from.endsWith("/lib/premium.ts")) &&
    request === "./db"
  ) {
    return { db: fakeDb };
  }
  return originalLoad.call(this, request, parent, isMain);
};

type RouteResult = { status: number; body: unknown };

/** Require a route fresh with `deps` substituted for its imports. */
function loadRoute(routePath: string, deps: Overrides) {
  const abs = require.resolve(`..${routePath}`);
  delete require.cache[abs];
  overrides = deps;
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    return require(abs) as {
      GET?: (req?: never, ctx?: unknown) => Promise<RouteResult>;
      POST: (req: never, ctx?: unknown) => Promise<RouteResult>;
      PATCH?: (req: never, ctx?: unknown) => Promise<RouteResult>;
      PUT?: (req: never, ctx?: unknown) => Promise<RouteResult>;
      DELETE?: (req: never, ctx?: unknown) => Promise<RouteResult>;
    };
    /* eslint-enable @typescript-eslint/no-require-imports */
  } finally {
    overrides = {};
  }
}

const req = (body: unknown) => ({ json: async () => body }) as never;
const PARAMS_FILE = { params: Promise.resolve({ id: "fil_1" }) };
const PARAMS_DEVICE = { params: Promise.resolve({ deviceId: "dev_1" }) };

// ---- dependency shims -------------------------------------------------------
const sessionDep = { getSession: async () => sessionValue };
const sessionUserDep = {
  getCurrentUser: async () => (sessionValue ? { id: sessionValue.userId } : null),
};
const prismaDep = { prisma: fakePrisma };
const premiumDep = {
  canUseExitNodes: async () => true,
  resolveUserTier: async () => 5,
};
const exitNodesDep = { getExitNode: () => null, listExitNodes: () => [] };
const createJobDep = {
  createSearchJob: async () => ({ id: "job_test", status: "queued" }),
};
const adminSettingsDep = {
  getAdminSettings: async () => ({
    cyberlabConsentTermsVersion: "v1",
    browserSessionsEnabled: true,
    browserSessionsMaxConcurrent: 3,
  }),
};
const labConsentDep = {
  recordConsent: async () => {
    consentCalls += 1;
    return {
      row: { termsVersion: "v1", signedAt: new Date(), id: "lc_test" },
      created: true,
    };
  },
  clientIp: () => "1.2.3.4",
};
const hostingFilesDep = {
  // ok:true on purpose: a DENIED caller never reaches these (the gate answers
  // first — proven by the 403 assertions), while a PASSING caller must flow
  // through to a clean 200 instead of a gate-shaped 403.
  renameHostedFile: async () => ({
    ok: true,
    value: { id: "fil_1", displayName: "Renamed", userId: "u_mod" },
  }),
  deleteHostedFile: async () => ({ ok: true, value: { id: "fil_1", userId: "u_mod" } }),
};
const browserRuntimeDep = {
  browserRuntime: {
    start: async () => ({ ok: false, error: "not reached" }),
    stop: async () => ({ ok: true }),
    restart: async () => ({ ok: false, error: "not reached" }),
  },
  browserRuntimeAvailable: () => false,
};
const browserProxyDep = {
  proxyServerValue: () => "",
  checkIpThroughProxy: async () => null,
  checkDirectIp: async () => null,
  PROXY_SCHEMES: ["http"],
};
const browserSessionSelectDep = { SESSION_SAFE_SELECT: { id: true } };
const browserSessionSerializeDep = {
  serializeSession: (row: unknown) => row,
  connectUrlFor: () => "",
};
const browserProfilesDep = {
  createProfileDir: async () => "/tmp/profile",
  deleteProfileDir: async () => undefined,
};

/** Per-route dependency sets (every import each route pulls, shimmed). */
const DEPS = {
  jobs: {
    "@/lib/session": sessionDep,
    "@/lib/prisma": prismaDep,
    "@/lib/create-search-job": createJobDep,
    "@/lib/premium": premiumDep,
  },
  extractRegion: {
    "@/lib/session": sessionDep,
    "@/lib/prisma": prismaDep,
    "@/lib/premium": premiumDep,
    "@/lib/exit-nodes": exitNodesDep,
  },
  hostingFile: {
    "@/lib/session-user": sessionUserDep,
    "@/lib/hosting/files": hostingFilesDep,
  },
  consent: {
    "@/lib/session-user": sessionUserDep,
    "@/lib/admin-settings": adminSettingsDep,
    "@/lib/lab/consent": labConsentDep,
  },
  browserSessions: {
    "@/lib/session": sessionDep,
    "@/lib/prisma": prismaDep,
    "@/lib/browser-runtime": browserRuntimeDep,
    "@/lib/exit-nodes": exitNodesDep,
    "@/lib/admin-settings": adminSettingsDep,
    "@/lib/premium": premiumDep,
    "@/lib/browser-proxy": browserProxyDep,
    "@/lib/browser-session-safe-select": browserSessionSelectDep,
    "@/lib/browser-session-serialize": browserSessionSerializeDep,
  },
  browserProfiles: {
    "@/lib/session": sessionDep,
    "@/lib/prisma": prismaDep,
    "@/lib/browser-profiles": browserProfilesDep,
  },
  deviceRun: {
    "@/lib/session": sessionDep,
    "@/lib/device-tools": DEVICE_TOOLS,
  },
} satisfies Record<string, Overrides>;

function seedUser(id: string, tier: number, premiumExpiresAt: Date | null): void {
  store.users.push({ id, tier, premiumExpiresAt, extractProxyRegion: null });
}

function seedGrant(userId: string, key: string): void {
  store.grants.push({ userId, key, expiresAt: null, revokedAt: null });
}

beforeEach(() => {
  store.users.length = 0;
  store.grants.length = 0;
  deviceCalls = [];
  consentCalls = 0;
  sessionValue = { userId: "u_mod" };
  overrides = {};
});

// ---------------------------------------------------------------------------
// THE TRUTH TABLE (top) — 401 first, free → every module 403, reads stay open.
// ---------------------------------------------------------------------------

test("no session → 401 before any entitlement read", async () => {
  sessionValue = null;
  const jobs = loadRoute(JOBS_ROUTE, DEPS.jobs);
  const res = await jobs.POST(req({ query: "plumber" }));
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: "Unauthorized" });
});

test("free tier 1 → 403 *_required on every web module mutation", async () => {
  seedUser("u_mod", 1, null);

  const jobs = loadRoute(JOBS_ROUTE, DEPS.jobs);
  const r1 = await jobs.POST(req({ query: "plumber" }));
  assert.equal(r1.status, 403);
  assert.deepEqual(r1.body, { error: "extractor_required" });

  const region = loadRoute(EXTRACT_REGION_ROUTE, DEPS.extractRegion);
  const r2 = await region.PATCH!(req({ region: "us" }));
  assert.equal(r2.status, 403);
  assert.deepEqual(r2.body, { error: "extractor_required" });

  const file = loadRoute(HOSTING_FILE_ROUTE, DEPS.hostingFile);
  const r3 = await file.DELETE!(req({}), PARAMS_FILE);
  assert.equal(r3.status, 403);
  assert.deepEqual(r3.body, { error: "hosting_required" });

  const consent = loadRoute(CONSENT_ROUTE, DEPS.consent);
  const r4 = await consent.POST(req({}));
  assert.equal(r4.status, 403);
  assert.deepEqual(r4.body, { error: "cyberlab_required" });
  assert.equal(consentCalls, 0, "denied user must never reach recordConsent");

  const profiles = loadRoute(BROWSER_PROFILES_ROUTE, DEPS.browserProfiles);
  const r5 = await profiles.POST(req({ name: "Free profile" }));
  assert.equal(r5.status, 403);
  assert.deepEqual(r5.body, { error: "browser_required" });

  const sessions = loadRoute(BROWSER_SESSIONS_ROUTE, DEPS.browserSessions);
  const r6 = await sessions.POST(req({ profileId: "bp_1", proxyMode: "free" }));
  assert.equal(r6.status, 403);
  assert.deepEqual(r6.body, { error: "browser_required" });
});

test("free tier 1 reads stay OPEN (the lock card must render over live data)", async () => {
  seedUser("u_mod", 1, null);

  const jobs = loadRoute(JOBS_ROUTE, DEPS.jobs);
  assert.equal((await jobs.GET!()).status, 200);

  const region = loadRoute(EXTRACT_REGION_ROUTE, DEPS.extractRegion);
  const cur = await region.GET!();
  assert.equal(cur.status, 200);
  assert.deepEqual(cur.body, { extractProxyRegion: null });

  const sessions = loadRoute(BROWSER_SESSIONS_ROUTE, DEPS.browserSessions);
  assert.equal((await sessions.GET!()).status, 200);

  const profiles = loadRoute(BROWSER_PROFILES_ROUTE, DEPS.browserProfiles);
  assert.equal((await profiles.GET!()).status, 200);
});

// ---------------------------------------------------------------------------
// THE TRUTH TABLE (middle) — tier 3: same 403s as free, device route still open.
// ---------------------------------------------------------------------------

test("tier 3 live XDevice → the SAME module 403s as free (web modules are not implied)", async () => {
  seedUser("u_mod", 3, future);

  const jobs = loadRoute(JOBS_ROUTE, DEPS.jobs);
  const r1 = await jobs.POST(req({ query: "plumber" }));
  assert.equal(r1.status, 403);
  assert.deepEqual(r1.body, { error: "extractor_required" });

  const region = loadRoute(EXTRACT_REGION_ROUTE, DEPS.extractRegion);
  const r2 = await region.PATCH!(req({ region: null }));
  assert.equal(r2.status, 403);
  assert.deepEqual(r2.body, { error: "extractor_required" });

  const file = loadRoute(HOSTING_FILE_ROUTE, DEPS.hostingFile);
  const r3 = await file.DELETE!(req({}), PARAMS_FILE);
  assert.equal(r3.status, 403);
  assert.deepEqual(r3.body, { error: "hosting_required" });

  const consent = loadRoute(CONSENT_ROUTE, DEPS.consent);
  const r4 = await consent.POST(req({}));
  assert.equal(r4.status, 403);
  assert.deepEqual(r4.body, { error: "cyberlab_required" });

  const profiles = loadRoute(BROWSER_PROFILES_ROUTE, DEPS.browserProfiles);
  const r5 = await profiles.POST(req({ name: "XDevice profile" }));
  assert.equal(r5.status, 403);
  assert.deepEqual(r5.body, { error: "browser_required" });

  const sessions = loadRoute(BROWSER_SESSIONS_ROUTE, DEPS.browserSessions);
  const r6 = await sessions.POST(req({ profileId: "bp_1", proxyMode: "free" }));
  assert.equal(r6.status, 403);
  assert.deepEqual(r6.body, { error: "browser_required" });
});

test("tier 3 live XDevice still passes a DEVICE action (positive control)", async () => {
  seedUser("u_mod", 3, future);
  const run = loadRoute(DEVICE_RUN_ROUTE, DEPS.deviceRun);
  const res = await run.POST(req({ cmd: "whoami" }), PARAMS_DEVICE);
  assert.equal(res.status, 200);
  assert.equal((res.body as { ok?: boolean }).ok, true);
  assert.equal(deviceCalls.length, 1);
});

test("expired tier-3 term → device route 403 xdevice_required (reversion runs in the gate path)", async () => {
  seedUser("u_mod", 3, past);
  const run = loadRoute(DEVICE_RUN_ROUTE, DEPS.deviceRun);
  const res = await run.POST(req({ cmd: "whoami" }), PARAMS_DEVICE);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: "xdevice_required" });
  assert.equal(deviceCalls.length, 0, "denied user must never reach runCommandNow");
});

// ---------------------------------------------------------------------------
// THE TRUTH TABLE (bottom) — tier 5 passes; grants are the purchase record.
// ---------------------------------------------------------------------------

test("tier 5 premium passes every web module mutation", async () => {
  seedUser("u_mod", 5, future);

  const jobs = loadRoute(JOBS_ROUTE, DEPS.jobs);
  const r1 = await jobs.POST(req({ query: "plumber" }));
  assert.equal(r1.status, 201);
  assert.equal((r1.body as { id?: string }).id, "job_test");

  const region = loadRoute(EXTRACT_REGION_ROUTE, DEPS.extractRegion);
  const r2 = await region.PATCH!(req({ region: null }));
  assert.equal(r2.status, 200);
  assert.deepEqual(r2.body, { extractProxyRegion: null });

  const file = loadRoute(HOSTING_FILE_ROUTE, DEPS.hostingFile);
  const r3 = await file.DELETE!(req({}), PARAMS_FILE);
  assert.equal(r3.status, 200);
  assert.deepEqual(r3.body, { ok: true, id: "fil_1" });

  const consent = loadRoute(CONSENT_ROUTE, DEPS.consent);
  const r4 = await consent.POST(req({}));
  assert.equal(r4.status, 200);
  assert.equal((r4.body as { ok?: boolean }).ok, true);
  assert.equal(consentCalls, 1, "an entitled user must actually record consent");

  const profiles = loadRoute(BROWSER_PROFILES_ROUTE, DEPS.browserProfiles);
  const r5 = await profiles.POST(req({ name: "Premium profile" }));
  assert.equal(r5.status, 201);

  // Gate first, then normal validation owns the answer: profile lookup misses
  // (fake returns null) → 404 "Profile not found", NEVER browser_required.
  const sessions = loadRoute(BROWSER_SESSIONS_ROUTE, DEPS.browserSessions);
  const r6 = await sessions.POST(req({ profileId: "bp_missing", proxyMode: "free" }));
  assert.equal(r6.status, 404);
  assert.deepEqual(r6.body, { error: "Profile not found" });
});

test("free user with a live `extractor` grant row → the extractor gate opens (the grant IS the purchase record)", async () => {
  seedUser("u_mod", 1, null);
  seedGrant("u_mod", "extractor");

  const jobs = loadRoute(JOBS_ROUTE, DEPS.jobs);
  const res = await jobs.POST(req({ query: "plumber" }));
  assert.equal(res.status, 201);
  assert.equal((res.body as { id?: string }).id, "job_test");

  // The grant covers ONLY its own key — hosting stays closed.
  const file = loadRoute(HOSTING_FILE_ROUTE, DEPS.hostingFile);
  const r2 = await file.DELETE!(req({}), PARAMS_FILE);
  assert.equal(r2.status, 403);
  assert.deepEqual(r2.body, { error: "hosting_required" });
});

test("revoked or expired grant row → the gate closes again", async () => {
  seedUser("u_mod", 1, null);
  seedGrant("u_mod", "extractor");

  store.grants[0].revokedAt = past;
  let jobs = loadRoute(JOBS_ROUTE, DEPS.jobs);
  let res = await jobs.POST(req({ query: "plumber" }));
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: "extractor_required" });

  store.grants[0].revokedAt = null;
  store.grants[0].expiresAt = past;
  jobs = loadRoute(JOBS_ROUTE, DEPS.jobs);
  res = await jobs.POST(req({ query: "plumber" }));
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: "extractor_required" });
});

test("a `devices` grant opens the DEVICE route but NOT the web modules (key, never tier)", async () => {
  seedUser("u_mod", 1, null);
  seedGrant("u_mod", "devices");

  const run = loadRoute(DEVICE_RUN_ROUTE, DEPS.deviceRun);
  const d = await run.POST(req({ cmd: "whoami" }), PARAMS_DEVICE);
  assert.equal(d.status, 200);
  assert.equal(deviceCalls.length, 1);

  const jobs = loadRoute(JOBS_ROUTE, DEPS.jobs);
  const j = await jobs.POST(req({ query: "plumber" }));
  assert.equal(j.status, 403);
  assert.deepEqual(j.body, { error: "extractor_required" });

  const profiles = loadRoute(BROWSER_PROFILES_ROUTE, DEPS.browserProfiles);
  const p = await profiles.POST(req({ name: "Nope" }));
  assert.equal(p.status, 403);
  assert.deepEqual(p.body, { error: "browser_required" });
});

// ---------------------------------------------------------------------------
// STATIC LOCKS — the SHAPE of the gate must survive refactors.
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, "..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name === "route.ts") out.push(full);
  }
  return out;
}

/** The 19 mutation handlers A2 (commit 8fec0ac) wired to moduleToolsDenied. */
const A2_GATED_ROUTES = [
  "app/api/cyberlab/consent/route.ts",
  "app/api/hosting/credentials/[id]/default/route.ts",
  "app/api/hosting/credentials/[id]/route.ts",
  "app/api/hosting/credentials/[id]/verify/route.ts",
  "app/api/hosting/domains/[id]/route.ts",
  "app/api/hosting/domains/route.ts",
  "app/api/hosting/files/[id]/route.ts",
  "app/api/hosting/links/[id]/route.ts",
  "app/api/hosting/sites/[id]/route.ts",
  "app/api/jobs/[id]/leads/delete-duplicates/route.ts",
  "app/api/jobs/[id]/leads/delete-invalid/route.ts",
  "app/api/jobs/[id]/route.ts",
  "app/api/jobs/[id]/stop/route.ts",
  "app/api/jobs/[id]/validate/route.ts",
  "app/api/jobs/merge/route.ts",
  "app/api/jobs/route.ts",
  "app/api/leads/merge/route.ts",
  "app/api/leads/upload/route.ts",
  "app/api/settings/extract-region/route.ts",
];

test("static: all 19 A2 routes still call moduleToolsDenied (a dropped gate fails here)", () => {
  assert.equal(A2_GATED_ROUTES.length, 19);
  for (const rel of A2_GATED_ROUTES) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.ok(src.includes("moduleToolsDenied("), `${rel} lost its module gate`);
  }
});

test("static: every browser mutation route is gated on the key, never a tier number", () => {
  const trees = ["app/api/browser-profiles", "app/api/browser-sessions"];
  const files = trees.flatMap((t) => walk(path.join(ROOT, t)));
  assert.equal(files.length, 8, "browser route inventory changed — update this list");

  const mutations = files.filter((f) =>
    /export (async )?function (POST|PUT|PATCH|DELETE)\b/.test(fs.readFileSync(f, "utf8")),
  );
  assert.equal(mutations.length, 7, "browser mutation inventory changed — update this list");
  for (const f of mutations) {
    const src = fs.readFileSync(f, "utf8");
    assert.ok(
      src.includes("moduleToolsDenied("),
      `${path.relative(ROOT, f)} is an ungated browser mutation`,
    );
  }
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    assert.ok(
      !src.includes("resolveUserTier"),
      `${path.relative(ROOT, f)} still reads a tier number`,
    );
    assert.ok(
      !/tier\s*<=?\s*\d/.test(src),
      `${path.relative(ROOT, f)} gates on a tier number`,
    );
  }
});

test("static: MODULE_CODES covers exactly ENTITLEMENT_KEYS; every code ends _required", () => {
  const gateSrc = fs.readFileSync(path.join(ROOT, "lib", "module-gate.ts"), "utf8");
  const entSrc = fs.readFileSync(path.join(ROOT, "lib", "entitlements.ts"), "utf8");

  const entMatch = entSrc.match(/ENTITLEMENT_KEYS\s*=\s*\[([^\]]+)\]/);
  assert.ok(entMatch, "ENTITLEMENT_KEYS literal not found");
  const entKeys = [...entMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();

  const codesMatch = gateSrc.match(/MODULE_CODES[^{]*\{([^}]+)\}/);
  assert.ok(codesMatch, "MODULE_CODES literal not found");
  const pairs = [...codesMatch[1].matchAll(/^\s*(\w+):\s*"([^"]+)"/gm)];
  const codeKeys = pairs.map((m) => m[1]).sort();
  const codes = pairs.map((m) => m[2]);

  assert.deepEqual(codeKeys, entKeys, "MODULE_CODES must have exactly one code per key");
  for (const code of codes) assert.match(code, /_required$/, `${code} must end _required`);
  assert.ok(codes.includes("browser_required"), "the browser key must map to browser_required");
  assert.ok(!gateSrc.includes("resolveUserTier"), "module-gate must never read a tier number");
});
