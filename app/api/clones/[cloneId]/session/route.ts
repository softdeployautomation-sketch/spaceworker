import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { getSession } from "@/lib/session";
import { getClone } from "@/lib/clone";
import { getCloneSettings } from "@/lib/clone-settings";

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
    // TASK_244 — a MISSING row is not an error: the clone exists and is still
    // in `requested`/`ready`/`launching`, so the session window needs the
    // status to show its waiting screen and drive the next step. Only a
    // cross-user row is a 404.
    if (row && row.userId !== session.userId) {
      return NextResponse.json({ error: "not_found", reason: "No such clone." }, { status: 404 });
    }

    // TASK_243 — an OPEN clone is in use: refresh the idle clock on every
    // session read so the 15 s window poll can never let it expire mid-use.
    // The hard TTL still caps the session.
    let idleExpiresAt: string | null = clone.idleExpiresAt;
    if (clone.status === "active" && row?.status === "running") {
      const settings = await getCloneSettings();
      const now = new Date();
      const next = new Date(now.getTime() + settings.idleTtlMinutes * 60_000);
      idleExpiresAt = next.toISOString();
      await db.cloneJob
        .update({ where: { id: cloneId }, data: { lastUsedAt: now, idleExpiresAt: next } })
        .catch(() => {});
      await db.hostedBrowserSession
        .update({ where: { cloneJobId: cloneId }, data: { lastUsedAt: now } })
        .catch(() => {});
    }

    return NextResponse.json({
      ok: true,
      cloneId,
      status: clone.status,
      // The hosted-session open URL (stamped at launch). Null until the launch
      // step stamps it — the window shows a loading state meanwhile (TASK_111).
      openUrl: row?.viewUrl ?? null,
      session: row
        ? {
            id: row.id,
            status: row.status,
            egressMode: row.egressMode,
            startedAt: row.startedAt.toISOString(),
            lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
            stoppedAt: row.stoppedAt?.toISOString() ?? null,
            expiresAt: row.expiresAt?.toISOString() ?? null,
          }
        : null,
      display: {
        browser: clone.browser,
        profileName: clone.profileName,
        egressMode: clone.egressMode,
        source: clone.source,
        destination: clone.destination,
        launchedAt: clone.launchedAt,
        expiresAt: clone.expiresAt,
        ttlRemainingMs: clone.ttlRemainingMs,
        idleRemainingMs: idleExpiresAt
          ? Math.max(0, new Date(idleExpiresAt).getTime() - Date.now())
          : clone.idleRemainingMs,
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
