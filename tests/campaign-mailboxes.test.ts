import { test } from "node:test";
import assert from "node:assert/strict";

// TASK_150 T4 — regression guard for lib/campaign-mailboxes.ts and the drain's
// defensive mailbox check.
//
// WHY THIS FILE EXISTS: queue items are PINNED to a mailbox when the campaign is
// created (EmailQueueItem.mailboxId is required + FK), and the mail-queue drain
// selected by that pinned id and NEVER consulted the campaign's mailboxIds
// (app/api/internal/mail-queue-drain/route.ts:131-144). So "remove a mailbox from
// a campaign that is sending" was a silent no-op — the removed mailbox kept
// draining its own items — and the edit was additionally blocked outright, because
// the all-fields PATCH guard returns 409 while status is "sending". The dedicated
// route (app/api/campaigns/[id]/mailboxes) owns the operation instead, and this
// file pins the invariants that make it safe:
//
//   1. `isMailboxStillInCampaign` is FALSE for a mailbox no longer in the
//      campaign — this is the guard that stops a racing drain tick sending from a
//      mailbox the owner just removed.
//   2. Removing a mailbox MOVES exactly its `status:"queued"` items round-robin
//      across the remaining mailboxes, in one transaction — nothing lost, nothing
//      duplicated, and NO item left with a null mailboxId.
//   3. SENT items and their history are never rewritten (a sent email's mailbox
//      is a historical fact, not a routing preference).
//   4. Removing the LAST mailbox is REFUSED with a clear error and changes
//      nothing at all.
//
// The pure half needs no DB and always runs. The DB half is the part that proves
// the routing invariants against real rows; it needs a scratch database and is
// gated on T150_T4_SCRATCH_DB (point it at a throwaway DB built from
// schema.prisma — NEVER a shared/live one), so a normal `tsx --test` run on a
// machine without one still passes rather than failing on a missing connection.
//
// The module under test has no RUNTIME import of "@/lib/prisma" (only `import
// type`), so it is loaded with the house `require` pattern (HOW_WE_MOVE_FAST §4)
// — a bare `import ... from "../lib/campaign-mailboxes"` fails `tsc` because the
// project does not enable `allowImportingTsExtensions`.

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  normalizeMailboxIdList,
  roundRobinTargets,
  rotatedFromAddress,
  isMailboxStillInCampaign,
  previewMailboxRemoval,
  applyCampaignMailboxChange,
  LAST_MAILBOX_ERROR,
} = require("../lib/campaign-mailboxes") as typeof import("../lib/campaign-mailboxes");
/* eslint-enable @typescript-eslint/no-require-imports */

// ---------------------------------------------------------------------------
// Pure invariants — no database.
// ---------------------------------------------------------------------------

test("normalizeMailboxIdList trims, drops blanks and de-duplicates (null only for non-arrays)", () => {
  assert.deepEqual(normalizeMailboxIdList([" a ", "b", "a", "", "  ", "c"]), ["a", "b", "c"]);
  assert.deepEqual(normalizeMailboxIdList([]), []);
  assert.equal(normalizeMailboxIdList("a"), null);
  assert.equal(normalizeMailboxIdList(undefined), null);
});

test("roundRobinTargets spreads N items evenly and returns [] when there is nowhere to send", () => {
  assert.deepEqual(roundRobinTargets(5, ["b", "c"]), ["b", "c", "b", "c", "b"]);
  assert.deepEqual(roundRobinTargets(0, ["b", "c"]), []);
  assert.deepEqual(roundRobinTargets(3, []), []);
});

test("rotatedFromAddress falls back to null when a mailbox has no From addresses", () => {
  assert.equal(rotatedFromAddress(0, ["a@x", "b@x"]), "a@x");
  assert.equal(rotatedFromAddress(3, ["a@x", "b@x"]), "b@x");
  assert.equal(rotatedFromAddress(0, []), null);
  assert.equal(rotatedFromAddress(0, null), null);
});

// The drain guard itself. This is the check that has to FIRE when a mailbox has
// been removed mid-send; a plausible "simplification" that dropped it would let a
// drain tick send from a mailbox the owner took out of the campaign.
test("isMailboxStillInCampaign is false for a mailbox no longer in the campaign (and true while it is)", () => {
  assert.equal(isMailboxStillInCampaign("A", ["B", "C"]), false);
  assert.equal(isMailboxStillInCampaign("A", ["A", "B", "C"]), true);
  assert.equal(isMailboxStillInCampaign("A", []), false);
});

// ---------------------------------------------------------------------------
// Scratch-DB half. Proves the routing invariants against real rows.
// Skipped unless T150_T4_SCRATCH_DB points at a throwaway database.
// ---------------------------------------------------------------------------

const SCRATCH_URL = process.env.T150_T4_SCRATCH_DB;

test("DB: removing a mailbox mid-send moves only its QUEUED items and nothing else", { skip: !SCRATCH_URL }, async () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { PrismaClient } = require("@prisma/client") as typeof import("@prisma/client");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const db = new PrismaClient({ datasourceUrl: SCRATCH_URL });

  const tag = `t4_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const log = (...parts: unknown[]) => console.log("[T4]", ...parts);

  const rowCounts = async (campaignId: string) => {
    const rows = await db.emailQueueItem.groupBy({
      by: ["mailboxId", "status"],
      where: { campaignId },
      _count: { _all: true },
    });
    return rows
      .map((r) => `${r.mailboxId.slice(-6)}/${r.status}=${r._count._all}`)
      .sort()
      .join(" ");
  };

  // ---- seed: a SENDING campaign over 3 mailboxes -------------------------
  const user = await db.user.create({ data: { email: `${tag}@t.test`, passwordHash: "x" } });
  const mkMailbox = (suffix: string, fromAddresses: string[], label: string) =>
    db.mailbox.create({
      data: {
        userId: user.id,
        label,
        host: `smtp.${suffix}.test`,
        port: 465,
        username: `u@${suffix}.test`,
        encryptedPassword: "x",
        passwordIv: "x",
        passwordTag: "x",
        fromAddresses,
      },
    });
  const A = await mkMailbox("a", ["a1@a.test", "a2@a.test"], "Mailbox A");
  const B = await mkMailbox("b", ["b1@b.test"], "Mailbox B");
  const C = await mkMailbox("c", [], "Mailbox C");

  const campaign = await db.emailCampaign.create({
    data: { userId: user.id, name: `T4 ${tag}`, status: "sending", mailboxIds: [A.id, B.id, C.id] },
  });
  const variant = await db.campaignVariant.create({
    data: { campaignId: campaign.id, subject: "s", bodyHtml: "b" },
  });
  const mkItem = (mailboxId: string, status: string, n: number) =>
    db.emailQueueItem.create({
      data: {
        campaignId: campaign.id,
        mailboxId,
        variantId: variant.id,
        toEmail: `${tag}.${status}.${mailboxId.slice(-6)}.${n}@t.test`,
        status,
        ...(status === "sent" ? { sentAt: new Date() } : {}),
      },
    });
  for (let i = 0; i < 5; i++) await mkItem(A.id, "queued", i); // A: 5 queued
  for (let i = 0; i < 4; i++) await mkItem(B.id, "queued", i); // B: 4 queued
  for (let i = 0; i < 3; i++) await mkItem(C.id, "queued", i); // C: 3 queued
  await mkItem(A.id, "sent", 99); // A: 1 sent (history that MUST NOT move)
  await mkItem(A.id, "failed", 98); // A: 1 failed (history that MUST NOT move)

  const before = await db.emailQueueItem.findMany({
    where: { campaignId: campaign.id },
    select: { id: true, mailboxId: true, status: true },
    orderBy: { id: "asc" },
  });
  log("BEFORE counts:", await rowCounts(campaign.id));
  log("BEFORE total items:", before.length);


  // ---- REPRODUCE THE BUG FIRST ------------------------------------------
  // Exactly what the drain used to select on (route.ts:131-144): pinned mailboxId
  // + status queued + campaign sending. It never looked at campaign.mailboxIds, so
  // with A removed from the campaign it STILL returned A's queued items — i.e. the
  // removed mailbox would keep sending. This is the failing condition, on real rows.
  const pinnedOnlyDrainSelect = (mailboxId: string) =>
    db.emailQueueItem.findMany({
      where: { mailboxId, status: "queued", campaign: { status: "sending" } },
      select: { id: true },
    });

  await db.emailCampaign.update({ where: { id: campaign.id }, data: { mailboxIds: [B.id, C.id] } });
  const bugRows = await pinnedOnlyDrainSelect(A.id);
  const bugCampaign = await db.emailCampaign.findUnique({ where: { id: campaign.id }, select: { mailboxIds: true } });
  log("BUG REPRO campaign.mailboxIds:", JSON.stringify(bugCampaign?.mailboxIds));
  log("BUG REPRO old drain select for removed mailbox A -> rows:", bugRows.length);
  assert.ok(bugRows.length > 0, "failing condition not reproduced: old select found no items for the removed mailbox");
  // restore the pre-fix state so the real fix runs from [A,B,C]
  await db.emailCampaign.update({ where: { id: campaign.id }, data: { mailboxIds: [A.id, B.id, C.id] } });

  // ---- THE FIX ----------------------------------------------------------
  const preview = await previewMailboxRemoval(db, {
    campaignId: campaign.id,
    userId: user.id,
    removeMailboxId: A.id,
  });
  assert.equal(preview.ok, true);
  log("PREVIEW removed:", preview.ok ? preview.value.removeLabel : "-");
  log("PREVIEW queuedCount:", preview.ok ? preview.value.queuedCount : "-");
  log(
    "PREVIEW targets:",
    preview.ok
      ? preview.value.targets.map((t) => `${t.label}=${t.count}`).join(" ")
      : "-",
  );
  assert.equal(preview.ok && preview.value.queuedCount, 5, "A had 5 queued items");

  const applied = await applyCampaignMailboxChange(db, {
    campaignId: campaign.id,
    userId: user.id,
    nextMailboxIds: [B.id, C.id],
  });
  assert.equal(applied.ok, true);
  log("APPLY movedCount:", applied.ok ? applied.value.movedCount : "-");
  log("APPLY targetCounts:", applied.ok ? JSON.stringify(applied.value.targetCounts) : "-");

  const after = await db.emailQueueItem.findMany({
    where: { campaignId: campaign.id },
    select: { id: true, mailboxId: true, status: true },
    orderBy: { id: "asc" },
  });
  log("AFTER counts:", await rowCounts(campaign.id));
  log("AFTER total items:", after.length);

  // nothing lost or duplicated: the id multiset is unchanged
  assert.deepEqual(after.map((r) => r.id), before.map((r) => r.id), "item ids changed — something was lost or duplicated");
  // queued total unchanged (12), just redistributed
  assert.equal(after.filter((r) => r.status === "queued").length, 12);
  // no queued item remains pinned to the removed mailbox
  assert.equal(after.filter((r) => r.mailboxId === A.id && r.status === "queued").length, 0);
  // moved 5 across B(4 queued before)+C(3) => B 7, C 5
  assert.equal(after.filter((r) => r.mailboxId === B.id && r.status === "queued").length, 7);
  assert.equal(after.filter((r) => r.mailboxId === C.id && r.status === "queued").length, 5);
  // sent + failed history stays pinned to A, untouched
  const sentOnA = after.find((r) => r.status === "sent");
  const failedOnA = after.find((r) => r.status === "failed");
  assert.equal(sentOnA?.mailboxId, A.id, "a SENT item's mailbox must never be rewritten");
  assert.equal(failedOnA?.mailboxId, A.id, "a FAILED item's history must never be rewritten");
  // never leave mailboxId null (required FK) — no orphaned rows
  const orphans = await db.$queryRawUnsafe<{ c: number }[]>(
    `select count(*)::int as c from "EmailQueueItem" i where i."mailboxId" is null`,
  );
  assert.equal(Number(orphans[0].c), 0);

  // ---- THE DRAIN GUARD --------------------------------------------------
  // Simulated race: a drain tick already holds an item pinned to A after the
  // owner's edit committed, so A is no longer in the campaign. The OLD select
  // still returns it (it would have been SENT); the guard now rejects it, so it
  // stays queued for the next tick instead of going out from a removed mailbox.
  const raceItem = await db.emailQueueItem.create({
    data: {
      campaignId: campaign.id,
      mailboxId: A.id,
      variantId: variant.id,
      toEmail: `${tag}.race@t.test`,
      status: "queued",
    },
  });
  const racySelected = await pinnedOnlyDrainSelect(A.id);
  const liveMailboxIds =
    (await db.emailCampaign.findUnique({ where: { id: campaign.id }, select: { mailboxIds: true } }))?.mailboxIds ?? [];
  const admitted = racySelected.filter(() => isMailboxStillInCampaign(A.id, liveMailboxIds));
  log("RACE live campaign.mailboxIds:", JSON.stringify(liveMailboxIds));
  log("RACE selected by pin-only:", racySelected.length, " admitted after guard:", admitted.length);
  assert.ok(racySelected.length > 0, "race setup did not reproduce a selectable item");
  assert.equal(admitted.length, 0, "guard failed to block a removed mailbox");
  await db.emailQueueItem.delete({ where: { id: raceItem.id } });


  // ---- LAST-MAILBOX REFUSAL --------------------------------------------
  // The campaign now sends from B and C only. Shrinking it to just C is fine;
  // shrinking it to NOTHING must be refused with a clear message and change
  // absolutely nothing (the queue has nowhere to go, and mailboxId is a required FK).
  const okShrink = await applyCampaignMailboxChange(db, {
    campaignId: campaign.id,
    userId: user.id,
    nextMailboxIds: [C.id],
  });
  assert.equal(okShrink.ok, true, "shrinking to one remaining mailbox should succeed");
  log("SHRINK to [C] ok; campaign.mailboxIds now:", JSON.stringify(okShrink.ok ? okShrink.value.mailboxIds : null));

  const snapshotBefore = await db.emailQueueItem.findMany({
    where: { campaignId: campaign.id },
    select: { id: true, mailboxId: true, status: true },
    orderBy: { id: "asc" },
  });
  const campBefore = await db.emailCampaign.findUnique({ where: { id: campaign.id }, select: { mailboxIds: true } });

  const refused = await applyCampaignMailboxChange(db, {
    campaignId: campaign.id,
    userId: user.id,
    nextMailboxIds: [],
  });
  assert.equal(refused.ok, false, "empty mailboxIds must be refused");
  assert.equal(refused.ok ? 0 : refused.status, 400);
  log("REFUSAL error:", refused.ok ? "(none)" : refused.error);
  assert.equal(refused.ok ? "" : refused.error, LAST_MAILBOX_ERROR);

  // also refuse removing the LAST remaining mailbox (the UI's "remove" path)
  const refusedPreview = await previewMailboxRemoval(db, {
    campaignId: campaign.id,
    userId: user.id,
    removeMailboxId: C.id,
  });
  assert.equal(refusedPreview.ok, false);
  assert.equal(refusedPreview.ok ? "" : refusedPreview.error, LAST_MAILBOX_ERROR);

  const snapshotAfter = await db.emailQueueItem.findMany({
    where: { campaignId: campaign.id },
    select: { id: true, mailboxId: true, status: true },
    orderBy: { id: "asc" },
  });
  const campAfter = await db.emailCampaign.findUnique({ where: { id: campaign.id }, select: { mailboxIds: true } });
  log("REFUSAL campaign.mailboxIds before/after:", JSON.stringify(campBefore?.mailboxIds), "/", JSON.stringify(campAfter?.mailboxIds));
  assert.deepEqual(campAfter?.mailboxIds, campBefore?.mailboxIds, "refusal changed the campaign");
  assert.deepEqual(snapshotAfter, snapshotBefore, "refusal changed the queue");

  await db.emailQueueItem.deleteMany({ where: { campaignId: campaign.id } });
  await db.campaignVariant.deleteMany({ where: { campaignId: campaign.id } });
  await db.emailCampaign.delete({ where: { id: campaign.id } });
  await db.mailbox.deleteMany({ where: { userId: user.id } });
  await db.user.delete({ where: { id: user.id } });
  await db.$disconnect();
});

