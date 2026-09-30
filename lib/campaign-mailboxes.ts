// TASK_150 T4 — editing a campaign's sending mailboxes WHILE it is sending.
//
// WHY THIS MODULE EXISTS. Queue items are pinned to a mailbox at
// campaign-creation time (EmailQueueItem.mailboxId is required + FK), and the
// mail-queue drain selects by that pinned id and never consulted the campaign's
// mailboxIds. So changing `EmailCampaign.mailboxIds` alone was a no-op: the
// removed mailbox kept draining its own items. Before this, the edit was also
// blocked outright — PATCH /api/campaigns/[id] returns 409 while a campaign is
// "sending"/"paused_deliverability". This module is the engine behind the
// DEDICATED route that fixes both, without loosening that all-fields PATCH guard
// (other surfaces depend on its 409 semantics — see TASK_150 §3 T4 / decision D6).
//
// The ownership check + the whole reassignment run in ONE transaction so a drain
// tick can never observe a half-applied edit:
//   * only `status:"queued"` items are touched — sent items and their history are
//     never rewritten (a sent email's mailbox is a historical fact);
//   * every moved item keeps a NON-NULL mailboxId (the column is a required FK);
//   * no capacity maths — the drain already caps per tick by each mailbox's
//     remaining dailyLimit - sentToday and leaves the rest queued, so a second
//     scheduler here would only be a bug farm (decision D7).
//
// This file deliberately has NO runtime import of "@/lib/prisma" (only `import
// type`), so it can be loaded directly by the pure unit test and by the scratch-DB
// simulation, which injects its own client.
import type { PrismaClient } from "@prisma/client";

// The client may be the app's singleton or (in the sim) a throwaway one pointed at
// a scratch DB — both satisfy this shape. The route passes `@/lib/prisma`.
export type MailboxDb = PrismaClient;

export type MailboxEditResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };

export type MailboxRemovalTarget = {
  mailboxId: string;
  label: string;
  username: string;
  count: number;
};

export type MailboxRemovalPreview = {
  campaignId: string;
  removeMailboxId: string;
  removeLabel: string;
  queuedCount: number;
  targets: MailboxRemovalTarget[];
};

export type MailboxChangeSummary = {
  campaignId: string;
  mailboxIds: string[];
  removedMailboxIds: string[];
  movedCount: number;
  targetCounts: Record<string, number>;
};

/**
 * Trim + drop blanks + de-duplicate a client-supplied `mailboxIds` array. Returns
 * null only when the value is not an array at all, so the caller can distinguish
 * "malformed" (400) from "empty after cleaning" (also 400, but a different,
 * clearer message) — mirroring POST /api/campaigns' own normalization.
 */
export function normalizeMailboxIdList(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of input) {
    const id = typeof entry === "string" ? entry.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Round-robin the N reassigned items across the remaining mailboxes:
 * item i -> targetIds[i % targetIds.length]. Mirrors the even spread
 * `buildQueueItemRows` applies at queue-creation time (lib/campaign-recipients.ts)
 * closely enough for a mid-send move — deterministic, even, no capacity maths.
 * Returns [] when there is nowhere to send.
 */
export function roundRobinTargets(count: number, targetIds: string[]): string[] {
  if (targetIds.length === 0 || count <= 0) return [];
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(targetIds[i % targetIds.length]);
  return out;
}

/**
 * The From address a moved item should carry for its NEW mailbox: the same
 * `fromAddresses[i % len]` rotation queue-creation uses, or null when that mailbox
 * has none (the drain then falls back to fromAddresses[0] || SMTP username). This
 * is recomputed on a move because the drain PREFERS the item's pinned
 * `resolvedFromAddress`; leaving the removed mailbox's From on an item now sent
 * through a different mailbox would send as an address that mailbox may not be
 * allowed to use.
 */
export function rotatedFromAddress(index: number, fromAddresses: string[] | null | undefined): string | null {
  if (!Array.isArray(fromAddresses) || fromAddresses.length === 0) return null;
  return fromAddresses[index % fromAddresses.length];
}

/**
 * TASK_150 T4 — the drain's defensive predicate. An item is pinned to a mailbox
 * at queue-build time, but the campaign's LIVE `mailboxIds` is the authority:
 * the item may only be dispatched while that mailbox is still part of the
 * campaign. The drain calls this in its admit loop (right before it would build
 * an SMTP transport and send), so a tick that had already selected the row
 * before the owner removed the mailbox can never send from a mailbox the owner
 * took out of the campaign. Kept here (not inlined in the route) so the
 * regression test exercises the exact shipped predicate.
 */
export function isMailboxStillInCampaign(
  mailboxId: string,
  campaignMailboxIds: readonly string[],
): boolean {
  return campaignMailboxIds.includes(mailboxId);
}


async function loadOwnedCampaign(
  client: MailboxDb,
  campaignId: string,
  userId: string,
): Promise<{ id: string; status: string; mailboxIds: string[] } | null> {
  return client.emailCampaign.findFirst({
    where: { id: campaignId, userId },
    select: { id: true, status: true, mailboxIds: true },
  });
}

export const LAST_MAILBOX_ERROR =
  "A campaign needs at least one sending mailbox — removing the last one would leave its queue with nowhere to send from.";

/**
 * Read-only preview of what removing one mailbox from a campaign would do: how
 * many currently-queued items would move, and onto which remaining mailboxes.
 * Used by the UI's confirmation step. Never mutates anything.
 */
export async function previewMailboxRemoval(
  client: MailboxDb,
  opts: { campaignId: string; userId: string; removeMailboxId: string },
): Promise<MailboxEditResult<MailboxRemovalPreview>> {
  const campaign = await loadOwnedCampaign(client, opts.campaignId, opts.userId);
  if (!campaign) return { ok: false, status: 404, error: "Not found" };

  if (!campaign.mailboxIds.includes(opts.removeMailboxId)) {
    return { ok: false, status: 400, error: "That mailbox is not part of this campaign." };
  }
  const remaining = campaign.mailboxIds.filter((id) => id !== opts.removeMailboxId);
  if (remaining.length === 0) {
    return { ok: false, status: 400, error: LAST_MAILBOX_ERROR };
  }

  const queued = await client.emailQueueItem.findMany({
    where: { campaignId: campaign.id, mailboxId: opts.removeMailboxId, status: "queued" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  const assigned = roundRobinTargets(queued.length, remaining);
  const counts = new Map<string, number>();
  for (const id of assigned) counts.set(id, (counts.get(id) ?? 0) + 1);

  const rows = await client.mailbox.findMany({
    where: { id: { in: remaining } },
    select: { id: true, label: true, username: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const targets: MailboxRemovalTarget[] = remaining.map((id) => {
    const row = byId.get(id);
    return {
      mailboxId: id,
      label: row?.label || row?.username || id,
      username: row?.username ?? "",
      count: counts.get(id) ?? 0,
    };
  });

  const removeRow = await client.mailbox.findUnique({
    where: { id: opts.removeMailboxId },
    select: { label: true, username: true },
  });

  return {
    ok: true,
    value: {
      campaignId: campaign.id,
      removeMailboxId: opts.removeMailboxId,
      removeLabel: removeRow?.label || removeRow?.username || opts.removeMailboxId,
      queuedCount: queued.length,
      targets,
    },
  };
}


/**
 * Replace a campaign's sending-mailbox list. Removed mailboxes' still-queued
 * items are reassigned round-robin across the remaining mailboxes in the SAME
 * transaction as the `mailboxIds` write.
 *
 * Rules enforced here (TASK_150 §3 T4):
 *   * an empty resulting list is REFUSED — never orphan the queue;
 *   * only `status:"queued"` items move; sent/failed history is untouched;
 *   * every moved item keeps a non-null `mailboxId` (required FK);
 *   * adding a mailbox is allowed and just persists the list (it has no pinned
 *     items yet; the next queue-build rotation picks it up).
 */
export async function applyCampaignMailboxChange(
  client: MailboxDb,
  opts: { campaignId: string; userId: string; nextMailboxIds: unknown },
): Promise<MailboxEditResult<MailboxChangeSummary>> {
  const campaign = await loadOwnedCampaign(client, opts.campaignId, opts.userId);
  if (!campaign) return { ok: false, status: 404, error: "Not found" };

  const next = normalizeMailboxIdList(opts.nextMailboxIds);
  if (!next) return { ok: false, status: 400, error: "mailboxIds must be an array of mailbox ids." };
  if (next.length === 0) return { ok: false, status: 400, error: LAST_MAILBOX_ERROR };

  // Every requested mailbox must belong to this user — a cross-tenant id must
  // never be persisted onto another user's campaign (same stance as
  // POST /api/campaigns).
  const owned = await client.mailbox.findMany({
    where: { id: { in: next }, userId: opts.userId },
    select: { id: true },
  });
  const ownedSet = new Set(owned.map((m) => m.id));
  const unknown = next.filter((id) => !ownedSet.has(id));
  if (unknown.length > 0) {
    return { ok: false, status: 400, error: "One or more mailboxes not found" };
  }

  const summary = await client.$transaction(async (tx) => {
    // Re-read INSIDE the transaction so the removed set is judged against
    // committed state, even if a concurrent edit landed since the pre-check.
    const live = await tx.emailCampaign.findUnique({
      where: { id: campaign.id },
      select: { mailboxIds: true },
    });
    const liveIds = live?.mailboxIds ?? [];
    const removed = liveIds.filter((id) => !next.includes(id));

    await tx.emailCampaign.update({
      where: { id: campaign.id },
      data: { mailboxIds: next },
    });

    if (removed.length === 0) {
      return { removedMailboxIds: [] as string[], movedCount: 0, targetCounts: {} as Record<string, number> };
    }

    const queued = await tx.emailQueueItem.findMany({
      where: { campaignId: campaign.id, mailboxId: { in: removed }, status: "queued" },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (queued.length === 0) {
      return { removedMailboxIds: removed, movedCount: 0, targetCounts: {} as Record<string, number> };
    }

    const fromRows = await tx.mailbox.findMany({
      where: { id: { in: next } },
      select: { id: true, fromAddresses: true },
    });
    const fromById = new Map(fromRows.map((m) => [m.id, m.fromAddresses]));

    const assigned = roundRobinTargets(queued.length, next);
    const targetCounts: Record<string, number> = {};
    // Group by (target mailbox, resolved From) so one updateMany covers each
    // distinct pair instead of one UPDATE per item (a 5k-item campaign stays a
    // handful of statements).
    const groups = new Map<string, { mailboxId: string; resolvedFromAddress: string | null; ids: string[] }>();
    for (let i = 0; i < queued.length; i++) {
      const mailboxId = assigned[i];
      const resolvedFromAddress = rotatedFromAddress(i, fromById.get(mailboxId));
      const key = `${mailboxId}\u0000${resolvedFromAddress ?? ""}`;
      let group = groups.get(key);
      if (!group) {
        group = { mailboxId, resolvedFromAddress, ids: [] };
        groups.set(key, group);
      }
      group.ids.push(queued[i].id);
      targetCounts[mailboxId] = (targetCounts[mailboxId] ?? 0) + 1;
    }

    for (const group of groups.values()) {
      await tx.emailQueueItem.updateMany({
        where: { id: { in: group.ids } },
        data: {
          mailboxId: group.mailboxId,
          resolvedFromAddress: group.resolvedFromAddress,
        },
      });
    }

    return { removedMailboxIds: removed, movedCount: queued.length, targetCounts };
  });

  return {
    ok: true,
    value: {
      campaignId: campaign.id,
      mailboxIds: next,
      removedMailboxIds: summary.removedMailboxIds,
      movedCount: summary.movedCount,
      targetCounts: summary.targetCounts,
    },
  };
}

