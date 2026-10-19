// TASK_230 Section A deliverable 3 (P4b-2) — public-on-top labeling. Mesh-only
// public devices (`node//` ids) must ride the SAME public-first machinery
// TASK_228 shipped: sort partition to the top group + the Public pill. Their
// tier comes from the ORG they surface under (the public org), so the pins
// here prove the whole chain: sync assigns tier from the org list → component
// partitions on tier → pill renders on non-private. Run:
//   npx tsx --test tests/task-230-public-surfacing.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isMeshOnlyDevice, MESH_ONLY_ID_PREFIX } from "../lib/mesh-device";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
/** Strip // line comments — prose legitimately names retired symbols. */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

const listSrc = read("components/device-list.tsx");
const syncSrc = codeOnly(read("lib/vantra-link.ts"));

// --- the discriminator (PURE — direct import) --------------------------------

test("isMeshOnlyDevice: `node//` prefix is true (the free, zero-schema signal)", () => {
  assert.equal(MESH_ONLY_ID_PREFIX, "node//");
  assert.equal(isMeshOnlyDevice("node//$GXOrIYlabc123+/="), true);
  assert.equal(isMeshOnlyDevice("node//"), true); // bare prefix still a node id
});

test("isMeshOnlyDevice: TRMM agent ids are never mesh-only", () => {
  // Real Tactical shapes: plain tokens/uuid-ish strings — none carry `node//`.
  assert.equal(isMeshOnlyDevice("8Qm4Rt2Zx9Lp0Av"), false);
  assert.equal(isMeshOnlyDevice("a1b2c3d4-e5f6-7788-99aa-bbccddeeff00"), false);
});

test("isMeshOnlyDevice: null/undefined/empty/case variants are false", () => {
  assert.equal(isMeshOnlyDevice(null), false);
  assert.equal(isMeshOnlyDevice(undefined), false);
  assert.equal(isMeshOnlyDevice(""), false);
  assert.equal(isMeshOnlyDevice("NODE//abc"), false); // exact lowercase prefix
  assert.equal(isMeshOnlyDevice(" xnode//abc"), false); // no stray match
});

// --- public-on-top sort (device-list.tsx) ------------------------------------

test("P4b-2: device list partitions PUBLIC first — stable tier sort (TASK_228)", () => {
  // The one comparator: private count difference ⇒ every non-private row
  // (INCLUDING mesh-only, whose tier comes from the public org) sorts above
  // every private row; equal tiers keep server order (stable sort).
  assert.match(listSrc, /Number\(a\.tier === "private"\) - Number\(b\.tier === "private"\)/);
});

test("P4b-2: mesh rows carry vantraAgentId on the client row type (gating key)", () => {
  // Declared on DeviceRow so capability gating (P4b-3) can read `node//`
  // without a second fetch — toDeviceView already serializes it server-side.
  assert.match(listSrc, /vantraAgentId: string \| null;/);
});

// --- the Public label (device-list.tsx) --------------------------------------

test("P4b-2: Public pill renders for every non-private row (mesh rows included)", () => {
  const pill = /!wrapper && d\.tier !== "private"/;
  assert.match(listSrc, pill);
  // …and the pill actually says Public right next to that condition.
  const idx = listSrc.search(pill);
  assert.ok(idx >= 0);
  assert.match(listSrc.slice(idx, idx + 400), />\s*Public\s*</);
});

test("P4b-2: private rows render NO pill (owner: Public is the state worth calling out)", () => {
  // The condition is exclusive: `tier !== "private"` — so a private row can
  // never render the label. Pinned by counting the markup: exactly ONE Public
  // pill exists in the list, and the test above ties it to that condition.
  const matches = listSrc.match(/>\s*Public\s*</g) ?? [];
  assert.equal(matches.length, 1, "exactly ONE Public pill in the list markup");
});

// --- tier provenance for mesh rows (lib/vantra-link.ts) -----------------------

test("P4b-2: sync assigns tier from the ORG the row came from (mesh = public org)", () => {
  // Mesh-only rows are surfaced by Vantra ONLY under the public org, and the
  // merge keeps each row's origin list + tier, so a mesh row's tier is
  // "public" by construction — which is what puts it in the top partition and
  // under the Public pill.
  assert.match(syncSrc, /const tier = list\.orgTier \?\? \(i === 0 \? "public" : "private"\)/);
  assert.match(syncSrc, /merged\.set\(d\.vantraAgentId, \{ row: d, orgId, tier \}\)/);
  assert.match(syncSrc, /tier: entry\.tier/); // the upsert persists that tier
});

test("P4b-2: mesh-only field is typed optional on the sync payload (older Vantra safe)", () => {
  assert.match(syncSrc, /meshOnly\?: boolean/);
});