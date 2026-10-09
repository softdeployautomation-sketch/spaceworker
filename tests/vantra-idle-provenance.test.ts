import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// TASK_154 N1 — the bulk idle read must carry PROVENANCE, and a MeshCentral
// hiccup must not blank a servable reading.
//
// WHY THIS FILE EXISTS: `app/api/devices/route.ts` collapses three different
// situations into ONE nullable number — a fresh reading, a stale one, and
// "we do not know right now" all render as `idleSeconds: null`, and the client
// deletes the idle text for null (components/device-list.tsx:638). So a
// transient MeshCentral socket timeout makes an idle machine read as a bare
// `online`, indistinguishable from `online · active now` — a lie about a machine
// nobody is touching. This was diagnosed in TASK_154 §1 but had no committed
// reproduction. This is that reproduction and the fix's proof.
//
// The modules under test are the REAL `app/api/devices/route.ts` and the REAL
// `lib/vantra-link.ts` — not copies. Only their own immediate dependencies are
// swapped (house require-hook pattern, HOW_WE_MOVE_FAST §4): the route's
// db/session/device-view, and vantra-link's db/audit/admin deps. The ONE seam
// that actually matters — the outbound mesh HTTP call — is `globalThis.fetch`,
// which this test drives directly. Nothing touches a real DB or the network.

// Set BEFORE `../app/api/devices/route` (→ lib/vantra-link → lib/env) loads:
// lib/env.ts runs its required() checks at import time and swHeaders() fails
// closed without a Vantra token.
process.env.DATABASE_URL = "postgresql://t154n1:t154n1@localhost:5432/t154n1_placeholder";
process.env.SESSION_SECRET = "task154n1-test-session-secret";
process.env.RESEND_API_KEY = "task154n1-test-resend";
process.env.EMAIL_FROM = "t154n1@spaceworker.test";
process.env.APP_BASE_URL = "https://spaceworker.test";
process.env.VANTRA_INTERNAL_TOKEN = "task154n1-test-vantra-token";
process.env.VANTRA_INTERNAL_URL = "https://vantra.spaceworker.test";
(process.env as Record<string, string>).NODE_ENV = "test";

const MIN = 60_000;

// ---------------------------------------------------------------------------
// Mutable fixtures — every test calls resetWorld() with its OWN user/org ids so
// the module-scope cache (keyed by org) starts cold and the tests cannot leak
// state into each other without an explicit test-only reset export.
// ---------------------------------------------------------------------------

let sessionValue: { userId: string } | null = null;
let linkRow: { orgId: string; privateOrgId: string | null; status: string } | null = null;
let deviceRows: Array<{
  id: string;
  name: string;
  status: string;
  lastSeenAt: Date | null;
  vantraAgentId?: string | null;
}> = [];
let fetchCalls: string[] = [];
let warns: string[] = [];
/** What the outbound idle read answers with when it succeeds (hostname key). */
let idleMap: Record<string, number | null> = {};
/** TASK_185 P1 — the additive agent-id key Vantra now reports alongside. */
let agentIdleMap: Record<string, number | null> = {};
/** When true the next outbound read throws, as a mesh socket timeout does. */
let idleThrows = false;

function resetWorld(userId: string, orgId: string): void {
  sessionValue = { userId };
  linkRow = { orgId, privateOrgId: null, status: "active" };
  deviceRows = [{ id: "d-1", name: "I", status: "online", lastSeenAt: new Date() }];
  fetchCalls = [];
  warns = [];
  idleMap = {};
  agentIdleMap = {};
  idleThrows = false;
  // Default the tests to "no TTL" so a call always dials the socket — that is
  // what lets a single failing poll be observed. The TTL-hit test raises it.
  process.env.DEVICE_IDLE_CACHE_TTL_MS = "0";
}

const fakeVantraDb = { vantraLink: { findUnique: async () => linkRow } };
// TASK_191 — the route now reads the user row for the tier-3 display
// suppression; default to a free-tier user so the idle assertions stay as-is.
const fakePrisma = {
  device: { findMany: async () => deviceRows },
  user: { findUnique: async () => ({ tier: 1, premiumExpiresAt: null }) },
};

type Loader = {
  _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    const from = (parent?.filename ?? "").replace(/\\/g, "/");
    // The REAL worth-testing module: swap only its own deps (not used here for
    // anything but the idle path, so the rest are inert stand-ins).
    if (from.endsWith("/lib/vantra-link.ts")) {
      if (request === "./db") return { db: fakeVantraDb };
      if (request === "./entitlements") {
        return { hasEntitlement: async () => ({ allowed: false, reason: "none" }) };
      }
      if (request === "./devices") return { recordAgentActionAudit: async () => {} };
      if (request === "./admin-settings") return { getAdminSettings: async () => ({}) };
      if (request === "./agent-visibility") return { DEFAULT_AGENT_LABEL: "Agent" };
      if (request === "./agent-approval-notify") {
        return { notifyPendingActionViaTelegram: async () => {} };
      }
      if (request === "./device-tools") {
        return {
          executePinRequest: async () => ({ output: null }),
          startMaintenanceOverlayAction: async () => ({}),
          stopMaintenanceOverlayAction: async () => ({}),
        };
      }
      // NOTE: `@/lib/vantra-link` is deliberately NOT swapped below, so the
      // route consumes the real module and this file exercises its caching.
    }
    // The API boundary under test.
    if (from.endsWith("/app/api/devices/route.ts")) {
      if (request === "next/server") {
        return {
          NextResponse: {
            json: (body: unknown, init?: { status?: number }) => ({
              status: init?.status ?? 200,
              body,
              json: async () => body,
            }),
          },
        };
      }
      if (request === "@/lib/prisma") return { prisma: fakePrisma };
      if (request === "@/lib/session") return { getSession: async () => sessionValue };
      if (request === "@/lib/devices") {
        return {
          deviceListSelector: {},
          DEVICE_ONLINE_WINDOW_MS: 10 * MIN,
          isDeviceOnline: (lastSeenAt: Date | null) => !!lastSeenAt,
          toDeviceView: (d: Record<string, unknown>) => ({
            ...d,
            effectiveStatus: d.status,
            onboarding: null,
          }),
        };
      }
    }
    return original.call(this, request, parent, isMain);
  };
}

installRequireHook();

globalThis.fetch = (async (url: unknown) => {
  fetchCalls.push(String(url));
  if (idleThrows) throw new Error("mesh_timeout");
  return {
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      idleByHostname: idleMap,
      idleByAgentId: agentIdleMap,
      idleUnit: "seconds",
    }),
    text: async () => "",
  } as unknown as Response;
}) as unknown as typeof fetch;

const realWarn = console.warn;
console.warn = (...args: unknown[]) => {
  warns.push(args.map(String).join(" "));
};
process.on("exit", () => {
  console.warn = realWarn;
});

interface RouteResult {
  status: number;
  body: {
    onlineWindowMs?: number;
    idle?: { asOf: string; state: string };
    devices: Array<Record<string, unknown>>;
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
const route = require("../app/api/devices/route") as {
  GET: (req: Request) => Promise<RouteResult>;
};
/* eslint-enable @typescript-eslint/no-require-imports */

function get(query = ""): Promise<RouteResult> {
  return route.GET(new Request(`http://localhost/api/devices${query}`));
}

/** Every row's rendered idle signal, for readable assertions. */
function row(d: Record<string, unknown>): Record<string, unknown> {
  return {
    name: d.name,
    status: d.status,
    idleSeconds: d.idleSeconds,
    idle: d.idle,
  };
}

// ---------------------------------------------------------------------------
// 1. The healthy path still returns a real value — and calls it fresh.
// ---------------------------------------------------------------------------
test("a healthy mesh read is marked fresh and returns the real value", async () => {
  resetWorld("u-healthy", "org-healthy");
  idleMap = { I: 104 };
  const res = await get();
  assert.equal(res.status, 200);
  assert.equal(row(res.body.devices[0]).idleSeconds, 104);
  assert.equal(res.body.idle?.state, "fresh");
  assert.ok(Date.parse(res.body.idle?.asOf ?? "") > 0, "asOf must be a real timestamp");
  assert.equal(warns.length, 0, "a healthy read must not warn");
});

// ---------------------------------------------------------------------------
// 2. THE DEFECT: a mesh hiccup must not blank a servable reading.
// ---------------------------------------------------------------------------
test("a mesh failure serves the last good reading as stale, never a blank", async () => {
  resetWorld("u-hiccup", "org-hiccup");
  idleMap = { I: 104 };
  const first = await get();
  assert.equal(row(first.body.devices[0]).idleSeconds, 104);
  const asOf = first.body.idle?.asOf;

  // The very next poll's mesh socket times out.
  idleThrows = true;
  const second = await get();
  assert.equal(second.status, 200, "a mesh failure must never 500 the device list");
  assert.equal(
    row(second.body.devices[0]).idleSeconds,
    104,
    "the reading must survive the hiccup instead of blanking to null",
  );
  assert.equal(second.body.idle?.state, "stale");
  assert.equal(second.body.idle?.asOf, asOf, "asOf is the observation time, not now()");
});

// ---------------------------------------------------------------------------
// 3. Cold cache + failing mesh degrades honestly — unknown, never "active".
// ---------------------------------------------------------------------------
test("a cold cache with a failing mesh degrades to unknown, never a guess", async () => {
  resetWorld("u-cold", "org-cold");
  idleThrows = true;
  const res = await get();
  assert.equal(res.status, 200);
  assert.equal(row(res.body.devices[0]).idleSeconds, null);
  assert.equal(res.body.idle?.state, "unknown");
  assert.equal(warns.length, 1, "exactly one warning for the cold outage");
  assert.match(warns[0], /no cached reading|unknown/i);
});

// ---------------------------------------------------------------------------
// 4. The failure is now OBSERVABLE, but rate-limited (today it is swallowed).
// ---------------------------------------------------------------------------
test("the mesh-failure warning fires once across several failing polls", async () => {
  resetWorld("u-ratelimit", "org-ratelimit");
  idleMap = { I: 104 };
  await get(); // seed a good reading
  idleThrows = true;
  await get();
  await get();
  await get();
  await get();
  assert.equal(warns.length, 1, `expected 1 rate-limited warning, saw ${warns.length}`);
});

// ---------------------------------------------------------------------------
// 5. Within the TTL a poll is served from cache WITHOUT opening a mesh socket.
// ---------------------------------------------------------------------------
test("within the TTL a poll is served from cache without touching the mesh", async () => {
  resetWorld("u-ttl", "org-ttl");
  process.env.DEVICE_IDLE_CACHE_TTL_MS = "25000";
  idleMap = { I: 104 };
  const a = await get();
  const b = await get();
  assert.equal(fetchCalls.length, 1, "the second poll must not open a second mesh read");
  assert.equal(a.body.idle?.asOf, b.body.idle?.asOf);
  assert.equal(b.body.idle?.state, "fresh");
  assert.equal(row(b.body.devices[0]).idleSeconds, 104);
});

// ---------------------------------------------------------------------------
// 6. No linked org is "unknown" without dialing Vantra at all.
// ---------------------------------------------------------------------------
test("no linked org is unknown and does not dial Vantra", async () => {
  resetWorld("u-nolink", "org-nolink");
  linkRow = null;
  const res = await get();
  assert.equal(row(res.body.devices[0]).idleSeconds, null);
  assert.equal(res.body.idle?.state, "unknown");
  assert.equal(fetchCalls.length, 0, "no link means no outbound call");
});

// ---------------------------------------------------------------------------
// 7. Back-compat: the per-row provenance object is opt-in, so the payload every
//    existing consumer reads is unchanged — the flag only ADDS a field.
// ---------------------------------------------------------------------------
test("the per-row provenance object is opt-in and strictly additive", async () => {
  resetWorld("u-shape", "org-shape");
  idleMap = { I: 104 };
  const plain = await get();
  assert.equal(row(plain.body.devices[0]).idleSeconds, 104, "the back-compat field stays");
  assert.ok(!("idle" in plain.body.devices[0]), "no per-row idle object unless asked");

  const flagged = await get("?idle=provenance");
  const perRow = flagged.body.devices[0].idle as {
    seconds: number | null;
    asOf: string | null;
    state: string;
  };
  assert.equal(perRow.seconds, 104);
  assert.equal(perRow.state, "fresh");
  assert.equal(perRow.asOf, flagged.body.idle?.asOf);
});

// ---------------------------------------------------------------------------
// 8. A device absent from a healthy map is unknown, not "active" — the exact
//    live shape that renders a bare `online` today (device WilkSF9's org).
// ---------------------------------------------------------------------------
test("a device missing from a healthy map is unknown, not active", async () => {
  resetWorld("u-missing", "org-missing");
  idleMap = {}; // the mesh answered — legitimately no live node for this device
  const res = await get("?idle=provenance");
  assert.equal(res.body.idle?.state, "fresh", "the bulk read itself succeeded");
  assert.equal(row(res.body.devices[0]).idleSeconds, null);
  const perRow = res.body.devices[0].idle as { state: string };
  assert.equal(perRow.state, "unknown");
});

// ---------------------------------------------------------------------------
// TASK_185 P1 — the LIVE defect behind "activity unknown": Device.name drifts
// off the TRMM hostname (sync seeds it, then rename/heartbeat overwrites it),
// so the name-keyed lookup missed even though the mesh had a reading. The
// lookup now keys by STABLE agent id first, with the name match as fallback
// (so an older Vantra without `idleByAgentId` behaves exactly as before).
// ---------------------------------------------------------------------------
test("a renamed device resolves idle via agent id; the name match stays as fallback", async () => {
  // Scenario 1: renamed device — name no longer equals the hostname key.
  resetWorld("u-agentkey", "org-agentkey");
  deviceRows = [
    { id: "d-re", name: "Sc-renamed", status: "online", lastSeenAt: new Date(), vantraAgentId: "agent-9" },
  ];
  idleMap = { "DESKTOP-OLDNAME": 720 }; // mesh reports under the OLD hostname key
  agentIdleMap = { "agent-9": 720 }; // …and under the stable agent id
  const viaAgent = await get();
  assert.equal(row(viaAgent.body.devices[0]).idleSeconds, 720, "agent-id key must win over the drifted name");

  // Scenario 2: agent map has no entry (older Vantra shape) → name fallback.
  resetWorld("u-agentkey-fb", "org-agentkey-fb");
  deviceRows = [
    { id: "d-fb", name: "DESKTOP-OLDNAME", status: "online", lastSeenAt: new Date(), vantraAgentId: "agent-9" },
  ];
  idleMap = { "DESKTOP-OLDNAME": 300 };
  agentIdleMap = {};
  const viaName = await get();
  assert.equal(row(viaName.body.devices[0]).idleSeconds, 300, "hostname-by-name fallback still works");
});



