import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// TASK_183 — devices-wrapper scoping: the `sw_wrapper` cookie.
//
// The wrapper EXE is a window onto the HOSTED app: GET /wrapper/devices sets
// this session cookie and 307s to /dashboard/devices. Scope now comes from env
// (dev/tests, unchanged) OR that cookie (hosted window); the proxy guard and
// the two server components (layout, settings) all resolve through
// lib/wrapper-mode. THE FAILURE THIS SUITE EXISTS TO PREVENT: either side of
// the resolution regressing — (a) the entry route not setting the cookie (or
// wrong attrs, so the webview drops it), (b) the parser widening scope
// (`"Devices"`/`"extractor"`/garbage must NEVER resolve to wrapper mode —
// fail-closed like the env), (c) env precedence flipping (an env flag must
// always outrank a cookie).
// ---------------------------------------------------------------------------

// server-only must never throw in a plain-Node test run; next/headers is a
// controllable jar for resolveWrapperMode; next/server is a minimal
// NextResponse stand-in — constructable (entry route uses `new NextResponse(null,
// {status})` + a RELATIVE Location header) and with cookies.set.
let jar: Map<string, string> = new Map();
class FakeNextResponse {
  status: number;
  private rawHeaders = new Map<string, string>();
  // real Headers lowercases keys — the shim must too (route sets "Location",
  // tests read "location").
  headers = {
    set: (key: string, value: string): void => {
      this.rawHeaders.set(key.toLowerCase(), value);
    },
    get: (key: string): string | null => this.rawHeaders.get(key.toLowerCase()) ?? null,
  };
  cookieSets: Array<{ name: string; value: string; opts: unknown }> = [];
  cookies = {
    set: (name: string, value: string, opts: unknown) => {
      this.cookieSets.push({ name, value, opts });
    },
  };
  constructor(_body: unknown, init?: { status?: number }) {
    this.status = init?.status ?? 200;
  }
  get redirectedTo(): string {
    return this.headers.get("location") ?? "";
  }
}
const fakeNextResponse = FakeNextResponse;

const loader = Module as unknown as {
  _load: (r: string, p: NodeModule | undefined, m: boolean) => unknown;
};
const originalLoad = loader._load;
loader._load = function patched(request, parent, isMain) {
  if (request === "server-only") return {};
  if (request === "next/headers") {
    return {
      cookies: async () => ({
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
      }),
    };
  }
  if (request === "next/server") return { NextResponse: fakeNextResponse };
  return originalLoad.call(this, request, parent, isMain);
};

/* eslint-disable @typescript-eslint/no-require-imports */
const wrapperMode = require("../lib/wrapper-mode") as {
  WRAPPER_MODE_COOKIE: string;
  WRAPPER_MODE_COOKIE_VALUE: string;
  wrapperMode: () => string | null;
  wrapperModeFromCookieValue: (v: string | undefined | null) => string | null;
  resolveWrapperMode: () => Promise<string | null>;
};
const entryRoute = require("../app/wrapper/devices/route.ts") as {
  GET: (req: Request) => {
    status: number;
    headers: { get: (key: string) => string | null };
    cookieSets: Array<{ name: string; value: string; opts: unknown }>;
  };
};
/* eslint-enable @typescript-eslint/no-require-imports */

test("cookie name and value are exactly sw_wrapper=devices", () => {
  assert.equal(wrapperMode.WRAPPER_MODE_COOKIE, "sw_wrapper");
  assert.equal(wrapperMode.WRAPPER_MODE_COOKIE_VALUE, "devices");
});

test("wrapperModeFromCookieValue fails closed on everything but 'devices'", () => {
  assert.equal(wrapperMode.wrapperModeFromCookieValue("devices"), "devices");
  assert.equal(wrapperMode.wrapperModeFromCookieValue(undefined), null);
  assert.equal(wrapperMode.wrapperModeFromCookieValue(null), null);
  assert.equal(wrapperMode.wrapperModeFromCookieValue(""), null);
  assert.equal(wrapperMode.wrapperModeFromCookieValue("Devices"), null); // case
  assert.equal(wrapperMode.wrapperModeFromCookieValue("extractor"), null);
  assert.equal(wrapperMode.wrapperModeFromCookieValue("true"), null);
});

test("resolveWrapperMode: env first (never overridden by cookie), then cookie", async () => {
  // env set ⇒ env wins; the jar holds a WRONG value and must not matter.
  process.env.WRAPPER_MODE = "devices";
  jar = new Map([["sw_wrapper", "extractor"]]);
  assert.equal(await wrapperMode.resolveWrapperMode(), "devices");

  // env absent ⇒ cookie path.
  delete process.env.WRAPPER_MODE;
  jar = new Map([["sw_wrapper", "devices"]]);
  assert.equal(await wrapperMode.resolveWrapperMode(), "devices");

  jar = new Map([["sw_wrapper", "nope"]]);
  assert.equal(await wrapperMode.resolveWrapperMode(), null);

  jar = new Map();
  assert.equal(await wrapperMode.resolveWrapperMode(), null);
});

test("GET /wrapper/devices: 307 to /dashboard/devices with the scoped cookie", () => {
  const res = entryRoute.GET(new Request("https://spaceworker.top/wrapper/devices"));
  assert.equal(res.status, 307);
  // RELATIVE Location on purpose (route comment): the client resolves it against
  // ITS origin (webview = spaceworker.top). An absolute URL built server-side
  // baked in the box's internal host (https://localhost:3500) — verified live.
  assert.equal(res.headers.get("location"), "/dashboard/devices");
  assert.equal(res.cookieSets.length, 1);
  const [c] = res.cookieSets;
  assert.equal(c.name, "sw_wrapper");
  assert.equal(c.value, "devices");
  const opts = c.opts as { httpOnly?: boolean; sameSite?: string; secure?: boolean; path?: string };
  assert.equal(opts.httpOnly, true);
  assert.equal(opts.sameSite, "lax");
  assert.equal(opts.secure, true);
  assert.equal(opts.path, "/");
  assert.equal("maxAge" in opts || "expires" in opts, false, "must be a session cookie");
});

// Static locks on the three consumers — cheap regression tripwires (same style
// as the carrier suite's content assertions): a revert to env-only resolution,
// or the license gate creeping back onto the wrapper branch, fails here.
test("consumers use the cookie-aware resolver and skip the license gate", () => {
  const proxySrc = readFileSync(join(__dirname, "..", "proxy.ts"), "utf8");
  assert.ok(
    proxySrc.includes("wrapperModeFromCookieValue(request.cookies.get(WRAPPER_MODE_COOKIE)"),
    "proxy.ts must resolve wrapper scope from the request cookie, not env alone",
  );

  const layoutSrc = readFileSync(join(__dirname, "..", "app", "dashboard", "layout.tsx"), "utf8");
  assert.ok(layoutSrc.includes("resolveWrapperMode()"), "layout must use the cookie-aware resolver");
  const wrapperArm = layoutSrc.match(/\{wrapper \? \(([\s\S]*?)\) : \(/);
  assert.ok(wrapperArm, "layout must branch on wrapper for the gate");
  assert.ok(
    !wrapperArm[1].includes("LicenseGate"),
    "the WRAPPER arm of the layout ternary must not render LicenseGate",
  );

  const settingsSrc = readFileSync(
    join(__dirname, "..", "app", "dashboard", "settings", "page.tsx"),
    "utf8",
  );
  assert.ok(
    settingsSrc.includes("isLocalExeRuntime() && !wrapper"),
    "settings must skip the local-exe license panel for the wrapper",
  );
});