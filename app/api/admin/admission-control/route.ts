import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminSession } from "@/lib/admin-auth";
import { getAdminSettings } from "@/lib/admin-settings";

// Task 46 — admin admission control for the two mechanisms that actually spend
// real RAM on this shared VPS: search/extraction dispatch lanes (light/heavy)
// and interactive browser sessions. GET returns each mechanism's current
// enabled/maxConcurrent (from AdminSetting) alongside a LIVE count of what's
// currently running/active — the RAM-management framing only works if the admin
// can see "2 of 3 in use" while deciding whether to raise or lower a limit, not
// just the static setting.

type MechanismKey =
  | "dispatchLight"
  | "dispatchHeavy"
  | "browserSessions"
  | "vantraLinks"
  | "deviceActions";

const MECHANISMS: Record<
  MechanismKey,
  { enabledField: string; maxField: string }
> = {
  dispatchLight: { enabledField: "dispatchLightEnabled", maxField: "dispatchLightMaxConcurrent" },
  dispatchHeavy: { enabledField: "dispatchHeavyEnabled", maxField: "dispatchHeavyMaxConcurrent" },
  browserSessions: { enabledField: "browserSessionsEnabled", maxField: "browserSessionsMaxConcurrent" },
  // Task 93 (CROSS-TRACK RULE 7) — Vantra plugin per-feature limits.
  vantraLinks: { enabledField: "vantraLinksEnabled", maxField: "vantraLinksMax" },
  deviceActions: { enabledField: "deviceActionsEnabled", maxField: "deviceActionsMaxConcurrent" },
};

async function liveCounts(): Promise<Record<MechanismKey, number>> {
  const [light, heavy, sessions, links, deviceActions] = await Promise.all([
    prisma.searchJob.count({ where: { lane: "light", status: "running" } }),
    prisma.searchJob.count({ where: { lane: "heavy", status: "running" } }),
    prisma.browserSession.count({ where: { status: { in: ["starting", "running"] } } }),
    // Live counts for the Task 93 mechanisms. For links, "active" = links NOT
    // revoked (the number the vantraLinksMax cap applies to). For device
    // actions, it's the open (requested/approved/executing) proposals — the
    // same pool createDeviceActionProposal counts against the cap.
    prisma.vantraLink.count({ where: { status: { not: "revoked" } } }),
    prisma.deviceAction.count({ where: { status: { in: ["requested", "approved", "executing"] } } }),
  ]);
  return {
    dispatchLight: light,
    dispatchHeavy: heavy,
    browserSessions: sessions,
    vantraLinks: links,
    deviceActions,
  };
}

export async function GET() {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const settings = await getAdminSettings();
  const active = await liveCounts();

  const body = Object.fromEntries(
    (Object.keys(MECHANISMS) as MechanismKey[]).map((key) => {
      const { enabledField, maxField } = MECHANISMS[key];
      return [
        key,
        {
          enabled: settings[enabledField as keyof typeof settings] as boolean,
          maxConcurrent: settings[maxField as keyof typeof settings] as number,
          active: active[key],
        },
      ];
    })
  );

  return NextResponse.json(body);
}

// PATCH — body: { mechanism: "dispatchLight"|"dispatchHeavy"|"browserSessions", enabled?, maxConcurrent? }
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
  if (!(mechanism in MECHANISMS)) {
    return NextResponse.json({ error: "Unknown mechanism" }, { status: 400 });
  }
  const { enabledField, maxField } = MECHANISMS[mechanism as MechanismKey];

  const data: Record<string, boolean | number> = {};
  if (typeof body.enabled === "boolean") {
    data[enabledField] = body.enabled;
  }
  if (body.maxConcurrent !== undefined) {
    const n = Number(body.maxConcurrent);
    if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
      return NextResponse.json({ error: "maxConcurrent must be a positive integer" }, { status: 400 });
    }
    data[maxField] = n;
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  // Same upsert-into-singleton pattern getAdminSettings() uses, so the very
  // first PATCH (before any GET has created the row) still works.
  const updated = await prisma.adminSetting.upsert({
    where: { id: "singleton" },
    update: data,
    create: data,
  });

  const active = await liveCounts();
  const key = mechanism as MechanismKey;
  return NextResponse.json({
    mechanism: key,
    enabled: updated[enabledField as keyof typeof updated] as boolean,
    maxConcurrent: updated[maxField as keyof typeof updated] as number,
    active: active[key],
  });
}
