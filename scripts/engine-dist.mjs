#!/usr/bin/env node
/**
 * scripts/engine-dist.mjs — build the Browser Clone device-engine bundle that
 * one-click device setup (TASK_114) downloads.
 *
 *   node scripts/engine-dist.mjs
 *
 * Cross-compiles the three Windows binaries from michael/browser-clone/engine
 * plus the Linux `swfwd` forwarder, copies the installer + MT-1 PowerShell
 * scripts next to them, then writes engine-dist/manifest.json with a SHA-256 +
 * byte count per artifact. The agent verifies every hash before installing, so
 * the manifest is the contract — regenerate it whenever a binary or script
 * changes.
 *
 * WHY A LINUX BINARY IS IN HERE (TASK_119A A4): `swfwd-linux-amd64` is NOT
 * downloaded by any device — it is the CDP forwarder that runs INSIDE a hosted
 * clone's container, so its consumer is browser-server on our own VPS
 * (`SWFWD_BIN`, defaulting to <dist>/swfwd-linux-amd64). It rides this pipeline
 * because that is what makes it versioned, hashed and deployed with everything
 * else rather than hand-copied onto a server. Per-role setup downloads are
 * filtered by name (lib/clone-setup.ts ROLE_ARTIFACTS), so no device ever
 * fetches it.
 *
 * engine-dist/ is deliberately NOT committed (build outputs do not belong in
 * git); it is rsynced to the VPS at deploy time:
 *   rsync -a engine-dist/ root@<vps>:/opt/spaceworker/engine-dist/
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..");
const engineSrc = path.join(repo, "michael", "browser-clone", "engine");
const psSrc = path.join(repo, "michael", "browser-clone");
const out = path.join(repo, "engine-dist");

/** go package -> artifact name (GUI-subsystem builds must stay silent). */
const BINARIES = [
  { pkg: "./cmd/hack-browser-clone", name: "hack-browser-clone.exe", gui: false },
  { pkg: "./cmd/hack-browser-clone", name: "hack-browser-clone-svc.exe", gui: true },
  { pkg: "./cmd/relay", name: "hack-relay.exe", gui: true },
];

/** Plain files copied as-is (installers + the MT-1 capture skin + its libs). */
const SCRIPTS = [
  path.join(engineSrc, "scripts", "install-relay.ps1"),
  path.join(engineSrc, "scripts", "install-hosted.ps1"),
  path.join(psSrc, "Invoke-BrowserClone.ps1"),
  path.join(psSrc, "lib", "CdpCookies.ps1"),
  path.join(psSrc, "lib", "GcmCrypto.ps1"),
  path.join(psSrc, "lib", "ProfilePaths.ps1"),
];

/**
 * Host-side (VPS) binaries. Built for the VPS's own OS/arch, NOT for devices —
 * see the header. Kept static (CGO_ENABLED=0) so it runs in any container base.
 */
const HOST_BINARIES = [
  {
    pkg: "./cmd/swfwd",
    name: "swfwd-linux-amd64",
    goos: "linux",
    goarch: "amd64",
  },
];

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

for (const bin of BINARIES) {
  const ldflags = bin.gui ? "-s -w -H=windowsgui" : "-s -w";
  execFileSync("go", ["build", "-trimpath", `-ldflags=${ldflags}`, "-o", path.join(out, bin.name), bin.pkg], {
    cwd: engineSrc,
    stdio: "inherit",
    env: { ...process.env, GOOS: "windows", GOARCH: "amd64", CGO_ENABLED: "0" },
  });
}

for (const bin of HOST_BINARIES) {
  execFileSync("go", ["build", "-trimpath", "-ldflags=-s -w", "-o", path.join(out, bin.name), bin.pkg], {
    cwd: engineSrc,
    stdio: "inherit",
    env: { ...process.env, GOOS: bin.goos, GOARCH: bin.goarch, CGO_ENABLED: "0" },
  });
}

for (const script of SCRIPTS) {
  if (!fs.existsSync(script)) throw new Error(`missing script: ${script}`);
  fs.copyFileSync(script, path.join(out, path.basename(script)));
}

const files = fs
  .readdirSync(out)
  .filter((name) => name !== "manifest.json" && !name.endsWith(".map"))
  .sort()
  .map((name) => {
    const file = path.join(out, name);
    return { name, sha256: sha256(file), bytes: fs.statSync(file).size };
  });

fs.writeFileSync(
  path.join(out, "manifest.json"),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), files }, null, 2)}\n`,
);

for (const f of files) {
  console.log(`${f.sha256.slice(0, 12)}…  ${String(f.bytes).padStart(9)}  ${f.name}`);
}
console.log(`\n${files.length} artifacts -> ${path.relative(repo, out)}/manifest.json`);
