import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { getProduct } from "@/lib/products";
import { TRIAL_HOURS } from "@/lib/license-state";

export const dynamic = "force-dynamic";

// GET /api/admin/exe-trials — owner-requested 2026-09-20: "a subtab showing
// every free users device active for that 24hrs, and can leave after they
// get binded." Lists every ExeTrialSession still inside its 24h window
// (same rule lib/license-state.ts's trialActive() uses locally), EXCLUDING
// any (machineId, product) pair that now has a bound ExeLicense — the
// "leaves after they get binded" behaviour: once a trial device claims a
// real license it belongs in the normal licenses list, not here.
export async function GET() {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cutoff = new Date(Date.now() - TRIAL_HOURS * 60 * 60 * 1000);
  const sessions = await db.exeTrialSession.findMany({
    where: { startedAt: { gte: cutoff } },
    orderBy: { lastSeenAt: "desc" },
  });
  if (sessions.length === 0) {
    return NextResponse.json({ trials: [] });
  }

  const boundMachines = await db.exeLicense.findMany({
    where: {
      product: { in: [...new Set(sessions.map((s) => s.product))] },
      boundMachineId: { not: null },
    },
    select: { boundMachineId: true, product: true },
  });
  const boundKey = (machineId: string, product: string) => `${machineId}::${product}`;
  const boundSet = new Set(
    boundMachines.map((l) => boundKey((l.boundMachineId ?? "").toLowerCase(), l.product)),
  );

  const now = Date.now();
  const trials = sessions
    .filter((s) => !boundSet.has(boundKey(s.machineId, s.product)))
    .map((s) => {
      const endsAt = new Date(s.startedAt.getTime() + TRIAL_HOURS * 60 * 60 * 1000);
      const hoursLeft = Math.max(0, (endsAt.getTime() - now) / (60 * 60 * 1000));
      return {
        id: s.id,
        machineId: s.machineId,
        machineLabel: s.machineLabel,
        product: s.product,
        productName: getProduct(s.product)?.name ?? s.product,
        startedAt: s.startedAt.toISOString(),
        lastSeenAt: s.lastSeenAt.toISOString(),
        endsAt: endsAt.toISOString(),
        hoursLeft,
      };
    });

  return NextResponse.json({ trials });
}
