import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  BRIDGE_CONTEXT_MAX_AGE_MS,
  BRIDGE_TOOL_IDS,
  BRIDGE_TOOLS,
  bridgeHref,
  bridgeTool,
  isRangeId,
  parseBridgeContext,
  serializeBridgeContext,
} from "@/lib/lab/tool-bridge";

// TASK_156B S7-B — the tool bridge's pure-core tests (deep-links out, output
// returns signed) plus static pins on the attach route's guard ORDER: the
// security claims that matter here (404-not-403, cap, server-recomputed
// signature) must be visible in the source a reviewer reads, not folklore.

test("bridge tools cover exactly the three real launch points", () => {
  assert.deepEqual([...BRIDGE_TOOL_IDS], ["mailer", "extract", "devices"]);
  assert.equal(BRIDGE_TOOLS.length, 3);
  for (const t of BRIDGE_TOOLS) {
    assert.ok(t.href.startsWith("/dashboard/"), `${t.id} must target the app's dashboard routes`);
    assert.ok(t.hint.length > 0);
  }
  assert.ok(bridgeTool("mailer"));
  assert.equal(bridgeTool("nope"), null);
});

test("bridgeHref binds a validated rangeId and never encodes foreign shapes", () => {
  assert.equal(bridgeHref("mailer", "ckx1234567890"), "/dashboard/campaigns?labBridge=ckx1234567890");
  assert.equal(bridgeHref("mailer", null), "/dashboard/campaigns");
  assert.equal(bridgeHref("mailer", undefined), "/dashboard/campaigns");
  // Foreign shapes are refused — the query is simply not bound (links stay safe).
  assert.equal(bridgeHref("mailer", "../etc"), "/dashboard/campaigns");
  assert.equal(bridgeHref("mailer", "AB CD"), "/dashboard/campaigns");
  assert.equal(bridgeHref("mailer", "short"), "/dashboard/campaigns");
  assert.ok(!isRangeId("../etc") && !isRangeId("a/b") && !isRangeId(null));
  assert.ok(isRangeId("ckx1234567890"));
  assert.throws(() => bridgeHref("nope" as never, null));
});

test("bridge context round-trips and every tamper reads as null (never a URL)", () => {
  const at = 1_792_000_000_000;
  const raw = serializeBridgeContext({ toolId: "extract", rangeId: "ckx1234567890", at });
  assert.ok(raw);
  const parsed = parseBridgeContext(raw, at + 1000);
  assert.deepEqual(parsed, { toolId: "extract", rangeId: "ckx1234567890", at });

  const now = Date.now();
  // Stale (older than the window) → null.
  assert.equal(parseBridgeContext(raw, at + BRIDGE_CONTEXT_MAX_AGE_MS + 1), null);
  // Future-stamped beyond skew → null.
  assert.equal(parseBridgeContext(raw, at - 10 * 60 * 1000), null);
  // Unknown tool / bad shape / bad JSON / oversized → null.
  assert.equal(parseBridgeContext(JSON.stringify({ toolId: "nope", rangeId: "ckx1234567890", at }), now), null);
  assert.equal(parseBridgeContext(JSON.stringify({ toolId: "mailer", rangeId: "../etc", at }), now), null);
  assert.equal(parseBridgeContext("{not json", now), null);
  assert.equal(parseBridgeContext(null, now), null);
  assert.equal(parseBridgeContext("x".repeat(600), now), null);
  // serialize refuses invalid input outright.
  assert.equal(serializeBridgeContext({ toolId: "mailer", rangeId: "BAD ID", at }), null);
});

test("route pins: owner-scope 404 before body parse, cap, server-recomputed signature", () => {
  const root = resolve(import.meta.dirname, "..");
  const src = readFileSync(resolve(root, "app/api/cyberlab/runs/[id]/artefacts/route.ts"), "utf8");
  // Code-only substrings (the header comment mentions some of these words —
  // pinning to exact code forms keeps the ORDER check about the actual guards).
  const order = [
    src.indexOf("const user = await getCurrentUser()"),
    src.indexOf('await moduleToolsDenied(user.id, "cyberlab")'),
    src.indexOf("db.labRange.findUnique"),
    src.indexOf("userId !== user.id"),
    src.indexOf("Body.safeParse"),
    src.indexOf("createEpisode({"),
    src.indexOf("verifyEpisodeSignature(episode.id)"),
  ];
  for (const idx of order) assert.ok(idx >= 0, "every guard step must exist in source");
  for (let i = 1; i < order.length; i++) assert.ok(order[i] > order[i - 1], `guard ${i} must run in order`);
  assert.ok(src.includes("404"), "foreign range must be 404, never 403");
  assert.ok(src.includes(`BRIDGE_MAX_CONTENT_CHARS`), "the API must enforce the shared size cap");
  assert.ok(src.includes("EpisodeCapError"), "bridge artefacts count against the evidence budget");
});

test("UI + console pins: bridge mounted with run binding, context written on leave", () => {
  const root = resolve(import.meta.dirname, "..");
  const ui = readFileSync(resolve(root, "components/cyberlab-tool-bridge.tsx"), "utf8");
  const consoleSrc = readFileSync(resolve(root, "components/cyberlab-ops-console.tsx"), "utf8");
  assert.ok(ui.includes("serializeBridgeContext"), "context written when leaving to a tool");
  assert.ok(ui.includes("parseBridgeContext"), "context re-validated on return");
  assert.ok(ui.includes("Attach as signed artefact"));
  assert.ok(consoleSrc.includes("<CyberLabToolBridge"));
  assert.ok(consoleSrc.includes("openFrame?.rangeId ?? null"), "bridge binds to the open run");
  assert.ok(consoleSrc.includes("void refresh()"), "console refreshes after an attach");
});
