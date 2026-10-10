import test from "node:test";
import assert from "node:assert/strict";

// TASK_201 S8 — per-product local license state. Regression for the cross-EXE
// trial bleed: every EXE variant used to share ONE exe-license-state.json, so
// the Extractor EXE's expired 24h trial gated the Mailer EXE. Pure file-state
// checks (no server, no network): legacy name for extractor, suffixed name for
// mailer, and — the actual regression — the two targets cannot see each other's
// trial/activation.
//
// House require pattern (HOW_WE_MOVE_FAST §4): "server-only" is stubbed, and
// SPACEWORKER_LOCAL_DATA_DIR MUST be set BEFORE the require.

import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
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

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "exe-lic-iso-"));
process.env.SPACEWORKER_LOCAL_DATA_DIR = DATA_DIR;

/* eslint-disable @typescript-eslint/no-require-imports */
const licenseState = require("../lib/license-state") as typeof import("../lib/license-state");
/* eslint-enable @typescript-eslint/no-require-imports */

function legacyPath(): string {
  return path.join(DATA_DIR, "exe-license-state.json");
}
function targetPath(target: string): string {
  return path.join(DATA_DIR, `exe-license-state-${target}.json`);
}

// exeBuildTarget() reads BUILD_TARGET at call time, so we can flip it between
// assertions to simulate each variant running on the same machine. Async-aware:
// the env MUST stay set until the awaited work settles, or a writeTrialStart's
// readFile/writeFile would resume with BUILD_TARGET already reset to the
// extractor default and land in the wrong file (the exact bug that made test 6
// below fail on the first cut).
async function withTarget<T>(target: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env.BUILD_TARGET;
  process.env.BUILD_TARGET = target;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.BUILD_TARGET;
    else process.env.BUILD_TARGET = prev;
  }
}

test("extractor target keeps the LEGACY unsuffixed filename (zero migration)", () => {
  withTarget("extractor", () => {
    assert.equal(licenseState.licenseStatePath(), legacyPath());
  });
});

test("mailer target uses a suffixed filename (isolated file)", () => {
  withTarget("mailer", () => {
    assert.equal(licenseState.licenseStatePath(), targetPath("mailer"));
  });
});

test("combined/automation targets each get their own suffixed file", () => {
  withTarget("combined", () => {
    assert.equal(licenseState.licenseStatePath(), targetPath("combined"));
  });
  withTarget("automation", () => {
    assert.equal(licenseState.licenseStatePath(), targetPath("automation"));
  });
});

test("REGRESSION: an expired extractor trial does NOT bleed into the mailer", async () => {
  // Simulate the shipped Extractor EXE: it started a trial 48h ago (> 24h, so
  // expired). Written at the LEGACY path.
  await withTarget("extractor", async () => {
    const started = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    await licenseState.writeTrialStart({ trialStartedAt: started, email: "ext@example.com" });
    assert.ok(existsSync(legacyPath()), "extractor writes the legacy file");
  });

  // The Mailer EXE on the SAME machine must see NO trial — its own file is a
  // fresh default — never the extractor's dead clock.
  await withTarget("mailer", async () => {
    const state = await licenseState.readLocalState();
    assert.equal(state.trialStartedAt, undefined, "mailer must not inherit extractor's trial");
    assert.equal(licenseState.trialActive(state, new Date()), false);
  });
});

test("REGRESSION: an extractor activation does NOT license the mailer", async () => {
  // Extractor activated on this machine (legacy file).
  await withTarget("extractor", async () => {
    await licenseState.saveActivation({
      licensee: "buyer@example.com",
      licenseKey: "KEY-EXTRACTOR",
      machineId: "abc123",
    });
  });

  // Mailer's own state must be un-activated — the products are separate.
  await withTarget("mailer", async () => {
    const state = await licenseState.readLocalState();
    assert.equal(state.activation, undefined, "mailer must not inherit extractor's activation");
  });
});

test("each target persists independently (a mailer trial lands only in its own file)", async () => {
  // Snapshot whatever is already in the legacy file (test 4 wrote the extractor
  // trial there). A mailer write must NOT touch it.
  const legacyBefore = existsSync(legacyPath()) ? readFileSync(legacyPath(), "utf8") : null;

  await withTarget("mailer", async () => {
    await licenseState.writeTrialStart({ trialStartedAt: new Date().toISOString(), email: "m@example.com" });
  });

  assert.ok(existsSync(targetPath("mailer")), "mailer wrote its own file");
  const legacyAfter = existsSync(legacyPath()) ? readFileSync(legacyPath(), "utf8") : null;
  assert.equal(legacyAfter, legacyBefore, "mailer never modified the legacy extractor file");
});

test("verify-exe-license.mts style: corrupt/missing file falls back to defaults", async () => {
  await withTarget("mailer", async () => {
    writeFileSync(targetPath("mailer"), "{ not json", "utf8");
    const state = await licenseState.readLocalState();
    assert.deepEqual(state, { version: 1 });
  });
});
