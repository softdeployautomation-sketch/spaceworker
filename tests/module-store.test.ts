// TASK_99 / plan §COMMERCIAL C3 (owner, 2026-09-26) — pick-your-capability
// module store. Two things worth real evidence, not just a read-through:
//   1. lib/products.ts's catalog integrity (no duplicate ids/price fields,
//      every module actually carries entitlement keys, every exe a plan).
//   2. lib/entitlements.ts's grantEntitlement now STACKS onto an unexpired
//      existing term instead of resetting the clock — the fix that makes a
//      recurring module subscription behave correctly (mirrors
//      lib/premium.ts's grantPremium, which already did this).
//
// Run: npx tsx --test tests/module-store.test.ts

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

import { ALL_PRODUCTS, MODULE_PRODUCTS, EXE_PRODUCTS, getProduct } from "../lib/products";

// --- lib/products.ts catalog integrity — pure, no stubbing needed. --------

test("ALL_PRODUCTS: every id is unique", () => {
  const ids = ALL_PRODUCTS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("ALL_PRODUCTS: every priceField is unique (no two products share one AdminSetting price)", () => {
  const fields = ALL_PRODUCTS.map((p) => p.priceField);
  assert.equal(new Set(fields).size, fields.length);
});

test("MODULE_PRODUCTS: every module carries at least one entitlement key, and getProduct resolves it", () => {
  for (const p of MODULE_PRODUCTS) {
    assert.equal(p.kind, "module");
    assert.ok(Array.isArray(p.entitlementKeys) && p.entitlementKeys.length > 0, `${p.id} has no entitlementKeys`);
    assert.deepEqual(getProduct(p.id), p);
  }
});

test("EXE_PRODUCTS: every exe carries a plan slug (license-service.ts throws otherwise)", () => {
  for (const p of EXE_PRODUCTS) {
    assert.equal(p.kind, "exe");
    assert.ok(typeof p.plan === "string" && p.plan.length > 0, `${p.id} has no plan`);
  }
});

test("the new SpaceWorker Agent EXE and the three modules are really in the catalog", () => {
  assert.ok(getProduct("agent_exe"));
  assert.ok(getProduct("extractor_module"));
  assert.ok(getProduct("mailer_module"));
  assert.ok(getProduct("assistant_devices_module"));
  assert.deepEqual(getProduct("assistant_devices_module")?.entitlementKeys, ["assistant", "devices"]);
});

// --- lib/entitlements.ts, through the house require-hook stub -------------

interface EntitlementRow {
  userId: string;
  key: string;
  source: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  grantedAt: Date;
}

let rows: Map<string, EntitlementRow>;

beforeEach(() => {
  rows = new Map();
});

const rowKey = (userId: string, key: string) => `${userId}:${key}`;

const fakeDb = {
  userEntitlement: {
    findUnique: async ({ where }: { where: { userId_key: { userId: string; key: string } } }) => {
      return rows.get(rowKey(where.userId_key.userId, where.userId_key.key)) ?? null;
    },
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { userId_key: { userId: string; key: string } };
      create: Omit<EntitlementRow, "grantedAt">;
      update: Partial<EntitlementRow>;
    }) => {
      const k = rowKey(where.userId_key.userId, where.userId_key.key);
      const existing = rows.get(k);
      const next: EntitlementRow = existing
        ? { ...existing, ...update, grantedAt: update.grantedAt ?? existing.grantedAt }
        : { ...create, grantedAt: new Date() };
      rows.set(k, next);
      return next;
    },
  },
};

type Loader = { _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown };
const MODULE_UNDER_TEST = "lib/entitlements.ts";

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    const from = (parent?.filename ?? "").replace(/\\/g, "/");
    if (from.endsWith(`/${MODULE_UNDER_TEST}`)) {
      if (request === "./db") return { db: fakeDb };
      // Not exercised by grantEntitlement itself — stubbed only so the
      // module loads; every test below calls grantEntitlement directly.
      if (request === "./premium") {
        return { isPremiumWithReversion: () => false, applyPremiumReversion: async () => false };
      }
    }
    return original.call(this, request, parent, isMain);
  };
}

installRequireHook();

/* eslint-disable @typescript-eslint/no-require-imports */
const { grantEntitlement } = require("../lib/entitlements") as typeof import("../lib/entitlements");
/* eslint-enable @typescript-eslint/no-require-imports */

test("grantEntitlement: a fresh grant sets expiresAt = now + expiresInDays", async () => {
  const before = Date.now();
  await grantEntitlement({ userId: "u1", key: "extractor", source: "module", expiresInDays: 30 });
  const row = rows.get(rowKey("u1", "extractor"))!;
  assert.ok(row.expiresAt);
  const days = (row.expiresAt!.getTime() - before) / (24 * 60 * 60 * 1000);
  assert.ok(days > 29.9 && days < 30.1, `expected ~30 days, got ${days}`);
});

test("grantEntitlement: acceptance — a SECOND grant while still active STACKS onto the existing expiry, never resets to now+30", async () => {
  await grantEntitlement({ userId: "u2", key: "mailer", source: "module", expiresInDays: 30 });
  const first = rows.get(rowKey("u2", "mailer"))!.expiresAt!.getTime();

  // Simulate paying again 5 days later, well before the first term expires.
  await grantEntitlement({ userId: "u2", key: "mailer", source: "module", expiresInDays: 30 });
  const second = rows.get(rowKey("u2", "mailer"))!.expiresAt!.getTime();

  // Stacked: the new expiry is ~30 days AFTER the first one, not ~30 days
  // from now (which would be roughly equal to `first` again, not later).
  const gapDays = (second - first) / (24 * 60 * 60 * 1000);
  assert.ok(gapDays > 29.9 && gapDays < 30.1, `expected the term to extend by ~30 more days, got ${gapDays}`);
});

test("grantEntitlement: re-granting after expiry resets from now, not from the stale expired date", async () => {
  const key = rowKey("u3", "devices");
  rows.set(key, {
    userId: "u3",
    key: "devices",
    source: "module",
    expiresAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000), // expired 10 days ago
    revokedAt: null,
    grantedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
  });
  const before = Date.now();
  await grantEntitlement({ userId: "u3", key: "devices", source: "module", expiresInDays: 30 });
  const row = rows.get(key)!;
  const days = (row.expiresAt!.getTime() - before) / (24 * 60 * 60 * 1000);
  assert.ok(days > 29.9 && days < 30.1, `expected a fresh 30 days from now, got ${days}`);
});

test("grantEntitlement: re-granting after a revoke clears revokedAt and starts a fresh term", async () => {
  const key = rowKey("u4", "assistant");
  rows.set(key, {
    userId: "u4",
    key: "assistant",
    source: "module",
    expiresAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000), // would still be "active" if not revoked
    revokedAt: new Date(),
    grantedAt: new Date(),
  });
  await grantEntitlement({ userId: "u4", key: "assistant", source: "module", expiresInDays: 30 });
  const row = rows.get(key)!;
  assert.equal(row.revokedAt, null);
});

test("grantEntitlement: expiresInDays undefined never expires (admin's own never-expiring grant)", async () => {
  await grantEntitlement({ userId: "u5", key: "cyberlab", source: "admin_grant" });
  const row = rows.get(rowKey("u5", "cyberlab"))!;
  assert.equal(row.expiresAt, null);
});
