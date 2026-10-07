// TASK_177 follow-up — mint a single-file Vantra/TacticalRMM agent install
// carrier (.vbs) from OUR RMM dashboard's PowerShell install script.
//
// SEPARATE from the OpenFrame pipeline on purpose (owner directive): the
// openframe mint script and lib stay byte-identical to their Windows-tested
// state; this is its own script against lib/vantra-carrier.ts.
//
// Usage (run from repo root):
//   npx tsx scripts/mint-vantra-carrier.ts \
//     --script <path/to/install.ps1> \
//     [--out out/vantra-agent-carrier.vbs] [--no-elevate]
//
// The input script contains your RMM account's LIVE auth token — keep it
// outside the repo (or in a gitignored path). Output defaults to out/
// (gitignored); a minted carrier embeds the token and MUST NOT be committed.
//
// The rendered .vbs is double-clickable on Windows: one UAC prompt, then the
// script runs hidden (download agent exe → silent install → enroll → cleanup).
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { renderVantraCarrierFromScript } from "../lib/vantra-carrier";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const scriptPath = arg("script");
if (!scriptPath) {
  console.error(
    "error: missing required arg: --script <path/to/install.ps1>\n" +
      "Point it at the PowerShell install script your RMM dashboard hands out " +
      "(the multi-line one that downloads the agent and runs `tacticalrmm.exe -m install …`).",
  );
  process.exit(1);
}
const scriptFile = resolve(scriptPath);
if (!existsSync(scriptFile)) {
  console.error(`error: script not found: ${scriptFile}`);
  process.exit(1);
}

const elevate = !process.argv.includes("--no-elevate");
const out = resolve(arg("out") ?? "out/vantra-agent-carrier.vbs");

let vbs: string;
try {
  vbs = renderVantraCarrierFromScript(readFileSync(scriptFile, "utf8"), { elevate });
} catch (err) {
  console.error(`error: ${(err as Error).message} (in ${scriptFile})`);
  console.error(
    "The script must be one complete statement per line, with no here-strings, " +
      "multi-line string literals, interpolating double quotes, or trailing " +
      "continuation characters. Flatten those by hand and retry.",
  );
  process.exit(1);
}

try {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, vbs, { mode: 0o600 });
  console.log(`minted ${out} (elevate=${elevate})`);
  console.log("copy to the Windows device and double-click; one UAC prompt.");
} catch (err) {
  console.error(`error: ${(err as Error).message}`);
  process.exit(1);
}