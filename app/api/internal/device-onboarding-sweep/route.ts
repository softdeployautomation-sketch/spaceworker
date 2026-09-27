import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { requireInternalBearer } from "@/lib/internal-auth";
import { isDeviceOnline } from "@/lib/devices";
import { runCommandNow, setPowerPolicy } from "@/lib/device-tools";
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
//   - only the ceiling (20 + 3 grace periods) turns that into `failed`, which
//     is surfaced loudly — never silently (the row keeps a red badge and the
//     Devices page keeps an alert naming it, with the device left Public and
//     fully usable);
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
      } else if (action === "fail") {
        // Past the plan AND its grace, and still public. The ONLY way a device
        // goes terminal without having moved — and it is never silent: the row
        // keeps a red `Setup failed` badge and the Devices page keeps an alert
        // naming it, with the device left exactly where the owner can still
        // use it (`Public`, fully accessible). We do NOT set releasedAt: the
        // window genuinely never released.
        await prisma.deviceOnboarding.update({
          where: { id: row.id },
          data: {
            status: "failed",
            claimAt: null,
            lastError:
              row.lastError ??
              "move_not_landed_after_grace — still on your public agent, still fully usable",
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
  return NextResponse.json({ ok: true, checked, acted });
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
