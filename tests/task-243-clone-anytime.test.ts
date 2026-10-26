import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// TASK_243 — "access your cloned browser anytime": the two mechanisms that
// make it true must be proven without a database, a browser or a network.
//
//   1. relayTunnelState() is TRI-STATE: a browser-server hiccup ("unknown")
//      must never be mistaken for a dead relay ("down"), because the
//      fail-closed sweep kills sessions on "down" only.
//   2. The cookie jar round-trips through real AES-256-GCM at 0600, and
//      injectLiveCapture() can inject from it after the in-memory capture is
//      gone (the PC-offline launch path).
//
// House pattern (HOW_WE_MOVE_FAST §4): require hook, the REAL modules, only
// their edges are stand-ins.

process.env.DATABASE_URL = "postgresql://t_t243:dev@localhost:5432/placeholder";
process.env.MAILBOX_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

type Loader = {
  _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};

type RelayReply = { ok: boolean; data?: { up?: boolean } } | Error;

let relayReply: RelayReply = { ok: true, data: { up: true } };
let stateDir = "";
let jar: { cookies: Array<{ name: string; value: string; domain: string; path: string }>; capturedAt: string | null } | null =
  null;
let injected: Array<{ name: string }> | null = null;
let sessionUpdates = 0;

const fakeDb = {
  cloneJob: {
    findUnique: async () => ({
      sourceDeviceId: "dev-1",
      browser: "chrome",
      profileName: "Default",
    }),
  },
  hostedBrowserSession: {
    update: async () => {
      sessionUpdates += 1;
      return { count: 1 };
    },
  },
};

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    const from = (parent?.filename ?? "").replace(/\\/g, "/");

    if (from.endsWith("/lib/clone-relay-state.ts") && request === "./browser-runtime") {
      return {
        browserRuntime: {
          relayControlStatus: async () => {
            if (relayReply instanceof Error) throw relayReply;
            return relayReply;
          },
        },
      };
    }

    if (from.endsWith("/lib/clone-cookie-jar.ts") && request === "./clone-state-ingest") {
      return { stateCacheDirForTarget: () => stateDir };
    }

    if (from.endsWith("/lib/clone-live-capture.ts")) {
      if (request === "./db") return { db: fakeDb };
      if (request === "./clone-cookie-jar") return { loadCookieJar: async () => jar };
      if (request === "./cdp") {
        return {
          injectCookies: async (opts: { cookies: Array<{ name: string }> }) => {
            injected = opts.cookies;
            return { ok: true, count: opts.cookies.length };
          },
        };
      }
    }

    return original.call(this, request, parent, isMain);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
installRequireHook();
const relay = require("../lib/clone-relay-state") as typeof import("../lib/clone-relay-state");
const jarMod = require("../lib/clone-cookie-jar") as typeof import("../lib/clone-cookie-jar");
const live = require("../lib/clone-live-capture") as typeof import("../lib/clone-live-capture");
/* eslint-enable @typescript-eslint/no-require-imports */

const COOKIE = {
  name: "sid",
  value: "abc123",
  domain: ".example.com",
  path: "/",
  expires: -1,
  httpOnly: true,
  secure: true,
};

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "t243-jar-"));
}

test("relay tunnel: up / down / unknown never collapse into each other", async () => {
  relayReply = { ok: true, data: { up: true } };
  assert.equal(await relay.relayTunnelState("dev-1"), "up");
  assert.equal(await relay.isRelayTunnelUp("dev-1"), true);

  relayReply = { ok: true, data: { up: false } };
  assert.equal(await relay.relayTunnelState("dev-1"), "down");
  assert.equal(await relay.isRelayTunnelUp("dev-1"), false);

  relayReply = { ok: false };
  assert.equal(await relay.relayTunnelState("dev-1"), "unknown");
  assert.equal(await relay.isRelayTunnelUp("dev-1"), false);

  relayReply = new Error("browser-server unreachable");
  assert.equal(await relay.relayTunnelState("dev-1"), "unknown");
  assert.equal(await relay.isRelayTunnelUp("dev-1"), false);

  relayReply = { ok: true, data: {} };
  assert.equal(await relay.relayTunnelState("dev-1"), "unknown");
});

test("cookie jar: encrypted round-trip, 0600, counts preserved", async () => {
  stateDir = await freshDir();
  try {
    await jarMod.persistCookieJar(
      { deviceId: "dev-1", browser: "chrome", profileName: "Default" },
      [COOKIE] as never
    );
    const file = join(stateDir, "cookie-jar.enc");
    const mode = (await stat(file)).mode & 0o777;
    assert.equal(mode, 0o600, "jar must not be world/group readable");

    const loaded = await jarMod.loadCookieJar({
      deviceId: "dev-1",
      browser: "chrome",
      profileName: "Default",
    });
    assert.ok(loaded);
    assert.equal(loaded.cookies.length, 1);
    assert.equal(loaded.cookies[0].name, "sid");
    assert.equal(loaded.cookies[0].value, "abc123");
    assert.match(loaded.capturedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(
      await jarMod.hasCookieJar({ deviceId: "dev-1", browser: "chrome", profileName: "Default" }),
      true
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("cookie jar: absent target is null, empty capture writes nothing, corrupt file is null", async () => {
  stateDir = await freshDir();
  try {
    const target = { deviceId: "dev-1", browser: "chrome", profileName: "Default" };
    assert.equal(await jarMod.loadCookieJar(target), null);
    assert.equal(await jarMod.hasCookieJar(target), false);

    await jarMod.persistCookieJar(target, []);
    assert.equal(await jarMod.loadCookieJar(target), null);

    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(stateDir, "cookie-jar.enc"), "not:a:valid:payload", { mode: 0o600 });
    assert.equal(await jarMod.loadCookieJar(target), null);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("live capture: injects from the saved jar when the in-memory payload is gone", async () => {
  jar = { cookies: [COOKIE as never], capturedAt: new Date().toISOString() };
  injected = null;
  sessionUpdates = 0;

  const res = await live.injectLiveCapture({ cloneJobId: "clone-offline-1", cdpPort: 9222 });
  assert.equal(res.ok, true);
  assert.equal(res.injectedCount, 1);
  assert.equal((injected as Array<{ name: string }> | null)?.[0]?.name, "sid");
  assert.equal(sessionUpdates, 1, "counts are stamped on the session");
});

test("live capture: no payload and no jar still fails closed", async () => {
  jar = null;
  injected = null;
  const res = await live.injectLiveCapture({ cloneJobId: "clone-offline-2", cdpPort: 9222 });
  assert.equal(res.ok, false);
  assert.equal(res.error, "capture_not_found");
  assert.equal(injected, null);
});
