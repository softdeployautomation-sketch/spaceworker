import { NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import { deleteClone, getClone } from "@/lib/clone";

export const dynamic = "force-dynamic";

// TASK_110 (bit B4) — /api/clones/[cloneId].
// GET: single clone status/progress (for polling). DELETE: deleteClone() —
// terminal states only. Owner-scoping (rule 3): session.userId is passed to the
// orchestrator for every call, so another user's clone is 404, never 403.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ cloneId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { cloneId } = await params;

  try {
    const clone = await getClone(cloneId, session.userId);
    if (!clone) {
      return NextResponse.json({ error: "not_found", reason: "No such clone." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, clone });
  } catch (err) {
    return failure(err);
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ cloneId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { cloneId } = await params;

  try {
    const result = await deleteClone(cloneId, session.userId);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return failure(err);
  }
}

/** Never leak a raw upstream body (HTML) into the caller's diagnosis (rule 4). */
function sanitize(message: string): string {
  return /<!DOCTYPE|<html/i.test(message)
    ? "clone_unavailable: the agent answered with an HTML page (deploy outdated?) — check the Vantra deploy."
    : message;
}

function failureReason(err: unknown): string {
  return sanitize(unknownMessage(err));
}

function unknownMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Upstream-shape guard (rule 4): the UI must never render a raw agent/Vantra body. */
function failure(err: unknown): NextResponse {
  const text = failureReason(err);
  if (/not found|no such clone/.test(text)) {
    return NextResponse.json({ error: "not_found", reason: "No such clone." }, { status: 404 });
  }
  if (/clone is still .* — revoke it first|clone_state_conflict/.test(text)) {
    // Live record (revoke first) or a raced concurrent transition.
    return NextResponse.json({ error: "clone_not_terminal", reason: text }, { status: 409 });
  }
  // Anything else (DB outage): a stable code + generic reason.
  return NextResponse.json(
    { error: "clone_failed", reason: "The clone could not be read — try again." },
    { status: 502 },
  );
}

/** Never leak a raw upstream body (HTML) into the UI (rule 4). */