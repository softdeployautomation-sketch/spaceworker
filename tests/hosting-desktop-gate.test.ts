import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { randomUUID } from "node:crypto";

// TASK_175 — Desktop-only gate for hosting short links (/r/<key>).
//
// The gate is premium-only at MINT (a non-premium minter's `desktopOnly: true`
// is silently dropped) and presence-authoritative at OPEN (no tier check on the
// anonymous resolve path). Mobile/tablet openers of a gated link see a small
// white "open on your PC" interstitial instead of the redirect; desktop
// openers pass straight through, and ?desktop=1 ("Continue anyway") bypasses.

(process.env as Record<string, string>).NODE_ENV = "test";
process.env.APP_BASE_URL = "https://spaceworker.test";
process.env.MAILBOX_ENCRYPTION_KEY = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");

// --- Fake prisma: only the user row matters for the premium gate ------------
let fakeUser: { tier: number; premiumExpiresAt: Date | null } = { tier: 5, premiumExpiresAt: null };

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
  desktopOnly: boolean | null;
};
let linkRows: LinkRow[] = [];
let seq = 0;
function blankLink(over: Partial<LinkRow>): LinkRow {
  seq += 1;
  return {
    id: `lr_${seq}`,
    token: `tok${seq}_Aa-_${seq}`,
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
    deployStatus: "live",
    deployError: null,
    desktopOnly: null,
    ...over,
  };
}
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v === null) return row[k] === null || row[k] === undefined;
    if (typeof v === "object" && v !== null) {
      const o = v as Record<string, unknown>;
      if ("in" in o) return (o.in as unknown[]).includes(row[k]);
      return false;
    }
    return row[k] === v;
  });
}
const fakePrisma = {
  user: {
    findUnique: async () => ({ ...fakeUser }),
  },
  linkRedirect: {
    create: async ({ data }: { data: Partial<LinkRow> }) => {
      const row = blankLink(data as Partial<LinkRow>);
      linkRows.push(row);
      return { ...row };
    },
    findMany: async ({ where }: { where?: Record<string, unknown> }) => {
      if (!where) return linkRows.map((r) => ({ ...r }));
      return linkRows.filter((r) => matches(r as unknown as Record<string, unknown>, where)).map((r) => ({ ...r }));
    },
    findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      const keys = Object.keys(where);
      if (keys.length === 1 && keys[0] === "slug") {
        const row = linkRows.find((r) => r.slug === (where as { slug: string }).slug);
        return row ? { ...row } : null;
      }
      const row = linkRows.find((r) => matches(r as unknown as Record<string, unknown>, where));
      return row ? { ...row } : null;
    },
    findUnique: async ({ where }: { where: Record<string, unknown> }) => {
      if ("token" in where) {
        const row = linkRows.find((r) => r.token === (where as { token: string }).token);
        return row ? { ...row } : null;
      }
      if ("id" in where) {
        const row = linkRows.find((r) => r.id === (where as { id: string }).id);
        return row ? { ...row } : null;
      }
      return null;
    },
    update: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const row = linkRows.find((r) => matches(r as unknown as Record<string, unknown>, where));
      if (!row) throw new Error("not found");
      Object.assign(row, data);
      return { ...row };
    },
    count: async ({ where }: { where?: Record<string, unknown> }) => {
      if (!where) return linkRows.length;
      return linkRows.filter((r) => matches(r as unknown as Record<string, unknown>, where)).length;
    },
  },
  hostedAsset: { count: async () => 0 },
  $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(fakePrisma),
};

const origLoad = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (
  request: unknown,
  parent: unknown,
  ...rest: unknown[]
) {
  const name = String(request);
  // `server-only` throws at import outside a Server Component — every test
  // file in this repo stubs it (same house hook pattern).
  if (name === "server-only") return {};
  const from = (parent as { filename?: string } | undefined)?.filename ?? "";
  // Only swap deps for modules under lib/hosting/ (the house pattern) — a
  // global name-match would also hit the test file's own imports.
  if (from.includes("/lib/hosting/") || from.includes("\\lib\\hosting\\") || from === "") {
    if (name === "../prisma" || name.endsWith("/lib/prisma") || name.endsWith("lib/prisma")) {
      return { prisma: fakePrisma };
    }
    if (name === "../db" || name.endsWith("/lib/db") || name.endsWith("lib/db")) {
      return { db: fakePrisma };
    }
    if (name === "../admin-settings" || name.endsWith("admin-settings")) {
      return {
        getAdminSettings: async () => ({
          hostingEnabled: true,
          hostingProvider: "local",
          hostingFreeStorageQuotaMb: 1024,
          hostingFreeMaxFileSizeMb: 512,
          hostingFreeMaxFiles: 500,
          hostingFreeMaxBandwidthGbPerMonth: 50,
          hostingFreeMaxLinks: 100,
          hostingPremiumMaxLinks: 1000,
          hostingPremiumStorageQuotaMb: 10240,
          hostingPagesMaxAssetMb: 20,
          hostingPlatformTokenTtlHours: 24,
        }),
      };
    }
    if (name === "../premium" || name.endsWith("/lib/premium") || name.endsWith("lib/premium")) {
      return {
        isPremiumWithReversion: (u: { tier: number; premiumExpiresAt: Date | null }) =>
          u.tier >= 5 && (u.premiumExpiresAt === null || u.premiumExpiresAt.getTime() > Date.now()),
      };
    }
    if (name === "./files" || name.endsWith("hosting/files")) {
      return {
        resolveCapsForUser: async () => ({
          caps: { enabled: true, provider: "local", maxLinks: 100, premiumMaxLinks: 1000 },
          premium: fakeUser.tier >= 5,
        }),
      };
    }
    if (name === "./platform-accounts" || name.endsWith("hosting/platform-accounts")) {
      return { healthyPlatformAccountCount: async () => 0 };
    }
    if (name === "./domain-registry" || name.endsWith("hosting/domain-registry")) {
      return { assertUserOwnsHost: () => ({ ok: true as const }) };
    }
    if (name === "./links-engine" || name.endsWith("hosting/links-engine")) {
      return {
        mapIdentityFor: () => ({ workerName: "lnk-test", routePattern: null }),
        publishUserMap: async () => ({ ok: true as const, value: { workerName: "lnk-test", routePattern: null, customHost: null, credentialId: null } }),
        teardownUserMap: async () => undefined,
      };
    }
  }
  return (origLoad as (...a: unknown[]) => unknown)(request, parent, ...rest);
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const links = require("../lib/hosting/links.ts") as typeof import("../lib/hosting/links");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const workers = require("../lib/hosting/workers.ts") as typeof import("../lib/hosting/workers");

beforeEach(() => {
  linkRows = [];
  seq = 0;
  fakeUser = { tier: 5, premiumExpiresAt: null };
});

// SERVER UA PRE-CHECK

test("TASK_175: phone UAs are mobile, desktop UAs are not", () => {
  const { isMobileUserAgent } = links;
  assert.equal(isMobileUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"), true);
  assert.equal(isMobileUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36"), true);
  assert.equal(isMobileUserAgent("Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15"), true);
  assert.equal(
    isMobileUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"),
    true
  );
  assert.equal(isMobileUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"), false);
  assert.equal(isMobileUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36"), false);
  assert.equal(isMobileUserAgent(null), false);
  assert.equal(isMobileUserAgent(undefined), false);
  assert.equal(isMobileUserAgent(""), false);
});

// INTERSTITIAL HTML

test("TASK_175: interstitial is a white modal with Continue-anyway, never the target", () => {
  const { desktopOnlyInterstitialHtml } = links;
  const html = desktopOnlyInterstitialHtml("/r/abc1234?desktop=1");
  assert.ok(html.includes("Open this on your PC"));
  assert.ok(html.includes("Continue anyway"));
  assert.ok(html.includes("/r/abc1234?desktop=1"));
  assert.ok(html.includes("background:#fff"), "white modal card");
  assert.ok(html.includes("maxTouchPoints"), "client re-confirm for misread desktops");
  assert.ok(html.includes("userAgentData"), "client re-confirm via UA-data mobile flag");
  assert.ok(!html.includes("https://"), "the destination URL must never leak into the gate page");
});

test("TASK_175: interstitial escapes the continue URL for attribute context", () => {
  const { desktopOnlyInterstitialHtml } = links;
  const html = desktopOnlyInterstitialHtml('/r/x?desktop=1"><script>');
  assert.ok(!html.includes('"><script>'), "raw quote/bracket must not break out of href");
  assert.ok(html.includes("&quot;"), "quotes are entity-escaped");
});
// PREMIUM-ONLY PERSISTENCE AT MINT

test("TASK_175: premium minter desktopOnly true persists on the row", async () => {
  fakeUser = { tier: 5, premiumExpiresAt: null };
  const res = await links.createHostedLink({ userId: "user_1", target: "https://example.com/", desktopOnly: true });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.value.desktopOnly, true);
  assert.equal(linkRows[0].desktopOnly, true);
});

test("TASK_175: free minter desktopOnly true is silently dropped", async () => {
  fakeUser = { tier: 1, premiumExpiresAt: null };
  const res = await links.createHostedLink({ userId: "user_1", target: "https://example.com/", desktopOnly: true });
  assert.equal(res.ok, true, "never a 400 — dropped like an invalid slug");
  if (res.ok) assert.equal(res.value.desktopOnly, false);
  assert.ok(linkRows[0].desktopOnly !== true, "row has NO flag");
});

test("TASK_175: expired premium term cannot set the gate", async () => {
  fakeUser = { tier: 5, premiumExpiresAt: new Date(Date.now() - 1000) };
  assert.equal(await links.canUseDesktopOnlyGate("user_1"), false);
  const res = await links.createHostedLink({ userId: "user_1", target: "https://example.com/", desktopOnly: true });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.value.desktopOnly, false);
});

test("TASK_175: flag-off mint resolves as gate-off", async () => {
  fakeUser = { tier: 1, premiumExpiresAt: null };
  const res = await links.createHostedLink({ userId: "user_1", target: "https://example.com/" });
  assert.equal(res.ok, true);
  const resolved = await links.resolveLink(linkRows[0].token);
  assert.ok(resolved);
  assert.equal(resolved!.desktopOnly, false);
});

// RESOLVER: presence is authority, no tier check at open

test("TASK_175: resolver carries desktopOnly true even after term lapses", async () => {
  fakeUser = { tier: 5, premiumExpiresAt: null };
  await links.createHostedLink({ userId: "user_1", target: "https://example.com/", desktopOnly: true });
  fakeUser = { tier: 1, premiumExpiresAt: null };
  const resolved = await links.resolveLink(linkRows[0].token);
  assert.ok(resolved);
  assert.equal(resolved!.desktopOnly, true);
  assert.equal(resolved!.target, "https://example.com/");
});

test("TASK_175: pre-flag rows resolve as gate-off", async () => {
  linkRows.push(blankLink({ target: "https://legacy.example/", desktopOnly: null }));
  const resolved = await links.resolveLink(linkRows[0].token);
  assert.ok(resolved);
  assert.equal(resolved!.desktopOnly, false);
});

// UPDATE: premium-only set, any-owner clear

test("TASK_175: update desktopOnly true persists for premium, clear for any owner", async () => {
  fakeUser = { tier: 5, premiumExpiresAt: null };
  await links.createHostedLink({ userId: "user_1", target: "https://example.com/" });
  const on = await links.updateHostedLink({ userId: "user_1", id: linkRows[0].id, desktopOnly: true });
  assert.equal(on.ok, true);
  if (on.ok) assert.equal(on.value.desktopOnly, true);
  fakeUser = { tier: 1, premiumExpiresAt: null };
  const dropped = await links.updateHostedLink({ userId: "user_1", id: linkRows[0].id, desktopOnly: false });
  assert.equal(dropped.ok, true, "clearing is allowed for any owner");
  if (dropped.ok) assert.equal(dropped.value.desktopOnly, false);
  assert.ok(linkRows[0].desktopOnly !== true);
});

// EDGE WORKER MAP

test("TASK_175: worker map gates only flagged keys, keeps 302 for rest", () => {
  const src = workers.buildWorkerMapSource([
    { key: "gated-tok", target: "https://gated.example/", desktopOnly: true },
    { key: "plain-tok", target: "https://plain.example/" },
  ]);
  assert.ok(src.includes('"gated-tok"'), "gated key present");
  assert.ok(src.includes("DESKTOP"), "parallel gate set exists");
  assert.ok(src.includes("t175Gate"), "edge runs the gate");
  assert.ok(src.includes("Response.redirect(target, 302)"), "ungated keys still 302");
  assert.ok(src.includes("Continue anyway"), "edge interstitial carries the escape");
  assert.ok(src.includes("desktop=1"), "escape re-requests with the bypass");
});

test("TASK_175: worker map with no flags gates nothing", () => {
  const src = workers.buildWorkerMapSource([{ key: "tok1", target: "https://a.example/" }]);
  assert.ok(src.includes("new Set([])"), "empty DESKTOP set — gate off for every key");
});

