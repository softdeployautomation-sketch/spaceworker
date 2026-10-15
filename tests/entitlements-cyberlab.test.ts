// TASK_156B V2 (owner 2026-10-14) — CyberLab is pulled OFF Premium Plus.
//
// WHAT THIS FILE PROVES (run: npx tsx --test tests/entitlements-cyberlab.test.ts):
//   1. `hasEntitlement(user, "cyberlab")` is DENIED for a tier-5 Premium user who
//      holds no cyberlab grant — premium is no longer a catch-all for cyberlab.
//   2. The SAME premium user is still ALLOWED every other key (extractor,
//      mailer, hosting, …) — only cyberlab was pulled off the bundle.
//   3. A tier-1 (free) user WITH a live cyberlab UserEntitlement grant is
//      ALLOWED (reason "grant") — this is the admin allow-button path.
//   4. `listEffectiveEntitlements` mirrors the gate: a premium user's key set
//      EXCLUDES cyberlab unless they also hold an explicit live grant.
//
// Drives the REAL lib/entitlements.ts with the DB swapped for a recording fake
// through the house require hook (no Postgres).

import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

type Loader = { _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown };

type FakeState = {
  user: { id: string; tier: number; premiumExpiresAt: Date | null } | null;
  grants: Array<{ id: string; key: string; revokedAt: Date | null; expiresAt: Date | null }>;
};

function install(state: FakeState): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  const db = {
    user: {
      findUnique: async () => state.user,
      updateMany: async () => ({ count: 0 }),
      update: async () => state.user,
    },
    userEntitlement: {
      findUnique: async ({ where }: { where: { userId_key: { key: string } } }) =>
        state.grants.find((g) => g.key === where.userId_key.key) ?? null,
      findMany: async () => state.grants,
      updateMany: async () => ({ count: 0 }),
      upsert: async () => ({}),
    },
  };
  loader._load = function patched(request, parent) {
    if (request === "server-only") return {};
    const from = (parent?.filename ?? "").replace(/\\/g, "/");
    if (from.endsWith("/lib/entitlements.ts") || from.endsWith("/lib/premium.ts")) {
      if (request === "./db" || request === "@/lib/db") return { db };
    }
    return original.call(loader, request, parent, false);
  };
}

async function loadEntitlements() {
  // Fresh module each time so the require hook + fake state take effect.
  const path = require.resolve("../lib/entitlements");
  delete require.cache[path];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../lib/entitlements") as typeof import("../lib/entitlements");
}

function restore(): void {
  // Reload cleanly for the next test by clearing entitlements + premium.
  for (const p of ["../lib/entitlements", "../lib/premium"]) {
    const rp = require.resolve(p);
    delete require.cache[rp];
  }
}

test("a Premium Plus (tier 5) user does NOT get cyberlab from the catch-all", async () => {
  install({ user: { id: "u1", tier: 5, premiumExpiresAt: null }, grants: [] });
  const ent = await loadEntitlements();
  const d = await ent.hasEntitlement("u1", "cyberlab");
  assert.equal(d.allowed, false, "premium must no longer imply cyberlab");
  assert.equal(d.reason, "none");
  restore();
});

test("premium still covers every OTHER key (only cyberlab was pulled off)", async () => {
  install({ user: { id: "u1", tier: 5, premiumExpiresAt: null }, grants: [] });
  const ent = await loadEntitlements();
  for (const key of ["extractor", "mailer", "assistant", "hosting", "browser"] as const) {
    const d = await ent.hasEntitlement("u1", key);
    assert.equal(d.allowed, true, `${key} must still ride premium`);
    assert.equal(d.reason, "premium");
  }
  restore();
});

test("a free (tier 1) user WITH a live cyberlab grant is allowed (the admin allow-button path)", async () => {
  install({
    user: { id: "u2", tier: 1, premiumExpiresAt: null },
    grants: [{ id: "g1", key: "cyberlab", revokedAt: null, expiresAt: null }],
  });
  const ent = await loadEntitlements();
  const d = await ent.hasEntitlement("u2", "cyberlab");
  assert.equal(d.allowed, true);
  assert.equal(d.reason, "grant");
  restore();
});

test("listEffectiveEntitlements excludes cyberlab for premium, includes it when explicitly granted", async () => {
  // Premium, no grant → keys have no cyberlab.
  install({ user: { id: "u3", tier: 5, premiumExpiresAt: null }, grants: [] });
  let ent = await loadEntitlements();
  let eff = await ent.listEffectiveEntitlements("u3");
  assert.equal(eff.premium, true);
  assert.ok(!eff.keys.includes("cyberlab"), "premium key set must exclude cyberlab");
  assert.ok(eff.keys.includes("extractor"), "premium key set still includes extractor");
  restore();

  // Premium, WITH an explicit cyberlab grant → keys DO include cyberlab.
  install({
    user: { id: "u4", tier: 5, premiumExpiresAt: null },
    grants: [{ id: "g2", key: "cyberlab", revokedAt: null, expiresAt: null }],
  });
  ent = await loadEntitlements();
  eff = await ent.listEffectiveEntitlements("u4");
  assert.ok(eff.keys.includes("cyberlab"), "an explicitly granted premium user keeps cyberlab");
  restore();
});
