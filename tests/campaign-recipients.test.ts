import Module from "node:module";
import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

type Loader = {
  _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};

// House require pattern (HOW_WE_MOVE_FAST §4): "server-only" is stubbed so the
// plain-Node test runner can load lib/campaign-recipients.ts (which imports
// @/lib/prisma, which starts with `import "server-only"`). This stub does not
// touch production code.
function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    return original.call(this, request, parent, isMain);
  };
}
installRequireHook();

// `require` (not `import`) so the module loads AFTER the server-only stub is
// installed; `import` would hoist above this hook and re-throw.
const req = createRequire(import.meta.url);
const campaignRecipients = req("../lib/campaign-recipients") as typeof import("../lib/campaign-recipients");
const { buildQueueItemRows } = campaignRecipients;

// TASK_255 — regression guard for lib/campaign-recipients.ts fromName rotation.
//
// Task 29, item 5 — independent sender display names rotate on their own index
// alongside subjects/bodies/addresses. Recipient i gets
//   fromNames[floor((i + offsetIndex) % fromNames.length)]
// A single-item list is held constant (i % 1 === 0) while other dimensions still
// rotate. Empty => no display name (resolvedFromName is null).












const recipients = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ email: `user${i}@example.test`, variables: {} }));

test("fromNames rotates independently per recipient (i % len)", () => {
  const rows = buildQueueItemRows({
    campaignId: "c1",
    mailboxIds: ["m1"],
    recipients: recipients(6),
    fromNames: ["Weekly Reminder", "Newsletter"],
  });
  const names = rows.map((r) => r.resolvedFromName);
  assert.deepEqual(names, [
    "Weekly Reminder", // i=0 -> 0 % 2 = 0
    "Newsletter", // i=1 -> 1 % 2 = 1
    "Weekly Reminder", // i=2 -> 2 % 2 = 0
    "Newsletter", // i=3 -> 3 % 2 = 1
    "Weekly Reminder", // i=4 -> 4 % 2 = 0
    "Newsletter", // i=5 -> 5 % 2 = 1
  ]);
});

test("single-item fromNames list is held constant while subjects still rotate", () => {
  const rows = buildQueueItemRows({
    campaignId: "c1",
    mailboxIds: ["m1"],
    subjects: ["Hello", "Hi"],
    bodies: ["Body A", "Body B"],
    recipients: recipients(4),
    fromNames: ["Brand"], // single item -> constant
  });
  const names = rows.map((r) => r.resolvedFromName);
  assert.deepEqual(names, ["Brand", "Brand", "Brand", "Brand"]);
  // subjects/bodies still rotate independently
  assert.deepEqual(rows.map((r) => r.resolvedSubject), ["Hello", "Hi", "Hello", "Hi"]);
  assert.deepEqual(rows.map((r) => r.resolvedBodyHtml), ["Body A", "Body B", "Body A", "Body B"]);
});

test("empty fromNames => resolvedFromName is null on every row", () => {
  const rows = buildQueueItemRows({
    campaignId: "c1",
    mailboxIds: ["m1"],
    recipients: recipients(3),
    fromNames: [],
  });
  assert.ok(rows.every((r) => r.resolvedFromName === null), "resolvedFromName must be null when no from names");
});

test("fromNames with offsetIndex continues rotation across batches", () => {
  const first = buildQueueItemRows({
    campaignId: "c1",
    mailboxIds: ["m1"],
    recipients: recipients(3),
    fromNames: ["A", "B", "C"],
    offsetIndex: 0,
  });
  assert.deepEqual(first.map((r) => r.resolvedFromName), ["A", "B", "C"]);

  const second = buildQueueItemRows({
    campaignId: "c1",
    mailboxIds: ["m1"],
    recipients: recipients(3),
    fromNames: ["A", "B", "C"],
    offsetIndex: 3, // continue from where the first batch left off
  });
  assert.deepEqual(second.map((r) => r.resolvedFromName), ["A", "B", "C"]); // 3 % 3 = 0, 4 % 3 = 1, 5 % 3 = 2
});

test("fromNames omitted entirely => resolvedFromName is null", () => {
  const rows = buildQueueItemRows({
    campaignId: "c1",
    mailboxIds: ["m1"],
    recipients: recipients(2),
  });
  assert.ok(rows.every((r) => r.resolvedFromName === null), "no fromNames prop must yield null");
});
