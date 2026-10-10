// TASK_195 S2 — admin QA health battery route.
//
// Runs the IDENTICAL read-only battery the CLI runs (shared adapters from
// lib/qa/battery.ts), so the admin UI and `npx tsx scripts/qa-battery.ts`
// can never disagree about what "healthy" means. READ-ONLY by construction:
// the battery's own header rules (no writes, no sweeps with bearer, values
// never printed) apply to this surface too.
//
// Auth: admin session required BEFORE the battery runs — an anon caller gets
// 401 and never triggers fs scans / self-HTTP probes. Response is no-store so
// every click is a fresh run, never a cached verdict.

import { NextResponse } from "next/server";
import { getAdminSession } from "@/lib/admin-auth";
import { prisma } from "@/lib/prisma";
import {
  createFsDeps,
  createQaDb,
  discoverInternalRoutes,
  resolveOwnOrigin,
  runBattery,
} from "@/lib/qa/battery";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const origin = await resolveOwnOrigin();
  const report = await runBattery({
    // Cast mirrors scripts/qa-battery.ts: Prisma's generic $queryRaw overloads
    // don't structurally unify with QaPrismaLike (TS assignability limit).
    db: createQaDb(prisma as unknown as Parameters<typeof createQaDb>[0]),
    fetchImpl: fetch,
    env: process.env,
    origin,
    internalRoutes: async () => discoverInternalRoutes(),
    ...createFsDeps(),
  });

  return NextResponse.json(report, {
    headers: { "cache-control": "no-store" },
  });
}
