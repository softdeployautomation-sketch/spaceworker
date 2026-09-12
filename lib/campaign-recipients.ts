import type { Prisma } from "@prisma/client";

// Task 26, Piece 4 — shared recipient → EmailQueueItem row builder.
//
// Both "add leads to a campaign" paths (the atomic create in
// POST /api/campaigns and the targeted POST /api/campaigns/[id]/recipients/from-leads)
// must assign mailboxId/variantId the exact same round-robin way the CSV-upload
// create path always has: recipient i gets mailboxIds[i % len] and variantRows[i % len].
// Keeping that logic in this one helper is what guarantees a recipient reaches the
// mailer identically whether it came from a CSV column or a validated Lead row.

export interface RecipientInput {
  email: string;
  variables: Record<string, unknown>;
}

// Task 26, Piece 5b — `rotateEvery` (EmailCampaign.rotateEvery, default 1) controls
// how many consecutive recipients share the SAME mailbox + subject variant before
// the rotation advances to the next: recipient i gets
//   mailboxIds[floor(i / rotateEvery) % len]   and   variantRows[floor(i / rotateEvery) % len]
// Default 1 reproduces the original per-recipient rotation exactly (non-breaking).
// `offsetIndex` lets the from-leads add-to-existing route continue the rotation at
// the campaign's current item count instead of restarting at 0, so a batch added
// later keeps rotating seamlessly across the whole roster.
export function buildQueueItemRows(opts: {
  campaignId: string;
  mailboxIds: string[];
  variantRows: { id: string }[];
  recipients: RecipientInput[];
  rotateEvery?: number;
  offsetIndex?: number;
}): Prisma.EmailQueueItemCreateManyInput[] {
  const { campaignId, mailboxIds, variantRows, recipients } = opts;
  const rotateEvery = Math.max(1, Math.floor(opts.rotateEvery ?? 1));
  const offsetIndex = Math.max(0, Math.floor(opts.offsetIndex ?? 0));
  return recipients.map((r, i) => {
    // Recipients (i + offsetIndex) across the whole roster; `rotateEvery` consecutive
    // recipients share the SAME mailbox AND subject variant (block rotation), then the
    // next `rotateEvery` move to the next pair — exactly the plan's
    // floor(i/rotateEvery) % len formula for both mailboxIds and variantRows.
    const slot = Math.floor((i + offsetIndex) / rotateEvery) % mailboxIds.length;
    const variantSlot = Math.floor((i + offsetIndex) / rotateEvery) % variantRows.length;
    return {
      campaignId,
      mailboxId: mailboxIds[slot],
      variantId: variantRows[variantSlot].id,
      toEmail: r.email,
      variables: r.variables as Prisma.InputJsonValue,
    };
  });
}

// The merge variables carried across for a Lead-derived recipient — mirrors the
// per-recipient merge vars the CSV path produces from extra columns, so a
// template's {{businessName}}/{{contactName}}/{{phone}}/{{website}} fields render
// identically whether the recipient came from a CSV or a validated Lead. Only
// non-empty values are included (same "skip blank cells" rule as parseRecipientsCsv).
export function leadToRecipient(input: {
  email?: string | null;
  businessName?: string | null;
  contactName?: string | null;
  phone?: string | null;
  website?: string | null;
}): RecipientInput | null {
  const email = (input.email ?? "").trim();
  if (!email) return null;
  const variables: Record<string, unknown> = {};
  if (input.businessName) variables.businessName = input.businessName;
  if (input.contactName) variables.contactName = input.contactName;
  if (input.phone) variables.phone = input.phone;
  if (input.website) variables.website = input.website;
  return { email, variables };
}