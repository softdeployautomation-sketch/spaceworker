import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { requireInternalBearer } from "@/lib/internal-auth";
import { runAdminNotifyPass } from "@/lib/admin-notify";
import {
  runTriggerPass,
  buildScreenDigest,
  screenDigestDue,
} from "@/lib/screen-notifications";

// TASK_152 M5 — the screen-monitoring notification sweep.
// POST /api/internal/screen-notify-sweep, gated by INTERNAL_BEARER_TOKEN, hit by
// the external scheduler (deploy/screen-notify-sweep.timer, mirroring
// digest-sweep). It does TWO independent things, in order:
//
//   1. TRIGGER PASS — evaluate every frame whose summary has not yet been checked
//      against its owner's keyword triggers (the DeviceScreenshot.triggerEvaluatedAt
//      work marker keeps this a one-shot queue). Firings go through notifyUser and
//      are rate-limited by the per-(trigger,device) cooldown.
//   2. ADMIN PASS (TASK_190) — for every device with adminNotifyEnabled, notify
//      the ADMIN's own channels about its newest summarized frame (120-min
//      cooldown on Device.adminNotifyLastSentAt). Runs in ITS OWN try/catch so
//      a dead Telegram token or a bad row can never fail the sweep (the
//      per-channel sends are contained inside the lib as well).
//   3. DIGEST PASS — for every user with the digest switched on and actually due,
//      build one message covering ALL their monitored devices for the last cadence
//      window. The (userId, windowStart) rollup unique key makes a re-fire a no-op.
//
// Both features default OFF, so a fresh sweep over an untouched install does
// nothing at all. Every failure is contained per user/frame so one bad account
// cannot stop the sweep — same discipline as digest-sweep.

export async function POST(req: Request) {
  if (!requireInternalBearer(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // --- 1. Triggers -------------------------------------------------------
  let triggerPass: Awaited<ReturnType<typeof runTriggerPass>> | { error: string };
  try {
    triggerPass = await runTriggerPass();
  } catch (err) {
    console.error("[screen-notify-sweep] trigger pass failed:", err);
    triggerPass = { error: err instanceof Error ? err.message : String(err) };
  }

  // --- 2. Admin alerts (TASK_190) ------------------------------------------
  // Its OWN try/catch, like the trigger pass above: a failure here is reported
  // in the response but must never take the sweep down with it (PROMPT_VERIFY
  // §3.6 — the notification failing is visible; the sweep still succeeds).
  let adminPass: Awaited<ReturnType<typeof runAdminNotifyPass>> | { error: string };
  try {
    adminPass = await runAdminNotifyPass();
  } catch (err) {
    console.error("[screen-notify-sweep] admin pass failed:", err);
    adminPass = { error: err instanceof Error ? err.message : String(err) };
  }

  // --- 3. Digests --------------------------------------------------------
  const candidates = await prisma.user.findMany({
    where: { screenDigestEnabled: true },
    select: { id: true },
  });

  const digestResults: Record<string, string> = {};
  let digestsGenerated = 0;
  let digestsSkipped = 0;

  for (const { id } of candidates) {
    try {
      if (!(await screenDigestDue(id))) {
        digestsSkipped += 1;
        digestResults[id] = "not_due";
        continue;
      }
      const res = await buildScreenDigest(id);
      digestResults[id] = res.status + (res.reason ? `:${res.reason}` : "");
      if (res.status === "generated") digestsGenerated += 1;
      else digestsSkipped += 1;
    } catch (err) {
      console.error(`[screen-notify-sweep] digest failed for user ${id}:`, err);
      digestResults[id] = "failed";
    }
  }

  console.log(
    `[screen-notify-sweep] triggers scanned ${"scanned" in triggerPass ? triggerPass.scanned : "n/a"}, ` +
      `fired ${"fired" in triggerPass ? triggerPass.fired : 0}; ` +
      `admin notified ${"notified" in adminPass ? adminPass.notified : "n/a"}, ` +
      `digests generated ${digestsGenerated}, skipped ${digestsSkipped} of ${candidates.length} eligible`,
  );

  return NextResponse.json({
    triggers: triggerPass,
    adminAlerts: adminPass,
    digests: {
      generated: digestsGenerated,
      skipped: digestsSkipped,
      eligible: candidates.length,
      results: digestResults,
    },
  });
}
