import { NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import { deviceToolsDenied } from "@/lib/device-gate";
import { db } from "@/lib/db";
import { scriptErrorResponse } from "@/lib/script-http";

export const dynamic = "force-dynamic";

// POST /api/scripts/:id/auto
//   { enabled: boolean, delayMinutes: number, targetTier: "public" | "any" }
//
// One rule per (user, script). The enrollment trigger fires it for devices that
// appear AFTER the rule is saved, `delayMinutes` after they first sync; the
// (autoRuleId, deviceId) unique key guarantees a single run per device.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ scriptId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await deviceToolsDenied(session.userId);
  if (denied) return denied;
  const { scriptId } = await params;

  let body: { enabled?: unknown; delayMinutes?: unknown; targetTier?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const script = await db.deviceScript.findFirst({
    where: { id: scriptId, userId: session.userId, archivedAt: null },
    select: { id: true },
  });
  if (!script) return NextResponse.json({ error: "script_not_found" }, { status: 404 });

  const enabled = body.enabled !== false;
  const delayMinutes = Math.min(
    7 * 24 * 60,
    Math.max(0, Math.round(Number(body.delayMinutes) || 10)),
  );
  const targetTier = body.targetTier === "any" ? "any" : "public";

  try {
    const existing = await db.deviceScriptAutoRule.findFirst({
      where: { userId: session.userId, scriptId },
      select: { id: true },
    });
    const rule = existing
      ? await db.deviceScriptAutoRule.update({
          where: { id: existing.id },
          data: { enabled, delayMinutes, targetTier },
        })
      : await db.deviceScriptAutoRule.create({
          data: { userId: session.userId, scriptId, enabled, delayMinutes, targetTier },
        });
    return NextResponse.json({ ok: true, rule });
  } catch (err) {
    return scriptErrorResponse(err);
  }
}
