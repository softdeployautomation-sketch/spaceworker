import "server-only";

import { db } from "./db";
import { recordAgentActionAudit } from "./devices";
import { runCloneRevoke, type CloneBrowser } from "./clone-transport";
import { getCloneSettings } from "./clone-settings";
import { CLONE_TERMINAL_STATES } from "./clone";

// TASK_112 (bit B6) — sweep halves left out of lib/clone.ts: staging
// teardown + inactive-record purge. Kept here so clone.ts stays the ONLY
// writer of CloneJob.status transitions — this module clears staging
// pointers and deletes rows via guarded updateMany/deleteMany only.
// Logging contract: counts + clone ids only. Never staging paths, cookie
// counts, session URLs, tokens, or capture contents.

export interface CloneStagingSweepResult {
  scanned: number;
  stagingDeleted: number;
  errors: number;
  clearedIds: string[];
}

export interface ClonePurgeSweepResult {
  scanned: number;
  purged: number;
  errors: number;
  purgedIds: string[];
}

const STAGING_BATCH_SIZE = 100;
const PURGE_BATCH_SIZE = 100;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isCloneBrowser(value: string): value is CloneBrowser {
  return value === "chrome" || value === "edge" || value === "firefox";
}

/** "Already gone" transport errors — material absent, clearing is correct. */
function isAlreadyGone(teardown: string): boolean {
  const t = teardown.toLowerCase();
  return (
    t.includes("not found") ||
    t.includes("no such") ||
    t.includes("missing") ||
    t.includes("already") ||
    t.includes("not_found") ||
    t.includes("device_not_linked") ||
    t.includes("404")
  );
}

/** Clear the staging pointer with an optimistic guard (idempotent). */
async function clearStagingRef(cloneJobId: string, stagingRef: string | null): Promise<void> {
  if (stagingRef === null) return;
  await db.cloneJob.updateMany({
    where: { id: cloneJobId, stagingRef },
    data: { stagingRef: null },
  });
}
export async function sweepCloneStaging(): Promise<CloneStagingSweepResult> {
  const due = await db.cloneJob.findMany({
    where: {
      status: { in: [...CLONE_TERMINAL_STATES] },
      stagingRef: { not: null },
    },
    select: {
      id: true,
      userId: true,
      sourceDeviceId: true,
      destinationDeviceId: true,
      pendingActionId: true,
      browser: true,
      cloneId: true,
      stagingRef: true,
    },
    orderBy: { createdAt: "asc" },
    take: STAGING_BATCH_SIZE,
  });
  const out: CloneStagingSweepResult = {
    scanned: due.length,
    stagingDeleted: 0,
    errors: 0,
    clearedIds: [],
  };
  for (const job of due) {
    try {
      if (!job.cloneId || !job.destinationDeviceId || !isCloneBrowser(job.browser)) {
        await clearStagingRef(job.id, job.stagingRef);
        out.stagingDeleted += 1;
        out.clearedIds.push(job.id);
        continue;
      }
      let teardown = "skipped";
      try {
        const res = await runCloneRevoke({
          userId: job.userId,
          cloneJobId: job.id,
          pendingActionId: job.pendingActionId ?? undefined,
          deviceId: job.destinationDeviceId,
          sourceDeviceId: job.sourceDeviceId,
          destinationDeviceId: job.destinationDeviceId,
          cloneId: job.cloneId,
          browser: job.browser,
        });
        teardown = res.ok
          ? "ok"
          : `error: revoke not ok (remaining=${res.browserProcessesRemaining ?? "unknown"})`;
      } catch (err) {
        teardown = `error: ${errMessage(err)}`;
      }
      if (teardown === "ok" || isAlreadyGone(teardown)) {
        await clearStagingRef(job.id, job.stagingRef);
        out.stagingDeleted += 1;
        out.clearedIds.push(job.id);
      } else {
        out.errors += 1;
        await recordAgentActionAudit({
          userId: job.userId,
          pendingActionId: job.pendingActionId ?? undefined,
          action: "browser-clone",
          status: "failed",
          sourceDeviceId: job.sourceDeviceId,
          destinationDeviceId: job.destinationDeviceId ?? undefined,
          cloneId: job.id,
          detail: { reason: "staging_teardown_retry_failed" },
        });
      }
    } catch (err) {
      out.errors += 1;
      await recordAgentActionAudit({
        userId: job.userId,
        pendingActionId: job.pendingActionId ?? undefined,
        action: "browser-clone",
        status: "failed",
        sourceDeviceId: job.sourceDeviceId,
        destinationDeviceId: job.destinationDeviceId ?? undefined,
        cloneId: job.id,
        detail: { reason: `staging_teardown_error: ${errMessage(err)}` },
      });
    }
  }
  return out;
}

export async function sweepClonePurge(): Promise<ClonePurgeSweepResult> {
  const settings = await getCloneSettings();
  void settings.purgeAfterDays;
  const now = new Date();
  const due = await db.cloneJob.findMany({
    where: {
      status: { in: [...CLONE_TERMINAL_STATES] },
      purgeAfter: { lte: now },
    },
    select: { id: true },
    orderBy: { purgeAfter: "asc" },
    take: PURGE_BATCH_SIZE,
  });
  const out: ClonePurgeSweepResult = {
    scanned: due.length,
    purged: 0,
    errors: 0,
    purgedIds: [],
  };
  for (const { id } of due) {
    try {
      await db.hostedBrowserSession.updateMany({
        where: { cloneJobId: id },
        data: { status: "stopped", stoppedAt: now, cloneJobId: null },
      });
      const deleted = await db.cloneJob.deleteMany({
        where: {
          id,
          status: { in: [...CLONE_TERMINAL_STATES] },
          purgeAfter: { lte: now },
        },
      });
      if (deleted.count > 0) {
        out.purged += 1;
        out.purgedIds.push(id);
      }
    } catch {
      out.errors += 1;
    }
  }
  return out;
}

