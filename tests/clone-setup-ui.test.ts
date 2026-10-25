import { test } from "node:test";
import assert from "node:assert/strict";

import { isOfflineHeadline, staleOfflineErrCleared } from "../lib/clone-setup-ui";

// TASK_242 — the clone-setup card must never keep claiming "offline" for a
// device a fresh status read just proved is online.

test("TASK_242: an offline headline is dropped once the device reads online", () => {
  assert.equal(staleOfflineErrCleared(true, "This device is currently offline."), "");
  assert.equal(
    staleOfflineErrCleared(true, "This PC is offline — bring it online, then run setup again."),
    "",
  );
});

test("TASK_242: a non-offline error survives an online read", () => {
  const running = "A setup is already running for this PC — wait for it to finish, then try again.";
  assert.equal(staleOfflineErrCleared(true, running), running);
  // The truthful transient message is NOT an offline claim, so it stays (it is
  // still the reason the last attempt failed; the next run clears it).
  const agent = "The agent didn’t answer that command just now — the PC is online, so try again.";
  assert.equal(staleOfflineErrCleared(true, agent), agent);
});

test("TASK_242: an offline headline stays while the device is offline", () => {
  assert.equal(
    staleOfflineErrCleared(false, "This device is currently offline."),
    "This device is currently offline.",
  );
});

test("TASK_242: isOfflineHeadline matches only offline claims", () => {
  assert.equal(isOfflineHeadline("This device is currently offline."), true);
  assert.equal(isOfflineHeadline("agent_not_responding"), false);
  assert.equal(isOfflineHeadline(""), false);
});
