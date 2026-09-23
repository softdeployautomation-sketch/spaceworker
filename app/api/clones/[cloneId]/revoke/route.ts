import { NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import { getClone, revokeClone } from "@/lib/clone";

export const dynamic = "force-dynamic";

// TASK_110 (bit B4) — POST /api/clones/[cloneId]/revoke.
// revokeClone(). Safe to call repeatedly: revoking an already-terminal clone is
// a no-op that reports { revoked:false, reason } — HTTP 200 either way, because
// the caller's goal ("this clone must be stopped") is satisfied.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ cloneId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { cloneId } = await params;

  try {
    // Owner-scope every read and write (rule 3): a clone belonging to another
    // user is 404 here, before any orchestrator call.
    const existing = await getClone(cloneId, session.userId);
    if (!existing) {
      return NextResponse.json({ error: "not_found", reason: "No such clone." }, { status: 404 });
    }

    // Actor is always the session owner: revocation authority flows from
    // session.userId, never from the request body (rules 1–3).
    const result = await revokeClone(cloneId, "user");
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return failure(err);
  }
}

/** Upstream-shape guard (rule 4): the UI must never render a raw agent/Vantra body. */
function failure(err: unknown): NextResponse {
  const text = sanitize(unknownMessage(err));
  if (/not found|no such clone/.test(text)) {
    // A raced delete between the owner-scoped read and the revoke.
    return NextResponse.json({ error: "not_found", reason: "No such clone." }, { status: 404 });
  }
  // Anything else (DB outage, transport throw): a stable code + generic reason.
  return NextResponse.json(
    { error: "revoke_failed", reason: "The clone could not be revoked — try again." },
    { status: 502 },
  );
}

/** Never leak a raw upstream body (HTML) into the UI (rule 4). */
function sanitize(message: string): string {
  return /<!DOCTYPE|<html/i.test(message)
    ? "clone_unavailable: the agent answered with an HTML page (deploy outdated?) — check the Vantra deploy."
    : message;
}

function unknownMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
