import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { deviceToolsDenied } from "@/lib/device-gate";
import { lanAuditConsent, LanAuditRefusedError, runLanAudit } from "@/lib/security-audit/run";
import { getCurrentUser } from "@/lib/session-user";

// TASK_217 — /api/security-audit/runs.
// POST runs ONE audit on the caller's own device (server assembles the probe
// pack; the client only sends deviceId). GET returns the caller's recent runs
// for the history panel. Both are xdevice-gated: an audit is a device tool.

const RunBody = z.object({
  deviceId: z.string().min(1).max(64),
});

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const denied = await deviceToolsDenied(user.id);
  if (denied) return denied;

  // Consent is checked twice on purpose: cheaply here (so a missing consent
  // is a clean 403 before any device call) and again inside runLanAudit (the
  // service never trusts its caller to have gated).
  const consent = await lanAuditConsent(user.id);
  if (!consent) {
    return NextResponse.json({ error: "lan_audit_consent_required" }, { status: 403 });
  }

  let body: z.infer<typeof RunBody>;
  try {
    body = RunBody.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const result = await runLanAudit({ userId: user.id, deviceId: body.deviceId });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof LanAuditRefusedError) {
      const status = err.code === "consent_required" ? 403 : 502;
      return NextResponse.json({ error: err.code }, { status });
    }
    return NextResponse.json({ error: "audit_failed" }, { status: 500 });
  }
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const denied = await deviceToolsDenied(user.id);
  if (denied) return denied;

  const runs = await db.securityAudit.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true,
      deviceId: true,
      verdict: true,
      worstSeverity: true,
      leakCount: true,
      passCount: true,
      infoCount: true,
      noData: true,
      createdAt: true,
    },
  });

  return NextResponse.json({ ok: true, runs });
}
