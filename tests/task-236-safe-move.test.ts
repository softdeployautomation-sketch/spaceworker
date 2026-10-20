// TASK_236 — SpaceWorker side of the SAFE move: install the private agent,
// VERIFY it, and let the USER delete the public row themselves.
//
// The Device I failure (2026-10-20) was the public device vanishing from the
// console while the private enrollment never appeared. These pins therefore
// assert ABSENCES: the console must expose no automatic/premature removal
// path, and the verification step must be read-only.
//
// Run: npx tsx --test tests/task-236-safe-move.test.ts

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
const verifyRouteSrc = codeOnly(read("app/api/devices/[deviceId]/move-to-private/verify/route.ts"));
const listSrc = read("components/device-list.tsx");

// --- 1: the move hands back a plan, nothing more ---------------------------

test("move route: returns the install plan and never a 'moved' promise", () => {
  assert.ok(moveRouteSrc.includes("install: result.install"));
  assert.ok(moveRouteSrc.includes("flow: result.flow"));
  assert.ok(!moveRouteSrc.includes("NextResponse.json({ ok: true })"));
  // The tier does NOT flip on the move click — only the sync does that.
  assert.ok(!moveRouteSrc.includes("tier: \"private\""));
});

test("the moved flag is forwarded so the UI can label a move", () => {
  assert.ok(deviceToolsSrc.includes("moved?: boolean"));
  assert.ok(listSrc.includes("data.install?.moved === true"));
});

// --- 2: no automatic public removal anywhere in the console -----------------

test("nothing in the console calls the Vantra remove route", () => {
  assert.ok(!deviceToolsSrc.includes("/move/remove"), "no removal tool may exist");
  assert.ok(!moveRouteSrc.includes("/move/remove"));
  assert.ok(!verifyRouteSrc.includes("/move/remove"));
});

test("the verify path is read-only: it reports, it never deletes", () => {
  assert.ok(verifyRouteSrc.includes("verifyMoveToPrivate"));
  assert.ok(!verifyRouteSrc.includes("removeDevice"));
  assert.ok(!verifyRouteSrc.includes("delete"));
  // It answers the question and nothing else.
  assert.ok(verifyRouteSrc.includes("verified: result.verified"));
});

test("the verify tool asks Vantra's verify route", () => {
  assert.ok(deviceToolsSrc.includes("/move/verify"));
  assert.ok(deviceToolsSrc.includes("verifyMoveToPrivate"));
});

// --- 3: the UI only offers deletion AFTER verification, by the user --------

test("the move panel offers a read-only verification check", () => {
  assert.ok(listSrc.includes("checkMoveVerification"));
  assert.ok(listSrc.includes("/move-to-private/verify"));
  assert.ok(listSrc.includes("Check private copy"));
  // The panel must state that the public agent keeps running.
  assert.ok(listSrc.includes("public agent stays online"));
});

test("the panel tells the user to delete the public row THEMSELVES", () => {
  const code = codeOnly(listSrc);
  assert.ok(code.includes("delete the public row yourself"));
  // No automatic delete button may appear in the move panel.
  assert.ok(!code.includes("delete the public row when you"));
});

test("an unverified move reports 'not seen yet' and keeps the public device", () => {
  assert.ok(listSrc.includes("not_verified"));
  assert.ok(listSrc.includes("The public agent is untouched"));
});
