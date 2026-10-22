// The cached private command must never outlive its generator: a stale flag
// set installs the binaries and enrolls nothing (live failure 2026-10-22).
//
// Run:
//   npx tsx --test tests/private-ps-command.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { isCurrentPrivatePsCommand, PRIVATE_PS_MARKER } from "../lib/private-ps-command";

const NOW = Date.parse("2026-10-22T12:00:00Z");
const future = new Date(NOW + 60 * 60 * 1000);
const past = new Date(NOW - 1000);

const CURRENT = [
  PRIVATE_PS_MARKER,
  "$ErrorActionPreference = 'Stop'",
  "-m install --api https://agent.broks.beauty --client-id 43 --site-id 144 --agent-type workstation",
].join("\n");

const LEGACY = [
  "$ErrorActionPreference = 'Stop'",
  "-m install --api https://agent.broks.beauty --client 43 --site 144 --agenttype workstation --copy Pact_x --devicedeployment 5f09",
].join("\n");

test("accepts an unexpired, current-generation command", () => {
  assert.equal(isCurrentPrivatePsCommand(CURRENT, future, NOW), true);
});

test("rejects the legacy cached command users were actually shown", () => {
  assert.equal(isCurrentPrivatePsCommand(LEGACY, future, NOW), false);
});

test("rejects a current command with any required flag missing", () => {
  for (const flag of ["--client-id", "--site-id", "--agent-type"]) {
    const broken = CURRENT.replace(flag, "--gone");
    assert.equal(isCurrentPrivatePsCommand(broken, future, NOW), false, flag);
  }
});

test("rejects expired commands even when the marker is present", () => {
  assert.equal(isCurrentPrivatePsCommand(CURRENT, past, NOW), false);
});

test("rejects empty / missing command or expiry", () => {
  assert.equal(isCurrentPrivatePsCommand(null, future, NOW), false);
  assert.equal(isCurrentPrivatePsCommand("", future, NOW), false);
  assert.equal(isCurrentPrivatePsCommand(CURRENT, null, NOW), false);
});
