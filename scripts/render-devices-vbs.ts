// TASK_181 P4b — CI-side renderer: turn the freshly built NSIS installer into
// its double-clickable `.vbs` carrier (owner: "the exe in the vbs… so it can
// just follow the same launch flow it does for the agent installer").
//
// Invoked by .github/workflows/build-exe.yml after the tauri build:
//
//   npx tsx scripts/render-devices-vbs.ts src-tauri/target/release/bundle/nsis
//
// Finds the single `*.exe` in the given directory, SHA-256s it, renders
// `<name>.vbs` NEXT TO it, prints measured sizes (the step-36 embed-vs-fallback
// decision input), and refuses to continue if the render fails closed.
// Pure fs + crypto — no server context, safe under plain tsx.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { renderEmbeddedExeVbs } from "../lib/wrapper-carrier";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: tsx scripts/render-devices-vbs.ts <nsis-bundle-dir>");
  process.exit(1);
}

const exes = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".exe"));
if (exes.length !== 1) {
  console.error(`expected exactly one .exe in ${dir}, found ${exes.length}: ${exes.join(", ")}`);
  process.exit(1);
}

const exeName = exes[0];
const exePath = path.join(dir, exeName);
const raw = fs.readFileSync(exePath);
const sha256 = createHash("sha256").update(raw).digest("hex").toUpperCase();
const base64 = raw.toString("base64");

const vbs = renderEmbeddedExeVbs({ exeName, base64, sha256 });
const vbsPath = path.join(dir, exeName.replace(/\.exe$/i, ".vbs"));
fs.writeFileSync(vbsPath, vbs, "utf8");

// Round-trip: the file we just wrote must rejoin to the exact payload
// (the same invariant the unit suite asserts — checked here against the
// REAL artifact, not a fixture).
const rejoined = [...vbs.matchAll(/b64File\.Write "((?:[^"]|"")*)"/g)]
  .map((m) => m[1].replace(/""/g, '"'))
  .join("");
if (rejoined !== base64) {
  console.error("FATAL: rendered VBS payload does not rejoin to the exe base64");
  process.exit(1);
}

const exeMb = (raw.length / (1024 * 1024)).toFixed(1);
const vbsBytes = fs.statSync(vbsPath).size;
const vbsMb = (vbsBytes / (1024 * 1024)).toFixed(1);
console.log(`exe:  ${exeName} (${exeMb} MB) sha256=${sha256}`);
console.log(`vbs:  ${path.basename(vbsPath)} (${vbsMb} MB)`);
console.log(`step36 embed decision input: exe=${raw.length} bytes vbs=${vbsBytes} bytes`);
console.log(`round-trip: OK (payload rejoins byte-exact)`);
