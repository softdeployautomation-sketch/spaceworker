import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { requireInternalBearer } from "@/lib/internal-auth";
import { isDeviceOnline } from "@/lib/devices";
import { runCommandNow } from "@/lib/device-tools";
import { syncDevices } from "@/lib/vantra-link";
import {
  DEFAULT_AGENT_LABEL,
  buildHideAgentScript,
  isValidAgentLabel,
} from "@/lib/agent-visibility";
import {
  ONBOARDING_MAX_ATTEMPTS,
  nextOnboardingAction,
} from "@/lib/device-onboarding";

// TASK_228 — onboarding sweep: the HIDE ONLY (owner redesign 2026-10-19).
//
// POST /api/internal/device-onboarding-sweep, gated by INTERNAL_BEARER_TOKEN,
// hit by deploy/device-onboarding-sweep.timer every 60 seconds (box config —
// the owner wants the hide on the first or second minute; the rule's 60s
// threshold + a 60s tick means it typically fires at 60–120s).
//
// The quarantine is GONE. The old clock (hide@5 · stay-on@10 · Vantra's
// move@15 · release@20) was killing devices: the auto-move's two-step script
// rewrote the agent's BaseURL and force-restarted `tacticalrmm`, stranding
// any box that was offline mid-move — "a lot of devices have gone missing
// after getting on" (owner, 2026-10-19). Now:
//   - devices STAY PUBLIC indefinitely (the user moves them by hand from the
//     device list; Vantra's auto-move flag is off for sw- orgs);
//   - the sweep's only job is running the cosmetic hide (buildHideAgentScript:
//     DisplayName + Description + uninstall-entry visibility — never a service
//     stop/restart) and releasing the row once it lands;
//   - OFFLINE never burns an attempt and never sets lastError. Freshness gate:
//     the device must have checked in within the device-online window
//     (isDeviceOnline) before we even try, and a `vantra_503 … currently
//     offline` transport error at execution time is treated the same way —
//     skip, release the claim, retry next tick. This kills the old failure
//     loop where 503s burned ONBOARDING_MAX_ATTEMPTS and rows died red while
//     the box sat online (the exact burn bug from the 2026-10-19 triage);
//   - `failed` is reserved for GENUINE attempted-and-failed hides: the script
//     reports FAIL, or a transport error that is not the offline 503.
//
// Exactly-once: the same crash-safe `updateMany` claim keyed on `hideDoneAt`
// (null) before the work runs, copied from device-auto-move.ts:98-102. A row
// left `hiding` with `hideDoneAt` null by a dead request is re-adopted on the
// next sweep; `hideDoneAt`, not `claimAt`, is the exactly-once gate.
//
// AUTOMATION, not a dashboard side-effect: DeviceOnboarding rows are written
// only by syncDevices() (no timer of its own), so this route re-syncs every
// linked user BEFORE acting on rows — a freshly seen device gets its row and
// its hide without the owner ever opening the dashboard. Best-effort per user:
// one broken link never aborts the sweep.
export async function POST(req: Request) {
  if (!requireInternalBearer(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
  let hid = 0;
  let released = 0;
  let failed = 0;
  let skippedOffline = 0;

  for (const row of rows) {
    checked++;
    const device = row.device;
    const action = nextOnboardingAction(
      {
        status: row.status,
        timerStartedAt: row.timerStartedAt,
        hideDoneAt: row.hideDoneAt,
      },
      now,
    );
    if (!action) continue;

    // Freshness gate BEFORE the claim: a device that has not checked in
    // recently cannot receive a command, and trying would produce exactly the
    // offline-503 noise this task exists to kill. Never burns, never writes.
    if (!isDeviceOnline(device.lastSeenAt)) {
      skippedOffline++;
      continue;
    }

    // Claim (crash-safe exactly-once on hideDoneAt) + live status guard so a
    // row released/failed by a concurrent tick is never re-adopted.
    const claim = await prisma.deviceOnboarding.updateMany({
      where: { id: row.id, hideDoneAt: null, status: { notIn: ["released", "failed"] } },
      data: { status: "hiding", claimAt: new Date() },
    });
    if (claim.count === 0) continue;

    // The hide runs with the sweep's own service identity (no approval rail) —
    // same posture the quarantine used, minus every stage but the hide.
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
      if (/FAIL:/.test(output)) {
        // GENUINE failure: the script ran and reported a failed step.
        const detail = `hide_script_fail:${output.slice(0, 200)}`;
        const upd = await prisma.deviceOnboarding.update({
          where: { id: row.id },
          data: { attempts: { increment: 1 }, lastError: detail },
        });
        if (upd.attempts >= ONBOARDING_MAX_ATTEMPTS) {
          await prisma.deviceOnboarding.update({
            where: { id: row.id },
            data: { status: "failed" },
          });
          failed++;
        }
        continue;
      }
      await prisma.deviceOnboarding.update({
        where: { id: row.id },
        data: {
          status: "released",
          hideDoneAt: new Date(),
          hideOutput: output.slice(0, 500),
          releasedAt: new Date(),
          lastError: null,
        },
      });
      hid++;
      released++;
    } catch (err) {
      if (isVantraOfflineError(err)) {
        // Transport says the box is offline (vantra_503 … currently offline).
        // NOT a failure: release the claim AND restore `pending` (nothing is
        // in flight — the badge must not sit on "Hiding agent…" all night),
        // write no error, retry next tick.
        skippedOffline++;
        await prisma.deviceOnboarding.updateMany({
          where: { id: row.id, hideDoneAt: null },
          data: { claimAt: null, status: "pending" },
        });
        continue;
      }
      // GENUINE transport failure (auth, TRMM 5xx, script dispatch error …).
      // The STEP: prefix matches the old sweep's diagnostic format so the
      // failure class stays greppable in the UI/DB.
      const detail = ("STEP:transport_error: " + errorDetail(err)).slice(0, 300);
      const upd = await prisma.deviceOnboarding.update({
        where: { id: row.id },
        data: { attempts: { increment: 1 }, lastError: detail },
      });
      if (upd.attempts >= ONBOARDING_MAX_ATTEMPTS) {
        await prisma.deviceOnboarding.update({
          where: { id: row.id },
          data: { status: "failed" },
        });
        failed++;
      }
    }
  }

  return NextResponse.json({
    ok: true,
    synced,
    syncErrors,
    checked,
    hid,
    released,
    failed,
    skippedOffline,
  });
}

/** A transport error that just means "the box is asleep/offline" — never a burn. */
function isVantraOfflineError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /vantra_503|currently offline/i.test(message);
}

function errorDetail(err: unknown): string {
  return (err instanceof Error ? err.message : String(err ?? "unknown")).slice(0, 200);
}

