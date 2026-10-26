import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { canOpenClone, cloneOpenTitle, shouldDriveSession } from "../lib/clone-open";

// TASK_204/TASK_244 — "Open session" was both unclickable (a `requested`
// clone never advanced) and, when it was clickable, silently blocked: the
// handler awaited the lifecycle drive and a `/session` fetch before calling
// `window.open`, so browsers saw it outside the click and showed the pop-up
// prompt. The click now navigates synchronously to `/clone/<id>`; that page
// owns the drive. These assertions pin the split, plus the requested-heal.
//
// The component has no render harness, so per the house pattern
// (tests/device-idle-chip.test.ts) we pin the REAL source, and test the REAL
// `lib/clone-open.ts` module directly.

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "..", "components", "device-console.tsx"), "utf8");
const SESSION_SRC = readFileSync(join(HERE, "..", "components", "clone-session-view.tsx"), "utf8");

test("TASK_244: requested is openable; mid-capture and terminal states are not", () => {
  for (const s of ["requested", "ready", "launching", "active"]) {
    assert.equal(canOpenClone(s), true, `${s} must be openable`);
  }
  for (const s of ["awaiting_source", "capturing", "transferred", "failed", "revoked", "expired_idle"]) {
    assert.equal(canOpenClone(s), false, `${s} must not be openable`);
  }
  assert.match(cloneOpenTitle("requested"), /starts as soon as your PC/i);
});

test("TASK_244: only the safe states drive from the session window", () => {
  for (const s of ["requested", "ready", "launching"]) {
    assert.equal(shouldDriveSession(s), true, `${s} must drive from the session window`);
  }
  for (const s of ["active", "awaiting_source", "capturing", "failed"]) {
    assert.equal(shouldDriveSession(s), false, `${s} must never drive from the session window`);
  }
});

test("TASK_244: Open navigates synchronously — no await before window.open", () => {
  const fn = SRC.match(/function openCloneSession\(cloneId: string\) \{[\s\S]*?\n  \}/);
  assert.ok(fn, "openCloneSession must exist");
  const body = fn![0];
  assert.ok(!/async function openCloneSession/.test(body), "openCloneSession must not be async");
  assert.ok(!/\bawait\b/.test(body), "openCloneSession must not await — that is what blocked the tab");
  const openAt = body.indexOf("window.open(");
  assert.ok(openAt !== -1, "the click must call window.open");
  assert.ok(
    body.indexOf("`/clone/${cloneId}`") !== -1,
    "the click must open the session window (/clone/<id>)",
  );
  assert.ok(
    body.indexOf("window.location.assign(url)") > openAt,
    "a blocked popup must fall back to same-tab navigation",
  );
  // The old silent bug: window.open after the awaits.
  assert.ok(
    !SRC.includes('window.open(url, "_blank", "noopener")'),
    "no Open path may window.open after awaiting",
  );
});

test("TASK_244: the session window drives requested/ready/launching itself", () => {
  assert.ok(
    SESSION_SRC.includes("shouldDriveSession(payload.status)"),
    "the session page must gate the drive on the shared helper",
  );
  assert.ok(
    SESSION_SRC.includes("`/api/clones/${cloneId}/advance`"),
    "the session page must POST advance",
  );
  assert.ok(
    SESSION_SRC.includes("advBody.advanced !== true"),
    "the drive loop must stop when a step makes no progress",
  );
  assert.ok(
    SESSION_SRC.includes("waitingOnPc"),
    "the waiting screen must say when it is waiting on the PC",
  );
});

test("TASK_244: the console poll retries a requested clone on a throttle", () => {
  assert.ok(
    SRC.includes('const stalledRequested = r.status === "requested"'),
    "the heal must target requested rows",
  );
  assert.ok(
    SRC.includes("Date.now() - lastKick < 20_000"),
    "requested retries must be throttled, not fired every render",
  );
  assert.ok(
    SRC.includes("requestedKickRef.current.set(r.id, Date.now())"),
    "the requested throttle must record the kick time",
  );
  assert.ok(
    SRC.includes("healKickedRef.current.add(r.id)"),
    "ready/launching must keep the one-shot dedupe",
  );
  assert.ok(
    SRC.includes('const stalledReady = r.status === "ready"'),
    "the ready self-heal must stay",
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
