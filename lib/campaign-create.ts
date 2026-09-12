// Task 27, Part B — shared campaign-create helper.
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { buildQueueItemRows, type RecipientInput } from "@/lib/campaign-recipients";

// Task 27, Part B — the ONE shared place that creates an EmailCampaign +
// its CampaignVariant rows + its EmailQueueItem roster in a single transaction.
//
// POST /api/campaigns and the automation run's send phase both call this, so the
// two can never drift (the plan's explicit "reuse not duplicate" mandate). It is
// deliberately given an already-resolved recipient list (RecipientInput[]) rather
// than a raw leadId set, mirroring POST /api/campaigns' per-source resolution
// upstream so both paths dedup/source-lead to recipients the same way.
//
// A created campaign starts at status "pending_test_confirm" — the existing
// test-send→confirm gate (POST /api/campaigns/[id]/confirm-test + the
// mail-queue drain) is the real send unlock, so a cloned automation campaign is
// gated identically to a hand-built one and never sends unattended.
export interface CreateCampaignInput {
  userId: string;
  name: string;
  mailboxIds: string[];
  variants: { subject: string; bodyHtml: string }[];
  recipients: RecipientInput[];
  rotateEvery?: number;
  searchJobId?: string | null;
}

export interface CreateCampaignResult {
  campaign: { id: string };
  recipientCount: number;
  // { [mailboxId]: count } — how many queued items were assigned to each
  // mailbox by the rotation, surfaced on a CampaignAutomationRun for Task 09's
  // per-mailbox send breakdown without re-scanning the queue on every read.
  byMailbox: Record<string, number>;
}

export async function createCampaign(input: CreateCampaignInput): Promise<CreateCampaignResult> {
  const mailboxIds = input.mailboxIds;
  const rotateEvery = Math.max(1, Math.min(1000, Math.floor(input.rotateEvery ?? 1)));

  // Dry-run pass to compute byMailbox's per-mailbox counts before the real
  // rows (and real variant ids) exist. buildQueueItemRows only reads
  // variantRows.length and each row's .id to STORE as variantId — since this
  // pass's output is discarded except for `rows.length`/mailboxId (never the
  // fabricated variantId itself), placeholder ids of the right COUNT are all
  // it needs; input.variants has no .id yet (the real CampaignVariant rows
  // are created inside the transaction below).
  const rows = buildQueueItemRows({
    campaignId: "", // discarded — this pass is never persisted
    mailboxIds,
    variantRows: input.variants.map((_, i) => ({ id: String(i) })),
    recipients: input.recipients,
    rotateEvery,
  });

  const byMailbox: Record<string, number> = {};
  for (const r of rows) {
    byMailbox[r.mailboxId] = (byMailbox[r.mailboxId] ?? 0) + 1;
  }

  const created = await prisma.$transaction(async (tx) => {
    const campaign = await tx.emailCampaign.create({
      data: {
        userId: input.userId,
        name: input.name,
        subject: "",
        bodyHtml: "",
        status: "pending_test_confirm",
        mailboxIds,
        rotateEvery,
        searchJobId: input.searchJobId ?? null,
      },
      select: { id: true },
    });

    const variantRows: { id: string }[] = [];
    for (const v of input.variants) {
      const row = await tx.campaignVariant.create({
        data: { campaignId: campaign.id, subject: v.subject, bodyHtml: v.bodyHtml },
        select: { id: true },
      });
      variantRows.push({ id: row.id });
    }

    await tx.emailQueueItem.createMany({
      data: buildQueueItemRows({
        campaignId: campaign.id,
        mailboxIds,
        variantRows,
        recipients: input.recipients,
        rotateEvery,
      }),
    });

    return campaign;
  });

  return { campaign: created, recipientCount: rows.length, byMailbox };
}