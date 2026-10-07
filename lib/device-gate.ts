import { NextResponse } from "next/server";

import "server-only";

import { canUseDeviceTools } from "./entitlements";

/**
 * TASK_181 P2 step 22 — THE device-action gate, in one place.
 *
 * Free (tier 1) accounts may CREATE their org, mint installers, and SEE their
 * devices read-only — but performing any action that reaches the device
 * (terminal, ping, power, remote control, clones, screenshots capture, panic,
 * uninstall…) requires the `devices` entitlement: tier 5 catch-all, a live
 * tier-3 XDevice term, or a `devices` grant row.
 *
 * Usage in a route handler, right after the session check:
 *
 *   const denied = await deviceToolsDenied(session.userId);
 *   if (denied) return denied;
 *
 * Returns null when allowed (so the happy path reads as a no-op), or a ready
 * 403 `{ error: "xdevice_required" }` response. NEVER use this on
 * AGENT-FACING routes (heartbeat, pin-callback) or pure READ routes — free
 * users must still see their devices.
 */
export async function deviceToolsDenied(userId: string): Promise<NextResponse | null> {
  if (await canUseDeviceTools(userId)) return null;
  return NextResponse.json({ error: "xdevice_required" }, { status: 403 });
}