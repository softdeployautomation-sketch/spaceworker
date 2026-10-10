// TASK_195 S1 — QA health battery CLI.
//
// Run on the box (per plan VERIFY §1):
//   sudo -u trmm -H bash -c 'cd /opt/spaceworker && set -a && . ./.env && set +a && npx tsx scripts/qa-battery.ts'
// Locally:  npm run qa-battery            (add --json / --group=platform,access / --origin=url)
//
// READ-ONLY by construction (see lib/qa/battery.ts header). Exit code 0 when
// nothing FAILED (warns/skips are informational), 1 when any probe failed.
// The CLI sources its deps from the real fs / real PrismaClient / real fetch
// via the SHARED adapters in lib/qa/battery.ts (the admin /api/admin/health
// route uses the same ones — TASK_195 S2 — so both run the identical battery).

import {
  QA_GROUPS,
  createFsDeps,
  createQaDb,
  discoverInternalRoutes,
  resolveOwnOrigin,
  runBattery,
  type QaDb,
  type QaDeps,
  type QaGroup,
  type QaReport,
} from "../lib/qa/battery";


// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const wantJson = argv.includes("--json");
const originFlag = argv.find((a) => a.startsWith("--origin="))?.slice("--origin=".length);
const groupFlag = argv.find((a) => a.startsWith("--group="))?.slice("--group=".length);

function selectedGroups(): QaGroup[] | undefined {
  if (!groupFlag) return undefined;
  const asked = groupFlag.split(",").map((s) => s.trim()).filter(Boolean);
  const valid = asked.filter((g): g is QaGroup => (QA_GROUPS as readonly string[]).includes(g));
  const bad = asked.filter((g) => !(QA_GROUPS as readonly string[]).includes(g));
  if (bad.length > 0) {
    process.stderr.write(`unknown group(s): ${bad.join(", ")} — valid: ${QA_GROUPS.join(", ")}\n`);
    process.exit(2);
  }
  return valid;
}

// ---------------------------------------------------------------------------
// Real dependencies — thin wiring over the SHARED adapters (see lib/qa).
// ---------------------------------------------------------------------------

/** Structural QaDb backed by a REAL PrismaClient (lib/prisma is server-only). */
function realDb(): QaDb {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { PrismaClient } = require("@prisma/client") as typeof import("@prisma/client");
  /* eslint-enable @typescript-eslint/no-require-imports */
  // Cast: Prisma's generic $queryRaw overloads don't structurally unify with
  // QaPrismaLike's simple tagged-template signature (TS assignability limit,
  // not a behavioural difference) — the battery only ever calls the four
  // members the interface declares.
  return createQaDb(new PrismaClient() as unknown as Parameters<typeof createQaDb>[0]);
}

// ---------------------------------------------------------------------------
// Origin resolution — QA_ORIGIN → PORT → :3500 → :3000, first to ANSWER wins,
// via the shared resolveOwnOrigin(); the --origin= flag is prepended as extra.
// (The box's .env PORT=3400 disagrees with its true listener :3500 — TASK_194
// S6 fact — so we probe instead of trusting one source.)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const MARK: Record<QaReport["probes"][number]["status"], string> = {
  pass: "PASS",
  warn: "WARN",
  fail: "FAIL",
  skip: "SKIP",
};

function printHuman(report: QaReport): void {
  const line = (s = ""): void => void process.stdout.write(`${s}\n`);
  line();
  line("QA HEALTH BATTERY");
  line(`ran: ${report.ranAt}  origin: ${report.origin}  (${report.durationMs} ms)`);
  line("-".repeat(72));
  let group = "";
  for (const p of report.probes) {
    if (p.group !== group) {
      group = p.group;
      line();
      line(`[${group.toUpperCase()}]`);
    }
    const ms = p.ms !== undefined ? ` (${p.ms} ms)` : "";
    line(`  ${MARK[p.status]}  ${p.label}${p.detail ? ` — ${p.detail}` : ""}${ms}`);
  }
  line();
  line("-".repeat(72));
  const c = report.counts;
  line(`TOTAL: ${report.probes.length} probes — ${c.pass} pass, ${c.warn} warn, ${c.fail} fail, ${c.skip} skip`);
  if (c.fail > 0) line("RESULT: FAIL — fix before trusting this deploy.");
  else if (c.warn > 0) line("RESULT: OK with warnings — read each WARN above.");
  else line("RESULT: ALL GREEN.");
  line();
  line("MANUAL (battery cannot test these — Windows VM needed): agent install,");
  line("wrapper download dialog, invoice→support-badge e2e, VBS silent window.");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const origin = await resolveOwnOrigin(originFlag ? [originFlag.replace(/\/$/, "")] : []);
  const db = realDb();
  const deps: QaDeps = {
    db,
    fetchImpl: fetch,
    env: process.env,
    origin,
    internalRoutes: async () => discoverInternalRoutes(),
    ...createFsDeps(),
  };

  // No explicit $disconnect — main() always process.exit()s (below), which
  // tears the Prisma pool down; an await here would just risk hanging the CLI.
  const report = await runBattery(deps, { groups: selectedGroups() });

  if (wantJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printHuman(report);
  }
  process.exit(report.counts.fail > 0 ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(`qa-battery crashed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(2);
});

