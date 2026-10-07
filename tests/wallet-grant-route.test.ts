import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// ---------------------------------------------------------------------------
// TASK_181 P0a — POST /api/admin/wallet/grant, the admin "give a customer
// funds" route.
//
// THE FAILURE THIS SUITE EXISTS TO PREVENT: the $50 founders grant. The admin
// panel's session is a SHARED PASSCODE whose JWT sub is the literal string
// "admin" (lib/admin-auth.ts — no per-admin accounts), but WalletLedgerEntry
// adminId is a real FK to User. Passing "admin" through wrote an unsatisfiable
// FK → P2003 inside move()'s transaction → the throw escaped to Next.js → an
// HTML 500 the panel's res.json().catch(() => ({})) could not read → the
// generic "Grant failed" toast, with no clue why.
//
// So this suite asserts two things, both load-bearing:
//   1. the session's "admin" becomes NULL on the ledger row (never a forged id,
//      never an FK violation), while the mandatory note keeps the audit trail;
//   2. a service throw comes back as a JSON body with a status — NEVER HTML —
//      so the panel always has an `error` string to show.
// ---------------------------------------------------------------------------

(process.env as Record<string, string>).NODE_ENV = "test";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";

const GRANT_ROUTE = "/app/api/admin/wallet/grant/route.ts";

/** Minimal NextResponse stand-in — the route only ever returns .json(...). */
const fakeNextResponse = {
  json: (data: unknown, init?: { status?: number }) => ({
    status: init?.status ?? 200,
    json: async () => data,
  }),
};

/** Request stand-in; json() is all this route ever calls. */
const req = (body: unknown) => ({ json: async () => body }) as never;

interface Row {
  [k: string]: unknown;
}

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
  if (parent?.filename && request === "next/server") return { NextResponse: fakeNextResponse };
  return originalLoad.call(this, request, parent, isMain);
};

/** Require the grant route fresh with `deps` substituted for its imports. */
function loadRoute(path: string, deps: Overrides) {
  const abs = require.resolve(`..${path}`);
  delete require.cache[abs];
  overrides = deps;
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    return require(abs) as {
      POST: (r: never) => Promise<{ status: number; json: () => Promise<unknown> }>;
    };
    /* eslint-enable @typescript-eslint/no-require-imports */
  } finally {
    overrides = {};
  }
}

/** The admin session the panel actually issues — sub is always "admin". */
const ADMIN_SESSION = { getAdminSession: async () => ({ sub: "admin" }) };

const VALID_BODY = {
  userId: "u_founder",
  amountCents: 5000,
  note: "founders funding",
  idempotencyKey: "grant_1",
};

beforeEach(() => {
  overrides = {};
});

test('the shared-passcode admin (sub "admin") reaches the wallet as NULL, not as an FK-breaking string', async () => {
  let seenAdminId: unknown = "not called";
  const { POST } = loadRoute(GRANT_ROUTE, {
    "@/lib/admin-auth": ADMIN_SESSION,
    "@/lib/wallet": {
      grantBalance: async (input: Row) => {
        seenAdminId = input.adminId;
        return { ok: true, value: { kind: "admin_grant", amountCents: 5000, balanceCents: 5000, replayed: undefined } };
      },
    },
  });

  const res = await POST(req(VALID_BODY));
  assert.equal(res.status, 200);
  assert.equal(seenAdminId, null, 'sub "admin" has no User row — the FK must be NULL, not "admin"');
});


test("a NON-admin session sub (a future per-admin id) is passed through untouched", async () => {
  let seenAdminId: unknown;
  const { POST } = loadRoute(GRANT_ROUTE, {
    "@/lib/admin-auth": { getAdminSession: async () => ({ sub: "admin_2" }) },
    "@/lib/wallet": {
      grantBalance: async (input: Row) => {
        seenAdminId = input.adminId;
        return { ok: true, value: { kind: "admin_grant", amountCents: 1, balanceCents: 1 } };
      },
    },
  });

  await POST(req({ ...VALID_BODY, idempotencyKey: undefined }));
  assert.equal(seenAdminId, "admin_2", "a real admin id still FKs normally");
});

test("a service throw is answered as JSON 500 with an error string — never HTML", async () => {
  const { POST } = loadRoute(GRANT_ROUTE, {
    "@/lib/admin-auth": ADMIN_SESSION,
    "@/lib/wallet": {
      grantBalance: () => {
        // Exactly the P0a failure: P2003 escaping move()'s transaction.
        const err = new Error("Foreign key constraint failed on the field: adminId");
        (err as Error & { code?: string }).code = "P2003";
        throw err;
      },
    },
  });

  const res = await POST(req(VALID_BODY));
  assert.equal(res.status, 500, "an escaped service throw must still carry a status");
  const body = (await res.json()) as Row;
  assert.equal(typeof body.error, "string", "the panel reads body.error — a missing string is how 'Grant failed' stayed unexplained");
  assert.ok(String(body.error).length > 0);
});

test("validation failures keep their own statuses and never reach the wallet", async () => {
  let called = false;
  const { POST } = loadRoute(GRANT_ROUTE, {
    "@/lib/admin-auth": ADMIN_SESSION,
    "@/lib/wallet": {
      grantBalance: async () => {
        called = true;
        return { ok: true, value: { kind: "admin_grant", amountCents: 0, balanceCents: 0 } };
      },
    },
  });

  const noNote = await POST(req({ ...VALID_BODY, note: undefined }));
  assert.equal(noNote.status, 400);
  const noUser = await POST(req({ ...VALID_BODY, userId: "" }));
  assert.equal(noUser.status, 400);
  assert.equal(called, false, "a refused request must never reach the money service");
});

test("a refused grant surfaces the service's own message and status as JSON", async () => {
  const { POST } = loadRoute(GRANT_ROUTE, {
    "@/lib/admin-auth": ADMIN_SESSION,
    "@/lib/wallet": {
      grantBalance: async () => ({
        ok: false,
        status: 404,
        code: "user_not_found",
        message: "No account with that id.",
      }),
    },
  });

  const res = await POST(req(VALID_BODY));
  assert.equal(res.status, 404);
  const body = (await res.json()) as Row;
  assert.equal(body.error, "No account with that id.");
});

test("no admin session → 403 before any body is parsed", async () => {
  const { POST } = loadRoute(GRANT_ROUTE, {
    "@/lib/admin-auth": { getAdminSession: async () => null },
    "@/lib/wallet": {
      grantBalance: () => {
        throw new Error("money must not be reachable without a session");
      },
    },
  });

  const res = await POST(req(VALID_BODY));
  assert.equal(res.status, 403);
});
