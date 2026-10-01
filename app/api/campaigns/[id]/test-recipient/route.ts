import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { MAX_TEST_SEND_RECIPIENTS, looksLikeEmail, normalizeRecipientList } from "@/lib/test-send-recipients";

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
//     email?:     string | null,  // the ACTIVE test recipient (null = back to the seed mailbox)
//     pool?:      string[],       // replace the whole shortlist
//     selection?: string[] | null, // TASK_150 T5 — which pool entries ONE test send
//                                  // goes to (all of them, or a ticked subset);
//                                  // null/[] = not in use, i.e. the active one only
//     from?:      string | null,  // the From address every TEST send uses (null = normal rotation)
//   }
// Every field is optional and independent — the client sends only what changed.
//
// TASK_150 T5 — a `selection` entry MUST already be in the resulting pool: this
// route owns the LIST, and the selection is only a ticked subset of it, never a
// second place an address can live. Selecting an address that isn't in the pool is
// rejected (400) rather than silently added, so the two can't drift apart.
export const MAX_TEST_RECIPIENTS = MAX_TEST_SEND_RECIPIENTS;

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

  let body: { email?: unknown; pool?: unknown; selection?: unknown; from?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const data: {
    testRecipientOverride?: string | null;
    testRecipientPool?: string[];
    testRecipientSelection?: string[];
    testFromOverride?: string | null;
  } = {};

  // What the client asked for as a multi-selection, if anything (resolved against
  // the pool further down, once that pool is final). An empty list = "not in use".
  let requestedSelection: { present: boolean; value: string[] } = { present: false, value: [] };

  // --- the ACTIVE test recipient -------------------------------------------
  let active: string | null | undefined;
  if ("email" in body) {
    const raw = typeof body.email === "string" ? body.email.trim() : "";
    if (raw && !looksLikeEmail(raw)) {
      return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
    }
    active = raw || null;
    data.testRecipientOverride = active;
    // TASK_150 T5 — picking ONE active address is the opposite instruction to a
    // multi-selection, and the two would otherwise both describe "where the next
    // test goes". The newest instruction wins: an explicit single pick (the
    // "Test this address" button, applyTestRecipient, campaign creation) clears
    // the multi-selection unless the same request sets one explicitly. Without
    // this, a stale ticked subset would silently outrank the address the user just
    // chose.
    if (!("selection" in body)) {
      requestedSelection = { present: true, value: [] };
    }
  }

  // --- the multi-selection (TASK_150 T5) -----------------------------------
  // Validated against the FINAL pool below, so only shape-checking happens here.
  if ("selection" in body) {
    if (body.selection === null) {
      // Accepted (and treated as "not in use") so a client written against the
      // nullable shape can still clear the selection.
      requestedSelection = { present: true, value: [] };
    } else {
      const selection = normalizeRecipientList(body.selection);
      if (!Array.isArray(body.selection)) {
        return NextResponse.json(
          { error: "selection must be an array of email addresses or null" },
          { status: 400 },
        );
      }
      const bad = selection.find((sel) => !looksLikeEmail(sel));
      if (bad) {
        return NextResponse.json({ error: `"${bad}" is not a valid email address` }, { status: 400 });
      }
      requestedSelection = { present: true, value: selection };
    }
  }

  // --- the shortlist -------------------------------------------------------
  // An explicitly-supplied pool wins (the client owns the list, so removals are
  // possible); otherwise an explicitly-set active address is folded in
  // automatically, which makes "type an address and test it" a single action
  // instead of "add it to the list, then select it".
  if ("pool" in body) {
    if (!Array.isArray(body.pool)) {
      return NextResponse.json({ error: "pool must be an array of email addresses" }, { status: 400 });
    }
    const pool = normalizeRecipientList(body.pool);
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

  // --- resolve the multi-selection against the FINAL pool -------------------
  // TASK_150 T5. An entry the pool doesn't contain is a 400 (this route is where
  // the address LIST lives — the selection only ever ticks entries of it), and
  // what IS stored is re-spelled from the pool so the two can never disagree on
  // casing. The stored value is small and additive: the pool is still the sole
  // owner of the addresses.
  if (requestedSelection.present) {
    const wanted = requestedSelection.value;
    if (wanted.length > 0) {
      const outside = wanted.find((sel) => !pool.some((p) => p.toLowerCase() === sel.toLowerCase()));
      if (outside) {
        return NextResponse.json(
          { error: `"${outside}" is not in this campaign's test-address list — add it first.` },
          { status: 400 },
        );
      }
      data.testRecipientSelection = wanted.map(
        (sel) => pool.find((p) => p.toLowerCase() === sel.toLowerCase())!,
      );
    } else {
      // Explicitly cleared. [] (not null — Prisma rejects optional lists) is the
      // "not in use" value the test-send precedence treats as "fall back to the
      // single active target".
      data.testRecipientSelection = [];
    }
  } else if (data.testRecipientPool) {
    // The list was replaced without mentioning the selection: anything it dropped
    // has to go too, or the selection would point outside the pool.
    const current = campaign.testRecipientSelection ?? [];
    const kept = current.filter((sel) => pool.some((p) => p.toLowerCase() === sel.toLowerCase()));
    if (kept.length !== current.length) data.testRecipientSelection = kept;
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
    return NextResponse.json(
      { error: "Nothing to update — pass email, pool, selection and/or from" },
      { status: 400 },
    );
  }

  const updated = await prisma.emailCampaign.update({
    where: { id },
    data,
    select: {
      id: true,
      testRecipientOverride: true,
      testRecipientPool: true,
      testRecipientSelection: true,
      testFromOverride: true,
    },
  });

  return NextResponse.json(updated);
}
