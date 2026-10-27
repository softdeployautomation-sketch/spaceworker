// TASK_246 — HTTP contract of the Cline auth routes.
// Run: npx tsx --test tests/clin-auth-routes.test.ts
//
// The settings card keys off status codes, so these must be exact:
//   200 connected · 202 still pending · 410 expired · 403 denied · 502 Cline unreachable.
// 202 in particular is NOT success: the previous card closed the panel on any
// `res.ok`, which is why users saw nothing happen after Confirm.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

(process.env as Record<string, string>).NODE_ENV = "test";

type Loader = { _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown };
const loader = Module as unknown as Loader;
const original = loader._load;

type JsonBody = Record<string, unknown>;

const fakeNextResponse = {
  json: (data: unknown, init?: { status?: number }) => ({
    status: init?.status ?? 200,
    json: async () => data as JsonBody,
  }),
};

let currentUser: { id: string } | null = { id: "u1" };
let pollResult: JsonBody = { status: "pending", message: "Waiting", retryAfterSeconds: 5 };
let lastPollInput: JsonBody | null = null;

const fakePoll = async (input: JsonBody) => {
  lastPollInput = input;
  return pollResult;
};

let overrides: Record<string, unknown> = {};

function loadRoute(path: string) {
  const abs = require.resolve(`..${path}`);
  delete require.cache[abs];
  overrides = {
    "next/server": { NextResponse: fakeNextResponse },
    "@/lib/session-user": { getCurrentUser: async () => currentUser },
    "@/lib/clin/device-auth": { pollClineDeviceAuth: fakePoll },
  };
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    return require(abs) as {
      POST: (r: never) => Promise<{ status: number; json: () => Promise<JsonBody> }>;
    };
    /* eslint-enable @typescript-eslint/no-require-imports */
  } finally {
    overrides = {};
  }
}

const req = (body: unknown) => ({ json: async () => body }) as never;
const badReq = () =>
  ({
    json: async () => {
      throw new Error("Unexpected end of JSON input");
    },
  }) as never;

loader._load = function patched(request, parent, isMain) {
  if (request === "server-only") return {};
  if (parent?.filename && request in overrides) return overrides[request];
  return original.apply(this, [request, parent, isMain]);
};

beforeEach(() => {
  currentUser = { id: "u1" };
  lastPollInput = null;
  pollResult = { status: "pending", message: "Waiting", retryAfterSeconds: 5 };
});

test("TASK_246 routes.1 — both routes require a session", async () => {
  currentUser = null;
  for (const path of ["/app/api/clin/auth/poll/route.ts", "/app/api/clin/auth/callback/route.ts"]) {
    const route = loadRoute(path);
    const res = await route.POST(req({}));
    assert.equal(res.status, 401, path);
  }
});

test("TASK_246 routes.2 — pending is 202 (not 200) and forwards the device code", async () => {
  const route = loadRoute("/app/api/clin/auth/poll/route.ts");
  const res = await route.POST(req({ deviceCode: "dev-1", windowSeconds: 4 }));
  assert.equal(res.status, 202);
  assert.deepEqual(lastPollInput, { userId: "u1", deviceCode: "dev-1", windowSeconds: 4 });

  const body = await res.json();
  assert.equal(body.pending, true);
  assert.equal(body.connected, false);
  assert.equal(body.retryAfterSeconds, 5);
});

test("TASK_246 routes.3 — default window is 8s for /poll, 15s for the /callback alias", async () => {
  const poll = loadRoute("/app/api/clin/auth/poll/route.ts");
  await poll.POST(req({}));
  assert.ok(lastPollInput);
  assert.equal(lastPollInput.windowSeconds, 8);
  assert.equal(lastPollInput.deviceCode, undefined);

  const callback = loadRoute("/app/api/clin/auth/callback/route.ts");
  await callback.POST(req({ deviceCode: "dev-2" }));
  assert.ok(lastPollInput);
  assert.equal(lastPollInput.windowSeconds, 15);
});

test("TASK_246 routes.4 — a malformed/empty body is tolerated", async () => {
  const route = loadRoute("/app/api/clin/auth/poll/route.ts");
  const res = await route.POST(badReq());
  assert.equal(res.status, 202);
  assert.ok(lastPollInput);
  assert.equal(lastPollInput.deviceCode, undefined);
});

test("TASK_246 routes.5 — connected / expired / denied / unreachable statuses", async () => {
  const route = loadRoute("/app/api/clin/auth/poll/route.ts");

  pollResult = { status: "connected", email: "a@b.c", accountId: "acct", expires: 123 };
  let res = await route.POST(req({ deviceCode: "d" }));
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.connected, true);
  assert.equal(body.email, "a@b.c");

  pollResult = { status: "expired", message: "expired" };
  res = await route.POST(req({ deviceCode: "d" }));
  assert.equal(res.status, 410);
  body = await res.json();
  assert.equal(body.expired, true);

  pollResult = { status: "denied", message: "denied" };
  res = await route.POST(req({ deviceCode: "d" }));
  assert.equal(res.status, 403);

  pollResult = { status: "unreachable", message: "Could not reach Cline's API from the server.", retryAfterSeconds: 5 };
  res = await route.POST(req({ deviceCode: "d" }));
  assert.equal(res.status, 502);
  body = await res.json();
  assert.equal(body.retry, true);
  assert.doesNotMatch(String(body.error), /fetch failed/i);
});

// ---------------------------------------------------------------------------
// Static regression guards
// ---------------------------------------------------------------------------

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

test("TASK_246 routes.6 — the dead host api.cline.com cannot come back", () => {
  const files = [
    ...walk(join(process.cwd(), "app/api/clin/auth")),
    ...walk(join(process.cwd(), "lib/clin")),
  ];
  assert.ok(files.length >= 8);
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.equal(source.includes("api.cline.com"), false, `${file} still references api.cline.com`);
  }
});

test("TASK_246 routes.7 — callback does not pass SDK error messages through to the client", () => {
  const source = readFileSync(join(process.cwd(), "app/api/clin/auth/callback/route.ts"), "utf8");
  assert.equal(source.includes("err.message"), false, "raw SDK/transport messages must not reach the UI");
  assert.ok(source.includes("clinePollResponse"));
});

test("TASK_246 routes.8 — logout is safe when there is no settings row (updateMany, not update)", () => {
  const source = readFileSync(join(process.cwd(), "app/api/clin/auth/logout/route.ts"), "utf8");
  assert.ok(source.includes("clearClineCredentials"));
  assert.equal(/cyberLabAgentSettings\s*\.update\s*\(/.test(source), false);
});
