import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// TASK_201 S7c — proves the Turbopack hashed-external alias shim:
//   1. a hashed alias ("real-pkg-<16hex>") that would normally MODULE_NOT_FOUND
//      resolves to the REAL package once the shim is installed,
//   2. exact-hash-shape lookups still throw when no real package backs them
//      (the shim must not swallow genuine module-not-found errors),
//   3. non-aliased resolution is untouched,
//   4. install is idempotent.
// This is the mechanism that broke the mailer EXE artifact boot (run
// 38052488430): Turbopack compiles serverExternalPackages requires into
// hashed aliases whose directories the CI standalone build never creates.

import { installTurbopackExternalAliasShim } from "../lib/turbopack-external-alias";

const require2 = createRequire(import.meta.url);

test("hashed alias resolves to the real package after shim install", () => {
  installTurbopackExternalAliasShim();
  const real = require2.resolve("js-yaml");
  const aliased = require2.resolve("js-yaml-0123456789abcdef");
  assert.equal(aliased, real);
});

test("scoped package hashed alias resolves too", () => {
  installTurbopackExternalAliasShim();
  const real = require2.resolve("@electric-sql/pglite");
  const aliased = require2.resolve("@electric-sql/pglite-7966c14983af6418");
  assert.equal(aliased, real);
});

test("unresolvable hashed alias still throws (no swallowing)", () => {
  installTurbopackExternalAliasShim();
  assert.throws(
    () => require2.resolve("no-such-package-anywhere-fedcba9876543210"),
    /Cannot find module|MODULE_NOT_FOUND/,
  );
});

test("non-aliased missing module still throws with original error", () => {
  installTurbopackExternalAliasShim();
  assert.throws(
    () => require2.resolve("no-such-package-anywhere"),
    /Cannot find module|MODULE_NOT_FOUND/,
  );
});

test("install is idempotent", () => {
  installTurbopackExternalAliasShim();
  installTurbopackExternalAliasShim();
  const real = require2.resolve("js-yaml");
  assert.equal(require2.resolve("js-yaml-ffffffffffffffff"), real);
});
