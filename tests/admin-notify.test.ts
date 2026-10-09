import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";

// ---------------------------------------------------------------------------
// TASK_190 S3/S4 — THE GATE for the admin notification channels + the sweep's
// admin pass.
//
// Three layers, each proving what the layer above it cannot:
//   1. ROUTES  — GET/PATCH answer 401 without the admin session (the
//                PROMPT_VERIFY §2.5 contract), PATCH validates the chat id as
//                a numeric string, rejects empty/garbage bodies, and NO
//                response can ever contain the write-only telegramChatId
//                (only the boolean telegramLinked).
//   2. LIB     — against a fake db the REAL lib runs: a missing prefs row
//                reads as both channels OFF + `configured` mirrors env
//                reality; maybeAdminScreenNotify claims the 120-min cooldown
//                with a conditional updateMany that touches ONLY
//                Device.adminNotifyLastSentAt (claimFiring pattern), does
//                nothing when both channels are off (no claim, no log rows —
//                PROMPT_VERIFY §2.3), suppresses a second send inside the
//                window and allows one after it, writes the
//                admin_screen_alert family row with userId null, contains
//                channel failures (dead token ⇒ failed row, no throw), and
//                runAdminNotifyPass picks each device's NEWEST summarized
//                frame newer than the stamp with per-device containment.
//   3. STATIC  — the sweep hook sits AFTER the trigger pass in its OWN
//                try/catch and reports adminAlerts; the header has exactly
//                the two toggles + the paste-chat-id field greying on
//                !configured; the schema comment matches the paste-chat-id
//                design (no webhook claim); the lib is server-only with no
//                reach into the owner's switches.
// ---------------------------------------------------------------------------

(process.env as Record<string, string>).NODE_ENV = "test";
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";

const PREFS_ROUTE = "/app/api/admin/notification-prefs/route.ts";
const SWEEP_ROUTE = "/app/api/internal/screen-notify-sweep/route.ts";
const NOTIFY_LIB = "/lib/admin-notify.ts";
const SHELL = "components/admin/admin-shell.tsx";
const SCHEMA = "prisma/schema.prisma";

const ROOT = path.join(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** Minimal NextResponse stand-in — every return here is `.json(...)`. */
const fakeNextResponse = {
  json: (data: unknown, init?: { status?: number }) => ({
    status: init?.status ?? 200,
    body: data,
    json: async () => data,
  }),
};

// ---------------------------------------------------------------------------
// Fake db — the tables this surface touches. The claim recorder IS the
// assertion: an update that reaches for one extra column, or a WHERE that
// stops honouring the cooldown, shows up here even when the return value
// still looks right.
// ---------------------------------------------------------------------------
interface FakeDeviceRow {
  id: string;
  name: string;
  email: string;
  removedAt: Date | null;
  adminNotifyEnabled: boolean;
  adminNotifyLastSentAt: Date | null;
}

interface FakePrefRow {
  telegramEnabled: boolean;
  emailEnabled: boolean;
  telegramChatId: string | null;
}

interface FakeFrame {
  deviceId: string;
  status: string;
  summary: string | null;
  summarisedAt: Date | null;
  capturedAt: Date;
}

const store: { devices: FakeDeviceRow[]; prefs: FakePrefRow | null; frames: FakeFrame[] } = {
  devices: [],
  prefs: null,
  frames: [],
};

/** Channel/env switches the tests flip (reset in beforeEach). */
const state = { tgConfigured: true, tgThrows: false, emailThrows: false, framesThrow: false };
const fakeEnv = { adminEmail: "boss@example.com", appBaseUrl: "https://sw.test" };

const calls: {
  emails: Array<Record<string, unknown>>;
  telegrams: Array<{ chatId: string; text: string }>;
  logs: Array<Record<string, unknown>>;
  claims: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
  upserts: Array<{ where: unknown; update: Record<string, unknown>; create: Record<string, unknown> }>;
  findManyWhere: Record<string, unknown> | null;
  frameWhere: Record<string, unknown> | null;
} = {
  emails: [],
  telegrams: [],
  logs: [],
  claims: [],
  upserts: [],
  findManyWhere: null,
  frameWhere: null,
};

const fakeDb = {
  adminNotificationPref: {
    findUnique: async () => store.prefs,
    upsert: async (args: {
      where: unknown;
      update: Record<string, unknown>;
      create: Record<string, unknown>;
    }) => {
      calls.upserts.push(args);
      const base = store.prefs ?? {
        telegramEnabled: false,
        emailEnabled: false,
        telegramChatId: null,
      };
      const merge = <K extends "telegramEnabled" | "emailEnabled" | "telegramChatId">(k: K) =>
        k in args.update ? (args.update[k] as FakePrefRow[K]) : base[k];
      store.prefs = {
        telegramEnabled: merge("telegramEnabled"),
        emailEnabled: merge("emailEnabled"),
        telegramChatId: merge("telegramChatId"),
      };
      return store.prefs;
    },
  },
  device: {
    findUnique: async (args: { where: { id: string } }) => {
      const d = store.devices.find((x) => x.id === args.where.id);
      if (!d) return null;
      // One union row — Prisma's `select` only shrinks what is already here.
      return {
        id: d.id,
        name: d.name,
        removedAt: d.removedAt,
        adminNotifyEnabled: d.adminNotifyEnabled,
        adminNotifyLastSentAt: d.adminNotifyLastSentAt,
        user: { email: d.email },
      };
    },
    findMany: async (args: { where: Record<string, unknown> }) => {
      calls.findManyWhere = args.where;
      return store.devices
        .filter((d) => d.adminNotifyEnabled && !d.removedAt)
        .map((d) => ({ id: d.id, adminNotifyLastSentAt: d.adminNotifyLastSentAt }));
    },
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      calls.claims.push(args);
      const d = store.devices.find((x) => x.id === (args.where as { id: string }).id);
      if (!d || !d.adminNotifyEnabled || d.removedAt) return { count: 0 };
      const or = (args.where as { OR: Array<Record<string, unknown>> }).OR;
      const cutoff = (or[1] as { adminNotifyLastSentAt: { lte: Date } }).adminNotifyLastSentAt.lte;
      // Honour the claim WHERE: enabled + not removed + outside the cooldown.
      if (d.adminNotifyLastSentAt !== null && d.adminNotifyLastSentAt > cutoff) return { count: 0 };
      d.adminNotifyLastSentAt = args.data.adminNotifyLastSentAt as Date;
      return { count: 1 };
    },
  },
  deviceScreenshot: {
    findFirst: async (args: { where: Record<string, unknown> }) => {
      if (state.framesThrow) throw new Error("db exploded");
      calls.frameWhere = args.where;
      const deviceId = (args.where as { deviceId: string }).deviceId;
      const gt = (args.where as { summarisedAt: { gt: Date } }).summarisedAt.gt;
      const rows = store.frames
        .filter(
          (f) =>
            f.deviceId === deviceId &&
            f.status === "captured" &&
            f.summary !== null &&
            f.summarisedAt !== null &&
            f.summarisedAt > gt,
        )
        .sort((a, b) => (b.summarisedAt as Date).getTime() - (a.summarisedAt as Date).getTime());
      const f = rows[0];
      if (!f) return null;
      return { summary: f.summary, capturedAt: f.capturedAt };
    },
  },
};

// ---------------------------------------------------------------------------
// Module loader — same machinery as tests/admin-screen-monitor.test.ts: the
// route's own "@/lib/…" imports go through `overrides`, the REAL lib runs on
// fakeDb via its parent-scoped relative branches.
// ---------------------------------------------------------------------------
interface Overrides {
  [request: string]: unknown;
}

let overrides: Overrides = {};

const loader = Module as unknown as {
  _load: (r: string, p: NodeModule | undefined, m: boolean) => unknown;
};
const originalLoad = loader._load;
const SCREEN_NOTIFS_ABS = path.join(ROOT, "lib", "screen-notifications.ts");

loader._load = function patched(request, parent, isMain) {
  if (parent?.filename && request in overrides) return overrides[request];
  if (request === "server-only") return {};
  if (request === "next/server") return { NextResponse: fakeNextResponse };
  const from = parent?.filename ?? "";
  // lib/admin-notify.ts pulls six relative deps — all must resolve to the
  // fakes above, or the "real" module would open a real db handle / throw on
  // missing env in a unit test. The screen-notifications import is LOADED FOR
  // REAL (real cooldownElapsed) with ITS deps faked by the branch below.
  if (from.endsWith("/lib/admin-notify.ts")) {
    if (request === "./db") return { db: fakeDb };
    if (request === "./env") return { env: fakeEnv };
    if (request === "./email")
      return {
        sendEmail: async (opts: Record<string, unknown>) => {
          calls.emails.push(opts);
          if (state.emailThrows) throw new Error("resend down");
        },
      };
    if (request === "./telegram")
      return {
        sendTelegramMessage: async (chatId: string, text: string) => {
          calls.telegrams.push({ chatId, text });
          if (state.tgThrows) throw new Error("telegram down");
        },
        telegramConfigured: () => state.tgConfigured,
      };
    if (request === "./notification-log")
      return {
        writeNotificationLog: async (row: Record<string, unknown>) => void calls.logs.push(row),
      };
    if (request === "./screen-notifications")
      return originalLoad.call(this, SCREEN_NOTIFS_ABS, parent, isMain);
  }
  if (from.endsWith("/lib/screen-notifications.ts")) {
    if (request === "./db") return { db: fakeDb };
    if (request === "./env") return { env: fakeEnv };
    if (request === "./notify") return { notifyUser: async () => {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};

type Result = { status: number; body: unknown };

/** Require a module fresh with `deps` substituted for its imports. */
function loadFresh(file: string, deps: Overrides = {}) {
  const abs = require.resolve(`..${file}`);
  delete require.cache[abs];
  overrides = deps;
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    return require(abs) as Record<string, unknown>;
    /* eslint-enable @typescript-eslint/no-require-imports */
  } finally {
    overrides = {};
  }
}

// The admin session each scenario answers with (null ⇒ the 401 path).
let adminValue: { sub: string } | null;
const ADMIN_DEP = {
  getAdminSession: async () => adminValue,
};

function seedDevice(row: Partial<FakeDeviceRow> = {}): void {
  store.devices.push({
    id: "dev_1",
    name: "Box",
    email: "owner@example.com",
    removedAt: null,
    adminNotifyEnabled: true,
    adminNotifyLastSentAt: null,
    ...row,
  });
}

const T0 = new Date("2026-10-09T12:00:00.000Z");
const req = (body: unknown) => ({ json: async () => body }) as never;

type GetFn = () => Promise<Result>;
type PatchFn = (r: unknown) => Promise<Result>;
type PostFn = (r: unknown) => Promise<Result>;
type MaybeFn = (id: string, summary: string, now: Date, capturedAt?: Date) => Promise<boolean>;
type PassFn = (now?: Date) => Promise<{ eligible: number; notified: number; suppressed: number }>;

beforeEach(() => {
  store.devices.length = 0;
  store.prefs = null;
  store.frames.length = 0;
  state.tgConfigured = true;
  state.tgThrows = false;
  state.emailThrows = false;
  state.framesThrow = false;
  fakeEnv.adminEmail = "boss@example.com";
  calls.emails.length = 0;
  calls.telegrams.length = 0;
  calls.logs.length = 0;
  calls.claims.length = 0;
  calls.upserts.length = 0;
  calls.findManyWhere = null;
  calls.frameWhere = null;
  adminValue = { sub: "admin" };
  overrides = {};
});

// ---------------------------------------------------------------------------
// 1. ROUTES — the prefs surface
// ---------------------------------------------------------------------------

function loadPrefsRoute() {
  return loadFresh(PREFS_ROUTE, { "@/lib/admin-auth": ADMIN_DEP });
}

test("GET and PATCH → 401 without an admin session; nothing is read or written", async () => {
  adminValue = null;
  const route = loadPrefsRoute();
  const getRes = await (route.GET as GetFn)();
  const patchRes = await (route.PATCH as PatchFn)(req({ telegramEnabled: true }));
  assert.equal(getRes.status, 401, "PROMPT_VERIFY §2.5 pins 401 for this route");
  assert.equal(patchRes.status, 401);
  assert.equal(store.prefs, null, "no row was read or created for a stranger");
  assert.equal(calls.upserts.length, 0, "no write for a stranger");
});

test("GET → default-off on a missing row; env-shaped configured; chat id never leaks", async () => {
  const route = loadPrefsRoute();

  // Missing row ⇒ both channels OFF (an alert feature never defaults ON).
  let res = await (route.GET as GetFn)();
  assert.equal(res.status, 200);
  type Body = {
    telegramEnabled: boolean;
    emailEnabled: boolean;
    telegramLinked: boolean;
    configured: { telegram: boolean; email: boolean };
    prefs: { notifyEmail: boolean; notifyTelegram: boolean; telegramLinked: boolean };
  };
  let body = res.body as Body;
  assert.equal(body.telegramEnabled, false);
  assert.equal(body.emailEnabled, false);
  assert.equal(body.telegramLinked, false);
  assert.deepEqual(body.configured, { telegram: true, email: true });
  assert.deepEqual(body.prefs, {
    notifyEmail: false,
    notifyTelegram: false,
    telegramLinked: false,
  });

  // A linked row still never hands the chat id back — only the boolean.
  store.prefs = { telegramEnabled: true, emailEnabled: true, telegramChatId: "9988776655" };
  res = await (route.GET as GetFn)();
  const serialized = JSON.stringify(res.body);
  assert.ok(!serialized.includes("9988776655"), "the write-only chat id never leaves the server");
  assert.ok(!("telegramChatId" in (res.body as Record<string, unknown>)), "no such key at all");
  body = res.body as Body;
  assert.equal(body.telegramLinked, true);
  assert.equal(body.prefs.notifyTelegram, true);
  assert.equal(body.prefs.notifyEmail, true);
});

test("GET → configured mirrors env reality (the UI greys impossible channels)", async () => {
  state.tgConfigured = false;
  fakeEnv.adminEmail = "";
  const route = loadPrefsRoute();
  const res = await (route.GET as GetFn)();
  const body = res.body as { configured: { telegram: boolean; email: boolean } };
  assert.deepEqual(body.configured, { telegram: false, email: false });
});

test("PATCH → chat id + body validation; singleton persisted; safe view echoed", async () => {
  const route = loadPrefsRoute();

  // Non-numeric chat ids are refused BEFORE any write.
  for (const chatId of ["abc", "12.5", "123 456", ""]) {
    const res = await (route.PATCH as PatchFn)(req({ telegramChatId: chatId }));
    assert.equal(res.status, 400, `${JSON.stringify(chatId)} must be refused`);
  }
  // Empty / unknown-key / unparseable bodies refuse too.
  assert.equal((await (route.PATCH as PatchFn)(req({}))).status, 400, "empty body");
  assert.equal((await (route.PATCH as PatchFn)(req({ frobnicate: 1 }))).status, 400, "garbage body");
  const badJson = {
    json: async () => {
      throw new Error("bad json");
    },
  } as never;
  assert.equal((await (route.PATCH as PatchFn)(badJson)).status, 400, "unparseable body");
  assert.equal(calls.upserts.length, 0, "nothing was written for any refused body");

  // The happy path stores the chat id and echoes ONLY the safe view.
  const res = await (route.PATCH as PatchFn)(
    req({ telegramEnabled: true, telegramChatId: "-100123456" }),
  );
  assert.equal(res.status, 200);
  const serialized = JSON.stringify(res.body);
  assert.ok(!serialized.includes("-100123456"), "write-only — even on success");
  assert.equal((res.body as { telegramEnabled: boolean }).telegramEnabled, true);
  assert.equal((res.body as { telegramLinked: boolean }).telegramLinked, true);
  assert.equal(calls.upserts.length, 1);
  assert.deepEqual(calls.upserts[0].update, {
    telegramEnabled: true,
    telegramChatId: "-100123456",
  });
  assert.equal(store.prefs?.telegramChatId, "-100123456");
  assert.equal(store.prefs?.emailEnabled, false, "unpassed keys stay untouched");
});

test("lib: setAdminNotifyPrefs rejects non-numeric chat ids without touching the db", async () => {
  const lib = loadFresh(NOTIFY_LIB);
  const set = lib.setAdminNotifyPrefs as (p: Record<string, unknown>) => Promise<unknown>;
  await assert.rejects(() => set({ telegramChatId: "chat-123" }), /numeric string/);
  await assert.rejects(() => set({ telegramChatId: "+123" }), /numeric string/);
  assert.equal(calls.upserts.length, 0, "a refused id never reaches the db");
});

// ---------------------------------------------------------------------------
// 2. LIB — maybeAdminScreenNotify (claim, cooldown, fan-out, containment)
// ---------------------------------------------------------------------------

test("both channels OFF ⇒ no claim, no sends, no log rows, stamp untouched", async () => {
  seedDevice();
  store.prefs = { telegramEnabled: false, emailEnabled: false, telegramChatId: null };
  const lib = loadFresh(NOTIFY_LIB);
  const ok = await (lib.maybeAdminScreenNotify as MaybeFn)("dev_1", "a summary", T0);
  assert.equal(ok, false);
  assert.equal(calls.claims.length, 0, "nothing to claim when nothing can send");
  assert.equal(calls.emails.length, 0);
  assert.equal(calls.telegrams.length, 0);
  assert.equal(calls.logs.length, 0, "PROMPT_VERIFY §2.3: zero rows");
  assert.equal(store.devices[0].adminNotifyLastSentAt, null, "stamp untouched");
});

test("claim touches ONLY adminNotifyLastSentAt; message names device/owner/capturedAt/summary/link", async () => {
  seedDevice();
  store.prefs = { telegramEnabled: true, emailEnabled: false, telegramChatId: "777" };
  const lib = loadFresh(NOTIFY_LIB);
  const ok = await (lib.maybeAdminScreenNotify as MaybeFn)(
    "dev_1",
    "balance is 900",
    T0,
    new Date("2026-10-09T11:55:00.000Z"),
  );
  assert.equal(ok, true);
  assert.equal(calls.claims.length, 1);
  assert.deepEqual(calls.claims[0].data, { adminNotifyLastSentAt: T0 }, "only the cooldown stamp");
  assert.equal(calls.claims[0].where.adminNotifyEnabled, true);
  assert.equal(calls.claims[0].where.removedAt, null);

  const msg = calls.telegrams[0].text;
  assert.ok(msg.includes("Box"), "device name");
  assert.ok(msg.includes("owner@example.com"), "owner email");
  assert.ok(msg.includes("2026-10-09 11:55"), "capturedAt");
  assert.ok(msg.includes("balance is 900"), "summary text");
  assert.ok(
    msg.includes("/admin=topsecret6199/device/dev_1"),
    "console link (PROMPT_VERIFY §3.2)",
  );

  // The family row: exactly one, ownerless, correct channel/recipient.
  assert.equal(calls.logs.length, 1);
  assert.equal(calls.logs[0].userId, null);
  assert.equal(calls.logs[0].eventType, "admin_screen_alert");
  assert.equal(calls.logs[0].channel, "telegram");
  assert.equal(calls.logs[0].recipient, "777");
  assert.equal(calls.logs[0].outcome, "sent");
  assert.equal(calls.emails.length, 0, "email channel off ⇒ no email attempt");
});

test("cooldown: first send claims, a second inside 120 min is suppressed, one after 121 min goes", async () => {
  seedDevice();
  store.prefs = { telegramEnabled: true, emailEnabled: false, telegramChatId: "777" };
  const lib = loadFresh(NOTIFY_LIB);
  const maybe = lib.maybeAdminScreenNotify as MaybeFn;

  const first = await maybe("dev_1", "frame one", T0);
  assert.equal(first, true);
  assert.equal(calls.telegrams.length, 1);
  assert.equal(store.devices[0].adminNotifyLastSentAt?.getTime(), T0.getTime());

  const second = await maybe("dev_1", "frame two", new Date(T0.getTime() + 10 * 60_000));
  assert.equal(second, false);
  assert.equal(calls.telegrams.length, 1, "suppressed inside the window");
  assert.equal(calls.logs.length, 1, "…and no new log row");
  assert.equal(store.devices[0].adminNotifyLastSentAt?.getTime(), T0.getTime(), "stamp unchanged");

  const third = await maybe("dev_1", "frame three", new Date(T0.getTime() + 121 * 60_000));
  assert.equal(third, true);
  assert.equal(calls.telegrams.length, 2, "allowed after the cooldown");
  assert.equal(calls.logs.length, 2);
});

test("email channel: sendEmail gets eventType admin_screen_alert; we don't double-log", async () => {
  seedDevice();
  store.prefs = { telegramEnabled: false, emailEnabled: true, telegramChatId: null };
  const lib = loadFresh(NOTIFY_LIB);
  const ok = await (lib.maybeAdminScreenNotify as MaybeFn)("dev_1", "secret spreadsheet", T0);
  assert.equal(ok, true);
  assert.equal(calls.emails.length, 1);
  assert.equal(calls.emails[0].eventType, "admin_screen_alert");
  assert.equal(calls.emails[0].to, "boss@example.com");
  assert.equal(calls.telegrams.length, 0);
  // sendEmail writes its own log row in its finally — no family row from us
  // (that would double-count the email channel).
  assert.equal(calls.logs.length, 0);
});

test("channel failures are contained: a dead token logs 'failed' and never throws", async () => {
  seedDevice();
  store.prefs = { telegramEnabled: true, emailEnabled: true, telegramChatId: "777" };
  state.tgThrows = true;
  state.emailThrows = true;
  const lib = loadFresh(NOTIFY_LIB);
  const ok = await (lib.maybeAdminScreenNotify as MaybeFn)("dev_1", "summary", T0);
  assert.equal(ok, true, "the claim already happened — delivery failure is not rethrown");
  assert.equal(calls.emails.length, 1, "email was attempted");
  assert.equal(calls.telegrams.length, 1, "telegram was attempted");
  assert.equal(calls.logs.length, 1, "our telegram family row records the failure");
  assert.equal(calls.logs[0].outcome, "failed");
  assert.match(String(calls.logs[0].errorMessage), /telegram down/);
  assert.equal(calls.logs[0].userId, null);
});

test("notify-off / removed / unknown device ⇒ false with zero db writes", async () => {
  seedDevice({ adminNotifyEnabled: false });
  seedDevice({ id: "dev_gone", removedAt: new Date() });
  store.prefs = { telegramEnabled: true, emailEnabled: false, telegramChatId: "777" };
  const lib = loadFresh(NOTIFY_LIB);
  const maybe = lib.maybeAdminScreenNotify as MaybeFn;
  assert.equal(await maybe("dev_1", "s", T0), false, "device switch off");
  assert.equal(await maybe("dev_gone", "s", T0), false, "soft-removed");
  assert.equal(await maybe("ghost", "s", T0), false, "unknown id");
  assert.equal(calls.claims.length, 0);
  assert.equal(calls.telegrams.length, 0);
});

// ---------------------------------------------------------------------------
// 2b. LIB — runAdminNotifyPass (the sweep pass itself)
// ---------------------------------------------------------------------------

test("runAdminNotifyPass: live+enabled devices only; NEWEST summarized frame since the stamp", async () => {
  seedDevice(); // dev_1 — enabled, never sent
  seedDevice({ id: "dev_off", adminNotifyEnabled: false });
  seedDevice({ id: "dev_gone", adminNotifyEnabled: true, removedAt: new Date() });
  store.prefs = { telegramEnabled: true, emailEnabled: false, telegramChatId: "777" };
  store.frames.push(
    // A null summary never notifies (PROMPT_VERIFY §3.4).
    { deviceId: "dev_1", status: "captured", summary: null, summarisedAt: null, capturedAt: T0 },
    {
      deviceId: "dev_1",
      status: "captured",
      summary: "older frame",
      summarisedAt: new Date("2026-10-09T10:00:00.000Z"),
      capturedAt: new Date("2026-10-09T10:00:00.000Z"),
    },
    {
      deviceId: "dev_1",
      status: "captured",
      summary: "newest frame",
      summarisedAt: new Date("2026-10-09T11:30:00.000Z"),
      capturedAt: new Date("2026-10-09T11:30:00.000Z"),
    },
    {
      deviceId: "dev_off",
      status: "captured",
      summary: "should not be seen",
      summarisedAt: new Date("2026-10-09T11:30:00.000Z"),
      capturedAt: T0,
    },
  );
  const lib = loadFresh(NOTIFY_LIB);
  const res = await (lib.runAdminNotifyPass as PassFn)(T0);
  assert.equal(res.eligible, 1, "only the enabled live device is eligible");
  assert.equal(res.notified, 1);
  assert.equal(res.suppressed, 0);
  assert.equal(calls.findManyWhere?.adminNotifyEnabled, true);
  assert.equal(calls.findManyWhere?.removedAt, null);

  const msg = calls.telegrams[0].text;
  assert.ok(msg.includes("newest frame"), "newest summarized frame wins");
  assert.ok(!msg.includes("older frame"), "the older one is not the pick");
  // Never-sent device ⇒ the frame window starts at the epoch; captured only.
  assert.equal((calls.frameWhere?.summarisedAt as { gt: Date }).gt.getTime(), 0);
  assert.equal(calls.frameWhere?.status, "captured");
  assert.ok(
    JSON.stringify(calls.frameWhere?.summary).includes("not"),
    "summary:{not:null} — a null summary never notifies",
  );
});

test("runAdminNotifyPass: no newer frame ⇒ suppressed; per-device failure contained", async () => {
  seedDevice();
  store.prefs = { telegramEnabled: true, emailEnabled: false, telegramChatId: "777" };
  store.frames.push({
    deviceId: "dev_1",
    status: "captured",
    summary: "already reported",
    summarisedAt: new Date("2026-10-09T11:00:00.000Z"),
    capturedAt: new Date("2026-10-09T11:00:00.000Z"),
  });
  const lib = loadFresh(NOTIFY_LIB);
  const pass = lib.runAdminNotifyPass as PassFn;

  // First pass: the frame is newer than epoch ⇒ claim + send.
  const first = await pass(T0);
  assert.equal(first.notified, 1);
  assert.equal(calls.telegrams.length, 1);

  // Second pass: nothing newer than the fresh stamp ⇒ suppressed, no send.
  const second = await pass(new Date(T0.getTime() + 60_000));
  assert.equal(second.notified, 0);
  assert.equal(second.suppressed, 1);
  assert.equal(calls.telegrams.length, 1, "no second send without a newer frame");

  // A broken device (frame lookup explodes) is contained per device.
  state.framesThrow = true;
  const third = await pass(T0);
  assert.equal(third.eligible, 1);
  assert.equal(third.suppressed, 1, "the failure is contained, not rethrown");
  state.framesThrow = false;
});

// ---------------------------------------------------------------------------
// 3. ROUTE — the sweep hook (the admin pass must never take the sweep down)
// ---------------------------------------------------------------------------

/** Load the sweep route with everything faked; `order` records pass sequence. */
function loadSweepRoute(adminPassFactory: (order: string[]) => unknown) {
  const order: string[] = [];
  const route = loadFresh(SWEEP_ROUTE, {
    "@/lib/internal-auth": { requireInternalBearer: () => true },
    "@/lib/prisma": { prisma: { user: { findMany: async () => [{ id: "u1" }] } } },
    "@/lib/screen-notifications": {
      runTriggerPass: async () => {
        order.push("triggers");
        return { scanned: 0, fired: 0, results: [] };
      },
      screenDigestDue: async () => true,
      buildScreenDigest: async () => {
        order.push("digest");
        return { status: "generated" };
      },
    },
    "@/lib/admin-notify": adminPassFactory(order),
  });
  return { route, order };
}

test("sweep: admin pass runs AFTER triggers, BEFORE digests, and is reported as adminAlerts", async () => {
  const { route, order } = loadSweepRoute((o) => ({
    runAdminNotifyPass: async () => {
      o.push("admin");
      return { eligible: 0, notified: 0, suppressed: 0 };
    },
  }));
  const res = await (route.POST as PostFn)({} as never);
  assert.equal(res.status, 200);
  assert.deepEqual(order, ["triggers", "admin", "digest"], "admin pass sits between the two");
  const body = res.body as {
    triggers: unknown;
    adminAlerts: { eligible: number; notified: number; suppressed: number };
    digests: { generated: number };
  };
  assert.deepEqual(body.adminAlerts, { eligible: 0, notified: 0, suppressed: 0 });
  assert.ok(body.triggers, "trigger pass still reported");
  assert.equal(body.digests.generated, 1, "digest pass still ran");
});

test("sweep: a throwing admin pass is contained — 200 with adminAlerts.error, digests still run", async () => {
  const { route, order } = loadSweepRoute(() => ({
    runAdminNotifyPass: async () => {
      throw new Error("telegram exploded");
    },
  }));
  const res = await (route.POST as PostFn)({} as never);
  assert.equal(res.status, 200, "the sweep survives a failing admin pass");
  const body = res.body as { adminAlerts: { error: string }; digests: { generated: number } };
  assert.match(body.adminAlerts.error, /telegram exploded/);
  assert.equal(body.digests.generated, 1, "digests ran anyway");
  assert.ok(order.includes("triggers"), "…and so did the trigger pass");
});

// ---------------------------------------------------------------------------
// 4. STATIC — source-level contracts the runtime tests can't see
// ---------------------------------------------------------------------------

test("static: sweep hook sits after the trigger CALL, inside its own try/catch, and is reported", () => {
  const sweep = read("/app/api/internal/screen-notify-sweep/route.ts");
  const triggerCall = sweep.indexOf("await runTriggerPass()");
  const adminCall = sweep.indexOf("adminPass = await runAdminNotifyPass()");
  assert.ok(triggerCall > -1 && adminCall > triggerCall, "the admin pass runs after the trigger pass");
  assert.match(
    sweep,
    /try \{\s*adminPass = await runAdminNotifyPass\(\)/,
    "its own try/catch — a failure cannot take the sweep down",
  );
  assert.ok(sweep.includes("adminAlerts: adminPass"), "…and the outcome is reported");
});

test("static: prefs route — 401 auth, numeric chat id at the edge, safe view cannot carry it", () => {
  const route = read("/app/api/admin/notification-prefs/route.ts");
  assert.equal((route.match(/export async function/g) ?? []).length, 2, "GET + PATCH only");
  assert.ok(route.includes("{ status: 401 }"), "PROMPT_VERIFY §2.5 pins 401");
  assert.ok(route.includes("regex(/^-?\\d+$/"), "numeric chat id rule at the edge");
  const safe = route.slice(
    route.indexOf("async function safeView"),
    route.indexOf("export async function GET"),
  );
  assert.ok(safe.length > 0, "GET and PATCH share one response builder");
  assert.ok(!safe.includes("telegramChatId"), "the builder cannot name the chat id");
  assert.ok(safe.includes("telegramLinked"), "…only the boolean");
});

test("static: header has exactly two toggles + paste-chat-id, greying on !configured", () => {
  const shell = read(SHELL);
  assert.equal((shell.match(/role="switch"/g) ?? []).length, 2, "Notifications [Telegram] [Email]");
  assert.equal((shell.match(/aria-label="Telegram"/g) ?? []).length, 1);
  assert.equal((shell.match(/aria-label="Email"/g) ?? []).length, 1);
  assert.ok(shell.includes("/api/admin/notification-prefs"));
  assert.ok(shell.includes('method: "PATCH"'));
  assert.ok(shell.includes("Telegram: not connected →"));
  assert.ok(shell.includes("paste chat id"));
  assert.ok(shell.includes("prefs.configured.telegram"), "greys Telegram on !configured");
  assert.ok(shell.includes("prefs.configured.email"), "…and Email the same way");
});

test("static: schema documents paste-chat-id (webhook claim gone); lib is server-only + ownerless", () => {
  const schema = read(SCHEMA);
  const modelAt = schema.indexOf("model AdminNotificationPref {");
  assert.ok(modelAt > -1, "the singleton model exists");
  const comment = schema.slice(modelAt - 1000, modelAt);
  assert.ok(comment.includes("WRITE-ONLY"), "the chat id is write-only by design");
  assert.ok(comment.includes("paste"), "paste-chat-id flow documented");
  assert.ok(!comment.includes("webhook"), "the webhook claim is gone (PROMPT_CONTINUE)");

  const lib = read(NOTIFY_LIB);
  assert.ok(lib.includes('import "server-only"'));
  assert.ok(lib.includes('ADMIN_NOTIFY_EVENT_TYPE = "admin_screen_alert"'));
  assert.ok(lib.includes("ADMIN_NOTIFY_COOLDOWN_MINUTES = 120"));
  assert.ok(lib.includes("userId: null"), "admin-path log rows are ownerless");
  assert.ok(lib.includes("cooldownElapsed("), "the shared cooldown helper is reused");
  assert.ok(!lib.includes("screenTriggerNotificationsEnabled"), "owner trigger switch unreachable");
  assert.ok(!lib.includes("screenDigestEnabled"), "owner digest switch unreachable");
});
