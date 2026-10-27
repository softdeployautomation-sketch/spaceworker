// TASK_246 — Cline token-at-rest crypto.
// Run: npx tsx --test tests/clin-token-crypto.test.ts
//
// WHAT THIS PREVENTS:
//   1. Cline credentials stored as plaintext / XOR-with-a-default-key.
//   2. A rotated key silently turning a stored login into "no email" instead of
//      a clear "log in again" (AES-GCM is authenticated; tampering throws).
//   3. Pre-TASK_246 rows (bare XOR access token) becoming unreadable on deploy.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

(process.env as Record<string, string>).NODE_ENV = "test";

type Loader = { _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown };
const loader = Module as unknown as Loader;
const original = loader._load;
loader._load = function patched(request, parent, isMain) {
  if (request === "server-only") return {};
  return original.apply(this, [request, parent, isMain]);
};

/* eslint-disable @typescript-eslint/no-require-imports */
const crypto = require("../lib/clin/token-crypto") as typeof import("../lib/clin/token-crypto");
/* eslint-enable @typescript-eslint/no-require-imports */

const CORRECT_SECRET = "task-246-session-secret";

beforeEach(() => {
  process.env.SESSION_SECRET = CORRECT_SECRET;
  delete process.env.CLINE_TOKEN_ENCRYPTION_KEY;
  crypto.resetClineTokenKeyCacheForTesting();
});

test("TASK_246 crypto.1 — AES-GCM round trip never stores the raw token", () => {
  const sealed = crypto.encryptValue("access-token-abc");
  assert.ok(sealed.startsWith("v1:"), "versioned envelope");
  assert.ok(!sealed.includes("access-token-abc"), "plaintext is not embedded");
  assert.equal(crypto.decryptValue(sealed), "access-token-abc");
});

test("TASK_246 crypto.2 — random IV: same input produces different ciphertext", () => {
  const a = crypto.encryptValue("same");
  const b = crypto.encryptValue("same");
  assert.notEqual(a, b);
  assert.equal(crypto.decryptValue(a), "same");
  assert.equal(crypto.decryptValue(b), "same");
});

test("TASK_246 crypto.3 — tampered ciphertext is rejected, not silently truncated", () => {
  const sealed = crypto.encryptValue("access-token-abc");
  const parts = sealed.split(".");
  const ciphertext = Buffer.from(parts[2], "base64");
  ciphertext[0] ^= 0xff;
  const tampered = `${parts[0]}.${parts[1]}.${ciphertext.toString("base64")}`;
  assert.throws(() => crypto.decryptValue(tampered));
});

test("TASK_246 crypto.4 — a different SESSION_SECRET fails loudly", () => {
  const sealed = crypto.encryptValue("access-token-abc");
  process.env.SESSION_SECRET = "a-different-secret";
  crypto.resetClineTokenKeyCacheForTesting();
  assert.throws(() => crypto.decryptValue(sealed));
});

test("TASK_246 crypto.5 — CLINE_TOKEN_ENCRYPTION_KEY overrides SESSION_SECRET deterministically", () => {
  process.env.CLINE_TOKEN_ENCRYPTION_KEY = "dedicated-cline-key";
  crypto.resetClineTokenKeyCacheForTesting();
  const sealed = crypto.encryptValue("access-token-abc");
  crypto.resetClineTokenKeyCacheForTesting();
  assert.equal(crypto.decryptValue(sealed), "access-token-abc");

  process.env.CLINE_TOKEN_ENCRYPTION_KEY = "another-key";
  crypto.resetClineTokenKeyCacheForTesting();
  assert.throws(() => crypto.decryptValue(sealed));
});

test("TASK_246 crypto.6 — legacy XOR rows still decode (no forced re-login on deploy)", () => {
  const legacy = crypto.legacyEncrypt("legacy-access-token");
  assert.equal(crypto.isEncryptedValue(legacy), false);
  assert.equal(crypto.decryptValue(legacy), "legacy-access-token");
});

test("TASK_246 crypto.7 — full credential object round trip", () => {
  const credentials = {
    access: "a",
    refresh: "r",
    expires: 1_700_000_000_000,
    email: "person@example.com",
    accountId: "acct_123",
    metadata: { provider: "workos" },
  };
  const sealed = crypto.encryptCredentials(credentials);
  assert.deepEqual(crypto.decryptCredentials(sealed), credentials);
});

test("TASK_246 crypto.8 — malformed envelope / non-object payload rejected", () => {
  assert.throws(() => crypto.decryptValue("v1:not-a-real-envelope"));
  assert.throws(() => crypto.decryptCredentials(crypto.encryptValue(JSON.stringify({ refresh: "r" }))));
  assert.throws(() => crypto.decryptCredentials(crypto.encryptValue(JSON.stringify({ access: 42 }))));
});

test("TASK_246 crypto.9 — missing SESSION_SECRET is an actionable error", () => {
  delete process.env.SESSION_SECRET;
  crypto.resetClineTokenKeyCacheForTesting();
  assert.throws(() => crypto.encryptValue("x"), /SESSION_SECRET/);
});
