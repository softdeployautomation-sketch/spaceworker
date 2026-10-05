import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// ---------------------------------------------------------------------------
// TASK_159 Phase 1 — the ROUTE + SERVICE contracts for support tickets.
//
// Scope: PLAN_TASK_159_SUPPORT_TICKETS.md §2 (the non-negotiables) and §4 (the API).
//
// WHY THESE ARE ROUTE TESTS AND NOT ONLY UNIT TESTS. Every failure this feature can
// have is SILENT, and each one is a different kind of silence:
//
//   1. A CREDENTIAL GETS STORED (§2.1). The ticket looks fine. The secret is now in
//      the admin UI, in an export, and eventually in a search index.
//   2. THE OWNER COMES FROM THE BODY (§2.2). A crafted POST files a ticket against
//      somebody else's account — including one whose domain is attached.
//   3. A NON-OWNER GETS 403 INSTEAD OF 404 (§4). The status code itself becomes an
//      enumeration oracle over other customers' support threads.
//   4. A MESSAGE CAN BE EDITED OR DELETED (§2.3). History stops being history.
//   5. THE DOMAIN LINK COPIES AN APEX (§3.3). It then goes stale and tells an admin
//      something false about who owns what.
//
// THE SERVICE IS REAL HERE; ONLY `@/lib/prisma` IS FAKED. That is the opposite of the
// sibling domain test, and deliberately so: the ownership WHERE clause, the credential
// refusal and the `resolvedAt` derivation all live in the service, and faking the
// service would mean testing a fake that reimplements exactly the rules under test.
// The fake below is an in-memory store, so every assertion is about real code paths.
// ---------------------------------------------------------------------------

(process.env as Record<string, string>).NODE_ENV = "test";
// A dummy, because `@/lib/prisma` is faked but a transitive import must not explode.
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";

const USER_LIST_ROUTE = "/app/api/support/tickets/route.ts";
const USER_ID_ROUTE = "/app/api/support/tickets/[id]/route.ts";
const USER_MSG_ROUTE = "/app/api/support/tickets/[id]/messages/route.ts";
/** TASK_166 — the read-cursor route, which lives in its own `/read` directory. */
const USER_READ_ROUTE = "/app/api/support/tickets/[id]/read/route.ts";
const ADMIN_LIST_ROUTE = "/app/api/admin/support/tickets/route.ts";
const ADMIN_ID_ROUTE = "/app/api/admin/support/tickets/[id]/route.ts";
const ADMIN_MSG_ROUTE = "/app/api/admin/support/tickets/[id]/messages/route.ts";

// ---------------------------------------------------------------------------
// The in-memory store. Dates are fixed so ordering is deterministic.
// ---------------------------------------------------------------------------

interface FakeTicket {
  id: string;
  userId: string;
  status: string;
  subject: string;
  category: string | null;
  priority: string | null;
  domainRefId: string | null;
  walletRefId: string | null;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
  /** TASK_166 — the owner's read cursor. null means NEVER READ (see the migration). */
  lastReadAt: Date | null;
}

interface FakeMessage {
  id: string;
  ticketId: string;
  authorRole: string;
  authorId: string | null;
  body: string;
  createdAt: Date;
}

interface FakeDomain {
  id: string;
  apex: string;
  status: string;
  ownerKind: string;
  ownerUserId: string | null;
}

const store: {
  tickets: FakeTicket[];
  messages: FakeMessage[];
  domains: FakeDomain[];
} = { tickets: [], messages: [], domains: [] };

/** Every write, in order, so a test can prove nothing was written at all. */
let writes: Array<{ op: string; data: Record<string, unknown> }> = [];
/** Every query, so a test can prove the ownership filter reached the WHERE clause. */
let queries: Array<{ op: string; where: Record<string, unknown> }> = [];
/** The fake clock. Advanced only by the test, never by wall time. */
let clock = new Date("2026-10-04T10:00:00.000Z");

let seq = 0;
const nextId = (prefix: string) => `${prefix}_${++seq}`;

/** Emails the admin detail view joins for, and the emails `user.findUnique` resolves. */
const userEmails: Record<string, string> = {
  user_a: "ada@sw.dev",
  user_b: "bob@sw.dev",
};

/**
 * The reverse index `createAdminComposedTicket` looks the target up through.
 *
 * TASK_161 D4 resolves the ticket's owner from an EMAIL, so this is the lookup the
 * whole admin-composed path hinges on. Seeded from `userEmails` by default so an
 * existing test that files as "user_a" resolves too.
 */
let usersByEmail: Record<string, string> = { "ada@sw.dev": "user_a", "bob@sw.dev": "user_b" };

function ticket(over: Partial<FakeTicket> & { id: string; userId: string }): FakeTicket {
  return {
    status: "open",
    subject: "subject",
    category: null,
    priority: null,
    domainRefId: null,
    walletRefId: null,
    createdAt: clock,
    updatedAt: clock,
    resolvedAt: null,
    // TASK_166 — null, i.e. "never read". This is the state every ticket is in on the day
    // the column is added, and it is why the service must treat null as UNREAD.
    lastReadAt: null,
    ...over,
  };
}

/**
 * Attach the two relation-shaped extras the service's mapper reads.
 *
 * `take: 1` means the LIST projection ("last activity only"), anything else means the
 * DETAIL projection (the whole thread, ascending). Reading this from the `select` the
 * caller actually passed — rather than guessing — is what makes the list and detail
 * assertions meaningful.
 */
function withRelations(t: FakeTicket, select: Record<string, unknown> | undefined) {
  const msgs = store.messages
    .filter((m) => m.ticketId === t.id)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const msgSelect = select?.messages as { take?: number } | undefined;
  const picked = typeof msgSelect?.take === "number" ? msgs.slice(-msgSelect.take) : msgs;
  return {
    ...t,
    _count: { messages: msgs.length },
    messages: picked.map((m) => ({
      id: m.id,
      authorRole: m.authorRole,
      body: m.body,
      createdAt: m.createdAt,
    })),
    user: { email: userEmails[t.userId] ?? "unknown@sw.dev" },
  };
}

/** Equality-only WHERE matching: every filter these tests exercise is an equality. */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => row[k] === v);
}

/**
 * `instanceof` on a `Date | null` is a TS2358 error ("must be of type any, an object
 * type or a type parameter"), so the narrowing goes through this helper rather than a
 * cast at each call site — a cast would switch off the check this test exists to make.
 */
function isDate(value: unknown): boolean {
  return value instanceof Date;
}

const fakePrisma = {
  user: {
    findUnique: async ({ where }: { where: { email: string } }) => {
      queries.push({ op: "user.findUnique", where });
      const id = usersByEmail[where.email];
      return id ? { id } : null;
    },
  },
  userDomain: {
    findUnique: async ({ where }: { where: { id: string } }) => {
      queries.push({ op: "userDomain.findUnique", where });
      return store.domains.find((d) => d.id === where.id) ?? null;
    },
  },
  supportTicket: {
    findMany: async ({
      where,
      select,
    }: {
      where?: Record<string, unknown>;
      select?: Record<string, unknown>;
    }) => {
      queries.push({ op: "supportTicket.findMany", where: where ?? {} });
      return store.tickets
        .filter((t) => matches(t as unknown as Record<string, unknown>, where ?? {}))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((t) => withRelations(t, select));
    },
    findFirst: async ({
      where,
      select,
    }: {
      where: Record<string, unknown>;
      select?: Record<string, unknown>;
    }) => {
      queries.push({ op: "supportTicket.findFirst", where });
      const found = store.tickets.find((t) =>
        matches(t as unknown as Record<string, unknown>, where)
      );
      return found ? withRelations(found, select) : null;
    },
    findUnique: async ({
      where,
      select,
    }: {
      where: { id: string };
      select?: Record<string, unknown>;
    }) => {
      queries.push({ op: "supportTicket.findUnique", where });
      const found = store.tickets.find((t) => t.id === where.id);
      return found ? withRelations(found, select) : null;
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      writes.push({ op: "supportTicket.create", data });
      const t = ticket({
        id: nextId("t"),
        userId: data.userId as string,
        subject: data.subject as string,
        category: (data.category ?? null) as string | null,
        priority: (data.priority ?? null) as string | null,
        domainRefId: (data.domainRefId ?? null) as string | null,
        createdAt: clock,
        updatedAt: clock,
      });
      store.tickets.push(t);
      const nested = data.messages as { create?: Record<string, unknown> } | undefined;
      if (nested?.create) {
        store.messages.push({
          id: nextId("m"),
          ticketId: t.id,
          authorRole: nested.create.authorRole as string,
          authorId: (nested.create.authorId ?? null) as string | null,
          body: nested.create.body as string,
          createdAt: clock,
        });
      }
      return { id: t.id };
    },
    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => {
      writes.push({ op: "supportTicket.update", data });
      const t = store.tickets.find((x) => x.id === where.id);
      if (!t) throw new Error("fake prisma: ticket not found");
      for (const [k, v] of Object.entries(data)) {
        if (v !== undefined) (t as unknown as Record<string, unknown>)[k] = v;
      }
      t.updatedAt = clock;
      return withRelations(t, {});
    },
  },
  supportMessage: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      writes.push({ op: "supportMessage.create", data });
      const m: FakeMessage = {
        id: nextId("m"),
        ticketId: data.ticketId as string,
        authorRole: data.authorRole as string,
        authorId: (data.authorId ?? null) as string | null,
        body: data.body as string,
        createdAt: clock,
      };
      store.messages.push(m);
      return { id: m.id, authorRole: m.authorRole, body: m.body, createdAt: m.createdAt };
    },
  },
  /** The array form only — which is the only form the service uses. */
  $transaction: async (ops: Array<Promise<unknown>>) => Promise.all(ops),
};

/** The caller for user-facing routes. `null` = signed out. */
let sessionUser: { id: string } | null = { id: "user_a" };
/** The admin session. `null` = not an admin, which is the default for no test. */
let adminSession: { sub: string } | null = null;

const fakeNextResponse = {
  json: (data: unknown, init?: { status?: number }) => ({
    status: init?.status ?? 200,
    json: async () => data,
  }),
};

const loader = Module as unknown as {
  _load: (r: string, p: NodeModule | undefined, m: boolean) => unknown;
};
const originalLoad = loader._load;
loader._load = function patched(request, parent, isMain) {
  const from = parent?.filename ?? "";
  const isSupportRoute =
    from.endsWith(USER_LIST_ROUTE) ||
    from.endsWith(USER_ID_ROUTE) ||
    from.endsWith(USER_MSG_ROUTE) ||
    from.endsWith(USER_READ_ROUTE) ||
    from.endsWith(ADMIN_LIST_ROUTE) ||
    from.endsWith(ADMIN_ID_ROUTE) ||
    from.endsWith(ADMIN_MSG_ROUTE);
  if (isSupportRoute) {
    if (request === "next/server") return { NextResponse: fakeNextResponse };
    if (request === "@/lib/session-user") return { getCurrentUser: async () => sessionUser };
    if (request === "@/lib/admin-auth") {
      return {
        requireAdminSession: async () => adminSession !== null,
        getAdminSession: async () => adminSession,
      };
    }
    if (request === "@/lib/prisma") return { prisma: fakePrisma };
  }
  // The SERVICE is reached through the routes, but it imports "@/lib/prisma" too —
  // and its parent is lib/support/tickets.ts, not a route. Patched separately so the
  // real service runs against the fake store rather than opening a connection.
  if (from.endsWith("/lib/support/tickets.ts") && request === "@/lib/prisma") {
    return { prisma: fakePrisma };
  }
  return originalLoad.call(this, request, parent, isMain);
};

/* eslint-disable @typescript-eslint/no-require-imports */
type Res = { status: number; json: () => Promise<unknown> };
interface TicketBody {
  ticket?: Record<string, unknown>;
  tickets?: Array<Record<string, unknown>>;
  message?: Record<string, unknown>;
  error?: string;
  code?: string;
  messages?: Array<Record<string, unknown>>;
  domain?: Record<string, unknown> | null;
  userEmail?: string;
}
async function readBody(res: Res): Promise<TicketBody> {
  return (await res.json()) as TicketBody;
}

const userListRoute = require("../app/api/support/tickets/route") as {
  GET: () => Promise<Res>;
  POST: (req: Request) => Promise<Res>;
};
const userIdRoute = require("../app/api/support/tickets/[id]/route") as {
  GET: (req: Request, c: { params: Promise<{ id: string }> }) => Promise<Res>;
};
const userMsgRoute = require("../app/api/support/tickets/[id]/messages/route") as {
  POST: (req: Request, c: { params: Promise<{ id: string }> }) => Promise<Res>;
};
const userReadRoute = require("../app/api/support/tickets/[id]/read/route") as {
  POST: (req: Request, c: { params: Promise<{ id: string }> }) => Promise<Res>;
};
const adminListRoute = require("../app/api/admin/support/tickets/route") as {
  GET: (req: Request) => Promise<Res>;
  /** TASK_161 D4 — the admin-composed ticket, added to this route's contract. */
  POST: (req: Request) => Promise<Res>;
};
const adminIdRoute = require("../app/api/admin/support/tickets/[id]/route") as {
  GET: (req: Request, c: { params: Promise<{ id: string }> }) => Promise<Res>;
  PATCH: (req: Request, c: { params: Promise<{ id: string }> }) => Promise<Res>;
};
const adminMsgRoute = require("../app/api/admin/support/tickets/[id]/messages/route") as {
  POST: (req: Request, c: { params: Promise<{ id: string }> }) => Promise<Res>;
};

const { describeCredentialIn, looksLikeCredential, redactCredentials, REDACTION_PLACEHOLDER } =
  require("../lib/support/redact") as typeof import("../lib/support/redact");
/* eslint-enable @typescript-eslint/no-require-imports */

function jsonReq(method: string, body?: unknown): Request {
  return new Request("https://spaceworker.test/api/support/tickets", {
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
  store.tickets = [];
  store.messages = [];
  store.domains = [{ id: "d_mine", apex: "mine.com", status: "active", ownerKind: "user", ownerUserId: "user_a" }];
  writes = [];
  queries = [];
  seq = 0;
  clock = new Date("2026-10-04T10:00:00.000Z");
  sessionUser = { id: "user_a" };
  adminSession = null;
  // Reset the lookup index, not just the store: a test that adds an email must not
  // leak that account into the next test, or "an unknown email is refused" would
  // silently stop being true depending on test order.
  usersByEmail = { "ada@sw.dev": "user_a", "bob@sw.dev": "user_b" };
});

// ===========================================================================
// §2.1 — THE CREDENTIAL DETECTOR.
//
// The FALSE-POSITIVE cases are tested as carefully as the true ones, and they are
// listed explicitly in the module: a UUID, a cuid, a lowercase snake_case identifier,
// a path, and plain prose must all pass through untouched. A detector that flags
// those would get switched off by the first user who pasted a traceback — and a
// switched-off detector protects nothing.
// ===========================================================================

test("§2.1 redact: catches the credential shapes a customer actually pastes", () => {
  for (const sample of [
    "cfut__OOujdCztZDuH8yrK3mNqPLrXe",
    "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345'",
    "CF_API_TOKEN=cfut__OOujdCztZDuH8yr",
    'ZONE_TOKEN: "abc123def456ghi789jkl012"',
    "password=hunter2hunter2",
    "sk_live_51H8xYzabcdefghijklmn",
    "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
    "AKIAIOSFODNN7EXAMPLE",
    "xoxb-123456789012-abcdefghijkl",
    "AIzaSyA1234567890abcdefghijklmnopqrstuv", // 39 chars, the real Google key length
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  ]) {
    assert.equal(looksLikeCredential(sample), true, `should catch: ${sample.slice(0, 24)}…`);
  }
});

test("§2.1 redact: does NOT flag ordinary technical text", () => {
  for (const sample of [
    "My domain mine.com is not showing up in the dashboard.",
    "550e8400-e29b-41d4-a716-446655440000", // UUID
    "clx0abcdefghijklmnopqrstuvw", // cuid
    "customer_account_identifier_name_value", // long snake_case, all lowercase
    "/Users/mikeolab/spaceworker/prisma/schema.prisma", // a path
    "The nameservers are ns1.cloudflare.com and ns2.cloudflare.com.",
    "I set the CNAME but got error 1016.",
    "internationalization", // one very long word
  ]) {
    assert.equal(looksLikeCredential(sample), false, `must not flag: ${sample}`);
  }
});

test("§2.1 redact: describes the SHAPE, and redacts without eating the prose", () => {
  assert.match(describeCredentialIn("token cfut__OOujdCztZDuH8yrK3mNq") ?? "", /Cloudflare/);
  const redacted = redactCredentials("my token is cfut__OOujdCztZDuH8yrK3mNqPLrXe please help");
  assert.ok(!redacted.includes("OOujdCztZDuH8yr"), "the secret must be gone");
  assert.match(redacted, /^my token is /, "the user's own words must survive");
  assert.match(redacted, /please help$/, "including after the secret");
  assert.ok(redacted.includes(REDACTION_PLACEHOLDER), "the removal must be visible, not silent");
  assert.equal(redactCredentials(redacted), redacted, "redaction is idempotent");
});

test("§2.1 a ticket carrying a token is refused and NOTHING is written", async () => {
  const res = await userListRoute.POST(
    jsonReq("POST", { subject: "help", body: "my token is cfut__OOujdCztZDuH8yrK3mNqPLrXe" })
  );
  const body = await readBody(res);
  assert.equal(res.status, 422);
  assert.equal(body.code, "credential_in_ticket");
  // The refusal must never echo the secret: this text is shown to the user AND logged.
  assert.ok(!String(body.error).includes("OOujdCztZDuH8yr"), "the error must not echo the token");
  assert.deepEqual(writes, [], "nothing may reach the database");
  assert.equal(store.tickets.length, 0);
  assert.equal(store.messages.length, 0);
});

test("§2.1 a token in the SUBJECT is refused too (the subject is just as readable)", async () => {
  const res = await userListRoute.POST(
    jsonReq("POST", { subject: "cfut__OOujdCztZDuH8yrK3mNqPLrXe", body: "please help" })
  );
  assert.equal(res.status, 422);
  assert.equal((await readBody(res)).code, "credential_in_ticket");
  assert.deepEqual(writes, []);
});

test("§2.1 a token in a REPLY is refused too, and the thread is untouched", async () => {
  store.tickets.push(ticket({ id: "t_1", userId: "user_a" }));
  const res = await userMsgRoute.POST(
    jsonReq("POST", { body: "API_TOKEN=abc123def456ghi789jkl012" }),
    ctx("t_1")
  );
  assert.equal(res.status, 422);
  assert.equal(store.messages.length, 0, "no message may be appended");
});

// ===========================================================================
// §2.2 / §4 — OWNERSHIP, AND THE 404-NOT-403 RULE.
//
// Rule 2's whole value is that a non-owner cannot tell "not yours" from "not there".
// So each of these asserts the STATUS CODE and that no data leaked into the body —
// a 404 carrying the subject line would be just as good an oracle as a 403.
// ===========================================================================

test("§2.2 the ticket's owner comes from the SESSION, never from the body", async () => {
  const res = await userListRoute.POST(
    jsonReq("POST", {
      subject: "mine.com is not resolving",
      body: "It has been pending for two days.",
      // A crafted field. The zod schema has no `userId`, so it is stripped — and even
      // if it were not, the route never reads it.
      userId: "user_b",
    })
  );
  assert.equal(res.status, 201);
  assert.equal(store.tickets.length, 1);
  assert.equal(store.tickets[0].userId, "user_a", "must be filed against the caller");
  assert.equal(store.messages[0].authorId, "user_a");
});

test("§2.2 the list returns ONLY the caller's tickets", async () => {
  store.tickets.push(ticket({ id: "t_mine", userId: "user_a", subject: "mine" }));
  store.tickets.push(ticket({ id: "t_theirs", userId: "user_b", subject: "theirs" }));
  const res = await userListRoute.GET();
  const body = await readBody(res);
  assert.equal(res.status, 200);
  assert.deepEqual(
    body.tickets?.map((t) => t.id),
    ["t_mine"]
  );
  // The filter must be IN the query, not applied afterwards in JS.
  const listQuery = queries.find((q) => q.op === "supportTicket.findMany");
  assert.equal(listQuery?.where.userId, "user_a");
});

test("§4 someone else's ticket -> 404, and NOT 403, on GET", async () => {
  store.tickets.push(ticket({ id: "t_theirs", userId: "user_b", subject: "SECRET SUBJECT" }));
  const res = await userIdRoute.GET(jsonReq("GET"), ctx("t_theirs"));
  const body = await readBody(res);
  assert.equal(res.status, 404, "403 would confirm the id exists");
  assert.equal(body.code, "ticket_not_found");
  assert.ok(!JSON.stringify(body).includes("SECRET"), "no subject may leak in the error");
});

test("§4 an id that does not exist is INDISTINGUISHABLE from someone else's", async () => {
  store.tickets.push(ticket({ id: "t_theirs", userId: "user_b" }));
  const theirs = await userIdRoute.GET(jsonReq("GET"), ctx("t_theirs"));
  const missing = await userIdRoute.GET(jsonReq("GET"), ctx("t_nope"));
  assert.equal(theirs.status, missing.status);
  assert.deepEqual(await theirs.json(), await missing.json());
});

test("§4 someone else's ticket -> 404 on REPLY too (and nothing is written)", async () => {
  store.tickets.push(ticket({ id: "t_theirs", userId: "user_b" }));
  const res = await userMsgRoute.POST(jsonReq("POST", { body: "hello" }), ctx("t_theirs"));
  assert.equal(res.status, 404);
  assert.deepEqual(writes, []);
  assert.equal(store.messages.length, 0);
});

test("§2.2 every user route 401s when signed out, before touching the store", async () => {
  sessionUser = null;
  for (const call of [
    () => userListRoute.GET(),
    () => userListRoute.POST(jsonReq("POST", { subject: "s", body: "b" })),
    () => userIdRoute.GET(jsonReq("GET"), ctx("t_1")),
    () => userMsgRoute.POST(jsonReq("POST", { body: "b" }), ctx("t_1")),
  ]) {
    assert.equal((await call()).status, 401);
  }
  assert.deepEqual(writes, []);
  assert.deepEqual(queries, []);
});

test("§2.3 messages are APPEND-ONLY: the route exposes no edit or delete at all", () => {
  // The absence of the handlers IS the enforcement. A route that does not exist
  // cannot be called, and this assertion fails loudly if one is ever added.
  const msg = userMsgRoute as unknown as Record<string, unknown>;
  const single = userIdRoute as unknown as Record<string, unknown>;
  for (const verb of ["PUT", "PATCH", "DELETE"]) {
    assert.equal(msg[verb], undefined, `${verb} must not exist on a message`);
    assert.equal(single[verb], undefined, `${verb} must not exist on a ticket`);
  }
});

// ===========================================================================
// §3.3 — THE DOMAIN IS REFERENCED BY ID AND READ LIVE.
//
// This is the rule that makes the feature honest: there is no apex column on the
// ticket to go stale. Every one of these asserts something about the LIVE read.
// ===========================================================================

test("§3.3 a domain that is not yours cannot be attached -> 404, nothing written", async () => {
  store.domains.push({
    id: "d_theirs",
    apex: "theirs.com",
    status: "active",
    ownerKind: "user",
    ownerUserId: "user_b",
  });
  const res = await userListRoute.POST(
    jsonReq("POST", { subject: "help", body: "with my domain", domainRefId: "d_theirs" })
  );
  assert.equal(res.status, 404, "not 403 — the same rule as a ticket id");
  assert.equal((await readBody(res)).code, "domain_not_found");
  assert.deepEqual(writes, [], "the ticket must not be created at all");
});

test("§3.3 a PLATFORM domain (ownerUserId null) cannot be attached either", async () => {
  // The ownership boundary is ownerKind AND ownerUserId, so a platform row — whose
  // user id is null — must never satisfy a user's request.
  store.domains.push({
    id: "d_platform",
    apex: "spaceworker.app",
    status: "active",
    ownerKind: "platform",
    ownerUserId: null,
  });
  const res = await userListRoute.POST(
    jsonReq("POST", { subject: "help", body: "x", domainRefId: "d_platform" })
  );
  assert.equal(res.status, 404);
  assert.deepEqual(writes, []);
});

test("§3.3 an attached domain is returned LIVE, and the apex is never stored", async () => {
  // The subject deliberately does NOT mention the apex: an earlier version said
  // "mine.com is stuck", and the assertion below then failed on the SUBJECT — a good
  // reminder that "does this row mention the apex anywhere" has to be asked of a row
  // that could only mention it by copying it.
  const created = await userListRoute.POST(
    jsonReq("POST", { subject: "my domain is stuck", body: "help", domainRefId: "d_mine" })
  );
  assert.equal(created.status, 201);
  const ticketId = (await readBody(created)).ticket?.id as string;

  // The ticket row holds an ID, and no apex anywhere on it.
  const row = store.tickets.find((t) => t.id === ticketId) as unknown as Record<string, unknown>;
  assert.equal(row.domainRefId, "d_mine");
  assert.ok(!JSON.stringify(row).includes("mine.com"), "no apex may be copied onto the ticket");

  const detail = await readBody(await userIdRoute.GET(jsonReq("GET"), ctx(ticketId)));
  assert.deepEqual(detail.ticket?.domain, { id: "d_mine", apex: "mine.com", status: "active" });
});

test("§3.3 the status shown is the domain's status NOW, not what it was when filed", async () => {
  store.domains[0].status = "pending"; // as filed
  const created = await userListRoute.POST(
    jsonReq("POST", { subject: "s", body: "b", domainRefId: "d_mine" })
  );
  const ticketId = (await readBody(created)).ticket?.id as string;
  assert.equal(
    ((await readBody(await userIdRoute.GET(jsonReq("GET"), ctx(ticketId)))).ticket?.domain as Record<
      string,
      unknown
    >).status,
    "pending"
  );

  // Cloudflare flips the zone to active outside the app. The ticket is not touched —
  // and the very next read must say so, or an admin is looking at a stale story.
  store.domains[0].status = "active";
  assert.equal(
    ((await readBody(await userIdRoute.GET(jsonReq("GET"), ctx(ticketId)))).ticket?.domain as Record<
      string,
      unknown
    >).status,
    "active"
  );
});

test("§3.3 if the domain is REMOVED, the reference dangles and reads as null", async () => {
  const created = await userListRoute.POST(
    jsonReq("POST", { subject: "s", body: "b", domainRefId: "d_mine" })
  );
  const ticketId = (await readBody(created)).ticket?.id as string;
  store.domains = []; // the customer deletes the domain
  const detail = await readBody(await userIdRoute.GET(jsonReq("GET"), ctx(ticketId)));
  assert.equal(detail.ticket?.domain, null, "null, not a stale copy of mine.com");
  // And the ticket itself still exists — a dangling reference is not a lost ticket.
  assert.equal(detail.ticket?.id, ticketId);
});

// ===========================================================================
// §7.1 — THE REOPEN RULE, WHICH IS THE ONE INTERIM PRODUCT DECISION HERE.
// ===========================================================================

test("§7.1 a USER reply reopens a resolved ticket (an answer must not be buried)", async () => {
  store.tickets.push(
    ticket({
      id: "t_1",
      userId: "user_a",
      status: "resolved",
      resolvedAt: new Date("2026-10-03T00:00:00.000Z"),
    })
  );
  const res = await userMsgRoute.POST(jsonReq("POST", { body: "it broke again" }), ctx("t_1"));
  assert.equal(res.status, 201);
  assert.equal(store.tickets[0].status, "open");
  assert.equal(store.tickets[0].resolvedAt, null);
});

test("§7.1 an ADMIN reply does NOT reopen — replying to close is not reopening", async () => {
  adminSession = { sub: "admin" };
  store.tickets.push(
    ticket({
      id: "t_1",
      userId: "user_a",
      status: "resolved",
      resolvedAt: new Date("2026-10-03T00:00:00.000Z"),
    })
  );
  const res = await adminMsgRoute.POST(jsonReq("POST", { body: "you're welcome" }), ctx("t_1"));
  assert.equal(res.status, 201);
  assert.equal(store.tickets[0].status, "resolved", "the admin's explicit action owns this");
  assert.deepEqual(store.tickets[0].resolvedAt, new Date("2026-10-03T00:00:00.000Z"));
});

test("§7.1 an admin reply records the session subject as its author", async () => {
  adminSession = { sub: "admin" };
  store.tickets.push(ticket({ id: "t_1", userId: "user_a" }));
  await adminMsgRoute.POST(jsonReq("POST", { body: "on it" }), ctx("t_1"));
  assert.equal(store.messages[0].authorRole, "admin");
  assert.equal(store.messages[0].authorId, "admin");
});

// ===========================================================================
// THE ADMIN QUEUE, ITS GATE, AND THE DERIVED `resolvedAt`.
// ===========================================================================

test("§4 every admin route 401s without an admin session", async () => {
  adminSession = null;
  assert.equal((await adminListRoute.GET(jsonReq("GET"))).status, 401);
  assert.equal((await adminIdRoute.GET(jsonReq("GET"), ctx("t_1"))).status, 401);
  assert.equal(
    (await adminIdRoute.PATCH(jsonReq("PATCH", { status: "resolved" }), ctx("t_1"))).status,
    401
  );
  assert.equal((await adminMsgRoute.POST(jsonReq("POST", { body: "b" }), ctx("t_1"))).status, 401);
  // The gate must fire BEFORE the store: no read, no write. An admin route that
  // queried first and checked afterwards would still have touched the data.
  assert.deepEqual(writes, []);
  assert.deepEqual(queries, []);
});

test("§4 the queue returns every user's tickets, and the detail has the owner's email", async () => {
  adminSession = { sub: "admin" };
  store.tickets.push(ticket({ id: "t_a", userId: "user_a", subject: "from ada" }));
  store.tickets.push(ticket({ id: "t_b", userId: "user_b", subject: "from bob" }));
  const body = await readBody(await adminListRoute.GET(jsonReq("GET")));
  assert.equal(body.tickets?.length, 2, "an admin sees every user, unlike the user list");

  const detail = await readBody(await adminIdRoute.GET(jsonReq("GET"), ctx("t_a")));
  assert.equal(detail.ticket?.userEmail, "ada@sw.dev");
  assert.equal(detail.ticket?.domain, null, "no domain attached");
});

test("§4 queue filters apply, and an EMPTY filter is ignored rather than matching nothing", async () => {
  adminSession = { sub: "admin" };
  store.tickets.push(ticket({ id: "t_open", userId: "user_a", status: "open" }));
  store.tickets.push(ticket({ id: "t_done", userId: "user_a", status: "resolved" }));

  const all = await readBody(await adminListRoute.GET(jsonReq("GET")));
  assert.equal(all.tickets?.length, 2, "no filter means everything");

  // `?status=` is exactly what an empty filter box sends. It must be IGNORED — not
  // turned into `status = ''`, which would return nothing and read as "no tickets".
  const blank = await adminListRoute.GET(
    new Request("https://spaceworker.test/api/admin/support/tickets?status=")
  );
  assert.equal((await readBody(blank)).tickets?.length, 2);
  const blankQuery = queries.filter((q) => q.op === "supportTicket.findMany").pop();
  assert.deepEqual(blankQuery?.where, {}, "the empty filter must not reach the query at all");

  const filtered = await adminListRoute.GET(
    new Request("https://spaceworker.test/api/admin/support/tickets?status=resolved")
  );
  assert.deepEqual(
    ((await readBody(filtered)).tickets ?? []).map((t) => t.id),
    ["t_done"]
  );
});

test("§4 resolving derives `resolvedAt`; reopening clears it", async () => {
  adminSession = { sub: "admin" };
  store.tickets.push(ticket({ id: "t_1", userId: "user_a" }));
  assert.equal(store.tickets[0].resolvedAt, null);

  const resolved = await adminIdRoute.PATCH(jsonReq("PATCH", { status: "resolved" }), ctx("t_1"));
  assert.equal(resolved.status, 200);
  assert.equal(store.tickets[0].status, "resolved");
  assert.ok(isDate(store.tickets[0].resolvedAt), "resolvedAt must be stamped");

  const reopened = await adminIdRoute.PATCH(jsonReq("PATCH", { status: "open" }), ctx("t_1"));
  assert.equal(reopened.status, 200);
  assert.equal(store.tickets[0].status, "open");
  assert.equal(store.tickets[0].resolvedAt, null, "reopening must clear it");
});

test("§4 the caller cannot set `resolvedAt` — it is derived, never accepted", async () => {
  adminSession = { sub: "admin" };
  store.tickets.push(ticket({ id: "t_1", userId: "user_a" }));
  await adminIdRoute.PATCH(
    // A crafted field. The zod schema has no `resolvedAt`, so it is stripped.
    jsonReq("PATCH", { status: "resolved", resolvedAt: null }),
    ctx("t_1")
  );
  assert.ok(
    isDate(store.tickets[0].resolvedAt),
    "the timestamp must come from the server, not the body"
  );
});

test("§4 re-resolving keeps the ORIGINAL resolution time", async () => {
  adminSession = { sub: "admin" };
  const first = new Date("2026-10-01T00:00:00.000Z");
  store.tickets.push(ticket({ id: "t_1", userId: "user_a", status: "resolved", resolvedAt: first }));
  await adminIdRoute.PATCH(jsonReq("PATCH", { status: "resolved" }), ctx("t_1"));
  assert.deepEqual(store.tickets[0].resolvedAt, first, "must not drift forward on re-resolve");
});

test("§4 PATCH semantics: absent leaves alone, null clears, an empty PATCH is refused", async () => {
  adminSession = { sub: "admin" };
  store.tickets.push(ticket({ id: "t_1", userId: "user_a", category: "hosting", priority: "high" }));

  // `status` only — category and priority must be untouched. This is the foot-gun the
  // route comment describes: sending explicit nulls for them would clear both.
  await adminIdRoute.PATCH(jsonReq("PATCH", { status: "resolved" }), ctx("t_1"));
  assert.equal(store.tickets[0].category, "hosting");
  assert.equal(store.tickets[0].priority, "high");

  // An explicit null DOES clear.
  await adminIdRoute.PATCH(jsonReq("PATCH", { category: null }), ctx("t_1"));
  assert.equal(store.tickets[0].category, null);
  assert.equal(store.tickets[0].priority, "high", "the untouched field survives");

  // Nothing to change is a 422, not a silent no-op success.
  const empty = await adminIdRoute.PATCH(jsonReq("PATCH", {}), ctx("t_1"));
  assert.equal(empty.status, 422);
  assert.equal((await readBody(empty)).code, "nothing_to_update");

  // `status: null` is a caller bug, and it says so rather than clearing.
  const nullStatus = await adminIdRoute.PATCH(jsonReq("PATCH", { status: null }), ctx("t_1"));
  assert.equal(nullStatus.status, 422);
  assert.equal((await readBody(nullStatus)).code, "empty_status");
});

test("§2.3 a ticket detail returns the whole thread, oldest first", async () => {
  store.tickets.push(ticket({ id: "t_1", userId: "user_a" }));
  store.messages.push(
    {
      id: "m_1",
      ticketId: "t_1",
      authorRole: "user",
      authorId: "user_a",
      body: "first",
      createdAt: new Date("2026-10-04T09:00:00Z"),
    },
    {
      id: "m_2",
      ticketId: "t_1",
      authorRole: "admin",
      authorId: "admin",
      body: "second",
      createdAt: new Date("2026-10-04T09:05:00Z"),
    },
    {
      id: "m_3",
      ticketId: "t_1",
      authorRole: "user",
      authorId: "user_a",
      body: "third",
      createdAt: new Date("2026-10-04T09:10:00Z"),
    }
  );
  const detail = await readBody(await userIdRoute.GET(jsonReq("GET"), ctx("t_1")));
  const ticketView = detail.ticket as Record<string, unknown>;
  assert.deepEqual(
    (ticketView.messages as Array<Record<string, unknown>>).map((m) => m.body),
    ["first", "second", "third"]
  );
  assert.equal(ticketView.messageCount, 3);
  assert.equal(ticketView.lastMessageAt, "2026-10-04T09:10:00.000Z");
});

test("§4 the queue's preview is the LAST message, and it is not the whole thread", async () => {
  adminSession = { sub: "admin" };
  store.tickets.push(ticket({ id: "t_1", userId: "user_a" }));
  store.messages.push(
    {
      id: "m_1",
      ticketId: "t_1",
      authorRole: "user",
      authorId: "user_a",
      body: "oldest",
      createdAt: new Date("2026-10-04T09:00:00Z"),
    },
    {
      id: "m_2",
      ticketId: "t_1",
      authorRole: "user",
      authorId: "user_a",
      body: "newest",
      createdAt: new Date("2026-10-04T09:30:00Z"),
    }
  );
  const rows = (await readBody(await adminListRoute.GET(jsonReq("GET")))).tickets ?? [];
  const row = rows[0] as Record<string, unknown>;
  assert.equal(row.messageCount, 2);
  assert.equal(row.lastMessageAt, "2026-10-04T09:30:00.000Z");
  // The list view does not carry the bodies at all — a queue that shipped every message
  // body would put the whole customer conversation in a page that renders one line per
  // row. `take: 1` bounds the QUERY; this bounds the VIEW.
  assert.equal(row.messages, undefined, "a list must not carry message bodies");
});

// ===========================================================================
// TASK_161 D4 — THE ADMIN-COMPOSED TICKET.
//
// The security question this file has to answer is NOT "can an admin file a ticket?"
// — of course they can. It is "can anybody ELSE file a ticket against a customer, or
// read a thread that is not theirs?" Every test below is about that.
// ===========================================================================

/** A valid admin-composed body, overridden per test. */
const compose = (over: Record<string, unknown> = {}) =>
  jsonReq("POST", {
    userEmail: "bob@sw.dev",
    subject: "Called about mine.com",
    body: "Bob phoned; his nameservers are set but the page is not served.",
    ...over,
  });

test("D4 an unauthenticated POST is refused 401 and the body is NEVER read", async () => {
  adminSession = null;
  const res = await adminListRoute.POST(compose());
  assert.equal(res.status, 401);
  // The gate runs before `request.json()`. Asserted rather than assumed, because the
  // alternative — parse, then check — is what turns this endpoint into an
  // account-existence oracle reachable without credentials.
  assert.equal(queries.some((q) => q.op === "user.findUnique"), false, "no lookup may run");
  assert.equal(store.tickets.length, 0, "and nothing may be written");
});

test("D4 the target is resolved from the EMAIL server-side, and the ticket is the customer's", async () => {
  adminSession = { sub: "admin" };
  const res = await adminListRoute.POST(compose());
  assert.equal(res.status, 201);

  // The lookup is by email, against User.email. There is no id parameter at all, so
  // there is nothing to forge into somebody else's row.
  const lookup = queries.find((q) => q.op === "user.findUnique");
  assert.equal(lookup?.where.email, "bob@sw.dev");

  // The stored owner is the RESOLVED id for that email — not "user_a" (the session
  // user) and not whatever the caller sent.
  const stored = store.tickets[0];
  assert.equal(stored.userId, "user_b");
  assert.notEqual(stored.userId, "user_a", "the admin session user is not the owner");
});

test("D4 the admin's session subject is recorded as the author, not a user id", async () => {
  adminSession = { sub: "admin" };
  await adminListRoute.POST(compose());
  const msg = store.messages[0];
  assert.equal(msg.authorRole, "admin");
  assert.equal(msg.authorId, "admin");
  // The literal string "admin" is the shared-passcode subject (lib/admin-auth.ts). It
  // is NOT a User row and must never be mistaken for one.
  assert.equal(usersByEmail["admin"], undefined, "'admin' is not a user id");
});

test("D4 the email match is case- and whitespace-insensitive", async () => {
  adminSession = { sub: "admin" };
  const res = await adminListRoute.POST(compose({ userEmail: "  BOB@Sw.Dev  " }));
  assert.equal(res.status, 201, "a different spelling of one address must still resolve");
  assert.equal(store.tickets[0].userId, "user_b");
});

test("D4 an unknown email is a 404 and writes nothing", async () => {
  adminSession = { sub: "admin" };
  const res = await adminListRoute.POST(compose({ userEmail: "nobody@sw.dev" }));
  assert.equal(res.status, 404);
  assert.equal(store.tickets.length, 0, "a ticket must not be filed against nobody");
  assert.equal(store.messages.length, 0);
});

test("D4 a missing email is refused before any lookup", async () => {
  adminSession = { sub: "admin" };
  // zod's `min(1)` accepts three spaces, so this is NOT caught as a 400 — it reaches
  // the service, which trims and returns 422 `missing_email`. The 404 branch and the
  // lookup are the things worth proving here, so the assertion is on the lookup.
  const res = await adminListRoute.POST(compose({ userEmail: "   " }));
  assert.equal(res.status, 422);
  assert.equal(queries.some((q) => q.op === "user.findUnique"), false, "no lookup for a blank");
  assert.equal(store.tickets.length, 0);
});

test("D4 the composed ticket is visible to the CUSTOMER it was filed for", async () => {
  adminSession = { sub: "admin" };
  await adminListRoute.POST(compose());

  // The whole reason this feature exists: a thread that starts in a channel nobody is
  // watching is a thread that gets answered twice, or not at all. It must land in the
  // customer's own list, which is only true because the owner was resolved to them.
  sessionUser = { id: "user_b" };
  const rows = (await readBody(await userListRoute.GET())).tickets ?? [];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subject, "Called about mine.com");

  // And the OTHER customer must not see it. This is the assertion that would fail if
  // the owner were ever taken from a request field instead of the email lookup.
  sessionUser = { id: "user_a" };
  const other = (await readBody(await userListRoute.GET())).tickets ?? [];
  assert.equal(other.length, 0, "user_a must not see a ticket filed for user_b");
});

test("D4 the customer can reply to an admin-composed ticket, and the admin sees it", async () => {
  adminSession = { sub: "admin" };
  const created = (await readBody(await adminListRoute.POST(compose()))).ticket as {
    id: string;
  };

  sessionUser = { id: "user_b" };
  const reply = await userMsgRoute.POST(
    jsonReq("POST", { body: "Yes, that is the right domain." }),
    ctx(created.id)
  );
  assert.equal(reply.status, 201);

  adminSession = { sub: "admin" };
  const thread = (await readBody(await adminIdRoute.GET(jsonReq("GET"), ctx(created.id)))).ticket as {
    messages: Array<Record<string, unknown>>;
    userEmail: string;
  };
  assert.equal(thread.userEmail, "bob@sw.dev", "the queue names whose ticket this is");
  assert.equal(thread.messages.length, 2);
  assert.equal(thread.messages[1].authorRole, "user");
});

test("D4 no customer route can name a target user — the D4 hole is not copied into §2.2", async () => {
  sessionUser = { id: "user_a" };
  // The customer POST is asked to file against user_b. The schema does not declare the
  // field, so it is dropped and the ticket is filed for the session user, which is the
  // ONLY correct outcome. If someone ever adds `userId` to that schema, this test is
  // what notices — it is the regression guard for the whole D4 design.
  const res = await userListRoute.POST(
    jsonReq("POST", {
      userEmail: "bob@sw.dev",
      userId: "user_b",
      subject: "Trying to file against someone else",
      body: "This must land on my own account.",
    })
  );
  assert.equal(res.status, 201);
  assert.equal(store.tickets[0].userId, "user_a");
  assert.equal(store.tickets.length, 1, "no second ticket may appear");
});

test("D4 §2.1 the credential scan applies to an ADMIN-composed ticket too", async () => {
  adminSession = { sub: "admin" };
  const res = await adminListRoute.POST(
    compose({ body: "his token is cfut__OOujdCztZDuH8yrK3mNqPLrXe" })
  );
  assert.equal(res.status, 422);
  assert.equal(store.tickets.length, 0, "staff must not be the one who gets a token in");
  const body = await readBody(res);
  assert.match(body.error ?? "", /Cloudflare/, "the refusal names the shape, not the secret");
  assert.ok(!(body.error ?? "").includes("OOujdCztZDuH8yr"), "and never echoes the value");
});

// ===========================================================================
// TASK_166 — THE UNREAD BADGE (owner, 2026-10-05: an admin reply "delivered into the
// user, but it didn't show like a notification on the support button").
//
// The bug was never a missing message — the reply was always in the list. It was that
// nothing told the CUSTOMER, on any surface, until they happened to open the panel.
// These cover the three ways that can silently fail: the flag itself, the read cursor
// (owner's only, forwards only), and the admin side (must NOT clear the customer's badge).
// ===========================================================================

/** Files a ticket for the session user with one message, then advances the clock. */
async function seedTicketWithMessage(
  role: "admin" | "user",
  id = "t_1",
  body = "hello"
): Promise<void> {
  store.tickets.push(ticket({ id, userId: "user_a", createdAt: clock }));
  store.messages.push({
    id: nextId("m"),
    ticketId: id,
    authorRole: role,
    authorId: role === "admin" ? "admin" : "user_a",
    body,
    createdAt: clock,
  });
  clock = new Date(clock.getTime() + 60_000);
}

/** The `unread` flag the customer's own list route reports, keyed by ticket id. */
async function unreadFlagsFor(sessionId: string): Promise<Record<string, boolean>> {
  sessionUser = { id: sessionId };
  const body = (await (await userListRoute.GET()).json()) as {
    tickets?: Array<{ id: string; unread?: boolean }>;
  };
  return Object.fromEntries((body.tickets ?? []).map((t) => [t.id, Boolean(t.unread)]));
}

test("TASK_166 an admin reply on a never-read ticket is unread", async () => {
  await seedTicketWithMessage("admin");
  assert.deepEqual(await unreadFlagsFor("user_a"), { t_1: true });
});

test("TASK_166 lastReadAt null means UNREAD, not read — the pre-migration direction", async () => {
  // Every ticket that existed before this column was added has NULL there. Reading NULL as
  // "read" would permanently hide an answer that really is sitting in the queue, which is
  // the one failure mode this whole feature exists to prevent.
  await seedTicketWithMessage("admin");
  assert.equal(store.tickets[0].lastReadAt, null);
  assert.equal((await unreadFlagsFor("user_a")).t_1, true);
});

test("TASK_166 a ticket whose newest message is the customer's own is not unread", async () => {
  // Replying is itself reading — the customer demonstrably saw the thread.
  await seedTicketWithMessage("admin");
  clock = new Date(clock.getTime() + 60_000);
  store.messages.push({
    id: nextId("m"),
    ticketId: "t_1",
    authorRole: "user",
    authorId: "user_a",
    body: "thanks",
    createdAt: clock,
  });
  assert.equal((await unreadFlagsFor("user_a")).t_1, false);
});

test("TASK_166 opening the thread clears the badge, and it stays cleared", async () => {
  await seedTicketWithMessage("admin");
  assert.equal((await unreadFlagsFor("user_a")).t_1, true);

  const res = await userReadRoute.POST(jsonReq("POST"), ctx("t_1"));
  assert.equal(res.status, 200);
  assert.equal((await unreadFlagsFor("user_a")).t_1, false, "the badge must clear");

  // Idempotent: a client retry must not throw or resurrect the badge.
  assert.equal((await userReadRoute.POST(jsonReq("POST"), ctx("t_1"))).status, 200);
  assert.equal((await unreadFlagsFor("user_a")).t_1, false);
});

test("TASK_166 the read cursor only ever moves FORWARDS", async () => {
  await seedTicketWithMessage("admin");
  await userReadRoute.POST(jsonReq("POST"), ctx("t_1"));
  const first = store.tickets[0].lastReadAt;
  assert.ok(first, "the cursor must have been written");

  // Simulate an out-of-order second call from a slower request that started earlier: the
  // cursor is rewound in the store, then the route runs again. The rewind must be corrected
  // rather than adopted, or the badge reappears under a customer reading the thread.
  store.tickets[0].lastReadAt = new Date(first.getTime() - 60_000);
  await userReadRoute.POST(jsonReq("POST"), ctx("t_1"));
  assert.equal(
    store.tickets[0].lastReadAt?.getTime(),
    first.getTime(),
    "a rewind must be corrected, not adopted",
  );
});

test("TASK_166 a non-owner gets 404, not 403, and the cursor is never touched", async () => {
  await seedTicketWithMessage("admin");
  sessionUser = { id: "user_a" };
  assert.equal((await userReadRoute.POST(jsonReq("POST"), ctx("t_1"))).status, 200);

  // user_b is not the owner. 404, because 403 would confirm the ticket exists (§4).
  sessionUser = { id: "user_b" };
  const before = store.tickets[0].lastReadAt;
  const res = await userReadRoute.POST(jsonReq("POST"), ctx("t_1"));
  assert.equal(res.status, 404, "must not confirm that another customer's ticket exists");
  assert.equal(store.tickets[0].lastReadAt?.getTime(), before?.getTime());
});

test("TASK_166 an unread ticket is listed for its owner alone", async () => {
  await seedTicketWithMessage("admin", "t_1");
  store.tickets.push(ticket({ id: "t_2", userId: "user_b", createdAt: clock }));
  store.messages.push({
    id: nextId("m"),
    ticketId: "t_2",
    authorRole: "admin",
    authorId: "admin",
    body: "not yours",
    createdAt: clock,
  });

  assert.deepEqual(await unreadFlagsFor("user_a"), { t_1: true }, "user_b's ticket is not listed");
  assert.deepEqual(await unreadFlagsFor("user_b"), { t_2: true });
});

test("TASK_166 the ADMIN queue must not clear the customer's badge", async () => {
  // The badge exists to tell the CUSTOMER an answer arrived. If reading the ticket in the
  // admin queue moved the customer's cursor, an admin working the queue would silence the
  // customer's alert for them and the reply would sit unread forever.
  adminSession = { sub: "admin" };
  await seedTicketWithMessage("user", "t_1");
  clock = new Date(clock.getTime() + 60_000);

  const res = await adminMsgRoute.POST(jsonReq("POST", { body: "fixed it" }), ctx("t_1"));
  assert.equal(res.status, 201);
  assert.equal(
    store.tickets[0].lastReadAt,
    null,
    "an admin reply must leave the read cursor alone so the customer is notified",
  );
  assert.equal((await unreadFlagsFor("user_a")).t_1, true);
});

test("TASK_166 the read route rejects an anonymous caller before touching the store", async () => {
  await seedTicketWithMessage("admin");
  sessionUser = null;
  const res = await userReadRoute.POST(jsonReq("POST"), ctx("t_1"));
  assert.equal(res.status, 401);
  assert.equal(store.tickets[0].lastReadAt, null, "no write for an anonymous caller");
});

test("TASK_166 the list projection drives the badge, so it must carry `unread`", async () => {
  // Guards the WIRE contract, not the service: the button reads `unread` off the LIST
  // response, so if this field is dropped from the view the badge silently reads 0 and the
  // original bug returns with every service-level test above still green.
  await seedTicketWithMessage("admin");
  sessionUser = { id: "user_a" };
  const body = (await (await userListRoute.GET()).json()) as {
    tickets?: Array<Record<string, unknown>>;
  };
  assert.equal(body.tickets?.[0]?.unread, true);
});

