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
  // Task 29, item 3 — provenance. "manual_insert" = a test recipient the user
  // dropped into the queue at a chosen position; "" (default) = extracted /
  // uploaded / picked lead.
  source?: string;
}

// Task 29, item 3 — where a manually-inserted test recipient should land in the
// queue, and how many such inserts. `mode`:
//   "top"      — insert once at the very front (position 0).
//   "position" — insert once "after position N" (1-based; N recipients precede it),
//                i.e. at array index N.
//   "every"    — insert a fresh copy after every Nth recipient (indices N, 2N, …).
// The inserts re-enter the same buildQueueItemRows path below, so each still gets
// a mailboxId/variantId assigned by its final index like every other recipient.
export interface ManualInsertSpec {
  email: string;
  mode: "top" | "position" | "every";
  position?: number; // 1-based, for mode "position"
  everyN?: number; // for mode "every"
}

export function insertManualRecipients(
  recipients: RecipientInput[],
  spec: ManualInsertSpec,
): RecipientInput[] {
  const email = spec.email.trim().toLowerCase();
  if (!email || recipients.length === 0) return recipients;
  const mk = (): RecipientInput => ({ email, variables: {}, source: "manual_insert" });

  // "every N" — a fresh copy after every Nth original recipient (N=1 => after each).
  if (spec.mode === "every") {
    const everyN = Math.max(1, Math.floor(spec.everyN ?? 1));
    const out: RecipientInput[] = [];
    for (let i = 0; i < recipients.length; i++) {
      out.push(recipients[i]);
      if ((i + 1) % everyN === 0) out.push(mk());
    }
    return out;
  }

  // "top" inserts at the very front, before the first recipient.
  if (spec.mode === "top") {
    return [mk(), ...recipients];
  }

  // "position N" — insert at index N (the Nth, 1-based, recipient precedes it),
  // clamped to append at the end when N >= length.
  const insertAt = Math.min(
    recipients.length,
    Math.max(0, Math.floor(spec.position ?? 0)),
  );
  const out: RecipientInput[] = [];
  for (let i = 0; i < recipients.length; i++) {
    if (i === insertAt) out.push(mk());
    out.push(recipients[i]);
  }
  if (insertAt >= recipients.length) out.push(mk());
  return out;
}

// Task 26, Piece 5b — `rotateEvery` (EmailCampaign.rotateEvery, default 1) controls
// how many consecutive recipients share the SAME mailbox + subject variant before
// the rotation advances to the next: recipient i gets
//   mailboxIds[floor(i / rotateEvery) % len]   and   variantRows[floor(i / rotateEvery) % len]
// Default 1 reproduces the original per-recipient rotation exactly (non-breaking).
// `offsetIndex` lets the from-leads add-to-existing route continue the rotation at
// the campaign's current item count instead of restarting at 0, so a batch added
// later keeps rotating seamlessly across the whole roster.
//
// Task 29, item 4 — when `subjects`/`bodies` are supplied (a DECOUPLED campaign),
// subject and body rotate on their OWN indices, cross-combined per recipient:
// recipient i gets subject = `subjects[i % subjects.length]` and
// body = `bodies[i % bodies.length]` — NOT tied to each other or to the mailbox
// slot. A single-item list is held constant (i % 1 === 0) while the other
// dimension still rotates, and these resolved snapshots are stored on the item
// (`resolvedSubject`/`resolvedBodyHtml`) so the drain route needs no variant pair.
// When subjects/bodies are omitted, the legacy CampaignVariant pair path is used.
export function buildQueueItemRows(opts: {
  campaignId: string;
  mailboxIds: string[];
  variantRows?: { id: string }[];
  subjects?: string[];
  bodies?: string[];
  recipients: RecipientInput[];
  rotateEvery?: number;
  offsetIndex?: number;
}): Prisma.EmailQueueItemCreateManyInput[] {
  const { campaignId, mailboxIds, recipients, variantRows = [], subjects = [], bodies = [] } = opts;
  const rotateEvery = Math.max(1, Math.floor(opts.rotateEvery ?? 1));
  const offsetIndex = Math.max(0, Math.floor(opts.offsetIndex ?? 0));
  const decoupled = (subjects.length > 0 || bodies.length > 0);
  return recipients.map((r, i) => {
    // Mailbox rotation (unchanged): `rotateEvery` consecutive recipients share a
    // sender, then the next block advances — floor(i/rotateEvery) % len.
    const slot = Math.floor((i + offsetIndex) / rotateEvery) % mailboxIds.length;
    const row: Prisma.EmailQueueItemCreateManyInput = {
      campaignId,
      mailboxId: mailboxIds[slot],
      toEmail: r.email,
      variables: r.variables as Prisma.InputJsonValue,
      source: r.source ?? "",
    };
    if (decoupled) {
      // Independent per-recipient index rotation (item 4). A single-item list is
      // held constant (i % 1 === 0) while the other dimension still varies.
      const subject = subjects.length > 0 ? subjects[Math.floor((i + offsetIndex) % subjects.length)] : "";
      const body = bodies.length > 0 ? bodies[Math.floor((i + offsetIndex) % bodies.length)] : "";
      row.resolvedSubject = subject;
      row.resolvedBodyHtml = body;
    } else {
      // Legacy pair path — one CampaignVariant row provides both subject and body.
      row.variantId = variantRows[Math.floor((i + offsetIndex) / rotateEvery) % variantRows.length].id;
    }
    return row;
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