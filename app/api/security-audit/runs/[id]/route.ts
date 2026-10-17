import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { deviceToolsDenied } from "@/lib/device-gate";
import { getCurrentUser } from "@/lib/session-user";

// TASK_217 — GET /api/security-audit/runs/[id].
// One run's roll-up + its verdict cards. Ownership is enforced by the
// userId-scoped query (a run belonging to someone else is a 404, never a 403
// leak of existence).

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const denied = await deviceToolsDenied(user.id);
  if (denied) return denied;

  const { id } = await params;

  const audit = await db.securityAudit.findFirst({
    where: { id, userId: user.id },
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
  if (!audit) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const findings = await db.auditFinding.findMany({
    where: { auditId: audit.id },
    orderBy: [{ verdict: "asc" }, { severity: "desc" }],
    select: {
      probe: true,
      title: true,
      verdict: true,
      severity: true,
      evidence: true,
      remediation: true,
    },
  });

  return NextResponse.json({ ok: true, audit, findings });
}
