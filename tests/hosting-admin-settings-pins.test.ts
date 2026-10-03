import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// TASK_157 Phase 2 — the per-purpose Cloudflare account PINS in the admin
// settings route (/api/admin/hosting).
//
// These have their own file rather than living in the platform-accounts route
// test because they are saved through a DIFFERENT endpoint: the pins are
// AdminSettings, not roster rows. The one behaviour worth pinning down here is
// what gets WRITTEN, because these dials decide which of our own Cloudflare
// accounts serves premium traffic. A silently mangled account id would leave
// premium links failing on `pinned_account_missing` with nothing on screen to
// explain why.
//
// Deliberately NOT tested here: whether the pinned account actually exists and
// works. That is Cloudflare's job and the resolver's, covered by
// tests/hosting-platform-accounts.test.ts. Validating existence at save time
// would make an account impossible to configure before its roster row is added.

const ROUTE = "/app/api/admin/hosting/route.ts";

let isAdmin = true;
/** The AdminSetting singleton as the route last wrote it. */
let settings: Record<string, unknown> = {};
/** Every `adminSetting.upsert` the route performed, in order. */
let writes: Array<Record<string, unknown>> = [];

function seedSettings(overrides: Record<string, unknown> = {}) {
  settings = {
    hostingEnabled: true,
    hostingProvider: "local",
    hostingFreeStorageQuotaMb: 1024,
    hostingFreeMaxFileSizeMb: 25,
    hostingFreeMaxFiles: 10,
    hostingFreeMaxBandwidthGbPerMonth: 10,
    hostingPremiumStorageQuotaMb: 10240,
    hostingPagesMaxAssetMb: 25,
    hostingPlatformTokenTtlHours: 24,
    hostingModulePriceUsd: 5,
    hostingFreeMaxLinks: 10,
    hostingPremiumMaxLinks: 500,
    hostingPremiumMaxProjects: 25,
    hostingPremiumMaxFilesPerProject: 2000,
    hostingPremiumMaxBandwidthGbPerMonth: 200,
    hostingPremiumDeploymentsPerDay: 50,
    hostingPreviewTtlHours: 24,
    hostingMaxZipMb: 100,
    hostingMaxZipEntries: 5000,
    hostingMaxHeavyJobsPerUser: 5,
    hostingPublishedRevisionsKept: 5,
    hostingPremiumSiteDomain: "",
    hostingPremiumLinkDomain: "",
    // Phase 1 shipped both of these empty; every live install has "", which is
    // what makes an unpinned default the thing that must keep working.
    hostingPremiumLinksAccountId: "",
    hostingPremiumSitesAccountId: "",
    ...overrides,
  };
}

const fakePrisma = {
  hostedAsset: {
    count: async () => 0,
    aggregate: async () => ({ _sum: { bytes: 0 } }),
    findMany: async () => [],
  },
  hostingSite: { count: async () => 0 },
  adminSetting: {
    upsert: async ({ update, create }: { update: Record<string, unknown>; create: Record<string, unknown> }) => {
      const data = update ?? create;
      writes.push(data);
      Object.assign(settings, data);
      return { id: "singleton", ...settings };
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
    if (request === "@/lib/admin-settings") return { getAdminSettings: async () => ({ ...settings }) };
    if (request === "@/lib/prisma") return { prisma: fakePrisma };
    if (request === "@/lib/hosting/rules") return { CLOUDFLARE_HARD_ASSET_MB: 25 };
    if (request === "@/lib/hosting/domains") {
      return {
        normalizeHostInput: (raw: string) =>
          raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "") || null,
        universalSslCovered: () => true,
      };
    }
    if (request === "@/lib/hosting/providers") {
      return { listProviders: () => [{ id: "local" }, { id: "cloudflare" }] };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

/* eslint-disable @typescript-eslint/no-require-imports */
const route = require("../app/api/admin/hosting/route") as {
  GET: (req?: Request) => Promise<{ status: number; json: () => Promise<unknown> }>;
  PATCH: (req: Request) => Promise<{ status: number; json: () => Promise<unknown> }>;
};
/* eslint-enable @typescript-eslint/no-require-imports */

const URL_BASE = "https://spaceworker.test/api/admin/hosting";

function patchRequest(body: unknown): Request {
  return new Request(URL_BASE, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A syntactically valid Cloudflare account id (exactly 32 hex chars). */
const LINKS_ACCOUNT = "43b24dc00bea90102ede000000000000";
const SITES_ACCOUNT = "1111111111111111111111111111111f";

beforeEach(() => {
  isAdmin = true;
  writes = [];
  seedSettings();
});
test("pins: GET exposes both pins so the panel can show what is actually set", async () => {
  seedSettings({
    hostingPremiumLinksAccountId: LINKS_ACCOUNT,
    hostingPremiumSitesAccountId: SITES_ACCOUNT,
  });

  const res = await route.GET();
  assert.equal(res.status, 200);
  const payload = (await res.json()) as { domains: Record<string, string> };

  assert.equal(payload.domains.premiumLinksAccountId, LINKS_ACCOUNT);
  assert.equal(payload.domains.premiumSitesAccountId, SITES_ACCOUNT);
});

test("pins: GET reports an UNSET pin as the empty string, not null", async () => {
  const res = await route.GET();
  const payload = (await res.json()) as { domains: Record<string, string> };

  // "" is what the resolver reads as "unpinned". null would have to be handled
  // separately at every read site, and would blur "unpinned" into "unknown".
  assert.equal(payload.domains.premiumLinksAccountId, "");
  assert.equal(payload.domains.premiumSitesAccountId, "");
});

test("pins: a valid account id is saved to its AdminSetting column", async () => {
  const res = await route.PATCH(patchRequest({ premiumLinksAccountId: LINKS_ACCOUNT }));
  assert.equal(res.status, 200, JSON.stringify(await res.json()));
  assert.equal(settings.hostingPremiumLinksAccountId, LINKS_ACCOUNT);
  assert.deepEqual(writes, [{ hostingPremiumLinksAccountId: LINKS_ACCOUNT }]);
});

test("pins: the value is NORMALISED, so panel and engine never disagree", async () => {
  const res = await route.PATCH(
    patchRequest({ premiumLinksAccountId: `  ${LINKS_ACCOUNT.toUpperCase()}  ` })
  );

  assert.equal(res.status, 200);
  // Stored lower-case and trimmed: the resolver compares this against
  // `row.accountId`, so a stray space or capital would silently never match.
  assert.equal(settings.hostingPremiumLinksAccountId, LINKS_ACCOUNT);
});

test("pins: an EMPTY string unpins, and is not mistaken for 'nothing to update'", async () => {
  seedSettings({ hostingPremiumLinksAccountId: LINKS_ACCOUNT });

  const res = await route.PATCH(patchRequest({ premiumLinksAccountId: "" }));

  assert.equal(res.status, 200, "clearing the box is how an admin returns to automatic rotation");
  assert.equal(settings.hostingPremiumLinksAccountId, "");
});

test("pins: a malformed account id is refused at SAVE time and writes nothing", async () => {
  // Each of these would otherwise become a silent, permanent mis-route reported
  // only as "premium hosting is being set up" to an end user who cannot act on it.
  for (const bad of [
    "43b24dc00bea90102ede", // 24 chars — truncated paste
    "43b24dc0-0bea-9010-2ede-0000", // a UUID with dashes
    "43b24dc00bea90102edezzzzzzzzzz", // trailing non-hex
    "instaweb.top", // a hostname, not an account id
  ]) {
    const res = await route.PATCH(patchRequest({ premiumLinksAccountId: bad }));
    assert.equal(res.status, 400, `${bad} must be rejected`);
    assert.equal(writes.length, 0, `${bad} must not reach the database`);
  }
});

test("pins: a non-string pin is refused", async () => {
  for (const bad of [123, true, null, { id: "x" }]) {
    const res = await route.PATCH(patchRequest({ premiumLinksAccountId: bad }));
    assert.equal(res.status, 400, `${JSON.stringify(bad)} must be rejected`);
  }
  assert.equal(writes.length, 0);
});

test("pins: setting ONE pin never touches the other", async () => {
  seedSettings({ hostingPremiumSitesAccountId: SITES_ACCOUNT });

  await route.PATCH(patchRequest({ premiumLinksAccountId: LINKS_ACCOUNT }));

  assert.equal(settings.hostingPremiumLinksAccountId, LINKS_ACCOUNT);
  assert.equal(
    settings.hostingPremiumSitesAccountId,
    SITES_ACCOUNT,
    "sites keep their own account — this is the whole point of pinning them separately"
  );
});

test("pins: both pins and a domain save in ONE call", async () => {
  const res = await route.PATCH(
    patchRequest({
      premiumLinksAccountId: LINKS_ACCOUNT,
      premiumSitesAccountId: SITES_ACCOUNT,
      linkDomain: "swdocs.workers.dev",
    })
  );

  assert.equal(res.status, 200, JSON.stringify(await res.json()));
  assert.equal(writes.length, 1, "a partial update is still a single write");
  assert.equal(settings.hostingPremiumLinkDomain, "swdocs.workers.dev");
});

test("pins: an unknown field is still refused", async () => {
  const res = await route.PATCH(patchRequest({ premiumLinksAccount: LINKS_ACCOUNT }));
  assert.equal(res.status, 400);
  assert.equal(writes.length, 0);
});

test("pins: an anonymous caller cannot change routing", async () => {
  isAdmin = false;
  const res = await route.PATCH(patchRequest({ premiumLinksAccountId: LINKS_ACCOUNT }));
  assert.equal(res.status, 403);
  assert.equal(writes.length, 0, "a refused caller must never reach the database");
});

test("pins: a TRUNCATED id is refused with its actual length", async () => {
  // The most likely real mistake: the Cloudflare dashboard and our own roster
  // label both show shortened ids. "must be 32 characters" reads as "this is
  // broken"; "you pasted 20 of 32" tells the admin exactly what to re-copy.
  const res = await route.PATCH(patchRequest({ premiumLinksAccountId: "43b24dc00bea90102ede" }));
  assert.equal(res.status, 400);
  const payload = (await res.json()) as { error: string };
  assert.match(payload.error, /20 characters/, "the error must report the length that was actually sent");
  assert.match(payload.error, /32/, "and what a real account ID looks like");
});
