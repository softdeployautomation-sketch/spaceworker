import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { getSession } from "@/lib/session";
import { getClone } from "@/lib/clone";

export const dynamic = "force-dynamic";

// TASK_110 (bit B4) — GET /api/clones/[cloneId]/session.
// The hosted-session open URL + display metadata for the full-screen window
// (TASK_111): openUrl (the viewer URL stamped at launch), plus everything the
// session window needs to draw its own thin toolbar (browser, profile name,
// egress mode, source/host names, expiry) — and nothing else. Rule 5: no
// profile contents, cookie data or job keys. HostedBrowserSession exposes no
// such columns here (server-only select), so the rule holds structurally, not
// by discipline.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ cloneId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { cloneId } = await params;

  try {
    // Owner-scope every read and write (rule 3): a clone belonging to another
    // user is 404 here, before the session row is even looked at.
    const clone = await getClone(cloneId, session.userId);
    if (!clone) {
      return NextResponse.json({ error: "not_found", reason: "No such clone." }, { status: 404 });
    }

    const row = await db.hostedBrowserSession.findUnique({
      where: { cloneJobId: cloneId },
      select: {
        id: true,
        userId: true,
        status: true,
        egressMode: true,
        startedAt: true,
        lastUsedAt: true,
        stoppedAt: true,
        expiresAt: true,
        viewUrl: true,
      },
    });
    // Belt-and-braces: the row, when present, must belong to this user too.
    if (!row || row.userId !== session.userId) {
      return NextResponse.json({ error: "not_found", reason: "No such clone." }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      cloneId,
      status: clone.status,
      // The hosted-session open URL (stamped at launch). Null until the launch
      // step stamps it — the window shows a loading state meanwhile (TASK_111).
      openUrl: row.viewUrl,
      session: {
        id: row.id,
        status: row.status,
        egressMode: row.egressMode,
        startedAt: row.startedAt.toISOString(),
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        stoppedAt: row.stoppedAt?.toISOString() ?? null,
        expiresAt: row.expiresAt?.toISOString() ?? null,
      },
      display: {
        browser: clone.browser,
        profileName: clone.profileName,
        egressMode: clone.egressMode,
        source: clone.source,
        destination: clone.destination,
        launchedAt: clone.launchedAt,
        expiresAt: clone.expiresAt,
        ttlRemainingMs: clone.ttlRemainingMs,
        idleRemainingMs: clone.idleRemainingMs,
      },
    });
  } catch {
    // DB outage here: stable code, generic reason — never engine internals.
    // (The parameter is intentionally unused: nothing about the failure is echoed.)
    return NextResponse.json(
      { error: "session_failed", reason: "The session could not be read — try again." },
      { status: 502 },
    );
  }
}
