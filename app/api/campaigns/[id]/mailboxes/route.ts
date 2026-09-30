import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import {
  applyCampaignMailboxChange,
  previewMailboxRemoval,
} from "@/lib/campaign-mailboxes";

// TASK_150 T4 — the DEDICATED route that edits a campaign's sending mailboxes,
// including while it is actively sending. It exists precisely so that the
// all-fields PATCH guard on `app/api/campaigns/[id]/route.ts` (which returns 409
// for an in-flight send, and whose semantics other surfaces depend on) does NOT
// have to be loosened. This route owns the one operation that genuinely needs to
// happen mid-send: taking a mailbox out (or adding one) without orphaning the
// already-pinned queue.
//
//   GET  ?remove=<mailboxId>  -> read-only preview: how many queued items would
//                                move and onto which remaining mailboxes.
//   POST { mailboxIds: [...] } -> apply. Removed mailboxes' `status:"queued"`
//                                items are reassigned round-robin across the
//                                remaining mailboxes in ONE transaction; sent
//                                items and their history are never touched.
//
// Both verbs are owner-scoped and the reassignment logic lives in
// `lib/campaign-mailboxes.ts` (transaction + invariants + the last-mailbox refusal).

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params; // MUST await — async in Next.js 16

  const removeMailboxId = new URL(req.url).searchParams.get("remove")?.trim() ?? "";
  if (removeMailboxId === "") {
    return NextResponse.json({ error: "Provide ?remove=<mailboxId> to preview a removal." }, { status: 400 });
  }

  const result = await previewMailboxRemoval(prisma, {
    campaignId: id,
    userId: session.userId,
    removeMailboxId,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(result.value);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params; // MUST await — async in Next.js 16

  let body: { mailboxIds?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (body.mailboxIds === undefined) {
    return NextResponse.json({ error: "mailboxIds is required" }, { status: 400 });
  }

  const result = await applyCampaignMailboxChange(prisma, {
    campaignId: id,
    userId: session.userId,
    nextMailboxIds: body.mailboxIds,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(result.value);
}
