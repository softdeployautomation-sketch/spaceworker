// TASK_135 §6.2 — the console's "Sync profile state" action (device page).
//
// This is the MANUAL half of the state pipe: the operator asks one device to
// re-carry its browser profile's state into the clone cache, without starting a
// whole clone. It is the counterpart to the automatic sync that runs as part of a
// clone, and it exists because the useful case is a device whose replica is stale
// — new bookmarks, a fresh tab session — and nothing else needs doing.
//
// It is a DEVICE action, not a job action: the cache is keyed by device + browser
// + profile, so a sync is meaningful whether or not a clone job is pending. The
// job, when there is one, is only used to know WHICH browser and profile to carry,
// so the operator does not have to restate them.
//
// Manual own-device action, no approval rail — the same posture as Ping / Run now
// / clone setup. Because it is a run-command action, it is audited by the
// transport it uses (`device_run_now`).
//
// The reply is counts only: no path, no filename, no cookie, no token. The
// device's own result line is parsed, and an unparseable line is reported as its
// own named failure rather than as success.

import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { requestDeviceStateSync, stateSyncSummary } from "@/lib/clone-state-sync";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

function errorStatus(code: string): number {
  if (code === "device_not_owned" || code === "device_not_linked") return 404;
  if (code === "device_offline") return 502;
  if (code === "cmd_invalid") return 400;
  return 502;
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { deviceId } = await params;

  try {
    // Which browser and profile? Taken from the device's most recent clone job,
    // because that is the pair the replica is keyed by — syncing a different one
    // would fill a cache nothing will ever materialise. A device with no clone
    // history has nothing to keep in step, and says so rather than guessing.
    const job = await db.cloneJob.findFirst({
      where: { sourceDeviceId: deviceId, userId: session.userId },
      orderBy: { createdAt: "desc" },
      select: { id: true, browser: true, profileName: true },
    });
    if (!job) {
      return NextResponse.json(
        { ok: false, error: "state_sync_no_clone_target", reason: "No clone has been run for this device yet, so there is nothing to keep in step." },
        { status: 409 },
      );
    }

    const reply = await requestDeviceStateSync({
      userId: session.userId,
      deviceId,
      browser: job.browser,
      profileName: job.profileName,
      cloneJobId: job.id,
    });

    // Record what the manual run found on the SAME job the automatic path writes
    // to, so the card's line and the console's history row show the truth about
    // this replica either way it was started. A transport failure only names the
    // reason when no plan was ever made — the ingest route owns that field once a
    // plan exists, and overwriting a decision with "it timed out" would erase the
    // record of what was actually decided.
    await db.cloneJob
      .update({
        where: { id: job.id },
        data: {
          stateSyncPending: reply.failed ? undefined : reply.pending ?? 0,
          ...(reply.failed ? { stateSyncReason: reply.failed } : {}),
        },
      })
      .catch(() => undefined);

    // 202 for a sync that ran (even if individual files were skipped — that is
    // normal and counted), 502 for a named failure. The summary is the operator's
    // line; the fields are for anything machine-readable.
    return NextResponse.json(
      { ok: reply.ok, summary: stateSyncSummary(reply), reply, cloneJobId: job.id },
      { status: reply.ok ? 202 : 502 },
    );
  } catch (err) {
    const code = err instanceof Error ? err.message : "state_sync_failed";
    return NextResponse.json({ ok: false, error: code }, { status: errorStatus(code) });
  }
}
