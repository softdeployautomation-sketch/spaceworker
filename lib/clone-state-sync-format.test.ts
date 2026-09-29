/**
 * TASK_135 §6.3 — tests for the pure half of the state pipe.
 *
 * These are the pieces where every possible bug is SILENT:
 *
 *   - a command without `--budget` never lets a long transfer report what it did
 *     not send, so a partial replica looks complete;
 *   - a parser that reads `done` loosely makes a half-finished transfer look
 *     finished, and the platform stops asking;
 *   - a summary that rounds up is the sentence an operator believes when their
 *     tabs are missing.
 *
 * There is no mocking here and no HTTP: all three functions are pure, which is
 * exactly why they were split out of the transport module (which is `server-only`
 * and cannot be imported by a test).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  DEVICE_COMMAND_MAX_SECONDS,
  STATE_SYNC_BROWSERS,
  buildStateSyncCommand,
  parseStateSyncOutput,
  stateSyncSummary,
} from "./clone-state-sync-format";

test("the command tells the device to stop sending BEFORE the platform's own timeout", () => {
  // The whole reason a transfer larger than one command can finish. If the device
  // were allowed to send until the platform killed the command, the kill would
  // arrive at the same moment as the report — so nothing would ever be recorded
  // about a long transfer, and a partial replica would be indistinguishable from
  // a failed one.
  const built = buildStateSyncCommand({ browser: "chrome", profileName: "Default" });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const timeout = Number(/--timeout (\d+)/.exec(built.cmd)?.[1]);
  const budget = Number(/--budget (\d+)/.exec(built.cmd)?.[1]);
  assert.ok(Number.isFinite(timeout) && Number.isFinite(budget), `both flags must be present: ${built.cmd}`);
  assert.ok(budget < timeout, `budget (${budget}) must be strictly less than timeout (${timeout})`);
  assert.ok(budget >= 5, `budget (${budget}) must stay usable`);
});

test("the command quotes every value and refuses anything that could add a statement", () => {
  const built = buildStateSyncCommand({ browser: "chrome", profileName: "Profile 1", cloneJobId: "job-1" });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.match(built.cmd, /--profile 'Profile 1'/);
  assert.match(built.cmd, /--job 'job-1'/);

  // A profile name reaches this from a clone job, which the console sets, and it
  // is interpolated into a PowerShell command line. A quote or a semicolon must
  // not be able to append a second statement.
  for (const evil of ["Default'; Remove-Item C:\\ -Recurse", "Default; whoami", "Default$(whoami)", "Default`n"]) {
    const refused = buildStateSyncCommand({ browser: "chrome", profileName: evil });
    assert.equal(refused.ok, false, `profile ${JSON.stringify(evil)} must be refused`);
  }
  const badJob = buildStateSyncCommand({ browser: "chrome", cloneJobId: "job'; whoami" });
  assert.equal(badJob.ok, false);
});

test("the command refuses a browser the device cannot walk", () => {
  // Firefox is refused HERE as well as on the device: its profile layout is not
  // Chromium's, and a Chromium-shaped walk of it would produce an empty manifest
  // that looks exactly like "nothing changed".
  assert.deepEqual([...STATE_SYNC_BROWSERS], ["chrome", "edge", "brave"]);
  for (const browser of ["firefox", "safari", "", "chrome-ish"]) {
    const built = buildStateSyncCommand({ browser });
    assert.equal(built.ok, false, `${JSON.stringify(browser)} must be refused`);
    if (!built.ok) assert.match(built.error, /^state_browser_unsupported/);
  }
  for (const browser of ["chrome", "EDGE", " Brave "]) {
    assert.equal(buildStateSyncCommand({ browser }).ok, true, `${browser} must be accepted`);
  }
});

test("the command never exceeds the device's own run-command cap", () => {
  const built = buildStateSyncCommand({ browser: "chrome", timeoutSeconds: 10_000 });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const timeout = Number(/--timeout (\d+)/.exec(built.cmd)?.[1]);
  assert.equal(timeout, DEVICE_COMMAND_MAX_SECONDS);
});

test("the parser reads `done` strictly, so an unfinished transfer cannot look finished", () => {
  // The exact failure this prevents: the device stops at its budget and says
  // `done:false`, but a parser that treated a missing-or-anything value as
  // finished would stop the platform from asking again — leaving the replica
  // incomplete forever, with every screen saying the sync succeeded.
  const unfinished = parseStateSyncOutput('{"ok":true,"browser":"chrome","done":false,"pending":12,"sent":3}');
  assert.equal(unfinished?.done, false);
  assert.equal(unfinished?.pending, 12);
  assert.equal(unfinished?.sent, 3);

  const finished = parseStateSyncOutput('{"ok":true,"browser":"chrome","done":true,"pending":0}');
  assert.equal(finished?.done, true);

  // An engine older than this field reports nothing about it. That must be read
  // as finished, not as "keep running forever".
  const legacy = parseStateSyncOutput('{"ok":true,"browser":"chrome","sent":5}');
  assert.equal(legacy?.done, true);
});

test("the parser takes the LAST result line and refuses anything else", () => {
  const output = [
    "starting state sync for chrome",
    '{"ok":true,"browser":"chrome","sent":1}',
    "some warning",
    "not json at all",
    '{"ok":false,"browser":"chrome","failed":"state_profile_missing"}',
  ].join("\r\n");
  const parsed = parseStateSyncOutput(output);
  assert.equal(parsed?.ok, false);
  assert.equal(parsed?.failed, "state_profile_missing");

  // A stray brace, a JSON array and a JSON object without a boolean `ok` are all
  // "no result" — never a sync that "must have worked".
  assert.equal(parseStateSyncOutput("{"), null);
  assert.equal(parseStateSyncOutput("[1,2,3]"), null);
  assert.equal(parseStateSyncOutput('{"sent":5}'), null);
  assert.equal(parseStateSyncOutput("no output at all"), null);
  assert.equal(parseStateSyncOutput(""), null);
  assert.equal(parseStateSyncOutput(null), null);
  assert.equal(parseStateSyncOutput(undefined), null);
});

test("the parser tolerates a missing browser or profile without inventing a value", () => {
  const parsed = parseStateSyncOutput('{"ok":true}');
  assert.equal(parsed?.ok, true);
  assert.equal(parsed?.browser, "");
  assert.equal(parsed?.profile, "Default");
  // Absent counts stay absent: `undefined` is not `0`, and the caller must be able
  // to tell "no files were sent" from "the device did not say".
  assert.equal(parsed?.sent, undefined);
  assert.equal(parsed?.pending, undefined);
});

test("the summary says a transfer is unfinished, and tells the operator to run it again", () => {
  const line = stateSyncSummary({
    ok: true,
    browser: "chrome",
    profile: "Default",
    reason: "first_clone",
    sent: 40,
    bytes: 2 * 1048576,
    pending: 12,
  });
  assert.match(line, /first clone/);
  assert.match(line, /40 files/);
  assert.match(line, /2\.0 MB/);
  assert.match(line, /12 still to come/);
  assert.match(line, /run it again to finish/);
});

test("the summary never claims success it did not see", () => {
  // No result line at all.
  assert.equal(stateSyncSummary(null), "state sync: no result from the device");
  // A named failure, with the transport's own sanitised words alongside.
  const failed = stateSyncSummary({
    ok: false,
    browser: "chrome",
    profile: "Default",
    failed: "state_sync_timeout",
    transport: "device did not respond",
  });
  assert.match(failed, /state sync failed: state_sync_timeout/);
  assert.match(failed, /device did not respond/);
  // A device-side refusal, still named.
  const refused = stateSyncSummary({
    ok: false,
    browser: "chrome",
    profile: "Default",
    failed: "state_profile_missing",
  });
  assert.match(refused, /state_profile_missing/);
  assert.doesNotMatch(refused, /\(\s*\)/);
});

test("the summary names a continued transfer as continued, not as a first clone", () => {
  // `cache_baseline` means the comparison was made against what the replica
  // already holds. Reporting it as a first clone would tell an operator their
  // replica was rebuilt from scratch when it was merely completed.
  const continued = stateSyncSummary({
    ok: true,
    browser: "chrome",
    profile: "Default",
    reason: "cache_baseline",
    sent: 3,
    bytes: 1024,
    pending: 0,
  });
  assert.match(continued, /continued/);
  assert.doesNotMatch(continued, /first clone/);
  assert.doesNotMatch(continued, /run it again/);

  const synced = stateSyncSummary({
    ok: true, browser: "chrome", profile: "Default", reason: "sync_on_reconnect", sent: 1, bytes: 10,
  });
  assert.match(synced, /synced/);
  assert.match(synced, /1 file\b/);
  assert.doesNotMatch(synced, /1 files/);
});
