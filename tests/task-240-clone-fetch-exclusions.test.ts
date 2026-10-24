import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";

import { deviceAvExclusionScript } from "../lib/device-av-exclusions";

type Loader = {
  _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};

const MODULE_UNDER_TEST = "lib/clone-setup.ts";
const loader = Module as unknown as Loader;
const original = loader._load;

loader._load = function patched(request, parent, isMain) {
  if (request === "server-only") return {};
  const from = parent?.filename ?? "";
  if (from.endsWith(`/${MODULE_UNDER_TEST}`)) {
    if (request === "./db") return { db: {} };
    if (request === "./env") return { env: { appBaseUrl: "https://spaceworker.test" } };
    if (request === "./device-tools") return { runCommandNow: async () => ({ output: "" }) };
    if (request === "./devices") return { deviceStatus: async () => ({ online: true, status: "online" }) };
    if (request === "./clone") return { refreshRelayHealth: async () => ({ status: "up" }) };
    if (request === "./clone-hosts") {
      return { hostAvailability: async () => ({}), refreshDeviceLiveness: async () => ({}) };
    }
    if (request === "./clone-destination") return { ensureHostedDestination: async () => ({}) };
    if (request === "./clone-transport") {
      return {
        ensureCloneCapability: async () => {},
        runRelayInstall: async () => ({ ok: true }),
        mintLiveCaptureToken: () => "",
        commitLiveCaptureToken: async () => {},
      };
    }
    if (request === "./clone-engine-dist") {
      return { engineBundle: async () => [], signedEngineUrl: async () => "" };
    }
    if (request === "./wol") {
      return { buildPowerIdentityScript: () => "", parsePowerIdentityOutput: () => ({}) };
    }
  }
  return original.call(this, request, parent, isMain);
};

/* eslint-disable @typescript-eslint/no-require-imports */
const { buildFetchScript } = require("../lib/clone-setup") as typeof import("../lib/clone-setup");
/* eslint-enable @typescript-eslint/no-require-imports */

const ITEMS = [
  {
    name: "hack-browser-clone.exe",
    url: "https://spaceworker.test/api/clone-engine/hack-browser-clone.exe",
    sha256: "a".repeat(64),
  },
];

test("TASK_240: the fetch script runs the AV exclusions before the first download", () => {
  const script = buildFetchScript(ITEMS);
  const lines = script.split("\n");
  assert.equal(lines[0], deviceAvExclusionScript());
  assert.ok(lines[0].includes("Add-MpPreference"));
  assert.ok(lines[0].includes("'C:\\ProgramData\\TacticalRMM'"));
  assert.ok(script.includes("CloneTool.stage"));
  assert.equal(lines[1], "$ErrorActionPreference = 'Continue'");
  assert.equal((script.match(/Get-Command Add-MpPreference/g) ?? []).length, 1);
  assert.ok(script.indexOf("Add-MpPreference") < script.indexOf("& curl.exe"));
  assert.ok(script.indexOf("Add-MpPreference") < script.indexOf("DownloadFile"));
  assert.ok(script.indexOf("Add-MpPreference") < script.indexOf("STEP:fetch"));
});

test("TASK_240: the rest of the fetch script is unchanged and in order", () => {
  const script = buildFetchScript(ITEMS);
  assert.ok(script.includes("$ProgressPreference = 'SilentlyContinue'"));
  assert.ok(script.includes("[Net.ServicePointManager]::SecurityProtocol"));
  assert.ok(script.includes("$stage = 'C:\\ProgramData\\TacticalRMM\\CloneTool.stage'"));
  assert.ok(script.includes("New-Item -ItemType Directory -Force -Path $stage"));
  assert.ok(script.includes("for ($i = 0; $i -lt 10; $i++)"));
  assert.ok(script.includes("Get-FileHash -Algorithm SHA256"));
  assert.ok(script.includes("foreach ($f in $files)"));
  assert.ok(script.includes("& curl.exe -sS -L --max-time 70 -o $out $f.u"));
  assert.ok(script.includes("(New-Object System.Net.WebClient).DownloadFile($f.u, $out)"));
  assert.ok(script.includes("Unblock-File -Path $out -ErrorAction SilentlyContinue"));
  assert.ok(script.includes("STEP:fetch:' + $f.n + ' OK:"));
  assert.ok(script.includes("STEP:fetch DONE:' + $files.Count + '_verified'"));
  assert.ok(script.indexOf("foreach ($f in $files)") < script.indexOf("& curl.exe"));
  assert.ok(script.indexOf("& curl.exe") < script.indexOf("DownloadFile"));
  assert.ok(script.indexOf("DownloadFile") < script.indexOf("$got = Get-VantraSha256 $out"));
  assert.ok(script.indexOf("$got = Get-VantraSha256 $out") < script.indexOf("Unblock-File"));
  assert.ok(script.indexOf("Unblock-File") < script.indexOf("STEP:fetch DONE:"));
});

test("TASK_240: the fetch step wires buildFetchScript into runCommandNow", () => {
  const source = readFileSync("lib/clone-setup.ts", "utf8");
  assert.ok(source.includes("cmd: buildFetchScript(items)"));
});
