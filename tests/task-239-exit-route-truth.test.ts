import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

import type { CurlOutcome, CurlRunner } from "../lib/browser-proxy";
import type { ExitNodeProber } from "../lib/exit-node-health";

// TASK_239 — the exit-route check must be HONEST and VISIBLE.
//
// Owner report: "private browser route issue to US and canada — none of the
// fixes worked." Measured cause: the launch route swallowed a timed-out IP
// check (`.catch(() => null)`), so half the US/CA sessions recorded no IP and
// the panel showed nothing. A host-side curl also proved the proxy, not the
// container's route to it.
//
// These tests pin (a) the typed failure taxonomy, (b) the audit record that
// distinguishes a container-proven path from a host-only probe, (c) the 30s
// node-health cache, and (d) that the new fields survive the safe-select and
// serializer. No socket is ever opened: every probe is injected.

process.env.DATABASE_URL = "postgresql://t_t239:dev@localhost:5432/placeholder";
process.env.SESSION_SECRET = "task-239-test-session-secret";
process.env.APP_BASE_URL = "https://spaceworker.test";
process.env.EMAIL_FROM = "t239@spaceworker.test";
process.env.RESEND_API_KEY = "re_task239_test";
process.env.MAILBOX_ENCRYPTION_KEY = "a".repeat(64);
process.env.EXIT_NODE_US = "socks5://172.17.0.1:1090";
process.env.EXIT_NODE_CA = "socks5://172.17.0.1:1091";
delete process.env.EXIT_NODE_UK;

type Loader = {
  _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    return original.call(this, request, parent, isMain);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
installRequireHook();
const proxy = require("../lib/browser-proxy") as typeof import("../lib/browser-proxy");
const audit = require("../lib/browser-session-exit-ip") as typeof import("../lib/browser-session-exit-ip");
const health = require("../lib/exit-node-health") as typeof import("../lib/exit-node-health");
const safeSelect = require("../lib/browser-session-safe-select") as typeof import("../lib/browser-session-safe-select");
const serialize = require("../lib/browser-session-serialize") as typeof import("../lib/browser-session-serialize");
/* eslint-enable @typescript-eslint/no-require-imports */

beforeEach(() => {
  health.resetExitNodeHealthCache();
});

const ok = (stdout: string): CurlOutcome => ({ stdout, stderr: "", code: 0, timedOut: false });

test("TASK_239 — the IP-check taxonomy separates timeout, unreachable, bad JSON and empty", () => {
  assert.deepEqual(proxy.classifyIpCheck({ ...ok(""), timedOut: true }), { ok: false, error: "timeout" });
  assert.deepEqual(proxy.classifyIpCheck({ ...ok(""), code: 28 }), { ok: false, error: "timeout" });
  assert.deepEqual(proxy.classifyIpCheck({ ...ok(""), code: 7 }), { ok: false, error: "unreachable" });
  assert.deepEqual(proxy.classifyIpCheck({ ...ok(""), code: 56 }), { ok: false, error: "unreachable" });
  assert.deepEqual(proxy.classifyIpCheck(ok("")), { ok: false, error: "empty" });
  assert.deepEqual(proxy.classifyIpCheck(ok("<html>captive portal</html>")), { ok: false, error: "bad_response" });
  assert.deepEqual(proxy.classifyIpCheck(ok("{}")), { ok: false, error: "empty" });
  assert.deepEqual(proxy.classifyIpCheck(ok('{"ip":""}')), { ok: false, error: "empty" });
  assert.deepEqual(proxy.classifyIpCheck(ok('{"ip":"64.34.81.172"}')), { ok: true, ip: "64.34.81.172" });
});

test("TASK_239 — probeIpThroughProxy sends the SOCKS route and never throws on failure", async () => {
  let seen: string[] = [];
  const runner: CurlRunner = async (args) => {
    seen = args;
    return ok('{"ip":"185.156.47.134"}');
  };
  const result = await proxy.probeIpThroughProxy(
    { scheme: "socks5", host: "172.17.0.1", port: 1091 },
    runner,
  );
  assert.deepEqual(result, { ok: true, ip: "185.156.47.134" });
  assert.ok(seen.includes("--proxy"));
  assert.ok(seen.includes("socks5://172.17.0.1:1091"));

  const failed = await proxy.probeIpThroughProxy(
    { scheme: "socks5", host: "172.17.0.1", port: 1091 },
    async () => ({ stdout: "", stderr: "Operation timed out", code: 28, timedOut: true }),
  );
  assert.deepEqual(failed, { ok: false, error: "timeout" });
});

test("TASK_239 — a direct probe sends no proxy flag", async () => {
  let seen: string[] = [];
  await proxy.probeDirectIp(async (args) => {
    seen = args;
    return ok('{"ip":"164.68.105.96"}');
  });
  assert.equal(seen.includes("--proxy"), false);
});

test("TASK_239 — the audit record never calls a host-only probe the container's route", () => {
  const now = new Date("2026-10-23T16:26:00.000Z");
  const good = { ok: true as const, ip: "64.34.81.172" };

  assert.deepEqual(
    audit.buildExitIpAudit(good, { proxyReachable: true, now }),
    { exitIpSnapshot: "64.34.81.172", exitIpError: null, exitIpCheckedAt: now, exitIpPath: "container" },
  );
  assert.deepEqual(
    audit.buildExitIpAudit(good, { proxyReachable: null, now }),
    { exitIpSnapshot: "64.34.81.172", exitIpError: null, exitIpCheckedAt: now, exitIpPath: "host" },
  );
  // Host curl succeeded but the container could not reach the proxy: the IP is
  // still evidence, the ROUTE is not proven, and the error says so.
  assert.deepEqual(
    audit.buildExitIpAudit(good, { proxyReachable: false, now }),
    {
      exitIpSnapshot: "64.34.81.172",
      exitIpError: "container_unreachable",
      exitIpCheckedAt: now,
      exitIpPath: "host",
    },
  );
  assert.deepEqual(
    audit.buildExitIpAudit({ ok: false, error: "timeout" }, { proxyReachable: true, now }),
    { exitIpSnapshot: null, exitIpError: "timeout", exitIpCheckedAt: now, exitIpPath: "container" },
  );
});

test("TASK_239 — node health is cached for 30s and re-probed after the TTL", async () => {
  health.resetExitNodeHealthCache();
  let probes = 0;
  const probe: ExitNodeProber = async (node) => {
    probes++;
    return { ok: true, ip: node.id === "us" ? "64.34.81.172" : "185.156.47.134" };
  };

  const first = await health.getExitNodeHealth({ now: 1_000_000, probe });
  assert.equal(probes, 2, "one probe per configured node");
  assert.deepEqual(first.map((n) => n.id), ["us", "ca"]);
  assert.deepEqual(first.map((n) => n.ip), ["64.34.81.172", "185.156.47.134"]);
  assert.equal(first[0].path, "host");

  const cached = await health.getExitNodeHealth({ now: 1_010_000, probe });
  assert.equal(probes, 2, "within the TTL must not re-probe");
  assert.equal(cached, first, "and the cached array is reused");

  const expired = await health.getExitNodeHealth({ now: 1_031_000, probe });
  assert.equal(probes, 4, "after 30s the nodes are probed again");
  assert.notEqual(expired, first);

  const forced = await health.getExitNodeHealth({ now: 1_031_100, probe, force: true });
  assert.equal(probes, 6, "force bypasses the cache");
  assert.notEqual(forced, expired);
});

test("TASK_239 — a changed node endpoint invalidates the cache even inside the TTL", async () => {
  health.resetExitNodeHealthCache();
  let probes = 0;
  const probe: ExitNodeProber = async () => {
    probes++;
    return { ok: false, error: "unreachable" };
  };
  await health.getExitNodeHealth({ now: 5_000, probe });
  assert.equal(probes, 2);

  process.env.EXIT_NODE_US = "socks5://172.17.0.1:2090";
  try {
    await health.getExitNodeHealth({ now: 5_100, probe });
    assert.equal(probes, 4, "the endpoint change must be re-probed");
  } finally {
    process.env.EXIT_NODE_US = "socks5://172.17.0.1:1090";
  }
});

test("TASK_239 — the safe select and serializer carry the audit fields", () => {
  assert.equal(safeSelect.SESSION_SAFE_SELECT.exitIpSnapshot, true);
  assert.equal(safeSelect.SESSION_SAFE_SELECT.exitIpError, true);
  assert.equal(safeSelect.SESSION_SAFE_SELECT.exitIpCheckedAt, true);
  assert.equal(safeSelect.SESSION_SAFE_SELECT.exitIpPath, true);

  const checkedAt = new Date("2026-10-23T16:26:00.000Z");
  const view = serialize.serializeSession({
    id: "s1",
    status: "stopped",
    proxyMode: "free",
    exitNodeId: "us",
    exitIpSnapshot: "64.34.81.172",
    exitIpError: "timeout",
    exitIpCheckedAt: checkedAt,
    exitIpPath: "host",
    byoProxyHost: null,
    byoProxyPort: null,
    byoProxyScheme: null,
    byoProxyUsername: null,
    containerId: null,
    nekoPassword: null,
    startedAt: null,
    endedAt: null,
    createdAt: checkedAt,
  });
  assert.equal(view.exitIpSnapshot, "64.34.81.172");
  assert.equal(view.exitIpError, "timeout");
  assert.equal(view.exitIpCheckedAt, checkedAt.toISOString());
  assert.equal(view.exitIpPath, "host");
});
