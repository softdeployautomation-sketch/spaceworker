/**
 * TASK_152 M7 — scratch-DB evidence harness. NOT part of the shipped app.
 *
 * WHY IT EXISTS: the acceptance bar is "a raw agent-context fetch shows the
 * user's OWN monitor summaries present for a user with monitors and
 * absent/empty for a user without". This drives the REAL
 * lib/monitor-agent-context.ts (and the REAL listRecentFrames read model) against
 * REAL DeviceScreenshot.summary rows in a scratch DB, and prints the raw rows and
 * the raw block it returns.
 *
 *   NODE_OPTIONS='--conditions=react-server' \
 *   DATABASE_URL=postgresql://.../spaceworker_t152_m7 \
 *   SESSION_SECRET=x RESEND_API_KEY=x npx tsx scripts/task152-m7-evidence.ts
 *
 * The END-TO-END turn (runAgentTurn handing this block to the model) is covered in
 * tests/monitor-agent-context.test.ts with a RECORDED fake relay, because there is
 * no real relay locally. THIS script proves the DB reads behind that block.
 */
import { db } from "../lib/db";
import { aiCapReached, getUsedAiTodayHundredthsCent } from "../lib/ai-metering";
import {
  buildMonitorSummaryContext,
  collectMonitorSummaries,
} from "../lib/monitor-agent-context";

const h = (s: string) => console.log(`\n==== ${s} ====`);
const BLOCK_MARKER = "recent screen-activity summaries from this user's OWN";
const summaryDate = new Date("2026-10-01T00:00:00.000Z");

async function resetDb(): Promise<void> {
  await db.$executeRawUnsafe('TRUNCATE "AiUsageLog","DeviceScreenshot","Device","User" CASCADE');
}

async function seed(): Promise<void> {
  // (1) monitored device WITH a summary, plus a not-yet-summarised frame.
  await db.user.create({ data: { id: "m7_mon", email: "mon@m7.test", passwordHash: "x" } });
  await db.device.create({
    data: { id: "m7_dev", userId: "m7_mon", name: "Editing Rig", screenshotMonitoringEnabled: true },
  });
  await db.deviceScreenshot.create({
    data: {
      id: "m7_frame1", deviceId: "m7_dev", userId: "m7_mon", status: "captured",
      summary: "Grading footage in DaVinci Resolve.", summaryModel: "vision-1",
      summarisedAt: new Date("2026-10-01T11:59:00.000Z"), summaryDate,
      capturedAt: new Date("2026-10-01T11:58:00.000Z"), bytes: 4096, width: 1920, height: 1080,
    },
  });
  await db.deviceScreenshot.create({
    data: {
      id: "m7_frame2", deviceId: "m7_dev", userId: "m7_mon", status: "captured",
      summary: null, summaryError: "cap_exhausted", summaryDate,
      capturedAt: new Date("2026-10-01T11:59:30.000Z"), bytes: 5120, width: 1920, height: 1080,
    },
  });

  // (2) monitored device, but NOTHING summarised yet (the NORMAL early state).
  await db.user.create({ data: { id: "m7_pending", email: "pending@m7.test", passwordHash: "x" } });
  await db.device.create({
    data: { id: "m7_dev_pending", userId: "m7_pending", name: "New Box", screenshotMonitoringEnabled: true },
  });
  await db.deviceScreenshot.create({
    data: {
      id: "m7_frame3", deviceId: "m7_dev_pending", userId: "m7_pending", status: "captured",
      summaryDate, capturedAt: new Date("2026-10-01T11:59:00.000Z"),
    },
  });

  // (3) monitoring OPTED OUT, yet a summary exists on the row — must stay invisible.
  await db.user.create({ data: { id: "m7_optout", email: "optout@m7.test", passwordHash: "x" } });
  await db.device.create({
    data: { id: "m7_dev_off", userId: "m7_optout", name: "Off Box", screenshotMonitoringEnabled: false },
  });
  await db.deviceScreenshot.create({
    data: {
      id: "m7_frame4", deviceId: "m7_dev_off", userId: "m7_optout", status: "captured",
      summary: "Should never reach the agent.", summaryDate,
      capturedAt: new Date("2026-10-01T11:59:00.000Z"),
    },
  });

  // (4) a user with no devices at all.
  await db.user.create({ data: { id: "m7_none", email: "none@m7.test", passwordHash: "x" } });
}

async function main(): Promise<void> {
  if (!process.argv.includes("--no-reset")) await resetDb();
  await seed();

  h("RAW DeviceScreenshot rows in the scratch DB");
  const frames = await db.deviceScreenshot.findMany({
    select: { id: true, deviceId: true, userId: true, status: true, summary: true, summaryError: true },
    orderBy: { createdAt: "asc" },
  });
  for (const f of frames) console.log("FRAME  " + JSON.stringify(f));
  const devices = await db.device.findMany({
    select: { id: true, userId: true, name: true, screenshotMonitoringEnabled: true },
    orderBy: { createdAt: "asc" },
  });
  for (const d of devices) console.log("DEVICE " + JSON.stringify(d));

  // The pre-M7 assembly expression, reproduced VERBATIM from git HEAD:lib/agent.ts
  // (`const systemContent = opts.pageContext ? ... : AGENT_SYSTEM_PROMPT;`). It had
  // NO path to monitor summaries at all — the failing condition for M7.
  const pageContext = undefined as string | undefined;
  const preM7Extra = pageContext ? `Current page context: ${pageContext}` : null;

  for (const userId of ["m7_mon", "m7_pending", "m7_optout", "m7_none"]) {
    h(`AGENT CONTEXT for ${userId}`);
    const collected = await collectMonitorSummaries(userId);
    console.log("collectMonitorSummaries      → " + JSON.stringify(collected));
    const block = await buildMonitorSummaryContext(userId);
    console.log("buildMonitorSummaryContext   → " + (block === null ? "null" : JSON.stringify(block)));

    const postM7Extra = [block, pageContext ? `Current page context: ${pageContext}` : null]
      .filter(Boolean)
      .join("\n\n");
    console.log(
      "PRE-M7  system-message extra  → " +
        (preM7Extra === null ? "null (nothing but the prompt)" : preM7Extra) +
        " ; contains monitor block? " +
        (preM7Extra ?? "").includes(BLOCK_MARKER),
    );
    console.log(
      "POST-M7 system-message extra  → " +
        (postM7Extra === "" ? "null" : `${postM7Extra.split("\n").length} lines`) +
        " ; contains monitor block? " +
        postM7Extra.includes(BLOCK_MARKER),
    );
  }

  h("AI CAP over REAL AiUsageLog rows (the cap the retrieval must not bypass)");
  const cap = 500;
  await db.aiUsageLog.create({
    data: { userId: "m7_mon", costHundredthsCent: cap, eventType: "agent_turn" },
  });
  const used = await getUsedAiTodayHundredthsCent("m7_mon");
  console.log(`usedToday=${used}  cap=${cap}  aiCapReached=${aiCapReached(used, cap)}`);
  const logCount = await db.aiUsageLog.count({ where: { userId: "m7_mon" } });
  console.log(`AiUsageLog rows for m7_mon = ${logCount}`);
}

main()
  .then(() => db.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await db.$disconnect();
    process.exit(1);
  });

