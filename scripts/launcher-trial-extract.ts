// TASK_104 follow-up (2026-09-26) — owner: "the vm is crashing so can't test
// well", asking for the app launcher to be verified without it. Mirrors
// scripts/overlay-trial.ps1's own "test on a throwaway cloud Windows box
// instead of the local VM" pattern (see .github/workflows/overlay-trial.yml).
//
// Extracts the EXACT deployed PowerShell from lib/device-tools.ts's
// buildDiscoverAppsScript / buildLaunchCommand — both exported specifically
// for this (pure functions, zero behaviour change to their real callers,
// discoverApps/launchApp) — via a require hook that stubs only their env/db/
// audit dependencies, the same technique tests/vantra-link-installer.test.ts
// already established for lib/vantra-link.ts. This is never a hand-copy: the
// .ps1 files below are byte-for-byte what a real device receives, so a
// discrepancy between this script and lib/device-tools.ts is structurally
// impossible.
//
// Run: npx tsx scripts/launcher-trial-extract.ts <outDir>

import Module from "node:module";
import fs from "node:fs";
import path from "node:path";

const MODULE_UNDER_TEST = "lib/device-tools.ts";

type Loader = { _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown };
const loader = Module as unknown as Loader;
const original = loader._load;
loader._load = function patched(request, parent, isMain) {
  if (request === "server-only") return {};
  // Normalize backslashes -> forward slashes before the endsWith check: on
  // Windows `parent.filename` is `D:\...\lib\device-tools.ts`, which never
  // matches a forward-slash suffix — caught live on a real windows-latest
  // runner, where the un-normalized check let the REAL lib/env.ts load and
  // throw on a missing APP_BASE_URL instead of getting stubbed.
  const from = (parent?.filename ?? "").replace(/\\/g, "/");
  if (from.endsWith(`/${MODULE_UNDER_TEST}`)) {
    if (request === "./db") return { db: {} };
    if (request === "./env") return { env: { appBaseUrl: "https://spaceworker.test" } };
    if (request === "./admin-settings") return { getAdminSettings: async () => ({}) };
    if (request === "./devices") return { recordAgentActionAudit: async () => {} };
  }
  return original.call(this, request, parent, isMain);
};

/* eslint-disable @typescript-eslint/no-require-imports */
const mod = require(path.join(__dirname, "..", "lib", "device-tools.ts")) as {
  buildDiscoverAppsScript: () => string;
  buildLaunchCommand: (kind: "app" | "path" | "url", resolvedPath: string) => string;
};
/* eslint-enable @typescript-eslint/no-require-imports */

const outDir = process.argv[2] ?? ".";
fs.mkdirSync(outDir, { recursive: true });

fs.writeFileSync(path.join(outDir, "discover-apps.ps1"), mod.buildDiscoverAppsScript(), "utf8");
// notepad.exe is present on every Windows install (including windows-latest
// GitHub runners) — a safe, harmless, always-available launch target.
fs.writeFileSync(
  path.join(outDir, "launch-notepad.ps1"),
  mod.buildLaunchCommand("path", "C:\\Windows\\System32\\notepad.exe"),
  "utf8",
);
// Proves the Test-Path/"not found" failure branch, not just the happy path.
fs.writeFileSync(
  path.join(outDir, "launch-missing.ps1"),
  mod.buildLaunchCommand("path", "C:\\Windows\\System32\\definitely-not-a-real-exe.exe"),
  "utf8",
);
fs.writeFileSync(
  path.join(outDir, "launch-url.ps1"),
  mod.buildLaunchCommand("url", "https://example.com/"),
  "utf8",
);

console.log(`wrote discover-apps.ps1, launch-notepad.ps1, launch-missing.ps1, launch-url.ps1 to ${outDir}`);
