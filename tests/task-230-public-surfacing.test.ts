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

import { isMeshOnlyDevice, MESH_ONLY_ID_PREFIX, meshOnlyNotice, isMeshOnlyNoticeTab, MESH_ONLY_NOTICE_TABS } from "../lib/mesh-device";

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
const consoleSrc = codeOnly(read("components/device-console.tsx"));

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
  // TASK_231: the same `!wrapper && tier !== "private"` condition now ALSO
  // guards the PUBLIC DEVICES section header (owner: public = separate engine
  // on top), so the LAST occurrence in source is the row pill's guard — the
  // pill still has to say "Public" within 400 chars of it.
  const pill = /!wrapper && d\.tier !== "private"/g;
  const all = [...listSrc.matchAll(pill)];
  assert.ok(all.length >= 1, "the non-private condition exists");
  const idx = all[all.length - 1].index ?? -1;
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

// --- capability policy: option-C notices (lib/mesh-device.ts) ------------------
// Owner decision (2026-10-19, option C): tabs stay VISIBLE; control / clone /
// monitoring replace their live tool with an honest "not available here → move
// to private" notice instead of a connection that would never open.

test("P4b-3: control/clone/monitoring are the notice tabs; summary/command/activity stay live", () => {
  assert.deepEqual(
    [...MESH_ONLY_NOTICE_TABS].sort(),
    ["clone", "control", "monitoring"],
  );
  assert.equal(isMeshOnlyNoticeTab("control"), true);
  assert.equal(isMeshOnlyNoticeTab("clone"), true);
  assert.equal(isMeshOnlyNoticeTab("monitoring"), true);
  assert.equal(isMeshOnlyNoticeTab("summary"), false);
  assert.equal(isMeshOnlyNoticeTab("command"), false);
  assert.equal(isMeshOnlyNoticeTab("activity"), false);
});

test("P4b-3: each notice tab names its capability and points at move-to-private", () => {
  const nouns: Record<string, string> = {
    control: "Remote control",
    clone: "Browser session",
    monitoring: "Screen monitoring",
  };
  for (const [tab, noun] of Object.entries(nouns)) {
    const n = meshOnlyNotice(tab);
    assert.ok(n, `${tab} must produce a notice`);
    assert.match(n.title, new RegExp(noun), `${tab} title names the capability`);
    assert.match(n.body, /move it to private/i, `${tab} body gives the path forward`);
    assert.match(n.body, /no\s+Tactical agent/i, `${tab} body explains WHY`);
  }
});

test("P4b-3: live tabs (summary/command/activity) produce NO notice", () => {
  for (const tab of ["summary", "command", "activity", "", "bogus"]) {
    assert.equal(meshOnlyNotice(tab), null, `${tab} must be null`);
  }
});

// --- capability policy wired into the console (device-console.tsx) ------------

test("P4b-3: console derives meshOnly from the row id (node// discriminator)", () => {
  assert.match(consoleSrc, /const meshOnly = isMeshOnlyDevice\(device\?\.vantraAgentId\)/);
  // The id reaches the client through the already-serialized /api/devices row.
  assert.match(consoleSrc, /vantraAgentId: string \| null;/);
});

test("P4b-3: control/clone/monitoring each render MeshOnlyNotice instead of the live tool", () => {
  // One notice branch per gated tab…
  assert.match(consoleSrc, /<MeshOnlyNotice tab="control"/);
  assert.match(consoleSrc, /<MeshOnlyNotice tab="clone"/);
  assert.match(consoleSrc, /<MeshOnlyNotice tab="monitoring"/);
  // …and ControlTab / CloneTab / ScreenMonitoringCard only mount in the else
  // arm (never on a mesh-only device).
  assert.match(consoleSrc, /\{meshOnly \? \(\s*<MeshOnlyNotice tab="control"/);
  assert.match(consoleSrc, /\) : meshOnly \? \(\s*<MeshOnlyNotice tab="clone"/);
});

test("P4b-3: PIN panel is suppressed on a mesh-only device (needs a TRMM agent)", () => {
  assert.match(consoleSrc, /tab === "control" && !toolsLocked && !meshOnly && \(/);
});