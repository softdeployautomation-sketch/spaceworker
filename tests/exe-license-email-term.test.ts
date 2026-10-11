import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// ---------------------------------------------------------------------------
// TASK_203 follow-up (2026-10-11) — the license email must state the REAL term,
// not a hardcoded "6 months". An admin can issue any day-count (a 1-day test
// license was the report: the buyer got a "valid for 6 months" email). And the
// admin generator no longer embeds the claim URL (it points at the PRIVATE app
// host, not the public site) — buyers don't need to go anywhere.
//
// These render the real templates (server-only stubbed, like the other lib
// tests) and assert the term is computed from the ACTUAL issued/expires dates
// and that no claim link leaks when claimUrl is omitted.
// ---------------------------------------------------------------------------

(process.env as Record<string, string>).NODE_ENV = "test";
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";
process.env.APP_BASE_URL = process.env.APP_BASE_URL || "https://spaceworker.top";
process.env.EMAIL_FROM = process.env.EMAIL_FROM || "test@spaceworker.top";
// lib/env.ts evaluates its required() accessors at module load, so these must
// be present before we require lib/email.ts. Test-only sentinels.
process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || "test_session_secret_not_for_prod";
process.env.RESEND_API_KEY =
  process.env.RESEND_API_KEY || "re_test_placeholder_key";

type Loader = { _load: (r: string, p: NodeModule | undefined, m: boolean) => unknown };
const loader = Module as unknown as Loader;
const originalLoad = loader._load;
loader._load = function patched(request, parent, isMain) {
  if (request === "server-only") return {};
  return originalLoad.call(this, request, parent, isMain);
};

// Synchronous require() AFTER the hook is installed (same pattern as the other
// lib tests — top-level await import trips tsx's CJS interop).
/* eslint-disable @typescript-eslint/no-require-imports */
const email = require("../lib/email") as typeof import("../lib/email");
/* eslint-enable @typescript-eslint/no-require-imports */
const { exeLicenseIssuedEmailHtml, exeLicenseWelcomeEmailHtml } = email;

const DAY = 86_400_000;
const issuedAt = new Date("2026-01-01T00:00:00.000Z");

test("issued email states the REAL 1-day term, not a hardcoded 6 months", () => {
  const html = exeLicenseIssuedEmailHtml({
    productName: "XDevice Monitor",
    licenseKey: "TESTKEY123",
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + 1 * DAY),
  });
  assert.match(html, /valid for 1 day and expires on/);
  assert.doesNotMatch(html, /6 months/);
  assert.doesNotMatch(html, /spaceworker\.top/);
  assert.doesNotMatch(html, /href="https?:\/\//); // no claim link leaked
});

test("welcome email states the REAL 1-day term and gives in-app activation when no claim link", () => {
  const html = exeLicenseWelcomeEmailHtml({
    productName: "XDevice Monitor",
    licenseKey: "TESTKEY123",
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + 1 * DAY),
  });
  assert.match(html, /valid for 1 day and expires on/);
  assert.doesNotMatch(html, /6 months/);
  assert.doesNotMatch(html, /spaceworker\.top/);
  // In-app activation steps present, and still shows the key to type in.
  assert.match(html, /enter the license key below on the activation screen/i);
  assert.match(html, /TESTKEY123/);
});

test("term is computed correctly across the day-count range", () => {
  const sentence = (days: number) =>
    exeLicenseIssuedEmailHtml({
      productName: "XDevice Monitor",
      licenseKey: "K",
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + days * DAY),
    });
  // 2 days → "2 days"
  assert.match(sentence(2), /valid for 2 days and expires on/);
  // 180 days → "6 months" (the default), proving it's date-derived not a constant
  assert.match(sentence(180), /valid for 6 months and expires on/);
  // 730 days → "2 years"
  assert.match(sentence(730), /valid for 2 years and expires on/);
});

test("a far-future (lifetime) key reads as valid for life", () => {
  const html = exeLicenseIssuedEmailHtml({
    productName: "XDevice Monitor",
    licenseKey: "K",
    issuedAt,
    // 200 years out → our lifetime sentinel.
    expiresAt: new Date(issuedAt.getTime() + 200 * 365 * DAY),
  });
  assert.match(html, /valid for life — it never expires/);
});
