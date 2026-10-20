// TASK_234 — SpaceWorker side: (A) captureOutput plumbing for mesh-only Run-now
// and (B1/B2) the Move-to-private install-plan passthrough. All pins read the
// shipped source (admin-device-tools.test.ts posture) — silent contract drift
// here drops command output or the install command again with no type error.
// Run: npx tsx --test tests/task-234-move-capture.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
/** Strip // line comments — prose legitimately names retired symbols. */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

const deviceToolsSrc = codeOnly(read("lib/device-tools.ts"));
const moveRouteSrc = codeOnly(read("app/api/devices/[deviceId]/move-to-private/route.ts"));
const runRouteSrc = codeOnly(read("app/api/devices/[deviceId]/run-command/route.ts"));
const sweepSrc = codeOnly(read("app/api/internal/device-onboarding-sweep/route.ts"));
const cloneSetupSrc = codeOnly(read("lib/clone-setup.ts"));
const auditSrc = codeOnly(read("lib/security-audit/run.ts"));
const listSrc = read("components/device-list.tsx"); // comments matter for the copy pins

// --- A: captureOutput plumbing ----------------------------------------------

test("runCommandNow: mesh body carries captureOutput ONLY when the caller sets it", () => {
  // The spread is multi-line in the source — pin both halves:
  assert.ok(deviceToolsSrc.includes("...(opts.captureOutput"));
  assert.ok(deviceToolsSrc.includes("? { captureOutput: true, timeoutSeconds }"));
  assert.ok(deviceToolsSrc.includes(": {}),"));
});

test("sweep never sets captureOutput — its hide verdict stays byte-old (pin 10)", () => {
  assert.ok(!sweepSrc.includes("captureOutput"), "sweep must not request capture");
});

test("every interactive output-reading caller opts in", () => {
  assert.ok(runRouteSrc.includes("captureOutput: true"), "Command tab Run-now");
  assert.ok(cloneSetupSrc.includes("captureOutput: true"), "clone setup");
  assert.ok(auditSrc.includes("captureOutput: true"), "security-audit");
  // The two in-file interactive callers (Ping / discovery tools):
  const hits = deviceToolsSrc.match(/captureOutput: true/g) ?? [];
  assert.ok(hits.length >= 2, `device-tools interactive callers, got ${hits.length}`);
});

// --- B1: Move-to-private carries the install plan ---------------------------

test("MoveToPrivateResult mirrors Vantra's real response (install survives)", () => {
  assert.ok(deviceToolsSrc.includes("install?: { command: string }"));
  assert.ok(deviceToolsSrc.includes("destinationOrgName?: string"));
  // The retired fiction must stay dead:
  assert.ok(!deviceToolsSrc.includes("moved: true"));
});

test("move-to-private route hands install.command to the client", () => {
  assert.ok(moveRouteSrc.includes("install: result.install"));
  assert.ok(moveRouteSrc.includes("flow: result.flow"));
  // Never the old bare ack:
  assert.ok(!moveRouteSrc.includes("NextResponse.json({ ok: true })"));
});

// --- B2: the UI shows the command and tells the truth -----------------------

test("device-list: Move success sets the instruction panel (masked until reveal)", () => {
  assert.ok(listSrc.includes("setMoveInstruction({ deviceName: d.name, command })"));
  assert.ok(listSrc.includes("moveRevealed ? moveInstruction.command : maskCommand("));
  assert.ok(listSrc.includes('copyText("move-install", moveInstruction.command)'));
  assert.ok(
    listSrc.includes("disabled={!moveRevealed}"),
    "copy must stay gated on reveal (same posture as the public PS command)",
  );
});

test("device-list: confirm copy no longer promises the retired live reconfig", () => {
  // Code-only view: the comment at device-list.tsx:702 legitimately quotes the
  // retired sentence while explaining WHY it died.
  const code = codeOnly(listSrc);
  assert.ok(!code.includes("restarts once"), "the reconfig-era sentence must stay dead");
  assert.ok(code.includes("Get install command"));
});
