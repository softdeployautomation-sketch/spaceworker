import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { panicStopAllDevices } from "@/lib/devices";

// Task 92 — THE panic switch endpoint (plan CROSS-TRACK RULE 6: one
// operation stops pending device actions, clone jobs, active clone sessions,
// and device-side agent operations together). Later tracks EXTEND
// panicStopAllDevices in lib/devices.ts — never a second kill path.

export async function POST() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const result = await panicStopAllDevices(session.userId, "user");
  return NextResponse.json({ ok: true, ...result });
}