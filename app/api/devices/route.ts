import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { isXdeviceLive } from "@/lib/entitlements";
import {
  deviceListSelector,
  DEVICE_ONLINE_WINDOW_MS,
  isDeviceOnline,
  toDeviceView,
} from "@/lib/devices";
import { fetchUserIdleReading } from "@/lib/vantra-link";

// Task 92/95 — the user's device list. Read-only: everything mutating is a
// gated proposal by design. ONE source of truth for the status the UI shows
// (the old page also rendered the Vantra-sync view, so a machine appeared
// twice with two different statuses).
//
// Task 106 (bit C1) — adds best-effort `idleSeconds` per row (MeshCentral
// `idletime`, normalised to seconds by Vantra). Vantra unreachable or no
// linked org → still 200 with `idleSeconds: null`.
//
// TASK_154 N1 — idle now carries PROVENANCE. Three situations used to share one
// nullable number (`null`): a fresh reading, a stale one, and "unknown". A mesh
// hiccup therefore blanked the idle text and the device read as a bare `online`
// (indistinguishable from "active now"). `fetchUserIdleReading` never throws and
// serves the last good map on failure; `idle: { asOf, state }` reports what the
// map is worth. `idleSeconds` is unchanged for existing consumers; the richer
// per-row `idle` object is opt-in via `?idle=provenance`.

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // TASK_118 B8-1: the "hosted" row is our own clone-destination browser
  // (lib/clone-destination.ts), infrastructure the account doesn't own or
  // manage — never a PC the user thinks they have to look after. Excluded
  // here, not just cosmetically renamed, so it can never appear in the
  // device list, get clicked into a console, or be targeted by a device
  // action meant for a real machine.
  const devices = await prisma.device.findMany({
    where: {
      userId: session.userId,
      deviceKind: { not: "hosted" },
      // TASK_128 §15 — a removed device (the Delete button) leaves no ghost
      // row behind: filtered HERE, at the one read every devices surface goes
      // through, rather than merely hidden in the component.
      removedAt: null,
    },
    orderBy: { createdAt: "asc" },
    select: deviceListSelector,
  });

  // TASK_191 — tier-3 (XDevice) accounts never get a private org (see
  // `isPrivateAllowed` in lib/vantra-link.ts), so the quarantine strip, row
  // badge and stage wording are meaningless to them: a new device should just
  // APPEAR (owner: "take out that flow showing on the ui from xdevice users…
  // it remains the same for premium plus"). Suppressed HERE, at the ONE read
  // every devices surface goes through (device-list AND device-console both
  // poll this route), so no client changes. Payload SHAPE is unchanged —
  // `onboarding` is already nullable. The sweep stages themselves keep running
  // (owner chose UI-only); nothing in lib/vantra-link.ts or the sweep changes.
  // Live tier-3 test = the exact grandfathered/null rule the entitlements use.
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { tier: true, premiumExpiresAt: true },
  });
  const suppressOnboarding = user !== null && isXdeviceLive(user);

  // TASK_154 N1 — idle with provenance, and a tolerance the old path lacked.
  // `fetchUserIdleReading` never throws: on a mesh hiccup it serves the last
  // good map (state "stale") instead of blanking every row, and degrades to
  // "unknown" only when there is genuinely no reading. The device list must
  // always render — a mesh failure is never a 500 here.
  const idle = await fetchUserIdleReading(session.userId);
  const includeRowProvenance = new URL(request.url).searchParams.get("idle") === "provenance";

  return NextResponse.json({
    onlineWindowMs: DEVICE_ONLINE_WINDOW_MS,
    // Provenance for the whole bulk read (additive; existing consumers ignore it).
    idle: { asOf: idle.asOf, state: idle.state },
    devices: devices.map((d) => {
      const view = toDeviceView(d);
      // TASK_185 P1 — the STABLE identity wins: key the idle read by TRMM agent
      // id first (rename-proof — Device.name drifts when a user renames the
      // machine or heartbeat overwrites it), with the legacy hostname-by-name
      // match as fallback for an older Vantra that omits `idleByAgentId`.
      const idleSeconds =
        (view.vantraAgentId ? idle.idleByAgentId[view.vantraAgentId] : undefined) ??
        idle.idleByHostname[view.name] ??
        null;
      return {
        ...view,
        // TASK_128 — the strip's "waiting for the device" needs the same online
        // derivation the rest of the app uses (`isDeviceOnline(lastSeenAt)`);
        // computing it here keeps the client helper free of the server-only
        // module. TASK_191 — `suppressOnboarding` nulls it wholesale for live
        // tier-3 accounts (see above); everything downstream (strip, row badge,
        // stuck/failure alerts, console hide-stage wording) is null-gated.
        onboarding:
          suppressOnboarding || !view.onboarding
            ? null
            : { ...view.onboarding, isOnline: isDeviceOnline(view.lastSeenAt) },
        // Unchanged back-compat field every existing consumer already reads.
        idleSeconds,
        // TASK_154 N1 — opt-in per-row provenance so a client can tell a known
        // reading (with its age) from "we do not know right now". Default OFF so
        // the payload for every existing caller stays byte-identical.
        ...(includeRowProvenance
          ? {
              idle: {
                seconds: idleSeconds,
                asOf: idleSeconds === null ? null : idle.asOf,
                state: idleSeconds === null ? ("unknown" as const) : idle.state,
              },
            }
          : {}),
      };
    }),
  });
}