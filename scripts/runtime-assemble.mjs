#!/usr/bin/env node
// SpaceWorker OS — Task 27 Part A: assemble the EXE's bundled local runtime.
//
// After `next build` (with next.config.ts output:"standalone"), Next emits a
// self-contained `.next/standalone/` tree: a `server.js` plus the minimal
// node_modules + `.next/server` it needs to run `next start` with NO separate
// dev server. This script copies that tree into `exe/runtime/`, fills in the
// parts Next deliberately leaves out (`.next/static`, `public/`), embeds the
// local-EXE environment (SPACEWORKER_LOCAL_EXE=true, EXE_LICENSE_SECRET, the
// extractor build target), and provisions a real Node runtime binary beside it
// so the packaged EXE runs on an end-user machine that has no Node installed.
//
// The Tauri shell spawns `exe/runtime/node` with `server.js`'s dir as cwd and
// then points the window at http://127.0.0.1:<port>/dashboard/extract.
//
// Target platform: defaults to the HOST (so a local Mac build produces a Mac
// runtime + Mac .app, and the Windows CI runner produces a Windows runtime +
// .exe). Override with EXE_TARGET_OS / EXE_TARGET_ARCH when cross-building.

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NODE_DIST_VERSION = process.env.EXE_NODE_VERSION ?? "20.19.6";
const NODE_MIRROR = (process.env.EXE_NODE_MIRROR ?? "https://nodejs.org/dist").replace(/\/+$/, "");

// fileURLToPath (not `new URL(...).pathname`) so ROOT resolves correctly on
// Windows CI (URL.pathname yields a `/D:/…` root-relative path there).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STANDALONE_OUT = path.join(ROOT, ".next", "standalone");
const RUNTIME_DIR = path.join(ROOT, "exe", "runtime");
const RUNTIME_STANDALONE = path.join(RUNTIME_DIR, "standalone");

const targetOs = process.env.EXE_TARGET_OS ?? process.platform; // win32 | darwin | linux
const targetArch = process.env.EXE_TARGET_ARCH ?? process.arch; // x64 | arm64

// ── 1. Source validation ─────────────────────────────────────────────────────
if (!existsSync(path.join(STANDALONE_OUT, "server.js"))) {
  console.error(
    "[runtime-assemble] Missing .next/standalone/server.js — run `next build` with output:\"standalone\" first.",
  );
  process.exit(1);
}

function loadRepoEnv(key) {
  const p = path.join(ROOT, ".env");
  if (!existsSync(p)) return "";
  for (const raw of readFileSync(p, "utf8").split("\n")) {
    const line = raw.trim();
    if (line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim();
  }
  return "";
}

const exeLicenseSecret = process.env.EXE_LICENSE_SECRET || loadRepoEnv("EXE_LICENSE_SECRET");
if (!exeLicenseSecret) {
  console.error("[runtime-assemble] EXE_LICENSE_SECRET is not set in repo .env — fail-closed (cannot build a licensable EXE).");
  process.exit(1);
}

// ── 2. Rebuild a fresh runtime dir ───────────────────────────────────────────
rmSync(RUNTIME_DIR, { recursive: true, force: true });
mkdirSync(RUNTIME_STANDALONE, { recursive: true });

cpSync(STANDALONE_OUT, RUNTIME_STANDALONE, { recursive: true });

// Next standalone omits these two — copy them in (Next docs: required for a
// correctly-served build).
const staticSrc = path.join(ROOT, ".next", "static");
if (existsSync(staticSrc)) {
  cpSync(staticSrc, path.join(RUNTIME_STANDALONE, ".next", "static"), { recursive: true });
}
const publicSrc = path.join(ROOT, "public");
if (existsSync(publicSrc)) {
  cpSync(publicSrc, path.join(RUNTIME_STANDALONE, "public"), { recursive: true });
}

// ── 3. Embed the local-EXE environment ───────────────────────────────────────
// Next copies the repo .env into .next/standalone, which would ship server-only
// pooled secrets (DATABASE_URL, RESEND_API_KEY, CHANNELRY_AI_API_KEY, ADMIN_TOKEN
// ...) inside a distributable EXE — explicitly what Part A forbids. Scrub it to
// ONLY the minimal local-EXE env. SPACEWORKER_LOCAL_EXE is only ever true for the
// Tauri-bundled runtime (see lib/exe-runtime.ts); EXE_LICENSE_SECRET is embedded
// so the EXE is licensable with zero external secrets; BUILD_TARGET gates which
// routes/nav compile in. .env.local outranks .env so nothing flips these off.
rmSync(path.join(RUNTIME_STANDALONE, ".env"), { force: true });
rmSync(path.join(RUNTIME_STANDALONE, ".env.local"), { force: true });
const localEnvPath = path.join(RUNTIME_STANDALONE, ".env.local");
const envLines = [
  "SPACEWORKER_LOCAL_EXE=true",
  `BUILD_TARGET=${process.env.BUILD_TARGET ?? "extractor"}`,
  `EXE_LICENSE_SECRET=${exeLicenseSecret}`,
  "NEXT_TELEMETRY_DISABLED=1",
];
writeFileSync(localEnvPath, envLines.join("\n") + "\n", "utf8");
// ── 4. Provision the bundled Node runtime ────────────────────────────────────
// A real Node binary so the EXE needs nothing running on the host machine. It is
// renamed to a deterministic path the Tauri shell resolves via
// std::env::consts::EXE_SUFFIX: `node` (mac/linux) or `node.exe` (windows).
//
// EXE_NODE_BIN: use an already-present Node binary directly (skip the download) —
// handy for local smoke builds when nodejs.org is slow. EXE_NODE_MIRROR: alternate
// dist base (CI has fast access to nodejs.org; local builds can point at a mirror).
const nodeExeTarget = path.join(RUNTIME_DIR, `node${targetOs === "win32" ? ".exe" : ""}`);
if (existsSync(nodeExeTarget)) rmSync(nodeExeTarget);

let nodeBinPath;
let nodeDistRoot;
if (process.env.EXE_NODE_BIN) {
  nodeBinPath = process.env.EXE_NODE_BIN;
  console.log(`[runtime-assemble] using provided Node binary at ${nodeBinPath}`);
} else {
  const dist = nodeDistUrl(targetOs, targetArch, NODE_DIST_VERSION);
  nodeDistRoot = await downloadAndExtractNode(dist, targetOs);
  nodeBinPath = findNodeBinary(nodeDistRoot, targetOs);
  if (!nodeBinPath) {
    console.error(`[runtime-assemble] could not locate the node binary extracted from ${dist}`);
    process.exit(1);
  }
}
mkdirSync(RUNTIME_DIR, { recursive: true });

// Windows node.exe is NOT self-contained: it needs node.dll, vcruntime140*.dll,
// icudt.dat, etc. in the SAME directory to run. Bundle the whole dist dir there
// (node.exe finds them next to itself); macOS/Linux ship a monolithic binary, so
// a single file copy is enough there.
if (targetOs === "win32" && nodeDistRoot) {
  cpSync(nodeDistRoot, RUNTIME_DIR, { recursive: true });
} else {
  cpSync(nodeBinPath, nodeExeTarget);
}

// Functional guard: execute the bundled Node. Windows node.exe silently fails
// (0xC0000135) if its sibling node.dll/vcruntime/icu files are missing, so this
// proves the multi-file bundle is complete BEFORE the installer is ever cut.
// Fails the whole build on any platform where the packaged node can't run.
const verifyExe = path.join(RUNTIME_DIR, `node${targetOs === "win32" ? ".exe" : ""}`);
const probe = spawnSync(verifyExe, ["--version"], { encoding: "utf8", timeout: 30_000 });
if (probe.status !== 0) {
  console.error(
    `[runtime-assemble] bundled Node failed to execute (${verifyExe}):`,
    (probe.stderr || "").trim() || (probe.error && probe.error.message),
  );
  process.exit(1);
}
console.log(`[runtime-assemble] bundled Node executes OK: ${(probe.stdout || "").trim()}`);

writeFileSync(
  path.join(RUNTIME_DIR, "RUNTIME.json"),
  JSON.stringify(
    {
      assembledAt: new Date().toISOString(),
      os: targetOs,
      arch: targetArch,
      nodeVersion: NODE_DIST_VERSION,
      buildTarget: process.env.BUILD_TARGET ?? "extractor",
    },
    null,
    2,
  ) + "\n",
  "utf8",
);

console.log(
  `[runtime-assemble] bundled runtime ready at ${RUNTIME_DIR} (os=${targetOs}, arch=${targetArch}, node=${NODE_DIST_VERSION})`,
);

// ── helpers ──────────────────────────────────────────────────────────────────

function nodeDistUrl(os, arch, version) {
  const base = `${NODE_MIRROR}/v${version}`;
  if (os === "win32") {
    if (arch === "arm64") return `${base}/node-v${version}-win-arm64.zip`;
    return `${base}/node-v${version}-win-x64.zip`;
  }
  if (os === "darwin") {
    if (arch === "arm64") return `${base}/node-v${version}-darwin-arm64.tar.gz`;
    return `${base}/node-v${version}-darwin-x64.tar.gz`;
  }
  if (arch === "arm64") return `${base}/node-v${version}-linux-arm64.tar.gz`;
  return `${base}/node-v${version}-linux-x64.tar.gz`;
}

/**
 * Downloads the official Node distribution and returns the extracted dist ROOT
 * dir (on Windows this contains node.exe + node.dll + vcruntime/icu files that
 * must be bundled together; on macOS/Linux it contains bin/node). curl is present
 * on macOS, Linux and Windows CI; tar handles both .zip (bsdtar) and .tar.gz.
 */
async function downloadAndExtractNode(dist, os) {
  const work = mkdtempSync(path.join(tmpdir(), "sw-node-dist-"));
  const archive = path.join(work, path.basename(dist));
  console.log(`[runtime-assemble] downloading Node ${NODE_DIST_VERSION} for ${os} …`);
  execFileSync("curl", ["-fsSL", "-o", archive, dist], { stdio: "inherit" });
  // .tar.gz needs -z; .zip is auto-detectable by bsdtar (Windows CI) — passing -z on
  // a zip makes bsdtar/tar complain, so only add it for real gzip archives.
  const flags = archive.endsWith(".zip") ? ["-xf"] : ["-xzf"];
  execFileSync("tar", [...flags, archive, "-C", work], { stdio: "inherit" });

  const rootName =
    os === "win32"
      ? `node-v${NODE_DIST_VERSION}-win-${targetArch}`
      : `node-v${NODE_DIST_VERSION}-${os}-${targetArch}`;
  const root = path.join(work, rootName);
  if (existsSync(root)) return root;

  // Fallback: the archive may not lay out exactly as expected — find the dir
  // containing the node binary. Return the parent of bin/ (dist root) so the
  // monolith-vs-split logic in the caller still works on every platform.
  const bin = findNodeBinary(work, os);
  if (bin) {
    const rootDir = os === "win32" ? path.dirname(bin) : path.dirname(path.dirname(bin));
    return rootDir;
  }
  console.error(`[runtime-assemble] could not locate the node binary extracted from ${dist}`);
  process.exit(1);
}

function findNodeBinary(dir, os) {
  const want = os === "win32" ? "node.exe" : "node";
  let best = null;
  for (const f of listFiles(dir)) {
    if (path.basename(f) !== want) continue;
    if (os !== "win32" && path.basename(path.dirname(f)) !== "bin") continue;
    best = f;
    break;
  }
  return best;
}

function listFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, acc);
    else acc.push(full);
  }
  return acc;
}