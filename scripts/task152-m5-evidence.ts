/**
 * TASK_152 M5 — scratch-DB evidence harness. NOT part of the shipped app; run
 * with tsx against the scratch DB to produce RAW NotificationLog /
 * ScreenDigestRollup / ScreenTriggerState rows for the task writeup.
 *
 *   NODE_OPTIONS='--conditions=react-server' \
 *   DATABASE_URL=... SCRATCH ... npx tsx tmp-m5-evidence.ts
 */
import { db } from "../lib/db";
import { runTriggerPass, buildScreenDigest } from "../lib/screen-notifications";
import { telegramConfigured } from "../lib/telegram";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const h = (s: string) => console.log(`\n==== ${s} ====`);

async function reset(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE "NotificationLog","AgentMessage","AgentThread","ScreenDigestRollup",' +
      '"ScreenTriggerState","ScreenTrigger","DeviceScreenshot","Device","User" CASCADE',
  );
}

async function seed(): Promise<void> {
  await db.user.create({
    data: {
      id: "m5_user_a",
      email: "a@m5.test",
      passwordHash: "x",
      notifyEmail: true,
      notifyTelegram: true,
      notifyAgent: true,
      telegramChatId: "5550001",
      // both master switches at their DEFAULTS (off) — the failing condition.
    },
  });
  await db.user.create({
    data: {
      id: "m5_user_b",
      email: "b@m5.test",
      passwordHash: "x",
      notifyEmail: true,
      notifyTelegram: false, // Telegram DISABLED for this user
      notifyAgent: true,
      telegramChatId: null,
      screenDigestEnabled: true,
      screenDigestIntervalMinutes: 120,
    },
  });
  await db.agentThread.create({ data: { id: "m5_thread_a", userId: "m5_user_a" } });
  await db.agentThread.create({ data: { id: "m5_thread_b", userId: "m5_user_b" } });

  await db.device.create({
    data: { id: "m5_devA1", userId: "m5_user_a", name: "Owner laptop", screenshotMonitoringEnabled: true },
  });
  await db.device.create({
    data: { id: "m5_devB1", userId: "m5_user_b", name: "Studio PC", screenshotMonitoringEnabled: true },
  });
  await db.device.create({
    data: { id: "m5_devB2", userId: "m5_user_b", name: "Reception PC", screenshotMonitoringEnabled: true },
  });

  // The owner's own example trigger: "the screen shows a balance".
  await db.screenTrigger.create({
    data: {
      id: "m5_trig1",
      userId: "m5_user_a",
      keyword: "balance",
      label: "Balance on screen",
      cooldownMinutes: 120,
    },
  });
  console.log("seeded users A,B; devices A1,B1,B2; trigger m5_trig1 (keyword=balance, cooldown=120m)");
}

async function addFrame(
  id: string,
  deviceId: string,
  userId: string,
  summary: string,
  createdAt: Date,
): Promise<void> {
  await db.deviceScreenshot.create({
    data: {
      id,
      deviceId,
      userId,
      status: "captured",
      filePath: `sim/${id}.png`,
      summary,
      summaryDate: new Date(Date.UTC(createdAt.getUTCFullYear(), createdAt.getUTCMonth(), createdAt.getUTCDate())),
      capturedAt: createdAt,
      createdAt,
    },
  });
}

async function notifRows(userId: string, label: string) {
  const rows = await db.notificationLog.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { id: true, eventType: true, channel: true, recipient: true, outcome: true, errorMessage: true },
  });
  console.log(`${label} → ${rows.length} NotificationLog row(s):`);
  for (const r of rows) {
    console.log(
      `  [${r.eventType}] channel=${r.channel} recipient=${r.recipient} outcome=${r.outcome}` +
        (r.errorMessage ? ` error="${r.errorMessage}"` : ""),
    );
  }
  return rows;
}

async function main(): Promise<void> {
  // SAFETY: this harness TRUNCATEs User/Device/... CASCADE. Refuse to run unless
  // DATABASE_URL points at a scratch database. Guards against ever nuking a live
  // install (the task rule: scratch DB only).
  const url = process.env.DATABASE_URL ?? "";
  const dbName = url.split("?")[0].split("/").pop() ?? "";
  if (!/scratch|_m5|_test|test_/i.test(dbName)) {
    console.error(
      `REFUSING TO RUN: DATABASE_URL database "${dbName}" does not look like a scratch DB. ` +
        "This harness TRUNCATEs tables. Point it at a scratch DB (name must contain scratch/_m5/test).",
    );
    process.exit(1);
  }
  console.log(`[evidence] scratch DB confirmed: ${dbName}`);
  await reset();
  await seed();

  // ---------------------------------------------------------------------
  h("PHASE 0 — FAILING CONDITION: master switch OFF, matching summary, trigger exists");
  await addFrame(
    "m5_f1",
    "m5_devA1",
    "m5_user_a",
    "Chase online banking page open, showing an account balance of $4,210.55.",
    NOW,
  );
  console.log("trigger rows for user A:", await db.screenTrigger.count({ where: { userId: "m5_user_a" } }));
  console.log(
    "user A screenTriggerNotificationsEnabled =",
    (await db.user.findUnique({ where: { id: "m5_user_a" }, select: { screenTriggerNotificationsEnabled: true } }))
      ?.screenTriggerNotificationsEnabled,
  );
  const p0 = await runTriggerPass(NOW);
  console.log("runTriggerPass result:", JSON.stringify(p0));
  await notifRows("m5_user_a", "AFTER phase 0 (expect ZERO rows — the guard was OFF)");

  // ---------------------------------------------------------------------
  h("PHASE 1 — switch triggers ON, a matching summary fires and delivers");
  await db.user.update({ where: { id: "m5_user_a" }, data: { screenTriggerNotificationsEnabled: true } });
  await addFrame(
    "m5_f2",
    "m5_devA1",
    "m5_user_a",
    "Chase online banking page open, showing an account balance of $4,210.55.",
    new Date(NOW.getTime() + 1000),
  );
  const p1 = await runTriggerPass(NOW);
  console.log("runTriggerPass result:", JSON.stringify(p1));
  const rows1 = await notifRows("m5_user_a", "AFTER phase 1");

  // ---------------------------------------------------------------------
  h("PHASE 2 — COOLDOWN: immediate 2nd capture must NOT re-fire; 121min later MAY");
  await addFrame(
    "m5_f3",
    "m5_devA1",
    "m5_user_a",
    "Banking again — balance still shown, current account $4,210.55.",
    new Date(NOW.getTime() + 60_000),
  );
  const p2a = await runTriggerPass(new Date(NOW.getTime() + 60_000));
  console.log("runTriggerPass @NOW+1min result:", JSON.stringify(p2a));
  const afterCooldown = await notifRows("m5_user_a", "AFTER +1min (expect SAME count as phase 1)");

  await addFrame(
    "m5_f4",
    "m5_devA1",
    "m5_user_a",
    "Balance check — account balance $4,199.00.",
    new Date(NOW.getTime() + 121 * 60_000),
  );
  const p2b = await runTriggerPass(new Date(NOW.getTime() + 121 * 60_000));
  console.log("runTriggerPass @NOW+121min result:", JSON.stringify(p2b));
  const afterExpiry = await notifRows("m5_user_a", "AFTER +121min (expect MORE rows — cooldown expired)");

  console.log("count check: phase1=", rows1.length, " after+1min=", afterCooldown.length, " after+121min=", afterExpiry.length);
  const state = await db.screenTriggerState.findMany({
    where: { triggerId: "m5_trig1" },
    select: { deviceId: true, lastFiredAt: true },
  });
  console.log("ScreenTriggerState (cooldown state) rows:", JSON.stringify(state));

  // ---------------------------------------------------------------------
  h("PHASE 3 — DIGEST covering >=2 devices in ONE message (user B, Telegram DISABLED)");
  await addFrame(
    "m5_b1",
    "m5_devB1",
    "m5_user_b",
    "Visual Studio Code open on a TypeScript file, tests running.",
    new Date(NOW.getTime() - 90 * 60_000),
  );
  await addFrame(
    "m5_b2",
    "m5_devB1",
    "m5_user_b",
    "Figma open on a checkout screen redesign.",
    new Date(NOW.getTime() - 30 * 60_000),
  );
  await addFrame(
    "m5_b3",
    "m5_devB2",
    "m5_user_b",
    "Reception calendar showing today's bookings.",
    new Date(NOW.getTime() - 60 * 60_000),
  );
  const dg = await buildScreenDigest("m5_user_b", NOW);
  console.log("buildScreenDigest result:", JSON.stringify(dg));
  const rollups = await db.screenDigestRollup.findMany({
    where: { userId: "m5_user_b" },
    select: { id: true, windowStart: true, windowEnd: true, deviceCount: true, digestText: true },
  });
  console.log("ScreenDigestRollup rows:", JSON.stringify(rollups, null, 2));
  const idem = await buildScreenDigest("m5_user_b", NOW);
  console.log("buildScreenDigest re-fire (idempotency):", JSON.stringify(idem));
  console.log("rollup count after re-fire:", await db.screenDigestRollup.count({ where: { userId: "m5_user_b" } }));
  const rowsB = await notifRows("m5_user_b", "AFTER digest (user B: email=on, telegram=OFF, agent=on)");
  console.log("user B telegram rows:", rowsB.filter((r) => r.channel === "telegram").length, "(expect 0)");

  // ---------------------------------------------------------------------
  h("PHASE 4 — agent channel really delivered (AgentMessage count for user B)");
  console.log(
    "AgentMessage count in thread m5_thread_b:",
    await db.agentMessage.count({ where: { threadId: "m5_thread_b" } }),
  );

  // ---------------------------------------------------------------------
  // PHASE 5 — the DISABLE gate must be FALSIFIABLE: same run, same process,
  // same configured bot token. User A has Telegram ENABLED (+ chatId); user B
  // has it DISABLED (notifyTelegram=false). If the pref is respected, A gets a
  // telegram row (attempt) and B gets none. A check where NEITHER gets a row
  // would be vacuous (it would just mean Telegram is unconfigured), so we also
  // assert telegramConfigured() must be true for this phase to count.
  h("PHASE 5 — Telegram pref honoured: A (ON) vs B (OFF), same configured bot");
  console.log("telegramConfigured() =", telegramConfigured(), "(MUST be true for this phase to be meaningful)");
  const tgA = await db.notificationLog.count({ where: { userId: "m5_user_a", channel: "telegram" } });
  const tgB = await db.notificationLog.count({ where: { userId: "m5_user_b", channel: "telegram" } });
  const tgARows = await db.notificationLog.findMany({
    where: { userId: "m5_user_a", channel: "telegram" },
    select: { channel: true, recipient: true, outcome: true, errorMessage: true },
  });
  console.log("user A (notifyTelegram=true) telegram rows =", tgA, "->", JSON.stringify(tgARows));
  console.log("user B (notifyTelegram=false) telegram rows =", tgB, "(MUST be 0)");
  console.log(
    `ASSERT telegram pref: A>=1 && B==0 -> ${tgA >= 1 && tgB === 0 ? "PASS" : "FAIL"}`,
  );

  h("RAW DB DUMPS");
  const allNotifs = await db.$queryRawUnsafe(
    'SELECT "userId","eventType","channel","recipient","outcome" FROM "NotificationLog" ORDER BY "createdAt"',
  );
  console.log("NotificationLog:", JSON.stringify(allNotifs, null, 2));

  await db.$disconnect();
}

main().catch((e) => {
  console.error("HARNESS FAILED:", e);
  process.exit(1);
});

