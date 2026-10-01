import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/session-user";
import {
  SCREEN_TRIGGER_DEFAULT_COOLDOWN_MINUTES,
  SCREEN_TRIGGER_MAX_COOLDOWN_MINUTES,
  SCREEN_TRIGGER_MAX_KEYWORD_LENGTH,
  SCREEN_TRIGGER_MIN_COOLDOWN_MINUTES,
  SCREEN_DIGEST_DEFAULT_INTERVAL_MINUTES,
  SCREEN_DIGEST_MAX_INTERVAL_MINUTES,
  SCREEN_DIGEST_MIN_INTERVAL_MINUTES,
} from "@/lib/screen-notifications";

// TASK_152 M5 — the screen-monitoring notification settings + trigger CRUD.
//
//   GET   → the account's two master switches + digest cadence, the supported
//           bounds (so the UI never hardcodes a limit), the user's triggers with
//           their last-fired state, and the monitored devices a trigger may be
//           scoped to.
//   PATCH → the master switches / digest cadence.
//   POST  → create a keyword trigger.
//
// Both master switches default FALSE; nothing here turns them on implicitly.
// Owner-scoped: every read and write is filtered by session.userId, and a
// deviceId is only accepted if it is one of THIS user's monitored devices.

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [triggers, devices] = await Promise.all([
    db.screenTrigger.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        keyword: true,
        label: true,
        enabled: true,
        cooldownMinutes: true,
        deviceId: true,
        states: { select: { deviceId: true, lastFiredAt: true } },
      },
    }),
    db.device.findMany({
      where: { userId: user.id, screenshotMonitoringEnabled: true },
      select: { id: true, name: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  return NextResponse.json({
    prefs: {
      triggersEnabled: user.screenTriggerNotificationsEnabled,
      digestEnabled: user.screenDigestEnabled,
      digestIntervalMinutes: user.screenDigestIntervalMinutes,
    },
    bounds: {
      minCooldownMinutes: SCREEN_TRIGGER_MIN_COOLDOWN_MINUTES,
      maxCooldownMinutes: SCREEN_TRIGGER_MAX_COOLDOWN_MINUTES,
      defaultCooldownMinutes: SCREEN_TRIGGER_DEFAULT_COOLDOWN_MINUTES,
      maxKeywordLength: SCREEN_TRIGGER_MAX_KEYWORD_LENGTH,
      minDigestIntervalMinutes: SCREEN_DIGEST_MIN_INTERVAL_MINUTES,
      maxDigestIntervalMinutes: SCREEN_DIGEST_MAX_INTERVAL_MINUTES,
      defaultDigestIntervalMinutes: SCREEN_DIGEST_DEFAULT_INTERVAL_MINUTES,
    },
    devices: devices.map((d) => ({ id: d.id, name: d.name })),
    triggers: triggers.map((t) => ({
      id: t.id,
      keyword: t.keyword,
      label: t.label,
      enabled: t.enabled,
      cooldownMinutes: t.cooldownMinutes,
      deviceId: t.deviceId,
      // Newest firing across the trigger's device states — what the UI shows as
      // "last fired"; null means it has never fired.
      lastFiredAt:
        t.states.length > 0
          ? new Date(Math.max(...t.states.map((s) => s.lastFiredAt.getTime()))).toISOString()
          : null,
    })),
  });
}

const patchSchema = z
  .object({
    triggersEnabled: z.boolean().optional(),
    digestEnabled: z.boolean().optional(),
    digestIntervalMinutes: z
      .number()
      .int()
      .min(SCREEN_DIGEST_MIN_INTERVAL_MINUTES)
      .max(SCREEN_DIGEST_MAX_INTERVAL_MINUTES)
      .optional(),
  })
  .refine(
    (v) =>
      v.triggersEnabled !== undefined ||
      v.digestEnabled !== undefined ||
      v.digestIntervalMinutes !== undefined,
    "Nothing to update",
  );

export async function PATCH(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let parsed: z.infer<typeof patchSchema>;
  try {
    parsed = patchSchema.parse(await request.json());
  } catch (e) {
    const msg = e instanceof z.ZodError ? e.errors[0]?.message : "Invalid request body";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const data: Record<string, unknown> = {};
  if (parsed.triggersEnabled !== undefined) {
    data.screenTriggerNotificationsEnabled = parsed.triggersEnabled;
  }
  if (parsed.digestEnabled !== undefined) data.screenDigestEnabled = parsed.digestEnabled;
  if (parsed.digestIntervalMinutes !== undefined) {
    data.screenDigestIntervalMinutes = parsed.digestIntervalMinutes;
  }

  const updated = await db.user.update({
    where: { id: user.id },
    data,
    select: {
      screenTriggerNotificationsEnabled: true,
      screenDigestEnabled: true,
      screenDigestIntervalMinutes: true,
    },
  });

  return NextResponse.json({
    ok: true,
    prefs: {
      triggersEnabled: updated.screenTriggerNotificationsEnabled,
      digestEnabled: updated.screenDigestEnabled,
      digestIntervalMinutes: updated.screenDigestIntervalMinutes,
    },
  });
}

const postSchema = z.object({
  keyword: z
    .string()
    .trim()
    .min(1, "Enter the text to look for")
    .max(SCREEN_TRIGGER_MAX_KEYWORD_LENGTH),
  label: z.string().trim().max(80).optional(),
  deviceId: z.string().min(1).nullable().optional(),
  enabled: z.boolean().optional(),
  cooldownMinutes: z
    .number()
    .int()
    .min(SCREEN_TRIGGER_MIN_COOLDOWN_MINUTES)
    .max(SCREEN_TRIGGER_MAX_COOLDOWN_MINUTES)
    .optional(),
});

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let parsed: z.infer<typeof postSchema>;
  try {
    parsed = postSchema.parse(await request.json());
  } catch (e) {
    const msg = e instanceof z.ZodError ? e.errors[0]?.message : "Invalid request body";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  // A device scope is only valid if the device is this user's AND monitored.
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

  const trigger = await db.screenTrigger.create({
    data: {
      userId: user.id,
      deviceId: parsed.deviceId ?? null,
      keyword: parsed.keyword,
      label: parsed.label && parsed.label.length > 0 ? parsed.label : null,
      enabled: parsed.enabled ?? true,
      cooldownMinutes: parsed.cooldownMinutes ?? SCREEN_TRIGGER_DEFAULT_COOLDOWN_MINUTES,
    },
    select: { id: true },
  });

  return NextResponse.json({ ok: true, id: trigger.id });
}
