import "server-only";
import { prisma } from "@/lib/prisma";

/**
 * The merge variables a TEST send should render with.
 *
 * WHY THIS MODULE EXISTS (confirmed live 2026-09-30): `runTestSend` rendered every
 * placeholder with an EMPTY variable set —
 *
 *     renderMerge(opts.variant.bodyHtml, {})   // lib/deliverability.ts
 *
 * — so a template that was perfectly correct arrived in the test inbox as
 * "Hi ,". The user's own name never appeared, and the only way to tell a broken
 * template from a working one was to compare it against the LIVE send, which
 * renders with the item's real per-recipient variables. A test send whose whole
 * purpose is "is this the message a recipient gets?" cannot answer that question
 * while silently substituting blanks for the one thing that varies per recipient.
 *
 * So a token-only template ("Hi {{name}},") read as a GAP in every test, on every
 * campaign — regardless of the template, the CSV, or the source. This is the
 * second, independent half of that bug; the first half was the case-sensitivity of
 * the lookup itself (see lib/render-merge.ts).
 *
 * The rule implemented here, in order:
 *   1. Recipients already queued  -> the FIRST one's real variables. That is
 *      literally the message recipient #1 will receive, which is the most honest
 *      sample available and matches what the run-detail preview shows per item.
 *   2. No recipients queued yet   -> a clearly-synthetic sample person. A campaign
 *      gets test-sent before its recipient CSV is attached (test-setup comes
 *      first in the flow), so returning {} here would reproduce the exact "Hi ,"
 *      gap this module exists to remove. Every other unknown token still renders
 *      empty, so a genuinely mistyped placeholder remains visible as a gap.
 */

// Keys cover BOTH key shapes the UI hint documents ({{firstName}}/{{company}} for
// CSV columns, {{contactName}}/{{businessName}} for picked leads) plus the
// {{name}} alias, so the sample reads correctly whichever token the template uses.
const SAMPLE_VARS: Record<string, string> = {
  name: "Sample Name",
  firstName: "Sample",
  contactName: "Sample Name",
  company: "Sample Co",
  businessName: "Sample Co",
};

/**
 * Merge variables for a test/probe send of `campaignId`.
 *
 * Read-only and deliberately cheap (one count + one row) — the batch-gate probe
 * calls this once per sending campaign per drain tick, so it must not become a
 * load-bearing query on the send path.
 */
export async function testMergeVarsForCampaign(
  campaignId: string,
): Promise<Record<string, string>> {
  // One query, deliberately: a recipient with an EMPTY variables object and a
  // campaign with NO recipients at all need different answers, and the null-check
  // alone already separates them — count() would be a second round-trip for
  // information this row boundary already carries.
  const first = await prisma.emailQueueItem.findFirst({
    where: { campaignId },
    // Oldest-first matches the order the drain sends in, so these are the values
    // the earliest-queued recipient's real send will render.
    orderBy: { createdAt: "asc" },
    select: { variables: true },
  });
  if (!first) return { ...SAMPLE_VARS };

  const variables = first.variables;
  if (!variables || typeof variables !== "object" || Array.isArray(variables)) {
    // A manual-insert / lead recipient can legitimately carry no variables. The
    // honest answer is "nothing to substitute" — NOT the sample person, which
    // would imply a name was available for this campaign.
    return {};
  }

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(variables as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}
