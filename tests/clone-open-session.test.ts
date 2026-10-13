import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// TASK_204 — the "Open session" button was unclickable: it required
// `status === "active"` on the CLIENT while the hosted session row only
// exists after stepLaunch — and nothing drove `ready` → launch, so clones
// sat on "Almost ready" (cookies already injected) forever.
//
// WHY THIS FILE EXISTS: the fix is behavioural wiring inside a 3.3k-line
// client component that has no render harness in this repo, so per the house
// pattern (tests/device-idle-chip.test.ts) we pin the REAL component source:
// the gate must accept `ready`/`launching`, the click must drive the
// lifecycle BEFORE opening, the poll must self-heal stalled rows once, and
// the profile combobox must be wired to the account's own profile names.

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "..", "components", "device-console.tsx"), "utf8");

test("TASK_204: canOpenClone admits ready/launching/active — the cookie'd clone is clickable", () => {
  const fn = SRC.match(/function canOpenClone\(status: string\): boolean \{\s*return ([^;]+);/);
  assert.ok(fn, "canOpenClone must exist");
  const expr = fn![1];
  for (const s of ["active", "ready", "launching"]) {
    assert.ok(expr.includes(`"${s}"`), `canOpenClone must accept "${s}"`);
  }
  // Neither button may keep the old hard `!== "active"` gate.
  assert.ok(
    !SRC.includes('disabled={row.status !== "active"'),
    "no Open button may hard-require status === active",
  );
});

test("TASK_204: openCloneSession drives the lifecycle before opening the session", () => {
  const body = SRC.match(/async function openCloneSession\(cloneId: string\) \{[\s\S]*?\n  \}/);
  assert.ok(body, "openCloneSession must exist");
  const b = body![0];
  const drive = b.indexOf("driveCloneLifecycle(cloneId)");
  const get = b.indexOf('fetch(`/api/clones/${cloneId}/session`)');
  assert.ok(drive !== -1, "the click must drive the lifecycle (advance → launch)");
  assert.ok(get !== -1, "the click must still open the session route");
  assert.ok(drive < get, "the launch must be driven BEFORE the session fetch");
  assert.ok(
    b.includes("canOpenClone(row.status)"),
    "driving must be gated to launchable states — never mid-transfer clones",
  );
});

test("TASK_204: the poll self-heals a stalled ready clone exactly once per id", () => {
  assert.ok(
    SRC.includes("healKickedRef.current.add(r.id)"),
    "the self-heal must dedupe through healKickedRef so a row is kicked once",
  );
  assert.ok(
    SRC.includes('const stalledReady = r.status === "ready"'),
    "the heal must target rows parked at ready",
  );
  assert.ok(
    /stalledLaunch[\s\S]{0,120}status === "launching"/.test(SRC),
    "a launch dead for 3 minutes must also be re-kicked",
  );
  assert.ok(
    SRC.includes("if (r.session) continue;"),
    "rows that already have a session must never be re-driven",
  );
});

test("TASK_204: profile picker offers the account's own profiles and keeps free text", () => {
  assert.ok(
    SRC.includes('list="clone-profile-options"'),
    "the Profile input must be a combobox bound to the datalist",
  );
  assert.ok(
    SRC.includes('id="clone-profile-options"'),
    "the datalist must exist in the start card",
  );
  assert.ok(
    SRC.includes("props.clones.map((r) => r.profileName)"),
    "profile options must be derived from this user's own clone rows",
  );
});
