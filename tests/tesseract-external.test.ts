import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// 2026-10-03 — REGRESSION GUARD for the silent Screen-monitoring hang.
//
// THE INCIDENT. For days every frame was stored with `summary` NULL, `ocrText`
// NULL, and `summaryError` set (or NULL), so the owner saw no summary and no
// "Full extraction" transcript toggle. The cause was NOT the AI relay and NOT
// capture: both were verified working standalone on the VPS. It was this —
//
//   tesseract.js spawns its OCR engine in a `worker_threads` Worker whose
//   script path is computed at RUNTIME from `__dirname`
//   (src/worker/node/defaultOptions.js):
//       workerPath: path.join(__dirname, '..', '..', 'worker-script', 'node', 'index.js')
//
//   When Turbopack INLINES the package into the server bundle it freezes
//   `__dirname` at BUILD time to its own virtual root, so the shipped chunk
//   literally contained:
//       workerPath: "/ROOT/node_modules/tesseract.js/src/worker/node"
//
//   `/ROOT` exists on the CI runner but NOT on the VPS. `new Worker("/ROOT/...")`
//   could therefore never start, so `createWorker()` never resolved,
//   `runSummaryPass` never returned, and systemd killed the sweep at its 300s
//   `TimeoutStartSec` on every single tick. Because the summary pass runs AFTER
//   capture in the same request, the kill also discarded the capture pass's work
//   reporting — the failure was invisible in the API response and looked exactly
//   like "summaries haven't happened yet".
//
// THE FIX (verified live): tesseract.js must be in next.config.ts's
// `serverExternalPackages`, which keeps a real runtime `require` so `__dirname`
// resolves to the actual install directory on whatever machine runs it.
//
// WHY THIS TEST IS A FILE-READ AND NOT A RENDER: the whole defect is a
// BUILD-CONFIGURATION property. There is no runtime input that can reproduce it,
// and a mocked OCR stub — which is what every other summary test uses — is
// exactly what hid it. So this asserts on the real next.config.ts source and on
// the real tesseract install, which are the two things that actually have to be
// true.

const require_ = createRequire(import.meta.url);
const repoRoot = dirname(dirname(new URL(import.meta.url).pathname));

test("next.config.ts externalizes tesseract.js so its worker path resolves at runtime", () => {
  const config = readFileSync(join(repoRoot, "next.config.ts"), "utf8");

  // The declaration itself.
  const match = config.match(/serverExternalPackages:\s*\[([^\]]*)\]/);
  assert.ok(match, "next.config.ts must declare serverExternalPackages");

  const listed = match[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);

  assert.ok(
    listed.includes("tesseract.js"),
    `tesseract.js MUST be in serverExternalPackages, or Turbopack inlines it and bakes ` +
      `the build machine's /ROOT path into the OCR worker spawn (the live outage). ` +
      `Currently listed: ${JSON.stringify(listed)}`,
  );

  // The ones that must NEVER be added, because externalizing them breaks the
  // build (server-only resolves to its throwing index.js). Guards against a
  // future "just add everything" sweep.
  for (const forbidden of ["server-only", "jose", "resend"]) {
    assert.ok(
      !listed.includes(forbidden),
      `${forbidden} must NOT be externalized — its real npm entry throws and breaks builds`,
    );
  }
});

test("the tesseract worker script tesseract.js will spawn actually exists on disk", () => {
  // Resolve the package the way Node does at runtime. When tesseract.js is
  // externalized this is a real install; when it is inlined there is no such
  // file at the bundled path, which is the bug.
  const pkgPath = require_.resolve("tesseract.js/package.json");
  const pkgDir = dirname(pkgPath);

  const workerScript = join(pkgDir, "src", "worker-script", "node", "index.js");
  assert.ok(
    existsSync(workerScript),
    `tesseract.js's node worker script must exist on disk at ${workerScript} — ` +
      `if it is missing, createWorker() hangs forever and the whole sweep is killed at 300s`,
  );

  // And the defaultOptions module must point at a path rooted in THIS install,
  // not at an absolute build-machine placeholder like /ROOT.
  const defaultOptions = require_(join(pkgDir, "src", "worker", "node", "defaultOptions.js"));
  const resolvedWorkerPath = defaultOptions.workerPath;

  assert.ok(
    resolvedWorkerPath.startsWith(pkgDir),
    `tesseract's workerPath (${resolvedWorkerPath}) must resolve inside the real install ` +
      `(${pkgDir}); a path outside it means __dirname was frozen at build time (the /ROOT bug)`,
  );
  assert.ok(
    !resolvedWorkerPath.includes("/ROOT/"),
    "workerPath still contains the build-machine placeholder /ROOT — tesseract.js is not externalized",
  );
  assert.ok(
    existsSync(resolvedWorkerPath),
    `the resolved workerPath must exist: ${resolvedWorkerPath}`,
  );
});
