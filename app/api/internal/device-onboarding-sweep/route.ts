import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { requireInternalBearer } from "@/lib/internal-auth";
import { isDeviceOnline } from "@/lib/devices";
import { runCommandNow, setPowerPolicy } from "@/lib/device-tools";
import { syncDevices } from "@/lib/vantra-link";
import {
  DEFAULT_AGENT_LABEL,
  buildHideAgentScript,
  isValidAgentLabel,
} from "@/lib/agent-visibility";
import {
  ONBOARDING_MAX_ATTEMPTS,
  ONBOARDING_MOVE_MINUTES,
  nextOnboardingAction,
} from "@/lib/device-onboarding";

// TASK_128 — device onboarding quarantine sweep.
//
// POST /api/internal/device-onboarding-sweep, gated by INTERNAL_BEARER_TOKEN,
// hit by deploy/device-onboarding-sweep.timer every 5 minutes (the stage
// thresholds are 5-minute-quantised by design, mirroring Vantra's own poller).
//
// One shared clock per device: hide@5 · stay-on@10 · move@15 (Vantra's) ·
// released by 20. The MOVE itself is Vantra's (lib/device-auto-move.ts) and is
// never fired from here; this sweep only runs the two EXISTING SpaceWorker
// tools (runCommandNow + buildHideAgentScript / setPowerPolicy) and mirrors the
// release once the device is observed private.
//
// GRACE, not a deadline (owner rule: "it's not necessarily for it to be exactly
// 20 mins — if anyone exceeds, we just want to put a little wait in each
// process"). The 20-minute window is the PLAN:
//   - a device still public at 20 is NOT released and NOT failed; its row stays
//     live and keeps being retried (the UI words this `overrun`);
//   - there is NO time ceiling. The clock can no longer fail a device, because
//     elapsed time includes the hours a box spent switched OFF, which is not a
//     failure of the process (owner decision 2026-09-27). A device previously
//     offline for 35+ minutes used to be marked `failed` the moment it came back
//     — a false alarm on a healthy device, and the opposite of "any failed
//     attempt due to offline should retry";
//   - past ONBOARDING_STUCK_MINUTES the UI instead escalates to a LOUD amber
//     warning that names the device, the elapsed time and the reason, so a stuck
//     device is visible WITHOUT being marked failed. `failed` is reserved for
//     ONBOARDING_MAX_ATTEMPTS genuinely attempted-and-failed stages, which keeps
//     a red badge meaning something;
//   - a free/trial device with no destination is released cleanly at the plan
//     and is never treated as a failure — nothing is hidden for a move that
//     can never happen.
//
// OFFLINE retries, and never burns an attempt: a due stage whose box is not
// reachable is skipped and retried on every later cycle. Only an ATTEMPTED
// stage that actually failed counts toward ONBOARDING_MAX_ATTEMPTS.
//
// Exactly-once: a crash-safe `updateMany` claim keyed on the stage's own
// `*DoneAt` (null) before the work runs, copied from device-auto-move.ts:98-102.
// A row left in hiding/staying_on with its `*DoneAt` null by a dead request is
// re-adopted unconditionally on the next sweep — there is NO staleness timer;
// the `*DoneAt` timestamp, not `claimAt`, is the exactly-once gate. The session
// routes are deliberately not called: runCommandNow/setPowerPolicy take a
// `userId` precisely so this works without an approval rail.
export async function POST(req: Request) {
  if (!requireInternalBearer(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // TASK_129 — see device-status-sweep/route.ts: a self-hosted deployment with
  // no configured internal device-check-in service must no-op cleanly (200) on
  // each timer fire, not error. Inert on a hosted deploy (both vars always set).
  if (!process.env.VANTRA_INTERNAL_URL || !process.env.VANTRA_INTERNAL_TOKEN) {
    return NextResponse.json({ ok: true, skipped: "device management not configured" });
  }

  // AUTOMATION, not a dashboard side-effect (owner rule: "we want all
  // automated"). `DeviceOnboarding` rows are written ONLY by `syncDevices()`,
  // which has no timer of its own (lib/clone.ts:506 says exactly that) — it runs
  // when a human opens the device list. Without this step the hide@5/stay-on@10
  // stages would only ever run for users who happened to visit their dashboard,
  // so a freshly installed public device could be moved by Vantra at 15 minutes
  // having never been hidden or kept awake: the exact failure this task exists
  // to prevent. Re-sync every linked user first, then act on the rows.
  //
  // Best-effort per user: one broken/revoked link must never abort the sweep or
  // stop the other users' devices being quarantined (each failure is recorded in
  // `syncErrors`, never thrown). Revoked links are skipped — they have no org.
  const links = await prisma.vantraLink.findMany({
    where: { status: { not: "revoked" } },
    select: { userId: true },
  });
  let synced = 0;
  const syncErrors: string[] = [];
  for (const link of links) {
    try {
      await syncDevices(link.userId);
      synced++;
    } catch (err) {
      syncErrors.push(`${link.userId}:${errorDetail(err)}`);
    }
  }

  const rows = await prisma.deviceOnboarding.findMany({
    where: { status: { notIn: ["released", "failed"] } },
    include: {
      device: { select: { id: true, userId: true, name: true, tier: true, lastSeenAt: true } },
    },
  });

  const now = Date.now();
  let checked = 0;
  let acted = 0;

  for (const row of rows) {
    checked++;
    const device = row.device;
    const action = nextOnboardingAction(
      {
        status: row.status,
        tier: device.tier,
        timerStartedAt: row.timerStartedAt,
        hideDoneAt: row.hideDoneAt,
        stayOnDoneAt: row.stayOnDoneAt,
        destinationOrgId: row.destinationOrgId,
      },
      now,
    );
    if (action === "terminal") continue;

    try {
      if (action === "hide" || action === "stay_on") {
        // §6 — the box being asleep is NEVER an error and must not burn an
        // attempt: skip and retry next cycle (the strip names it "waiting").
        if (!isDeviceOnline(device.lastSeenAt)) continue;
      }

      if (action === "hide") {
        const claimed = await prisma.deviceOnboarding.updateMany({
          where: { id: row.id, hideDoneAt: null },
          data: { status: "hiding", claimAt: new Date(), attempts: { increment: 1 } },
        });
        if (claimed.count !== 1) continue; // already done by another sweep
        const label = isValidAgentLabel(row.hideLabel) ? row.hideLabel : DEFAULT_AGENT_LABEL;
        try {
          const result = await runCommandNow({
            userId: device.userId,
            deviceId: device.id,
            cmd: buildHideAgentScript(label),
            shell: "powershell",
            timeoutSeconds: 90,
            runAsUser: false,
          });
          const output = result.output ?? "";
          if (output.includes("FAIL:")) {
            acted++;
            await failStage(row, output.slice(0, 500));
          } else {
            await prisma.deviceOnboarding.update({
              where: { id: row.id },
              data: {
                hideDoneAt: new Date(),
                hideOutput: output.slice(0, 2000),
                status: "pending",
                claimAt: null,
                lastError: null,
              },
            });
            acted++;
          }
        } catch (err) {
          acted++;
          await failStage(row, errorDetail(err));
        }
      } else if (action === "stay_on") {
        const claimed = await prisma.deviceOnboarding.updateMany({
          where: { id: row.id, stayOnDoneAt: null },
          data: { status: "staying_on", claimAt: new Date(), attempts: { increment: 1 } },
        });
        if (claimed.count !== 1) continue;
        try {
          await setPowerPolicy({ userId: device.userId, deviceId: device.id, mode: "indefinite" });
          await prisma.deviceOnboarding.update({
            where: { id: row.id },
            data: { stayOnDoneAt: new Date(), status: "pending", claimAt: null, lastError: null },
          });
          acted++;
        } catch (err) {
          acted++;
          await failStage(row, errorDetail(err));
        }
      } else if (action === "release") {
        await prisma.deviceOnboarding.update({
          where: { id: row.id },
          data: {
            releasedAt: new Date(),
            status: "released",
            claimAt: null,
            ...(device.tier === "private" ? { movedAt: new Date() } : {}),
          },
        });
        acted++;
      } else if (
        action === "wait" &&
        now - row.timerStartedAt.getTime() >= ONBOARDING_MOVE_MINUTES * 60_000
      ) {
        // 15–20 min: the move is in flight on Vantra's own clock. Non-terminal —
        // recorded once purely so the row shows "move in flight".
        const moved = await prisma.deviceOnboarding.updateMany({
          where: { id: row.id, status: "pending" },
          data: { status: "moving" },
        });
        if (moved.count === 1) acted++;
      }
    } catch (err) {
      console.error(`[device-onboarding-sweep] device ${device.id} failed:`, err);
    }
  }

  console.log(`[device-onboarding-sweep] checked ${checked}, acted ${acted}`);
  // `synced`/`syncErrors` are reported so the timer's journal says out loud
  // whether the automation half ran — a sweep that silently synced nobody is
  // how this gap hid in the first place.
  return NextResponse.json({ ok: true, synced, syncErrors, checked, acted });
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? "stage_failed");
}

/**
 * A stage attempt failed: retry next cycle, or go terminal once
 * ONBOARDING_MAX_ATTEMPTS is reached (mirrors recordAutoMoveAttempt). A
 * failed hide/stay-on never blocks the move — that is Vantra's and fires on
 * its own clock regardless.
 */
async function failStage(
  row: { id: string; attempts: number },
  detail: string,
): Promise<void> {
  const attempts = row.attempts + 1;
  const terminal = attempts >= ONBOARDING_MAX_ATTEMPTS;
  await prisma.deviceOnboarding.update({
    where: { id: row.id },
    data: {
      status: terminal ? "failed" : "pending",
      claimAt: null,
      lastError: detail.slice(0, 500),
    },
  });
  if (terminal) {
    console.error(`[device-onboarding-sweep] ${row.id} failed after ${attempts} attempts: ${detail}`);
  }
}
