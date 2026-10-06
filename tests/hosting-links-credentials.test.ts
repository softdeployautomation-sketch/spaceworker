import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { randomBytes } from "node:crypto";

// TASK_155 P2 — the hosting LINKS + CREDENTIALS engines
// (PLAN_TASK_155 §13, owner 2026-10-01: "we need the existing cf and also the
// insta can be used … option for users to add their own cf tokens and id … if
// users add multiple like 3, we should be able to switch between them").
//
// WHY THIS FILE EXISTS: the P2 acceptance list is otherwise only provable by
// hand on the VPS. Every case below drives the REAL `lib/hosting/links.ts` and
// `lib/hosting/credentials.ts` — not a copy of their logic — with `../prisma`,
// `../admin-settings` and `../premium` swapped for recording fakes through the
// house require hook (HOW_WE_MOVE_FAST §4), so no Postgres is needed.
//
// The encryption is REAL: credentials.ts runs the real `encryptSecret` against a
// real `MAILBOX_ENCRYPTION_KEY`, so "the token is stored encrypted and never
// returned" is a genuine assertion (the fake DB holds the ciphertext, and the
// test decrypts it back to prove the round-trip AND that no view ever carries it).
//
// What this file canNOT prove (per the task contract): that the P2 migration
// applies cleanly to the live DB, and that a real Cloudflare token authenticates
// against Cloudflare's API (that is P3, against the throwaway account). Those are
// live checks.

(process.env as Record<string, string>).NODE_ENV = "test";
// A real 32-byte key, hex — the same shape MAILBOX_ENCRYPTION_KEY must be, so the
// real AES-256-GCM path runs (a wrong-length key would throw at import).
process.env.MAILBOX_ENCRYPTION_KEY = randomBytes(32).toString("hex");

const USER = "user-t155p2";
const OTHER = "user-t155p2-other";

function uniqueError(): Error & { code: string } {
  const e = new Error("unique constraint") as Error & { code: string };
  e.code = "P2002";
  return e;
}

function matches(row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [key, expected] of Object.entries(where)) {
    if (key === "NOT") continue; // handled explicitly by updateMany below
    if (expected === undefined) continue;
    if (expected && typeof expected === "object" && !Array.isArray(expected)) continue; // e.g. { increment }
    if (row[key] !== expected) return false;
  }
  return true;
}

/** Apply Prisma-style `orderBy` ([{ col: "desc" }, …]) or a single object. */
function applyOrderBy<T extends Record<string, unknown>>(rows: T[], orderBy: unknown): T[] {
  if (!orderBy) return rows;
  const specs = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Array<Record<string, "asc" | "desc">>;
  return rows.slice().sort((a, b) => {
    for (const spec of specs) {
      for (const [col, dir] of Object.entries(spec)) {
        const av = a[col] as number | string | boolean;
        const bv = b[col] as number | string | boolean;
        if (av === bv) continue;
        const cmp = av < bv ? -1 : 1;
        return dir === "desc" ? -cmp : cmp;
      }
    }
    return 0;
  });
}

interface LinkRow {
  id: string;
  token: string;
  userId: string | null;
  slug: string | null;
  campaignId: string | null;
  target: string;
  label: string | null;
  clickCount: number;
  createdAt: Date;
  [k: string]: unknown;
}

interface CredRow {
  id: string;
  userId: string;
  provider: string;
  accountId: string;
  label: string;
  tokenCiphertext: string;
  tokenIv: string;
  tokenTag: string;
  tokenHint: string;
  isDefault: boolean;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  [k: string]: unknown;
}

let links: LinkRow[];
let creds: CredRow[];
let seq: number;
let adminRow: Record<string, unknown>;
let userRow: { tier: number; premiumExpiresAt: Date | null };

const fakePrisma = {
  user: { findUnique: async () => ({ ...userRow }) },
  linkRedirect: {
    count: async ({ where }: { where?: Record<string, unknown> }) => links.filter((r) => matches(r, where)).length,
    findMany: async ({ where }: { where?: Record<string, unknown> }) =>
      links.filter((r) => matches(r, where)).slice().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    findFirst: async ({ where }: { where?: Record<string, unknown> }) => links.find((r) => matches(r, where)) ?? null,
    findUnique: async ({ where }: { where: Record<string, unknown> }) => {
      if ("token" in where) return links.find((r) => r.token === where.token) ?? null;
      if ("slug" in where) return links.find((r) => r.slug === where.slug) ?? null;
      if ("id" in where) return links.find((r) => r.id === where.id) ?? null;
      return null;
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      if (links.some((r) => r.token === data.token)) throw uniqueError();
      if (data.slug != null && links.some((r) => r.slug === data.slug)) throw uniqueError();
      seq += 1;
      const row: LinkRow = {
        id: `link-${seq}`,
        token: String(data.token),
        userId: (data.userId as string | null) ?? null,
        slug: (data.slug as string | null) ?? null,
        campaignId: (data.campaignId as string | null) ?? null,
        target: String(data.target),
        label: (data.label as string | null) ?? null,
        clickCount: 0,
        createdAt: new Date(),
      };
      links.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = links.find((r) => r.id === where.id);
      if (!row) throw new Error("row not found");
      for (const [key, value] of Object.entries(data)) {
        if (value && typeof value === "object" && "increment" in (value as Record<string, unknown>)) {
          row[key] = (row[key] as number) + ((value as { increment: number }).increment as number);
          continue;
        }
        if (row[key] !== value && key === "slug" && value != null && links.some((r) => r.slug === value)) throw uniqueError();
        row[key] = value;
      }
      return row;
    },
    delete: async ({ where }: { where: { id: string } }) => {
      const idx = links.findIndex((r) => r.id === where.id);
      if (idx < 0) throw new Error("row not found");
      return links.splice(idx, 1)[0];
    },
  },
  hostingCredential: {
    count: async ({ where }: { where?: Record<string, unknown> }) => creds.filter((r) => matches(r, where)).length,
    findMany: async ({ where }: { where?: Record<string, unknown> }) => creds.filter((r) => matches(r, where)),
    // TASK_158 W2 — the read-back proof re-reads the row by id after every token
    // write, so this stub needs `findUnique`. Its absence is what made six of these
    // tests fail with "findUnique is not a function" when the guarantee landed —
    // a useful reminder that a new read path is a real change to every fake.
    findUnique: async ({ where }: { where: { id: string } }) => creds.find((r) => r.id === where.id) ?? null,
    findFirst: async ({ where, orderBy }: { where?: Record<string, unknown>; orderBy?: unknown }) => {
      let hit = creds.filter((r) => matches(r, where));
      hit = applyOrderBy(hit, orderBy);
      return hit[0] ?? null;
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      seq += 1;
      const row: CredRow = {
        id: `cred-${seq}`,
        userId: String(data.userId),
        provider: String(data.provider ?? "cloudflare"),
        accountId: String(data.accountId),
        label: String(data.label),
        tokenCiphertext: String(data.tokenCiphertext),
        tokenIv: String(data.tokenIv),
        tokenTag: String(data.tokenTag),
        tokenHint: String(data.tokenHint),
        isDefault: Boolean(data.isDefault ?? false),
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      creds.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = creds.find((r) => r.id === where.id);
      if (!row) throw new Error("row not found");
      for (const [key, value] of Object.entries(data)) row[key] = value;
      row.updatedAt = new Date();
      return row;
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hit = creds.filter(
        (r) => matches(r, where) && (!("NOT" in where) || (where.NOT as { id: string }).id !== r.id)
      );
      for (const row of hit) for (const [key, value] of Object.entries(data)) row[key] = value;
      return { count: hit.length };
    },
  },
  $transaction: async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]),
};

// Any module under lib/hosting/ gets its DB + settings + premium deps swapped, so
// links.ts, credentials.ts AND the files.ts they import all share the same fakes.
function installRequireHook(): void {
  const loader = Module as unknown as { _load: (r: string, p: NodeModule | undefined, m: boolean) => unknown };
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    const from = parent?.filename ?? "";
    if (from.includes("/lib/hosting/")) {
      if (request === "../prisma") return { prisma: fakePrisma };
      if (request === "../admin-settings") return { getAdminSettings: async () => ({ ...adminRow }) };
      if (request === "../premium") {
        return {
          isPremiumWithReversion: (u: { tier: number; premiumExpiresAt: Date | null }) =>
            u.tier >= 5 && (u.premiumExpiresAt === null || u.premiumExpiresAt.getTime() > Date.now()),
        };
      }
    }
    return original.call(this, request, parent, isMain);
  };
}

installRequireHook();

/* eslint-disable @typescript-eslint/no-require-imports */
const linksMod = require("../lib/hosting/links") as typeof import("../lib/hosting/links");
const credsMod = require("../lib/hosting/credentials") as typeof import("../lib/hosting/credentials");
const crypto = require("../lib/mailbox-crypto") as typeof import("../lib/mailbox-crypto");
const rulesMod = require("../lib/hosting/rules") as typeof import("../lib/hosting/rules");
/* eslint-enable @typescript-eslint/no-require-imports */

beforeEach(() => {
  links = [];
  creds = [];
  seq = 0;
  userRow = { tier: 1, premiumExpiresAt: null };
  adminRow = {
    hostingEnabled: true,
    hostingProvider: "local",
    hostingFreeStorageQuotaMb: 1024,
    hostingFreeMaxFileSizeMb: 512,
    hostingFreeMaxFiles: 500,
    hostingFreeMaxBandwidthGbPerMonth: 50,
    hostingFreeMaxLinks: 3,
    hostingPremiumMaxLinks: 8,
    hostingPremiumStorageQuotaMb: 10240,
    hostingPagesMaxAssetMb: 20,
    hostingPlatformTokenTtlHours: 24,
  };
});

// ---------------------------------------------------------------------------
// links.ts
// ---------------------------------------------------------------------------

/** Helper: the single user-owned link row in the fake DB. */
function linked(): LinkRow {
  return links.find((r) => r.userId === USER)!;
}

test("createHostedLink: mints a user-owned link that resolves by slug on the shared /r route", async () => {
  const res = await linksMod.createHostedLink({ userId: USER, target: "https://example.com/offer", label: "Offer", slug: "my-offer" });
  assert.ok(res.ok, JSON.stringify(res));
  if (!res.ok) return;
  assert.equal(res.value.slug, "my-offer");
  assert.equal(res.value.shortPath, "/r/my-offer");
  // The row is a LinkRedirect with a userId — the SAME table /r/<token> serves.
  assert.equal(links.length, 1);
  assert.equal(links[0].userId, USER);
  // ...and the slug key resolves it.
  const found = await linksMod.resolveLink("my-offer");
  assert.deepEqual(found, { id: res.value.id, target: "https://example.com/offer" });
});

test("createHostedLink: a javascript: target is refused (the XSS guard on a world-readable route)", async () => {
  const res = await linksMod.createHostedLink({ userId: USER, target: "javascript:alert(1)" });
  assert.ok(!res.ok && res.status === 400 && res.code === "invalid_target");
  assert.equal(links.length, 0);
});

test("createHostedLink: a slug collision is a clean 409, never a 500", async () => {
  const first = await linksMod.createHostedLink({ userId: USER, target: "https://a.test", slug: "taken" });
  assert.ok(first.ok);
  const second = await linksMod.createHostedLink({ userId: OTHER, target: "https://b.test", slug: "taken" });
  assert.ok(!second.ok && second.status === 409 && second.code === "slug_taken");
});

test("createHostedLink: the per-user link cap is enforced (admin dial), and CAMPAIGN links never count toward it", async () => {
  adminRow.hostingFreeMaxLinks = 2;
  // A pre-existing anonymous campaign link (userId NULL) sits in the table.
  links.push({
    id: "link-campaign", token: "CampaignTokenAAA", userId: null, slug: null, campaignId: "camp-1",
    target: "https://campaign.test", label: null, clickCount: 7, createdAt: new Date(),
  });
  assert.ok((await linksMod.createHostedLink({ userId: USER, target: "https://one.test" })).ok);
  assert.ok((await linksMod.createHostedLink({ userId: USER, target: "https://two.test" })).ok);
  const third = await linksMod.createHostedLink({ userId: USER, target: "https://three.test" });
  assert.ok(!third.ok && third.status === 400 && third.code === "quota_links");
  // The campaign link is untouched and still out of the user's list.
  assert.equal(links.find((r) => r.id === "link-campaign")?.clickCount, 7);
  assert.equal((await linksMod.listHostedLinks(USER)).length, 2);
});

test("createHostedLink: a PREMIUM user gets hostingPremiumMaxLinks, not the free dial (PLAN §17.2)", async () => {
  adminRow.hostingFreeMaxLinks = 2;
  adminRow.hostingPremiumMaxLinks = 3;
  // The fake lib/premium swaps in considers tier >= 5 premium.
  userRow = { tier: 5, premiumExpiresAt: null };
  assert.ok((await linksMod.createHostedLink({ userId: USER, target: "https://one.test" })).ok);
  assert.ok((await linksMod.createHostedLink({ userId: USER, target: "https://two.test" })).ok);
  assert.ok((await linksMod.createHostedLink({ userId: USER, target: "https://three.test" })).ok);
  // The FREE dial (2) would already have refused the third link above.
  const fourth = await linksMod.createHostedLink({ userId: USER, target: "https://four.test" });
  assert.ok(!fourth.ok && fourth.status === 400 && fourth.code === "quota_links");
  assert.match(fourth.ok ? "" : fourth.message, /limit of 3 links/);
});

test("updateHostedLink / deleteHostedLink: a user can only touch their OWN link, never a campaign link", async () => {
  const mine = await linksMod.createHostedLink({ userId: USER, target: "https://mine.test" });
  assert.ok(mine.ok);
  if (!mine.ok) return;
  links.push({
    id: "link-campaign", token: "CampaignTokenAAA", userId: null, slug: null, campaignId: "camp-1",
    target: "https://campaign.test", label: null, clickCount: 0, createdAt: new Date(),
  });

  const editForeign = await linksMod.updateHostedLink({ userId: OTHER, id: mine.value.id, label: "hijack" });
  assert.ok(!editForeign.ok && editForeign.status === 404);
  const delForeign = await linksMod.deleteHostedLink(OTHER, mine.value.id);
  assert.ok(!delForeign.ok && delForeign.status === 404);
  // A campaign link (userId NULL) can never be reached through a user id.
  const delCampaign = await linksMod.deleteHostedLink(USER, "link-campaign");
  assert.ok(!delCampaign.ok && delCampaign.status === 404);
  assert.equal(links.filter((r) => r.campaignId === "camp-1").length, 1);

  const retarget = await linksMod.updateHostedLink({ userId: USER, id: mine.value.id, target: "https://moved.test", slug: "moved" });
  assert.ok(retarget.ok);
  if (retarget.ok) assert.equal(retarget.value.shortPath, "/r/moved");
  // NEVER touches the stored token.
  assert.equal(linked().token, mine.value.token);
});

test("recordLinkClick: counts the click, best-effort, without breaking the redirect", async () => {
  const res = await linksMod.createHostedLink({ userId: USER, target: "https://count.test" });
  assert.ok(res.ok);
  if (!res.ok) return;
  await linksMod.recordLinkClick(res.value.id);
  await linksMod.recordLinkClick(res.value.id);
  assert.equal(linked().clickCount, 2);
});

test("resolveLink: an unknown key returns null (the route 404s cleanly, never throws)", async () => {
  assert.equal(await linksMod.resolveLink("does-not-exist"), null);
});

// ---------------------------------------------------------------------------
// credentials.ts
// ---------------------------------------------------------------------------

test("createHostingCredential: stores the token ENCRYPTED and returns only a 4-char hint — never the token", async () => {
  const secret = "cf-api-token-super-secret-1234";
  const res = await credsMod.createHostingCredential({ userId: USER, accountId: "acct-1", label: "Main", token: secret });
  assert.ok(res.ok, JSON.stringify(res));
  if (!res.ok) return;
  // The view has no token field at all, and the hint is only the last 4 chars.
  assert.equal(res.value.tokenHint, "1234");
  assert.ok(!("token" in res.value), "the view must never carry the token");
  assert.ok(!JSON.stringify(res.value).includes(secret), "the raw token must never be in a response view");
  // The DB row holds ciphertext, not the plaintext.
  const stored = creds[0];
  assert.notEqual(stored.tokenCiphertext, secret);
  assert.ok(!stored.tokenCiphertext.includes(secret));
  // ...and it decrypts back with the real key (proves the round-trip engine works).
  assert.equal(crypto.decryptSecret(stored.tokenCiphertext, stored.tokenIv, stored.tokenTag), secret);
});

test("createHostingCredential: the FIRST credential a user adds becomes the default automatically", async () => {
  const one = await credsMod.createHostingCredential({ userId: USER, accountId: "a1", label: "One", token: "tok-one-aaaa" });
  assert.ok(one.ok);
  if (one.ok) assert.equal(one.value.isDefault, true);
  const two = await credsMod.createHostingCredential({ userId: USER, accountId: "a2", label: "Two", token: "tok-two-bbbb" });
  assert.ok(two.ok);
  if (two.ok) assert.equal(two.value.isDefault, false);
});

test("switch between multiple credentials: exactly one default per provider holds, and the resolver returns it decrypted", async () => {
  const a = await credsMod.createHostingCredential({ userId: USER, accountId: "acct-a", label: "A", token: "token-aaaa" });
  const b = await credsMod.createHostingCredential({ userId: USER, accountId: "acct-b", label: "B", token: "token-bbbb" });
  const c = await credsMod.createHostingCredential({ userId: USER, accountId: "acct-c", label: "C", token: "token-cccc" });
  assert.ok(a.ok && b.ok && c.ok);
  if (!a.ok || !b.ok || !c.ok) return;

  // Three credentials, one default (A — the first).
  assert.equal((await credsMod.listHostingCredentials(USER)).length, 3);
  assert.equal(creds.filter((r) => r.isDefault).length, 1);

  // Switch to C.
  const switched = await credsMod.setDefaultHostingCredential(USER, c.value.id);
  assert.ok(switched.ok);
  if (switched.ok) assert.equal(switched.value.isDefault, true);
  assert.equal(creds.filter((r) => r.isDefault).length, 1, "switching must leave exactly one default");
  assert.equal(creds.find((r) => r.id === c.value.id)?.isDefault, true);
  assert.equal(creds.find((r) => r.id === a.value.id)?.isDefault, false);

  // The engine resolver now hands back C's token, decrypted — server-side only.
  const decrypted = await credsMod.getDefaultHostingCredential(USER);
  assert.ok(decrypted);
  if (decrypted) {
    assert.equal(decrypted.accountId, "acct-c");
    assert.equal(decrypted.token, "token-cccc");
  }
});

test("deleteHostingCredential: revoking the default promotes the oldest remaining one (never default-less)", async () => {
  const a = await credsMod.createHostingCredential({ userId: USER, accountId: "a", label: "A", token: "t-aaaa" });
  const b = await credsMod.createHostingCredential({ userId: USER, accountId: "b", label: "B", token: "t-bbbb" });
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;

  const del = await credsMod.deleteHostingCredential(USER, a.value.id);
  assert.ok(del.ok);
  assert.equal(creds.find((r) => r.id === a.value.id)?.status, "revoked");
  assert.equal(creds.find((r) => r.id === b.value.id)?.isDefault, true, "B is promoted to default");
  assert.equal((await credsMod.listHostingCredentials(USER)).length, 1, "a revoked credential is not listed");
});

test("updateHostingCredential: editing the label without a token leaves the stored secret untouched", async () => {
  const created = await credsMod.createHostingCredential({ userId: USER, accountId: "acct", label: "Old", token: "keep-me" });
  assert.ok(created.ok);
  if (!created.ok) return;
  const before = { ...creds[0] };

  const renamed = await credsMod.updateHostingCredential({ userId: USER, id: created.value.id, label: "New" });
  assert.ok(renamed.ok);
  assert.equal(creds[0].label, "New");
  assert.equal(creds[0].tokenCiphertext, before.tokenCiphertext, "a label edit must not rewrite the token");
  assert.equal(crypto.decryptSecret(creds[0].tokenCiphertext, creds[0].tokenIv, creds[0].tokenTag), "keep-me");

  // Re-entering a token DOES re-encrypt it.
  const retokened = await credsMod.updateHostingCredential({ userId: USER, id: created.value.id, token: "new-token-999" });
  assert.ok(retokened.ok);
  assert.notEqual(creds[0].tokenCiphertext, before.tokenCiphertext);
  assert.equal(creds[0].tokenHint, "-999");
  assert.equal(crypto.decryptSecret(creds[0].tokenCiphertext, creds[0].tokenIv, creds[0].tokenTag), "new-token-999");
});

test("credentials are per-user: one user can never see, edit or switch another's", async () => {
  const mine = await credsMod.createHostingCredential({ userId: USER, accountId: "mine", label: "Mine", token: "mine-token" });
  assert.ok(mine.ok);
  if (!mine.ok) return;
  assert.equal((await credsMod.listHostingCredentials(OTHER)).length, 0);
  const edit = await credsMod.updateHostingCredential({ userId: OTHER, id: mine.value.id, label: "hijack" });
  assert.ok(!edit.ok && edit.status === 404);
  const sw = await credsMod.setDefaultHostingCredential(OTHER, mine.value.id);
  assert.ok(!sw.ok && sw.status === 404);
  const del = await credsMod.deleteHostingCredential(OTHER, mine.value.id);
  assert.ok(!del.ok && del.status === 404);
  assert.equal(await credsMod.getDefaultHostingCredential(OTHER), null);
});

// ---------------------------------------------------------------------------
// TASK_169 — short auto tokens (7 base64url chars, never slug-shaped).
// ---------------------------------------------------------------------------

test("TASK_169: auto tokens are SHORT (7 chars, base64url) and slug-safe", async () => {
  const res = await linksMod.createHostedLink({ userId: USER, target: "https://example.com/short" });
  assert.ok(res.ok, JSON.stringify(res));
  if (!res.ok) return;
  assert.match(res.value.token, /^[A-Za-z0-9_-]{7}$/);
  assert.equal(res.value.shortPath, `/r/${res.value.token}`);
  // Slug-shaped would collide with the slug namespace — must never happen.
  assert.ok(rulesMod.isTokenSlugSafe(res.value.token), "auto token must never match the slug shape");
});

test("TASK_169: a token collision retries silently (never 409s); only user slugs 409", async () => {
  // Drive the REAL mint path by stubbing crypto with a SEQUENCED fill: first
  // every draw is 0xFF (base64 → "_______", slug-safe via `_`), then 0x00
  // (base64 → "AAAAAAA", slug-safe via uppercase). Attempt 1 collides with the
  // taken row and retries; attempt 2 lands free and succeeds — never a 409.
  const cryptoObj = globalThis.crypto as unknown as { getRandomValues: (b: Uint8Array) => Uint8Array };
  const origGet = cryptoObj.getRandomValues;
  let draws = 0;
  cryptoObj.getRandomValues = (b: Uint8Array) => {
    draws += 1;
    // newShortLinkToken = 1 draw per mint (18 bytes → slice 7). The sampler
    // accepts both fills first try, so draws map 1:1 to create attempts.
    return b.fill(draws <= 1 ? 0xff : 0x00);
  };
  try {
    links.push({
      id: "link-taken", token: "_______", userId: OTHER, slug: null, campaignId: null,
      target: "https://taken.test", label: null, clickCount: 0, createdAt: new Date(),
    });
    const res = await linksMod.createHostedLink({ userId: USER, target: "https://example.com/retry" });
    assert.ok(res.ok, JSON.stringify(res));
    if (!res.ok) return;
    assert.equal(res.value.token, "AAAAAAA");
    assert.equal(draws, 2, "one collision + one success");
  } finally {
    cryptoObj.getRandomValues = origGet;
  }
});

test("TASK_169: slug-first resolve still holds, and old 24-char tokens still resolve", async () => {
  links.push({
    id: "link-old", token: "ciLSBh6Wgwb_g7562FolUwT-", userId: USER, slug: null, campaignId: null,
    target: "https://old-token.test", label: null, clickCount: 0, createdAt: new Date(),
  });
  const old = await linksMod.resolveLink("ciLSBh6Wgwb_g7562FolUwT-");
  assert.deepEqual(old, { id: "link-old", target: "https://old-token.test" });
  const created = await linksMod.createHostedLink({ userId: OTHER, target: "https://slugged.test", slug: "my-offer" });
  assert.ok(created.ok);
  const bySlug = await linksMod.resolveLink("my-offer");
  assert.ok(bySlug && bySlug.target === "https://slugged.test");
});





