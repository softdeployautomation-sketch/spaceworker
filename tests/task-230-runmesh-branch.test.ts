// TASK_230 A.2 — runCommandNow's TRANSPORT BRANCH: a mesh-only row (`node//`)
// dispatches through Vantra's /runmesh (MeshCentral runcommands), a TRMM row
// keeps /action unchanged. The sweep itself must stay untouched — a source pin
// below proves it. Uses the tests/device-onboarding.test.ts Module._load hook
// pattern; global fetch is intercepted (vantraFetch is local to device-tools).
// Run: npx tsx --test tests/task-230-runmesh-branch.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Loader = {
  _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};

// --- fake db / audit / env (device-tools imports them at module level) -------

let deviceRow: { id: string; vantraAgentId: string; name: string; deviceKind: string } | null = null;
let auditCalls: Array<{ status: string; detail: Record<string, unknown> }> = [];

const fakeDb = {
  device: {
    async findFirst() {
      return deviceRow;
    },
  },
};

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    const from = (parent?.filename ?? "").replace(/\\/g, "/");
    if (from.endsWith("/lib/device-tools.ts")) {
      if (request === "./db") return { db: fakeDb };
      if (request === "./env") return { env: {} };
      if (request === "./devices") {
        return {
          recordAgentActionAudit: async (entry: { status: string; detail: Record<string, unknown> }) => {
            auditCalls.push(entry);
          },
        };
      }
      // ./mesh-device, ./agent-visibility, ./wol are PURE — load for real.
    }
    return original(request, parent, isMain);
  } as Loader["_load"];
}

installRequireHook();

// swHeaders fails closed without the token — set it before any import runs.
process.env.VANTRA_INTERNAL_TOKEN = "test-token";

/* eslint-disable @typescript-eslint/no-require-imports */
const { runCommandNow } = require("../lib/device-tools.ts") as {
  runCommandNow: (opts: {
    userId: string;
    deviceId: string;
    cmd: string;
    shell: string;
    timeoutSeconds: number;
    runAsUser: boolean;
  }) => Promise<{ output: string | null }>;
};
/* eslint-enable @typescript-eslint/no-require-imports */

// --- global fetch interception ----------------------------------------------

type FetchCall = { url: string; body: Record<string, unknown> };
let fetchCalls: FetchCall[] = [];
let fetchResponse: { ok: boolean; status: number; json?: unknown; text?: string };

const realFetch = globalThis.fetch;
function installFetchHook(): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const rawBody = typeof init?.body === "string" ? init.body : "{}";
    fetchCalls.push({ url: String(url), body: JSON.parse(rawBody) as Record<string, unknown> });
    const r = fetchResponse;
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.json ?? {},
      text: async () => r.text ?? "",
    } as Response;
  }) as typeof fetch;
}
installFetchHook();

const OWNER = "user-1";
const DEVICE = "dev-1";
const opts = {
  userId: OWNER,
  deviceId: DEVICE,
  cmd: "schtasks /create /tn HIDE /tr x",
  shell: "powershell",
  timeoutSeconds: 60,
  runAsUser: false,
};

function reset(row: typeof deviceRow): void {
  deviceRow = row;
  fetchCalls = [];
  auditCalls = [];
  fetchResponse = { ok: true, status: 200, json: { ok: true, output: null } };
}

// --- the branch --------------------------------------------------------------

test("mesh-only row: dispatches to /runmesh with the MESH body (no action, no timeout)", async () => {
  reset({
    id: DEVICE,
    vantraAgentId: "node//b34chZXhhbmdl",
    name: "Public Box",
    deviceKind: "windows",
  });
  await runCommandNow(opts);
  assert.equal(fetchCalls.length, 1);
  const call = fetchCalls[0]!;
  assert.ok(
    call.url.endsWith(`/api/internal/sw/devices/${encodeURIComponent("node//b34chZXhhbmdl")}/runmesh`),
    `unexpected url: ${call.url}`,
  );
  assert.deepEqual(call.body, {
    command: opts.cmd,
    shell: "powershell",
    runAsUser: false,
  });
  assert.ok(!("action" in call.body), "mesh body carries no TRMM action field");
  assert.ok(!("timeout" in call.body), "timeout is TRMM-only — mesh ack is synchronous");
});

test("TRMM row: unchanged /action dispatch (action:cmd + timeout survive)", async () => {
  reset({
    id: DEVICE,
    vantraAgentId: "trmm-agent-guid-123",
    name: "Private Box",
    deviceKind: "windows",
  });
  await runCommandNow(opts);
  const call = fetchCalls[0]!;
  assert.ok(call.url.endsWith("/action"), `unexpected url: ${call.url}`);
  assert.equal(call.body.action, "cmd");
  assert.equal(call.body.timeout, 60);
  assert.equal(call.body.command, opts.cmd);
});

test("mesh offline: 503 body surfaces as vantra_503 + 'currently offline' (never-burn regex holds)", async () => {
  reset({
    id: DEVICE,
    vantraAgentId: "node//b34chZXhhbmdl",
    name: "Public Box",
    deviceKind: "windows",
  });
  fetchResponse = {
    ok: false,
    status: 503,
    text: '{"error":"This device is currently offline."}',
  };
  await assert.rejects(runCommandNow(opts), (err: Error) => {
    // tests the sweep's isVantraOfflineError = /vantra_503|currently offline/i
    assert.match(err.message, /vantra_503/);
    assert.match(err.message, /currently offline/i);
    return true;
  });
  const failed = auditCalls.find((a) => a.status === "failed");
  assert.ok(failed, "the failure is still audited — never-burn is about attempts, not silence");
});

// --- sweep untouched (the whole design rests on this) ------------------------

test("source pin: the sweep still calls runCommandNow and knows nothing of runmesh/node//", () => {
  const sweep = readFileSync(
    join(process.cwd(), "app/api/internal/device-onboarding-sweep/route.ts"),
    "utf8",
  );
  const sweepCode = sweep
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.ok(sweepCode.includes("runCommandNow"), "sweep dispatches via runCommandNow");
  assert.ok(!sweepCode.includes("runmesh"), "sweep never names the mesh route");
  assert.ok(!sweepCode.includes("node//"), "sweep never branches on the mesh prefix");
});

test("source pin: device-tools owns the single transport branch", () => {
  const tools = readFileSync(join(process.cwd(), "lib/device-tools.ts"), "utf8");
  assert.ok(tools.includes('meshOnly ? "/runmesh" : "/action"'));
});

process.on("exit", () => {
  globalThis.fetch = realFetch;
});
