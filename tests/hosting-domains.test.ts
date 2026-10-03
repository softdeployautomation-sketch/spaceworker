import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isValidAccountSubdomain,
  isValidHostname,
  isWorkersDevHost,
  labelCount,
  normalizeHostInput,
  resolveLinkHost,
  resolveSiteHost,
  resolveWorkersDevHost,
  universalSslCovered,
} from "../lib/hosting/domains";

// TASK_157 Phase 1 (PLAN_TASK_157 §3) — the domain registry's rules.
//
// This module is PURE (no prisma, no network), which is the point: the whole
// free-vs-premium host decision is provable here instead of only on the VPS.
//
// One test per rule the plan states:
//   * an unset premium domain falls through to the free Cloudflare host, never to
//     an empty host — this is what makes the migration behaviour-preserving
//   * a set premium domain WINS for both sites and links
//   * links degrade in a documented order: premium host -> go.<zone> -> workers.dev
//   * a second-level site host is flagged as NOT covered by free Universal SSL
//   * a workers.dev subdomain is a single DNS label (dashes yes, dots no)

test("normalizeHostInput accepts a URL, a host:port and a trailing dot", () => {
  assert.equal(normalizeHostInput("https://Go.InstaWeb.top/"), "go.instaweb.top");
  assert.equal(normalizeHostInput("go.instaweb.top:443"), "go.instaweb.top");
  assert.equal(normalizeHostInput("go.instaweb.top."), "go.instaweb.top");
  assert.equal(normalizeHostInput("  GO.Instaweb.TOP  "), "go.instaweb.top");
});

test("normalizeHostInput refuses what is not a hostname", () => {
  assert.equal(normalizeHostInput(""), null);
  assert.equal(normalizeHostInput("   "), null);
  assert.equal(normalizeHostInput(null), null);
  assert.equal(normalizeHostInput(undefined), null);
  // A bare label is not a hostname — there is nothing to attach it to.
  assert.equal(normalizeHostInput("localhost"), null);
  // A leading dash is not a legal DNS label.
  assert.equal(normalizeHostInput("-bad.example.com"), null);
});

test("isValidHostname and labelCount agree on depth", () => {
  assert.equal(isValidHostname("instaweb.top"), true);
  assert.equal(isValidHostname("a.b.instaweb.top"), true);
  assert.equal(isValidHostname("instaweb"), false);
  assert.equal(labelCount("instaweb.top"), 2);
  assert.equal(labelCount("a.b.instaweb.top"), 4);
});

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

test("an UNSET site domain returns null, which is the free <project>.pages.dev default", () => {
  // The AdminSetting default is "" — it must mean "fall through", never
  // "publish to a site called '.instaweb.top'".
  assert.equal(resolveSiteHost("", "my-site"), null);
  assert.equal(resolveSiteHost(null, "my-site"), null);
  assert.equal(resolveSiteHost(undefined, "my-site"), null);
  assert.equal(resolveSiteHost("   ", "my-site"), null);
});

test("a SET site domain yields <slug>.<domain>", () => {
  const r = resolveSiteHost("instaweb.top", "my-site");
  assert.ok(r);
  assert.equal(r.host, "my-site.instaweb.top");
  assert.equal(r.universalSslCovered, true);
});

test("a malformed slug is refused rather than turned into a broken host", () => {
  assert.equal(resolveSiteHost("instaweb.top", ""), null);
  assert.equal(resolveSiteHost("instaweb.top", "Bad_Slug"), null);
  assert.equal(resolveSiteHost("instaweb.top", "-leading"), null);
  assert.equal(resolveSiteHost("instaweb.top", "trailing-"), null);
  // A slug is ONE label: a dot would silently add a subdomain level.
  assert.equal(resolveSiteHost("instaweb.top", "a.b"), null);
});

test("Universal SSL covers the apex + one level only, so a nested base is flagged", () => {
  // <slug>.instaweb.top is 3 labels — covered, free.
  assert.equal(universalSslCovered("my-site.instaweb.top"), true);
  // <slug>.sites.instaweb.top is 4 labels — needs Total TLS (paid), so the
  // resolver SAYS SO instead of shipping a certificate-less host.
  const nested = resolveSiteHost("sites.instaweb.top", "my-site");
  assert.ok(nested);
  assert.equal(nested.host, "my-site.sites.instaweb.top");
  assert.equal(nested.universalSslCovered, false);
});

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

test("link host prefers the admin's premium domain", () => {
  assert.equal(
    resolveLinkHost({
      premiumLinkDomain: "go.instaweb.top",
      zoneName: "spaceworker.top",
      workersDevSubdomain: "spaceworker",
      workerName: "sw-abc",
    }),
    "go.instaweb.top"
  );
});

test("link host falls back to go.<zone> when no premium domain is set", () => {
  // The pre-TASK_157 behaviour, kept so an account that configured nothing keeps
  // working exactly as it does today.
  assert.equal(
    resolveLinkHost({ premiumLinkDomain: "", zoneName: "spaceworker.top" }),
    "go.spaceworker.top"
  );
  assert.equal(resolveLinkHost({ zoneName: "spaceworker.top" }), "go.spaceworker.top");
});

test("link host falls back to the workers.dev host when there is no zone either", () => {
  assert.equal(
    resolveLinkHost({ workerName: "sw-abc", workersDevSubdomain: "spaceworker" }),
    "sw-abc.spaceworker.workers.dev"
  );
});

test("link host returns null when nothing at all is configured", () => {
  // null keeps the local /r/<token> fallback as the last tier instead of
  // inventing a host that can never resolve.
  assert.equal(resolveLinkHost({}), null);
  assert.equal(resolveLinkHost({ premiumLinkDomain: "   ", zoneName: "nope" }), null);
});

test("a workers.dev subdomain is one DNS label, so a dot is refused", () => {
  assert.equal(isValidAccountSubdomain("spaceworker"), true);
  assert.equal(isValidAccountSubdomain("sw-docs"), true);
  assert.equal(isValidAccountSubdomain("sw.docs"), false);
  assert.equal(isValidAccountSubdomain(""), false);
  assert.equal(isValidAccountSubdomain("-lead"), false);
});

test("resolveWorkersDevHost needs BOTH a script name and a subdomain", () => {
  assert.equal(resolveWorkersDevHost("sw-abc", "spaceworker"), "sw-abc.spaceworker.workers.dev");
  assert.equal(resolveWorkersDevHost("sw-abc", null), null);
  assert.equal(resolveWorkersDevHost(null, "spaceworker"), null);
});

// ---------------------------------------------------------------------------
// isWorkersDevHost — the predicate that decides whether the publish needs a zone
// ---------------------------------------------------------------------------

test("isWorkersDevHost recognises the workers.dev edge and nothing else", () => {
  assert.equal(isWorkersDevHost("sw-abc.swdocs.workers.dev"), true);
  assert.equal(isWorkersDevHost("swdocs.workers.dev"), true, "the bare admin setting counts too");
  assert.equal(isWorkersDevHost("SW-ABC.SWDOCS.WORKERS.DEV"), true, "matching is case-insensitive");
});

test("isWorkersDevHost refuses look-alikes that endsWith would wrongly accept", () => {
  // These are the reason this is a label-boundary check and not `endsWith`. A
  // zone we control, or an attacker's name that merely ENDS in the right string,
  // must still take the full zoned publish path with its DNS record and route.
  assert.equal(isWorkersDevHost("go.instaweb.top"), false);
  assert.equal(isWorkersDevHost("evilworkers.dev"), false, "no dot boundary — not Cloudflare's edge");
  assert.equal(isWorkersDevHost("x.workers.dev.attacker.com"), false, "the suffix is not terminal");
  assert.equal(isWorkersDevHost("workers.dev.evil.com"), false);
  assert.equal(isWorkersDevHost(""), false);
  assert.equal(isWorkersDevHost(null), false);
  assert.equal(isWorkersDevHost(undefined), false);
});
