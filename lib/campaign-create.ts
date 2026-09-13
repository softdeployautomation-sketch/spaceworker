// Task 27, Part B — shared campaign-create helper.
import { prisma } from "@/lib/prisma";
import { buildQueueItemRows, resolveFromAddressesByMailbox, type RecipientInput } from "@/lib/campaign-recipients";
import { env } from "@/lib/env";
import { assignLinkTokens, hasHttpLinks, rewriteLinks } from "@/lib/link-cloak";

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
  // Legacy pair-based content (1+ subject+body variants). Superseded by
  // subjects/bodies for decoupled rotation, but kept so automation template
  // cloning (which materializes a template's CampaignVariant rows) keeps working.
  variants?: { subject: string; bodyHtml: string }[];
  // Task 29, item 4 — independent subject/body lists. When supplied (non-empty),
  // the campaign is DECOUPLED: subject and body rotate on their own indices,
  // cross-combined per recipient, and no CampaignVariant rows are created.
  subjects?: string[];
  bodies?: string[];
  recipients: RecipientInput[];
  rotateEvery?: number;
  // Task 29, item 6 — per-batch deliverability checkpoint size (default 50, waits
  // for the DB default when omitted). Clamped to [1, 1000] like rotateEvery.
  batchSize?: number;
  // Task 35 — send pacing bounds in seconds. Defaults 5/45 reproduce the old
  // hardcoded jitter exactly for existing campaigns. min is floored at 1 and max
  // at min (safety floor — no 0-0 bot blast); the UI is an advanced control.
  minSendDelaySeconds?: number;
  maxSendDelaySeconds?: number;
  searchJobId?: string | null;
  // Human-assisted deliverability fallback (see lib/deliverability.ts) — set at
  // creation when the user opts to use their inserted test recipient instead of
  // the platform seed mailbox from the start.
  testRecipientOverride?: string | null;
  // Task 30, item 3 — opt-in link-redirect cloaking. When true and any body
  // contains absolute http(s) links, this helper creates a LinkRedirect row per
  // unique link and rewrites the stored bodies so each link points at
  // <appBaseUrl>/r/<token> instead of the raw target. Stored rewritten (so the
  // drain sends the cloaked absolute URL with no extra render-time work).
  cloakLinks?: boolean;
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
  const batchSize = Math.max(1, Math.min(1000, Math.floor(input.batchSize ?? 50)));
  // Task 35 — same server-side floor as POST /api/campaigns: min >= 1, max >= min.
  const minSendDelaySeconds = Math.max(1, Math.floor(input.minSendDelaySeconds ?? 5));
  const maxSendDelaySeconds = Math.max(
    minSendDelaySeconds,
    Math.floor(input.maxSendDelaySeconds ?? 45)
  );
  const subjects = (input.subjects ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
  let bodies = (input.bodies ?? []).map((b) => b.trim()).filter((b) => b.length > 0);
  let variants = (input.variants ?? []).filter((v) => v.subject.trim().length > 0 && v.bodyHtml.trim().length > 0);
  // Task 29, item 4 — a campaign is DECOUPLED when it supplies subject/body lists
  // (the new cross-rotated form). Legacy pair-based input (variants) is the same
  // path every pre-Task-29 campaign and automation template clone uses.
  const decoupled = subjects.length > 0 || bodies.length > 0;
  if (!decoupled && variants.length === 0) {
    throw new Error("A campaign needs at least one subject/body pair (or a subject and a body list).");
  }

  // Task 30, item 4 — the per-recipient From rotation source, loaded once here and
  // threaded into every buildQueueItemRows call so resolvedFromAddress is assigned
  // identically across every path that used this helper.
  const fromAddressesByMailbox = await resolveFromAddressesByMailbox(mailboxIds);

  // Task 30, item 3 — opt-in link cloaking. Assign a fresh token per unique
  // absolute http(s) link across every body, create a LinkRedirect row for each
  // inside the transaction, and store the REWRITTEN bodies (each link now points
  // at <appBaseUrl>/r/<token>), so the mail-queue drain sends the cloaked absolute
  // URL with no extra render-time work. Legacy variants are rewritten the same way.
  let tokenByUrl: Record<string, string> = {};
  if (input.cloakLinks && hasHttpLinks(...bodies, ...variants.map((v) => v.bodyHtml))) {
    tokenByUrl = assignLinkTokens(...bodies, ...variants.map((v) => v.bodyHtml));
    const baseUrl = env.appBaseUrl;
    bodies = bodies.map((b) => rewriteLinks(b, tokenByUrl, baseUrl));
    variants = variants.map((v) => ({ subject: v.subject, bodyHtml: rewriteLinks(v.bodyHtml, tokenByUrl, baseUrl) }));
  }

  // Dry-run pass to compute byMailbox's per-mailbox counts before the real
  // rows (and real variant ids) exist. buildQueueItemRows only reads
  // variantRows.length and each row's .id to STORE as variantId — since this
  // pass's output is discarded except for `rows.length`/mailboxId (never the
  // fabricated variantId itself), placeholder ids of the right COUNT are all
  // it needs.
  const rows = buildQueueItemRows({
    campaignId: "", // discarded — this pass is never persisted
    mailboxIds,
    // In decoupled mode subjects/bodies are passed directly; in legacy mode the
    // variants map 1:1 to placeholder variant ids so the block count matches.
    ...(decoupled
      ? { subjects, bodies }
      : { variantRows: variants.map((_, i) => ({ id: String(i) })) }),
    recipients: input.recipients,
    rotateEvery,
    fromAddressesByMailbox,
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
        batchSize,
        minSendDelaySeconds,
        maxSendDelaySeconds,
        // Decoupled content: store the independent (cloak-rewritten) lists; legacy keeps [].
        ...(decoupled ? { subjects, bodies } : {}),
        searchJobId: input.searchJobId ?? null,
        testRecipientOverride: input.testRecipientOverride?.trim() || null,
      },
      select: { id: true },
    });

    // Task 30, item 3 — persist the per-link redirects so GET /r/<token> resolves
    // and counts clicks. Created inside the same transaction as the campaign, so a
    // failed create leaves no dangling cloaked links.
    if (Object.keys(tokenByUrl).length > 0) {
      await tx.linkRedirect.createMany({
        data: Object.entries(tokenByUrl).map(([target, token]) => ({
          token,
          target,
          campaignId: campaign.id,
        })),
      });
    }

    // Legacy pair mode materializes 1+ CampaignVariant rows and assigns each
    // recipient a variantId; decoupled mode stores resolved subject/body on each
    // EmailQueueItem directly and creates no variant rows.
    const variantRows: { id: string }[] = [];
    if (!decoupled) {
      for (const v of variants) {
        const row = await tx.campaignVariant.create({
          data: { campaignId: campaign.id, subject: v.subject.trim(), bodyHtml: v.bodyHtml.trim() },
          select: { id: true },
        });
        variantRows.push({ id: row.id });
      }
    }

    await tx.emailQueueItem.createMany({
      data: buildQueueItemRows({
        campaignId: campaign.id,
        mailboxIds,
        ...(decoupled
          ? { subjects, bodies }
          : { variantRows }),
        recipients: input.recipients,
        rotateEvery,
        fromAddressesByMailbox,
      }),
    });

    return campaign;
  });

  return { campaign: created, recipientCount: rows.length, byMailbox };
}