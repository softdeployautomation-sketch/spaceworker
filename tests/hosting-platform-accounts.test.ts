import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { randomUUID } from "node:crypto";

// TASK_155 P6a (PLAN §19) — the platform-account roster, rotation and gates.
//
// These rules would otherwise only be provable by publishing a real site on the
// live VPS, so they are proven here against the REAL module with a fake Prisma
// and an INJECTED verifier (`resolvePlatformCredential` takes `verify` as a
// parameter precisely so rotation order is testable with no network call and no
// real Cloudflare account).
//
// One test per rule the plan states:
//   * rotation walks ASCENDING priority, skipping red and disabled rows
//   * a dead primary moves on to the next account AND gets marked red
//   * the kill switch stops every resolve (no decrypt, no network)
//   * empty and all-red rosters fail CLOSED — never a silent fallback, always in
//     plain language rather than a raw Cloudflare string
//   * the token is encrypted at rest and never appears in a view
//   * a new row APPENDS, so adding a backup cannot steal traffic from the primary

(process.env as Record<string, string>).NODE_ENV = "test";
process.env.APP_BASE_URL = "https://spaceworker.test";
// platform-accounts.ts -> mailbox-crypto.ts reads MAILBOX_ENCRYPTION_KEY at import
// time; a real 32-byte hex key keeps the real AES-256-GCM path loadable.
process.env.MAILBOX_ENCRYPTION_KEY = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");

// TASK_155 P6a (PLAN §19) — the platform-account roster, rotation and gates.
//
// These rules would otherwise only be provable by publishing a real site on the
// live VPS, so they are proven here against the REAL module with a fake Prisma
// and an INJECTED verifier (`resolvePlatformCredential` takes `verify` as a
// parameter precisely so rotation order is testable with no network call and no
// real Cloudflare account).
//
// One test per rule the plan states:
//   * rotation walks ASCENDING priority, skipping red and disabled rows
//   * a dead primary moves on to the next account AND gets marked red
//   * the kill switch stops every resolve (no decrypt, no network)
//   * empty and all-red rosters fail CLOSED — never a silent fallback, always in
//     plain language rather than a raw Cloudflare string
//   * the token is encrypted at rest and never appears in a view
//   * a new row APPENDS, so adding a backup cannot steal traffic from the primary

(process.env as Record<string, string>).NODE_ENV = "test";
process.env.APP_BASE_URL = "https://spaceworker.test";
// platform-accounts.ts -> mailbox-crypto.ts reads MAILBOX_ENCRYPTION_KEY at import
// time; a real 32-byte hex key keeps the real AES-256-GCM path loadable.
process.env.MAILBOX_ENCRYPTION_KEY = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");

type Row = {
  id: string;
  accountId: string;
  label: string;
  tokenCiphertext: string;
  tokenIv: string;
  tokenTag: string;
  tokenHint: string;
  priority: number;
  status: string;
  lastVerifiedAt: Date | null;
  verifyError: string | null;
  createdAt: Date;
};

let rows: Row[] = [];
let adminRow: Record<string, unknown> = { hostingEnabled: true, hostingPlatformCfEnabled: true };
let seq = 0;
/** The one user row the premium gates read (free by default). */
let premiumUser: { id: string; tier: number; premiumExpiresAt: Date | null } = {
  id: "user_1",
  tier: 0,
  premiumExpiresAt: null,
};

/** Matches only the predicates the module uses, so a wrong `where` fails loudly. */
function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => (row as unknown as Record<string, unknown>)[k] === v);
}

function sortRows(hits: Row[], orderBy: unknown): Row[] {
  if (!orderBy) return hits;
  return [...hits].sort((a, b) => {
    for (const o of orderBy as Array<Record<string, string>>) {
      const key = Object.keys(o)[0];
      const dir = o[key] === "desc" ? -1 : 1;
      const delta =
        key === "priority"
          ? (a.priority - b.priority) * dir
          : (a.createdAt.getTime() - b.createdAt.getTime()) * dir;
      if (delta !== 0) return delta;
    }
    return 0;
  });
}

const fakePrisma = {
  // `user` is here because lib/hosting/files.ts `resolveCapsForUser` reads the
  // tier through the SAME stub (that module is already cached by the time the
  // createSite tests load sites.ts), so the premium flag comes from one row.
  user: { findUnique: async () => premiumUser },
  hostingPlatformAccount: {
    create: async ({ data }: { data: Partial<Row> }) => {
      const row: Row = {
        id: "pa_" + ++seq,
        lastVerifiedAt: null,
        verifyError: null,
        createdAt: new Date(),
        tokenCiphertext: "",
        tokenIv: "",
        tokenTag: "",
        ...data,
      } as Row;
      rows.push(row);
      return row;
    },
    findUnique: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null,
    findFirst: async ({ orderBy }: { orderBy?: { priority: string } }) =>
      sortRows(rows, orderBy)[0] ?? null,
    findMany: async ({ where, orderBy }: { where?: Record<string, unknown>; orderBy?: unknown }) =>
      sortRows(rows.filter((r) => (where ? matches(r, where) : true)), orderBy),
    update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      const row = rows.find((r) => r.id === where.id);
      if (!row) throw new Error("not found");
      Object.assign(row, data);
      return row;
    },
    count: async ({ where }: { where?: Record<string, unknown> }) =>
      rows.filter((r) => (where ? matches(r, where) : true)).length,
  },
};

function installRequireHook(): void {
  const loader = Module as unknown as { _load: (r: string, p: NodeModule | undefined, m: boolean) => unknown };
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    const from = parent?.filename ?? "";
    if (from.includes("/lib/hosting/")) {
      if (request === "../prisma") return { prisma: fakePrisma };
      if (request === "../admin-settings") return { getAdminSettings: async () => ({ ...adminRow }) };
    }
    return original.call(this, request, parent, isMain);
  };
}

installRequireHook();

/* eslint-disable @typescript-eslint/no-require-imports */
const mod = require("../lib/hosting/platform-accounts") as typeof import("../lib/hosting/platform-accounts");
const crypto = require("../lib/mailbox-crypto") as typeof import("../lib/mailbox-crypto");
/* eslint-enable @typescript-eslint/no-require-imports */

const {
  createPlatformAccount,
  updatePlatformAccount,
  disablePlatformAccount,
  resolvePlatformCredential,
  healthyPlatformAccountCount,
  isPlatformEngineEnabled,
  listPlatformAccounts,
} = mod;

beforeEach(() => {
  rows = [];
  // hostingEnabled must be ON: `caps.enabled` gates createSite before anything else.
  adminRow = { hostingEnabled: true, hostingPlatformCfEnabled: true };
  premiumUser = { id: "user_1", tier: 0, premiumExpiresAt: null };
  seq = 0;
});

after(() => {
  rows = [];
});

const TOKEN = "cf-token-abcdefgh1234";
/** The token of the USER's own (BYO) credential — distinct so a mix-up is visible. */
const OWN_TOKEN = "cf-own-token-zzzz9999";

/** Add a healthy row directly, bypassing create() where the test is not about CRUD. */
function seed(overrides: Partial<Row> = {}): Row {
  const { ciphertext, iv, tag } = crypto.encryptSecret(TOKEN);
  const row: Row = {
    id: "pa_seed_" + ++seq,
    accountId: "acct_" + seq,
    label: "Account " + seq,
    tokenCiphertext: ciphertext,
    tokenIv: iv,
    tokenTag: tag,
    tokenHint: TOKEN.slice(-4),
    priority: 1,
    status: "active",
    lastVerifiedAt: new Date(),
    verifyError: null,
    createdAt: new Date(),
    ...overrides,
  };
  rows.push(row);
  return row;
}

const ok = { ok: true };
const bad = (error: string) => ({ ok: false, error });
// ---------------------------------------------------------------------------
// Rotation order (PLAN §19.2)
// ---------------------------------------------------------------------------

test("rotation: the LOWEST healthy priority serves first", async () => {
  seed({ accountId: "acct_second", priority: 2 });
  seed({ accountId: "acct_primary", priority: 1 });

  const res = await resolvePlatformCredential(async () => ok);
  assert.ok(res.ok, JSON.stringify(res));
  if (res.ok) assert.equal(res.value.accountId, "acct_primary");
});

test("rotation: a dead primary is marked red and the NEXT account serves", async () => {
  const primary = seed({ accountId: "acct_primary", priority: 1 });
  seed({ accountId: "acct_backup", priority: 2 });

  const tried: string[] = [];
  const res = await resolvePlatformCredential(async (c) => {
    tried.push(c.accountId);
    return c.accountId === "acct_primary" ? bad("That API token could not be verified.") : ok;
  });

  assert.ok(res.ok, JSON.stringify(res));
  if (res.ok) assert.equal(res.value.accountId, "acct_backup");
  assert.deepEqual(tried, ["acct_primary", "acct_backup"], "walked primary then backup, in order");
  assert.equal(primary.verifyError, "That API token could not be verified.", "the dead row is marked red");
});

test("rotation: an already-red row is skipped WITHOUT re-verifying it", async () => {
  seed({ accountId: "acct_red", priority: 1, verifyError: "Token expired." });
  seed({ accountId: "acct_good", priority: 2 });

  let calls = 0;
  const res = await resolvePlatformCredential(async () => {
    calls++;
    return ok;
  });

  assert.ok(res.ok, JSON.stringify(res));
  if (res.ok) assert.equal(res.value.accountId, "acct_good");
  assert.equal(calls, 1, "the red row cost no network call — rotation stays cheap once an account dies");
});

test("rotation: a disabled row is never used, even at priority 1", async () => {
  seed({ accountId: "acct_off", priority: 1, status: "disabled" });
  seed({ accountId: "acct_on", priority: 2 });

  const res = await resolvePlatformCredential(async () => ok);
  assert.ok(res.ok, JSON.stringify(res));
  if (res.ok) assert.equal(res.value.accountId, "acct_on");
});

test("rotation: the served token is the decrypted real token, and the row is stamped verified", async () => {
  const row = seed({ lastVerifiedAt: null });
  const res = await resolvePlatformCredential(async () => ok);
  assert.ok(res.ok, JSON.stringify(res));
  if (res.ok) {
    assert.equal(res.value.token, TOKEN, "the caller gets a usable token, not ciphertext");
    assert.equal(res.value.platformAccountId, row.id);
  }
  assert.ok(row.lastVerifiedAt instanceof Date, "a successful use stamps lastVerifiedAt");
  assert.equal(row.verifyError, null);
});

// ---------------------------------------------------------------------------
// Fail-CLOSED (PLAN §19.2) — never a silent fallback
// ---------------------------------------------------------------------------

test("kill switch: hostingPlatformCfEnabled = false stops every resolve", async () => {
  seed();
  adminRow = { hostingPlatformCfEnabled: false };

  let called = false;
  const res = await resolvePlatformCredential(async () => {
    called = true;
    return ok;
  });

  assert.equal(res.ok, false, "the kill switch is honoured");
  if (!res.ok) assert.equal(res.code, "platform_disabled");
  assert.equal(called, false, "no verify call, no decrypt — the engine is simply off");
  assert.equal(await isPlatformEngineEnabled(), false);
  assert.equal(await healthyPlatformAccountCount(), 0, "the picker stops offering Premium");
});

test("empty roster: a premium deploy with no accounts fails CLOSED in plain language", async () => {
  const res = await resolvePlatformCredential(async () => ok);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.code, "platform_empty");
    assert.match(res.message, /try again shortly/i);
    assert.doesNotMatch(res.message, /cloudflare\.com|1000|error code/i, "never a raw Cloudflare string");
  }
});

test("exhausted roster: every account dead fails CLOSED — never a silent local fallback", async () => {
  seed({ accountId: "acct_a", priority: 1 });
  seed({ accountId: "acct_b", priority: 2 });

  const res = await resolvePlatformCredential(async () => bad("Token expired."));
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, "platform_exhausted");
  assert.ok(rows.every((r) => r.verifyError), "both rows are now red, so the next deploy skips them cheaply");
});

test("exhausted roster: already-red rows cost nothing and report exhaustion", async () => {
  seed({ verifyError: "Token expired." });
  seed({ priority: 2, verifyError: "Token expired." });

  let called = false;
  const res = await resolvePlatformCredential(async () => {
    called = true;
    return ok;
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, "platform_exhausted");
  assert.equal(called, false);
});

test("healthyPlatformAccountCount counts only active, unred rows", async () => {
  seed();
  seed({ priority: 2, verifyError: "Token expired." });
  seed({ priority: 3, status: "disabled" });
  assert.equal(await healthyPlatformAccountCount(), 1);
});

// ---------------------------------------------------------------------------
// Token handling (P2 security discipline, reused)
// ---------------------------------------------------------------------------

test("create: the token is encrypted at rest and never echoed back", async () => {
  const result = await createPlatformAccount({ accountId: "acct_x", label: "Primary", token: TOKEN });
  assert.ok(result.ok, JSON.stringify(result));
  if (!result.ok) return;

  const row = rows[0];
  assert.notEqual(row.tokenCiphertext, TOKEN);
  assert.equal(crypto.decryptSecretOrThrow(row.tokenCiphertext, row.tokenIv, row.tokenTag, "test"), TOKEN);

  assert.equal(result.value.tokenHint, TOKEN.slice(-4), "only a 4-char hint is exposed");
  assert.equal((result.value as unknown as Record<string, unknown>).token, undefined);
});

test("create: a new row APPENDS to the rotation, so a backup cannot steal traffic", async () => {
  seed({ priority: 1 });
  await createPlatformAccount({ accountId: "acct_new", label: "Backup", token: TOKEN });
  assert.equal(rows[1].priority, 2, "appended after the existing primary");
});

test("create: rejects a blank account id, token or label", async () => {
  for (const input of [
    { accountId: "  ", label: "L", token: TOKEN },
    { accountId: "a", label: "L", token: "  " },
    { accountId: "a", label: "  ", token: TOKEN },
  ]) {
    const res = await createPlatformAccount(input);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.status, 400);
  }
  assert.equal(rows.length, 0, "nothing was written");
});

test("update: re-entering a token CLEARS the red mark so the row can serve again", async () => {
  const row = seed({ verifyError: "Token expired." });

  const res = await updatePlatformAccount({ id: row.id, token: "brand-new-token-9999" });
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(row.verifyError, null, "a fixed account is not condemned by rotation forever");
  assert.equal(row.tokenHint, "9999");
  assert.equal(
    crypto.decryptSecretOrThrow(row.tokenCiphertext, row.tokenIv, row.tokenTag, "test"),
    "brand-new-token-9999"
  );
});

test("update: omitting the token keeps the stored one", async () => {
  const row = seed();
  const before = row.tokenCiphertext;
  const res = await updatePlatformAccount({ id: row.id, label: "Renamed" });
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(row.tokenCiphertext, before, "a label edit must not need the token retyped");
  assert.equal(row.label, "Renamed");
});

test("update: reorder via priority, and disable is soft (the row is kept)", async () => {
  const first = seed({ priority: 1 });
  const second = seed({ priority: 2 });

  // Swap the two slots (both edits, so the order is unambiguous even when the
  // seed timestamps land in the same millisecond).
  await updatePlatformAccount({ id: second.id, priority: 1 });
  await updatePlatformAccount({ id: first.id, priority: 2 });

  const res = await resolvePlatformCredential(async () => ok);
  assert.ok(res.ok, JSON.stringify(res));
  if (res.ok) assert.equal(res.value.platformAccountId, second.id, "the re-ordered row is now primary");

  const off = await disablePlatformAccount(first.id);
  assert.ok(off.ok);
  assert.equal(first.status, "disabled");
  assert.equal(rows.length, 2, "disable keeps the row — it is history, not a hole in the audit trail");
  assert.equal((await listPlatformAccounts()).length, 2);
});

test("update: an unknown id is a 404, not a silent no-op", async () => {
  const res = await updatePlatformAccount({ id: "nope", label: "X" });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.status, 404);
});

test("update: rejects a bad status or a sub-1 priority", async () => {
  const row = seed();
  const a = await updatePlatformAccount({ id: row.id, status: "sideways" });
  assert.equal(a.ok, false);
  const b = await updatePlatformAccount({ id: row.id, priority: 0 });
  assert.equal(b.ok, false);
  assert.equal(row.status, "active", "a rejected edit changed nothing");
});


// ---------------------------------------------------------------------------
// The premium gate at site creation (PLAN §19.2 / §19.9 Q1)
// ---------------------------------------------------------------------------

// sites.ts is loaded with its OWN fake Prisma so `createSite` really runs — the
// gate must be proven where a user meets it, not only inside the resolver.
// It re-exposes `premiumUser` (above) so the premium flag is one fact, not two.
let createdSites: Array<Record<string, unknown>> = [];
/** Counts as "the user connected their own Cloudflare account". */
let userHasCredential = false;

const sitePrisma = {
  user: { findUnique: async () => premiumUser },
  hostingSite: {
    count: async () => createdSites.length,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      createdSites.push(data);
      return { id: "site_" + createdSites.length, createdAt: new Date(), ...data };
    },
  },
  hostingCredential: {
    findFirst: async () => (userHasCredential ? { id: "cred_1" } : null),
    findMany: async () => (userHasCredential ? [{ id: "cred_1", accountId: "acct_own" }] : []),
  },
  hostingPlatformAccount: fakePrisma.hostingPlatformAccount,
};

const loader2 = Module as unknown as { _load: (r: string, p: NodeModule | undefined, m: boolean) => unknown };
const originalLoad = loader2._load;
loader2._load = function patched2(request, parent, isMain) {
  const from = parent?.filename ?? "";
  if (from.endsWith("/lib/hosting/sites.ts")) {
    if (request === "../prisma") return { prisma: sitePrisma };
    if (request === "../premium") {
      return {
        isPremiumWithReversion: (u: { tier: number; premiumExpiresAt: Date | null }) => u.tier >= 5 && (u.premiumExpiresAt === null || u.premiumExpiresAt.getTime() > Date.now()),
      };
    }
    if (request === "./credentials") {
      return {
        getDefaultHostingCredential: async () => (userHasCredential ? { id: "cred_1", accountId: "acct_own", token: OWN_TOKEN } : null),
        getHostingCredentialById: async (_userId: string, id: string) =>
          userHasCredential && id === "cred_1"
            ? { id: "cred_1", accountId: "acct_own", token: OWN_TOKEN, tokenHint: OWN_TOKEN.slice(-4) }
            : null,
        markHostingCredentialVerified: async () => {},
        listHostingCredentials: async () => [],
      };
    }
    if (request === "./cloudflare") {
      return { verifyCredential: async () => ok, pagesAssetKey: (k: string) => k };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

/* eslint-disable @typescript-eslint/no-require-imports */
const sitesMod = require("../lib/hosting/sites") as typeof import("../lib/hosting/sites");
/* eslint-enable @typescript-eslint/no-require-imports */
const { createSite } = sitesMod;

const asPremium = () => {
  premiumUser = { id: "user_1", tier: 5, premiumExpiresAt: null };
};
const asFree = () => {
  premiumUser = { id: "user_1", tier: 0, premiumExpiresAt: null };
};

test("createSite: FREE + Premium option is refused — no silent platform access", async () => {
  asFree();
  createdSites = [];
  seed(); // a healthy platform account EXISTS — it is still not for free users

  const res = await createSite({ userId: "user_1", name: "Free site", engine: "cloudflare" });
  assert.equal(res.ok, false, "a free user must not get a platform deploy");
  if (!res.ok) {
    assert.equal(res.status, 403);
    assert.equal(res.code, "premium_required");
  }
  assert.equal(createdSites.length, 0, "nothing was created");
});

test("createSite: FREE + local is allowed — free hosting is for everyone", async () => {
  asFree();
  createdSites = [];
  const res = await createSite({ userId: "user_1", name: "Free site", engine: "local" });
  assert.ok(res.ok, JSON.stringify(res));
  if (res.ok) {
    assert.equal(res.value.engine, "local");
    assert.equal(res.value.credentialId, null);
  }
});

test("createSite: FREE + their OWN Cloudflare account is refused (BYO is premium, §19.9 Q1)", async () => {
  asFree();
  createdSites = [];
  userHasCredential = true;

  const res = await createSite({ userId: "user_1", name: "Own account", engine: "cloudflare", credentialId: "cred_1" });
  assert.equal(res.ok, false, "free users get exactly one engine: our metal");
  if (!res.ok) {
    assert.equal(res.status, 403);
    assert.equal(res.code, "premium_required");
  }
  assert.equal(createdSites.length, 0, "nothing was created");

  userHasCredential = false;
});

test("createSite: PREMIUM + cloudflare with no account and no healthy platform is refused honestly", async () => {
  asPremium();
  createdSites = [];
  // No roster at all: offering the option we cannot honour is the failure mode.
  const res = await createSite({ userId: "user_1", name: "Premium site", engine: "cloudflare" });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, "platform_empty");
  assert.equal(createdSites.length, 0);
});

test("createSite: PREMIUM + cloudflare is allowed once one platform account is healthy", async () => {
  asPremium();
  createdSites = [];
  seed();

  const res = await createSite({ userId: "user_1", name: "Premium site", engine: "cloudflare" });
  assert.ok(res.ok, JSON.stringify(res));
  if (res.ok) {
    assert.equal(res.value.engine, "cloudflare");
    assert.equal(res.value.credentialId, null, "NULL credentialId IS the platform-account path");
  }
});

test("createSite: PREMIUM + their OWN account is allowed — BYO survives with a full roster", async () => {
  asPremium();
  createdSites = [];
  seed(); // platform rows exist; a named credential must still be accepted
  userHasCredential = true;

  const res = await createSite({ userId: "user_1", name: "Yours", engine: "cloudflare", credentialId: "cred_1" });
  assert.ok(res.ok, JSON.stringify(res));
  if (res.ok) assert.equal(res.value.credentialId, "cred_1");

  userHasCredential = false;
});


// ---------------------------------------------------------------------------
// The deploy-time resolution matrix (PLAN §19.2) — the feature in one block
// ---------------------------------------------------------------------------

const { resolveDeployCredential } = sitesMod;

test("resolve: FREE + platform (NULL) → 403 premium_required, never a deploy", async () => {
  asFree();
  seed(); // a healthy roster exists; free users still may not use it

  const res = await resolveDeployCredential("user_1", null);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.status, 403);
    assert.equal(res.code, "premium_required");
  }
});

test("resolve: FREE + their own credential → 403 premium_required (BYO is premium too)", async () => {
  asFree();
  userHasCredential = true;
  seed();

  const res = await resolveDeployCredential("user_1", "cred_1");
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, "premium_required");

  userHasCredential = false;
});

test("resolve: PREMIUM + NULL → the PLATFORM account, even when the user has a default BYO", async () => {
  asPremium();
  const platform = seed(); // our account
  userHasCredential = true; // their account is ALSO there — it must not be preferred

  const res = await resolveDeployCredential("user_1", null);
  assert.ok(res.ok, JSON.stringify(res));
  if (res.ok) {
    assert.equal(res.value.accountId, platform.accountId, "Premium means OUR account, not theirs");
    assert.equal(res.value.token, TOKEN, "the decrypted platform token is what deploys");
    assert.equal(res.value.credentialId, "platform:" + platform.id);
  }

  userHasCredential = false;
});

test("resolve: PREMIUM + explicit BYO → THEIR account, even with a full platform roster", async () => {
  asPremium();
  const platform = seed(); // ours exists — it must not swallow a named credential
  userHasCredential = true;

  const res = await resolveDeployCredential("user_1", "cred_1");
  assert.ok(res.ok, JSON.stringify(res));
  if (res.ok) {
    assert.equal(res.value.accountId, "acct_own", "Yours means yours — never a silent switch to ours");
    assert.equal(res.value.credentialId, "cred_1");
    assert.notEqual(res.value.credentialId, platform.id, "the named row wins over the roster row");
    assert.notEqual(res.value.token, TOKEN, "and never the platform token");
  }

  userHasCredential = false;
});

test("resolve: PREMIUM + NULL + no platform row → plain-language 403, never local", async () => {
  asPremium(); // no seed(): the roster is empty
  userHasCredential = true; // even a default credential of their own does NOT save it

  const res = await resolveDeployCredential("user_1", null);
  assert.equal(res.ok, false, "no silent fallback — not to local, not to their own account");
  if (!res.ok) {
    assert.equal(res.status, 403);
    assert.equal(res.code, "platform_empty");
    assert.match(res.message, /try again shortly/i, "plain language, not a raw Cloudflare error");
  }

  userHasCredential = false;
});

test("resolve: the kill switch takes the platform branch down with a clean 403", async () => {
  asPremium();
  seed();
  adminRow = { hostingEnabled: true, hostingPlatformCfEnabled: false };

  const res = await resolveDeployCredential("user_1", null);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.status, 403);
    assert.equal(res.code, "platform_disabled");
  }

  adminRow = { hostingEnabled: true, hostingPlatformCfEnabled: true };
});