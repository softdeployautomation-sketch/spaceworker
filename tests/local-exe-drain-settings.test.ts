import test from "node:test";
import assert from "node:assert/strict";

// TASK_201 S7 — drain settings file behaviour (owner directive 2026-10-10:
// drain controls live in the mailer EXE's Settings). Pure file-state checks:
// defaults on missing file, clamping of out-of-range intervals, persistence
// round-trip, and corruption recovery — no server, no network.
//
// House require pattern (HOW_WE_MOVE_FAST §4): "server-only" is stubbed, and
// SPACEWORKER_LOCAL_DATA_DIR MUST be set BEFORE the require.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Module from "node:module";

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
installRequireHook();

process.env.SPACEWORKER_LOCAL_DATA_DIR = mkdtempSync(path.join(tmpdir(), "exe-drain-"));

/* eslint-disable @typescript-eslint/no-require-imports */
const drain = require("../lib/local-exe-drain") as typeof import("../lib/local-exe-drain");
/* eslint-enable @typescript-eslint/no-require-imports */

test("missing settings file yields the defaults (auto-drain ON, 60s)", async () => {
  const settings = await drain.readDrainSettings();
  assert.deepEqual(settings, drain.DRAIN_SETTINGS_DEFAULTS);
  assert.equal(settings.autoDrain, true);
  assert.equal(settings.intervalSeconds, 60);
});

test("writes clamp out-of-range intervals into [15, 3600]", async () => {
  const tooFast = await drain.writeDrainSettings({ intervalSeconds: 5 });
  assert.equal(tooFast.intervalSeconds, drain.DRAIN_INTERVAL_MIN_SECONDS);

  const tooSlow = await drain.writeDrainSettings({ intervalSeconds: 999_999 });
  assert.equal(tooSlow.intervalSeconds, drain.DRAIN_INTERVAL_MAX_SECONDS);

  const nonsense = await drain.writeDrainSettings({ intervalSeconds: Number.NaN });
  assert.equal(nonsense.intervalSeconds, drain.DRAIN_SETTINGS_DEFAULTS.intervalSeconds);
});

test("partial patch merges and persists across reads", async () => {
  await drain.writeDrainSettings({ autoDrain: false, intervalSeconds: 300 });
  const readBack = await drain.readDrainSettings();
  assert.deepEqual(readBack, { autoDrain: false, intervalSeconds: 300 });

  await drain.writeDrainSettings({ autoDrain: true });
  const merged = await drain.readDrainSettings();
  assert.deepEqual(merged, { autoDrain: true, intervalSeconds: 300 });
});

test("corrupt settings file falls back to defaults instead of throwing", async () => {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(drain.drainSettingsPath(), "{not json", "utf8");
  const settings = await drain.readDrainSettings();
  assert.deepEqual(settings, drain.DRAIN_SETTINGS_DEFAULTS);
});

test("triggerMailQueueDrain fails closed without INTERNAL_BEARER_TOKEN", async () => {
  delete process.env.INTERNAL_BEARER_TOKEN;
  const result = await drain.triggerMailQueueDrain();
  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
});
