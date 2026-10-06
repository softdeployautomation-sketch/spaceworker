import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { createHash } from "node:crypto";

const USER = "user-t157";
const callLog: string[] = [];

/** The admin's premium link domain, per test. */
let premiumLinkDomain = "";
// TASK_157 Phase 2 — the admin's links-account pin, and the `opts` the engine
// actually hands the resolver. Recording the call is the only way to prove the
// pin is FORWARDED: a stub that always returns a fixed account would pass every
// host test even if the engine had stopped passing the pin altogether.
let premiumLinksAccountId = "";
let lastResolveOpts: { requireWorkerToken?: boolean; pinAccountId?: string | null } | null = null;
// Flipped by the fail-closed test: proves a publish that cannot switch the
// workers.dev route on refuses, instead of reporting an unreachable link live.
let enableFails = false;

const USER_WORKER = `lnk-${createHash("sha256").update(USER).digest("hex").slice(0, 8)}`;

function fakeWorkers() {
  return {
    buildWorkerMapSource: (entries: unknown[]) => {
      callLog.push(`buildSource:${entries.length}`);
      return "// script";
    },
    assertZoneWritable: () => ({ ok: true }),
    defaultLinkHost: (z: string) => `go.${z}`,
    deleteWorkerRoute: async () => ({ ok: true, status: 200 }),
    deleteWorkerScript: async (_c: unknown, name: string) => {
      callLog.push(`deleteScript:${name}`);
      return { ok: true, status: 200 };
    },
    enableWorkerOnWorkersDev: async (_c: unknown, name: string) => {
      callLog.push(`enable:${name}`);
      return enableFails
        ? { ok: false, status: 403, error: "Cloudflare returned 403." }
        : { ok: true, status: 200 };
    },
    ensureProxiedRecord: async () => {
      callLog.push("ensureRecord");
      return { ok: true, status: 200 };
    },
    ensureZoneActive: async (_c: unknown, host: string) => {
      callLog.push(`ensureZone:${host}`);
      // A workers.dev host is NOT in any zone, which is exactly what the real
      // call reports — so a test that wrongly let the zoned path run for one
      // fails loudly here instead of silently passing.
      if (host.endsWith(".workers.dev")) {
        return { ok: false, status: 404, error: `No zone for ${host}` };
      }
      return { ok: true, status: 200, value: { zoneId: "zone-1", zoneName: "instaweb.top" } };
    },
    hostFromRoutePattern: (p: string) => p.replace(/\/\*+$/, ""),
    listActiveZones: async () => {
      callLog.push("listZones");
      return { ok: true, status: 200, value: [{ id: "z1", name: "instaweb.top", status: "active" }] };
    },
    listWorkerRoutes: async () => ({ ok: true, status: 200, value: [] }),
    putWorkerRoute: async () => {
      callLog.push("putRoute");
      return { ok: true, status: 200 };
    },
    reservedZoneMessage: () => "reserved",
    routePatternFor: (h: string) => `${h}/*`,
    uploadWorkerScript: async (_c: unknown, name: string) => {
      callLog.push(`upload:${name}`);
      return { ok: true, status: 200 };
    },
    workerNameForUser: (id: string) => `lnk-${createHash("sha256").update(id).digest("hex").slice(0, 8)}`,
    legacyWorkerNameForUser: (id: string) => `sw-${createHash("sha256").update(id).digest("hex").slice(0, 32)}`,
  };
}

// ---------------------------------------------------------------------------
// Require hook: only this module's own dependencies are swapped.
// ---------------------------------------------------------------------------

type Loader = { _load: (r: string, p: NodeModule | undefined, m: boolean) => unknown };
const MODULE_UNDER_TEST = "lib/hosting/links-engine.ts";

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    const from = parent?.filename ?? "";
    // `server-only` throws on import by design. Stubbed globally (as the vantra
    // suite does) so a module that slips past a path check fails loudly on its
    // OWN logic instead of on this sentinel.
    if (request === "server-only") return {};
    // `../admin-settings` is server-only + prisma. Stubbed by NAME rather than
    // exact specifier so the stub holds however tsx resolves it.
    if (request.includes("admin-settings")) {
      return {
        getAdminSettings: async () => ({
          hostingPremiumLinkDomain: premiumLinkDomain,
          hostingPremiumLinksAccountId: premiumLinksAccountId,
        }),
      };
    }
    if (from.endsWith(`/${MODULE_UNDER_TEST}`)) {
      if (request === "../prisma") {
        return { prisma: { linkRedirect: { findMany: async () => [], findFirst: async () => null } } };
      }
      if (request === "./cloudflare") return { verifyCredential: async () => ({ ok: true, status: 200 }) };
      if (request === "./credentials") return { getHostingCredentialById: async () => null };
      if (request === "./platform-accounts") {
        return {
          resolvePlatformCredential: async (
          _verify: unknown,
          opts?: { requireWorkerToken?: boolean; pinAccountId?: string | null }
        ) => {
          lastResolveOpts = opts ?? null;
          return {
            ok: true,
            status: 200,
            value: { accountId: "cf-1", workerToken: "tok" },
          };
        },
        };
      }
      if (request === "./workers") return fakeWorkers();
    }
    return original.call(this, request, parent, isMain);
  };
}

installRequireHook();

/* eslint-disable @typescript-eslint/no-require-imports */
const engine = require("../lib/hosting/links-engine") as typeof import("../lib/hosting/links-engine");
/* eslint-enable @typescript-eslint/no-require-imports */

beforeEach(() => {
  callLog.length = 0;
  premiumLinkDomain = "";
  premiumLinksAccountId = "";
  lastResolveOpts = null;
  enableFails = false;
});

test("a workers.dev premium domain publishes by uploading the script ALONE", async () => {
  premiumLinkDomain = "swdocs.workers.dev";

  const res = await engine.publishUserMap(USER, { credentialId: null });

  assert.equal(res.ok, true, `publish failed: ${JSON.stringify(res)}`);
  const LEGACY_WORKER = `sw-${createHash("sha256").update(USER).digest("hex").slice(0, 32)}`;
  assert.deepEqual(
    callLog,
    ["buildSource:0", "upload:" + USER_WORKER, "enable:" + USER_WORKER, "deleteScript:" + LEGACY_WORKER],
    "no zone lookup, no DNS record, no route — but the workers.dev route IS switched on, and the orphaned long-named script is cleaned up"
  );
  assert.equal(res.ok && res.value.customHost, `${USER_WORKER}.swdocs.workers.dev`);
});

test("the workers.dev publish records NO route, so teardown cannot strand the script", async () => {
  premiumLinkDomain = "swdocs.workers.dev";

  const published = await engine.publishUserMap(USER, { credentialId: null });
  assert.equal(published.ok, true);
  const pattern = published.ok ? published.value.routePattern : "unreachable";
  assert.equal(pattern, null, "a route pattern here would send teardown after a route that never existed");

  // mapIdentityFor MUST agree with the publish. Teardown is handed only a stored
  // pattern and is fail-closed on "route not confirmed gone", so a mismatch here
  // leaves the user's Worker alive forever after they delete their last link.
  const identity = engine.mapIdentityFor(USER, `${USER_WORKER}.swdocs.workers.dev`);
  assert.equal(identity.routePattern, null, "identity and publish must both say 'no route'");
  assert.equal(identity.workerName, USER_WORKER);
});

test("a workers.dev host is per-USER, so two users cannot overwrite each other", async () => {
  premiumLinkDomain = "swdocs.workers.dev";

  await engine.publishUserMap(USER, { credentialId: null });
  const mine = engine.mapIdentityFor(USER, `${USER_WORKER}.swdocs.workers.dev`).workerName;
  const theirs = engine.mapIdentityFor("user-elsewhere", "sw-theirs.swdocs.workers.dev").workerName;

  assert.notEqual(theirs, mine, "a shared host would let the last publish clobber everyone else");
});

test("a ZONED premium domain still takes the full DNS + route publish", async () => {
  // The regression guard for the fast path: adding it must not divert the
  // existing instaweb behaviour onto the wrong branch.
  premiumLinkDomain = "go.instaweb.top";

  const res = await engine.publishUserMap(USER, { credentialId: null });

  assert.equal(res.ok, true);
  assert.ok(callLog.includes("ensureZone:go.instaweb.top"), "a zoned host must still resolve its zone");
  assert.ok(callLog.includes("ensureRecord"), "and still create the DNS record");
  assert.ok(callLog.includes("putRoute"), "and still install the route");
  assert.equal(res.ok && res.value.customHost, "go.instaweb.top");
  assert.equal(res.ok && res.value.routePattern, "go.instaweb.top/*");
});

test("mapIdentityFor still returns a route pattern for a zoned host", () => {
  assert.equal(engine.mapIdentityFor(USER, "go.instaweb.top").routePattern, "go.instaweb.top/*");
});

// ---------------------------------------------------------------------------
// TASK_157 Phase 2 — the links-account pin is FORWARDED to the resolver.
// ---------------------------------------------------------------------------

test("a premium platform publish forwards the admin's links-account pin", async () => {
  premiumLinksAccountId = "43b24dc00bea90102ede000000000000";

  // credentialId null = the platform roster, which is the only branch that routes.
  const res = await engine.resolveWorkerCredential(USER, null);

  assert.equal(res.ok, true);
  assert.ok(lastResolveOpts, "the resolver must actually have been asked");
  assert.equal(lastResolveOpts?.pinAccountId, "43b24dc00bea90102ede000000000000");
  assert.equal(
    lastResolveOpts?.requireWorkerToken,
    true,
    "the pin is ADDED to the existing Workers-token requirement, never in place of it"
  );
});

test("with no pin configured the resolver is asked for rotation, not a pin", async () => {
  const res = await engine.resolveWorkerCredential(USER, null);

  assert.equal(res.ok, true);
  assert.ok(lastResolveOpts, "the resolver must actually have been asked");
  assert.equal(
    lastResolveOpts?.pinAccountId,
    "",
    "an unset pin must arrive as empty so the resolver does automatic rotation"
  );
});

test("a BYO publish never consults the platform pin at all", async () => {
  premiumLinksAccountId = "43b24dc00bea90102ede000000000000";

  // The stub returns no credential, so this takes the "no such credential" branch
  // — but it must have taken it WITHOUT asking the platform roster. Routing a
  // user's own Cloudflare account by an admin pin would be the "ours vs yours"
  // contract breaking.
  await engine.resolveWorkerCredential(USER, "cred_does_not_exist");

  assert.equal(lastResolveOpts, null, "BYO must not reach the platform resolver");
});

// ---------------------------------------------------------------------------
// TASK_157 — the workers.dev route must be switched ON, never assumed on.
//
// Live bug, found 2026-10-04. A script uploaded through the API is created with
// its workers.dev route DISABLED, so `<worker>.swdocs.workers.dev` answered
// 404 / error code 1042 forever while every step of the publish reported success.
// The Cloudflare dashboard enables the route for you when you click
// "Create Worker"; the API does not. Verified end to end against the real
// account: PUT 200 -> host 404 -> POST subdomain {enabled:true} -> host 200.
// ---------------------------------------------------------------------------

test("a ZONED publish never switches on a workers.dev route", async () => {
  // The guard against over-applying the fix. The zoned path shares
  // uploadWorkerScript, so enabling the workers.dev route there would expose a
  // BYO user's worker on a public *.workers.dev hostname they never configured —
  // a silent leak on top of the domain they actually asked for.
  premiumLinkDomain = "go.instaweb.top";

  const res = await engine.publishUserMap(USER, { credentialId: null });

  assert.equal(res.ok, true, `publish failed: ${JSON.stringify(res)}`);
  assert.equal(
    callLog.some((c) => c.startsWith("enable:")),
    false,
    "a zoned publish must not touch the workers.dev route at all"
  );
});

test("a publish that cannot switch the workers.dev route on FAILS CLOSED", async () => {
  premiumLinkDomain = "swdocs.workers.dev";
  enableFails = true;

  const res = await engine.publishUserMap(USER, { credentialId: null });

  assert.equal(
    res.ok,
    false,
    "an unreachable worker must never be reported as successfully published"
  );
  assert.equal(!res.ok && res.code, "cf_error");
  assert.ok(
    callLog.includes("upload:" + USER_WORKER),
    "the script upload is attempted first — the route cannot be enabled before it exists"
  );
});
