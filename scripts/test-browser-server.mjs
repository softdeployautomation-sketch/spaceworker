#!/usr/bin/env node
// Browser-server test runner.
//
// Why this exists instead of a plain `tsx --test <files>`:
//
// The relay-ingress suite contains five integration tests that exercise the REAL
// relay client (cmd/relay) — the dial-out egress path a hosted clone's traffic
// rides on. They skip themselves when RELAY_BIN is unset, which is the right
// behaviour for a developer without a Go toolchain, but it means a plain test run
// can go green while the egress path was never actually tested. This runner builds
// the relay and passes it in, and then FAILS if anything was skipped for that
// reason — so "green" genuinely means the egress path was exercised.
//
// If Go is unavailable, the runner says so loudly and still runs the suite rather
// than pretending the skip did not happen.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const engineDir = join(root, "michael", "browser-clone", "engine");

const SUITES = [
  { name: "relay-ingress", file: "browser-server/relay-ingress.test.ts", needsRelay: true },
  { name: "chromium-session-config", file: "browser-server/chromium-session-config.test.ts", needsRelay: false },
  // TASK_135 — the pinned-build cache. It downloads nothing in the test (the
  // fetch is injected) but it does run the REAL extractor chain against a real
  // zip, so a broken extraction or a leaked temp dir fails here rather than on
  // the VPS mid-launch.
  { name: "pinned-chromium", file: "browser-server/pinned-chromium.test.ts", needsRelay: false },
];

function buildRelay(dir) {
  const out = join(dir, "relay");
  const built = spawnSync("go", ["build", "-o", out, "./cmd/relay"], {
    cwd: engineDir,
    encoding: "utf8",
  });
  if (built.error || built.status !== 0) {
    return { ok: false, reason: (built.stderr || built.error?.message || "go build failed").trim() };
  }
  return existsSync(out) ? { ok: true, path: out } : { ok: false, reason: "relay binary not produced" };
}

const tmp = mkdtempSync(join(tmpdir(), "sw-browser-test-"));
let failures = 0;

try {
  const relay = buildRelay(tmp);
  if (!relay.ok) {
    console.log(`[test-browser] relay NOT built (${relay.reason})`);
    console.log("[test-browser] relay integration tests will SKIP; egress is NOT verified in this run");
  } else {
    console.log(`[test-browser] relay built: ${relay.path}`);
  }

  for (const suite of SUITES) {
    const env = { ...process.env };
    if (suite.needsRelay) {
      if (relay.ok) env.RELAY_BIN = relay.path;
      else delete env.RELAY_BIN;
    }

    console.log(`\n=== ${suite.name} ===`);
    const run = spawnSync("npx", ["tsx", "--test", suite.file], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    process.stdout.write(output);

    const skipped = Number(/^# skipped (\d+)/m.exec(output)?.[1] ?? "0");
    const failed = Number(/^# fail (\d+)/m.exec(output)?.[1] ?? "0");
    if (failed > 0) failures += 1;

    // A skip in the relay suite means the egress proof did not run.
    if (suite.needsRelay && skipped > 0) {
      console.log(`[test-browser] FAIL: ${skipped} relay test(s) skipped — the egress path was not verified`);
      failures += 1;
    }
    if (run.error) {
      console.log(`[test-browser] FAIL: could not run ${suite.file}: ${run.error.message}`);
      failures += 1;
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\n[test-browser] FAILED (${failures} problem${failures === 1 ? "" : "s"})`);
  process.exit(1);
}
console.log("\n[test-browser] PASSED");
