import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// TASK_152 M5 — the screen-monitoring notification RULES, pinned.
//
// The live acceptance run (scratch DB) is the primary evidence and lives in the
// task writeup. This file pins the pieces that a live run can't isolate:
//   * the one keyword-matching rule (and that a blank keyword matches NOTHING),
//   * the cooldown arithmetic, including the exactly-at-boundary case,
//   * the digest window alignment / clamping,
//   * the "off means off" copy the UI shows, and
//   * a GUARD that the two master switches stay @default(false) in the schema
//     AND in the shipped migration — so "a notification feature that defaults
//     on" cannot be committed without this test going red.

process.env.DATABASE_URL ??= "postgresql://t152:t152@localhost:5432/task152_placeholder";
process.env.SESSION_SECRET ??= "task152-m5-test-session-secret";
process.env.RESEND_API_KEY ??= "task152-m5-test-resend-key";
process.env.EMAIL_FROM ??= "t152@spaceworker.test";
process.env.APP_BASE_URL ??= "https://spaceworker.test";
(process.env as Record<string, string>).NODE_ENV = "test";

// `server-only` throws outside a Server Component build, so it is stubbed with
// the house require hook (HOW_WE_MOVE_FAST §4). The hook must be installed
// BEFORE the modules under test load, so they are pulled in with require()
// below rather than a hoisted `import`.
import Module from "node:module";

type Loader = {
  _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};
function installServerOnlyStub(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    return original.call(this, request, parent, isMain);
  };
}
installServerOnlyStub();

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  matchTriggerKeyword,
  cooldownElapsed,
  digestWindowEnd,
  triggerDisplayName,
  clampDigestIntervalMinutes,
  SCREEN_TRIGGER_DEFAULT_COOLDOWN_MINUTES,
  SCREEN_TRIGGER_MIN_COOLDOWN_MINUTES,
  SCREEN_TRIGGER_MAX_COOLDOWN_MINUTES,
  SCREEN_DIGEST_DEFAULT_INTERVAL_MINUTES,
  SCREEN_DIGEST_MIN_INTERVAL_MINUTES,
  SCREEN_DIGEST_MAX_INTERVAL_MINUTES,
  SCREEN_TRIGGER_EVENT_TYPE,
  SCREEN_DIGEST_EVENT_TYPE,
} = require("../lib/screen-notifications") as typeof import("../lib/screen-notifications");

const {
  screenAlertsStateCopy,
  digestCadenceLabel,
  cooldownLabel,
} = require("../lib/screen-alert-copy") as typeof import("../lib/screen-alert-copy");
/* eslint-enable @typescript-eslint/no-require-imports */

// --------------------------------------------------------------------------
// The keyword rule — the owner's own example, "the screen shows a balance"
// --------------------------------------------------------------------------

test("a keyword matches a frame summary case-insensitively as a substring", () => {
  const summary = "Chase online banking page open, showing an account balance of $4,210.55.";
  assert.equal(matchTriggerKeyword(summary, "balance"), true);
  assert.equal(matchTriggerKeyword(summary, "BALANCE"), true);
  assert.equal(matchTriggerKeyword(summary, "  balance  "), true, "surrounding spaces are trimmed");
  assert.equal(matchTriggerKeyword(summary, "account balance"), true, "multi-word phrase");
});

test("a keyword that is not present does not match", () => {
  const summary = "A code editor with a test output panel.";
  assert.equal(matchTriggerKeyword(summary, "balance"), false);
});

test("a blank keyword matches NOTHING (never everything)", () => {
  assert.equal(matchTriggerKeyword("anything at all", ""), false);
  assert.equal(matchTriggerKeyword("anything at all", "   "), false);
});

test("a missing summary never matches", () => {
  assert.equal(matchTriggerKeyword(null, "balance"), false);
});

// --------------------------------------------------------------------------
// The cooldown — a "balance" sitting on screen must not fire every capture
// --------------------------------------------------------------------------

test("a never-fired trigger is not in cooldown", () => {
  const now = new Date("2026-10-01T12:00:00.000Z");
  assert.equal(cooldownElapsed(null, 120, now), true);
});

test("a trigger inside its cooldown does not fire again", () => {
  const now = new Date("2026-10-01T12:01:00.000Z");
  const last = new Date("2026-10-01T12:00:00.000Z"); // 1 minute ago
  assert.equal(cooldownElapsed(last, 120, now), false);
});

test("a trigger fires again once the cooldown has fully elapsed", () => {
  const last = new Date("2026-10-01T12:00:00.000Z");
  assert.equal(cooldownElapsed(last, 120, new Date("2026-10-01T13:59:59.000Z")), false);
  assert.equal(cooldownElapsed(last, 120, new Date("2026-10-01T14:00:00.000Z")), true, "exactly at the boundary");
  assert.equal(cooldownElapsed(last, 120, new Date("2026-10-01T14:01:00.000Z")), true);
});

// --------------------------------------------------------------------------
// Digest cadence — window alignment and clamping
// --------------------------------------------------------------------------

test("the digest window is floored to a whole cadence boundary", () => {
  const m = SCREEN_DIGEST_DEFAULT_INTERVAL_MINUTES; // 120
  assert.equal(digestWindowEnd(new Date("2026-10-01T12:00:00.000Z"), m).toISOString(), "2026-10-01T12:00:00.000Z");
  assert.equal(digestWindowEnd(new Date("2026-10-01T12:59:59.000Z"), m).toISOString(), "2026-10-01T12:00:00.000Z");
  assert.equal(digestWindowEnd(new Date("2026-10-01T13:00:00.000Z"), m).toISOString(), "2026-10-01T12:00:00.000Z");
  assert.equal(digestWindowEnd(new Date("2026-10-01T13:00:01.000Z"), m).toISOString(), "2026-10-01T12:00:00.000Z");
  assert.equal(digestWindowEnd(new Date("2026-10-01T13:59:59.000Z"), m).toISOString(), "2026-10-01T12:00:00.000Z");
  assert.equal(digestWindowEnd(new Date("2026-10-01T14:00:00.000Z"), m).toISOString(), "2026-10-01T14:00:00.000Z");
});

test("a stored cadence is clamped into the supported range", () => {
  assert.equal(clampDigestIntervalMinutes(0), SCREEN_DIGEST_MIN_INTERVAL_MINUTES);
  assert.equal(clampDigestIntervalMinutes(1), SCREEN_DIGEST_MIN_INTERVAL_MINUTES);
  assert.equal(clampDigestIntervalMinutes(120), 120);
  assert.equal(clampDigestIntervalMinutes(999999), SCREEN_DIGEST_MAX_INTERVAL_MINUTES);
});

// --------------------------------------------------------------------------
// Display helpers
// --------------------------------------------------------------------------

test("a trigger's name is its label, falling back to the keyword", () => {
  assert.equal(triggerDisplayName({ label: "Balance shown", keyword: "balance" }), "Balance shown");
  assert.equal(triggerDisplayName({ label: null, keyword: "balance" }), "balance");
  assert.equal(triggerDisplayName({ label: "   ", keyword: "balance" }), "balance");
});

test("human cadence/cooldown labels read sensibly", () => {
  assert.equal(digestCadenceLabel(120), "every 2 hours");
  assert.equal(digestCadenceLabel(60), "every 1 hour");
  assert.equal(digestCadenceLabel(1440), "every 1 day");
  assert.equal(digestCadenceLabel(30), "every 30 minutes");
  assert.equal(cooldownLabel(720), "12 hours");
  assert.equal(cooldownLabel(90), "90 minutes");
});

// --------------------------------------------------------------------------
// THE OFF SWITCH — "off" must read as off, and the defaults must be off
// --------------------------------------------------------------------------

test("the default (both switches false) state reads as OFF", () => {
  const copy = screenAlertsStateCopy({
    triggersEnabled: false,
    digestEnabled: false,
    digestIntervalMinutes: 120,
  });
  assert.match(copy, /OFF/);
  assert.match(copy, /Nothing will be sent/);
});

test("the copy distinguishes the partial states from 'all on'", () => {
  const t = screenAlertsStateCopy({ triggersEnabled: true, digestEnabled: false, digestIntervalMinutes: 120 });
  const d = screenAlertsStateCopy({ triggersEnabled: false, digestEnabled: true, digestIntervalMinutes: 120 });
  assert.match(t, /digest is OFF/i);
  assert.match(d, /Triggers are OFF/i);
});

test("GUARD: both master switches default FALSE in the schema", () => {
  const schema = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf8");
  assert.match(
    schema,
    /screenTriggerNotificationsEnabled\s+Boolean\s+@default\(false\)/,
    "screenTriggerNotificationsEnabled must default false",
  );
  assert.match(
    schema,
    /screenDigestEnabled\s+Boolean\s+@default\(false\)/,
    "screenDigestEnabled must default false",
  );
});

test("GUARD: the shipped migration also defaults both switches to false", () => {
  const sql = readFileSync(
    join(
      process.cwd(),
      "prisma",
      "migrations",
      "20261026000000_task152_m5_screen_monitor_notifications",
      "migration.sql",
    ),
    "utf8",
  );
  assert.match(sql, /"screenTriggerNotificationsEnabled" BOOLEAN NOT NULL DEFAULT false/);
  assert.match(sql, /"screenDigestEnabled" BOOLEAN NOT NULL DEFAULT false/);
});

// --------------------------------------------------------------------------
// Constants the rest of the feature depends on
// --------------------------------------------------------------------------

test("the documented defaults and bounds are the ones shipped", () => {
  assert.equal(SCREEN_TRIGGER_DEFAULT_COOLDOWN_MINUTES, 120);
  assert.equal(SCREEN_TRIGGER_MIN_COOLDOWN_MINUTES, 1);
  assert.equal(SCREEN_TRIGGER_MAX_COOLDOWN_MINUTES, 1440);
  assert.equal(SCREEN_DIGEST_DEFAULT_INTERVAL_MINUTES, 120);
  assert.ok(SCREEN_DIGEST_MIN_INTERVAL_MINUTES < SCREEN_DIGEST_DEFAULT_INTERVAL_MINUTES);
  assert.ok(SCREEN_DIGEST_MAX_INTERVAL_MINUTES > SCREEN_DIGEST_DEFAULT_INTERVAL_MINUTES);
  assert.equal(SCREEN_TRIGGER_EVENT_TYPE, "screen_trigger");
  assert.equal(SCREEN_DIGEST_EVENT_TYPE, "screen_digest");
});
