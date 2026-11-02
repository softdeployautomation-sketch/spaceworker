import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// TASK_249 — the admin route's domain-selection behaviour:
//   * a host not under an active zone in the pinned account is refused (400);
//   * switching account + host in ONE PATCH validates against the NEW pin;
//   * the public proxy is provisioned BEFORE the setting is saved, and a
//     provision failure saves nothing;
//   * the zones endpoint never serializes a token.

const ROUTE = "/app/api/admin/hosting/route.ts";

const LINKS_PIN = "2222222222222222222222222222222a";
const PUBLIC_PIN = "43b24dc00bea90102ede000000000000";
const MULTI_PIN = "9bc97c44fc72505e6f9f413c568ffa7b";

let settings: Record<string, unknown> = {};
let upserts: Array<Record<string, unknown>> = [];
let order: string[] = [];
let provisionOk = true;
let provisionPin: string | null | undefined;
let zonesByAccount: Record<string, Array<{ id: string; name: string; status: string }>> = {};
let rowsByAccount: Record<string, Array<Record<string, unknown>>> = {};
let deadTokens = new Set<string>();

function accountRow(
  accountId: string,
  label: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    accountId,
    label,
    tokenCiphertext: "enc",
    tokenIv: "iv",
    tokenTag: "tag",
    workerTokenCiphertext: "enc",
    workerTokenIv: "iv",
    workerTokenTag: "tag",
    zoneTokenCiphertext: null,
    ...extra,
  };
}

function bridge(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    hostingPremiumLinksAccountId: LINKS_PIN,
    hostingPremiumSitesAccountId: "",
    hostingPublicLinkHost: null,
    hostingPublicLinksAccountId: null,
    ...extra,
  };
}

const fakeNextResponse = {
  json: (data: unknown, init?: { status?: number }) => ({
    status: init?.status ?? 200,
    json: async () => data,
  }),
};

const prismaStub = {
  hostedAsset: {
    count: async () => 0,
    aggregate: async () => ({ _sum: { bytes: 0 } }),
    findMany: async () => [],
  },
  hostingSite: { count: async () => 0 },
  hostingPlatformAccount: {
    findMany: async (args: { where?: { accountId?: string } }) => {
      const id = args?.where?.accountId;
      return id ? rowsByAccount[id] ?? [] : [];
    },
  },
  adminSetting: {
    upsert: async ({ update, create }: { update: Record<string, unknown>; create: Record<string, unknown> }) => {
      const data = update ?? create;
      order.push("upsert");
      upserts.push(data);
      Object.assign(settings, data);
      return { id: "singleton", ...settings };
    },
  },
};

const loader = Module as unknown as { _load: (r: string, p: NodeModule | undefined, m: boolean) => unknown };
const originalLoad = loader._load;
loader._load = function patched(request, parent, isMain) {
  if (parent?.filename?.endsWith(ROUTE)) {
    if (request === "next/server") return { NextResponse: fakeNextResponse };
    if (request === "@/lib/admin-auth") return { requireAdminSession: async () => true };
    if (request === "@/lib/admin-settings") return { getAdminSettings: async () => ({ ...settings }) };
    if (request === "@/lib/prisma") return { prisma: prismaStub };
    if (request === "@/lib/hosting/rules") return { CLOUDFLARE_HARD_ASSET_MB: 25 };
    if (request === "@/lib/hosting/providers") return { listProviders: () => [] };
    if (request === "@/lib/hosting/credentials") {
      return {
        // The real helpers decrypt Prisma columns; the stub rows carry the
        // decrypted value under a synthetic field so a row can model exactly
        // which slots are readable/dead.
        readWorkerToken: (row: Record<string, unknown>) => row.workerTokenValue ?? null,
        readMainToken: (row: Record<string, unknown>) => row.mainTokenValue ?? null,
        readZoneToken: (row: Record<string, unknown>) => row.zoneTokenValue ?? null,
      };
    }
    if (request === "@/lib/hosting/workers") {
      return {
        listActiveZones: async (cred: { accountId: string; token: string }) => {
          if (deadTokens.has(cred.token)) {
            return { ok: false, status: 403, value: null, error: "Invalid access token" };
          }
          return { ok: true, status: 200, value: zonesByAccount[cred.accountId] ?? [] };
        },
        isReservedZone: (host: string) => host.endsWith("broks.beauty"),
      };
    }
    if (request === "@/lib/hosting/public-proxy") {
      return {
        provisionPublicHost: async (host: string, opts?: { accountId?: string | null }) => {
          order.push("provision");
          provisionPin = opts?.accountId;
          return provisionOk
            ? { ok: true, host, zoneId: "z1", zoneName: "instaweb.top", dnsCreated: true, error: null }
            : { ok: false, host, zoneId: null, zoneName: null, dnsCreated: false, error: "boom" };
        },
        teardownPublicHost: async (host: string) => {
          order.push("teardown");
          return { ok: true, host, error: null };
        },
      };
    }
    if (request === "@/lib/hosting/public-bases") return { resetPublicBaseCache: () => {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};

/* eslint-disable @typescript-eslint/no-require-imports */
const route = require("../app/api/admin/hosting/route") as {
  GET: (req?: Request) => Promise<{ status: number; json: () => Promise<unknown> }>;
  PATCH: (req: Request) => Promise<{ status: number; json: () => Promise<unknown> }>;
};
/* eslint-enable @typescript-eslint/no-require-imports */

function patchRequest(body: unknown): Request {
  return new Request("https://spaceworker.test/api/admin/hosting", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  settings = bridge();
  upserts = [];
  order = [];
  provisionOk = true;
  provisionPin = undefined;
  deadTokens = new Set(["dead-worker"]);
  zonesByAccount = {
    [LINKS_PIN]: [{ id: "z1", name: "instaweb.top", status: "active" }],
    [PUBLIC_PIN]: [
      { id: "z1", name: "instaweb.top", status: "active" },
      { id: "z2", name: "mainstreetmint.sbs", status: "active" },
    ],
    [MULTI_PIN]: [
      { id: "z3", name: "mainstreetmint.sbs", status: "active" },
      { id: "z4", name: "mainstreetmint.work", status: "active" },
    ],
  };
  rowsByAccount = {
    [LINKS_PIN]: [accountRow(LINKS_PIN, "acct-links", { workerTokenValue: "tok" })],
    [PUBLIC_PIN]: [accountRow(PUBLIC_PIN, "acct-public", { workerTokenValue: "tok" })],
    // TASK_251 — the production shape: two rows for one account, the first row's
    // Workers token is dead while its main token still works.
    [MULTI_PIN]: [
      accountRow(MULTI_PIN, "mainstreet.sbs", {
        workerTokenValue: "dead-worker",
        mainTokenValue: "tok-main",
      }),
      accountRow(MULTI_PIN, "mainstreet.work", { mainTokenValue: "tok-work" }),
    ],
  };
});

test("a host outside the pinned account's zones is refused and nothing is saved", async () => {
  const res = await route.PATCH(
    patchRequest({ linkDomain: "go.mainstreetmint.sbs", premiumLinksAccountId: LINKS_PIN })
  );
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /not under an active zone/);
  assert.equal(upserts.length, 0);
});

test("switching account + host in one PATCH validates against the NEW pin", async () => {
  // mainstreetmint.sbs exists in the account NOW pinned by the same PATCH.
  const res = await route.PATCH(
    patchRequest({ linkDomain: "go.mainstreetmint.sbs", premiumLinksAccountId: PUBLIC_PIN })
  );
  assert.equal(res.status, 200);
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].hostingPremiumLinkDomain, "go.mainstreetmint.sbs");
  assert.equal(upserts[0].hostingPremiumLinksAccountId, PUBLIC_PIN);
});

test("the public host is provisioned before the save, with the new pin", async () => {
  const res = await route.PATCH(
    patchRequest({
      publicLinkHost: "dl.instaweb.top",
      publicLinksAccountId: PUBLIC_PIN,
    })
  );
  assert.equal(res.status, 200);
  assert.deepEqual(order, ["provision", "upsert"]);
  assert.equal(provisionPin, PUBLIC_PIN);
  const body = (await res.json()) as { provisionResult: { ok: boolean } };
  assert.equal(body.provisionResult.ok, true);
});

test("a provision failure saves nothing", async () => {
  provisionOk = false;
  const res = await route.PATCH(
    patchRequest({ publicLinkHost: "dl.mainstreetmint.sbs", publicLinksAccountId: PUBLIC_PIN })
  );
  assert.equal(res.status, 400);
  assert.equal(upserts.length, 0);
  assert.equal(settings.hostingPublicLinkHost, null);
});

test("clearing the public host tears the old host down after the save", async () => {
  settings = bridge({ hostingPublicLinkHost: "dl.old.test" });
  const res = await route.PATCH(patchRequest({ publicLinkHost: "" }));
  assert.equal(res.status, 200);
  assert.deepEqual(order, ["upsert", "teardown"]);
  assert.equal(upserts[0].hostingPublicLinkHost, "");
});

test("zones GET honours an explicit accountId and never returns a token", async () => {
  const res = await route.GET(
    new Request(`https://spaceworker.test/api/admin/hosting?purpose=public&accountId=${PUBLIC_PIN}`)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.accountId, PUBLIC_PIN);
  assert.equal(body.canListZones, true);
  assert.ok(Array.isArray(body.zones));
  assert.ok(!JSON.stringify(body).includes("tok"));
});

test("TASK_251: a dead Workers token falls through to the row's main token", async () => {
  const res = await route.GET(
    new Request(`https://spaceworker.test/api/admin/hosting?purpose=sites&accountId=${MULTI_PIN}`)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    canListZones: boolean;
    label: string;
    zones: Array<{ name: string }>;
  };
  assert.equal(body.canListZones, true);
  assert.equal(body.label, "mainstreet.sbs");
  assert.deepEqual(
    body.zones.map((z) => z.name).sort(),
    ["mainstreetmint.sbs", "mainstreetmint.work"]
  );
  assert.ok(!JSON.stringify(body).includes("tok"));
});

test("TASK_251: a dead Workers token does not block PATCH validation", async () => {
  const res = await route.PATCH(
    patchRequest({ siteDomain: "mainstreetmint.sbs", premiumSitesAccountId: MULTI_PIN })
  );
  assert.equal(res.status, 200);
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].hostingPremiumSiteDomain, "mainstreetmint.sbs");
});

test("TASK_251: when every readable token is refused, the PATCH fails closed", async () => {
  deadTokens.add("tok-main");
  deadTokens.add("tok-work");
  const res = await route.PATCH(
    patchRequest({ siteDomain: "mainstreetmint.sbs", premiumSitesAccountId: MULTI_PIN })
  );
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /Invalid access token/);
  assert.equal(upserts.length, 0);
});
