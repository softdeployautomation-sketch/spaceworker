import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { randomUUID } from "node:crypto";

// TASK_155 P6a (PLAN §19.4) — the ADMIN route behind the platform roster.
//
// WHY A ROUTE TEST AND NOT ONLY MODULE TESTS. hosting-platform-accounts.test.ts
// proves the CRUD/rotation rules of the module; it cannot prove the contracts
// that live between the panel and that module, and every one of those contracts
// fails SILENTLY (an admin clicks, nothing happens, the roster looks broken):
//
//   1. AUTH. This endpoint can add a Cloudflare token to the database. An
//      unauthenticated POST is a credential-dumping endpoint for anyone who
//      finds it. Every handler must start with requireAdminSession().
//   2. "Add and VERIFY" must verify. If POST only writes the row, a typo'd token
//      sits green in the UI until a real deploy rotates onto it at 3am.
//   3. DELETE accepts the id as a JSON BODY (what the panel sends) — an earlier
//      build read only `?id=`, so "Remove" 400'd on every click.
//   4. Re-enabling a row re-verifies it, so a disabled-then-enabled account is
//      never handed to rotation unconfirmed.
//   5. The kill switch rides the same route and must be a separate branch (it is
//      not a row edit) — and the token must never appear in any response body.

(process.env as Record<string, string>).NODE_ENV = "test";
process.env.APP_BASE_URL = "https://spaceworker.test";
process.env.MAILBOX_ENCRYPTION_KEY = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");

const ROUTE = "/app/api/admin/hosting/platform-accounts/route.ts";

let isAdmin = false;
let switchOn = true;
/** Every mutating call the route makes on the platform module, in order. */
let calls: string[] = [];
let settingsWrites: Array<Record<string, unknown>> = [];
/** What Cloudflare reports as the account's live workers.dev subdomain. */
let liveSubdomain: string | null = "myrate619";
/** What WE last stamped on the row. Kept separate so drift is testable. */
let stampedSubdomain: string | null = "myrate619";

const ACCOUNT_VIEW = {
  id: "pa_1",
  accountId: "acct_1",
  label: "Primary",
  tokenHint: "1234",
  priority: 1,
  status: "active",
  lastVerifiedAt: "2026-10-02T00:00:00.000Z",
  verifyError: null,
  createdAt: "2026-10-02T00:00:00.000Z",
};

const fakePlatformAccounts = {
  listPlatformAccounts: async () => [ACCOUNT_VIEW],
  createPlatformAccount: async (input: { accountId: string }) => {
    calls.push("create:" + input.accountId);
    return { ok: true, value: { id: "pa_new" } };
  },
  updatePlatformAccount: async (fields: Record<string, unknown>) => {
    calls.push("update:" + JSON.stringify(fields));
    return { ok: true, value: { ...ACCOUNT_VIEW, ...fields } };
  },
  verifyPlatformAccount: async (id: string) => {
    calls.push("verify:" + id);
    return { ok: true, value: ACCOUNT_VIEW };
  },
  disablePlatformAccount: async (id: string) => {
    calls.push("disable:" + id);
    return { ok: true, value: { ...ACCOUNT_VIEW, status: "disabled" } };
  },
  // TASK_157 Phase 1 — the workers.dev subdomain verbs. Faked rather than exercised
  // for real: these reach Cloudflare, and what needs testing here is the ROUTE's
  // contract (does it authenticate, does it short-circuit the DB patch, does a
  // taken name come back as a clean refusal) — not Cloudflare's answer.
  //
  // The fake mirrors the REAL shape and the real ordering rules of
  // setAccountWorkersDevSubdomain, including its local label validation. That
  // validation lives in the service, so a route test that skipped it would happily
  // "pass" a rename the production code would reject.
  getWorkersDevSubdomainState: async (id: string) => {
    calls.push("getSubdomain:" + id);
    return { ok: true, value: { configured: stampedSubdomain, live: liveSubdomain, needsWorkerToken: false } };
  },
  setAccountWorkersDevSubdomain: async (id: string, subdomain: string) => {
    calls.push("setSubdomain:" + id + ":" + subdomain);
    const name = subdomain.trim().toLowerCase();
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
      return {
        ok: false as const,
        code: "invalid_subdomain" as const,
        message: "Use one DNS label: letters, digits and dashes only.",
        status: 400 as const,
      };
    }
    if (name === "taken") {
      return {
        ok: false as const,
        code: "subdomain_taken" as const,
        message: "That workers.dev subdomain is already taken",
        status: 409 as const,
      };
    }
    liveSubdomain = name;
    stampedSubdomain = name;
    return { ok: true as const, value: { subdomain: name, unchanged: false } };
  },
};

const fakePrisma = {
  hostingSite: { count: async () => 3 },
  adminSetting: {
    upsert: async ({ update }: { update: Record<string, unknown>; create: Record<string, unknown> }) => {
      settingsWrites.push(update ?? {});
      // Mirror the write the way the real singleton setting does, so `payload()`
      // (which re-reads getAdminSettings) reports what was just toggled.
      if (typeof update?.hostingPlatformCfEnabled === "boolean") switchOn = update.hostingPlatformCfEnabled;
      return { id: "singleton", ...update };
    },
  },
};

/** A minimal NextResponse stand-in: the route only ever returns .json(...) bodies. */
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
  if (from.endsWith(ROUTE)) {
    if (request === "next/server") return { NextResponse: fakeNextResponse };
    if (request === "@/lib/admin-auth") return { requireAdminSession: async () => isAdmin };
    if (request === "@/lib/admin-settings")
      return { getAdminSettings: async () => ({ hostingPlatformCfEnabled: switchOn }) };
    if (request === "@/lib/prisma") return { prisma: fakePrisma };
    if (request === "@/lib/hosting/platform-accounts") return fakePlatformAccounts;
  }
  return originalLoad.call(this, request, parent, isMain);
};

/* eslint-disable @typescript-eslint/no-require-imports */
const route = require("../app/api/admin/hosting/platform-accounts/route") as {
  GET: (req?: Request) => Promise<{ status: number; json: () => Promise<unknown> }>;
  POST: (req: Request) => Promise<{ status: number; json: () => Promise<unknown> }>;
  PATCH: (req: Request) => Promise<{ status: number; json: () => Promise<unknown> }>;
  DELETE: (req: Request) => Promise<{ status: number; json: () => Promise<unknown> }>;
};
/* eslint-enable @typescript-eslint/no-require-imports */

const URL_BASE = "https://spaceworker.test/api/admin/hosting/platform-accounts";

function bodyRequest(method: string, body?: unknown, query = ""): Request {
  return new Request(URL_BASE + query, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  isAdmin = false;
  switchOn = true;
  calls = [];
  settingsWrites = [];
  liveSubdomain = "myrate619";
  stampedSubdomain = "myrate619";
});

test("admin route: every handler refuses an anonymous caller", async () => {
  isAdmin = false;

  const get = await route.GET();
  assert.equal(get.status, 403);

  const post = await route.POST(bodyRequest("POST", { accountId: "a", label: "l", token: "t" }));
  assert.equal(post.status, 403);

  const patch = await route.PATCH(bodyRequest("PATCH", { id: "pa_1", priority: 2 }));
  assert.equal(patch.status, 403);

  const del = await route.DELETE(bodyRequest("DELETE", { id: "pa_1" }));
  assert.equal(del.status, 403);

  assert.deepEqual(calls, [], "a rejected request must not touch a single row");
  assert.deepEqual(settingsWrites, [], "…and must not flip the kill switch");
});

test("admin route: GET returns the roster + kill switch, never a token", async () => {
  isAdmin = true;
  const res = await route.GET();
  const payload = (await res.json()) as { enabled: boolean; accounts: Array<Record<string, unknown>> };

  assert.equal(res.status, 200);
  assert.equal(payload.enabled, true, "the panel renders the switch from here");
  assert.equal(payload.accounts.length, 1);
  assert.equal(payload.accounts[0]?.tokenHint, "1234");
  assert.ok(!("token" in payload.accounts[0]!), "the raw token is never in a payload");
  assert.ok(!("tokenCiphertext" in payload.accounts[0]!), "…nor the ciphertext");
});

test("admin route: POST adds AND verifies — \"Add and verify\" cannot lie", async () => {
  isAdmin = true;
  const res = await route.POST(bodyRequest("POST", { accountId: "acct_9", label: "Backup", token: "cf-token-xxxx" }));
  const payload = (await res.json()) as { accounts: Array<Record<string, unknown>> };

  assert.equal(res.status, 201);
  assert.deepEqual(calls, ["create:acct_9", "verify:pa_new"], "create, then verify the row it created");
  assert.equal(payload.accounts[0]?.tokenHint, "1234", "the payload is the fresh roster, not an echo of the POST");
});

test("admin route: POST validates the body — no blank fields", async () => {
  isAdmin = true;
  const res = await route.POST(bodyRequest("POST", { accountId: "", label: "Backup", token: "" }));
  assert.equal(res.status, 400);
  assert.deepEqual(calls, []);
});

test("admin route: PATCH kill switch is its own branch (not a row edit)", async () => {
  isAdmin = true;
  const res = await route.PATCH(bodyRequest("PATCH", { switch: false }));
  const payload = (await res.json()) as { enabled: boolean };

  assert.equal(res.status, 200);
  assert.equal(payload.enabled, false);
  assert.deepEqual(settingsWrites, [{ hostingPlatformCfEnabled: false }]);
  assert.deepEqual(calls, [], "a switch toggle must not look like a row mutation");
});

test("admin route: PATCH reorder sends priority, PATCH verify sends verify", async () => {
  isAdmin = true;
  await route.PATCH(bodyRequest("PATCH", { id: "pa_1", priority: 5 }));
  await route.PATCH(bodyRequest("PATCH", { id: "pa_1", verify: true }));

  assert.equal(calls[0], 'update:{"id":"pa_1","priority":5}');
  assert.equal(calls[1], "verify:pa_1");
});

test("admin route: PATCH re-enable re-verifies, so rotation never gets an unconfirmed token", async () => {
  isAdmin = true;
  const res = await route.PATCH(bodyRequest("PATCH", { id: "pa_1", status: "active" }));

  assert.equal(res.status, 200);
  assert.equal(calls[0], 'update:{"id":"pa_1","status":"active"}');
  assert.equal(calls[1], "verify:pa_1", "the row returns to rotation only after a fresh check");
});

test("admin route: PATCH refuses a payload with nothing actionable", async () => {
  isAdmin = true;
  const res = await route.PATCH(bodyRequest("PATCH", { id: "pa_1", nonsense: 1 }));
  assert.equal(res.status, 400);
  assert.deepEqual(calls, [], "unknown fields are stripped, then refused — never a silent no-op 200");
});

test("admin route: DELETE reads the id from the JSON BODY the panel sends", async () => {
  isAdmin = true;
  const res = await route.DELETE(bodyRequest("DELETE", { id: "pa_1" }));

  assert.equal(res.status, 200);
  assert.deepEqual(calls, ["disable:pa_1"]);
});

test("admin route: DELETE also accepts ?id= for scripts and bookmarks", async () => {
  isAdmin = true;
  const res = await route.DELETE(bodyRequest("DELETE", undefined, "?id=pa_1"));

  assert.equal(res.status, 200);
  assert.deepEqual(calls, ["disable:pa_1"]);
});

test("admin route: DELETE with no id at all is a 400, not a crash", async () => {
  isAdmin = true;
  const res = await route.DELETE(bodyRequest("DELETE"));
  assert.equal(res.status, 400);
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// TASK_157 Phase 1 — the workers.dev account subdomain.
//
// WHY THESE MATTER. The subdomain is the only setting here that renames a LIVE
// account-wide host: every Worker in that account starts answering on a new
// hostname. So the route has to be right about three things — it is a separate
// verb rather than a DB column write, a taken name is refused without a
// half-applied row, and the response reports what CLOUDFLARE confirmed rather
// than what the admin typed.
// ---------------------------------------------------------------------------

test("admin route: GET ?subdomain= reads ONE account's live workers.dev host", async () => {
  isAdmin = true;
  const res = await route.GET(new Request(URL_BASE + "?subdomain=pa_1"));
  const payload = (await res.json()) as {
    workersDevSubdomain: { configured: string | null; live: string | null };
  };

  assert.equal(res.status, 200);
  assert.equal(payload.workersDevSubdomain.live, "myrate619");
  assert.deepEqual(calls, ["getSubdomain:pa_1"], "exactly one live read, and no account-wide sweep");
});

test("admin route: the subdomain read separates what we stamped from what Cloudflare says", async () => {
  isAdmin = true;
  // Simulate an out-of-band rename in the Cloudflare dashboard.
  liveSubdomain = "swdocs";

  const res = await route.GET(new Request(URL_BASE + "?subdomain=pa_1"));
  const payload = (await res.json()) as {
    workersDevSubdomain: { configured: string | null; live: string | null };
  };

  assert.equal(payload.workersDevSubdomain.configured, "myrate619", "the stamp is reported as-is");
  assert.equal(payload.workersDevSubdomain.live, "swdocs", "and so is the truth — the panel can flag the drift");
});

test("admin route: GET without ?subdomain= does NOT pay for a live Cloudflare read", async () => {
  isAdmin = true;
  const res = await route.GET();
  const payload = (await res.json()) as { workersDevSubdomain?: unknown };

  assert.equal(res.status, 200);
  assert.equal(payload.workersDevSubdomain, undefined, "the roster payload omits it entirely");
  assert.deepEqual(calls, [], "reading the panel must not hit Cloudflare on every row");
});

test("admin route: setting a subdomain answers with the LIVE value, not the typed one", async () => {
  isAdmin = true;
  const res = await route.PATCH(
    bodyRequest("PATCH", { id: "pa_1", workersDevSubdomain: "spaceworker" })
  );
  const payload = (await res.json()) as {
    workersDevSubdomain: { configured: string | null; live: string | null };
  };

  assert.equal(res.status, 200);
  assert.equal(payload.workersDevSubdomain.live, "spaceworker");
  assert.equal(
    payload.workersDevSubdomain.configured,
    "spaceworker",
    "the row is stamped with what Cloudflare confirmed"
  );
  assert.deepEqual(
    calls,
    ["setSubdomain:pa_1:spaceworker", "getSubdomain:pa_1"],
    "rename, then re-read — and never the plain DB update path"
  );
});

test("admin route: a TAKEN subdomain is a clean 409 and writes nothing", async () => {
  isAdmin = true;
  const res = await route.PATCH(
    bodyRequest("PATCH", { id: "pa_1", workersDevSubdomain: "taken" })
  );
  const payload = (await res.json()) as { error: string; code: string };

  assert.equal(res.status, 409);
  assert.equal(payload.code, "subdomain_taken");
  assert.ok(payload.error.length > 0, "the panel shows this verbatim, so it must be readable");
  assert.deepEqual(calls, ["setSubdomain:pa_1:taken"], "…and no follow-up read, nothing was changed");
  assert.equal(liveSubdomain, "myrate619", "the live host is unchanged");
});

test("admin route: an anonymous caller cannot rename the account subdomain", async () => {
  isAdmin = false;
  const res = await route.PATCH(
    bodyRequest("PATCH", { id: "pa_1", workersDevSubdomain: "spaceworker" })
  );

  assert.equal(res.status, 403, "this is the guard that matters most here");
  assert.deepEqual(calls, [], "no Cloudflare call and no row write");
  assert.equal(liveSubdomain, "myrate619");
});

test("admin route: renaming requires a non-empty single DNS label", async () => {
  isAdmin = true;

  const empty = await route.PATCH(bodyRequest("PATCH", { id: "pa_1", workersDevSubdomain: "   " }));
  assert.equal(empty.status, 400, "a blank label would produce a .workers.dev host that cannot exist");

  const dotted = await route.PATCH(bodyRequest("PATCH", { id: "pa_1", workersDevSubdomain: "a.b.c" }));
  assert.equal(dotted.status, 400, "this is ONE label, not a hostname");

  // Both refusals happen in the service, but they must still surface as a clean
  // 400 from this route rather than a crash or a 200 that silently did nothing.
  assert.deepEqual(calls, ["setSubdomain:pa_1:   ", "setSubdomain:pa_1:a.b.c"], "nothing was written");
  assert.equal(liveSubdomain, "myrate619", "the live host is untouched");
  assert.equal(stampedSubdomain, "myrate619");
});

test("admin route: the rename is NORMALISED before it reaches Cloudflare", async () => {
  isAdmin = true;
  await route.PATCH(bodyRequest("PATCH", { id: "pa_1", workersDevSubdomain: "  SpaceWorker  " }));

  assert.equal(liveSubdomain, "spaceworker", "trimmed and lowercased, so the host matches what we stamp");
  assert.equal(stampedSubdomain, "spaceworker");
});

test("admin route: an ordinary row edit still takes the plain DB path", async () => {
  isAdmin = true;
  const res = await route.PATCH(bodyRequest("PATCH", { id: "pa_1", priority: 3 }));

  assert.equal(res.status, 200);
  assert.deepEqual(
    calls,
    ["update:{\"id\":\"pa_1\",\"priority\":3}"],
    "adding the subdomain verb must not change how a priority edit behaves"
  );
});
