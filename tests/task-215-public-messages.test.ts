// TASK_215 Bug 2 — public form messages surfacing in the ADMIN support queue.
//
// The anonymous clown/captcha form writes `PublicMessage` rows; the admin
// queue must show them (synthetic `public:` ids), resolve/reopen them
// (isRead), and reply by EMAIL to the captured address — `SupportMessage.
// ticketId` is a hard FK, so no reply row can exist. Route-level tests against
// the real service with fake prisma/email/notify/admin-auth, mirroring
// tests/support-tickets.test.ts.

import assert from "node:assert/strict";
import { Module } from "node:module";
import { beforeEach, test } from "node:test";

interface FakePublic {
  id: string;
  name: string | null;
  email: string | null;
  message: string;
  isRead: boolean;
  createdAt: Date;
}

const store: { publics: FakePublic[] } = { publics: [] };

/** Every write, so a test can prove nothing was persisted. */
let writes: Array<{ op: string; data: Record<string, unknown> }> = [];
/** Calls into publicMessage.findMany — proves the merge skipped the read. */
let publicReads = 0;
/** The fake clock. Advanced only by tests, never by wall time. */
const clock = new Date("2026-10-10T09:00:00.000Z");

function publicMsg(over: Partial<FakePublic> & { id: string }): FakePublic {
  return {
    name: "Ada",
    email: "ada@example.com",
    message: "The deploy button does nothing.",
    isRead: false,
    createdAt: clock,
    ...over,
  };
}

const fakePrisma = {
  // Real tickets are covered by tests/support-tickets.test.ts; the merge must
  // simply tolerate an empty ticket table alongside public rows.
  supportTicket: {
    findMany: async () => [],
  },
  publicMessage: {
    findMany: async () => {
      publicReads++;
      return [...store.publics].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },
    findUnique: async ({ where }: { where: { id: string } }) =>
      store.publics.find((p) => p.id === where.id) ?? null,
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      writes.push({ op: "publicMessage.update", data });
      const row = store.publics.find((p) => p.id === where.id);
      if (!row) throw new Error("fake prisma: public message not found");
      for (const [k, v] of Object.entries(data)) {
        (row as unknown as Record<string, unknown>)[k] = v;
      }
      return row;
    },
  },
};

/** The admin session. Tests assume an admin unless they set this to null. */
let adminSession: { sub: string } | null = { sub: "admin" };

/** Emails sendEmail was called with, in order. */
let emailCalls: Array<{ to: string; subject: string; html: string; eventType?: string }> = [];
/** Make sendEmail throw — the 502 path. */
let emailThrows = false;
/** Every notifyUserTicketReply call — must stay empty for public replies. */
let notifyCalls: Array<Record<string, unknown>> = [];

const emailStub = {
  sendEmail: async (opts: { to: string; subject: string; html: string; eventType?: string }) => {
    if (emailThrows) throw new Error("smtp down");
    emailCalls.push(opts);
  },
};

const notifyStub = {
  notifyUserTicketReply: (payload: Record<string, unknown>) => {
    notifyCalls.push(payload);
  },
};

const fakeNextResponse = {
  json: (body: unknown, init?: { status?: number }) => ({
    status: init?.status ?? 200,
    json: async () => body,
  }),
};

// Route-level fakes. The graph has no `server-only` module (the service
// imports only prisma/email/redact), but the pattern matches the proven one.
const mod = Module as unknown as {
  _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};
const originalLoad = mod._load;
mod._load = function (
  this: unknown,
  request: string,
  parent: NodeModule | undefined,
  isMain: boolean
) {
  const from = parent?.filename ?? "";
  const isSupportRoute =
    from.endsWith("app/api/admin/support/tickets/route.ts") ||
    from.endsWith("app/api/admin/support/tickets/[id]/route.ts") ||
    from.endsWith("app/api/admin/support/tickets/[id]/messages/route.ts");
  if (isSupportRoute) {
    // CJS interop reads the NAMED export off the returned module object — the
    // fake must be wrapped, exactly like the proven harness does it.
    if (request === "next/server") return { NextResponse: fakeNextResponse };
    if (request === "@/lib/admin-auth") {
      return {
        requireAdminSession: async () => adminSession !== null,
        getAdminSession: async () => adminSession,
      };
    }
    if (request === "@/lib/support-notify") return notifyStub;
    if (request === "@/lib/prisma") return { prisma: fakePrisma };
    if (request === "@/lib/email") return emailStub;
  }
  // The service is reached through the routes; it imports prisma AND email.
  if (from.endsWith("/lib/support/tickets.ts")) {
    if (request === "@/lib/prisma") return { prisma: fakePrisma };
    if (request === "@/lib/email") return emailStub;
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof mod._load;

/* eslint-disable @typescript-eslint/no-require-imports */
type Res = { status: number; json: () => Promise<unknown> };
interface Body {
  tickets?: Array<Record<string, unknown>>;
  ticket?: Record<string, unknown>;
  message?: Record<string, unknown>;
  error?: string;
  code?: string;
}
async function readBody(res: Res): Promise<Body> {
  return (await res.json()) as Body;
}

const LIST_URL = "https://spaceworker.test/api/admin/support/tickets";
const adminListRoute = require("../app/api/admin/support/tickets/route") as {
  GET: (req: Request) => Promise<Res>;
};
const adminIdRoute = require("../app/api/admin/support/tickets/[id]/route") as {
  GET: (req: Request, c: { params: Promise<{ id: string }> }) => Promise<Res>;
  PATCH: (req: Request, c: { params: Promise<{ id: string }> }) => Promise<Res>;
};
const adminMsgRoute = require("../app/api/admin/support/tickets/[id]/messages/route") as {
  POST: (req: Request, c: { params: Promise<{ id: string }> }) => Promise<Res>;
};
/* eslint-enable @typescript-eslint/no-require-imports */

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
  store.publics = [];
  writes = [];
  publicReads = 0;
  adminSession = { sub: "admin" };
  emailCalls = [];
  emailThrows = false;
  notifyCalls = [];
});

// ===========================================================================
// THE QUEUE — public rows ride the same list with a `public:` id + prefix.
// ===========================================================================

test("TASK_215 — a public message rides the admin queue with a Public: prefix", async () => {
  store.publics.push(publicMsg({ id: "pm_1", name: "Ada", message: "DNS is broken" }));
  const res = await adminListRoute.GET(jsonReq(LIST_URL, "GET"));
  const body = await readBody(res);
  assert.equal(res.status, 200);
  const rows = body.tickets!;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "public:pm_1");
  assert.equal(rows[0].subject, "Public: Ada");
  assert.equal(rows[0].status, "open");
  assert.equal(rows[0].category, null);
  assert.equal(rows[0].priority, null);
  assert.equal(rows[0].messageCount, 1);
});

test("TASK_215 — a nameless submission is labelled Public: anonymous", async () => {
  store.publics.push(publicMsg({ id: "pm_2", name: null, message: "hello?" }));
  const res = await adminListRoute.GET(jsonReq(LIST_URL, "GET"));
  const rows = (await readBody(res)).tickets!;
  assert.equal(rows[0].subject, "Public: anonymous");
});

test("TASK_215 — merged public rows stay newest-first", async () => {
  store.publics.push(
    publicMsg({ id: "pm_old", name: "Old", createdAt: new Date("2026-10-01T00:00:00Z") }),
    publicMsg({ id: "pm_new", name: "New", createdAt: new Date("2026-10-09T00:00:00Z") })
  );
  const res = await adminListRoute.GET(jsonReq(LIST_URL, "GET"));
  const rows = (await readBody(res)).tickets!;
  assert.deepEqual(
    rows.map((r) => r.id),
    ["public:pm_new", "public:pm_old"]
  );
});

test("TASK_215 — the status filter applies to the DERIVED status", async () => {
  store.publics.push(
    publicMsg({ id: "pm_open", name: "Open", isRead: false }),
    publicMsg({ id: "pm_done", name: "Done", isRead: true })
  );
  const open = await adminListRoute.GET(jsonReq(`${LIST_URL}?status=open`, "GET"));
  const openIds = (await readBody(open)).tickets!.map((r) => r.id);
  assert.deepEqual(openIds, ["public:pm_open"]);

  const resolved = await adminListRoute.GET(jsonReq(`${LIST_URL}?status=resolved`, "GET"));
  const resolvedRows = (await readBody(resolved)).tickets!;
  assert.deepEqual(resolvedRows.map((r) => r.id), ["public:pm_done"]);
  assert.equal(resolvedRows[0].status, "resolved");
});

test("TASK_215 — a category filter excludes public rows AND skips the read", async () => {
  store.publics.push(publicMsg({ id: "pm_1" }));
  const res = await adminListRoute.GET(jsonReq(`${LIST_URL}?category=hosting`, "GET"));
  assert.equal(res.status, 200);
  assert.deepEqual((await readBody(res)).tickets!, []);
  assert.equal(publicReads, 0);
});

// ===========================================================================
// THE DETAIL — one user message, no account, no invoice composer.
// ===========================================================================

test("TASK_215 — detail: single user message, captured email, NO userId, no write on read", async () => {
  store.publics.push(publicMsg({ id: "pm_9", email: "ada@example.com", message: "help pls" }));
  const res = await adminIdRoute.GET(jsonReq(LIST_URL, "GET"), ctx("public:pm_9"));
  const body = await readBody(res);
  assert.equal(res.status, 200);
  const t = body.ticket!;
  assert.equal(t.subject, "Public: Ada");
  assert.equal(t.userEmail, "ada@example.com");
  assert.equal(t.userId, undefined); // hides the invoice composer
  assert.equal(t.domain, null);
  const msgs = t.messages as Array<Record<string, unknown>>;
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].authorRole, "user");
  assert.equal(msgs[0].body, "help pls");
  assert.equal(writes.length, 0); // opening does NOT flip isRead
});

test("TASK_215 — a message that left no address has no userEmail placeholder", async () => {
  store.publics.push(publicMsg({ id: "pm_na", name: null, email: null }));
  const res = await adminIdRoute.GET(jsonReq(LIST_URL, "GET"), ctx("public:pm_na"));
  const t = (await readBody(res)).ticket!;
  assert.equal(t.userEmail, undefined);
});

test("TASK_215 — an unknown public id is a 404", async () => {
  const res = await adminIdRoute.GET(jsonReq(LIST_URL, "GET"), ctx("public:nope"));
  assert.equal(res.status, 404);
});

// ===========================================================================
// RESOLVE / REOPEN — isRead is the only state the schema allows.
// ===========================================================================

test("TASK_215 — Resolve persists as isRead=true; Reopen flips it back", async () => {
  store.publics.push(publicMsg({ id: "pm_r" }));
  const patch = (b: unknown) =>
    adminIdRoute.PATCH(jsonReq(LIST_URL, "PATCH", b), ctx("public:pm_r"));
  const r1 = await patch({ status: "resolved" });
  assert.equal(r1.status, 200);
  assert.equal(store.publics[0].isRead, true);
  assert.equal(((await readBody(r1)).ticket as Record<string, unknown>).status, "resolved");

  const r2 = await patch({ status: "open" });
  assert.equal(r2.status, 200);
  assert.equal(store.publics[0].isRead, false);
});

test("TASK_215 — category/priority patches are a 422, not a silent no-op", async () => {
  store.publics.push(publicMsg({ id: "pm_c" }));
  const res = await adminIdRoute.PATCH(
    jsonReq(LIST_URL, "PATCH", { category: "hosting" }),
    ctx("public:pm_c")
  );
  assert.equal(res.status, 422);
  assert.equal((await readBody(res)).code, "public_message_no_fields");
  assert.equal(writes.length, 0);
});

// ===========================================================================
// REPLY — email delivery, nothing persisted, no dashboard notify.
// ===========================================================================

test("TASK_215 — a reply EMAILS the captured address; nothing is persisted; no notify", async () => {
  store.publics.push(
    publicMsg({ id: "pm_e", email: "ada@example.com", message: "Original <body>" })
  );
  const res = await adminMsgRoute.POST(
    jsonReq(LIST_URL, "POST", { body: "Fixed by re-pointing NS.\nRun it again & see." }),
    ctx("public:pm_e")
  );
  assert.equal(res.status, 201);
  assert.equal(emailCalls.length, 1);
  assert.equal(emailCalls[0].to, "ada@example.com");
  assert.equal(emailCalls[0].eventType, "public_message_reply");
  assert.ok(emailCalls[0].html.includes("Fixed by re-pointing NS."));
  assert.ok(emailCalls[0].html.includes("Run it again &amp; see.")); // reply escaped
  assert.ok(emailCalls[0].html.includes("Original &lt;body&gt;")); // original quoted + escaped
  assert.equal(writes.length, 0); // no SupportMessage row can exist (hard FK)
  assert.equal(notifyCalls.length, 0); // no account ⇒ no dashboard email
  const msg = (await readBody(res)).message as Record<string, unknown>;
  assert.equal(msg.authorRole, "admin");
  assert.equal(msg.invoiceId, null);
});

test("TASK_215 — a reply to a message with no captured email is a 422", async () => {
  store.publics.push(publicMsg({ id: "pm_ne", email: null }));
  const res = await adminMsgRoute.POST(
    jsonReq(LIST_URL, "POST", { body: "hi" }),
    ctx("public:pm_ne")
  );
  assert.equal(res.status, 422);
  assert.equal((await readBody(res)).code, "public_message_no_email");
  assert.equal(emailCalls.length, 0);
  assert.equal(writes.length, 0);
});

test("TASK_215 — replies go through the same credential scan as ticket bodies", async () => {
  store.publics.push(publicMsg({ id: "pm_cs" }));
  const res = await adminMsgRoute.POST(
    jsonReq(LIST_URL, "POST", { body: "here: cfut__OOujdCztZDuH8yrK3mNqPLrXe" }),
    ctx("public:pm_cs")
  );
  assert.equal(res.status, 422);
  assert.equal((await readBody(res)).code, "credential_in_ticket");
  assert.equal(emailCalls.length, 0);
  assert.equal(writes.length, 0);
});

test("TASK_215 — an invoice cannot ride a public reply", async () => {
  store.publics.push(publicMsg({ id: "pm_inv" }));
  const res = await adminMsgRoute.POST(
    jsonReq(LIST_URL, "POST", { body: "pay this", invoiceId: "inv_1" }),
    ctx("public:pm_inv")
  );
  assert.equal(res.status, 422);
  assert.equal((await readBody(res)).code, "public_message_invoice");
  assert.equal(emailCalls.length, 0);
});

test("TASK_215 — a failed send is a 502 and nothing pretends otherwise", async () => {
  store.publics.push(publicMsg({ id: "pm_502" }));
  emailThrows = true;
  const res = await adminMsgRoute.POST(
    jsonReq(LIST_URL, "POST", { body: "hello" }),
    ctx("public:pm_502")
  );
  assert.equal(res.status, 502);
  assert.equal((await readBody(res)).code, "public_message_reply_failed");
  assert.equal(writes.length, 0);
});