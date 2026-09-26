import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminSession } from "@/lib/admin-auth";
import {
  FEATURE_REGISTRY,
  getGovernorFeatureStatuses,
  isGovernorFeature,
  type GovernorFeature,
  type GovernorFeatureStatus,
} from "@/lib/resource-governor";

// Task 46 — admin admission control for the two mechanisms that actually spend
// real RAM on this shared VPS: search/extraction dispatch lanes (light/heavy)
// and interactive browser sessions. GET returns each mechanism's current
// enabled/maxConcurrent (from AdminSetting) alongside a LIVE count of what's
// currently running/active — the RAM-management framing only works if the admin
// can see "2 of 3 in use" while deciding whether to raise or lower a limit, not
// just the static setting.

// TASK_105 — the mechanism list IS the governor's feature registry (deliverable
// 3: "adding a feature = one registry entry, not a new subsystem"). Caps and
// enabled flags still come from AdminSetting through each entry's columns; the
// LIVE count and the QUEUED count now come from that same registry and the
// governor's queue table, so this card, the governor and each feature's own gate
// can never disagree about "2 of 3 in use, 4 waiting".
type MechanismKey = GovernorFeature;

type MechanismState = {
  enabled: boolean;
  maxConcurrent: number;
  active: number;
  /** TASK_105 — requests the governor is holding for this feature right now. */
  queued: number;
  /**
   * False when the feature has no master on/off AdminSetting column (the hosted
   * pool's size IS its cap), so the panel hides the Pause toggle rather than
   * offering a switch that would write nothing.
   */
  toggleable: boolean;
};

function toMechanismState(status: GovernorFeatureStatus): MechanismState {
  return {
    enabled: status.enabled,
    maxConcurrent: status.cap,
    active: status.live,
    queued: status.queued,
    toggleable: FEATURE_REGISTRY[status.key].enabledColumn !== undefined,
  };
}

async function featureStates(): Promise<Record<MechanismKey, MechanismState>> {
  const statuses = await getGovernorFeatureStatuses();
  return Object.fromEntries(
    statuses.map((status) => [status.key, toMechanismState(status)])
  ) as Record<MechanismKey, MechanismState>;
}

export async function GET() {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json(await featureStates());
}

// PATCH — body: { mechanism: <registry key>, enabled?, maxConcurrent? }. The
// column each field writes is read from the feature registry, so the API and the
// governor can never target different columns for the same feature.
export async function PATCH(req: Request) {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { mechanism?: unknown; enabled?: unknown; maxConcurrent?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const mechanism = typeof body.mechanism === "string" ? body.mechanism : "";
  if (!isGovernorFeature(mechanism)) {
    return NextResponse.json({ error: "Unknown mechanism" }, { status: 400 });
  }
  const key: GovernorFeature = mechanism;
  const def = FEATURE_REGISTRY[key];

  const data: Record<string, boolean | number> = {};
  if (typeof body.enabled === "boolean") {
    if (!def.enabledColumn) {
      return NextResponse.json(
        { error: `${key} has no on/off switch — its size is the limit` },
        { status: 400 },
      );
    }
    data[def.enabledColumn] = body.enabled;
  }
  if (body.maxConcurrent !== undefined) {
    const n = Number(body.maxConcurrent);
    if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
      return NextResponse.json({ error: "maxConcurrent must be a positive integer" }, { status: 400 });
    }
    data[def.maxColumn] = n;
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  // Same upsert-into-singleton pattern getAdminSettings() uses, so the very
  // first PATCH (before any GET has created the row) still works.
  await prisma.adminSetting.upsert({
    where: { id: "singleton" },
    update: data,
    create: data,
  });

  // Fresh state back (the panel swaps its row wholesale, so ONE round trip
  // refreshes the cap, the live count AND the queued count).
  const states = await featureStates();
  return NextResponse.json({ mechanism: key, ...states[key] });
}
