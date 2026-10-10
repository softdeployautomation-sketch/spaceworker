// TASK_195 S1 — QA health battery CLI.
//
// Run on the box (per plan VERIFY §1):
//   sudo -u trmm -H bash -c 'cd /opt/spaceworker && set -a && . ./.env && set +a && npx tsx scripts/qa-battery.ts'
// Locally:  npm run qa-battery            (add --json / --group=platform,access / --origin=url)
//
// READ-ONLY by construction (see lib/qa/battery.ts header). Exit code 0 when
// nothing FAILED (warns/skips are informational), 1 when any probe failed.
// The CLI sources its deps from the real fs / real PrismaClient / real fetch.

import { readdirSync, readFileSync, statSync, statfsSync } from "node:fs";
import { join } from "node:path";
import {
  QA_GROUPS,
  SECRET_ADMIN_FRAGMENT,
  runBattery,
  type QaDb,
  type QaDeps,
  type QaGroup,
  type QaReport,
} from "../lib/qa/battery";

const ROOT = process.cwd();

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
// Real dependencies
// ---------------------------------------------------------------------------

/** Filesystem-truth deps: .next build state, disk, uptime. */
function fsDeps(): Pick<QaDeps, "readBuildId" | "buildAgeMs" | "secretAdminChunkHits" | "diskFreePct" | "uptimeSec"> {
  return {
    async readBuildId() {
      try {
        return readFileSync(join(ROOT, ".next/BUILD_ID"), "utf8").trim();
      } catch {
        return null;
      }
    },
    async buildAgeMs() {
      try {
        return Date.now() - statSync(join(ROOT, ".next/BUILD_ID")).mtimeMs;
      } catch {
        return null;
      }
    },
    async secretAdminChunkHits() {
      const dir = join(ROOT, ".next/static/chunks");
      let files: string[];
      try {
        files = readdirSync(dir, { recursive: true }) as unknown as string[];
      } catch {
        return null; // no build here → battery marks SKIP
      }
      let hits = 0;
      for (const f of files) {
        if (!f.endsWith(".js")) continue;
        try {
          if (readFileSync(join(dir, f), "utf8").includes(SECRET_ADMIN_FRAGMENT)) hits += 1;
        } catch {
          /* unreadable chunk — ignore */
        }
      }
      return hits;
    },
    async diskFreePct() {
      try {
        const s = statfsSync("/");
        const total = s.blocks * s.bsize;
        const free = s.bavail * s.bsize;
        return total > 0 ? (free / total) * 100 : null;
      } catch {
        return null;
      }
    },
    uptimeSec: () => process.uptime(),
  };
}

/** Drift detector: static internal routes from the app dir (dynamic → skipped). */
function discoverInternalRoutes(): string[] {
  const dir = join(ROOT, "app/api/internal");
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith("[")) continue; // v1: static paths only
    out.push(`/api/internal/${name}`);
  }
  return out.sort();
}

/** Structural QaDb backed by a REAL PrismaClient (lib/prisma is server-only). */
function realDb(): QaDb {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { PrismaClient } = require("@prisma/client") as typeof import("@prisma/client");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const prisma = new PrismaClient();
  return {
    async ping() {
      await prisma.$queryRaw`SELECT 1`;
    },
    async unfinishedMigrations() {
      try {
        const rows = await prisma.$queryRaw`SELECT 1 FROM "_prisma_migrations" WHERE "finished_at" IS NULL OR "rolled_back_at" IS NOT NULL`;
        return (rows as unknown[]).length;
      } catch {
        return -1;
      }
    },
    async newestCreatedAt(model) {
      if (model === "DeviceScreenshot") {
        const r = await prisma.deviceScreenshot.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } });
        return r?.createdAt ?? null;
      }
      const r = await prisma.userPresenceEvent.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } });
      return r?.createdAt ?? null;
    },
    async deviceCount() {
      return prisma.device.count();
    },
  };
}

// ---------------------------------------------------------------------------
// Origin resolution — QA_ORIGIN → PORT → :3500 → :3000, first to ANSWER wins.
// (The box's .env PORT=3400 disagrees with its true listener :3500 — TASK_194
// S6 fact — so we probe instead of trusting one source.)
// ---------------------------------------------------------------------------

async function resolveOrigin(): Promise<string> {
  const candidates: string[] = [];
  if (originFlag) candidates.push(originFlag.replace(/\/$/, ""));
  if (process.env.QA_ORIGIN) candidates.push(process.env.QA_ORIGIN.replace(/\/$/, ""));
  const port = process.env.PORT ?? "3400";
  candidates.push(`http://127.0.0.1:${port}`);
  candidates.push("http://127.0.0.1:3500");
  candidates.push("http://127.0.0.1:3000");

  const seen = new Set<string>();
  for (const url of candidates) {
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const res = await fetch(`${url}/login`, { signal: AbortSignal.timeout(2_000) });
      await res.text().catch(() => undefined);
      return url; // any HTTP answer = this is our origin
    } catch {
      /* try next */
    }
  }
  // Nothing answered — fall back to the first candidate so the battery's
  // access probes run anyway and report their own network failures.
  return [...seen][0] ?? "http://127.0.0.1:3500";
}

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
  const origin = await resolveOrigin();
  const db = realDb();
  const deps: QaDeps = {
    db,
    fetchImpl: fetch,
    env: process.env,
    origin,
    internalRoutes: async () => discoverInternalRoutes(),
    ...fsDeps(),
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

