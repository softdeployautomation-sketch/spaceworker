// TASK_177 — mint a single-file OpenFrame install carrier (.vbs) for ONE
// device. Values come from argv only — NEVER hardcoded, never committed.
//
// Usage (run from repo root):
//   npx tsx scripts/mint-openframe-carrier.ts \
//     --serverUrl <dashboard-host> \
//     --machineId <uuid-from-openframe-dashboard> \
//     --initialKey <key> --orgId <uuid> --userId <uuid> \
//     [--out out/openframe-carrier.vbs] [--no-elevate]
//
// Output defaults to out/ (gitignored) — a minted carrier contains the live
// initialKey/orgId/userId/machine-id and MUST NOT be committed (TASK_177
// hygiene rule: those values are per-customer secrets).
//
// The rendered .vbs is double-clickable on Windows: it UAC-elevates once,
// runs the dashboard install command hidden, the OpenFrame agent service
// comes up, device appears in the OpenFrame dashboard. Run it from an admin
// session or accept the single UAC prompt.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  renderOpenFrameInstallCommand,
  renderCarrierVbs,
} from "../lib/openframe-carrier";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const required = ["serverUrl", "machineId", "initialKey", "orgId", "userId"] as const;
const values = {
  serverUrl: arg("serverUrl"),
  machineId: arg("machineId"),
  initialKey: arg("initialKey"),
  orgId: arg("orgId"),
  userId: arg("userId"),
};

const missing = required.filter((k) => !values[k]);
if (missing.length > 0) {
  console.error(
    `error: missing required args: ${missing.map((k) => `--${k}`).join(" ")}\n` +
      "Values come from the OpenFrame dashboard's installation-script panel. " +
      "Do not paste them into any committed file.",
  );
  process.exit(1);
}

const elevate = !process.argv.includes("--no-elevate");
const out = resolve(arg("out") ?? "out/openframe-carrier.vbs");

try {
  const command = renderOpenFrameInstallCommand(values as never);
  const vbs = renderCarrierVbs(command, { elevate });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, vbs, { mode: 0o600 });
  console.log(`minted ${out} (elevate=${elevate})`);
  console.log("copy to the Windows device and double-click; one UAC prompt.");
} catch (err) {
  console.error(`error: ${(err as Error).message}`);
  process.exit(1);
}
