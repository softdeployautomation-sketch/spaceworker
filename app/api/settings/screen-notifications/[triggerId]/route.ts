import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/session-user";
import {
  SCREEN_TRIGGER_MAX_COOLDOWN_MINUTES,
  SCREEN_TRIGGER_MAX_KEYWORD_LENGTH,
  SCREEN_TRIGGER_MIN_COOLDOWN_MINUTES,
} from "@/lib/screen-notifications";

// TASK_152 M5 — update or delete ONE of the caller's keyword triggers.
//
//   PATCH  → enable/disable, re-word, re-label, re-scope, change the cooldown.
//   DELETE → remove it (the cooldown state rows cascade with it).
//
// Owner-scoped by userId on every query: another user's trigger is 404, never a
// 200 and never a 403 that confirms it exists. Deletion here removes only the
// user's OWN trigger config — it never touches a captured frame or a summary.

export const dynamic = "force-dynamic";

function clampCooldown(n: number): number {
  return Math.min(Math.max(Math.round(n), SCREEN_TRIGGER_MIN_COOLDOWN_MINUTES), SCREEN_TRIGGER_MAX_COOLDOWN_MINUTES);
}

const patchSchema = z
  .object({
    keyword: z.string().trim().min(1).max(SCREEN_TRIGGER_MAX_KEYWORD_LENGTH).optional(),
    label: z.string().trim().max(80).nullable().optional(),
    enabled: z.boolean().optional(),
    cooldownMinutes: z
      .number()
      .int()
      .min(SCREEN_TRIGGER_MIN_COOLDOWN_MINUTES)
      .max(SCREEN_TRIGGER_MAX_COOLDOWN_MINUTES)
      .optional(),
    deviceId: z.string().min(1).nullable().optional(),
  })
  .refine(
    (v) =>
      v.keyword !== undefined ||
      v.label !== undefined ||
      v.enabled !== undefined ||
      v.cooldownMinutes !== undefined ||
      v.deviceId !== undefined,
    "Nothing to update",
  );

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ triggerId: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { triggerId } = await params;

  const existing = await db.screenTrigger.findFirst({
    where: { id: triggerId, userId: user.id },
    select: { id: true },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let parsed: z.infer<typeof patchSchema>;
  try {
    parsed = patchSchema.parse(await request.json());
  } catch (e) {
    const msg = e instanceof z.ZodError ? e.errors[0]?.message : "Invalid request body";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  if (parsed.deviceId) {
    const device = await db.device.findFirst({
      where: { id: parsed.deviceId, userId: user.id, screenshotMonitoringEnabled: true },
      select: { id: true },
    });
    if (!device) {
      return NextResponse.json(
        { error: "That device is not one of your monitored machines" },
        { status: 400 },
      );
    }
  }

  const data: Record<string, unknown> = {};
  if (parsed.keyword !== undefined) data.keyword = parsed.keyword;
  if (parsed.label !== undefined) data.label = parsed.label && parsed.label.length > 0 ? parsed.label : null;
  if (parsed.enabled !== undefined) data.enabled = parsed.enabled;
  if (parsed.cooldownMinutes !== undefined) data.cooldownMinutes = clampCooldown(parsed.cooldownMinutes);
  if (parsed.deviceId !== undefined) data.deviceId = parsed.deviceId;

  const updated = await db.screenTrigger.update({
    where: { id: existing.id },
    data,
    select: { id: true, keyword: true, label: true, enabled: true, cooldownMinutes: true, deviceId: true },
  });

  return NextResponse.json({ ok: true, trigger: updated });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ triggerId: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { triggerId } = await params;

  const removed = await db.screenTrigger.deleteMany({ where: { id: triggerId, userId: user.id } });
  if (removed.count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ ok: true, removed: removed.count });
}
