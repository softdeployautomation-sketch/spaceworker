#!/usr/bin/env node
// Migration-chain repair for a database that has to replay the history from empty.
//
// WHY THIS EXISTS
//
// `prisma migrate deploy` applies migrations in directory-name order, and five committed
// migrations touch an object that a LATER migration creates (the fifth is a cascade off the
// fourth — it opens with `DROP INDEX "Device_liveCaptureTokenHash_key"`, the very index the
// fourth would have created). On an empty database deploy therefore stops partway and never
// reaches the TASK_135 clone-state migrations.
//
// The obvious repair — mark the five `prisma migrate resolve --applied` and move on — is
// WRONG, and dangerously so. Measured 2026-09-30 on PostgreSQL 16, from empty: baselining all
// five does let `deploy` finish, and `migrate status` then reports "Database schema is up to
// date!", while the database is missing EVERYTHING those five migrations contained — the
// `DeviceQueuedCommand` and `DevicePinRequest` tables, `CloneJob.sessionMode`, five
// `HostedBrowserSession` columns, `Device.liveCaptureTokenHash`, four `VantraLink` columns and
// three `ExeLicense` columns — because their DDL exists nowhere else. No error is raised at any
// point; the failures arrive later, one request at a time, on columns that "should" exist.
//
// So this script does the two halves that are actually required:
//
//   1. Baseline ONLY the five known mis-ordered migrations. Anything else that fails is a real
//      problem and aborts the run — a script that silently baselines whatever it trips over
//      would recreate the exact failure above on a migration nobody had diagnosed yet.
//   2. Apply the DDL the baselined migrations would have contributed, taken from
//      `prisma migrate diff` rather than typed out, and then ASSERT that the drift is empty.
//      A run that cannot reach "No difference detected" exits non-zero; it never reports
//      success on a schema it has not verified.
//
// Safe to run against an already-correct database (it is a no-op) and against production
// (nothing here runs automatically — it is not itself a migration).
//
// Usage:  DATABASE_URL=postgresql://... node scripts/repair-migration-chain.mjs [--dry-run]

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const SCHEMA = join(root, "prisma", "schema.prisma");
const DRY_RUN = process.argv.includes("--dry-run");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required (this script writes to the database).");
  process.exit(1);
}

/**
 * The five migrations that cannot apply in directory-name order on an empty database.
 *
 * `needs` is carried so the failure message says what the migration was waiting for instead of
 * only that it failed — the difference between a 30-second diagnosis and an afternoon.
 */
const MISORDERED = {
  "20260914150000_add_license_claim_token": "ExeLicense (created by 20260914200000)",
  "20260921000000_device_tools_v2": "Device (created by 20260922000000)",
  "20260922120000_console_followups": "VantraLink (created by 20260923000000)",
  "20260925000000_task119_live_session_streaming": "CloneJob (created by 20261002000000)",
  "20261005000001_device_livecapturetoken_index_repair":
    "Device_liveCaptureTokenHash_key (index dropped/recreated above)",
};

const MISORDERED_COUNT = Object.keys(MISORDERED).length;

/** Runs a prisma CLI command and returns its combined output. */
function prisma(...args) {
  const r = spawnSync("npx", ["prisma", ...args], { cwd: root, env: process.env, encoding: "utf8" });
  return ((r.stdout ?? "") + (r.stderr ?? "")).trim();
}

const DEPLOY_CLEAN =
  /No pending migrations|successfully been applied|All migrations have been successfully applied/i;

/**
 * Pulls the failing migration's name out of either Prisma error shape.
 *
 * Two shapes exist and both matter: P3018 (a migration fails as it is applied) says
 * `Migration name: X`; P3009 (a migration is already recorded as failed by an earlier run)
 * says ``The `X` migration started at ... failed``. Handling only one of them makes the script
 * stall on its own second step.
 */
function failingMigration(out) {
  const m =
    out.match(/Migration name:\s*(\S+)/) ?? out.match(/The\s+`([^`]+)`\s+migration started/);
  return m?.[1] ?? null;
}

console.log(`repair-migration-chain${DRY_RUN ? " (dry run — no changes)" : ""}`);
console.log(`schema: ${SCHEMA}\n`);

// 1. Baseline the known mis-ordered migrations, one deploy at a time, so each failure is
//    attributable to a specific migration rather than inferred from a partial log.
const baselined = [];
for (let attempt = 1; attempt <= MISORDERED_COUNT + 3; attempt++) {
  const out = prisma("migrate", "deploy");
  if (DEPLOY_CLEAN.test(out)) {
    console.log(`deploy: clean after ${baselined.length} baseline(s)`);
    break;
  }

  const name = failingMigration(out);
  if (!name) {
    console.error("\ndeploy failed for a reason this script does not recognise. Output:\n");
    console.error(out);
    process.exit(1);
  }

  if (!(name in MISORDERED)) {
    console.error(`\nREFUSING to baseline \`${name}\`.`);
    console.error(
      "It is not one of the five mis-ordered migrations, so its failure is a real problem —\n" +
        "baselining it would drop whatever DDL it contains, silently, which is the exact bug\n" +
        "this script exists to avoid. Diagnose it, then add it here only if it genuinely is\n" +
        "an ordering fault.",
    );
    process.exit(1);
  }

  console.log(`  baselining ${name}\n    was waiting for: ${MISORDERED[name]}`);
  if (DRY_RUN) {
    console.log(
      "\ndry run: this migration is the next blocker. The ones behind it are only\n" +
        "discoverable by actually passing this one — `migrate deploy` stops at the first\n" +
        "failure — so a dry run reports the first rather than guessing at the rest.",
    );
    process.exit(0);
  }
  {
    const res = prisma("migrate", "resolve", "--applied", name);
    // Prisma prints "Migration <name> marked as applied." — matched on that exact wording
    // rather than a guess, after a first version of this script aborted on its own success.
    if (!/marked as applied|already recorded as applied/i.test(res)) {
      console.error(`\nresolve --applied ${name} did not confirm. Output:\n${res}`);
      process.exit(1);
    }
  }
  baselined.push(name);
}

// 2. Take the remaining drift from `migrate diff` and apply it. Baselining cleared the blocker;
//    this is what actually puts the missing objects into the database.
const driftSql = prisma(
  "migrate",
  "diff",
  "--from-url",
  url,
  "--to-schema-datamodel",
  SCHEMA,
  "--script",
);
if (driftSql === "") {
  console.error("\n`migrate diff --script` produced no output at all — aborting rather than");
  console.error("treating an unrecognised result as the empty string.");
  process.exit(1);
}

// On a database that already matches, `migrate diff --script` does NOT return the empty
// string: it returns the placeholder `-- This is an empty migration.` (observed 2026-09-30).
// Checked explicitly rather than by a truthiness test, so a clean run says "none" instead of
// writing a comment-only .sql file and asking Postgres to execute it — which succeeds, and is
// therefore a silent no-op that reads like a real repair in the log.
const NO_DRIFT = /^\s*(--\s*This is an empty migration\.)?\s*$/;

if (NO_DRIFT.test(driftSql)) {
  console.log("drift: none (the database already matches schema.prisma)");
} else {
  const file = join(tmpdir(), "spaceworker-migration-chain-catchup.sql");
  writeFileSync(file, driftSql);
  const statements = driftSql
    .replace(/--.*$/gm, "")
    .split(";")
    .filter((s) => s.trim()).length;
  console.log(`drift: ${statements} statement(s) to apply -> ${file}`);
  if (!DRY_RUN) {
    const applied = prisma("db", "execute", "--file", file, "--url", url);
    if (/error/i.test(applied)) {
      console.error(`\napplying the catch-up SQL failed:\n${applied}`);
      process.exit(1);
    }
  }
}

// 3. The assertion. Step 1 alone can look completely successful while leaving the database
//    incomplete, so nothing here counts as done until the drift is provably empty.
if (DRY_RUN) {
  console.log("\ndry run: stopping before the verification assertion.");
  process.exit(0);
}

const final = prisma("migrate", "diff", "--from-url", url, "--to-schema-datamodel", SCHEMA);
if (!/No difference detected/.test(final)) {
  console.error("\nVERIFICATION FAILED — the database still does not match schema.prisma:\n");
  console.error(final);
  process.exit(1);
}

console.log("\nOK — `migrate diff` reports: No difference detected.");
console.log(`baselined (${baselined.length}): ${baselined.join(", ") || "none"}`);
