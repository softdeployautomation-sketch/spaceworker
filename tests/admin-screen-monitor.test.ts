import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";

// ---------------------------------------------------------------------------
// TASK_190 S2 — THE GATE for the screen-monitor surface + the S1 Actions menu.
//
// Three layers, each proving what the layer above it cannot:
//   1. ROUTES  — GET/PATCH are 403 without the admin session, deep-404 (NEVER
//                403) for unknown AND soft-deleted devices, 400 on garbage or
//                empty bodies.
//   2. LIB     — against a fake db the REAL lib runs: a PATCH writes ONLY the
//                one/two switch keys it was asked for (the owner's trigger/
//                digest columns provably unreachable) and writes one audit
//                row per CHANGED switch on the OWNER's user id. GET returns
//                the switches + the read-only global cadence/retention + the
//                newest CAPTURED frame, where summary: null is passed through
//                as-is (that is NORMAL) — never coerced into an error.
//   3. STATIC  — the dropdown has exactly the three S1 items and lives in the
//                ACTIVE row only (Deleted rows keep the plain silent-viewer
//                button), the panel's "no summary yet" copy stays neutral,
//                the console deep link is guarded, and only the route tree +
//                devices-tab name its URL.
// ---------------------------------------------------------------------------

(process.env as Record<string, string>).NODE_ENV = "test";
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";

const SCREEN_ROUTE = "/app/api/admin/devices/[deviceId]/screen-monitor/route.ts";
const DEVICES_TAB = "components/admin/devices-tab.tsx";
const MONITOR_PANEL = "components/admin/screen-monitor-panel.tsx";
const DEEP_PAGE = "app/admin=topsecret6199/device/[deviceId]/page.tsx";

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
// Fake db — the tables this surface touches. The update recorder IS the
// assertion: a helper that reaches for one extra column shows up here even
// when the response still looks right.
// ---------------------------------------------------------------------------
interface FakeDeviceRow {
  id: string;
  userId: string;
  email: string;
  name: string;
  removedAt: Date | null;
  enabled: boolean;
  notify: boolean;
  intervalOverride: number | null;
  wakeDelay: number | null;
  tier: string;
}

interface FakeFrame {
  deviceId: string;
  capturedAt: Date;
  summary: string | null;
  summaryError: string | null;
  summarisedAt: Date | null;
  imagePurgedAt: Date | null;
}

const store: { devices: FakeDeviceRow[]; frames: FakeFrame[] } = {
  devices: [],
  frames: [],
};

const calls: {
  reads: number;
  updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
  screenshotWhere: Record<string, unknown> | null;
} = { reads: 0, updates: [], screenshotWhere: null };

const fakeDb = {
  device: {
    // The lib calls findUnique TWICE with different selects (guard: id/name/
    // removedAt/user · switches: the four admin columns + tier). One union
    // row satisfies both — Prisma's `select` only shrinks what is already
    // here, so not emulating it cannot hide a wrong column read.
    findUnique: async (args: { where: { id: string } }) => {
      calls.reads += 1;
      const d = store.devices.find((x) => x.id === args.where.id);
      if (!d) return null;
      return {
        id: d.id,
        name: d.name,
        userId: d.userId,
        removedAt: d.removedAt,
        user: { id: d.userId, email: d.email },
        screenshotMonitoringEnabled: d.enabled,
        adminNotifyEnabled: d.notify,
        screenshotIntervalMinutesOverride: d.intervalOverride,
        screenshotWakeDelayMinutes: d.wakeDelay,
        tier: d.tier,
      };
    },
    update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      calls.updates.push({ where: args.where, data: args.data });
      const d = store.devices.find((x) => x.id === args.where.id);
      if (!d) throw new Error("device_not_found");
      if (typeof args.data.screenshotMonitoringEnabled === "boolean") {
        d.enabled = args.data.screenshotMonitoringEnabled;
      }
      if (typeof args.data.adminNotifyEnabled === "boolean") {
        d.notify = args.data.adminNotifyEnabled;
      }
      return {
        id: d.id,
        name: d.name,
        screenshotMonitoringEnabled: d.enabled,
        adminNotifyEnabled: d.notify,
        user: { id: d.userId, email: d.email },
      };
    },
  },
  deviceScreenshot: {
    findFirst: async (args: { where: Record<string, unknown> }) => {
      calls.screenshotWhere = args.where;
      if (args.where.status !== "captured") return null;
      const rows = store.frames
        .filter((f) => f.deviceId === args.where.deviceId)
        .sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime());
      const f = rows[0];
      if (!f) return null;
      return {
        capturedAt: f.capturedAt,
        summary: f.summary,
        summaryError: f.summaryError,
        summarisedAt: f.summarisedAt,
        imagePurgedAt: f.imagePurgedAt,
      };
    },
  },
};

interface Overrides {
  [request: string]: unknown;
}

let overrides: Overrides = {};

const loader = Module as unknown as {
  _load: (r: string, p: NodeModule | undefined, m: boolean) => unknown;
};
const originalLoad = loader._load;
loader._load = function patched(request, parent, isMain) {
  if (parent?.filename && request in overrides) return overrides[request];
  if (request === "server-only") return {};
  if (request === "next/server") return { NextResponse: fakeNextResponse };
  const from = parent?.filename ?? "";
  // lib/admin-devices.ts pulls four relative deps — all four must resolve to
  // the fakes above, or the "real" module would open a real db handle in a
  // unit test. (The route's own "@/lib/…" imports are handled by `overrides`;
  // tsx resolves "@/lib/admin-devices" itself so the REAL lib runs on fakeDb.)
  if (from.endsWith("/lib/admin-devices.ts")) {
    if (request === "./db") return { db: fakeDb };
    if (request === "./devices")
      return { deviceStatus: (r: { status?: string }) => r.status ?? "offline" };
    if (request === "./device-tools") return { adminRunDeviceCommand: async () => ({}) };
    if (request === "./vantra-link") return { fetchUserIdle: async () => ({}) };
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

// The admin session each scenario answers with (null ⇒ the 403 path).
let adminValue: { sub: string } | null;
const ADMIN_DEP = {
  getAdminSession: async () => adminValue,
};

const auditCalls: Array<Record<string, unknown>> = [];
const AUDIT_DEP = {
  recordAgentActionAudit: async (opts: Record<string, unknown>) => void auditCalls.push(opts),
};

// The route plumbs the GLOBAL cadence/retention dials through these two —
// faked so this test proves the ROUTE's wiring, not the resolver's math (the
// resolver has its own suite with the screenshot scheduler).
const PRISMA_DEP = {
  prisma: { adminSetting: { upsert: async () => ({}) } },
};
const SETTINGS_DEP = {
  resolveScreenshotSettings: () => ({ intervalMinutes: 60, retentionDays: 7 }),
};

/** The route with everything EXCEPT the real lib replaced (lib runs on fakeDb). */
function loadRoute() {
  return loadFresh(SCREEN_ROUTE, {
    "@/lib/admin-auth": ADMIN_DEP,
    "@/lib/devices": AUDIT_DEP,
    "@/lib/device-screenshots": SETTINGS_DEP,
    "@/lib/prisma": PRISMA_DEP,
  });
}

const paramsFor = (deviceId: string) => ({ params: Promise.resolve({ deviceId }) });
const PARAMS = paramsFor("dev_1");
const req = (body: unknown) => ({ json: async () => body }) as never;
const bareReq = {} as Request;

type GetFn = (r: unknown, c: unknown) => Promise<Result>;
type PatchFn = (r: unknown, c: unknown) => Promise<Result>;

function seedDevice(row: Partial<FakeDeviceRow> = {}): void {
  store.devices.push({
    id: "dev_1",
    userId: "u_owner",
    email: "owner@example.com",
    name: "Box",
    removedAt: null,
    enabled: false,
    notify: false,
    intervalOverride: null,
    wakeDelay: null,
    tier: "public",
    ...row,
  });
}

beforeEach(() => {
  store.devices.length = 0;
  store.frames.length = 0;
  calls.reads = 0;
  calls.updates.length = 0;
  calls.screenshotWhere = null;
  auditCalls.length = 0;
  adminValue = { sub: "admin" };
  overrides = {};
});

// ---------------------------------------------------------------------------
// 1. ROUTES + 2. LIB (the real route driving the REAL lib against fakeDb)
// ---------------------------------------------------------------------------

test("GET and PATCH → 403 without an admin session; nothing is read, written or audited", async () => {
  adminValue = null;
  const route = loadRoute();
  const getRes = await (route.GET as GetFn)(bareReq, PARAMS);
  const patchRes = await (route.PATCH as PatchFn)(req({ enabled: true }), PARAMS);
  assert.equal(getRes.status, 403);
  assert.equal(patchRes.status, 403);
  assert.equal(calls.reads, 0, "no db read for a stranger");
  assert.equal(calls.updates.length, 0, "no write for a stranger");
  assert.equal(auditCalls.length, 0, "no audit for a stranger");
});

test("GET → deep 404 for unknown AND soft-deleted devices (never 403)", async () => {
  seedDevice();
  seedDevice({ id: "dev_gone", removedAt: new Date("2026-10-01T00:00:00.000Z") });
  const route = loadRoute();

  const unknown = await (route.GET as GetFn)(bareReq, paramsFor("ghost"));
  assert.equal(unknown.status, 404, "an unknown id must not be confirmed");

  const removed = await (route.GET as GetFn)(bareReq, paramsFor("dev_gone"));
  assert.equal(removed.status, 404, "a soft-deleted row is invisible here — recover it first");

  const known = await (route.GET as GetFn)(bareReq, PARAMS);
  assert.equal(known.status, 200, "…while a live row still opens");
});

test("PATCH → deep 404 for unknown/removed devices; no update, no audit", async () => {
  seedDevice({ id: "dev_gone", removedAt: new Date() });
  const route = loadRoute();
  for (const id of ["ghost", "dev_gone"]) {
    const res = await (route.PATCH as PatchFn)(req({ enabled: true }), paramsFor(id));
    assert.equal(res.status, 404, `${id} must deep-404`);
  }
  assert.equal(calls.updates.length, 0, "the mutation never reached a row");
  assert.equal(auditCalls.length, 0);
});

test("PATCH → 400 on empty or wrong-type bodies; nothing is written", async () => {
  seedDevice();
  const route = loadRoute();
  for (const body of [{}, { enabled: "yes" }, { adminNotifyEnabled: 1 }, []]) {
    const res = await (route.PATCH as PatchFn)(req(body), PARAMS);
    assert.equal(res.status, 400, `body ${JSON.stringify(body)} must be refused`);
  }
  assert.equal(calls.updates.length, 0);
  assert.equal(auditCalls.length, 0);
});

test("PATCH {enabled} → writes ONLY the monitoring switch; one audit on the owner's id", async () => {
  seedDevice();
  const route = loadRoute();
  const res = await (route.PATCH as PatchFn)(req({ enabled: true }), PARAMS);
  assert.equal(res.status, 200);

  assert.equal(calls.updates.length, 1);
  const data = calls.updates[0].data;
  assert.deepEqual(Object.keys(data), ["screenshotMonitoringEnabled"], "exactly one key");
  for (const forbidden of [
    "adminNotifyEnabled",
    "screenTriggerNotificationsEnabled",
    "screenDigestEnabled",
    "screenshotIntervalMinutesOverride",
    "screenshotWakeDelayMinutes",
    "userId",
    "removedAt",
  ]) {
    assert.ok(!(forbidden in data), `column "${forbidden}" must be unreachable from this route`);
  }

  assert.equal((res.body as { enabled: boolean }).enabled, true);
  assert.equal(auditCalls.length, 1, "one audit per CHANGED switch");
  assert.equal(auditCalls[0].action, "screen_monitor_toggle");
  assert.equal(auditCalls[0].userId, "u_owner", "the audit lands on the OWNER's user id");
  assert.equal(auditCalls[0].sourceDeviceId, "dev_1");
});

test("PATCH {adminNotifyEnabled} → writes ONLY the notify switch; admin_notify_toggle audit", async () => {
  seedDevice();
  const route = loadRoute();
  const res = await (route.PATCH as PatchFn)(req({ adminNotifyEnabled: false }), PARAMS);
  assert.equal(res.status, 200);

  const data = calls.updates[0].data;
  assert.deepEqual(Object.keys(data), ["adminNotifyEnabled"], "exactly one key");
  assert.ok(!("screenshotMonitoringEnabled" in data), "the monitoring switch stays untouched");

  assert.equal((res.body as { adminNotifyEnabled: boolean }).adminNotifyEnabled, false);
  assert.equal(auditCalls.length, 1);
  assert.equal(auditCalls[0].action, "admin_notify_toggle");
  assert.equal(auditCalls[0].userId, "u_owner");
});

test("PATCH both switches → two keys, two audits (one per switch)", async () => {
  seedDevice();
  const route = loadRoute();
  const res = await (route.PATCH as PatchFn)(
    req({ enabled: true, adminNotifyEnabled: true }),
    PARAMS,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(calls.updates[0].data).sort(), [
    "adminNotifyEnabled",
    "screenshotMonitoringEnabled",
  ]);
  assert.equal(auditCalls.length, 2);
  assert.deepEqual(
    auditCalls.map((a) => a.action).sort(),
    ["admin_notify_toggle", "screen_monitor_toggle"],
  );
});

test("GET → switches + read-only cadence/retention + newest captured frame (summary null = NORMAL)", async () => {
  seedDevice({ enabled: true, notify: true, intervalOverride: 15, wakeDelay: 3 });
  store.frames.push({
    deviceId: "dev_1",
    capturedAt: new Date("2026-10-01T10:00:00.000Z"),
    summary: null,
    summaryError: null,
    summarisedAt: null,
    imagePurgedAt: null,
  });
  const route = loadRoute();
  const res = await (route.GET as GetFn)(bareReq, PARAMS);
  assert.equal(res.status, 200);

  const body = res.body as {
    device: unknown;
    enabled: boolean;
    adminNotifyEnabled: boolean;
    tier: string;
    intervalMinutesOverride: number | null;
    wakeDelayMinutes: number | null;
    captureIntervalMinutes: number;
    retentionDays: number;
    latestFrame: {
      capturedAt: string | null;
      summary: string | null;
      summaryError: string | null;
    } | null;
  };
  assert.deepEqual(body.device, { id: "dev_1", name: "Box", ownerEmail: "owner@example.com" });
  assert.equal(body.enabled, true);
  assert.equal(body.adminNotifyEnabled, true);
  assert.equal(body.tier, "public");
  assert.equal(body.intervalMinutesOverride, 15);
  assert.equal(body.wakeDelayMinutes, 3);
  assert.equal(body.captureIntervalMinutes, 60, "the read-only global cadence");
  assert.equal(body.retentionDays, 7, "the read-only global retention");
  assert.equal(calls.screenshotWhere?.status, "captured", "only CAPTURED frames are read");

  const frame = body.latestFrame;
  assert.ok(frame, "the newest captured frame is included");
  assert.equal(frame.capturedAt, "2026-10-01T10:00:00.000Z");
  assert.equal(frame.summary, null, "an unsummarised frame stays null — NORMAL, not an error");
  assert.equal(frame.summaryError, null);
});

test("GET with no frames → latestFrame null while the switches still flow", async () => {
  seedDevice();
  const route = loadRoute();
  const res = await (route.GET as GetFn)(bareReq, PARAMS);
  assert.equal(res.status, 200);
  const body = res.body as { enabled: boolean; latestFrame: unknown };
  assert.equal(body.enabled, false);
  assert.equal(body.latestFrame, null);
});

// ---------------------------------------------------------------------------
// 3. STATIC LOCKS
// ---------------------------------------------------------------------------

test("S1 menu: exactly three Actions items; the trigger lives in the ACTIVE row only", () => {
  const tab = read(DEVICES_TAB);

  // The three items — the former direct button first (S1 ground-truth
  // correction: that button IS the silent viewer), then the S2 panel, then
  // the console deep link.
  assert.ok(tab.includes("Actions ▾"), "the trigger label exists");
  assert.equal((tab.match(/role="menuitem"/g) ?? []).length, 3, "exactly three menu items");
  assert.ok(tab.includes('"Remote control"'), "item 1 — the silent viewer");
  assert.ok(tab.includes("Screen monitor…"), "item 2 — the inline panel");
  assert.ok(tab.includes("Open console"), "item 3 — the console deep link");
  assert.ok(
    tab.includes("`/admin=topsecret6199/device/${device.id}`"),
    "item 3 targets the device's own page",
  );

  // The trigger (located by its unique aria-haspopup, since the explanatory
  // comment above the cell also says "Actions ▾") sits inside the ACTIVE
  // branch of the row's trailing cell; the Deleted branch keeps the plain
  // viewer button byte-for-byte (TASK_188 S3c: deleted rows retain their
  // tools — and must show NO dropdown).
  const trigger = tab.indexOf('aria-haspopup="menu"');
  // Anchor on the NEAREST active-branch ternary before the trigger: other
  // cells also branch on the view, so a plain indexOf would tie into theirs.
  const ternary = tab.lastIndexOf('{view === "active" ? (', trigger);
  const elseBranch = tab.indexOf(") : (", trigger);
  const tdEnd = tab.indexOf("</td>", elseBranch);
  assert.ok(
    trigger > -1 && ternary > -1 && trigger > ternary,
    "the Actions trigger is created by the active-branch ternary",
  );
  assert.ok(elseBranch > trigger, "…and the deleted branch follows it (no dropdown there)");
  assert.ok(
    tab.slice(elseBranch, tdEnd).includes('"Remote control"'),
    "Deleted rows keep the plain Remote control button (no dropdown)",
  );

  // Popover and panel are both active-gated; outside click + Escape close it.
  assert.ok(tab.includes('{view === "active" && actions?.id === device.id && ('));
  assert.ok(tab.includes('{monitorId === device.id && view === "active" && ('));
  assert.ok(tab.includes('document.addEventListener("click"'), "outside click closes");
  assert.ok(tab.includes('document.addEventListener("keydown"'), "Escape closes");
});

test("S2 panel: GET on mount + two one-key flips + neutral 'no summary yet' copy", () => {
  const panel = read(MONITOR_PANEL);
  assert.ok(panel.includes("/screen-monitor"), "it loads its own data over GET");
  assert.ok(panel.includes('method: "PATCH"'));
  assert.ok(panel.includes("flip({ enabled: !monitor.enabled })"));
  assert.ok(panel.includes("flip({ adminNotifyEnabled: !monitor.adminNotifyEnabled })"));
  assert.ok(panel.includes("No summary yet — normal for a freshly captured frame."));

  // …and that neutral copy is rendered in NEUTRAL zinc — never error red.
  const at = panel.indexOf("No summary yet");
  const open = panel.lastIndexOf("<p", at);
  assert.ok(open !== -1);
  assert.ok(panel.slice(open, at).includes("text-zinc-500"), "neutral styling");
  assert.ok(!panel.slice(open, at).includes("text-red"), "never error styling");
  assert.equal((panel.match(/role="switch"/g) ?? []).length, 1, "one shared Toggle (two uses)");
});

test("deep link: Open console opens the guarded per-device page; the original still answers", () => {
  const tab = read(DEVICES_TAB);
  assert.ok(tab.includes("window.open("), "opens in a new tab");

  const page = read(DEEP_PAGE);
  assert.ok(page.includes("getAdminSession()"), "the deep page carries its own session check");
  assert.ok(page.includes("redirect("), "…and redirects without one");
  assert.ok(page.includes("<SecretDevicesHost"), "…rendering the same console as the static route");
  assert.ok(
    fs.existsSync(path.join(ROOT, "app/admin=topsecret6199/device/101/page.tsx")),
    "the original unlisted route still exists (its literal URL keeps answering)",
  );
});

test("secrecy: only the route tree + devices-tab name the console URL; retired literal stays out", () => {
  const offenders: string[] = [];
  const needle = "/admin=topsecret6199/device/";
  const retired = ["admin", "device", "101"].join("/");
  const routeTree = path.join("app", "admin=topsecret6199", "device");
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|js|jsx|json|txt|xml|html)$/.test(entry.name)) continue;
      const text = fs.readFileSync(full, "utf8");
      const inRouteTree = full.includes(routeTree);
      const isMenuOwner = full.endsWith(path.join("components", "admin", "devices-tab.tsx"));
      // TASK_190 S3 — the ADMIN's own alert message carries the console link
      // (PROMPT_VERIFY §3.2), so server-only lib/admin-notify.ts is the one
      // place outside the route tree allowed to name the URL: it runs on the
      // server, ships to no client bundle and never enters the build manifest.
      const isNotifyFanout = full.endsWith(path.join("lib", "admin-notify.ts"));
      if (text.includes(needle) && !inRouteTree && !isMenuOwner && !isNotifyFanout)
        offenders.push(full);
      // The pre-TASK_188 literal never appears outside the route's own folder
      // (the S1 dropdown replaced the old link style, not copied it).
      if (text.includes(retired) && !inRouteTree) offenders.push(full);
    }
  };
  for (const t of ["app", "components", "lib", "public"]) {
    const dir = path.join(ROOT, t);
    if (fs.existsSync(dir)) walk(dir);
  }
  assert.deepEqual(offenders, [], `the console URL must not spread: ${offenders.join(", ")}`);
});
