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

export function buildQueueItemRows(opts: {
  campaignId: string;
  mailboxIds: string[];
  variantRows: { id: string }[];
  recipients: RecipientInput[];
}): Prisma.EmailQueueItemCreateManyInput[] {
  const { campaignId, mailboxIds, variantRows, recipients } = opts;
  return recipients.map((r, i) => ({
    campaignId,
    mailboxId: mailboxIds[i % mailboxIds.length],
    variantId: variantRows[i % variantRows.length].id,
    toEmail: r.email,
    variables: r.variables as Prisma.InputJsonValue,
  }));
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