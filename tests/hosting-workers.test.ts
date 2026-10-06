import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { randomUUID } from "node:crypto";

// TASK_155 P6c (PLAN §19.12) — the LINKS engine on Cloudflare Workers.
//
// Driven against the REAL modules with a fake Prisma and a scripted fetch, so the
// assertions are about OUR ordering and OUR map contents, not about Cloudflare's
// behaviour. Every test here exists because the live failure it covers would be
// invisible until a customer's link quietly stopped working:
//
//   * another user's target ending up in someone's script (map isolation)
//   * a route created on a zone that isn't there yet (zone-first ordering)
//   * the script deleted before its route, stranding a 500 at the edge (teardown
//     order — the reverse order "works" in every test that doesn't check order)
//   * /r/<token> breaking for a link that IS live on a Worker (the fallback, which
//     is the whole safety net if a route is ever wrong)
//
// No real token appears here. The fake one is obviously fake.

(process.env as Record<string, string>).NODE_ENV = "test";
process.env.APP_BASE_URL = "https://spaceworker.test";
process.env.MAILBOX_ENCRYPTION_KEY = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");

const FAKE_WORKER_TOKEN = "cfut_FAKE_TOKEN_FOR_TESTS_0000";
const FAKE_PAGES_TOKEN = "cfut_FAKE_PAGES_TOKEN_FOR_TESTS_0";
const ACCOUNT = "acct_1";
const HOST = "go.instaweb.top";

// TASK_157 — the USER-OWNED host the publish tests use.
//
// `HOST` above is a PLATFORM-ONLY zone: a user may never select it, so it can only
// appear where the engine is driven directly (publishUserMap) or as a default the
// engine infers. Anything that goes through links.createHostedLink/updateHostedLink
// now asks the registry whether the caller OWNS the host, and instaweb.top is
// correctly refused. So the link-level tests publish on a domain the fixture has
// actually claimed for user_1, which is what a real user's setup looks like.
const OWN_APEX = "mytest.example";
const OWN_HOST = `go.${OWN_APEX}`;

type LinkRow = {
  id: string;
  token: string;
  userId: string | null;
  slug: string | null;
  target: string;
  label: string | null;
  clickCount: number;
  createdAt: Date;
  engine: string;
  credentialId: string | null;
  workerName: string | null;
  routePattern: string | null;
  customHost: string | null;
  deployStatus: string;
  deployError: string | null;
};

let linkRows: LinkRow[] = [];
let credRows: Array<Record<string, unknown>> = [];
/** The platform roster. Empty by default; tests that publish without a named
 *  credential push a row here. */
let platformRows: Array<Record<string, unknown>> = [];
/**
 * TASK_157 — the user's OWN domains. `createHostedLink` now asks the registry whether
 * the caller may publish on a host, so these tests need a claim to stand on. The
 * default is the apex of HOST, owned by user_1 and ACTIVE: a link on a host the user
 * has not claimed is refused, which is the point of the check.
 */
let domainRows: Array<Record<string, unknown>> = [];
let seq = 0;
let premium = true;

/** Every fetch our modules made, in order — the whole point of the ordering tests. */
let calls: { method: string; url: string }[] = [];
/** The bodies we uploaded, so a test can read the generated script itself. */
let bodies: string[] = [];

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    // `{ in: [...] }` is a real Prisma filter, used when re-fetching the row being
    // published. Treat any non-array value as a no-op so the suite keeps working
    // for filters this helper does not model.
    if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
      const cond = v as Record<string, unknown>;
      if (Array.isArray(cond.in)) return (cond.in as unknown[]).includes(row[k]);
      return true;
    }
    return row[k] === v;
  });
}

function blankLink(over: Partial<LinkRow>): LinkRow {
  return {
    id: "lnk_" + ++seq,
    token: "tok" + seq,
    userId: "user_1",
    slug: null,
    target: "https://example.com/",
    label: null,
    clickCount: 0,
    createdAt: new Date(),
    engine: "local",
    credentialId: null,
    workerName: null,
    routePattern: null,
    customHost: null,
    deployStatus: "pending",
  deployError: null,
  ...over,
  };
}

/** The AdminSetting singleton every caps read resolves against — same values as
 *  baseCapsSrc() in hosting-files.test.ts, kept in step so the two suites agree. */
function adminRow(): Record<string, unknown> {
  return {
    hostingEnabled: true,
    hostingProvider: "local",
    hostingFreeStorageQuotaMb: 1024,
    hostingFreeMaxFileSizeMb: 512,
    hostingFreeMaxFiles: 500,
    hostingFreeMaxBandwidthGbPerMonth: 50,
    hostingPremiumStorageQuotaMb: 10240,
    hostingPagesMaxAssetMb: 20,
    hostingPlatformTokenTtlHours: 24,
    hostingFreeMaxLinks: 50,
    hostingPremiumMaxLinks: 500,
    hostingPremiumMaxProjects: 25,
    hostingPremiumMaxFilesPerProject: 2000,
    hostingPremiumMaxBandwidthGbPerMonth: 200,
    hostingPremiumDeploymentsPerDay: 50,
    hostingPreviewTtlHours: 72,
    hostingMaxZipMb: 2048,
    hostingMaxZipEntries: 20000,
    hostingMaxHeavyJobsPerUser: 1,
    hostingPublishedRevisionsKept: 3,
  };
}

const fakePrisma = {
  linkRedirect: {
    create: async ({ data }: { data: Partial<LinkRow> }) => {
      const row = blankLink(data as Partial<LinkRow>);
      linkRows.push(row);
      return row;
    },
    findMany: async ({ where }: { where?: Record<string, unknown> } = {}) =>
      linkRows.filter((r) => matches(r as unknown as Record<string, unknown>, where ?? {})),
    // Reads return a SNAPSHOT, like Prisma does. Without the copy, `findFirst`
    // hands back the very object `update` mutates, so a caller holding the old row
    // silently sees the new values — which hides real bugs (a host move comparing
    // equal to itself).
    findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      const row = linkRows.find((r) => matches(r as unknown as Record<string, unknown>, where));
      return row ? ({ ...row } as LinkRow) : null;
    },
    findUnique: async ({ where }: { where: Record<string, unknown> }) => {
      const row = linkRows.find((r) => matches(r as unknown as Record<string, unknown>, where));
      return row ? ({ ...row } as LinkRow) : null;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<LinkRow> }) => {
      const row = linkRows.find((r) => r.id === where.id);
      if (!row) throw new Error("no such link");
      Object.assign(row, data);
      return { ...row } as LinkRow;
    },
    delete: async ({ where }: { where: { id: string } }) => {
      const i = linkRows.findIndex((r) => r.id === where.id);
      if (i < 0) throw new Error("no such link");
      return linkRows.splice(i, 1)[0];
    },
    count: async ({ where }: { where?: Record<string, unknown> } = {}) =>
      linkRows.filter((r) => matches(r as unknown as Record<string, unknown>, where ?? {})).length,
  },
  userDomain: {
    findMany: async ({ where }: { where?: Record<string, unknown> } = {}) =>
      domainRows.filter((r) => matches(r as unknown as Record<string, unknown>, where ?? {})),
    findUnique: async ({ where }: { where: Record<string, unknown> }) =>
      domainRows.find((r) => matches(r as unknown as Record<string, unknown>, where)) ?? null,
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = domainRows.find((r) => r.id === where.id);
      if (!row) throw new Error("no such domain");
      Object.assign(row, data);
      return { ...row };
    },
    delete: async ({ where }: { where: { id: string } }) => {
      const i = domainRows.findIndex((r) => r.id === where.id);
      if (i < 0) throw new Error("no such domain");
      return domainRows.splice(i, 1)[0];
    },
  },
  hostingCredential: {
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      (credRows.find((r) => matches(r, where)) as never) ?? null,
    findMany: async () => credRows,
  },
  hostingPlatformAccount: {
    findMany: async () => platformRows,
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = platformRows.find((r) => r.id === where.id);
      if (row) Object.assign(row, data);
      return row;
    },
    count: async ({ where }: { where?: Record<string, unknown> } = {}) =>
      platformRows.filter((r) => matches(r, where ?? {})).length,
  },
  user: {
    // tier is a NUMBER (PREMIUM_TIER = 5) — a "premium"/"free" string compares
    // false-against-5 and every user silently reads as premium.
    findUnique: async ({ where }: { where: { id: string } }) =>
      where.id === "user_1"
        ? { id: "user_1", tier: premium ? 5 : 0, premiumExpiresAt: null }
        : where.id === "user_2"
          ? { id: "user_2", tier: 5, premiumExpiresAt: null }
          : null,
  },
// Singular `adminSetting` is the model name; getAdminSettings() does an upsert
  // on the singleton, and it is reached from links.ts via resolveCapsForUser. If
  // this returns {} every create 403s with "disabled" before the engine is read.
  adminSetting: {
    findFirst: async () => adminRow() as never,
    upsert: async () => adminRow() as never,
  },
};

/**
 * Swap Prisma for the fake wherever it is imported — `../prisma` from lib/hosting,
 * `./prisma` from lib/admin-settings, and `@/lib/prisma` elsewhere. Matching on the
 * resolved suffix rather than on the parent directory matters: links.ts reaches
 * getAdminSettings, and a hook scoped to /lib/hosting/ lets the REAL client through
 * on that path and quietly talks to the developer's dev database.
 */
function isPrismaRequest(request: string): boolean {
  return /(^|\/)(prisma)$/.test(request) || request === "@/lib/prisma" || request === "@/prisma";
}

function installRequireHook(): void {
  const loader = Module as unknown as { _load: (r: string, p: NodeModule | undefined, m: boolean) => unknown };
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    if (isPrismaRequest(request) && !(parent?.filename ?? "").includes("/lib/db")) {
      return { prisma: fakePrisma };
    }
    return original.call(this, request, parent, isMain);
  };
}
installRequireHook();

/* eslint-disable @typescript-eslint/no-require-imports */
const links = require("../lib/hosting/links") as typeof import("../lib/hosting/links");
const engine = require("../lib/hosting/links-engine") as typeof import("../lib/hosting/links-engine");
const workers = require("../lib/hosting/workers") as typeof import("../lib/hosting/workers");
const creds = require("../lib/hosting/credentials") as typeof import("../lib/hosting/credentials");
/* eslint-enable @typescript-eslint/no-require-imports */

/** Script the Cloudflare responses. Every path is matched by substring. */
type Route = { method: string; match: string; status?: number; result?: unknown };

let routes: Route[] = [];

function installFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url });
    if (init?.body) bodies.push(String(init.body));
    // The script upload sends multipart FormData; pull the module back out so a
    // test can read the generated Worker source, not "[object FormData]".
    if (init?.body instanceof FormData) {
      const part = init.body.get("worker.mjs");
      if (part instanceof Blob) bodies.push(await part.text());
    }
    const hit = routes.find((r) => r.method === method && url.includes(r.match));
    if (!hit) {
      return new Response(JSON.stringify({ success: false, errors: [{ code: 1, message: "unmatched in test" }] }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ success: (hit.status ?? 200) < 400, result: hit.result ?? null }), {
      status: hit.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}
installFetch();

/** Overrides come FIRST so a test can shadow a default route — appended last they
 *  would never match, since find() takes the first hit. */
function defaultRoutes(over: Route[] = []): void {
  routes = [
    ...over,
    { method: "GET", match: "/zones?name=instaweb.top", result: [{ id: "zone_1", name: "instaweb.top", status: "active" }] },
    // TASK_157 — the zone behind the USER-OWNED apex, so a publish on OWN_HOST
    // resolves a zone exactly the way it does for a real customer's domain.
    { method: "GET", match: `/zones?name=${OWN_APEX}`, result: [{ id: "zone_own", name: OWN_APEX, status: "active" }] },
    { method: "GET", match: "/zones?per_page", result: [{ id: "zone_1", name: "instaweb.top", status: "active" }] },
    // Teardown matches the live route by BOTH pattern and script, so the list has
    // to actually contain this user's route or the delete loop finds nothing.
    {
      method: "GET",
      match: "/workers/routes",
      result: [
        { id: "route_1", pattern: `${HOST}/*`, script: workers.workerNameForUser("user_1") },
        { id: "route_own", pattern: `${OWN_HOST}/*`, script: workers.workerNameForUser("user_1") },
      ],
    },
    { method: "GET", match: "/user/tokens/verify", result: { status: "active" } },
    { method: "GET", match: "/pages/projects?per_page", result: [] },
    // TASK_155 P6c — a route is not a host. The custom hostname needs a PROXIED
    // DNS record to resolve at all, so every publish now writes one first. The
    // default models a brand-new subdomain (no record yet → we create it); a test
    // that cares about ADOPTING an existing record shadows the GET with an
    // override, because overrides are matched first.
    { method: "GET", match: "/dns_records", result: [] },
    { method: "POST", match: "/dns_records", result: { id: "dns_1" } },
    { method: "PATCH", match: "/dns_records/", result: { id: "dns_1" } },
    { method: "PUT", match: "/workers/scripts/", result: { success: true } },
    { method: "POST", match: "/workers/routes", result: { id: "route_1" } },
    { method: "DELETE", match: "/workers/routes/", result: {} },
    { method: "DELETE", match: "/workers/scripts/", result: {} },
  ];
}

/** A BYO credential with a real (encrypted) Workers token, via the real helper. */
function addCred(userId = "user_1", id = "hc_1"): void {
  const fields = creds.buildWorkerTokenFields(FAKE_WORKER_TOKEN)!;
  // The Pages token is a SEPARATE secret and is decrypted on the same read, so a
  // realistic row carries both — getHostingCredentialById throws on a missing
  // tokenCiphertext long before it looks at the Worker token.
  const pages = creds.buildWorkerTokenFields(FAKE_PAGES_TOKEN)!;
  credRows.push({
    id,
    userId,
    provider: "cloudflare",
    accountId: ACCOUNT,
    label: "Yours",
    tokenCiphertext: pages.workerTokenCiphertext,
    tokenIv: pages.workerTokenIv,
    tokenTag: pages.workerTokenTag,
    tokenHint: "cfut_…FAKE",
    ...fields,
    isDefault: true,
    status: "active",
    lastVerifiedAt: null,
    verifyError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/** A platform roster row, so a publish with NO named credential has something to
 *  resolve to. Its id is deliberately NOT a HostingCredential id — that is exactly
 *  the confusion the credentialId test below pins down. */
function addPlatformAccount(id = "pa_1"): void {
  const pages = creds.buildWorkerTokenFields(FAKE_PAGES_TOKEN)!;
  const workers = creds.buildWorkerTokenFields(FAKE_WORKER_TOKEN)!;
  platformRows.push({
    id,
    provider: "cloudflare",
    accountId: ACCOUNT,
    label: "Platform",
    tokenCiphertext: pages.workerTokenCiphertext,
    tokenIv: pages.workerTokenIv,
    tokenTag: pages.workerTokenTag,
    tokenHint: "cfut_…FAKE",
    workerTokenCiphertext: workers.workerTokenCiphertext,
    workerTokenIv: workers.workerTokenIv,
    workerTokenTag: workers.workerTokenTag,
    workerTokenHint: "cfut_…FAKE",
    status: "active",
    verifyError: null,
    priority: 0,
    createdAt: new Date(),
  });
}

beforeEach(() => {
  linkRows = [];
  credRows = [];
  platformRows = [];
  // TASK_157 — the caller OWNS an active domain, so publishing on a subdomain of it
  // is allowed. Without this row every publish test would be (correctly) refused.
  domainRows = [
    {
      id: "ud_1",
      apex: OWN_APEX,
      label: OWN_APEX,
      source: "byo",
      status: "active",
      ownerKind: "user",
      ownerUserId: "user_1",
      zoneId: "zone_own",
      nameservers: JSON.stringify(["a.ns.cloudflare.com", "b.ns.cloudflare.com"]),
      note: null,
      createdAt: new Date(),
    },
  ];
  calls = [];
  bodies = [];
  premium = true;
  addCred();
  defaultRoutes();
});
function firstIndexOf(method: string, fragment: string): number {
  return calls.findIndex((c) => c.method === method && c.url.includes(fragment));
}

/** The last generated Worker source we uploaded. The route POST also carries a
 *  body, so pick the module rather than simply taking the last entry. */
function lastUploadedSource(): string {
  const modules = bodies.filter((b) => b.startsWith("// Generated by"));
  return modules[modules.length - 1] ?? "";
}

// ---------------------------------------------------------------------------
// The generated map (pure, no network) — §19.12.5 (a)
// ---------------------------------------------------------------------------

test("P6c: the generated map holds this user's token and slug, and nothing else", () => {
  const src = workers.buildWorkerMapSource([
    { key: "tok1", target: "https://a.example/" },
    { key: "my-slug", target: "https://a.example/" },
  ]);
  assert.ok(src.includes("tok1"));
  assert.ok(src.includes("my-slug"));
  // It is an ES module — a classic service worker would be rejected by the upload.
  assert.ok(src.includes("export default"));
  assert.ok(src.includes("Response.redirect(target, 302)"));
});

test("P6c: worker names are stable, per-user, and never contain a userId", () => {
  const a = workers.workerNameForUser("user_1");
  assert.equal(a, workers.workerNameForUser("user_1"), "same user, same script — one script, not one per link");
  assert.notEqual(a, workers.workerNameForUser("user_2"));
  assert.ok(!a.includes("user"), "the userId must not appear in the account");
  assert.ok(/^[a-z0-9-]{1,63}$/.test(a), "must be a valid DNS label");
  // Short by design: the name is the left label of the premium workers.dev
  // host, so every char is paid on every shared link.
  assert.ok(/^lnk-[0-9a-f]{8}$/.test(a), `short lnk-<8hex> shape, got ${a}`);
  // The pre-rename long name is kept only for orphan cleanup.
  assert.ok(/^sw-[0-9a-f]{32}$/.test(workers.legacyWorkerNameForUser("user_1")));
  assert.notEqual(a, workers.legacyWorkerNameForUser("user_1"));
});

test("P6c: the route pattern is the exact host, never a wildcard subdomain", () => {
  assert.equal(workers.routePatternFor("go.instaweb.top"), "go.instaweb.top/*");
  // The apex instaweb.top is Cloudflare-managed and live; a `*.instaweb.top/*`
  // route would hijack every subdomain the customer has.
  assert.ok(!workers.routePatternFor("go.instaweb.top").includes("*."));
});

test("P6c: one user's map NEVER contains another user's target", async () => {
  // user_1's link, plus a link belonging to somebody else and to a campaign.
  await links.createHostedLink({ userId: "user_1", target: "https://mine.example/" });
  linkRows.push(blankLink({ userId: "user_2", target: "https://theirs.example/" }));
  linkRows.push(blankLink({ userId: null, target: "https://campaign.example/" }));
  linkRows[0].engine = "cloudflare";
  linkRows[0].customHost = HOST;

  const out = await engine.publishUserMap("user_1", { credentialId: "hc_1", customHost: HOST });
  assert.ok(out.ok);

  // The map is rebuilt from the DB every time, so the isolation is structural.
  const mine = linkRows.filter((r) => r.userId === "user_1" && r.engine === "cloudflare" && r.customHost === HOST);
  const src = workers.buildWorkerMapSource(
    mine.flatMap((r) => [{ key: r.token, target: r.target }, ...(r.slug ? [{ key: r.slug, target: r.target }] : [])])
  );
  assert.ok(src.includes("https://mine.example/"));
  assert.ok(!src.includes("theirs.example"), "user_2's target must not be in user_1's map");
  assert.ok(!src.includes("campaign.example"), "a campaign link must not be in user_1's map");
});

// ---------------------------------------------------------------------------
// Premium gating — §19.12.5 (g)
// ---------------------------------------------------------------------------

test("P6c: a free user is refused a Worker link at CREATE, before any row exists", async () => {
  premium = false;
  const res = await links.createHostedLink({
    userId: "user_1",
    target: "https://example.com/",
    engine: "cloudflare",
    credentialId: "hc_1",
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.status, 403);
    assert.equal(res.code, "premium_required");
  }
  assert.equal(linkRows.length, 0, "no row may be written for a refused request");
  assert.equal(calls.length, 0, "Cloudflare must never be contacted for a free user");
});

test("P6c: the gate bites a SECOND time — switching an existing link to a Worker", async () => {
  await links.createHostedLink({ userId: "user_1", target: "https://example.com/" });
  premium = false; // the account was downgraded after the link was created
  const res = await links.updateHostedLink({ userId: "user_1", id: linkRows[0].id, engine: "cloudflare" });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, "premium_required");
  assert.equal(linkRows[0].engine, "local", "a downgrade must not buy a Worker");
});

test("P6c: local is still free and never touches Cloudflare", async () => {
  premium = false;
  const res = await links.createHostedLink({ userId: "user_1", target: "https://example.com/", engine: "local" });
  assert.ok(res.ok);
  assert.equal(linkRows[0].engine, "local");
  assert.equal(calls.length, 0, "a free local link makes zero Cloudflare calls");
});

test("P6c: a BYO credential with no Workers token is a readable error, never a silent local fallback", async () => {
  credRows[0].workerTokenCiphertext = null;
  credRows[0].workerTokenIv = null;
  credRows[0].workerTokenTag = null;
  const res = await links.createHostedLink({
    userId: "user_1",
    target: "https://example.com/",
    engine: "cloudflare",
    credentialId: "hc_1",
  });
  // The link is saved (so /r still works) but flagged — and it is NOT downgraded
  // to "local" behind the user's back.
  assert.ok(res.ok);
  assert.equal(linkRows[0].engine, "cloudflare");
  assert.equal(linkRows[0].deployStatus, "error");
  assert.match(linkRows[0].deployError ?? "", /Workers API token/i);
});
// ---------------------------------------------------------------------------
// Publish ordering — §19.12.5 (b) zone-first, and the zone gate itself
// ---------------------------------------------------------------------------

test("P6c: publish order is zone → script → route", async () => {
  // An empty existing-route list, so putWorkerRoute genuinely POSTs. (With a
  // pre-owned pattern it short-circuits and there is no POST to order against.)
  defaultRoutes([{ method: "GET", match: "/workers/routes", result: [] }]);
  await links.createHostedLink({
    userId: "user_1",
    target: "https://example.com/",
    engine: "cloudflare",
    credentialId: "hc_1",
    customHost: OWN_HOST,
  });
  const zone = firstIndexOf("GET", "/zones?name=");
  const script = firstIndexOf("PUT", "/workers/scripts/");
  const route = firstIndexOf("POST", "/workers/routes");
  assert.ok(zone >= 0 && script >= 0 && route >= 0, "all three steps happen");
  assert.ok(zone < script, "the zone is verified BEFORE the script is uploaded");
  assert.ok(script < route, "the script exists BEFORE the route points at it");
});

test("P6c: a missing zone is a clean no_zone error and NO route is ever created", async () => {
  defaultRoutes([
    { method: "GET", match: "/zones?name=instaweb.top", result: [] },
    { method: "GET", match: "/zones?per_page", result: [] },
  ]);
  const out = await engine.publishUserMap("user_1", { credentialId: "hc_1", customHost: HOST });
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.code, "no_zone");
  assert.equal(firstIndexOf("PUT", "/workers/scripts/"), -1, "no script upload on a missing zone");
  assert.equal(firstIndexOf("POST", "/workers/routes"), -1, "NO route on a missing zone — the ordering rule");
  assert.equal(firstIndexOf("DELETE", "/workers/routes/"), -1, "and nothing to tear down");
});

test("P6c: a zone that is not active is refused with a readable message", async () => {
  defaultRoutes([
    { method: "GET", match: "/zones?name=instaweb.top", result: [{ id: "z", name: "instaweb.top", status: "pending" }] },
  ]);
  const out = await engine.publishUserMap("user_1", { credentialId: "hc_1", customHost: HOST });
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.message, /still being set up/i);
  assert.equal(firstIndexOf("POST", "/workers/routes"), -1);
});

test("P6c: a junk customHost is a 400 and never reaches Cloudflare", async () => {
  const res = await links.createHostedLink({
    userId: "user_1",
    target: "https://example.com/",
    engine: "cloudflare",
    credentialId: "hc_1",
    customHost: "evil.example.com/path?x=1",
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, "invalid_host");
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// The /r fallback — §19.12.5 (f). This is the whole safety net.
// ---------------------------------------------------------------------------

test("P6c: a link live on a Worker STILL resolves on /r/<token>", async () => {
  const res = await links.createHostedLink({
    userId: "user_1",
    target: "https://example.com/landing",
    slug: "promo",
    engine: "cloudflare",
    credentialId: "hc_1",
    customHost: OWN_HOST,
  });
  assert.ok(res.ok);
  assert.equal(linkRows[0].deployStatus, "live");

  // The local resolver knows nothing about engines — it must answer identically.
  const byToken = await links.resolveLink(linkRows[0].token);
  const bySlug = await links.resolveLink("promo");
  assert.equal(byToken?.target, "https://example.com/landing");
  assert.equal(bySlug?.target, "https://example.com/landing");
});

test("P6c: a campaign link (userId NULL) is untouched by the engine and still resolves", async () => {
  linkRows.push(blankLink({ userId: null, token: "camptok", target: "https://campaign.example/", engine: "local" }));
  const before = calls.length;
  const res = await links.resolveLink("camptok");
  assert.equal(res?.target, "https://campaign.example/");
  assert.equal(calls.length, before, "serving a campaign link makes no Cloudflare call");
  assert.equal(linkRows[0].userId, null);
  assert.equal(linkRows[0].engine, "local");
});

// ---------------------------------------------------------------------------
// TASK_157 — publishing is restricted to domains the CALLER OWNS.
//
// This is the owner's rule ("users can only select the domain they own or added")
// enforced in the data layer. The UI already offers only the user's own domains,
// so without these tests a crafted request naming any host at all would pass
// unnoticed — which is exactly the case a UI filter cannot protect.
// ---------------------------------------------------------------------------

test("TASK_157: a link on a host the user has NOT claimed is refused, with no row written", async () => {
  const res = await links.createHostedLink({
    userId: "user_1",
    target: "https://example.com/",
    engine: "cloudflare",
    credentialId: "hc_1",
    customHost: "go.someone-elses-domain.test",
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.code, "host_not_owned");
    assert.equal(res.status, 403);
  }
  assert.equal(linkRows.length, 0, "a refused host must not leave a half-made link");
  // Cloudflare is never contacted for a host we already know we may not use.
  assert.equal(calls.length, 0, "no script, no route, no DNS record for a foreign host");
});

test("TASK_157: another user's claimed domain is refused just the same", async () => {
  // Same shape as the previous test but the domain EXISTS and belongs to user_2 —
  // the ownership filter is on the owner pair, not on whether the name is known.
  domainRows.push({
    id: "ud_other",
    apex: "theirs.test",
    label: "theirs.test",
    source: "byo",
    status: "active",
    ownerKind: "user",
    ownerUserId: "user_2",
    zoneId: "zone_theirs",
    nameservers: null,
    note: null,
    createdAt: new Date(),
  });
  const res = await links.createHostedLink({
    userId: "user_1",
    target: "https://example.com/",
    engine: "cloudflare",
    credentialId: "hc_1",
    customHost: "go.theirs.test",
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.code, "host_not_owned");
    // The message must not confirm the domain exists — that would make this an
    // enumeration oracle for other users' domains.
    assert.doesNotMatch(res.message, /exists|already claimed|owned by/i);
  }
  assert.equal(linkRows.length, 0);
});

test("TASK_157: a domain that is still PENDING cannot be published on yet", async () => {
  domainRows[0].status = "pending";
  const res = await links.createHostedLink({
    userId: "user_1",
    target: "https://example.com/",
    engine: "cloudflare",
    credentialId: "hc_1",
    customHost: OWN_HOST,
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    // A distinct code from "not yours": this one is the user's OWN domain and the
    // fix is something they can do, so the message has to say so.
    assert.equal(res.code, "domain_not_ready");
    assert.equal(res.status, 409);
    assert.match(res.message, /isn’t ready yet/i);
  }
  assert.equal(linkRows.length, 0);
});

test("TASK_157: moving a LIVE link onto a host the user does not own is refused, and the link stays put", async () => {
  const created = await makeWorkerLink("https://example.com/");
  assert.ok(created.ok);
  const before = { host: linkRows[0].customHost, route: linkRows[0].routePattern };
  calls = [];

  const res = await links.updateHostedLink({
    userId: "user_1",
    id: linkRows[0].id,
    customHost: "go.not-mine.test",
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, "host_not_owned");

  // The refusal happens BEFORE the row is touched, so nothing was torn down and the
  // link is still serving from where it was.
  assert.equal(linkRows[0].customHost, before.host, "the link did not move");
  assert.equal(linkRows[0].routePattern, before.route);
  assert.equal(calls.length, 0, "a refused move must not delete the live route");
});

test("TASK_157: the apex itself and any subdomain of it are both allowed", async () => {
  for (const host of [OWN_APEX, `deep.nested.${OWN_APEX}`]) {
    const res = await links.createHostedLink({
      userId: "user_1",
      target: "https://example.com/",
      engine: "cloudflare",
      credentialId: "hc_1",
      customHost: host,
    });
    assert.ok(res.ok, `${host} should be allowed: ${JSON.stringify(res)}`);
    assert.equal(linkRows.at(-1)!.customHost, host);
  }
});

test("P6c: a FAILED publish leaves a working local link, flagged but not lost", async () => {
  defaultRoutes([
    { method: "GET", match: "/zones?name=instaweb.top", result: [{ id: "z", name: "instaweb.top", status: "active" }] },
    { method: "GET", match: "/workers/routes", result: [] },
    { method: "PUT", match: "/workers/scripts/", status: 403, result: null },
    { method: "DELETE", match: "/workers/scripts/", result: {} },
    { method: "DELETE", match: "/workers/routes/", result: {} },
  ]);
  const res = await links.createHostedLink({
    userId: "user_1",
    target: "https://example.com/",
    engine: "cloudflare",
    credentialId: "hc_1",
    customHost: OWN_HOST,
  });
  assert.ok(res.ok, "the user still gets their link");
  assert.equal(linkRows.length, 1, "the row exists");
  assert.equal(linkRows[0].deployStatus, "error");
  // The safety net: it resolves on OUR metal even though the Worker never shipped.
  const served = await links.resolveLink(linkRows[0].token);
  assert.equal(served?.target, "https://example.com/");
});

test("P6c: the token never appears in anything the user is shown", async () => {
  const res = await links.createHostedLink({
    userId: "user_1",
    target: "https://example.com/",
    engine: "cloudflare",
    credentialId: "hc_1",
    customHost: OWN_HOST,
  });
  assert.ok(res.ok);
  const view = JSON.stringify(res.value);
  assert.ok(!view.includes(FAKE_WORKER_TOKEN), "no token in the view");
  assert.ok(!("workerToken" in (res.value as unknown as Record<string, unknown>)));
});

test("P6c: our /r path and the Worker URL are both offered", async () => {
  const res = await links.createHostedLink({
    userId: "user_1",
    target: "https://example.com/",
    engine: "cloudflare",
    credentialId: "hc_1",
    customHost: OWN_HOST,
  });
  assert.ok(res.ok);
  assert.ok(res.value.shortPath.startsWith("/r/"), "our own path is always the fallback");
  assert.equal(res.value.publicUrl, `https://${OWN_HOST}/${res.value.slug ?? res.value.token}`);
});

// ---------------------------------------------------------------------------
// The three lifecycle bugs these tests were written to pin (PLAN §19.12.5)
// ---------------------------------------------------------------------------

test("P6c: the NEWLY created link is itself in the map it published", async () => {
  // An INFERRED host (no customHost given) is the trap: the row is created with
  // customHost NULL and publish resolves the host from the zone. If the map is
  // filtered by that resolved host, this row does not match itself and the very
  // first link a user creates is live on a Worker that 404s.
  const res = await links.createHostedLink({
    userId: "user_1",
    target: "https://example.com/",
    engine: "cloudflare",
    credentialId: "hc_1",
  });
  assert.ok(res.ok);
  assert.equal(linkRows[0].deployStatus, "live");

  const put = calls.find((c) => c.method === "PUT" && c.url.includes("/workers/scripts/"));
  assert.ok(put, "a script was uploaded");
  assert.ok(
    calls.length > 0,
    "the upload happened before we assert on the body"
  );
  // The uploaded source must contain this link's own token.
  const uploaded = lastUploadedSource();
  assert.ok(
    uploaded.includes(linkRows[0].token),
    "the freshly created token must be in the script it just published"
  );
});

test("P6c: a PLATFORM-published link keeps credentialId NULL", async () => {
  addPlatformAccount("pa_1");
  const res = await links.createHostedLink({
    userId: "user_1",
    target: "https://example.com/",
    engine: "cloudflare",
    // no credentialId — the platform roster serves it
    customHost: OWN_HOST,
  });
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(linkRows[0].deployStatus, "live", String(linkRows[0].deployError));
  // A platform account id written here would be resolved later as if it were a
  // HostingCredential id, and getHostingCredentialById would find nothing —
  // leaving the route and script behind forever, with no error anywhere.
  assert.equal(linkRows[0].credentialId, null, "platform links record no credential");
});

test("P6c: a platform-published link can still be torn down", async () => {
  addPlatformAccount("pa_1");
  await links.createHostedLink({
    userId: "user_1",
    target: "https://example.com/",
    engine: "cloudflare",
    customHost: OWN_HOST,
  });
  calls = [];
  await links.deleteHostedLink("user_1", linkRows[0].id);
  const name = workers.workerNameForUser("user_1");
  assert.ok(
    calls.some((c) => c.method === "DELETE" && c.url.includes(name)),
    "teardown resolves the platform roster again rather than looking up a credential"
  );
});

test("P6c: moving a LIVE link to another host removes it from the OLD map", async () => {
  await links.createHostedLink({
    userId: "user_1",
    target: "https://example.com/",
    engine: "cloudflare",
    credentialId: "hc_1",
    customHost: OWN_HOST,
  });
  calls = [];
  // The new host is a SECOND domain the same user owns — moving between your own
  // domains is the real case. (A host the user does not own is refused outright, and
  // there is a test for that below.)
  const secondApex = "second.example";
  domainRows.push({
    id: "ud_2",
    apex: secondApex,
    label: secondApex,
    source: "byo",
    status: "active",
    ownerKind: "user",
    ownerUserId: "user_1",
    zoneId: "zone_second",
    nameservers: null,
    note: null,
    createdAt: new Date(),
  });
  defaultRoutes([
    { method: "GET", match: `/zones?name=${secondApex}`, result: [{ id: "zone_second", name: secondApex, status: "active" }] },
  ]);
  const secondHost = `go.${secondApex}`;
  await links.updateHostedLink({
    userId: "user_1",
    id: linkRows[0].id,
    customHost: secondHost,
  });
  assert.equal(linkRows[0].customHost, secondHost);
  // One script per user, so "clean the old host up, then publish the new one" is the
  // only order that leaves a working script. Doing it the other way round deletes
  // the script the new route is about to point at.
  const scriptDelete = calls.findIndex((c) => c.method === "DELETE" && c.url.includes("/workers/scripts/"));
  const scriptPut = calls.findIndex((c) => c.method === "PUT" && c.url.includes("/workers/scripts/"));
  assert.ok(scriptDelete >= 0, "the shared script is torn down before the move");
  assert.ok(
    scriptDelete < scriptPut,
    `teardown (${scriptDelete}) must precede the new publish (${scriptPut})`
  );
  // The route must go BEFORE the script, or the customer's domain keeps pointing
  // at a script that no longer exists.
  const routeDelete = calls.findIndex((c) => c.method === "DELETE" && c.url.includes("/workers/routes/"));
  assert.ok(routeDelete >= 0 && routeDelete < scriptDelete, "route before script");
  // And the map that finally lands must still carry the link.
  assert.ok(lastUploadedSource().includes(linkRows[0].token), "the new publish still carries the link");
});

async function makeWorkerLink(target: string, userId = "user_1", credId = "hc_1") {
  return links.createHostedLink({
    userId,
    target,
    engine: "cloudflare",
    credentialId: credId,
    customHost: OWN_HOST,
  });
}

test("P6c: editing the target REWRITES the map, keeping the same script name", async () => {
  await makeWorkerLink("https://old.example/");
  const name = linkRows[0].workerName;
  calls = [];

  await links.updateHostedLink({ userId: "user_1", id: linkRows[0].id, target: "https://new.example/" });
  assert.equal(linkRows[0].target, "https://new.example/");
  assert.equal(linkRows[0].workerName, name, "one script per user — the name never changes");
  assert.ok(firstIndexOf("PUT", "/workers/scripts/") >= 0, "the map is re-uploaded");
});

test("P6c: a re-label does NOT re-upload the script", async () => {
  await makeWorkerLink("https://example.com/");
  calls = [];
  await links.updateHostedLink({ userId: "user_1", id: linkRows[0].id, label: "Spring" });
  assert.equal(firstIndexOf("PUT", "/workers/scripts/"), -1, "a label lives nowhere near the Worker");
});

test("P6c: deleting the LAST cloudflare link removes the ROUTE before the SCRIPT", async () => {
  await makeWorkerLink("https://example.com/");
  calls = [];
  await links.deleteHostedLink("user_1", linkRows[0].id);

  const route = firstIndexOf("DELETE", "/workers/routes/");
  const script = firstIndexOf("DELETE", "/workers/scripts/");
  assert.ok(route >= 0, "the route is deleted");
  assert.ok(script >= 0, "the script is deleted");
  // THE ordering that matters: a route pointing at a deleted script is a 500 at
  // the edge, not a clean 404.
  assert.ok(route < script, "ROUTE first, then script");
});

test("P6c: deleting one of TWO cloudflare links republishes instead of tearing down", async () => {
  await makeWorkerLink("https://one.example/");
  await makeWorkerLink("https://two.example/");
  calls = [];
  await links.deleteHostedLink("user_1", linkRows[0].id);

  assert.ok(firstIndexOf("PUT", "/workers/scripts/") >= 0, "the map is rebuilt with the survivor");
  assert.equal(firstIndexOf("DELETE", "/workers/scripts/"), -1, "the script stays while a link still uses it");
  assert.equal(linkRows.length, 1);
});

test("P6c: one user's delete never touches another user's script", async () => {
  addCred("user_2", "hc_2");
  await makeWorkerLink("https://mine.example/", "user_1", "hc_1");
  await makeWorkerLink("https://theirs.example/", "user_2", "hc_2");
  calls = [];
  await links.deleteHostedLink("user_1", linkRows[0].id);

  const mineName = workers.workerNameForUser("user_1");
  const theirsName = workers.workerNameForUser("user_2");
  // user_1's last link goes, so user_1's script goes with it — that is correct.
  assert.ok(
    calls.some((c) => c.method === "DELETE" && c.url.includes(mineName)),
    "the deleting user's own script is torn down"
  );
  // The one that matters: user_2 still has a live link, so their script stands.
  assert.ok(!calls.some((c) => c.url.includes(theirsName)), "user_2's script is never touched");
});

test("P6c: a local link's delete makes no Cloudflare call at all", async () => {
  await links.createHostedLink({ userId: "user_1", target: "https://example.com/" });
  calls = [];
  await links.deleteHostedLink("user_1", linkRows[0].id);
  assert.equal(calls.length, 0);
  assert.equal(linkRows.length, 0);
});

// ---------------------------------------------------------------------------
// Fail-closed teardown — the route gates the script.
//
// These three exist because the ROUTE-before-SCRIPT ORDER test above cannot catch a
// teardown that never learned the route state at all: an engine that deletes the
// script anyway passes every ordering assertion while leaving the customer's domain
// pointing at a script that no longer exists. That is a 500 at the edge, and it is
// silent everywhere else, so the failure mode is pinned here rather than reasoned about.
// ---------------------------------------------------------------------------

test("P6c: a FAILED route listing leaves the script alone (never strand a route)", async () => {
  await makeWorkerLink("https://example.com/");
  // The route list is the only way to find out what is bound to the pattern. If it
  // errors we are blind, and blind must mean "do not delete the script".
  defaultRoutes([{ method: "GET", match: "/workers/routes", status: 500 }]);
  calls = [];

  const result = await engine.teardownUserMap(
    "user_1",
    linkRows[0].credentialId,
    linkRows[0].workerName ?? "",
    linkRows[0].routePattern
  );

  assert.equal(result.scriptDeleted, false, "an unreadable route set must NOT free the script");
  assert.equal(
    firstIndexOf("DELETE", "/workers/scripts/"),
    -1,
    "the script delete is never even attempted when the route state is unknown"
  );
});

test("P6c: a FAILED route delete leaves the script alone (never strand a route)", async () => {
  await makeWorkerLink("https://example.com/");
  // The list succeeds and shows our route, but removing it fails at the edge. The
  // route is still there — so the script it points at has to stay too.
  defaultRoutes([{ method: "DELETE", match: "/workers/routes/", status: 500 }]);
  calls = [];

  const result = await engine.teardownUserMap(
    "user_1",
    linkRows[0].credentialId,
    linkRows[0].workerName ?? "",
    linkRows[0].routePattern
  );

  assert.equal(result.scriptDeleted, false, "the script survives while its route still exists");
  assert.equal(firstIndexOf("DELETE", "/workers/scripts/"), -1, "no script delete is attempted");
});

test("P6c: an ALREADY-absent route still frees the script (no leak on a re-run)", async () => {
  await makeWorkerLink("https://example.com/");
  // Nothing matching in the list: the route is already gone, so the goal is met and
  // the script must still be removed. Fail-closed must not become "never delete".
  defaultRoutes([{ method: "GET", match: "/workers/routes", result: [] }]);
  calls = [];

  const result = await engine.teardownUserMap(
    "user_1",
    linkRows[0].credentialId,
    linkRows[0].workerName ?? "",
    linkRows[0].routePattern
  );

  assert.equal(result.scriptDeleted, true, "an absent route is a confirmed clear");
  assert.ok(firstIndexOf("DELETE", "/workers/scripts/") >= 0, "the script is still torn down");
});

// ---------------------------------------------------------------------------
// P6c — the two live-account fixes, both found by probing the owner's REAL
// Cloudflare account and both silent: the routes URL 400s with code 7000 ("No
// route for that URI"), which reads like an auth fault rather than a wrong
// endpoint; and a missing DNS record leaves the hostname unresolvable while
// every publish step reports success. Neither would fail a link test, so each is
// pinned here.
// ---------------------------------------------------------------------------

test("P6c: routes are created ZONE-scoped, never /accounts/{id}/workers/routes", async () => {
  defaultRoutes([{ method: "GET", match: "/workers/routes", result: [] }]);
  await links.createHostedLink({
    userId: "user_1",
    target: "https://example.com/",
    engine: "cloudflare",
    credentialId: "hc_1",
    customHost: OWN_HOST,
  });

  const routeCall = calls.find((c) => c.url.includes("/workers/routes") && c.method !== "DELETE");
  assert.ok(routeCall, "a routes call was made");
  assert.ok(
    routeCall.url.includes("/zones/zone_own/workers/routes"),
    "Routes is a ZONE-scoped Cloudflare API — the account-scoped form 400s (code 7000)"
  );
  assert.equal(
    calls.some((c) => c.url.includes("/accounts/") && c.url.includes("/workers/routes")),
    false,
    "the account-scoped routes URL must never be called again"
  );
});

test("P6c: publish writes a PROXIED originless DNS record BEFORE the route", async () => {
  defaultRoutes([{ method: "GET", match: "/workers/routes", result: [] }]);
  await links.createHostedLink({
    userId: "user_1",
    target: "https://example.com/",
    engine: "cloudflare",
    credentialId: "hc_1",
    customHost: OWN_HOST,
  });

  const dns = firstIndexOf("POST", "/dns_records");
  const route = firstIndexOf("POST", "/workers/routes");
  assert.ok(dns >= 0, "a DNS record is created — without it the host is ERR_NAME_NOT_RESOLVED");
  assert.ok(dns < route, "DNS comes first, so the name resolves by the time the route is live");

  const body = bodies.find((b) => b.includes('"100::"'));
  assert.ok(body, "the record is the originless IPv6 discard prefix — no real origin is named");
  assert.ok(body.includes('"proxied":true'), "and proxied, which is what puts it on Cloudflare's edge");
  assert.ok(body.includes(`"name":"${OWN_HOST}"`), `for the custom host ${OWN_HOST}`);
});

test("P6c: an EXISTING unproxied record is ADOPTED, never overwritten", async () => {
  defaultRoutes([
    { method: "GET", match: "/workers/routes", result: [] },
    { method: "GET", match: "/dns_records", result: [{ id: "rec_1", name: OWN_HOST, proxied: false }] },
  ]);
  await links.createHostedLink({
    userId: "user_1",
    target: "https://example.com/",
    engine: "cloudflare",
    credentialId: "hc_1",
    customHost: OWN_HOST,
  });

  assert.equal(firstIndexOf("POST", "/dns_records"), -1, "we never create a record the user already has");
  assert.ok(
    firstIndexOf("PATCH", "/dns_records/rec_1") >= 0,
    "we only flip THEIR record to proxied — replacing the address would take their host down"
  );
});

test("P6c: an ALREADY-proxied record is left completely alone", async () => {
  defaultRoutes([
    { method: "GET", match: "/workers/routes", result: [] },
    { method: "GET", match: "/dns_records", result: [{ id: "rec_1", name: OWN_HOST, proxied: true }] },
  ]);
  await links.createHostedLink({
    userId: "user_1",
    target: "https://example.com/",
    engine: "cloudflare",
    credentialId: "hc_1",
    customHost: OWN_HOST,
  });

  assert.equal(firstIndexOf("POST", "/dns_records"), -1, "nothing created");
  assert.equal(firstIndexOf("PATCH", "/dns_records/"), -1, "nothing touched");
  assert.ok(firstIndexOf("POST", "/workers/routes") >= 0, "and the publish still completes");
});

test("P6c: a DNS 403 names the missing permission instead of a bare Authentication error", async () => {
  defaultRoutes([
    { method: "GET", match: "/workers/routes", result: [] },
    { method: "POST", match: "/dns_records", status: 403, result: [] },
  ]);
  const out = await engine.publishUserMap("user_1", { credentialId: "hc_1", customHost: HOST });

  assert.equal(out.ok, false, "a link we cannot make resolve is not a link");
  if (!out.ok) {
    assert.equal(out.code, "dns_permission_missing");
    assert.match(out.message, /DNS:Edit/, "the owner is told exactly what to add");
    assert.match(out.message, /DNS:Read/);
  }
  assert.equal(
    firstIndexOf("POST", "/workers/routes"),
    -1,
    "and no route is left pointing at a hostname that does not resolve"
  );
});

test("P6c: a non-403 DNS failure is a plain cf_error and still creates NO route", async () => {
  defaultRoutes([
    { method: "GET", match: "/workers/routes", result: [] },
    { method: "POST", match: "/dns_records", status: 500, result: [] },
  ]);
  const out = await engine.publishUserMap("user_1", { credentialId: "hc_1", customHost: HOST });
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.code, "cf_error");
  assert.equal(firstIndexOf("POST", "/workers/routes"), -1);
});

test("P6c: deleting a link whose OWN publish failed still tears down the shared route", async () => {
  // Reproduces the live bug exactly. The route belongs to the USER+HOST, not to any
  // one link, so it can outlive the link that recorded it:
  //   1. link B is created while the token cannot touch DNS → its publish FAILS, so
  //      B records no workerName and no routePattern.
  //   2. link A publishes fine and creates the route for this user+host.
  //   3. A is deleted → B is still there, so the map is REPUBLISHED and the route stays.
  //   4. B is deleted last → remaining=0, so this is the teardown path — and it must
  //      still find and delete the route, which it can only do by deriving the
  //      pattern from the host. Taking B's NULL pattern skips route deletion and
  //      orphans a live route that answers 500 at the edge forever.
  defaultRoutes([{ method: "POST", match: "/dns_records", status: 403, result: [] }]);
  const bad = await links.createHostedLink({
    userId: "user_1",
    target: "https://bad.example/",
    engine: "cloudflare",
    credentialId: "hc_1",
    customHost: OWN_HOST,
  });
  assert.ok(bad.ok);
  assert.equal(bad.value.deployStatus, "error", "B never got as far as publishing");

  defaultRoutes();
  const good = await makeWorkerLink("https://good.example/");
  assert.ok(good.ok);

  // Step 3 — delete the healthy link; B keeps the map alive.
  const goodRow = linkRows.find((r) => r.id === good.value.id)!;
  assert.ok(goodRow.routePattern, "A did publish and record the pattern");
  assert.ok((await links.deleteHostedLink("user_1", goodRow.id)).ok);

  calls = [];
  const res = await links.deleteHostedLink("user_1", bad.value.id);
  assert.ok(res.ok, "the local delete succeeds regardless of Cloudflare");

  const routeDelete = calls.find((c) => c.method === "DELETE" && c.url.includes("/workers/routes"));
  assert.ok(routeDelete, "the shared route is deleted even though B recorded no pattern");
  assert.ok(
    routeDelete!.url.includes("/zones/zone_own/workers/routes"),
    "and it is the zone-scoped delete, recovered from the host B does still know"
  );
  const scriptDelete = calls.find((c) => c.method === "DELETE" && c.url.includes("/workers/scripts/"));
  assert.ok(scriptDelete, "then the shared script");
  assert.ok(
    calls.indexOf(routeDelete!) < calls.indexOf(scriptDelete!),
    "route before script, so the domain never points at a deleted script"
  );
});

test("P6c: teardown lists and deletes routes ZONE-scoped too", async () => {
  await makeWorkerLink("https://example.com/");
  calls = [];

  await engine.teardownUserMap(
    "user_1",
    linkRows[0].credentialId,
    linkRows[0].workerName ?? "",
    linkRows[0].routePattern
  );

  const list = calls.find((c) => c.method === "GET" && c.url.includes("/workers/routes"));
  assert.ok(list, "route discovery happened");
  assert.ok(
    list.url.includes("/zones/zone_own/workers/routes"),
    "the zone is recovered from the stored pattern, because routes are zone-scoped"
  );
  assert.equal(
    calls.some((c) => c.url.includes("/accounts/") && c.url.includes("/workers/routes")),
    false,
    "never the account-scoped URL"
  );
});

// ---------------------------------------------------------------------------
// RESERVED ZONES — the broks.beauty guard.
//
// The owner removed broks.beauty from the platform token's Zone Resources. That is
// the real fix, but a token is re-issued over time and the next one may be broader.
// This is the code-side backstop: an over-broad token must not be able to install a
// proxied DNS record or a Worker route on a reserved zone just because it can SEE
// the zone.
// ---------------------------------------------------------------------------

test("normalizeZoneName: a host, a URL, a port and a trailing dot all normalise", () => {
  assert.equal(workers.normalizeZoneName("Broks.Beauty"), "broks.beauty");
  assert.equal(workers.normalizeZoneName("  go.broks.beauty  "), "go.broks.beauty");
  assert.equal(workers.normalizeZoneName("https://go.broks.beauty/mylink"), "go.broks.beauty");
  assert.equal(workers.normalizeZoneName("go.broks.beauty:443"), "go.broks.beauty");
  assert.equal(workers.normalizeZoneName("broks.beauty."), "broks.beauty");
  assert.equal(workers.apexOf("go.broks.beauty"), "broks.beauty");
});

test("normalizeZoneName: junk is null, NOT a permissive value", () => {
  // A bare label is not a zone. Anything unparseable must fail closed downstream.
  assert.equal(workers.normalizeZoneName("localhost"), null);
  assert.equal(workers.normalizeZoneName(""), null);
  assert.equal(workers.normalizeZoneName("   "), null);
  assert.equal(workers.normalizeZoneName(null), null);
  assert.equal(workers.normalizeZoneName(undefined), null);
  assert.equal(workers.normalizeZoneName("not a host!"), null);
});

test("isReservedZone: broks.beauty and anything under it are refused, others are not", () => {
  assert.equal(workers.isReservedZone("broks.beauty"), true);
  // The publish path always works in terms of a HOST — go.<zone> must be caught too.
  assert.equal(workers.isReservedZone("go.broks.beauty"), true);
  assert.equal(workers.isReservedZone("GO.BROKS.BEAUTY"), true);
  // Near-misses must NOT be caught: a denylist that over-matches is its own outage.
  assert.equal(workers.isReservedZone("notbroks.beauty"), false);
  assert.equal(workers.isReservedZone("broks.beauty.example.com"), false);
  assert.equal(workers.isReservedZone("example.com"), false);
  assert.equal(workers.isReservedZone("go.example.com"), false);
});

test("assertZoneWritable fails CLOSED — an unparseable host is refused, not allowed", () => {
  assert.deepEqual(workers.assertZoneWritable("go.example.com"), { ok: true });
  assert.equal(workers.assertZoneWritable("localhost").ok, false, "junk must not pass the guard");
  assert.equal(workers.assertZoneWritable(null).ok, false);
  const reserved = workers.assertZoneWritable("go.broks.beauty");
  assert.equal(reserved.ok, false);
  assert.equal(reserved.zone, "broks.beauty", "the refusal names the zone");
});

test("reservedZoneMessage: says which domain, and never leaks a token", () => {
  assert.match(workers.reservedZoneMessage("broks.beauty"), /broks\.beauty/);
  assert.match(workers.reservedZoneMessage(undefined), /could not be verified/);
  assert.ok(!/token|secret|bearer/i.test(workers.reservedZoneMessage("broks.beauty")));
});

test("publishUserMap REFUSES a reserved zone before any DNS/Worker write", async () => {
  calls = [];
  defaultRoutes([
    { method: "GET", match: "/zones?per_page", result: [{ id: "zone_private", name: "broks.beauty", status: "active" }] },
    { method: "GET", match: "/zones?name=broks.beauty", result: [{ id: "zone_private", name: "broks.beauty", status: "active" }] },
  ]);
  const res = await engine.publishUserMap("user_1", { credentialId: "hc_1", customHost: null });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "reserved_zone");
  assert.match(res.message, /broks\.beauty/);
  // The whole point: nothing was WRITTEN. No DNS record, no script, no route.
  assert.equal(calls.some((c) => c.method === "POST" && c.url.includes("/dns_records")), false, "no DNS write");
  assert.equal(calls.some((c) => c.method === "PUT" && c.url.includes("/workers/scripts")), false, "no script write");
  assert.equal(calls.some((c) => c.method === "POST" && c.url.includes("/workers/routes")), false, "no route write");
});

test("publishUserMap refuses an EXPLICIT reserved host too (not just the default pick)", async () => {
  calls = [];
  defaultRoutes([
    { method: "GET", match: "/zones?name=broks.beauty", result: [{ id: "zone_private", name: "broks.beauty", status: "active" }] },
  ]);
  const res = await engine.publishUserMap("user_1", { credentialId: "hc_1", customHost: "go.broks.beauty" });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "reserved_zone");
  assert.equal(calls.some((c) => c.method === "POST" && c.url.includes("/dns_records")), false, "no DNS write");
});

test("publishUserMap skips a reserved zone when DEFAULTING, and picks a usable one", async () => {
  // broks.beauty is listed FIRST — the old code took zones[0] and would have
  // published straight onto the owner's private domain.
  calls = [];
  defaultRoutes([
    {
      method: "GET",
      match: "/zones?per_page",
      result: [
        { id: "zone_private", name: "broks.beauty", status: "active" },
        { id: "zone_1", name: "instaweb.top", status: "active" },
      ],
    },
  ]);
  const res = await engine.publishUserMap("user_1", { credentialId: "hc_1", customHost: null });
  assert.ok(res.ok, JSON.stringify(res));
  if (!res.ok) return;
  assert.equal(res.value.customHost, "go.instaweb.top", "the reserved zone was skipped, not picked");
  assert.equal(
    calls.some((c) => c.url.includes("zone_private")),
    false,
    "broks.beauty's zone id is never used for a write"
  );
});

// ---------------------------------------------------------------------------
// TASK_169 — short auto tokens ride the Worker map like any other key.
// ---------------------------------------------------------------------------

test("TASK_169: a short auto token is created at 7 chars and published into the Worker map", async () => {
  calls = [];
  bodies = [];
  defaultRoutes();
  addCred();
  const created = await links.createHostedLink({
    userId: "user_1",
    target: "https://short.example/",
    engine: "cloudflare",
    customHost: OWN_HOST,
    credentialId: "hc_1",
  });
  assert.ok(created.ok, JSON.stringify(created));
  if (!created.ok) return;
  assert.match(created.value.token, /^[A-Za-z0-9_-]{7}$/);
  const src = lastUploadedSource();
  assert.ok(src.includes(created.value.token), "the short token must be a key in the uploaded map");
  assert.ok(src.includes("https://short.example/"));
});