import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// TASK_242 — a transient TRMM command-channel blip ("unable to contact the
// agent" → Vantra 503 "This device is currently offline.") on a device that is
// still ONLINE must not abort setup on the first try, and must never be
// reported as the machine being offline. This drives the REAL module's retry
// seam with a controllable transport.

type Loader = {
  _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};

const MODULE_UNDER_TEST = "lib/clone-setup.ts";
const loader = Module as unknown as Loader;
const original = loader._load;

// Controllable transport + status, read by the stubbed dependencies below.
type Reply = "ok" | "offline" | "boom";
let replies: Reply[] = [];
let callCount = 0;
let deviceOnline = true;

const offlineErr = () =>
  new Error('vantra_503: {"error":"This device is currently offline."}');

const fakeRunCommandNow = async () => {
  const reply = replies[callCount] ?? "ok";
  callCount += 1;
  if (reply === "offline") throw offlineErr();
  if (reply === "boom") throw new Error("some_unrelated_failure");
  return { output: "STEP:probe OK", ranAt: new Date(), exitCode: 0 };
};

loader._load = function patched(request, parent, isMain) {
  if (request === "server-only") return {};
  const from = parent?.filename ?? "";
  if (from.endsWith(`/${MODULE_UNDER_TEST}`)) {
    if (request === "./db") return { db: {} };
    if (request === "./env") return { env: { appBaseUrl: "https://spaceworker.test" } };
    if (request === "./device-tools") return { runCommandNow: fakeRunCommandNow };
    if (request === "./devices") return { deviceStatus: () => (deviceOnline ? "online" : "offline") };
    if (request === "./clone") return { refreshRelayHealth: async () => ({ status: "up" }) };
    if (request === "./clone-hosts") {
      return { hostAvailability: async () => ({}), refreshDeviceLiveness: async () => {} };
    }
    if (request === "./clone-destination") return { ensureHostedDestination: async () => ({}) };
    if (request === "./clone-transport") {
      return {
        ensureCloneCapability: async () => {},
        runRelayInstall: async () => ({ ok: true }),
        mintLiveCaptureToken: () => "",
        commitLiveCaptureToken: async () => {},
      };
    }
    if (request === "./clone-engine-dist") {
      return { engineBundle: async () => [], signedEngineUrl: async () => "" };
    }
    if (request === "./wol") {
      return { buildPowerIdentityScript: () => "", parsePowerIdentityOutput: () => ({}) };
    }
  }
  return original.call(this, request, parent, isMain);
};

/* eslint-disable @typescript-eslint/no-require-imports */
const { runNowWithTransientRetry, isTransientAgentUnreachable } =
  require("../lib/clone-setup") as typeof import("../lib/clone-setup");
/* eslint-enable @typescript-eslint/no-require-imports */

const OPTS = {
  userId: "user-1",
  deviceId: "device-1",
  cmd: "echo ok",
  shell: "powershell",
  timeoutSeconds: 10,
  runAsUser: false,
};

function device(online: boolean) {
  return {
    status: online ? "online" : "offline",
    lastSeenAt: online ? new Date() : new Date(Date.now() - 60 * 60_000),
    onlineConfirmedAt: online ? new Date() : null,
  };
}

function reset(nextReplies: Reply[], online: boolean) {
  replies = nextReplies;
  callCount = 0;
  deviceOnline = online;
}

test("TASK_242: a transient offline on the first dispatch is retried and succeeds", async () => {
  reset(["offline", "ok"], true);

  const res = await runNowWithTransientRetry(OPTS, device(true));

  assert.equal(res.output, "STEP:probe OK");
  assert.equal(callCount, 2, "exactly one retry");
});

test("TASK_242: a persistent failure on an ONLINE device reports agent_not_responding, not offline", async () => {
  reset(["offline", "offline"], true);

  await assert.rejects(runNowWithTransientRetry(OPTS, device(true)), (err: Error) => {
    assert.equal(err.message, "agent_not_responding");
    assert.doesNotMatch(err.message, /offline/i);
    return true;
  });
  assert.equal(callCount, 2);
});

test("TASK_242: a persistent failure on an OFFLINE device keeps the real offline error", async () => {
  reset(["offline", "offline"], false);

  await assert.rejects(runNowWithTransientRetry(OPTS, device(false)), (err: Error) => {
    assert.match(err.message, /vantra_503/);
    return true;
  });
  assert.equal(callCount, 2);
});

test("TASK_242: a non-transient error is not retried", async () => {
  reset(["boom"], true);

  await assert.rejects(runNowWithTransientRetry(OPTS, device(true)), /some_unrelated_failure/);
  assert.equal(callCount, 1, "no retry for an unrelated failure");
});

test("TASK_242: the transient predicate matches only channel/unreachable errors", () => {
  assert.equal(isTransientAgentUnreachable(offlineErr()), true);
  assert.equal(isTransientAgentUnreachable(new Error("unable to contact the agent")), true);
  assert.equal(isTransientAgentUnreachable(new Error("clone_engine_dist_missing")), false);
  assert.equal(isTransientAgentUnreachable(new Error("setup_already_running")), false);
});
