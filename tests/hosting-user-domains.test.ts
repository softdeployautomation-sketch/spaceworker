import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// TASK_157 Phase 4 — the ROUTE contracts for the user + admin domain routes.
//
// WHY ROUTE TESTS AND NOT ONLY MODULE TESTS. The tests above prove the pure
// rules: the two guards, and name normalization. What they cannot prove is the
// contracts between the panel and these routes — and every one of them fails
// SILENTLY: the button does nothing, or worse, it does the WRONG THING and nobody
// notices.
//
//   1. AUTH. Every handler resolves the caller from the SESSION. The id must never
//      be read from the request body, or a crafted POST adds a domain to somebody
//      else's account.
//   2. Cross-user isolation: another user's domain id must give 404, not 403.
//   3. A FAILED verify must still 201 with the row saved, because the domain WAS
//      added. Erroring here leaves users re-submitting saved domains.
//   4. The admin route must reject an unknown `userId` BEFORE insert — an admin
//      typo would otherwise create a domain owned by nobody, a row that no user
//      can ever see or delete.
//   5. `asAdmin` must be hard-coded true in the admin route, never read from user
//      input, or it is an authorization bypass.
//
// The registry is FAKED on purpose. These tests are about the routes' wiring, and
// the registry's own rules (claim-once, the UNIQUE race, the reserved /
// platform-only filters) are already proven against a real database in the
// sibling file. A fake that reimplemented those rules would be testing the fake.
// ---------------------------------------------------------------------------

(process.env as Record<string, string>).NODE_ENV = "test";
process.env.APP_BASE_URL = "https://spaceworker.test";
process.env.MAILBOX_ENCRYPTION_KEY = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");

const USER_ROUTE = "/app/api/hosting/domains/route.ts";
const ID_ROUTE = "/app/api/hosting/domains/[id]/route.ts";
const ADMIN_ROUTE = "/app/api/admin/hosting/domains/route.ts";
// TASK_157 P4b — the user chooser for "add a domain on someone's behalf".
const USERS_ROUTE = "/app/api/admin/hosting/domains/users/route.ts";

let sessionUser: { id: string } | null = { id: "user_a" };
let isAdmin = false;
/** Domain rows the fake registry hands back. */
let registryRows: Array<Record<string, unknown>> = [];
/** When set, `addUserDomain` returns this instead of succeeding. */
let addResult: Record<string, unknown> | null = null;
let listResult: Record<string, unknown> = { ok: true, value: [] };
/** Cloudflare's answer per apex; an unset apex means "not in this account". */
let zoneByApex: Record<string, unknown> = {};
let hasCredential = true;
let calls: string[] = [];
/** Existing user ids, for the admin route's owner guard (4). */
let knownUserIds: string[] = ["user_a", "user_b"];
/** TASK_157 P4b — rows the user-chooser returns, and the args it was called with. */
let knownUsers: Array<Record<string, unknown>> = [];
let userFindManyArgs: Record<string, unknown> = {};
/** Rows the fake prisma wrote. */
let prismaUpdates: Array<Record<string, unknown>> = [];

const DOMAIN_VIEW = {
  id: "d_1",
  apex: "example.com",
  label: "example.com",
  source: "byo",
  status: "pending",
  zoneId: null,
  nameservers: null,
  selectable: false,
  note: null,
  createdAt: "2026-10-03T00:00:00.000Z",
};

import {
  apexDomainOf,
  isValidDomainApex,
  normalizeDomainInput,
  normalizeZoneStatus,
} from "../lib/hosting/domains";
import {
  PLATFORM_ONLY_ZONES,
  RESERVED_ZONES,
  assertZoneUserSelectable,
  assertZoneWritable,
  isPlatformOnlyZone,
  isReservedZone,
} from "../lib/hosting/workers";

// ---------------------------------------------------------------------------
// TASK_157 Phase 4 — the owner's rule (2026-10-03):
//
//   "i don't want users too be able to pick instaweb or mainaccess..
//    i don't want to use mainaccess at all..
//    the platform domains are only selectable by admin,
//    users can only select the domain they own or added"
//
// The tests below pin BOTH halves of that, because they are enforced by two
// DIFFERENT guards and conflating them is the obvious mistake:
//
//   assertZoneWritable        = a WRITE guard. mainaccess.top is here: nobody may
//                               ever write there, because the owner retired it.
//   assertZoneUserSelectable  = a SELECTION guard. instaweb.top is here: we may
//                               publish on it ourselves, a user may not pick it.
//
// A platform-only zone that is NOT reserved is the case that proves the two are
// genuinely separate: instaweb.top must fail selection while still passing writes,
// otherwise "users can't pick it" would have silently retired it.
// ---------------------------------------------------------------------------

test("mainaccess.top is retired: refused for writes AND for user selection", () => {
  assert.ok(RESERVED_ZONES.includes("mainaccess.top"));
  assert.equal(isReservedZone("mainaccess.top"), true);
  assert.equal(assertZoneWritable("mainaccess.top").ok, false);
  // Also refused under a subdomain, because the publish path works on HOSTS.
  assert.equal(isReservedZone("go.mainaccess.top"), true);
  assert.equal(assertZoneUserSelectable("mainaccess.top").ok, false);
});

test("instaweb.top is platform-only: NOT selectable by a user, but still writable by us", () => {
  assert.ok(PLATFORM_ONLY_ZONES.includes("instaweb.top"));
  // The user's instruction: "i dont want users too be able to pick instaweb".
  assert.equal(isPlatformOnlyZone("instaweb.top"), true);
  assert.equal(assertZoneUserSelectable("instaweb.top").ok, false);
  assert.equal(assertZoneUserSelectable("go.instaweb.top").ok, false);
  // NOT retired: the platform still publishes on it, which is the whole reason
  // this list exists separately from RESERVED_ZONES.
  assert.equal(isReservedZone("instaweb.top"), false);
  assert.equal(assertZoneWritable("go.instaweb.top").ok, true);
});

test("broks.beauty stays a hard write guard", () => {
  assert.equal(isReservedZone("broks.beauty"), true);
  assert.equal(assertZoneWritable("go.broks.beauty").ok, false);
  assert.equal(assertZoneUserSelectable("broks.beauty").ok, false);
});

test("assertZoneUserSelectable FAILS CLOSED on junk", () => {
  // A guard that fails open on an unexpected shape is worse than no guard.
  assert.equal(assertZoneUserSelectable("").ok, false);
  assert.equal(assertZoneUserSelectable("   ").ok, false);
  assert.equal(assertZoneUserSelectable("localhost").ok, false);
  assert.equal(assertZoneUserSelectable(null).ok, false);
  assert.equal(assertZoneUserSelectable(undefined).ok, false);
});

test("a user's own domain passes the selection guard", () => {
  assert.equal(assertZoneUserSelectable("example.com").ok, true);
  assert.equal(assertZoneUserSelectable("go.example.com").ok, true);
  // Case is normalised, so a user typing "MAINACCESS.TOP" cannot slip past.
  assert.equal(assertZoneUserSelectable("MainAccess.TOP").ok, false);
  assert.equal(assertZoneUserSelectable("INSTAWEB.top").ok, false);
});

// --- accepting a domain "the way cloudflare would accept" --------------------
//
// The owner: "build it for now in a way users can add domain just the way
// cloudflare would accept since that works". So the rule is to agree with
// Cloudflare rather than invent a stricter list of our own.

test("normalizeDomainInput reduces a pasted host/URL to its bare apex", () => {
  assert.equal(normalizeDomainInput("example.com"), "example.com");
  assert.equal(normalizeDomainInput("  Example.COM  "), "example.com");
  assert.equal(normalizeDomainInput("https://www.example.com/path"), "example.com");
  assert.equal(normalizeDomainInput("example.com."), "example.com");
  // "www" is not a separate registration -- a user should not have to care.
  assert.equal(normalizeDomainInput("www.shop.example.com"), "example.com");
  assert.equal(normalizeDomainInput("go.instaweb.top"), "instaweb.top");
});

test("normalizeDomainInput handles the common multi-part suffixes", () => {
  // Without this, "example.co.uk" would reduce to "co.uk" and silently claim the
  // WRONG apex -- so two unrelated customers would collide on one row.
  assert.equal(normalizeDomainInput("example.co.uk"), "example.co.uk");
  assert.equal(normalizeDomainInput("shop.example.com.au"), "example.com.au");
  assert.equal(normalizeDomainInput("example.co.jp"), "example.co.jp");
  // An unlisted two-part TLD is not special-cased: Cloudflare is the authority.
  assert.equal(normalizeDomainInput("example.zz"), "example.zz");
});

test("normalizeDomainInput refuses what Cloudflare would refuse", () => {
  assert.equal(normalizeDomainInput(""), null);
  assert.equal(normalizeDomainInput(null), null);
  assert.equal(normalizeDomainInput("localhost"), null);        // not a domain
  assert.equal(normalizeDomainInput("my_domain.com"), null);    // underscore
  assert.equal(normalizeDomainInput("-bad.com"), null);          // leading dash
  assert.equal(normalizeDomainInput("bad-.com"), null);          // trailing dash
  assert.equal(normalizeDomainInput("192.168.0.1"), null);      // an IP
  assert.equal(normalizeDomainInput("exa mple.com"), null);     // a space
  assert.equal(normalizeDomainInput(`${"a".repeat(64)}.com`), null); // label >63
});

test("isValidDomainApex requires a real alphabetic TLD", () => {
  assert.equal(isValidDomainApex("example.com"), true);
  assert.equal(isValidDomainApex("example.co.uk"), true);
  // A numeric final label means an IP address, not a domain.
  assert.equal(isValidDomainApex("1.2.3.4"), false);
  assert.equal(isValidDomainApex("example.123"), false);
  // A single label is not a zone apex.
  assert.equal(isValidDomainApex("localhost"), false);
  assert.equal(isValidDomainApex(""), false);
  // NOT a TLD registry check: "a.b" has two labels and an alphabetic last label, so
  // it passes here and is settled by Cloudflare's own answer. Being more permissive
  // than Cloudflare is safe (the write still fails closed); being stricter would
  // reject domains a user legitimately owns.
  assert.equal(isValidDomainApex("a.b"), true);
});

test("normalizeZoneStatus collapses Cloudflare's open-ended status enum", () => {
  // Cloudflare reports more statuses than we store, and the schema CHECK refuses
  // anything outside our three. Storing its raw string verbatim would make every
  // reconcile of an "initializing" zone FAIL its write — so the zone would never
  // update again and the domain would silently never become publishable.
  assert.equal(normalizeZoneStatus("active"), "active");
  assert.equal(normalizeZoneStatus("pending"), "pending");
  assert.equal(normalizeZoneStatus("initializing"), "pending");
  assert.equal(normalizeZoneStatus("moved"), "pending");
  assert.equal(normalizeZoneStatus("deleted"), "pending");
});

test("normalizeZoneStatus never treats an unknown status as publishable", () => {
  // The dangerous direction. An unrecognised status must fail CLOSED: reporting a
  // domain as usable when Cloudflare has not said it is would send a user's traffic
  // at a host that cannot serve it. Case matters too — "ACTIVE" is not Cloudflare's
  // spelling, so treating it as active would be trusting the wrong string.
  assert.equal(normalizeZoneStatus("unknown"), "pending");
  assert.equal(normalizeZoneStatus("ACTIVE"), "pending");
  assert.equal(normalizeZoneStatus(""), "pending");
  assert.equal(normalizeZoneStatus(null), "pending");
  assert.equal(normalizeZoneStatus(undefined), "pending");
  // A status Cloudflare might add tomorrow: still not "active".
  assert.equal(normalizeZoneStatus("degraded"), "pending");
});

test("apexDomainOf keeps bare labels null", () => {
  assert.equal(apexDomainOf("localhost"), null);
  assert.equal(apexDomainOf("example.com"), "example.com");
});

const fakeRegistry = {
  listUserDomains: async (userId: string) => {
    calls.push("list:" + userId);
    return listResult;
  },
  listAllDomains: async () => {
    calls.push("listAll");
    return { ok: true, value: registryRows };
  },
  addUserDomain: async (userId: string, input: string) => {
    calls.push(`add:${userId}:${input}`);
    if (addResult) return addResult;
    return { ok: true, value: DOMAIN_VIEW };
  },
  recordDomainZoneState: async (userId: string, apex: string, state: Record<string, unknown>) => {
    calls.push(`record:${userId}:${apex}:${state.status}`);
    return { ok: true, value: { ...DOMAIN_VIEW, ...state, selectable: state.status === "active" } };
  },
  reconcileUserDomain: async (
    userId: string,
    id: string,
    readZone: (apex: string) => Promise<
      { ok: true; zoneId: string; status: string; nameservers: string[] } | { ok: false; message: string }
    >
  ) => {
    calls.push(`reconcile:${userId}:${id}`);
    // Mirrors the REAL ownership rule (owner pair checked on the row) so the
    // isolation assertions below test the route rather than the fake's politeness.
    const row = registryRows.find((r) => r.id === id);
    if (!row || row.ownerKind !== "user" || row.ownerUserId !== userId) {
      return { ok: false, status: 404, code: "not_found", message: "That domain was not found." };
    }
    const seen = await readZone(String(row.apex));
    if (!seen.ok) return { ok: true, value: { ...row, note: seen.message } };
    return {
      ok: true,
      value: { ...row, zoneId: seen.zoneId, status: seen.status, nameservers: seen.nameservers, note: null },
    };
  },
  refreshUserDomainsFromCloudflare: async (userId: string) => {
    calls.push("refreshAll:" + userId);
    return { ok: true, value: registryRows };
  },
  removeUserDomain: async (userId: string, id: string, opts: Record<string, unknown> = {}) => {
    calls.push(`remove:${userId}:${id}:${String(opts.asAdmin)}`);
    // Mirrors the REAL ownership rule, so cross-user isolation is genuinely tested
    // rather than assumed. A platform row carries a NULL user id, so it fails the
    // very same `ownerUserId === userId` comparison an outsider's row does.
    const row = registryRows.find((r) => r.id === id);
    if (!row) return { ok: false, status: 404, code: "not_found", message: "That domain was not found." };
    const mine = row.ownerKind === "user" && row.ownerUserId === userId;
    if (!opts.asAdmin && !mine) {
      return { ok: false, status: 404, code: "not_found", message: "That domain was not found." };
    }
    return { ok: true, value: { id } };
  },
};

const fakePrisma = {
  user: {
    findUnique: async ({ where }: { where: { id: string } }) =>
      knownUserIds.includes(where.id) ? { id: where.id } : null,
    /**
     * TASK_157 P4b — the user chooser (`.../domains/users`). Records the args so a
     * test can prove the route BOUNDS what it returns instead of trusting the caller's
     * `limit`; an unbounded chooser endpoint is an account-dump primitive.
     */
    findMany: async (args: Record<string, unknown>) => {
      userFindManyArgs = args;
      return knownUsers.slice(0, Number((args.take as number) ?? knownUsers.length));
    },
  },
  userDomain: {
    update: async ({ data }: { data: Record<string, unknown> }) => {
      prismaUpdates.push(data);
      return { id: "d_1", ...data };
    },
  },
};

const fakeCredentials = {
  getDefaultHostingCredential: async (userId: string) => {
    calls.push("cred:" + userId);
    return hasCredential
      ? { id: "c_1", accountId: "acct_1", token: "SECRET", workerToken: "SECRET2" }
      : null;
  },
};

const fakeWorkers = {
  getZoneByName: async (_cred: unknown, apex: string) => {
    calls.push("zone:" + apex);
    return zoneByApex[apex] ?? { ok: true, status: 200, value: null };
  },
};

/**
 * TASK_158 W1 — the platform provisioner. Faked for the same reason the registry
 * is: these tests are about the ROUTE's wiring (when it reaches for the platform
 * token, and what it does with each answer), not about Cloudflare.
 */
let provisionResult: Record<string, unknown> = {
  ok: false,
  zoneId: null,
  status: "pending",
  nameservers: null,
  note: "This domain isn't in the Cloudflare account we publish to yet.",
};

const fakeZoneProvision = {
  MANUAL_ZONE_NOTE: "This domain isn't in the Cloudflare account we publish to yet.",
  provisionDomainZone: async (userId: string, apex: string) => {
    calls.push(`provision:${userId}:${apex}`);
    return provisionResult;
  },
};

/** A minimal NextResponse stand-in: these routes only return .json(...) bodies. */
const fakeNextResponse = {
  json: (data: unknown, init?: { status?: number }) => ({
    status: init?.status ?? 200,
    json: async () => data,
  }),
};

const loader = Module as unknown as { _load: (r: string, p: NodeModule | undefined, m: boolean) => unknown };
const originalLoad = loader._load;
loader._load = function patched(request, parent, isMain) {
  const from = parent?.filename ?? "";
  if (
    from.endsWith(USER_ROUTE) ||
    from.endsWith(ID_ROUTE) ||
    from.endsWith(ADMIN_ROUTE) ||
    from.endsWith(USERS_ROUTE)
  ) {
    if (request === "next/server") return { NextResponse: fakeNextResponse };
    if (request === "@/lib/session-user") return { getCurrentUser: async () => sessionUser };
    if (request === "@/lib/admin-auth") return { requireAdminSession: async () => isAdmin };
    if (request === "@/lib/prisma") return { prisma: fakePrisma };
    // TASK_184 A2 — this suite is about DOMAIN OWNERSHIP, not entitlements:
    // the module gate is stubbed open (A4 adds dedicated entitled/denied tests).
    if (request === "@/lib/module-gate") return { moduleToolsDenied: async () => null };
    if (request === "@/lib/hosting/domain-registry") return fakeRegistry;
    if (request === "@/lib/hosting/credentials") return fakeCredentials;
    if (request === "@/lib/hosting/workers") return fakeWorkers;
    if (request === "@/lib/hosting/zone-provision") return fakeZoneProvision;
  }
  return originalLoad.call(this, request, parent, isMain);
};

/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * The response bodies these tests assert on — narrow, and NOT `any`, matching the
 * way the sibling admin-route test types its payloads.
 */
interface DomainBody {
  domain?: Record<string, unknown>;
  domains?: Array<Record<string, unknown>>;
  verified?: boolean;
  verifyNote?: string | null;
  error?: string;
  code?: string;
  ok?: boolean;
  id?: string;
}
type Res = { status: number; json: () => Promise<unknown> };
/** Read and type a fake response body. */
async function readBody(res: Res): Promise<DomainBody> {
  return (await res.json()) as DomainBody;
}
const userRoute = require("../app/api/hosting/domains/route") as {
  GET: () => Promise<Res>;
  POST: (req: Request) => Promise<Res>;
};
const idRoute = require("../app/api/hosting/domains/[id]/route") as {
  DELETE: (req: Request, c: { params: Promise<{ id: string }> }) => Promise<Res>;
  POST: (req: Request, c: { params: Promise<{ id: string }> }) => Promise<Res>;
};
const adminRoute = require("../app/api/admin/hosting/domains/route") as {
  GET: () => Promise<Res>;
  POST: (req: Request) => Promise<Res>;
  DELETE: (req: Request) => Promise<Res>;
};
/* TASK_157 P4b — the user chooser. */
const usersRoute = require("../app/api/admin/hosting/domains/users/route") as {
  GET: (req: Request) => Promise<Res>;
};
/* eslint-enable @typescript-eslint/no-require-imports */

const BASE = "https://spaceworker.test/api/hosting/domains";
const ADMIN_BASE = "https://spaceworker.test/api/admin/hosting/domains";

function jsonReq(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** The [id] handlers take `params` as a PROMISE (async in Next.js 16). */
function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  sessionUser = { id: "user_a" };
  isAdmin = false;
  registryRows = [{ ...DOMAIN_VIEW, id: "d_1", ownerKind: "user", ownerUserId: "user_a" }];
  addResult = null;
  listResult = { ok: true, value: registryRows };
  zoneByApex = {};
  hasCredential = true;
  calls = [];
  knownUserIds = ["user_a", "user_b"];
  prismaUpdates = [];
  knownUsers = [
    { id: "user_a", email: "ada@sw.dev", tier: "PREMIUM" },
    { id: "user_b", email: "bob@sw.dev", tier: "FREE" },
  ];
  userFindManyArgs = {};
  provisionResult = {
    ok: false,
    zoneId: null,
    status: "pending",
    nameservers: null,
    note: "This domain isn't in the Cloudflare account we publish to yet.",
  };
});

// ---------------------------------------------------------------------------
// TASK_157 P4b — the user chooser behind "add a domain for a user".
//
// Two things can go wrong here and BOTH are silent: the panel shows a stale list,
// or it leaks. The first is cosmetic; the second hands any admin-session bug a
// complete user export. So the tests pin the two halves: admins only, and always
// bounded — the route must clamp `limit` itself rather than trusting the query
// string, because that value arrives from a text input.
// ---------------------------------------------------------------------------
// Mirrors MAX_LIMIT in the route. Kept as a literal rather than imported so the test
// fails if someone raises the cap without thinking about the dump surface.
const CHOOSER_MAX_LIMIT = 200;
const USERS_BASE = "https://spaceworker.test/api/admin/hosting/domains/users";
interface UsersBody {
  users?: Array<{ id?: string; email?: string; tier?: string }>;
}

test("user chooser refuses a non-admin", async () => {
  isAdmin = false;
  const res = await usersRoute.GET(new Request(`${USERS_BASE}?q=ada`));
  assert.equal(res.status, 403);
});

test("user chooser refuses an anonymous caller", async () => {
  sessionUser = null;
  isAdmin = false;
  const res = await usersRoute.GET(new Request(`${USERS_BASE}?q=ada`));
  assert.equal(res.status, 403);
  // And it must not have reached the database to decide that.
  assert.equal(Object.keys(userFindManyArgs).length, 0);
});

test("user chooser returns the owner candidates for an admin", async () => {
  isAdmin = true;
  const res = await usersRoute.GET(new Request(`${USERS_BASE}?q=ada`));
  assert.equal(res.status, 200);
  const body = (await res.json()) as UsersBody;
  assert.equal(body.users?.length, 2);
  assert.equal(body.users?.[0].email, "ada@sw.dev");
});

test("user chooser clamps a caller-supplied limit instead of obeying it", async () => {
  isAdmin = true;
  const res = await usersRoute.GET(new Request(`${USERS_BASE}?q=ada&limit=100000`));
  assert.equal(res.status, 200);
  const take = userFindManyArgs.take as number;
  assert.ok(take > 0, "take must be positive");
  assert.equal(take, CHOOSER_MAX_LIMIT, "a huge limit must clamp to the cap");
});

test("user chooser rejects a nonsense limit rather than defaulting to unbounded", async () => {
  isAdmin = true;
  const res = await usersRoute.GET(new Request(`${USERS_BASE}?q=ada&limit=abc`));
  assert.equal(res.status, 200);
  const take = userFindManyArgs.take as number;
  assert.ok(take > 0 && take <= CHOOSER_MAX_LIMIT, `take must stay in range, got ${take}`);
});

test("user chooser never returns a password hash or token field", async () => {
  isAdmin = true;
  // The fake stands in for the DB and would hand back whatever the route selects.
  // So the assertion is about the SELECT: the route must project explicit columns,
  // not `include` the whole row. This is the assertion that would have caught a
  // `findMany({ where })` with no `select`.
  await usersRoute.GET(new Request(`${USERS_BASE}?q=ada`));
  const select = userFindManyArgs.select as Record<string, boolean>;
  assert.ok(select, "the route must pass an explicit `select`");
  for (const leaked of ["passwordHash", "password", "token", "sessionToken"]) {
    assert.equal(select[leaked], undefined, `must not select ${leaked}`);
  }
  assert.equal(select.id, true);
  assert.equal(select.email, true);
});

// --- auth ------------------------------------------------------------------

test("user route: every handler refuses an anonymous caller", async () => {
  sessionUser = null;

  assert.equal((await userRoute.GET()).status, 401);
  assert.equal((await userRoute.POST(jsonReq(BASE, "POST", { domain: "example.com" }))).status, 401);
  assert.equal((await idRoute.DELETE(jsonReq(`${BASE}/d_1`, "DELETE"), ctx("d_1"))).status, 401);
  assert.equal((await idRoute.POST(jsonReq(`${BASE}/d_1`, "POST"), ctx("d_1"))).status, 401);

  // Nothing may have reached the registry — the refusal has to happen BEFORE any
  // work, not after it.
  assert.deepEqual(calls, []);
});

test("admin route: every handler refuses a non-admin", async () => {
  isAdmin = false;

  assert.equal((await adminRoute.GET()).status, 403);
  assert.equal(
    (await adminRoute.POST(jsonReq(ADMIN_BASE, "POST", { domain: "x.com", userId: "user_b" }))).status,
    403
  );
  assert.equal((await adminRoute.DELETE(jsonReq(`${ADMIN_BASE}?id=d_1`, "DELETE"))).status, 403);

  assert.deepEqual(calls, []);
});

// --- the ownership rule ----------------------------------------------------

test("user route: the owner id comes from the SESSION, never the body", async () => {
  sessionUser = { id: "user_a" };

  // A crafted body trying to add a domain to somebody else's account.
  await userRoute.POST(
    jsonReq(BASE, "POST", { domain: "evil.com", userId: "user_b", ownerUserId: "user_b", apex: "evil.com" })
  );

  const add = calls.find((c) => c.startsWith("add:"));
  assert.ok(add, "the add must have been attempted");
  assert.equal(add, "add:user_a:evil.com");
  assert.ok(
    !calls.some((c) => c.includes("user_b")),
    "no call may reference the body's user id"
  );
});

test("user route: GET scopes the list to the session user", async () => {
  sessionUser = { id: "user_a" };

  const res = await userRoute.GET();
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ["list:user_a"]);
});

test("user route: DELETE of another user's domain is 404, not 403", async () => {
  // 403 would LEAK that the domain exists: a caller could enumerate ids and learn
  // which are real. 404 for both "no such row" and "not yours" is the point.
  sessionUser = { id: "user_a" };
  registryRows = [{ ...DOMAIN_VIEW, id: "d_9", ownerKind: "user", ownerUserId: "user_b" }];

  const res = await idRoute.DELETE(jsonReq(`${BASE}/d_9`, "DELETE"), ctx("d_9"));
  assert.equal(res.status, 404);

  // An id that does not exist gives the SAME answer, so the two are
  // indistinguishable from outside.
  const missing = await idRoute.DELETE(jsonReq(`${BASE}/nope`, "DELETE"), ctx("nope"));
  assert.equal(missing.status, 404);
  assert.equal((await readBody(missing)).code, (await readBody(res)).code);
});

test("user route: a platform domain is not removable by a user", async () => {
  // ownerKind "platform" with a NULL user id — the shape the platform's own zones
  // have. It must fail the same check an outsider's row does.
  sessionUser = { id: "user_a" };
  registryRows = [{ ...DOMAIN_VIEW, id: "d_p", ownerKind: "platform", ownerUserId: null }];

  assert.equal((await idRoute.DELETE(jsonReq(`${BASE}/d_p`, "DELETE"), ctx("d_p"))).status, 404);
});
// --- verify reconciles exactly ONE row, exactly ONCE -------------------------

test("id route: verify checks exactly ONE zone, not the whole list", async () => {
  // Regression guard. This endpoint used to call refreshUserDomainsFromCloudflare,
  // which reconciles every domain the user owns — so pressing "check status" on one
  // row cost one rate-limited /zones call per domain, growing without bound.
  registryRows = [
    { ...DOMAIN_VIEW, id: "d_1", apex: "example.com", ownerKind: "user", ownerUserId: "user_a" },
    { ...DOMAIN_VIEW, id: "d_2", apex: "other.com", ownerKind: "user", ownerUserId: "user_a" },
    { ...DOMAIN_VIEW, id: "d_3", apex: "third.com", ownerKind: "user", ownerUserId: "user_a" },
  ];
  const active = (zoneId: string, name: string) => ({
    ok: true, status: 200, value: { zoneId, name, status: "active", nameservers: [] },
  });
  zoneByApex = { "example.com": active("z_1", "example.com"), "other.com": active("z_2", "other.com"), "third.com": active("z_3", "third.com") };

  const res = await idRoute.POST(jsonReq(`${BASE}/d_1`, "POST"), ctx("d_1"));
  assert.equal(res.status, 200);

  assert.deepEqual(
    calls.filter((c) => c.startsWith("zone:")),
    ["zone:example.com"],
    "one lookup, for the apex of the row being verified"
  );
  assert.ok(!calls.some((c) => c.startsWith("refreshAll")), "must not reconcile the whole list");
});

test("id route: verify probes the STORED apex, never one supplied by the caller", async () => {
  // The id is only ever used to select a row we already own, so there is no
  // request-controlled input that could redirect the lookup at somebody else's domain.
  registryRows = [{ ...DOMAIN_VIEW, id: "d_1", apex: "example.com", ownerKind: "user", ownerUserId: "user_a" }];
  zoneByApex = { "example.com": { ok: true, status: 200, value: { zoneId: "z_1", name: "example.com", status: "active", nameservers: [] } } };

  await idRoute.POST(jsonReq(`${BASE}/d_1`, "POST", { domain: "victim.com", apex: "victim.com" }), ctx("d_1"));
  assert.ok(!calls.some((c) => c.includes("victim.com")), "the body must not steer the lookup");
});

test("id route: verify of another user's domain is 404 and makes NO Cloudflare call", async () => {
  registryRows = [{ ...DOMAIN_VIEW, id: "d_theirs", apex: "theirs.com", ownerKind: "user", ownerUserId: "user_b" }];
  zoneByApex = { "theirs.com": { ok: true, status: 200, value: { zoneId: "z", name: "theirs.com", status: "active", nameservers: [] } } };

  const theirsUrl = BASE + "/d_theirs";
  const res = await idRoute.POST(jsonReq(theirsUrl, "POST"), ctx("d_theirs"));
  assert.equal(res.status, 404);
  assert.equal(calls.filter((c) => c.startsWith("zone:")).length, 0, "a foreign row must not be probed");
  // Indistinguishable from a row that does not exist at all.
  const missing = await idRoute.POST(jsonReq(`${BASE}/nope`, "POST"), ctx("nope"));
  assert.equal(missing.status, 404);
  assert.equal((await readBody(missing)).code, (await readBody(res)).code);
});

test("id route: verify of a PLATFORM domain is 404 too", async () => {
  registryRows = [{ ...DOMAIN_VIEW, id: "d_p", apex: "instaweb.top", ownerKind: "platform", ownerUserId: null }];
  const res = await idRoute.POST(jsonReq(`${BASE}/d_p`, "POST"), ctx("d_p"));
  assert.equal(res.status, 404);
  assert.equal(calls.filter((c) => c.startsWith("zone:")).length, 0);
});

test("id route: verify keeps the row when Cloudflare cannot see the zone yet", async () => {
  // Not a failure: the user added the domain and it is theirs, and a transient
  // lookup failure must not make the row disappear from their list.
  registryRows = [{ ...DOMAIN_VIEW, id: "d_1", apex: "example.com", status: "pending", selectable: false, ownerKind: "user", ownerUserId: "user_a" }];
  zoneByApex = {}; // Cloudflare has no zone for it

  const res = await idRoute.POST(jsonReq(`${BASE}/d_1`, "POST"), ctx("d_1"));
  assert.equal(res.status, 200);

  const payload = await readBody(res);
  assert.equal(payload.domain?.id, "d_1", "the row is still there");
  assert.equal(payload.domain?.selectable, false, "and still not publishable");
  assert.match(String(payload.domain?.note ?? ""), /Not in this Cloudflare account/);
});

test("id route: verify never promotes a PENDING zone to selectable", async () => {
  // The most damaging way this endpoint could be wrong: telling the user a domain is
  // ready when Cloudflare still has it pending, so they publish onto a host that
  // cannot serve traffic.
  registryRows = [{ ...DOMAIN_VIEW, id: "d_1", apex: "example.com", status: "pending", selectable: false, ownerKind: "user", ownerUserId: "user_a" }];
  zoneByApex = {
    "example.com": {
      ok: true, status: 200,
      value: { zoneId: "z_1", name: "example.com", status: "pending", nameservers: ["a.ns.cloudflare.com"] },
    },
  };

  const res = await idRoute.POST(jsonReq(`${BASE}/d_1`, "POST"), ctx("d_1"));
  const payload = await readBody(res);
  assert.equal(res.status, 200);
  assert.equal(payload.domain?.status, "pending");
  assert.equal(payload.domain?.selectable, false, "a pending zone is never selectable");
  // The nameservers must survive the round trip — they are the user's only way out.
  assert.deepEqual(payload.domain?.nameservers, ["a.ns.cloudflare.com"]);
});

test("id route: verify returns one domain, not the whole list", async () => {
  // Returning the full list here would let the verify button quietly replace one
  // row's data with another's.
  registryRows = [{ ...DOMAIN_VIEW, id: "d_1", apex: "example.com", ownerKind: "user", ownerUserId: "user_a" }];
  zoneByApex = { "example.com": { ok: true, status: 200, value: { zoneId: "z_1", name: "example.com", status: "active", nameservers: [] } } };

  const payload = await readBody(await idRoute.POST(jsonReq(`${BASE}/d_1`, "POST"), ctx("d_1")));
  assert.deepEqual(Object.keys(payload), ["domain"]);
  assert.equal(payload.domain?.id, "d_1");
});

test("id route: verify without a connected Cloudflare account is a clear 400", async () => {
  hasCredential = false;
  const res = await idRoute.POST(jsonReq(`${BASE}/d_1`, "POST"), ctx("d_1"));
  assert.equal(res.status, 400);
  assert.equal((await readBody(res)).code, "no_credential");
  assert.equal(calls.some((c) => c.startsWith("zone:")), false);
});

// --- verify is best-effort, and never fabricates readiness -------------------

test("user route: a failed Cloudflare verify still 201s — the domain WAS added", async () => {
  // No credential connected yet. The row exists and the user owns it; failing the
  // whole request would make them re-submit a domain that is already saved.
  hasCredential = false;

  const res = await userRoute.POST(jsonReq(BASE, "POST", { domain: "example.com" }));
  assert.equal(res.status, 201);

  const payload = await readBody(res);
  assert.equal(payload.verified, false);
  assert.equal(payload.domain?.apex, "example.com");
  assert.match(String(payload.verifyNote ?? ""), /Cloudflare/i);
  // TASK_158 W1 — with no BYO account the route must still TRY the platform
  // provisioner. The old code returned here, which is exactly why a user with no
  // Cloudflare account could never get a domain set up for them.
  assert.ok(calls.some((c) => c.startsWith("provision:user_a:")), "the platform provisioner must be reached");
});

test("user route: a domain not yet in the user's Cloudflare is PROVISIONED on the platform", async () => {
  hasCredential = true;
  zoneByApex = { "example.com": { ok: true, status: 200, value: null } };
  // The platform created it and Cloudflare assigned these nameservers — the whole
  // point of the Zones token. The user now has something actionable to paste at
  // their registrar instead of a dead end.
  provisionResult = {
    ok: true,
    zoneId: "z_9",
    status: "pending",
    nameservers: ["a.ns.cloudflare.com", "b.ns.cloudflare.com"],
    note: "Set the nameservers below at your registrar to finish.",
  };
  // The re-read must see the row the provisioner just recorded.
  listResult = {
    ok: true,
    value: [
      {
        ...DOMAIN_VIEW,
        zoneId: "z_9",
        nameservers: ["a.ns.cloudflare.com", "b.ns.cloudflare.com"],
        status: "pending",
      },
    ],
  };

  const res = await userRoute.POST(jsonReq(BASE, "POST", { domain: "example.com" }));
  assert.equal(res.status, 201);
  const payload = await readBody(res);
  assert.equal(payload.verified, false, "a pending zone is not 'ready'");
  assert.equal(payload.domain?.zoneId, "z_9");
  assert.deepEqual(payload.domain?.nameservers, ["a.ns.cloudflare.com", "b.ns.cloudflare.com"]);
  assert.ok(calls.includes("provision:user_a:example.com"));
});

test("user route: a zone already in the USER's account is recorded there, never re-provisioned", async () => {
  hasCredential = true;
  zoneByApex = {
    "example.com": {
      ok: true,
      status: 200,
      value: { zoneId: "z_1", name: "example.com", status: "pending", nameservers: ["x.ns.cloudflare.com"] },
    },
  };

  const res = await userRoute.POST(jsonReq(BASE, "POST", { domain: "example.com" }));
  assert.equal(res.status, 201);
  // The user's own account is authoritative — reaching for our token here would
  // either duplicate the zone or report OUR account's state as theirs.
  assert.ok(calls.some((c) => c.startsWith("record:")), "the user's own zone must be recorded");
  assert.equal(calls.some((c) => c.startsWith("provision:")), false, "no platform write for a user-owned zone");
});

test("user route: an active zone marks the domain selectable", async () => {
  hasCredential = true;
  zoneByApex = {
    "example.com": {
      ok: true,
      status: 200,
      value: {
        zoneId: "z_1",
        name: "example.com",
        status: "active",
        nameservers: ["a.ns.cloudflare.com", "b.ns.cloudflare.com"],
      },
    },
  };

  const res = await userRoute.POST(jsonReq(BASE, "POST", { domain: "example.com" }));
  assert.equal(res.status, 201);
  const payload = await readBody(res);
  assert.equal(payload.verified, true);
  assert.equal(payload.domain?.selectable, true);
});

test("user route: a PENDING zone is recorded but NOT selectable", async () => {
  // The dangerous case. Cloudflare reports a zone as present while nameservers are
  // still propagating; treating "found" as "ready" would let a user publish onto a
  // host that cannot serve traffic.
  hasCredential = true;
  zoneByApex = {
    "example.com": {
      ok: true,
      status: 200,
      value: {
        zoneId: "z_1",
        name: "example.com",
        status: "pending",
        nameservers: ["a.ns.cloudflare.com", "b.ns.cloudflare.com"],
      },
    },
  };

  const res = await userRoute.POST(jsonReq(BASE, "POST", { domain: "example.com" }));
  const payload = await readBody(res);
  assert.equal(payload.verified, false);
  assert.equal(payload.domain?.selectable, false);
  // The nameservers MUST still come back — they are the only thing the user can act
  // on to escape the pending state.
  assert.deepEqual(payload.domain?.nameservers, ["a.ns.cloudflare.com", "b.ns.cloudflare.com"]);
});

test("user route: adding one domain checks exactly ONE zone", async () => {
  // Regression guard. An earlier build called refreshUserDomainsFromCloudflare,
  // which reconciles the user's WHOLE list — so adding one domain fired one /zones
  // call per domain they own. N+1 against a rate-limited API.
  hasCredential = true;
  zoneByApex = {
    "example.com": {
      ok: true,
      status: 200,
      value: { zoneId: "z_1", name: "example.com", status: "active", nameservers: [] },
    },
    "other.com": {
      ok: true,
      status: 200,
      value: { zoneId: "z_2", name: "other.com", status: "active", nameservers: [] },
    },
  };

  await userRoute.POST(jsonReq(BASE, "POST", { domain: "example.com" }));

  assert.deepEqual(calls.filter((c) => c.startsWith("zone:")), ["zone:example.com"]);
  assert.ok(!calls.some((c) => c.startsWith("refreshAll")), "must not reconcile the whole list");
});

test("user route: no response body ever contains a credential token", async () => {
  // The fake hands back literal "SECRET" tokens. The route decrypts one to call
  // Cloudflare and must not echo any of it back.
  hasCredential = true;
  zoneByApex = {
    "example.com": {
      ok: true,
      status: 200,
      value: { zoneId: "z_1", name: "example.com", status: "active", nameservers: [] },
    },
  };

  const res = await userRoute.POST(jsonReq(BASE, "POST", { domain: "example.com" }));
  const raw = JSON.stringify(await res.json());
  assert.ok(!raw.includes("SECRET"), "response leaked a credential token");
});

test("user route: a registry refusal passes its status and code through", async () => {
  // e.g. re-adding a domain already held, or trying a reserved one. The route must
  // not flatten these into a generic 500 — the panel keys off the code.
  addResult = { ok: false, status: 409, code: "domain_exists", message: "You have already added that domain." };

  const res = await userRoute.POST(jsonReq(BASE, "POST", { domain: "example.com" }));
  assert.equal(res.status, 409);
  assert.equal((await readBody(res)).code, "domain_exists");
});

// --- admin route -----------------------------------------------------------

test("admin route: refuses to attribute a domain to a user that does not exist", async () => {
  // An admin typo must fail loudly. Inserting anyway would create a row owned by a
  // non-existent id — invisible to every user and undeletable by anyone, because
  // the ownership filter needs a matching ownerUserId.
  isAdmin = true;
  knownUserIds = ["user_a"];

  const res = await adminRoute.POST(
    jsonReq(ADMIN_BASE, "POST", { domain: "example.com", userId: "user_ghost" })
  );
  assert.equal(res.status, 400);
  assert.equal((await readBody(res)).code, "unknown_user");
  assert.ok(!calls.some((c) => c.startsWith("add:")), "must not insert before validating the owner");
});

test("admin route: adding on a user's behalf works", async () => {
  isAdmin = true;

  const res = await adminRoute.POST(
    jsonReq(ADMIN_BASE, "POST", { domain: "example.com", userId: "user_b" })
  );
  assert.equal(res.status, 201);
  assert.ok(calls.includes("add:user_b:example.com"));
});

test("admin route: DELETE uses a hard-coded asAdmin, and needs an id", async () => {
  isAdmin = true;

  const missing = await adminRoute.DELETE(jsonReq(ADMIN_BASE, "DELETE"));
  assert.equal(missing.status, 400);
  assert.equal((await readBody(missing)).code, "missing_id");

  assert.equal((await adminRoute.DELETE(jsonReq(`${ADMIN_BASE}?id=d_1`, "DELETE"))).status, 200);
  // "true" hard-coded and NOT influenced by the request — an admin flag read from
  // user input would be an authorization bypass.
  assert.ok(calls.includes("remove::d_1:true"));
});

test("admin route: GET lists every domain, including other users' and the platform's", async () => {
  // The one place the platform-only guard is NOT applied: the owner manages the
  // whole registry, including the platform's own zones.
  isAdmin = true;
  registryRows = [
    { ...DOMAIN_VIEW, id: "d_1", ownerKind: "user", ownerUserId: "user_a" },
    { ...DOMAIN_VIEW, id: "d_2", ownerKind: "user", ownerUserId: "user_b" },
    { ...DOMAIN_VIEW, id: "d_p", apex: "instaweb.top", ownerKind: "platform", ownerUserId: null },
  ];

  const res = await adminRoute.GET();
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ["listAll"]);
  assert.equal((await readBody(res)).domains?.length, 3);
});
