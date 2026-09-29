import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  CLONE_PROFILE_NAME_DEFAULT,
  isSessionFilePath,
  materializeCloneState,
  normalizeProfileName,
  normalizeRelPath,
  stageIncomingFile,
  stateFileProblem,
} from "./clone-state-restore";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("a missing profile name resolves to Default, a path-like one does not", () => {
  // Chromium's primary profile really is `Default`, so refusing here would fail
  // a good clone over an absent optional field.
  assert.equal(normalizeProfileName(undefined), CLONE_PROFILE_NAME_DEFAULT);
  assert.equal(normalizeProfileName("  "), CLONE_PROFILE_NAME_DEFAULT);
  assert.equal(normalizeProfileName("Profile 1"), "Profile 1");
  assert.equal(normalizeProfileName("Profile-23"), "Profile-23");
  // These are not missing fields, they are attempts to write elsewhere.
  for (const bad of ["..", ".", "../Default", "Default/..", "a/b", "Default\\x", "x\u0000y", "a".repeat(65)]) {
    assert.equal(normalizeProfileName(bad), null, `must refuse ${JSON.stringify(bad)}`);
  }
});

test("relative paths are normalised from either separator", () => {
  assert.equal(normalizeRelPath("Sessions\\Session_123"), "Sessions/Session_123");
  assert.equal(normalizeRelPath("/History"), "History");
  assert.equal(normalizeRelPath("  Bookmarks "), "Bookmarks");
});

test("a session (tab) file is recognised, from both layouts", () => {
  assert.equal(isSessionFilePath("Sessions/Session_13200000000000000"), true);
  assert.equal(isSessionFilePath("sessions\\Tabs_132"), true);
  assert.equal(isSessionFilePath("Current Session"), true);
  assert.equal(isSessionFilePath("Last Tabs"), true);
  assert.equal(isSessionFilePath("History"), false);
  assert.equal(isSessionFilePath("Sessions.txt"), false);
});

test("the sensitive files are refused with their reason, and normal files are not", () => {
  assert.equal(stateFileProblem("History"), null);
  assert.equal(stateFileProblem("Sessions/Session_1"), null);
  assert.equal(stateFileProblem("Network/Cookies"), "cookies_abe_bound_use_cdp");
  assert.equal(stateFileProblem("Login Data"), "passwords_abe_bound_unusable_in_clone");
  assert.equal(stateFileProblem("Local State"), "abe_key_store_never_transferred");
  assert.equal(stateFileProblem("SingletonLock"), "stale_browser_lock");
  assert.equal(stateFileProblem("../../etc/passwd"), "state_path_escapes_profile");
});

test("staging accepts a normal file and refuses an unsafe or sensitive one", async () => {
  const staging = tmp("stage-");
  const ok = await stageIncomingFile({
    stagingDir: staging,
    relPath: "Sessions/Session_1",
    content: Buffer.from("tab data"),
  });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(readFileSync(join(staging, "Sessions", "Session_1"), "utf8"), "tab data");

  for (const bad of ["Network/Cookies", "../../escape", "", "Login Data"]) {
    const res = await stageIncomingFile({ stagingDir: staging, relPath: bad, content: Buffer.from("x") });
    assert.equal(res.ok, false, `must refuse ${JSON.stringify(bad)}`);
  }
  assert.equal(
    (await stageIncomingFile({ stagingDir: staging, relPath: "History", content: Buffer.alloc(0) })).ok,
    false,
    "an empty file is not a state file",
  );
  // And nothing escaped the staging dir.
  assert.equal(existsSync(join(staging, "..", "escape")), false);
});

test("a materialised clone lands in the profile directory with tabs restored", async () => {
  const staging = tmp("stage-");
  const profileDir = tmp("profile-");
  writeFileSync(join(staging, "History"), "history-bytes");
  writeFileSync(join(staging, "Bookmarks"), "{}");
  mkdirSync(join(staging, "Sessions"), { recursive: true });
  writeFileSync(join(staging, "Sessions", "Session_1"), "tabs");
  // A sensitive file the device should never have sent, and a symlink.
  mkdirSync(join(staging, "Network"), { recursive: true });
  writeFileSync(join(staging, "Network", "Cookies"), "encrypted");
  symlinkSync("/etc/passwd", join(staging, "SneakyLink"));
  // The Preferences document Chromium reads at startup — the file the tab
  // restore nudge edits.
  writeFileSync(join(staging, "Preferences"), JSON.stringify({ profile: { exit_type: "Normal" }, other: 1 }));

  const result = await materializeCloneState({ stagingDir: staging, profileDir, profileName: "Default" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.profileName, "Default");
  assert.equal(result.copied, 4);
  assert.equal(result.tabsStaged, true);
  assert.equal(result.restoreNudged, true);

  const dest = join(profileDir, "Default");
  assert.equal(readFileSync(join(dest, "History"), "utf8"), "history-bytes");
  assert.equal(readFileSync(join(dest, "Sessions", "Session_1"), "utf8"), "tabs");
  // The sensitive file and the symlink were refused, WITH reasons.
  assert.equal(existsSync(join(dest, "Network", "Cookies")), false);
  assert.equal(existsSync(join(dest, "SneakyLink")), false);
  assert.deepEqual(result.skipped.map((s) => s.path).sort(), ["Network/Cookies", "SneakyLink"]);
  assert.equal(result.skipped.find((s) => s.path === "SneakyLink")?.reason, "state_path_not_a_regular_file");
  assert.equal(result.skipped.find((s) => s.path === "Network/Cookies")?.reason, "cookies_abe_bound_use_cdp");

  // Tabs only reopen when Chromium believes the last exit was dirty.
  const prefs = JSON.parse(readFileSync(join(dest, "Preferences"), "utf8"));
  assert.equal(prefs.profile.exit_type, "Crashed");
  assert.equal(prefs.profile.exited_cleanly, false);
  // Everything else in the document is preserved, not replaced.
  assert.equal(prefs.other, 1);
});

test("without a tab file the Preferences nudge is not applied at all", async () => {
  const staging = tmp("stage-");
  const profileDir = tmp("profile-");
  writeFileSync(join(staging, "History"), "h");
  writeFileSync(join(staging, "Preferences"), JSON.stringify({ profile: { exit_type: "Normal" } }));

  const result = await materializeCloneState({ stagingDir: staging, profileDir, profileName: "Default" });
  assert.equal(result.ok, true);
  assert.equal(result.tabsStaged, false);
  assert.equal(result.restoreNudged, false);
  // Untouched: a nudge with no tabs to restore would be a change for nothing.
  const prefs = JSON.parse(readFileSync(join(profileDir, "Default", "Preferences"), "utf8"));
  assert.equal(prefs.profile.exit_type, "Normal");
});

test("a Preferences that cannot be parsed is left exactly as it came", async () => {
  const staging = tmp("stage-");
  const profileDir = tmp("profile-");
  mkdirSync(join(staging, "Sessions"), { recursive: true });
  writeFileSync(join(staging, "Sessions", "Session_1"), "tabs");
  writeFileSync(join(staging, "Preferences"), "{not json at all");

  const result = await materializeCloneState({ stagingDir: staging, profileDir, profileName: "Default" });
  assert.equal(result.ok, true);
  assert.equal(result.tabsStaged, true);
  // The nudge could not be applied, and that is REPORTED rather than hidden by
  // inventing a Preferences document.
  assert.equal(result.restoreNudged, false);
  assert.equal(readFileSync(join(profileDir, "Default", "Preferences"), "utf8"), "{not json at all");
});

test("a profile name that is not a profile name refuses the whole materialisation", async () => {
  const staging = tmp("stage-");
  const profileDir = tmp("profile-");
  writeFileSync(join(staging, "History"), "h");
  const result = await materializeCloneState({ stagingDir: staging, profileDir, profileName: "../evil" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "state_profile_unknown");
  assert.equal(result.copied, 0);
  assert.equal(existsSync(join(profileDir, "evil")), false);
});

test("an empty staging area is a clean no-op, not an error", async () => {
  const profileDir = tmp("profile-");
  const result = await materializeCloneState({
    stagingDir: join(profileDir, "does-not-exist"),
    profileDir,
    profileName: "Default",
  });
  assert.equal(result.ok, true);
  assert.equal(result.copied, 0);
  assert.equal(result.tabsStaged, false);
  assert.equal(result.restoreNudged, false);
});

