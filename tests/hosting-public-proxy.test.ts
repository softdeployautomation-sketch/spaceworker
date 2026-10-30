import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
/* eslint-disable @typescript-eslint/no-require-imports -- house require-hook pattern for module stubs */
import Module from "node:module";

// TASK_249 — the public Worker proxy (lib/hosting/public-proxy.ts).
// provisionPublicHost idempotency + re-save teardown, plus a source snapshot.

const ROUTE = "../lib/hosting/public-proxy.ts";

const HOST_B = "dl.instaweb.top";
const APP_ORIGIN = "https://app.instaweb.top";

let settings: Record<string, unknown> = { hostingPublicLinkHost: null };

function workerStubs(overrides: Record<string, unknown> = {}) {
  return {
    ensureZoneActive: async () =>
      overrides.ensureZoneActive ?? {
        ok: true,
        value: { zoneId: "zone_instaweb", zoneName: "instaweb.top" },
      },
    ensureProxiedRecord: async () =>
      overrides.ensureProxiedRecord ?? {
        ok: true,
        value: { id: "rec1", created: true },
      },
    uploadWorkerScript: async () => ({
      ok: true,
      status: 200,
      value: { name: "sw-public-proxy" },
    }),
    putWorkerRoute: async () => ({ ok: true, status: 200, value: { pattern: "" } }),
    listActiveZones: async () =>
      overrides.listActiveZones ?? {
        ok: true,
        status: 200,
        value: [{ id: "zone_old", name: "old.test", status: "active" }],
      },
    listWorkerRoutes: async () => ({ ok: true, value: [] }),
    deleteWorkerRoute: async () => ({ ok: true, status: 200 }),
    deleteWorkerScript: async () => ({ ok: true, status: 200 }),
    getZoneByName: async () =>
      overrides.getZoneByName ?? {
        ok: true,
        value: { zoneId: "zone_instaweb", name: "instaweb.top", status: "active" },
      },
    ...overrides,
  };
}

const loader = Module as unknown as {
  _load: (r: string, p: NodeModule | undefined, m: boolean) => unknown;
};
const originalLoad = loader._load;

function patchLoader(overrides: {
  settings?: Record<string, unknown>;
  accountRow?: { accountId: string; label: string; workerTokenCiphertext: string; id?: string } | null;
  token?: string | null;
  workers?: Record<string, unknown>;
  envAppBaseUrl?: string;
  onFindFirst?: (args: { where?: Record<string, unknown> }) => void;
}) {
  loader._load = function patched(request, _parent, _isMain) {
    if (request === "server-only") {
      return {};
    }
    if (request === "@/lib/admin-settings") {
      return {
        getAdminSettings: async () => ({ ...(overrides.settings ?? settings) }),
      };
    }
    if (request === "@/lib/prisma" || request === "../prisma" || request === "./prisma") {
      return {
        prisma: {
          hostingPlatformAccount: {
            findUnique: async () => overrides.accountRow ?? null,
            findFirst: async (args: { where?: Record<string, unknown> }) => {
              overrides.onFindFirst?.(args ?? {});
              return overrides.accountRow ?? null;
            },
          },
        },
      };
    }
    if (request === "@/lib/env") {
      return { env: { appBaseUrl: overrides.envAppBaseUrl ?? APP_ORIGIN } };
    }
    if (request === "./credentials") {
      return { readWorkerToken: () => overrides.token ?? null };
    }
    if (request === "./workers") {
      return workerStubs(overrides.workers ?? {});
    }
    return originalLoad.call(this, request, _parent, _isMain);
  };
}

let mod: typeof import("../lib/hosting/public-proxy");
beforeEach(async () => {
  settings = { hostingPublicLinkHost: null };
  patchLoader({});
  delete require.cache[require.resolve(ROUTE)];
  mod = require(ROUTE) as typeof import("../lib/hosting/public-proxy");
});

const PUBLIC_PROXY_SCRIPT = "sw-public-proxy";

test("publicProxySource snapshot: origin, path allowlist, manual redirect", () => {
  const src = mod.publicProxySource(APP_ORIGIN);
  assert.ok(src.includes(APP_ORIGIN), "origin embedded");
  assert.ok(src.includes("/hf/"), "serves /hf/");
  assert.ok(src.includes("/link/vantra/"), "serves /link/vantra/");
  assert.ok(src.includes('redirect: "manual"'), "manual redirect");
  assert.ok(
    src.includes("return new Response(null, { status: 404 })"),
    "404 for other paths"
  );
  assert.ok(src.includes("url.search"), "query string is preserved");
  assert.ok(src.includes('headers.delete("host")'), "client Host is not forwarded");
});

test("provisionPublicHost is idempotent across two runs", async () => {
  const createdLog: boolean[] = [];
  patchLoader({
    settings: {
      hostingPublicLinksAccountId: "43b24dc00bea90102ede000000000000",
      hostingPremiumLinksAccountId: "2222222222222222222222222222222a",
      hostingPremiumSitesAccountId: "1111111111111111111111111111111f",
    },
    accountRow: {
      id: "row1",
      accountId: "43b24dc00bea90102ede000000000000",
      label: "Links account",
      workerTokenCiphertext: "enc",
    },
    token: "tok-abc",
    workers: {
      ensureProxiedRecord: async () => {
        const result = { ok: true, value: { id: "rec1", created: createdLog.length === 0 } };
        createdLog.push(createdLog.length === 0);
        return result;
      },
    },
  });
  delete require.cache[require.resolve(ROUTE)];
  mod = require(ROUTE) as typeof import("../lib/hosting/public-proxy");

  const first = await mod.provisionPublicHost(HOST_B);
  assert.equal(first.ok, true, JSON.stringify(first.error));
  assert.equal(first.zoneId, "zone_instaweb");
  assert.equal(first.dnsCreated, true);

  const second = await mod.provisionPublicHost(HOST_B);
  assert.equal(second.ok, true, JSON.stringify(second.error));
  assert.equal(second.dnsCreated, false);
  assert.deepEqual(createdLog, [true, false]);
});

test("provisionPublicHost rejects when the zone is not active", async () => {
  patchLoader({
    settings: { hostingPublicLinksAccountId: "43b24dc00bea90102ede000000000000" },
    accountRow: {
      id: "row1",
      accountId: "43b24dc00bea90102ede000000000000",
      label: "Links account",
      workerTokenCiphertext: "enc",
    },
    token: "tok",
    workers: {
      ensureZoneActive: async () => ({
        ok: false,
        status: 409,
        error:
          "instaweb.top is still being set up in Cloudflare. Finish activating it, then try again.",
      }),
    },
  });
  delete require.cache[require.resolve(ROUTE)];
  mod = require(ROUTE) as typeof import("../lib/hosting/public-proxy");

  const res = await mod.provisionPublicHost("go.instaweb.top");
  assert.equal(res.ok, false);
  assert.ok(res.error?.includes("instaweb.top"));
  assert.ok(res.error?.includes("still being set up"));
});

test("provisionPublicHost fails closed with no token", async () => {
  patchLoader({
    settings: { hostingPublicLinksAccountId: "43b24dc00bea90102ede000000000000" },
    accountRow: {
      id: "row1",
      accountId: "43b24dc00bea90102ede000000000000",
      label: "Links account",
      workerTokenCiphertext: "enc",
    },
    token: null,
  });
  delete require.cache[require.resolve(ROUTE)];
  mod = require(ROUTE) as typeof import("../lib/hosting/public-proxy");

  const res = await mod.provisionPublicHost("dl.instaweb.top");
  assert.equal(res.ok, false);
  assert.equal(res.zoneId, null);
  assert.ok(res.error?.includes("No active platform account"));
});

test("teardownPublicHost deletes the old route then the script", async () => {
  let routeDeleted = false;
  let scriptDeleted = false;
  let routeId: string | null = null;
  patchLoader({
    settings: { hostingPublicLinksAccountId: "43b24dc00bea90102ede000000000000" },
    accountRow: {
      id: "row1",
      accountId: "43b24dc00bea90102ede000000000000",
      label: "Links account",
      workerTokenCiphertext: "enc",
    },
    token: "tok",
    workers: {
      listWorkerRoutes: async () => ({
        ok: true,
        value: [
          { id: "route-1", pattern: "dl.old.test/*", script: PUBLIC_PROXY_SCRIPT },
          { id: "route-2", pattern: "other/*", script: "other-script" },
        ],
      }),
      deleteWorkerRoute: async (_cred: unknown, _zoneId: string, id: string) => {
        routeDeleted = true;
        routeId = id;
        return { ok: true, status: 200 };
      },
      deleteWorkerScript: async (_cred: unknown, name: string) => {
        scriptDeleted = true;
        assert.equal(name, PUBLIC_PROXY_SCRIPT);
        return { ok: true, status: 200 };
      },
    },
  });
  delete require.cache[require.resolve(ROUTE)];
  mod = require(ROUTE) as typeof import("../lib/hosting/public-proxy");

  const res = await mod.teardownPublicHost("dl.old.test");
  assert.equal(res.ok, true);
  assert.equal(routeDeleted, true);
  assert.equal(routeId, "route-1");
  assert.equal(scriptDeleted, true);
});

test("teardownPublicHost is a no-op success when no token is configured", async () => {
  patchLoader({
    settings: { hostingPublicLinksAccountId: "43b24dc00bea90102ede000000000000" },
    accountRow: null,
    token: null,
  });
  delete require.cache[require.resolve(ROUTE)];
  mod = require(ROUTE) as typeof import("../lib/hosting/public-proxy");

  const res = await mod.teardownPublicHost("dl.old.test");
  assert.equal(res.ok, true);
  assert.equal(res.error, null);
});

// TASK_249 — the account fallback is public pin → LINKS pin → priority.
// The first implementation fell back to the SITES pin, so a files/installer host
// silently published to the Pages account (owner: "defaults to the links pin").
const PUBLIC_PIN = "43b24dc00bea90102ede000000000000";
const LINKS_PIN = "2222222222222222222222222222222a";
const SITES_PIN = "1111111111111111111111111111111f";

async function pinUsedByProvision(settings: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  let where: Record<string, unknown> | null = null;
  patchLoader({
    settings,
    accountRow: {
      id: "row1",
      accountId: PUBLIC_PIN,
      label: "Account",
      workerTokenCiphertext: "enc",
    },
    token: "tok",
    onFindFirst: (args) => {
      where = args.where ?? null;
    },
  });
  delete require.cache[require.resolve(ROUTE)];
  mod = require(ROUTE) as typeof import("../lib/hosting/public-proxy");
  await mod.provisionPublicHost("dl.instaweb.top");
  return where;
}

test("pin: the public pin wins when set", async () => {
  const where = await pinUsedByProvision({
    hostingPublicLinksAccountId: PUBLIC_PIN,
    hostingPremiumLinksAccountId: LINKS_PIN,
    hostingPremiumSitesAccountId: SITES_PIN,
  });
  assert.equal(where?.accountId, PUBLIC_PIN);
});

test("pin: an empty public pin follows the LINKS pin, not the sites pin", async () => {
  const where = await pinUsedByProvision({
    hostingPublicLinksAccountId: "",
    hostingPremiumLinksAccountId: LINKS_PIN,
    hostingPremiumSitesAccountId: SITES_PIN,
  });
  assert.equal(where?.accountId, LINKS_PIN);
});

test("pin: with no public or links pin, priority rotation is used (sites pin ignored)", async () => {
  const where = await pinUsedByProvision({
    hostingPublicLinksAccountId: "",
    hostingPremiumLinksAccountId: "",
    hostingPremiumSitesAccountId: SITES_PIN,
  });
  assert.equal(where?.accountId, undefined);
  assert.deepEqual(where?.status, "active");
});

test("teardownPublicHost picks the deepest matching zone (example.co.uk, not co.uk)", async () => {
  let zoneUsed: string | null = null;
  let routeDeleted = false;
  patchLoader({
    settings: { hostingPublicLinksAccountId: "43b24dc00bea90102ede000000000000" },
    accountRow: {
      id: "row1",
      accountId: "43b24dc00bea90102ede000000000000",
      label: "Links account",
      workerTokenCiphertext: "enc",
    },
    token: "tok",
    workers: {
      listActiveZones: async () => ({
        ok: true,
        status: 200,
        value: [
          { id: "zone_co_uk", name: "co.uk", status: "active" },
          { id: "zone_example", name: "example.co.uk", status: "active" },
        ],
      }),
      listWorkerRoutes: async () => ({
        ok: true,
        value: [
          { id: "route-1", pattern: "dl.example.co.uk/*", script: PUBLIC_PROXY_SCRIPT },
        ],
      }),
      deleteWorkerRoute: async (_cred: unknown, zoneId: string) => {
        zoneUsed = zoneId;
        routeDeleted = true;
        return { ok: true, status: 200 };
      },
    },
  });
  delete require.cache[require.resolve(ROUTE)];
  mod = require(ROUTE) as typeof import("../lib/hosting/public-proxy");

  const res = await mod.teardownPublicHost("dl.example.co.uk");
  assert.equal(res.ok, true);
  assert.equal(routeDeleted, true);
  assert.equal(zoneUsed, "zone_example");
});
