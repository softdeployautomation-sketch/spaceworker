import { test } from "node:test";
import assert from "node:assert/strict";

// TASK_226 — regression guards for lib/campaign-stall.ts, the pure module
// behind the campaign stall-visibility UI (§6 of TASK_226_CAMPAIGN_STALL_
// VISIBILITY.md).
//
// WHY THIS FILE EXISTS: the 2026-10-18 live incident (Sblast1) showed a
// campaign frozen at "sending" with zero on-screen explanation — the only
// answers lived in the drain journal on the box. These tests pin the three
// things the new UI must never regress on:
//
//   1. Every status the drain can park a campaign in maps to PLAIN-LANGUAGE
//      copy (all 4 §3.1 statuses + the two paused_deliverability variants).
//   2. The send-region label distinguishes "direct from server" from an exit
//      node — the exact field (Mailbox.sendRegion) that caused the stall.
//   3. The serialized payload NEVER carries recipient addresses (no toEmail).
//
// The module under test has zero imports on purpose (HOW_WE_MOVE_FAST §4) —
// loaded with the house `require` pattern since the project does not enable
// allowImportingTsExtensions.

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  stallExplanation,
  regionText,
  groupStallFailures,
  buildStallPayload,
} = require("../lib/campaign-stall") as typeof import("../lib/campaign-stall");
/* eslint-enable @typescript-eslint/no-require-imports */

const NO_OVERRIDE = { manualBoundary: false, testOverrideActive: false };

// ---------------------------------------------------------------------------
// 1. Status → message mapping (§3.1)
// ---------------------------------------------------------------------------

test("pending_test_confirm explains the test gate before any real send", () => {
  const copy = stallExplanation("pending_test_confirm", NO_OVERRIDE);
  assert.ok(copy, "pending_test_confirm must render an explanation");
  assert.match(copy.message, /confirm the test email/i);
  assert.match(copy.message, /nothing sends/i);
});

test("paused_deliverability (automated mode) says waiting for resume, never blameless silence", () => {
  const copy = stallExplanation("paused_deliverability", {
    manualBoundary: false,
    testOverrideActive: false,
  });
  assert.ok(copy);
  assert.equal(copy.tone, "danger");
  assert.match(copy.message, /waiting for your resume/i);
  assert.match(copy.message, /nothing sends while paused/i);
});

test("paused_deliverability in manual test mode is a CHECKPOINT (owner's turn), not a failure", () => {
  const copy = stallExplanation("paused_deliverability", {
    manualBoundary: true,
    testOverrideActive: true,
  });
  assert.ok(copy);
  assert.equal(copy.tone, "warning");
  assert.match(copy.message, /50-recipient checkpoint/i);
  assert.match(copy.message, /by design/i); // never failure-framed
  assert.doesNotMatch(copy.title, /fail/i);
});

test("sending with a test override warns that 50-boundary pauses are expected", () => {
  const copy = stallExplanation("sending", { manualBoundary: false, testOverrideActive: true });
  assert.ok(copy);
  assert.match(copy.message, /50-recipient checkpoint/i);
  assert.match(copy.message, /expected, not a failure/i);
});

test("plain sending explains the drain cadence (60s / 50 per tick)", () => {
  const copy = stallExplanation("sending", NO_OVERRIDE);
  assert.ok(copy);
  assert.match(copy.message, /60 seconds/i);
  assert.match(copy.message, /50 items per tick/i);
});

test("paused_manual says the user paused it themselves", () => {
  const copy = stallExplanation("paused_manual", NO_OVERRIDE);
  assert.ok(copy);
  assert.equal(copy.tone, "quiet");
  assert.match(copy.message, /you paused/i);
});

test("statuses where nothing is expected to move render NO explanation", () => {
  for (const status of ["done", "stopped", "draft", "", "something_new"]) {
    assert.equal(stallExplanation(status, NO_OVERRIDE), null, `status=${status}`);
  }
});

// ---------------------------------------------------------------------------
// 2. Region labels (§3.3 — direct vs exit node; the 2026-10-18 root cause)
// ---------------------------------------------------------------------------

test('null sendRegion renders "direct from server" — never an empty label', () => {
  assert.equal(regionText(null), "direct from server");
  assert.equal(regionText(undefined), "direct from server");
  assert.equal(regionText(""), "direct from server");
});

test("the US region (what caused the live stall) renders as a US exit node", () => {
  assert.equal(regionText("us"), "via US exit node (New York)");
});

test("registered ca/uk regions render their exit nodes; unknown regions still name themselves", () => {
  assert.equal(regionText("ca"), "via Canada exit node (Toronto)");
  assert.equal(regionText("uk"), "via UK exit node (London)");
  assert.equal(regionText("jp"), "via jp exit node"); // unregistered ≠ hidden
});

// ---------------------------------------------------------------------------
// 3. Failure-group rendering (§3.3)
// ---------------------------------------------------------------------------

test("identical errors group into one bucket, biggest count first", () => {
  const groups = groupStallFailures([
    { error: "Greeting never received", category: "soft_bounce", retryable: true },
    { error: "mailbox unavailable", category: "soft_bounce", retryable: true },
    { error: "Greeting never received", category: "soft_bounce", retryable: true },
    { error: "Greeting never received", category: "soft_bounce", retryable: true },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].error, "Greeting never received");
  assert.equal(groups[0].count, 3);
  assert.equal(groups[1].count, 1);
});

test("a group with ANY retryable member is marked retryable", () => {
  const groups = groupStallFailures([
    { error: "Connection closed", category: "hard_bounce", retryable: false },
    { error: "Connection closed", category: "soft_bounce", retryable: true },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].retryable, true);
  assert.equal(groups[0].count, 2);
});

test('wholly terminal groups stay non-retryable; blank errors become "Unknown error"', () => {
  const groups = groupStallFailures([
    { error: "550 5.1.1 user unknown", category: "hard_bounce", retryable: false },
    { error: "   ", category: null, retryable: false },
  ]);
  assert.equal(groups.find((g) => g.error === "550 5.1.1 user unknown")?.retryable, false);
  assert.ok(groups.find((g) => g.error === "Unknown error"));
});

test("the group list is capped (default 5) and huge provider errors are truncated for rendering", () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({
    error: i === 0 ? "x".repeat(500) : `distinct error ${i}`,
    category: "other",
    retryable: false,
  }));
  const groups = groupStallFailures(rows);
  assert.equal(groups.length, 5);
  const longest = groups.find((g) => g.error.startsWith("xxx"));
  assert.ok(longest);
  assert.ok(longest.error.length <= 161, "long errors render truncated (160 chars + ellipsis)");
  assert.ok(longest.error.endsWith("…"));
});

// ---------------------------------------------------------------------------
// 4. Payload serialization + the no-PII pin (§6)
// ---------------------------------------------------------------------------

function samplePayload() {
  return buildStallPayload({
    counts: { total: 150, queued: 100, retryScheduled: 100, sent: 30, failed: 20 },
    lastSentAt: new Date("2026-10-18T12:00:00.000Z"),
    nextRetryAt: new Date("2026-10-18T12:20:00.000Z"),
    failureRows: [
      { error: "Greeting never received", category: "soft_bounce", retryable: true },
      { error: "Greeting never received", category: "soft_bounce", retryable: true },
      { error: "550 rejected", category: "hard_bounce", retryable: false },
    ],
    mailboxes: [
      { label: "propertyblast", host: "smtp.zeptomail.com", sendRegion: null },
      { label: "us-relay", host: "smtp.example.com", sendRegion: "us" },
    ],
  });
}

test("payload carries counts, timestamps, groups, and mailbox paths with region labels", () => {
  const p = samplePayload();
  assert.equal(p.counts.retryScheduled, 100);
  assert.equal(p.lastSentAt, "2026-10-18T12:00:00.000Z");
  assert.equal(p.nextRetryAt, "2026-10-18T12:20:00.000Z");
  assert.equal(p.failureGroups[0].count, 2);
  assert.equal(p.mailboxes[0].regionText, "direct from server");
  assert.equal(p.mailboxes[1].regionText, "via US exit node (New York)");
});

test("no-PII pin: the serialized payload never contains toEmail or any recipient address", () => {
  const json = JSON.stringify(samplePayload());
  assert.ok(!json.includes("toEmail"), "payload must not carry toEmail");
  assert.ok(!json.includes("recipient"), "payload must not carry a recipient field");
  // No email-shaped values anywhere (mailbox usernames/hosts are domain-only).
  assert.doesNotMatch(json, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
});

test("empty campaign payload (nothing sent, no failures, no mailboxes) serializes cleanly", () => {
  const p = buildStallPayload({
    counts: { total: 0, queued: 0, retryScheduled: 0, sent: 0, failed: 0 },
    lastSentAt: null,
    nextRetryAt: null,
    failureRows: [],
    mailboxes: [],
  });
  assert.equal(p.lastSentAt, null);
  assert.equal(p.nextRetryAt, null);
  assert.deepEqual(p.failureGroups, []);
  assert.deepEqual(p.mailboxes, []);
});
