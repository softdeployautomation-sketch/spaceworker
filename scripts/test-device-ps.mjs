#!/usr/bin/env node
// Device-side PowerShell test runner.
//
// WHY THIS EXISTS
//
// The device half of browser clone is PowerShell (lib/ProfilePaths.ps1,
// lib/CdpCookies.ps1, engine/extension/background.js via a Node driver), and none of
// it is reachable from the JS suites. Those suites were run by hand, on Windows, and
// that is exactly how a real bug survived in them: the CAPTURE branch's cookie gate
// read `@('chrome','edge')` while the RESTORE branch read `@('chrome','edge','brave')`,
// so a Brave clone carried its history, bookmarks and tabs, skipped its session, and
// still exited 0 — a clean-looking clone with no logins. Nothing reported it because
// nothing ran these files.
//
// TWO THINGS MAKE THAT POSSIBLE TO RUN IN CI, and both are load-bearing:
//
//   1. A job key. Without `SPACEWORKER_CLONE_KEY`, the suites fall back to DPAPI
//      (`ProtectedData.Protect`) for sealing, which throws "Operation is not supported
//      on this platform" off Windows — so the suite could not run on CI's ubuntu
//      runner AT ALL and was quietly absent. Supplying a random key per run puts them
//      on the AES-256-GCM path, which is platform-independent. The DPAPI path itself
//      is still the device's real default and is exercised on Windows only; this
//      runner does not pretend otherwise (it says so below).
//
//   2. A minimum check count. One of these harnesses once could not fail: a bare
//      `$failures += $Name` inside a function assigned a NEW local, so the suite
//      printed FAIL lines and then "ALL PASSED" and exited 0. A suite that reports
//      green while asserting nothing is worse than no suite, so a run that passes but
//      executed too few checks is treated as a failure here.
//
// Run by `npm run test:ps`.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cloneRoot = join(root, "michael", "browser-clone");

/**
 * The suites, and what "it really ran" means for each.
 *
 * `minChecks` is deliberately close to the real count rather than token: a suite that
 * silently returns early (a missing module, an early `exit`) produces a small number
 * and must not read as a pass.
 */
const SUITES = [
  {
    name: "roundtrip",
    file: join("tests", "Test-Roundtrip.ps1"),
    args: ["-WithKey"], // pair of the key below; without it the DPAPI path is taken
    successMarker: "ALL PASSED",
    countRe: /^PASS /gm,
    minChecks: 30,
  },
  {
    name: "silent-trigger",
    file: join("tests", "Test-SilentTrigger.ps1"),
    args: [],
    successMarker: "RESULT: PASSED",
    countRe: /checks=(\d+)/,
    minChecks: 30,
  },
  {
    // Builds the REAL native host (cmd/native-host) and loads the REAL service worker,
    // so this needs a Go toolchain. It asserts the chunked-message contract, the 1 MiB
    // framing cap, and that no cookie VALUE reaches any log or non-0600 file.
    name: "cookie-capture",
    file: join("tests", "Test-CookieCapture.ps1"),
    args: [],
    successMarker: "ALL PASSED",
    countRe: /^PASS /gm,
    minChecks: 25,
  },
];

function findPwsh() {
  for (const candidate of ["pwsh", "powershell"]) {
    const probe = spawnSync(candidate, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
      encoding: "utf8",
    });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

// Resolved before anything else runs. A missing PowerShell is a FAILURE, not a skip:
// the device half is PowerShell, so "green" without it would mean nothing was checked.
const pwsh = findPwsh();
if (!pwsh) {
  console.log("[test-device-ps] FAIL: no PowerShell found (tried pwsh, powershell).");
  console.log("[test-device-ps] The device half of browser clone is PowerShell; without it NOTHING");
  console.log("[test-device-ps] in lib/ProfilePaths.ps1 or lib/CdpCookies.ps1 is verified.");
  console.log("[test-device-ps] Ubuntu CI runners ship pwsh; install it locally instead of skipping.");
  process.exit(1);
}
console.log(`[test-device-ps] using ${pwsh}`);

// A fresh key per run. It never leaves this process: the suites accept it through the
// environment so no key is written to disk, and the archives they build live in a temp
// dir the suites clean up themselves.
const jobKey = randomBytes(32).toString("base64");

let failures = 0;

for (const suite of SUITES) {
  console.log(`\n=== ${suite.name} ===`);
  const run = spawnSync(pwsh, ["-NoProfile", "-File", suite.file, ...suite.args], {
    cwd: cloneRoot,
    env: { ...process.env, SPACEWORKER_CLONE_KEY: jobKey },
    encoding: "utf8",
    timeout: 600_000,
  });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  process.stdout.write(output);

  if (run.error) {
    console.log(`[test-device-ps] FAIL: could not run ${suite.file}: ${run.error.message}`);
    failures += 1;
    continue;
  }

  // PowerShell exits 2 when an assertion failed (the suites' own contract). The marker
  // and the count are checked too, so a suite killed mid-run cannot pass by exiting 0
  // before reaching its assertions.
  const failMatches = output.match(/^FAIL /gm);
  const failed = failMatches ? failMatches.length : 0;
  const checks = suite.countRe.global
    ? (output.match(suite.countRe) ?? []).length
    : Number(suite.countRe.exec(output)?.[1] ?? "0");
  console.log(`[test-device-ps] ${suite.name}: exit=${run.status} checks=${checks} failed=${failed}`);

  if (run.status !== 0) {
    console.log(`[test-device-ps] FAIL: ${suite.name} exited ${run.status}`);
    failures += 1;
  }
  if (failed > 0) {
    console.log(`[test-device-ps] FAIL: ${suite.name} reported ${failed} failing check(s)`);
    failures += 1;
  }
  if (!output.includes(suite.successMarker)) {
    console.log(`[test-device-ps] FAIL: ${suite.name} never printed "${suite.successMarker}"`);
    failures += 1;
  }
  if (checks < suite.minChecks) {
    console.log(
      `[test-device-ps] FAIL: ${suite.name} ran only ${checks} check(s); expected at least ` +
        `${suite.minChecks}. A suite that asserts too little must not read as green.`,
    );
    failures += 1;
  }
}

// A statement, not a failure: DPAPI sealing is the device's real default and it cannot
// run off Windows, so this run proves the profile logic and the GCM path — not the
// DPAPI fallback. Saying so out loud keeps "green here" from being read as "green on
// the device".
if (process.platform !== "win32") {
  console.log("\n[test-device-ps] note: DPAPI sealing is Windows-only and was NOT exercised in this run");
}

if (failures > 0) {
  console.log(`\n[test-device-ps] FAILED (${failures} problem${failures === 1 ? "" : "s"})`);
  process.exit(1);
}
console.log("\n[test-device-ps] PASSED");
