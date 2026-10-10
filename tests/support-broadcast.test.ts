import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// ---------------------------------------------------------------------------
// TASK_199 S1 — the broadcast route + service contracts.
//
// WHAT CAN GO WRONG HERE, AND WHY THESE ARE ROUTE-LEVEL:
//   1. THE WRONG AUDIENCE GETS EMAILED. The tier filter must be derived
//      server-side from an enum; a client-sent tier list would be a
//      where-clause injection and a lie about who received it.
//   2. THE BATCH DIES HALFWAY. One broken thread must not stop the other
//      N-1 sends — the owner would believe "sent to everyone" while half the
//      list silently got nothing. Hence targeted/sent/failed counts.
//   3. AN UNAUTHORIZED CALLER BROADCASTS. The guard is asserted with NOTHING
//      written — a 401 that still posted is worse than no guard at all.
//   4. PII LEAVES THE ROUTE. The response ships COUNTS ONLY — no ids, no
//      emails — pinned by a serialization assertion.
//   5. THE BADGE NEVER LIGHTS. Delivery rides `addAdminMessage` (the same
//      path every admin reply takes), so the derived-unread rule stays true;
//      the email is the TASK_187 S2 contract, one per SENT user.
//
// The SERVICE and the ROUTE are real; only `@/lib/prisma`, `@/lib/admin-auth`
// and `@/lib/support-notify` are faked (house pattern — support-tickets.test.ts).
// `lib/support/` must stay free of `server-only` imports for this to hold.
// ---------------------------------------------------------------------------

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "task199-test-session-secret";

const BROADCAST_ROUTE = "/app/api/admin/support/broadcast/route.ts";

// ---------------------------------------------------------------- stores

interface FakeUser {
  id: string;
  email: string;
  tier: number;
}
interface FakeTicket {
  id: string;
  userId: string;
  status: string;
  subject: string;
  createdAt: Date;
  updatedAt: Date;
}
interface FakeMessage {
  id: string;
  ticketId: string;
  authorRole: string;
  authorId: string | null;
  body: string;
  invoiceId: string | null;
  createdAt: Date;
}

let users: FakeUser[] = [];
let tickets: FakeTicket[] = [];
let messages: FakeMessage[] = [];
let failCreateForUser: string | null = null;
let adminSession: { sub: string } | null = { sub: "admin" };
const emailCalls: Array<{ ticketId: string; to: string; subject: string }> = [];

function resetWorld(): void {
  users = [
    { id: "u-free", email: "free@x.dev", tier: 1 },
    { id: "u-zero", email: "zero@x.dev", tier: 0 },
    { id: "u-x", email: "xdev@x.dev", tier: 3 },
    { id: "u-plus", email: "plus@x.dev", tier: 5 },
  ];
  tickets = [];
  messages = [];
  emailCalls.length = 0;
  failCreateForUser = null;
  adminSession = { sub: "admin" };
}

const fakePrisma = {
  user: {
    // Applies the tier filter the SERVICE derived — so count assertions prove
    // the real where-clause, not a reimplementation of it.
    findMany: async ({ where }: { where?: { tier?: { in?: number[]; gte?: number } } } = {}) =>
      users.filter((u) => {
        if (!where?.tier) return true;
        if (where.tier.in) return where.tier.in.includes(u.tier);
        if (typeof where.tier.gte === "number") return u.tier >= where.tier.gte;
        return true;
      }),
  },
  supportTicket: {
    findFirst: async ({
      where,
    }: {
      where: { userId: string; status: { not: string } };
      orderBy?: { updatedAt: "desc" };
      select?: unknown;
    }) => {
      const rows = tickets
        .filter((t) => t.userId === where.userId && t.status !== where.status.not)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      return rows[0] ?? null;
    },
    findUnique: async ({ where }: { where: { id: string } }) => {
      const t = tickets.find((row) => row.id === where.id);
      return t ? { id: t.id, userId: t.userId } : null;
    },
    create: async ({ data }: { data: { userId: string; subject: string } }) => {
      if (failCreateForUser && data.userId === failCreateForUser) {
        throw new Error("simulated write failure");
      }
      const now = new Date();
      const t: FakeTicket = {
        id: `t${tickets.length + 1}`,
        userId: data.userId,
        status: "open",
        subject: data.subject,
        createdAt: now,
        updatedAt: now,
      };
      tickets.push(t);
      return { id: t.id, subject: t.subject };
    },
    update: async ({ where, data }: { where: { id: string }; data: { updatedAt?: Date } }) => {
      const t = tickets.find((row) => row.id === where.id);
      if (t && data.updatedAt) t.updatedAt = data.updatedAt;
      return t;
    },
  },
  supportMessage: {
    create: async ({
      data,
    }: {
      data: {
        ticketId: string;
        authorRole: string;
        authorId: string | null;
        body: string;
        invoiceId?: string | null;
      };
    }) => {
      const m: FakeMessage = {
        id: `m${messages.length + 1}`,
        ticketId: data.ticketId,
        authorRole: data.authorRole,
        authorId: data.authorId ?? null,
        body: data.body,
        invoiceId: data.invoiceId ?? null,
        createdAt: new Date(),
      };
      messages.push(m);
      return {
        id: m.id,
        authorRole: m.authorRole,
        body: m.body,
        createdAt: m.createdAt,
        invoiceId: m.invoiceId,
      };
    },
  },
  premiumInvoice: { findUnique: async () => null },
  $transaction: async (ops: Array<Promise<unknown>>) => Promise.all(ops),
};

// ---------------------------------------------------------------- hook

const fakeNextResponse = {
  json: (data: unknown, init?: { status?: number }) => ({
    status: init?.status ?? 200,
    json: async () => data,
  }),
};

function installRequireHook(): void {
  const loader = Module as unknown as {
    _load: (r: string, p: NodeModule | undefined, m: boolean) => unknown;
  };
  const originalLoad = loader._load;
  loader._load = function patched(request, parent, isMain) {
    const from = (parent?.filename ?? "").replace(/\\/g, "/");
    if (from.endsWith(BROADCAST_ROUTE)) {
      if (request === "next/server") return { NextResponse: fakeNextResponse };
      if (request === "@/lib/admin-auth") {
        return {
          requireAdminSession: async () => adminSession !== null,
          getAdminSession: async () => adminSession,
        };
      }
      if (request === "@/lib/support-notify") {
        return {
          notifyUserTicketReply: (n: { ticketId: string; to: string; subject: string }) => {
            emailCalls.push(n);
          },
        };
      }
    }
    // The SERVICE reaches prisma from its own file (house pattern, see
    // support-tickets.test.ts): real service code, fake store.
    if (from.endsWith("/lib/support/tickets.ts") && request === "@/lib/prisma") {
      return { prisma: fakePrisma };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
installRequireHook();
const route = require("../app/api/admin/support/broadcast/route") as {
  POST: (req: Request) => Promise<{ status: number; json: () => Promise<Record<string, unknown>> }>;
};
const service = require("../lib/support/tickets") as {
  broadcastAudienceWhere: (a: string) => Record<string, unknown>;
};
/* eslint-enable @typescript-eslint/no-require-imports */

type PostRes = { status: number; json: () => Promise<Record<string, unknown>> };

async function postRaw(raw: string, admin: { sub: string } | null = { sub: "admin" }): Promise<PostRes> {
  adminSession = admin;
  return route.POST(
    new Request("http://localhost/api/admin/support/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw,
    }),
  );
}

const post = (body: unknown): Promise<PostRes> => postRaw(JSON.stringify(body));

beforeEach(resetWorld);

// ---------------------------------------------------------------- tests

test("audience → tier filter is derived SERVER-side from the enum", () => {
  assert.deepEqual(service.broadcastAudienceWhere("everyone"), {});
  assert.deepEqual(service.broadcastAudienceWhere("free"), { tier: { in: [0, 1, 4] } });
  assert.deepEqual(service.broadcastAudienceWhere("xdevice"), { tier: { in: [3] } });
  assert.deepEqual(service.broadcastAudienceWhere("plus"), { tier: { gte: 5 } });
});

test("no admin session → 401 and NOTHING is written", async () => {
  const res = await postRaw(JSON.stringify({ audience: "everyone", body: "hello" }), null);
  assert.equal(res.status, 401);
  assert.equal(messages.length, 0, "a 401 that still posted would be worse than no guard");
  assert.equal(emailCalls.length, 0);
});

test("empty body / bad audience / unknown key → 400, nothing sent", async () => {
  assert.equal((await post({ audience: "everyone", body: "" })).status, 400);
  assert.equal((await post({ audience: "everyone", body: "   " })).status, 400);
  assert.equal((await post({ audience: "vip", body: "hi" })).status, 400);
  // .strict() — a typo'd key is REFUSED, never silently ignored.
  assert.equal((await post({ audience: "everyone", body: "hi", tier: 5 })).status, 400);
  assert.equal(messages.length, 0);
});

test("invalid JSON → 400", async () => {
  assert.equal((await postRaw("not-json{")).status, 400);
});

test("audience 'free' → exactly the free tiers, counts contract, no PII", async () => {
  const res = await post({ audience: "free", body: "Maintenance tonight" });
  assert.equal(res.status, 200);
  const counts = await res.json();
  assert.deepEqual(Object.keys(counts).sort(), ["audience", "failed", "sent", "targeted"]);
  assert.deepEqual(counts, { audience: "free", targeted: 2, sent: 2, failed: 0 });
  assert.equal(messages.length, 2, "one message per targeted user");
  const json = JSON.stringify(counts);
  assert.ok(!json.includes("u-free") && !json.includes("@x.dev"), "ids/emails must never leave the route");
});

test("audience 'everyone' → all four users, one message each", async () => {
  const counts = await (await post({ audience: "everyone", body: "hello all" })).json();
  assert.deepEqual(counts, { audience: "everyone", targeted: 4, sent: 4, failed: 0 });
  assert.equal(messages.length, 4);
});

test("audience 'xdevice' hits only tier 3; 'plus' only >= 5", async () => {
  const x = await (await post({ audience: "xdevice", body: "x" })).json();
  assert.deepEqual(x, { audience: "xdevice", targeted: 1, sent: 1, failed: 0 });
  resetWorld();
  const p = await (await post({ audience: "plus", body: "p" })).json();
  assert.deepEqual(p, { audience: "plus", targeted: 1, sent: 1, failed: 0 });
});

test("exactly one email per SENT user, none for anyone else (TASK_187 S2)", async () => {
  await post({ audience: "everyone", body: "hello" });
  assert.equal(emailCalls.length, 4, "one notify per sent user");
  assert.deepEqual(
    emailCalls.map((e) => e.to).sort(),
    ["free@x.dev", "plus@x.dev", "xdev@x.dev", "zero@x.dev"],
  );
  assert.ok(emailCalls.every((e) => e.subject === "Announcement"), "new threads are 'Announcement'");
});

test("reuses a user's OPEN thread (subject preserved) instead of opening another", async () => {
  tickets.push({
    id: "t-open",
    userId: "u-free",
    status: "open",
    subject: "Billing help",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await post({ audience: "free", body: "note" });

  assert.ok(
    messages.some((m) => m.ticketId === "t-open"),
    "the open thread must receive the broadcast",
  );
  const newTicketForZero = tickets.find((t) => t.userId === "u-zero");
  assert.equal(newTicketForZero?.subject, "Announcement");
  const emailForFree = emailCalls.find((e) => e.ticketId === "t-open");
  assert.equal(emailForFree?.subject, "Billing help", "reused thread emails keep the real subject");
});

test("a user whose only thread is RESOLVED gets a fresh Announcement thread", async () => {
  tickets.push({
    id: "t-res",
    userId: "u-free",
    status: "resolved",
    subject: "Old thing",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await post({ audience: "free", body: "x" });
  assert.ok(!messages.some((m) => m.ticketId === "t-res"), "never resurrect a resolved thread");
  assert.ok(
    tickets.some((t) => t.userId === "u-free" && t.subject === "Announcement"),
    "a fresh thread is opened instead",
  );
});

test("one bad user → failed:1, everyone else STILL sent (batch never aborts)", async () => {
  failCreateForUser = "u-zero";
  const counts = await (await post({ audience: "everyone", body: "x" })).json();
  assert.deepEqual(counts, { audience: "everyone", targeted: 4, sent: 3, failed: 1 });
  assert.equal(emailCalls.length, 3, "the failed user gets no email");
  assert.ok(!emailCalls.some((e) => e.to === "zero@x.dev"));
});

test("every message is stamped with the admin session sub", async () => {
  await post({ audience: "everyone", body: "x" });
  assert.ok(
    messages.every((m) => m.authorRole === "admin" && m.authorId === "admin"),
    "authorRole/authorId must carry the admin subject",
  );
});
