import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// TASK_158 W1 — the platform zone provisioner, in isolation.
//
// WHY THIS FILE EXISTS. `provisionDomainZone` is the ONLY code path that can talk
// to Cloudflare with the platform's ZONES token, so it is the one place where a
// mistake is both silent and expensive. The failures it must not have:
//
//   1. USING THE WRONG TOKEN. `resolvePlatformCredential` returns the Pages/general
//      `token` as well as the `zoneToken`. Creating a zone with `token` fails closed
//      (403) but makes the feature look broken; worse, a future token with a wider
//      scope would make it SUCCEED in a way nobody reasoned about. So the bearer is
//      asserted, byte for byte, on both the read and the create.
//   2. WRITING WHEN IT CANNOT. No Zones token on any eligible account must mean NO
//      Cloudflare call at all — not a call that fails. A create attempt we know is
//      unauthorized burns a rate-limit unit and lies in the audit trail.
//   3. ROTATION LANDING ON A ROW THAT CANNOT DO THE JOB. `requireZoneToken` must be
//      passed, so a healthy Pages-only account is never chosen over one holding the
//      grant.
//   4. LEAKING THE TOKEN. Every outcome is serialised into an HTTP response, so no
//      secret may appear in ANY field of it — error paths included.
//   5. DESTROYING AN EXISTING ZONE. "Zone already exists" is a normal answer, not a
//      failure: the zone lives in the user's own account. The right response is to
//      re-read it, never to retry, and never to clear the row.
//
// The Cloudflare/registry/admin-settings edges are FAKED; the module under test is
// the real one. Faking the edges rather than `fetch` is deliberate: it lets the
// assertions be about WHICH credential went to WHICH call, which a fetch-level stub
// could not express without reimplementing the module's own logic.
// ---------------------------------------------------------------------------

(process.env as Record<string, string>).NODE_ENV = "test";
process.env.APP_BASE_URL = "https://spaceworker.test";
process.env.MAILBOX_ENCRYPTION_KEY = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");

const PROVISION = "/lib/hosting/zone-provision.ts";

/** Secrets that must NEVER appear in the returned outcome. */
const PAGES_TOKEN = "pages_secret_token_value";
const WORKER_TOKEN = "workers_secret_token_value";
const ZONE_TOKEN = "zones_secret_token_value";

/** Every call the module made, so "did it touch Cloudflare?" is answerable. */
let calls: string[] = [];
let resolveResult: Record<string, unknown>;
let resolveOpts: Record<string, unknown> | null = null;
/** Cloudflare's /zones answer per apex; unset means "not in this account". */
let zoneByApex: Record<string, unknown> = {};
/** createZone's answer; null means "it must not be called in this test". */
let createResult: Record<string, unknown> | null = null;
/** The bearer the CREATE was handed, and the bearer each READ was handed. */
let createAuth: string[] = [];
let readAuth: string[] = [];
let recorded: Array<Record<string, unknown>> = [];
let recordResult: Record<string, unknown> | null = null;
let settings: Record<string, unknown> = { hostingPremiumSitesAccountId: "acct_premium" };

const fakeAdminSettings = {
  getAdminSettings: async () => settings,
};

const fakePlatformAccounts = {
  resolvePlatformCredential: async (_verify: unknown, opts: Record<string, unknown> = {}) => {
    calls.push("resolve");
    resolveOpts = opts;
    return resolveResult;
  },
};

const fakeCloudflare = {
  verifyCredential: async () => ({ ok: true }),
  createZone: async (cred: { accountId: string; token: string }, name: string) => {
    calls.push(`create:${name}`);
    createAuth.push(cred.token);
    if (!createResult) throw new Error("createZone must NOT be called in this test");
    return createResult;
  },
};

const fakeWorkers = {
  getZoneByName: async (cred: { token: string }, apex: string) => {
    calls.push(`zone:${apex}`);
    readAuth.push(cred.token);
    return zoneByApex[apex] ?? { ok: true, status: 200, value: null };
  },
};

const fakeRegistry = {
  recordDomainZoneState: async (userId: string, apex: string, state: Record<string, unknown>) => {
    calls.push(`record:${apex}`);
    recorded.push({ userId, apex, ...state });
    if (recordResult) return recordResult;
    return { ok: true, value: { ...state, selectable: state.status === "active" } };
  },
};

const loader = Module as unknown as {
  _load: (r: string, p: NodeModule | undefined, m: boolean) => unknown;
};
const originalLoad = loader._load;
loader._load = function patched(request, parent, isMain) {
  const from = parent?.filename ?? "";
  if (from.endsWith(PROVISION)) {
    if (request === "../admin-settings") return fakeAdminSettings;
    if (request === "./platform-accounts") return fakePlatformAccounts;
    if (request === "./cloudflare") return fakeCloudflare;
    if (request === "./workers") return fakeWorkers;
    if (request === "./domain-registry") return fakeRegistry;
  }
  return originalLoad.call(this, request, parent, isMain);
};

/* eslint-disable @typescript-eslint/no-require-imports */
interface Outcome {
  ok: boolean;
  zoneId: string | null;
  status: string;
  nameservers: string[] | null;
  note: string | null;
}
const { provisionDomainZone, MANUAL_ZONE_NOTE } = require("../lib/hosting/zone-provision") as {
  provisionDomainZone: (userId: string, apex: string) => Promise<Outcome>;
  MANUAL_ZONE_NOTE: string;
};
/* eslint-enable @typescript-eslint/no-require-imports */

beforeEach(() => {
  calls = [];
  resolveOpts = null;
  zoneByApex = {};
  createResult = null;
  createAuth = [];
  readAuth = [];
  recorded = [];
  recordResult = null;
  settings = { hostingPremiumSitesAccountId: "acct_premium" };
  resolveResult = {
    ok: true,
    value: {
      accountId: "acct_premium",
      token: PAGES_TOKEN,
      platformAccountId: "pa_1",
      label: "Primary CF",
      workerToken: WORKER_TOKEN,
      zoneToken: ZONE_TOKEN,
    },
  };
});

// ---------------------------------------------------------------------------
// The credential contract.
// ---------------------------------------------------------------------------

test("resolve: asks for a row that HOLDS a Zones token, pinned to the sites account", async () => {
  zoneByApex = { "example.com": { ok: true, status: 200, value: { zoneId: "z_1", status: "active", nameservers: ["a.ns"] } } };
  await provisionDomainZone("user_a", "example.com");

  assert.equal(resolveOpts?.requireZoneToken, true, "rotation must not land on a Pages-only row");
  // The pin is what keeps the zone in the SAME Cloudflare account as the Pages
  // project, which is a hard requirement for binding a custom domain later.
  assert.equal(resolveOpts?.pinAccountId, "acct_premium");
});

test("resolve: no eligible account means NO Cloudflare call at all — not a failed one", async () => {
  resolveResult = { ok: false, status: 403, code: "platform_exhausted", message: "No platform account can do this." };
  const out = await provisionDomainZone("user_a", "example.com");

  assert.equal(out.ok, false);
  assert.equal(out.note, MANUAL_ZONE_NOTE, "the fallback wording is the manual path, unchanged");
  assert.equal(calls.filter((c) => c.startsWith("zone:")).length, 0, "no read");
  assert.equal(calls.filter((c) => c.startsWith("create:")).length, 0, "no write");
  assert.equal(calls.filter((c) => c.startsWith("record:")).length, 0, "nothing recorded");
});

test("resolve: a row with requireZoneToken=true but a NULL zoneToken is still refused before any call", async () => {
  // Belt-and-braces: the filter should have dropped such a row, but if a future
  // resolver change returns one, the module must not fall through to the Pages
  // token and hammer Cloudflare with a guaranteed 403.
  resolveResult = {
    ok: true,
    value: {
      accountId: "acct_premium",
      token: PAGES_TOKEN,
      platformAccountId: "pa_1",
      label: "Pages only",
      workerToken: WORKER_TOKEN,
      zoneToken: null,
    },
  };
  const out = await provisionDomainZone("user_a", "example.com");

  assert.equal(out.ok, false);
  assert.equal(out.note, MANUAL_ZONE_NOTE);
  assert.deepEqual(calls, ["resolve"], "resolve, then nothing else");
});

// ---------------------------------------------------------------------------
// Which token reaches Cloudflare.
// ---------------------------------------------------------------------------

test("a zone already in OUR account is recorded — no create, and the ZONE token did the read", async () => {
  zoneByApex = {
    "example.com": {
      ok: true,
      status: 200,
      value: { zoneId: "z_7", status: "active", nameservers: ["a.ns.cloudflare.com", "b.ns.cloudflare.com"] },
    },
  };
  const out = await provisionDomainZone("user_a", "example.com");

  assert.equal(out.ok, true);
  assert.equal(out.zoneId, "z_7");
  assert.equal(out.status, "active");
  // The read is a Cloudflare call too, so it must carry the same narrow grant —
  // never the Pages/Workers token.
  assert.deepEqual(readAuth, [ZONE_TOKEN]);
  assert.equal(createAuth.length, 0, "an existing zone is never re-created");
  assert.deepEqual(recorded, [
    {
      userId: "user_a",
      apex: "example.com",
      zoneId: "z_7",
      status: "active",
      nameservers: ["a.ns.cloudflare.com", "b.ns.cloudflare.com"],
      note: null,
    },
  ]);
});

test("a genuinely absent zone is CREATED with the zone token, and its assigned nameservers are recorded", async () => {
  createResult = {
    ok: true,
    status: 200,
    value: { zoneId: "z_9", status: "pending", nameservers: ["ns1.cf.com", "ns2.cf.com"] },
  };
  const out = await provisionDomainZone("user_a", "example.com");

  assert.equal(out.ok, true);
  assert.equal(out.zoneId, "z_9");
  assert.equal(out.status, "pending");
  assert.deepEqual(out.nameservers, ["ns1.cf.com", "ns2.cf.com"]);
  // THE assertion this whole file is about: the bearer on the create is the ZONES
  // token, not `token`. Getting this wrong is the difference between a working
  // feature and a permanent 403.
  assert.deepEqual(createAuth, [ZONE_TOKEN]);
  assert.ok(!createAuth.includes(PAGES_TOKEN), "the Pages token must never be used for a zone write");
  assert.ok(!createAuth.includes(WORKER_TOKEN), "the Workers token must never be used for a zone write either");
  // A brand-new zone is NOT selectable — the user still has to set nameservers.
  assert.equal(out.note, "Cloudflare is holding this domain as pending. Set the nameservers below at your registrar to finish.");
});

test("'already exists' re-reads the zone instead of failing — nothing is created twice", async () => {
  const reread = {
    ok: true,
    status: 200,
    value: { zoneId: "z_other", status: "active", nameservers: ["x.ns.cloudflare.com"] },
  };
  // First read: absent. Second read (after the failed create): present, because the
  // zone was already live in another account.
  let reads = 0;
  zoneByApex = {
    get "example.com"() {
      reads += 1;
      return reads === 1 ? { ok: true, status: 200, value: null } : reread;
    },
  };
  createResult = { ok: false, status: 400, code: "zone_exists", error: "Zone already exists." };

  const out = await provisionDomainZone("user_a", "example.com");
  assert.equal(out.ok, true);
  assert.equal(out.zoneId, "z_other");
  assert.equal(calls.filter((c) => c.startsWith("zone:")).length, 2, "absent, then re-read");
  assert.equal(calls.filter((c) => c.startsWith("create:")).length, 1, "exactly one create attempt");
  assert.equal(recorded.length, 1);
});

// ---------------------------------------------------------------------------
// Failure modes — every one of them degrades to the manual note, never an error.
// ---------------------------------------------------------------------------

test("a read error is reported plainly and nothing is written", async () => {
  zoneByApex = { "example.com": { ok: false, status: 0, code: "network", error: "Could not reach Cloudflare." } };
  const out = await provisionDomainZone("user_a", "example.com");

  assert.equal(out.ok, false);
  assert.equal(out.note, "Could not reach Cloudflare.");
  assert.equal(createAuth.length, 0, "a failed read must not escalate into a create");
  assert.equal(recorded.length, 0);
});

test("a 403 from the create names the permission, and records nothing", async () => {
  createResult = {
    ok: false,
    status: 403,
    code: "zone_create_failed",
    // Cloudflare's actual wording for a missing grant. Paraphrasing it away is the
    // point of this branch.
    error: "Authentication error",
  };
  const out = await provisionDomainZone("user_a", "example.com");

  assert.equal(out.ok, false);
  assert.equal(out.zoneId, null);
  assert.equal(recorded.length, 0, "nothing is recorded for a zone that does not exist");
  assert.match(String(out.note), /Zone Create permission/, "the note must name the missing grant");
});

test("a non-403 create failure keeps Cloudflare's own words, redacted", async () => {
  createResult = { ok: false, status: 429, code: "zone_create_failed", error: "Rate limited, try later" };
  const out = await provisionDomainZone("user_a", "example.com");
  assert.equal(out.ok, false);
  assert.equal(out.note, "Rate limited, try later");
});

test("a create that succeeds but returns no zone is not treated as success", async () => {
  createResult = { ok: true, status: 200, value: null };
  const out = await provisionDomainZone("user_a", "example.com");

  assert.equal(out.ok, false);
  assert.equal(out.zoneId, null);
  assert.equal(recorded.length, 0);
});

test("a registry write failure is surfaced but never throws — the ADD already happened", async () => {
  createResult = { ok: true, status: 200, value: { zoneId: "z_9", status: "pending", nameservers: ["ns1.cf.com"] } };
  recordResult = { ok: false, status: 500, code: "db", message: "Could not save that domain." };

  const out = await provisionDomainZone("user_a", "example.com");
  assert.equal(out.ok, false);
  assert.equal(out.note, "Could not save that domain.");
  assert.equal(calls.filter((c) => c.startsWith("create:")).length, 1);
});

// ---------------------------------------------------------------------------
// Leakage — the outcome is serialised into an HTTP response, so it carries prose
// and identifiers only.
// ---------------------------------------------------------------------------

test("no outcome path ever exposes a token", async () => {
  const secrets = [PAGES_TOKEN, WORKER_TOKEN, ZONE_TOKEN];

  const scenarios: Array<{ label: string; setup: () => void }> = [
    {
      label: "no eligible account",
      setup: () => {
        resolveResult = { ok: false, status: 403, code: "platform_exhausted", message: "No platform account can do this." };
      },
    },
    {
      label: "null zone token",
      setup: () => {
        resolveResult = {
          ok: true,
          value: { accountId: "a", token: PAGES_TOKEN, platformAccountId: "pa_1", label: "x", workerToken: WORKER_TOKEN, zoneToken: null },
        };
      },
    },
    {
      label: "read failure",
      setup: () => {
        zoneByApex = { "example.com": { ok: false, status: 0, code: "network", error: "Cloudflare said no." } };
      },
    },
    {
      label: "create failure echoing the request",
      setup: () => {
        // A hostile/lazy API or proxy that quotes the offending Authorization header
        // back in its error body. 400 (not 403) so it goes down the pass-through
        // branch — the 403 branch returns fixed wording and could hide a redactor bug.
        createResult = { ok: false, status: 400, code: "zone_create_failed", error: `denied for ${ZONE_TOKEN}` };
      },
    },
    {
      label: "registry write failure echoing the request",
      setup: () => {
        // The row IS created, the zone really exists, but our own write failed and the
        // internal error quotes the bearer. The note still goes out in the same
        // response as everything else, so it is redacted on this path too.
        createResult = { ok: true, status: 200, value: { zoneId: "z_9", status: "pending", nameservers: ["ns1.cf.com"] } };
        recordResult = { ok: false, status: 500, code: "db", message: `save failed for ${ZONE_TOKEN}` };
      },
    },
    {
      label: "success",
      setup: () => {
        createResult = { ok: true, status: 200, value: { zoneId: "z_9", status: "pending", nameservers: ["ns1.cf.com"] } };
      },
    },
  ];

  for (const scenario of scenarios) {
    calls = [];
    createAuth = [];
    readAuth = [];
    zoneByApex = {};
    createResult = null;
    recordResult = null;
    resolveResult = {
      ok: true,
      value: {
        accountId: "acct_premium",
        token: PAGES_TOKEN,
        platformAccountId: "pa_1",
        label: "Primary CF",
        workerToken: WORKER_TOKEN,
        zoneToken: ZONE_TOKEN,
      },
    };
    scenario.setup();

    const out = await provisionDomainZone("user_a", "example.com");
    const serialised = JSON.stringify(out);
    for (const secret of secrets) {
      assert.ok(
        !serialised.includes(secret),
        `${scenario.label}: the outcome leaked a credential: ${serialised}`
      );
    }
    // The zone id IS safe to expose and the UI needs it.
    assert.equal(typeof out.status, "string");
  }
});
