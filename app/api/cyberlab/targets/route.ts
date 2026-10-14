import { NextResponse } from "next/server";
import { z } from "zod";

import { getAdminSettings } from "@/lib/admin-settings";
import { db } from "@/lib/db";
import { listLabTargets, attestTarget, normalizeTarget } from "@/lib/lab/targets";
import { moduleToolsDenied } from "@/lib/module-gate";
import { getCurrentUser } from "@/lib/session-user";

// TASK_156 C2a (PLAN_TASK_156 §7 C2 item 2, §6 LabTarget) — the attested
// inventory API. The legal spine: a run can only touch values that have a row
// here for that user (checked pre-flight, lib/lab/targets.ts).
//
// GET  — the caller's own attested targets (the panel's picker source).
// POST — attest (or re-attest) ONE target. Normalisation is server-side, so
//        the stored value IS the canonical form pre-flight matches against.
//        Re-attesting refreshes attestedAt on the SAME row — never a duplicate.
//
// HONEST LIMIT (stated in the AUP too): attestation is the operator's
// DECLARATION that they own / are authorised for the asset. Platform-side
// ownership verification exists only inside the lab ranges (C2b).

const AttestBody = z.object({
  kind: z.enum(["host", "network", "url", "domain", "email"]),
  value: z.string().min(1).max(512),
  // TASK_156B C2b (§13.5) — optional link to one of the user's OWN devices
  // ("pick from your devices"). Validated server-side in attestTarget; the
  // client value is never trusted (owner match, not hosted, not removed).
  sourceDeviceId: z.string().min(1).max(64).nullish(),
});

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await moduleToolsDenied(user.id, "cyberlab");
  if (denied) return denied;

  const targets = await listLabTargets(user.id);
  return NextResponse.json({
    targets: targets.map((t) => ({
      id: t.id,
      kind: t.kind,
      value: t.value,
      attestedAt: t.attestedAt,
      sourceDeviceId: t.sourceDeviceId,
    })),
  });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await moduleToolsDenied(user.id, "cyberlab");
  if (denied) return denied;

  const parsed = AttestBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_target" }, { status: 400 });

  const norm = normalizeTarget(parsed.data.kind, parsed.data.value);
  if (!norm) return NextResponse.json({ error: "invalid_target_value" }, { status: 400 });

  // Per-user inventory cap (AdminSetting.cyberlabMaxTargetsPerUser). A
  // re-attest of an existing value is always allowed — it refreshes freshness.
  const settings = await getAdminSettings();
  const already = await db.labTarget.findUnique({
    where: { userId_kind_value: { userId: user.id, kind: norm.kind, value: norm.value } },
  });
  if (!already) {
    const held = await db.labTarget.count({ where: { userId: user.id } });
    if (held >= settings.cyberlabMaxTargetsPerUser) {
      return NextResponse.json(
        { error: `target_cap (${held}/${settings.cyberlabMaxTargetsPerUser})` },
        { status: 400 },
      );
    }
  }

  let row;
  try {
    row = await attestTarget({
      userId: user.id,
      kind: norm.kind,
      value: norm.value,
      sourceDeviceId: parsed.data.sourceDeviceId ?? null,
    });
  } catch (err) {
    // A sourceDeviceId that isn't this user's own live workstation is a
    // validation error (400), never an audit event — no run was refused.
    if (err instanceof Error && err.message.startsWith("invalid_source_device")) {
      return NextResponse.json({ error: "invalid_source_device" }, { status: 400 });
    }
    throw err;
  }
  return NextResponse.json({
    ok: true,
    target: { id: row.id, kind: row.kind, value: row.value, attestedAt: row.attestedAt, sourceDeviceId: row.sourceDeviceId },
  });
}
