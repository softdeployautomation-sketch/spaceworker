import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";

// Sets a campaign's human-assisted deliverability test settings
// (EmailCampaign.testRecipientOverride / testRecipientPool / testFromOverride).
//
// Entry points:
//   1. Proactively, at campaign creation (the "use this recipient as my test
//      target instead of Gmail" option next to the manual-insert recipient).
//   2. Reactively, from the campaign detail page's failed-check prompt — after
//      the platform seed mailbox's automated check fails, the user either picks
//      an existing manual_insert recipient already in the queue, or types a new
//      email right there, and this route stores it before they retry the test.
//   3. The test-setup panel on the campaign detail page (2026-09-28): the user
//      keeps a SHORTLIST of addresses they can open and switches which one is
//      active between test sends ("did it land in my Gmail or my Outlook?"),
//      and pins the From address every test goes out as ("is the From what's
//      triggering spam?"). All of it lives here because this is the one route
//      that owns "how this campaign is tested", deliberately separate from
//      everything a real send reads — so none of this experimenting can leak
//      into the live send.
//
// Only meaningful while the campaign hasn't started sending — matches the
// test-send route's own guard.
//
// POST /api/campaigns/[id]/test-recipient
//   body: {
//     email?: string | null,   // the ACTIVE test recipient (null = back to the seed mailbox)
//     pool?:  string[],        // replace the whole shortlist
//     from?:  string | null,   // the From address every TEST send uses (null = normal rotation)
//   }
// Every field is optional and independent — the client sends only what changed.
export const MAX_TEST_RECIPIENTS = 20;

/**
 * A deliberately light shape check: the real proof an address works is the test
 * send the caller runs right after this, not a regex. It exists to catch typos
 * and stray whitespace, not to adjudicate RFC 5322 — so it insists only on
 * "exactly one @, no spaces, something on both sides", which still permits
 * internal-only addresses like user@localhost.
 */
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+$/.test(value);
}

/** Trim, drop blanks, de-duplicate (case-insensitively, keeping the first spelling). */
function normalizePool(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of input) {
    const value = typeof entry === "string" ? entry.trim() : "";
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= MAX_TEST_RECIPIENTS) break;
  }
  return out;
}

// POST /api/campaigns/[id]/test-recipient   body: { email?, pool?, from? }
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const campaign = await prisma.emailCampaign.findFirst({ where: { id, userId: session.userId } });
  if (!campaign) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (campaign.status === "sending" || campaign.status === "done") {
    return NextResponse.json(
      { error: "Campaign has already started or finished sending" },
      { status: 409 },
    );
  }

  let body: { email?: unknown; pool?: unknown; from?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const data: {
    testRecipientOverride?: string | null;
    testRecipientPool?: string[];
    testFromOverride?: string | null;
  } = {};

  // --- the ACTIVE test recipient -------------------------------------------
  let active: string | null | undefined;
  if ("email" in body) {
    const raw = typeof body.email === "string" ? body.email.trim() : "";
    if (raw && !looksLikeEmail(raw)) {
      return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
    }
    active = raw || null;
    data.testRecipientOverride = active;
  }

  // --- the shortlist -------------------------------------------------------
  // An explicitly-supplied pool wins (the client owns the list, so removals are
  // possible); otherwise an explicitly-set active address is folded in
  // automatically, which makes "type an address and test it" a single action
  // instead of "add it to the list, then select it".
  if ("pool" in body) {
    const pool = normalizePool(body.pool);
    if (!pool) {
      return NextResponse.json({ error: "pool must be an array of email addresses" }, { status: 400 });
    }
    const bad = pool.find((p) => !looksLikeEmail(p));
    if (bad) {
      return NextResponse.json({ error: `"${bad}" is not a valid email address` }, { status: 400 });
    }
    data.testRecipientPool = pool;
  }

  let pool = data.testRecipientPool ?? campaign.testRecipientPool;
  if (active && !pool.some((p) => p.toLowerCase() === active!.toLowerCase())) {
    if (pool.length >= MAX_TEST_RECIPIENTS) {
      return NextResponse.json(
        { error: `You can keep up to ${MAX_TEST_RECIPIENTS} test addresses — remove one first.` },
        { status: 400 },
      );
    }
    pool = [...pool, active];
    data.testRecipientPool = pool;
  }

  // A picker's active entry has to exist in its own list: if a supplied pool
  // dropped whatever was active, fall back to the seed mailbox rather than
  // leaving the UI pointing at an address it no longer offers.
  const resultingActive =
    "testRecipientOverride" in data ? data.testRecipientOverride ?? null : campaign.testRecipientOverride;
  if (resultingActive && !pool.some((p) => p.toLowerCase() === resultingActive.toLowerCase())) {
    data.testRecipientOverride = null;
  }

  // --- the test-only From address ------------------------------------------
  if ("from" in body) {
    const raw = typeof body.from === "string" ? body.from.trim() : "";
    if (raw && !looksLikeEmail(raw)) {
      return NextResponse.json({ error: "The test From address must be a valid email address" }, { status: 400 });
    }
    data.testFromOverride = raw || null;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Nothing to update — pass email, pool and/or from" }, { status: 400 });
  }

  const updated = await prisma.emailCampaign.update({
    where: { id },
    data,
    select: {
      id: true,
      testRecipientOverride: true,
      testRecipientPool: true,
      testFromOverride: true,
    },
  });

  return NextResponse.json(updated);
}
