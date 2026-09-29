import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// 2026-09-28 — `buildIsolationProbes` regression test.
//
// WHY THIS FILE EXISTS: the diagnostics ladder answers exactly one question —
// "WHICH element is triggering spam?" — and it can only answer it if every probe
// changes ONE variable while holding the other two constant. That invariant is
// invisible in the UI (all the user sees is a label and a result), so a silent
// break in it would produce confident, wrong advice. This file pins the
// invariant itself, including the 2026-09-28 change where a campaign's test-only
// From address becomes the baseline for every probe.
//
// Only the module's own dependencies are swapped (the house require-hook
// pattern, HOW_WE_MOVE_FAST §4) — `buildIsolationProbes` is pure, so nothing
// here touches a database, an SMTP server or an IMAP mailbox.

type Loader = {
  _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};

const MODULE_UNDER_TEST = "lib/deliverability.ts";

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    const from = parent?.filename ?? "";
    // Task 144 — stubbed OUTSIDE the parent gate below on purpose.
    //
    // Why: lib/deliverability.ts now imports the shared message builder
    // (./campaign-message) so the test send and the real send build identical
    // MIME. That builder reaches ./env via ./unsubscribe-token, and lib/env.ts
    // calls required() at import time — it would throw without the whole
    // production environment. The require chain is
    // deliverability.ts -> campaign-message.ts -> unsubscribe-token.ts -> env,
    // so by the time env is requested the parent is unsubscribe-token.ts and no
    // longer matches the gate below.
    //
    // The tempting alternative is to stub ./campaign-message itself, like the
    // other entries — but that is the wrong fix: the stub would silently satisfy
    // any FUTURE probe that does build a message, i.e. a green test for a
    // function that never ran. Stubbing only the env read keeps the real builder
    // and the real HMAC signing loaded. The fake still carries a real
    // sessionSecret because unsubscribe-token.ts signs with it.
    if (
      (request === "./env" || request === "@/lib/env") &&
      (from.endsWith("/lib/unsubscribe-token.ts") || from.endsWith("/lib/campaign-message.ts"))
    ) {
      return { env: { appBaseUrl: "https://spaceworker.test", sessionSecret: "test-secret-for-unit-tests" } };
    }
    if (from.endsWith(`/${MODULE_UNDER_TEST}`)) {
      // Every one of these is only reachable from a function this test does not
      // call — stubbed purely so the module can be loaded without a live DB,
      // an SMTP transport or an IMAP session.
      if (request === "@/lib/prisma") return { prisma: {} };
      if (request === "./mailer-send") return { transporterForMailbox: async () => ({}) };
      if (request === "./mailbox-crypto") return { decryptSecret: () => "" };
      if (request === "./imap") {
        return { pollSeedMailbox: async () => ({ found: false, landedIn: "unknown", messages: [] }) };
      }
      if (request === "./seed-mailbox") return { resolveSeedMailbox: async () => null };
      if (request === "./render-merge") return { renderMerge: (s: unknown) => s };
      if (request === "./trial") return { mayEnterSending: async () => true };
    }
    return original.call(this, request, parent, isMain);
  };
}

installRequireHook();

/* eslint-disable @typescript-eslint/no-require-imports */
const { buildIsolationProbes } = require("../lib/deliverability") as typeof import("../lib/deliverability");
/* eslint-enable @typescript-eslint/no-require-imports */

const CAMPAIGN = {
  subjects: ["First subject", "Second subject"],
  bodies: ["<p>First body</p>", "<p>Second body</p>"],
  fromAddresses: ["real@mydomain.com", "alias@mydomain.com"],
};

function probe(probes: ReturnType<typeof buildIsolationProbes>, key: string) {
  const found = probes.find((p) => p.key === key);
  assert.ok(found, `expected a "${key}" probe`);
  return found;
}

test("without a test From, the ladder is byte-identical to the pre-2026-09-28 behaviour", () => {
  const probes = buildIsolationProbes(CAMPAIGN);

  // The three non-From probes leave the From alone (null = "send as the
  // mailbox's normal first From"), so the From stays a held-constant variable.
  assert.equal(probe(probes, "subject").from, null);
  assert.equal(probe(probes, "body").from, null);
  assert.equal(probe(probes, "emptyBody").from, null);
  // Only the From probe changes it, and it moves to the NEXT rotation entry —
  // not the first, which is already in use.
  assert.equal(probe(probes, "from").from, "alias@mydomain.com");

  // Each probe changes exactly one dimension.
  assert.deepEqual(probe(probes, "subject").variant, { subject: "Second subject", bodyHtml: "<p>First body</p>" });
  assert.deepEqual(probe(probes, "body").variant, { subject: "First subject", bodyHtml: "<p>Second body</p>" });
  assert.deepEqual(probe(probes, "emptyBody").variant, { subject: "First subject", bodyHtml: "" });
  assert.deepEqual(probe(probes, "from").variant, { subject: "First subject", bodyHtml: "<p>First body</p>" });

  for (const p of probes) assert.equal(p.available, true, `${p.key} should be runnable`);
});

test("a test-only From becomes the baseline every probe is sent as", () => {
  const probes = buildIsolationProbes({ ...CAMPAIGN, testFromOverride: "testing@otherdomain.com" });

  // Held constant across the isolation ladder — this is what makes the ladder a
  // controlled experiment rather than three unrelated sends.
  assert.equal(probe(probes, "subject").from, "testing@otherdomain.com");
  assert.equal(probe(probes, "body").from, "testing@otherdomain.com");
  assert.equal(probe(probes, "emptyBody").from, "testing@otherdomain.com");
  // And the From probe now flips to what the campaign REALLY sends as, so its
  // result answers the question the user actually asked ("is the From I'm
  // testing with better than the one I send with?").
  assert.equal(probe(probes, "from").from, "real@mydomain.com");
});

test("a test From that equals the real sending From still yields an alternative to compare", () => {
  const probes = buildIsolationProbes({ ...CAMPAIGN, testFromOverride: "real@mydomain.com" });

  assert.equal(probe(probes, "emptyBody").from, "real@mydomain.com");
  // Testing the same address twice would prove nothing, so the From probe falls
  // through to the next entry in the rotation instead.
  assert.equal(probe(probes, "from").from, "alias@mydomain.com");
});

test("probes that have nothing to compare against are flagged unavailable, never silently duplicated", () => {
  const probes = buildIsolationProbes({
    subjects: ["Only subject"],
    bodies: ["<p>Only body</p>"],
    fromAddresses: ["solo@mydomain.com"],
  });

  for (const key of ["subject", "body", "from"]) {
    const p = probe(probes, key);
    assert.equal(p.available, false, `${key} has no alternative and must be flagged`);
    assert.match(p.unavailableReason ?? "", /no alternative|No alternative/i);
  }
  // The empty-body diagnostic is always runnable: it needs no alternative, only
  // the removal of a variable.
  assert.equal(probe(probes, "emptyBody").available, true);
});

test("a single-entry rotation becomes a usable From comparison when a test From is set", () => {
  // One configured From + a different test From = a real A/B even though the
  // rotation itself has only one entry. Previously this probe was simply
  // unavailable, which hid the answer the user was looking for.
  const probes = buildIsolationProbes({
    subjects: ["Only subject"],
    bodies: ["<p>Only body</p>"],
    fromAddresses: ["solo@mydomain.com"],
    testFromOverride: "testing@otherdomain.com",
  });

  const fromProbe = probe(probes, "from");
  assert.equal(fromProbe.available, true);
  assert.equal(fromProbe.from, "solo@mydomain.com");
});

test("legacy variant-only campaigns still produce a ladder", () => {
  // Pre-Task-29 campaigns keep their content in CampaignVariant rows and leave
  // subjects/bodies empty; the ladder must not go blank for them.
  const probes = buildIsolationProbes({
    subjects: [],
    bodies: [],
    variants: [{ subject: "Variant subject", bodyHtml: "<p>Variant body</p>" }],
    fromAddresses: [],
  });

  assert.equal(probe(probes, "emptyBody").variant.subject, "Variant subject");
  assert.equal(probe(probes, "emptyBody").available, true);
  // No From configured anywhere: the From probe must be flagged, not silently
  // sent as some invented address.
  assert.equal(probe(probes, "from").from, null);
  assert.equal(probe(probes, "from").available, false);
});
