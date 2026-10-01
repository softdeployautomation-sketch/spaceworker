/**
 * TASK_152 M6 — scratch-DB evidence harness for the capture scheduler
 * (headroom concurrency, per-user fairness, rotation).
 *
 * NOT part of the shipped app. It drives the REAL `runCapturePass` /
 * `requestSlot` / `deviceScreenshots` governor slot against a REAL Postgres
 * scratch DB (built from schema.prisma), and dumps RAW rows/counts.
 *
 * SIMULATION, NOT "VERIFIED LIVE": the capture function is INJECTED (a stub
 * that writes a byte to the prepared path) because there is no real device /
 * Playwright / MeshCentral locally — the end-to-end browser capture CANNOT be
 * reproduced here and is not claimed. Everything else (due logic, the governor
 * slot as the single admission authority, the persisted rotation cursor) is the
 * real code path.
 *
 * Run (from the repo root):
 *   NODE_OPTIONS='--conditions=react-server' \
 *   DATABASE_URL='postgresql://spaceworker_app:sw_dev_pw@127.0.0.1:5432/spaceworker_t152_m6' \
 *   SESSION_SECRET=x RESEND_API_KEY=x EMAIL_FROM=t@t.test APP_BASE_URL='https://t.test' \
 *   SCREENSHOT_BASE_DIR="$(mktemp -d)" \
 *   npx tsx scripts/task152-m6-evidence.ts [all|restart1|restart2]
 *
 * `restart1` then `restart2` are run as TWO SEPARATE OS processes so the
 * persisted-cursor-across-restart claim is real, not simulated in-process.
 */
import { writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { db } from "../lib/db";
import {
  runCapturePass,
  resolveScreenshotSettings,
  screenshotBaseDir,
  type CaptureFn,
} from "../lib/device-screenshots";
import { sweepGovernor } from "../lib/resource-governor";
import type { PressureSnapshot } from "../lib/resource-governor";

const T0 = new Date("2026-10-01T12:00:00.000Z");
const SLICE_MIN = 25; // matches the schema default screenshotRotationSliceMinutes
const h = (s: string) => console.log(`\n======== ${s} ========`);

// A controlled pressure snapshot: measured, RAM well under the governor's
// default warn line (75%), i.e. the box HAS headroom unless a scenario says
// otherwise. Injected so the host's own load never decides the outcome.
function pressure(ramUsedPct: number, level: PressureSnapshot["level"] = "normal"): PressureSnapshot {
  return {
    level,
    measured: true,
    ramUsedPct,
    ramTotalMb: 8192,
    ramAvailableMb: 8192,
    swapUsedMb: 0,
    swapTotalMb: 0,
    load1: 0.1,
    cpuCount: 4,
    reason: level === "normal" ? "" : `ram ${ramUsedPct.toFixed(1)}%`,
  };
}

/** The injected (simulated) browser. Writes one byte to the prepared path. */
const simCapture: CaptureFn = async (_device, framePath) => {
  await writeFile(framePath, "x");
  return {
    filePath: relative(screenshotBaseDir(), framePath),
    bytes: 1,
    width: 10,
    height: 10,
  };
};

async function reset(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE "GovernorQueueEntry","ScreenshotRotationCursor","DeviceScreenshot",' +
      '"Device","User","AdminSetting" CASCADE',
  );
}

async function seedAdmin(over: Record<string, unknown> = {}): Promise<void> {
  await db.adminSetting.upsert({
    where: { id: "singleton" },
    update: over,
    create: {
      id: "singleton",
      screenshotMonitoringEnabled: true,
      ...over,
    },
  });
}

async function seedUser(id: string, email: string): Promise<void> {
  await db.user.create({ data: { id, email, passwordHash: "x" } });
}

async function seedDevice(id: string, userId: string, name: string, online = true): Promise<void> {
  await db.device.create({
    data: { id, userId, name, status: online ? "online" : "offline", screenshotMonitoringEnabled: true },
  });
}


/** Raw DB view of every frame + cursor + queue row. */
async function dump(label: string): Promise<void> {
  const frames = await db.$queryRawUnsafe<{ status: string; deviceId: string }[]>(
    'SELECT status, "deviceId" FROM "DeviceScreenshot" ORDER BY "createdAt"',
  );
  const byStatus: Record<string, number> = {};
  const byDevice: Record<string, number> = {};
  for (const f of frames) {
    byStatus[f.status] = (byStatus[f.status] ?? 0) + 1;
    if (f.status === "captured") byDevice[f.deviceId] = (byDevice[f.deviceId] ?? 0) + 1;
  }
  console.log(`${label} DeviceScreenshot rows = ${frames.length}; byStatus=${JSON.stringify(byStatus)}`);
  console.log(`${label} captured-per-device = ${JSON.stringify(byDevice)}`);
  const cursors = await db.$queryRawUnsafe<
    { userId: string; cursorDeviceId: string | null; rotatedAt: Date }[]
  >('SELECT "userId","cursorDeviceId","rotatedAt" FROM "ScreenshotRotationCursor" ORDER BY "userId"');
  console.log(`${label} ScreenshotRotationCursor rows = ${JSON.stringify(cursors)}`);
  const q = await db.$queryRawUnsafe<{ status: string }[]>('SELECT status FROM "GovernorQueueEntry"');
  console.log(`${label} GovernorQueueEntry rows = ${JSON.stringify(q)}`);
}

function summarize(
  pass: {
    attempted: number;
    captured: number;
    failed: number;
    queued: number;
    deferred: number;
    rotatingUsers: number;
    parallel: boolean;
  },
  tag: string,
): void {
  console.log(
    `  [${tag}] attempted=${pass.attempted} captured=${pass.captured} failed=${pass.failed} ` +
      `queued=${pass.queued} deferred=${pass.deferred} rotatingUsers=${pass.rotatingUsers} parallel=${pass.parallel}`,
  );
}

// ---------------------------------------------------------------------------
// Scenario A — one slot, four devices (pure rotation)
// ---------------------------------------------------------------------------
async function scenarioRotation(): Promise<void> {
  h("SCENARIO A — cap=1, ONE user with FOUR devices: rotation across successive passes");
  await reset();
  await seedAdmin({
    screenshotCapturesMaxConcurrent: 1,
    screenshotCaptureIntervalMinutes: 1,
    screenshotRotationSliceMinutes: SLICE_MIN,
    screenshotHeadroomRamPct: 0, // inherit governorRamWarnPct (75)
    governorEnabled: false,
  });
  await seedUser("uA", "a@m6.test");
  for (const n of [1, 2, 3, 4]) await seedDevice(`m6_A${n}`, "uA", `A device ${n}`);
  console.log("seeded: cap=1, 4 devices (m6_A1..m6_A4), slice=25m, interval=1m, governorEnabled=false");
  await dump("BEFORE");

  // Effective dials actually resolved by the code (proves the RAM line is the
  // governor's warn line, not a third hardcoded number).
  const eff = resolveScreenshotSettings(await db.adminSetting.findUnique({ where: { id: "singleton" } }));
  console.log("resolved settings:", JSON.stringify(eff));

  for (let i = 0; i < 5; i++) {
    const now = new Date(T0.getTime() + i * 30 * 60_000);
    const pass = await runCapturePass(simCapture, { now, pressure: pressure(50) });
    summarize(pass, `pass ${i + 1} @ ${now.toISOString()}`);
    console.log(`    results: ${JSON.stringify(pass.results.map((r) => `${r.deviceId}:${r.status}`))}`);
  }
  await dump("AFTER");
  const counts = await db.$queryRawUnsafe<{ deviceId: string; n: bigint }[]>(
    'SELECT "deviceId", count(*) AS n FROM "DeviceScreenshot" WHERE status=\'captured\' GROUP BY "deviceId" ORDER BY "deviceId"',
  );
  console.log(
    "RAW captured-per-device:",
    JSON.stringify(counts, (_, v) => (typeof v === "bigint" ? Number(v) : v)),
  );
}

// ---------------------------------------------------------------------------
// Scenario B — raise the cap mid-run (rotation -> parallel, no restart)
// ---------------------------------------------------------------------------
async function scenarioRaiseCap(): Promise<void> {
  h("SCENARIO B — SAME state, cap RAISED 1 -> 4 mid-run: switches to PARALLEL, rotation stops");
  await reset();
  await seedAdmin({
    screenshotCapturesMaxConcurrent: 1,
    screenshotCaptureIntervalMinutes: 1,
    screenshotRotationSliceMinutes: SLICE_MIN,
    screenshotHeadroomRamPct: 0,
    governorEnabled: false,
  });
  await seedUser("uA", "a@m6.test");
  for (const n of [1, 2, 3, 4]) await seedDevice(`m6_A${n}`, "uA", `A device ${n}`);

  const p1 = await runCapturePass(simCapture, { now: T0, pressure: pressure(50) });
  summarize(p1, "cap=1 pass (rotating)");
  await dump("after cap=1 pass");

  // Raise the cap by writing the AdminSetting row ONLY — no process restart,
  // no code change. The next call re-derives everything from current state.
  await db.adminSetting.update({
    where: { id: "singleton" },
    data: { screenshotCapturesMaxConcurrent: 4 },
  });
  console.log("\nADMIN ACTION: screenshotCapturesMaxConcurrent 1 -> 4 (DB write only, same process)");
  const p2 = await runCapturePass(simCapture, {
    now: new Date(T0.getTime() + 60 * 60_000),
    pressure: pressure(50),
  });
  summarize(p2, "cap=4 pass (parallel?)");
  console.log(`  results: ${JSON.stringify(p2.results.map((r) => `${r.deviceId}:${r.status}`))}`);
  await dump("after cap=4 pass");
}

// ---------------------------------------------------------------------------
// Scenario C — lower the cap mid-run (parallel -> rotation, NOTHING lost)
// ---------------------------------------------------------------------------
async function scenarioLowerCap(): Promise<void> {
  h("SCENARIO C — cap RAISED then LOWERED back to 1 mid-run: degrades to rotation, LOSES NO WORK");
  await reset();
  await seedAdmin({
    screenshotCapturesMaxConcurrent: 4,
    screenshotCaptureIntervalMinutes: 1,
    screenshotRotationSliceMinutes: SLICE_MIN,
    screenshotHeadroomRamPct: 0,
    governorEnabled: false,
  });
  await seedUser("uA", "a@m6.test");
  for (const n of [1, 2, 3, 4]) await seedDevice(`m6_A${n}`, "uA", `A device ${n}`);

  const p1 = await runCapturePass(simCapture, { now: T0, pressure: pressure(50) });
  summarize(p1, "cap=4 pass (parallel)");
  await dump("after cap=4 pass");

  await db.adminSetting.update({
    where: { id: "singleton" },
    data: { screenshotCapturesMaxConcurrent: 1 },
  });
  console.log("\nADMIN ACTION: screenshotCapturesMaxConcurrent 4 -> 1 (DB write only, same process)");

  // Successive passes at +30m steps; every device must be captured, none failed.
  for (let i = 1; i <= 4; i++) {
    const now = new Date(T0.getTime() + i * 30 * 60_000);
    const pass = await runCapturePass(simCapture, { now, pressure: pressure(50) });
    summarize(pass, `cap=1 pass ${i}`);
    console.log(`    results: ${JSON.stringify(pass.results.map((r) => `${r.deviceId}:${r.status}`))}`);
  }
  await dump("AFTER");
  const failed = await db.deviceScreenshot.count({ where: { status: "failed" } });
  console.log(`RAW failed rows = ${failed} (MUST be 0 — degradation must not fail anything)`);
}

// ---------------------------------------------------------------------------
// Scenario D — two users: one many-device, one single (fairness)
// ---------------------------------------------------------------------------
async function scenarioFairness(): Promise<void> {
  h("SCENARIO D — TWO users (A: 4 devices, B: 1 device), cap=2: B keeps getting captures");
  await reset();
  await seedAdmin({
    screenshotCapturesMaxConcurrent: 2,
    screenshotCaptureIntervalMinutes: 1,
    screenshotRotationSliceMinutes: SLICE_MIN,
    screenshotHeadroomRamPct: 0,
    governorEnabled: false,
  });
  await seedUser("uA", "a@m6.test");
  await seedUser("uB", "b@m6.test");
  for (const n of [1, 2, 3, 4]) await seedDevice(`m6_A${n}`, "uA", `A device ${n}`);
  await seedDevice("m6_B1", "uB", "B device 1");
  console.log("seeded: user A 4 devices, user B 1 device, cap=2");

  for (let i = 0; i < 3; i++) {
    const now = new Date(T0.getTime() + i * 30 * 60_000);
    const pass = await runCapturePass(simCapture, { now, pressure: pressure(50) });
    summarize(pass, `pass ${i + 1}`);
    console.log(`    results: ${JSON.stringify(pass.results.map((r) => `${r.deviceId}:${r.status}`))}`);
  }
  await dump("AFTER");
  const perUser = await db.$queryRawUnsafe<{ userId: string; n: bigint }[]>(
    'SELECT "userId", count(*) AS n FROM "DeviceScreenshot" WHERE status=\'captured\' GROUP BY "userId" ORDER BY "userId"',
  );
  console.log(
    "RAW captured-per-USER:",
    JSON.stringify(perUser, (_, v) => (typeof v === "bigint" ? Number(v) : v)),
  );
}

// ---------------------------------------------------------------------------
// Scenario F — governor ON: work that cannot run STAYS QUEUED (durable row)
// and eventually runs, with no lost frames and no contention-caused failures.
// ---------------------------------------------------------------------------
async function scenarioQueuedWork(): Promise<void> {
  h("SCENARIO F — governor ON, cap=1, TWO users each 1 device: the loser stays QUEUED, later runs");
  await reset();
  await seedAdmin({
    screenshotCapturesMaxConcurrent: 1,
    screenshotCaptureIntervalMinutes: 1,
    screenshotRotationSliceMinutes: SLICE_MIN,
    screenshotHeadroomRamPct: 0,
    governorEnabled: true,
    governorQueueTimeoutSec: 900,
  });
  await seedUser("uA", "a@m6.test");
  await seedUser("uB", "b@m6.test");
  await seedDevice("m6_A1", "uA", "A device 1");
  await seedDevice("m6_B1", "uB", "B device 1");
  console.log("seeded: governor ON, cap=1, user A 1 device + user B 1 device");

  for (let i = 0; i < 4; i++) {
    const now = new Date(T0.getTime() + i * 30 * 60_000);
    const pass = await runCapturePass(simCapture, { now, pressure: pressure(50) });
    summarize(pass, `capture-sweep tick ${i + 1}`);
    console.log(`    results: ${JSON.stringify(pass.results.map((r) => `${r.deviceId}:${r.status}`))}`);
    const q1 = await db.$queryRawUnsafe<{ ref: string; status: string }[]>(
      'SELECT ref, status FROM "GovernorQueueEntry" WHERE feature=\'deviceScreenshots\' ORDER BY "requestedAt"',
    );
    console.log(`    GovernorQueueEntry after capture-sweep = ${JSON.stringify(q1)}`);
    // The governor-sweep timer (separate systemd unit, every minute) drains the
    // head of each feature's queue here — the exact production pairing.
    const drain = await sweepGovernor({ pressure: pressure(50), now });
    console.log(`    governor-sweep: byFeature=${JSON.stringify(drain.byFeature)}`);
    const q2 = await db.$queryRawUnsafe<{ ref: string; status: string }[]>(
      'SELECT ref, status FROM "GovernorQueueEntry" WHERE feature=\'deviceScreenshots\' ORDER BY "requestedAt"',
    );
    console.log(`    GovernorQueueEntry after governor-sweep = ${JSON.stringify(q2)}`);
  }
  await dump("AFTER");
  const failed = await db.deviceScreenshot.count({ where: { status: "failed" } });
  const perUser = await db.$queryRawUnsafe<{ userId: string; n: bigint }[]>(
    'SELECT "userId", count(*) AS n FROM "DeviceScreenshot" WHERE status=\'captured\' GROUP BY "userId" ORDER BY "userId"',
  );
  console.log(
    "RAW captured-per-USER:",
    JSON.stringify(perUser, (_, v) => (typeof v === "bigint" ? Number(v) : v)),
  );
  console.log(`RAW failed rows = ${failed} (MUST be 0 — contention must not fail anything)`);
}

// ---------------------------------------------------------------------------
// Scenario E — persisted cursor across a REAL process restart
// ---------------------------------------------------------------------------
async function scenarioRestart1(): Promise<void> {
  h("SCENARIO E (process 1) — seed + first pass, then EXIT");
  await reset();
  await seedAdmin({
    screenshotCapturesMaxConcurrent: 1,
    screenshotCaptureIntervalMinutes: 1,
    screenshotRotationSliceMinutes: SLICE_MIN,
    screenshotHeadroomRamPct: 0,
    governorEnabled: false,
  });
  await seedUser("uA", "a@m6.test");
  for (const n of [1, 2, 3, 4]) await seedDevice(`m6_A${n}`, "uA", `A device ${n}`);
  const pass = await runCapturePass(simCapture, { now: T0, pressure: pressure(50) });
  summarize(pass, "process-1 pass");
  await dump("process 1 (about to exit)");
}

async function scenarioRestart2(): Promise<void> {
  h("SCENARIO E (process 2, FRESH node) — read the persisted cursor, advance to the next device");
  // This is a NEW process: nothing from process 1 is in memory. The only thing
  // that can carry the rotation forward is the DB row.
  await dump("process 2 BEFORE any pass");
  const pass = await runCapturePass(simCapture, {
    now: new Date(T0.getTime() + 30 * 60_000),
    pressure: pressure(50),
  });
  summarize(pass, "process-2 pass");
  console.log(`  results: ${JSON.stringify(pass.results.map((r) => `${r.deviceId}:${r.status}`))}`);
  await dump("process 2 AFTER");
}

async function main(): Promise<void> {
  console.log(
    "TASK_152 M6 capture-scheduler evidence — SIMULATION (injected capture; no real device/Playwright)",
  );
  const mode = process.argv[2] ?? "all";
  console.log(
    "legend: parallel = cross-user parallelism allowed this pass (idle box, one user);" +
      " rotatingUsers = users >1 device whose roster exceeds slots; deferred = 'not its turn yet'",
  );
  if (mode === "restart1") await scenarioRestart1();
  else if (mode === "restart2") await scenarioRestart2();
  else {
    await scenarioRotation();
    await scenarioRaiseCap();
    await scenarioLowerCap();
    await scenarioFairness();
    await scenarioQueuedWork();
  }
  console.log("\nDONE.");
  await db.$disconnect();
}

main().catch((e) => {
  console.error("HARNESS FAILED:", e);
  process.exit(1);
});

