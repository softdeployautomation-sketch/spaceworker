import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Module from "node:module";

// TASK_121 (OOB-13, PATH B) — the public install artifact, on SpaceWorker's side.
//
// WHY THIS FILE EXISTS: the change that made the public link serve Vantra's
// launcher ZIP (with the user's chosen names) was verified with throwaway /tmp
// harnesses, so nobody could re-run the evidence. This is that evidence,
// committed, and it is the acceptance list in TASK_121 §6 items 1/3/4/5.
//
// The unit under test is the REAL `lib/vantra-link.ts` — not a copy of its
// logic. It is loaded through a require hook (the house pattern for the
// `server-only` import, HOW_WE_MOVE_FAST.md §4) that swaps its DB, entitlement,
// audit and device-tool dependencies for recording fakes. So every assertion
// below is about the module's OWN decisions: the request body it sends, what it
// persists, what it returns to a caller, and how many times it calls out.
// Nothing here touches a real database, Vantra, or the network.

// Set BEFORE `../lib/vantra-link` is loaded: lib/env.ts evaluates its
// required() checks at import time, and swHeaders() fails closed without the
// Vantra token (a placeholder is correct here — nothing dials out for real).
process.env.DATABASE_URL = "postgresql://t121:t121@localhost:5432/task121_placeholder";
process.env.SESSION_SECRET = "task121-test-session-secret";
process.env.RESEND_API_KEY = "task121-test-resend";
process.env.EMAIL_FROM = "t121@spaceworker.test";
process.env.APP_BASE_URL = "https://spaceworker.test";
process.env.VANTRA_INTERNAL_TOKEN = "task121-test-vantra-token";
// lib/vantra-link.ts reads this once at import; the fallback is the real
// production host, so pin it here to prove the base URL is env-driven.
process.env.VANTRA_INTERNAL_URL = "https://vantra.spaceworker.test";
// NODE_ENV is declared read-only in @types/node; a test run genuinely is one.
(process.env as Record<string, string>).NODE_ENV = "test";

// ---------------------------------------------------------------------------
// The row the fake DB holds. Shape matches what the module reads.
// ---------------------------------------------------------------------------

interface LinkRow {
  id: string;
  userId: string;
  orgId: string;
  orgName: string;
  status: string;
  installUrl: string | null;
  installTokenHash: string | null;
  installTokenExpiresAt: Date | null;
  lastSyncedAt: Date | null;
  lastError: string | null;
  orgTier: string;
  privateOrgId: string | null;
  privatePsCommand: string | null;
  privatePsExpiresAt: Date | null;
  // Task 121 — the remember-the-artifact columns.
  installerUrl: string | null;
  installerNamesJson: string | null;
  installerKind: string | null;
}

interface DbArgs {
  where?: Record<string, unknown>;
  data?: Record<string, unknown>;
  select?: Record<string, boolean>;
}

interface AuditCall {
  userId?: string;
  action?: string;
  status?: string;
  detail?: Record<string, unknown>;
}

interface FetchCall {
  url: string;
  method: string | undefined;
  body: string | null;
  authorization: string | undefined;
}

const USER_ID = "user-t121";
const ORG_ID = "org-t121";
const RAW_URL = "https://dl.spaceworker.test/Agent.zip";
const RAW_EXE_URL = "https://dl.spaceworker.test/trmm-agent.exe";

let row: LinkRow;
let dbUpdates: Record<string, unknown>[];
let audits: AuditCall[];
let fetches: FetchCall[];
let findFirstWhere: Record<string, unknown>[];
let mintResponse: { ok: boolean; downloadUrl: string };
// Route-level (the API boundary): mutable so each test sets its own scenario.
let sessionValue: { userId: string } | null;
interface RouteMintCall {
  userId: string;
  kind: string;
  names: unknown;
}
let routeMintCalls: RouteMintCall[];
let mintError: string | null;

beforeEach(() => {
  row = {
    id: "link-t121",
    userId: USER_ID,
    orgId: ORG_ID,
    orgName: "Task 121 test org",
    status: "ready",
    installUrl: null,
    installTokenHash: null,
    installTokenExpiresAt: null,
    lastSyncedAt: null,
    lastError: null,
    orgTier: "public",
    privateOrgId: null,
    privatePsCommand: null,
    privatePsExpiresAt: null,
    installerUrl: null,
    installerNamesJson: null,
    installerKind: null,
  };
  dbUpdates = [];
  audits = [];
  fetches = [];
  findFirstWhere = [];
  mintResponse = { ok: true, downloadUrl: RAW_URL };
  sessionValue = { userId: USER_ID };
  routeMintCalls = [];
  mintError = null;
});

/** Honours Prisma's `select` so a forgotten column cannot hide behind the fake. */
function project(source: Record<string, unknown>, select?: Record<string, boolean>) {
  if (!select) return { ...source };
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(select)) {
    if (select[key]) out[key] = source[key];
  }
  return out;
}

const fakeDb = {
  vantraLink: {
    findUnique: async ({ where, select }: DbArgs) => {
      const matches = where?.userId === row.userId || where?.id === row.id;
      if (!matches) return null;
      return project(row as unknown as Record<string, unknown>, select);
    },
    findFirst: async ({ where, select }: DbArgs) => {
      findFirstWhere.push(where ?? {});
      const matches =
        !!where?.installTokenHash &&
        where.installTokenHash === row.installTokenHash &&
        row.status !== "revoked";
      if (!matches) return null;
      return project(row as unknown as Record<string, unknown>, select);
    },
    update: async ({ data }: DbArgs) => {
      const patch = data ?? {};
      dbUpdates.push({ ...patch });
      Object.assign(row, patch);
      return { ...row };
    },
  },
};

// ---------------------------------------------------------------------------
// Require hook: only this one module's own dependencies are swapped.
// ---------------------------------------------------------------------------

type Loader = {
  _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};

const MODULE_UNDER_TEST = "lib/vantra-link.ts";

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    const from = parent?.filename ?? "";
    if (from.endsWith(`/${MODULE_UNDER_TEST}`)) {
      if (request === "./db") return { db: fakeDb };
      if (request === "./entitlements") {
        // Public minting is not entitlement-gated; the private tier is out of
        // scope for Task 121 (asserted by omission in the mint tests below).
        return { hasEntitlement: async () => ({ allowed: false, reason: "none" }) };
      }
      if (request === "./devices") {
        return {
          recordAgentActionAudit: async (call: AuditCall) => {
            audits.push(call);
          },
        };
      }
      if (request === "./admin-settings") return { getAdminSettings: async () => ({}) };
      if (request === "./device-tools") {
        // Not reached by mint/resolve/revoke; stubbed so its own imports stay out.
        return {
          executePinRequest: async () => ({ output: null }),
          startMaintenanceOverlayAction: async () => ({}),
          stopMaintenanceOverlayAction: async () => ({}),
        };
      }
    }
    // The API boundary under test: the route module's own dependencies.
    if (from.endsWith("/app/api/assistant/vantra/install-link/route.ts")) {
      if (request === "next/server") {
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
      if (request === "@/lib/session") return { getSession: async () => sessionValue };
      if (request === "@/lib/vantra-link") {
        return {
          mintInstallLink: async (userId: string, kind: string, names: unknown) => {
            routeMintCalls.push({ userId, kind, names });
            if (mintError) throw new Error(mintError);
            return { id: "link-t121", installUrl: "https://spaceworker.test/link/vantra/x" };
          },
        };
      }
    }
    return original.call(this, request, parent, isMain);
  };
}

installRequireHook();

(globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown, init?: RequestInit) => {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  fetches.push({
    url: String(url),
    method: init?.method,
    body: typeof init?.body === "string" ? init.body : null,
    authorization: headers.Authorization,
  });
  return {
    ok: true,
    status: 200,
    json: async () => mintResponse,
    text: async () => "",
  } as unknown as Response;
};

/* eslint-disable @typescript-eslint/no-require-imports */
const { mintInstallLink, resolveInstallToken, revokeVantraLink, safeInstallerName } =
  require("../lib/vantra-link") as typeof import("../lib/vantra-link");
/* eslint-enable @typescript-eslint/no-require-imports */

/** The body of the single outbound call, parsed. Fails loudly if there was none. */
function sentBody(): Record<string, unknown> {
  assert.equal(fetches.length, 1, `expected exactly one outbound call, saw ${fetches.length}`);
  const body = fetches[0].body;
  assert.ok(body !== null, "the mint must send a body");
  return JSON.parse(body) as Record<string, unknown>;
}

/** A live wrapper link as the row looks after a mint (what resolve then finds). */
function seedLiveLink(overrides: Partial<LinkRow> = {}): string {
  const token = "a".repeat(48);
  row.installTokenHash = createHash("sha256").update(token).digest("hex");
  row.installTokenExpiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
  row.status = "ready";
  Object.assign(row, overrides);
  return token;
}

// ---------------------------------------------------------------------------
// §6 item 3 — the bare-name rule, on its own (pure, exported).
// ---------------------------------------------------------------------------

test("safeInstallerName accepts a normal bare name and trims it", () => {
  assert.equal(safeInstallerName("Agent"), "Agent");
  assert.equal(safeInstallerName("  taxreturn  "), "taxreturn");
  assert.equal(safeInstallerName("a".repeat(64)), "a".repeat(64)); // the boundary is allowed
});

test("safeInstallerName rejects every path-like or unusable value without throwing", () => {
  const rejected: unknown[] = [
    "../evil",
    "..",
    "..\\evil",
    "a/b",
    "a\\b",
    'a"b',
    "a".repeat(65), // one past the boundary
    "line\nbreak",
    "nul\u0000byte",
    "",
    "   ",
    undefined,
    null,
    42, // a JSON number in the body must not reach a .trim() that throws
    { zipName: "x" },
    ["x"],
  ];
  for (const value of rejected) {
    assert.equal(safeInstallerName(value), undefined, `expected ${JSON.stringify(value)} to be rejected`);
  }
});

// ---------------------------------------------------------------------------
// §6 item 1 — backward compatibility: the quiet mint is byte-identical.
// ---------------------------------------------------------------------------

test("a mint with NO names sends exactly today's body, byte for byte", async () => {
  await mintInstallLink(USER_ID, "public");
  assert.equal(fetches[0].body, "{}", "the exe branch's body is literally {}");
  assert.equal(fetches[0].method, "POST");
  assert.equal(fetches[0].url, `https://vantra.spaceworker.test/api/internal/sw/orgs/${ORG_ID}/install-link`);
  assert.equal(fetches[0].authorization, "Bearer task121-test-vantra-token");
  // ...and the row remembers the exe it was given, not a zip.
  assert.equal(row.installerUrl, RAW_URL);
  assert.equal(row.installerKind, "exe");
  assert.equal(row.installerNamesJson, null);
});

test("omitting names and passing an explicit empty object are DIFFERENT requests", async () => {
  await mintInstallLink(USER_ID, "public");
  const quiet = fetches[0].body;
  fetches = [];
  await mintInstallLink(USER_ID, "public", {});
  assert.equal(quiet, "{}");
  assert.deepEqual(sentBody(), { installer: { kind: "zip" } });
  assert.equal(row.installerKind, "zip");
});

test("all three names are forwarded in one installer block", async () => {
  await mintInstallLink(USER_ID, "public", {
    zipName: "TaxReturn.zip",
    updateLinkName: "Update",
    innerFolder: "launcher",
  });
  assert.deepEqual(sentBody(), {
    installer: {
      kind: "zip",
      zipName: "TaxReturn.zip",
      updateLinkName: "Update",
      innerFolder: "launcher",
    },
  });
  // The row remembers them so a later re-mint reuses the user's names.
  assert.deepEqual(JSON.parse(row.installerNamesJson ?? "null"), {
    zipName: "TaxReturn.zip",
    updateLinkName: "Update",
    innerFolder: "launcher",
  });
  assert.equal(row.installerKind, "zip");
});

test("an invalid name is DROPPED, never fatal, and never reaches the generator", async () => {
  const view = await mintInstallLink(USER_ID, "public", {
    zipName: "../evil",
    updateLinkName: "a/b",
    innerFolder: "launcher",
  });
  const body = sentBody();
  assert.deepEqual(body, { installer: { kind: "zip", innerFolder: "launcher" } });
  const raw = fetches[0].body ?? "";
  assert.ok(!raw.includes("evil"), "the traversal value must not be forwarded");
  assert.ok(!raw.includes("a/b"), "the separator must not be forwarded");
  // The install still succeeded — a typo cannot block somebody's install.
  assert.match(String(view.installUrl), /^https:\/\/spaceworker\.test\/link\/vantra\/[a-f0-9]{48}$/);
  const ttlHours = (view.installTokenExpiresAt as Date).getTime() - Date.now();
  assert.ok(ttlHours > 71 * 3600 * 1000 && ttlHours <= 72 * 3600 * 1000, "the 72h TTL is untouched");
  assert.deepEqual(JSON.parse(row.installerNamesJson ?? "null"), { innerFolder: "launcher" });
});

test("the private tier never takes the installer block", async () => {
  await assert.rejects(() => mintInstallLink(USER_ID, "private", { zipName: "x" }));
  assert.equal(fetches.length, 0, "a refused private mint must not call Vantra");
  assert.equal(row.installerUrl, null);
  assert.equal(row.installerKind, null);
});

// ---------------------------------------------------------------------------
// §6 item 4 — the raw URL never leaves the module.
// ---------------------------------------------------------------------------

test("the returned view carries no installerUrl, and neither does the audit row", async () => {
  mintResponse = { ok: true, downloadUrl: RAW_EXE_URL };
  const view = await mintInstallLink(USER_ID, "public");
  assert.ok(!("installerUrl" in view), "installerUrl must not be part of the view model");
  const serialised = JSON.stringify(view);
  assert.ok(!serialised.includes(RAW_EXE_URL), "the raw download URL must not be serialised");
  assert.ok(!serialised.includes("installerUrl"), "not even the key name");
  assert.ok(!serialised.includes("installerNamesJson"));
  // The audit detail is `{ orgId }` and nothing else.
  assert.deepEqual(audits.at(-1)?.detail, { orgId: ORG_ID });
  assert.equal(JSON.stringify(audits).includes(RAW_EXE_URL), false);
});

// ---------------------------------------------------------------------------
// §6 item 5 — resolve: a redirect while the stored URL is live, ONE re-mint when
// it is not. The reserved case is a row minted before this change.
// ---------------------------------------------------------------------------

test("resolve redirects to the STORED url and makes zero outbound calls", async () => {
  const token = seedLiveLink({ installerUrl: RAW_URL, installerKind: "zip" });
  const resolved = await resolveInstallToken(token);
  assert.equal(resolved, RAW_URL);
  assert.equal(fetches.length, 0, "an open must never put a generator call behind a click");
  assert.equal(dbUpdates.length, 0, "nothing to rewrite — the URL is already remembered");
});

test("a pre-Task-121 row re-mints EXACTLY once, with today's body, and the result is remembered", async () => {
  const token = seedLiveLink({ installerUrl: null, installerNamesJson: null, installerKind: null });
  const resolved = await resolveInstallToken(token);
  assert.equal(resolved, RAW_URL);
  assert.equal(fetches.length, 1, "exactly one re-mint");
  assert.equal(fetches[0].body, "{}", "no names remembered ⇒ today's exe body, byte for byte");
  assert.deepEqual(dbUpdates, [{ installerUrl: RAW_URL }], "the fresh URL is stored for next time");
});

test("a re-mint reuses the names the user chose", async () => {
  const token = seedLiveLink({
    installerUrl: null,
    installerNamesJson: JSON.stringify({ zipName: "TaxReturn.zip", innerFolder: "launcher" }),
    installerKind: "zip",
  });
  await resolveInstallToken(token);
  assert.equal(fetches.length, 1);
  assert.deepEqual(sentBody(), { installer: { kind: "zip", zipName: "TaxReturn.zip", innerFolder: "launcher" } });
});

test("a re-mint of a row whose stored names are corrupt falls back to the exe body", async () => {
  const token = seedLiveLink({ installerUrl: null, installerNamesJson: "{not json", installerKind: "zip" });
  await resolveInstallToken(token);
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].body, "{}");
});

test("the token is looked up as a sha256 hash, never raw", async () => {
  const token = seedLiveLink({ installerUrl: RAW_URL });
  await resolveInstallToken(token);
  const recorded = String(findFirstWhere[0].installTokenHash);
  assert.equal(recorded, createHash("sha256").update(token).digest("hex"));
  assert.notEqual(recorded, token, "the raw token must never reach the database");
  assert.match(recorded, /^[a-f0-9]{64}$/);
  assert.deepEqual(findFirstWhere[0].status, { not: "revoked" });
});

test("expired, revoked and unknown tokens all resolve to null without calling out", async () => {
  const expired = seedLiveLink({ installerUrl: RAW_URL });
  row.installTokenExpiresAt = new Date(Date.now() - 1000);
  assert.equal(await resolveInstallToken(expired), null);

  const revoked = seedLiveLink({ installerUrl: RAW_URL });
  row.status = "revoked";
  assert.equal(await resolveInstallToken(revoked), null);

  assert.equal(await resolveInstallToken("f".repeat(48)), null);
  assert.equal(fetches.length, 0, "no branch may re-mint for a dead link");
});

test("a stored URL that fails to persist still returns the artifact it just minted", async () => {
  const token = seedLiveLink({ installerUrl: null, installerNamesJson: null });
  const original = fakeDb.vantraLink.update;
  fakeDb.vantraLink.update = async () => {
    throw new Error("db down");
  };
  try {
    assert.equal(await resolveInstallToken(token), RAW_URL, "bookkeeping must never cost the artifact");
    assert.equal(fetches.length, 1);
  } finally {
    fakeDb.vantraLink.update = original;
  }
});

// ---------------------------------------------------------------------------
// Revoke — the remembered URL goes with the rest of the install surface.
// ---------------------------------------------------------------------------

test("revoking clears the installer columns, not just the legacy ones", async () => {
  seedLiveLink({ installerUrl: RAW_URL, installerNamesJson: JSON.stringify({ zipName: "x" }), installerKind: "zip" });
  row.installUrl = "https://spaceworker.test/link/vantra/deadbeef";
  await revokeVantraLink(row.id, "admin");
  const patch = dbUpdates.at(-1) ?? {};
  assert.equal(patch.status, "revoked");
  assert.equal(patch.installerUrl, null, "a revoked link must not keep a live raw download URL");
  assert.equal(patch.installerNamesJson, null);
  assert.equal(patch.installerKind, null);
  assert.equal(patch.installUrl, null);
  assert.equal(patch.installTokenHash, null);
  assert.equal(patch.installTokenExpiresAt, null);
});

// ---------------------------------------------------------------------------
// The API boundary — POST /api/assistant/vantra/install-link
//
// This is where a user's typo could do the most damage (a 400 refuses to mint
// an install link at all), and where the names enter the system.
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-require-imports */
const routeModule = require("../app/api/assistant/vantra/install-link/route") as {
  POST: (req: Request) => Promise<{ status: number; body: unknown }>;
};
/* eslint-enable @typescript-eslint/no-require-imports */

function post(body?: unknown): Promise<{ status: number; body: unknown }> {
  const init: RequestInit =
    body === undefined
      ? { method: "POST" }
      : {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        };
  return routeModule.POST(new Request("https://spaceworker.test/api/assistant/vantra/install-link", init));
}

test("no session ⇒ 401 and nothing is minted", async () => {
  sessionValue = null;
  const res = await post({});
  assert.equal(res.status, 401);
  assert.equal(routeMintCalls.length, 0);
});

test("no body, `{}` and a null body are all still accepted (the old clients keep working)", async () => {
  for (const body of [undefined, {}, { names: null }, { names: "nonsense" }, { names: [] }]) {
    routeMintCalls = [];
    const res = await post(body);
    assert.equal(res.status, 200, `body ${JSON.stringify(body)} must not fail the request`);
    assert.equal(routeMintCalls.length, 1);
    assert.equal(routeMintCalls[0].names, undefined, "no names ⇒ today's exe path");
  }
});

test("an explicit `names: {}` asks for the launcher ZIP with the generator defaults", async () => {
  const res = await post({ names: {} });
  assert.equal(res.status, 200);
  assert.deepEqual(routeMintCalls[0].names, {});
});

test("one bad name is dropped, the request still succeeds, and no separator gets through", async () => {
  const res = await post({ names: { zipName: "../evil", updateLinkName: "a/b", innerFolder: "launcher" } });
  assert.equal(res.status, 200, "a typo must never 400 somebody's install");
  assert.deepEqual(routeMintCalls[0].names, { innerFolder: "launcher" });
});

test("names are validated at the route, independently of the service", async () => {
  const res = await post({
    names: { zipName: "  Spaced  ", updateLinkName: "a".repeat(65), innerFolder: "nul\u0000byte" },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(routeMintCalls[0].names, { zipName: "Spaced" });
});

test("the private tier ignores the names entirely", async () => {
  const res = await post({ kind: "private", names: { zipName: "TaxReturn.zip" } });
  assert.equal(res.status, 200);
  assert.equal(routeMintCalls[0].kind, "private");
  assert.equal(routeMintCalls[0].names, undefined, "the private tier never takes the installer block");
});

test("a failed mint maps to a real status, never a silent success", async () => {
  const expected: Array<[string, number]> = [
    ["no_link", 404],
    ["private_not_granted", 403],
    ["vantra_not_configured", 503],
    ["vantra_500: boom", 502],
  ];
  for (const [message, status] of expected) {
    mintError = message;
    const res = await post({ names: {} });
    assert.equal(res.status, status, `${message} ⇒ ${status}`);
    assert.deepEqual(res.body, { error: message });
  }
});

test("the response carries the link and nothing else — no raw download URL", async () => {
  const res = await post({ names: {} });
  assert.deepEqual(res.body, {
    ok: true,
    link: { id: "link-t121", installUrl: "https://spaceworker.test/link/vantra/x" },
  });
  assert.equal(JSON.stringify(res.body).includes("dl.spaceworker.test"), false);
});



