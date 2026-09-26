import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminSession } from "@/lib/admin-auth";
import { getGovernorView, resolveGovernorSettings } from "@/lib/resource-governor";

// TASK_105 — the admin dials for the governor's PRESSURE MODEL, plus the live
// per-feature queue read-out. This extends the admission-control card (no new
// page): leave `enabled` false and nothing changes vs. today; turn it on and
// every high-RAM feature starts queueing under real load.
//
// PATCH is a SUBSET update of the six AdminSetting thresholds, validated so the
// stored model stays coherent (a warn above hard would invert the escalation, so
// that combination is rejected rather than stored and silently clamped).

const WRITABLE = {
  enabled: { column: "governorEnabled", kind: "bool" },
  ramWarnPct: { column: "governorRamWarnPct", kind: "int", min: 1, max: 100 },
  ramHardPct: { column: "governorRamHardPct", kind: "int", min: 1, max: 100 },
  swapHardMb: { column: "governorSwapHardMb", kind: "int", min: 0 },
  // 60s floor: a queue that expires in seconds would just thrash.
  queueTimeoutSec: { column: "governorQueueTimeoutSec", kind: "int", min: 60 },
  starvationPromoteMin: { column: "governorStarvationPromoteMin", kind: "int", min: 1 },
} as const;

type WritableKey = keyof typeof WRITABLE;

export async function GET() {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json(await getGovernorView());
}

// PATCH — body: a SUBSET of { enabled?, ramWarnPct?, ramHardPct?, swapHardMb?,
// queueTimeoutSec?, starvationPromoteMin? }. Returns the whole view so the panel
// refreshes thresholds AND live counts in one round trip.
export async function PATCH(req: Request) {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const data: Record<string, boolean | number> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!(key in WRITABLE)) {
      return NextResponse.json({ error: `Unknown setting: ${key}` }, { status: 400 });
    }
    const spec = WRITABLE[key as WritableKey];
    if (spec.kind === "bool") {
      if (typeof value !== "boolean") {
        return NextResponse.json({ error: `${key} must be a boolean` }, { status: 400 });
      }
      data[spec.column] = value;
      continue;
    }
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < spec.min || ("max" in spec && n > spec.max)) {
      const bound = "max" in spec ? ` between ${spec.min} and ${spec.max}` : ` >= ${spec.min}`;
      return NextResponse.json({ error: `${key} must be a whole number${bound}` }, { status: 400 });
    }
    data[spec.column] = n;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  // Cross-field guard against the CURRENT row plus this patch: warn must never
  // exceed hard (resolveGovernorSettings would clamp it, which would silently
  // contradict what the admin just typed).
  const current = resolveGovernorSettings(await prisma.adminSetting.findUnique({ where: { id: "singleton" } }));
  const nextWarn = (data.governorRamWarnPct as number | undefined) ?? current.ramWarnPct;
  const nextHard = (data.governorRamHardPct as number | undefined) ?? current.ramHardPct;
  if (nextWarn > nextHard) {
    return NextResponse.json(
      { error: "ramWarnPct must not be greater than ramHardPct" },
      { status: 400 },
    );
  }

  // Same upsert-into-singleton pattern getAdminSettings() uses, so the very
  // first PATCH (before any GET created the row) works and nobody else's value
  // is lost.
  await prisma.adminSetting.upsert({
    where: { id: "singleton" },
    update: data,
    create: data,
  });

  return NextResponse.json(await getGovernorView());
}
