// PLAN_TASK_165 P3 — GET /api/overview-stats
//
// ONE read for the whole status row under the welcome panel. The owner asked for
// "wallet balance, AI balance and used, and other dashboard in one line under the
// hero", and the naive way to build that is five client components each fetching
// their own endpoint. That is five round trips, five loading states that resolve
// in a different order (so the row visibly reflows), and five chances to disagree
// about the same user. One route, one read, one row.
//
// SCOPED TO THE SESSION, EXACTLY LIKE app/api/wallet/route.ts. There is no
// userId parameter, query string or body, deliberately: a read that can be
// pointed at somebody else's numbers is an account-takeover with an API. The id
// comes from the cookie and nowhere else.
//
// MONEY AND AI SPEND STAY INTEGER. Wallet figures are CENTS (the unit lib/wallet
// uses end to end); AI figures are HUNDREDTHS OF A CENT, because that is the unit
// AiUsageLog.costHundredthsCent and User.aiDailyCapHundredthsCent are stored in
// and the unit getUsedAiTodayHundredthsCent returns. Neither is divided here —
// formatting is a display concern and happens in the browser. Converting either
// to a float on the server is how "used 0.1 + 0.2" turns into a wrong invoice.
//
// AI USAGE COMES FROM lib/ai-metering, NOT /api/admin/ai-usage. The admin route
// rolls up EVERY user and is admin-gated; this one is a user's own row. The sum
// and the "today" boundary are reused from the single shared implementation rather
// than re-derived, so this number is by construction the same number the agent's
// cap check is enforcing — a second copy of that SUM is exactly the kind of drift
// TASK_127 was about.
//
// COUNTS ARE COUNT(*), NOT TABLE LENGTHS. Every query is filtered by userId, so a
// user only ever sees their own rows; the aggregate is served by the index on
// userId and the four run in one Promise.all rather than four round trips.
//
// NO NEW TABLES AND NO MIGRATION. Every figure here is already stored.
import { NextResponse } from "next/server";

import { getUsedAiTodayHundredthsCent } from "@/lib/ai-metering";
import { db } from "@/lib/db";
// TASK_185 P2 — "online" is the SAME 10-minute window the device list and the
// status derivation use (`isDeviceOnline`), never the raw `status` column,
// which is set at heartbeat time and never ages on its own.
import { DEVICE_ONLINE_WINDOW_MS } from "@/lib/devices";
import { allowAndRecord, getClientIp } from "@/lib/rate-limit";
import { getCurrentUser } from "@/lib/session-user";

export const dynamic = "force-dynamic";

export async function GET() {
  const ip = await getClientIp();
  if (!(await allowAndRecord(ip, "overview-stats"))) {
    return NextResponse.json(
      { error: "Too many requests. Please try again shortly." },
      { status: 429 },
    );
  }

  // Same reasoning as /api/wallet: the cookie can outlive its user row (deleted
  // account, restored backup), and a deleted user must be a 401, never a row of
  // zeroes that reads as "you own nothing".
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [
    wallet,
    aiUsedTodayHundredthsCent,
    devicesTotal,
    devicesOnline,
    leads,
    campaigns,
    mailboxes,
  ] = await Promise.all([
    db.user.findUnique({
      where: { id: user.id },
      select: { balanceCents: true, postpaidLimitCents: true },
    }),
    getUsedAiTodayHundredthsCent(user.id),
    // TASK_185 P2 — EXACTLY the read `GET /api/devices` serves (same three
    // filters): no soft-removed ghosts (the Delete button sets `removedAt`),
    // no "hosted" clone-destination rows, and — for online — the live
    // last-seen WINDOW rather than the stale `status` column. The live defect
    // this fixes: owner saw "4 online of 9" against a list of 2 (psql: 6 rows
    // removed + 1 hosted still counted, 4 `status='online'` but 0 in-window).
    db.device.count({
      where: { userId: user.id, deviceKind: { not: "hosted" }, removedAt: null },
    }),
    db.device.count({
      where: {
        userId: user.id,
        deviceKind: { not: "hosted" },
        removedAt: null,
        lastSeenAt: { gte: new Date(Date.now() - DEVICE_ONLINE_WINDOW_MS) },
      },
    }),
    db.lead.count({ where: { userId: user.id } }),
    db.emailCampaign.count({ where: { userId: user.id } }),
    db.mailbox.count({ where: { userId: user.id } }),
  ]);

  return NextResponse.json({
    wallet: {
      balanceCents: wallet?.balanceCents ?? 0,
      postpaidLimitCents: wallet?.postpaidLimitCents ?? 0,
      // Same arithmetic getWallet() uses for its spendable figure, so the row
      // cannot disagree with the billing page.
      spendableCents: (wallet?.balanceCents ?? 0) + (wallet?.postpaidLimitCents ?? 0),
      prepaidOnly: (wallet?.postpaidLimitCents ?? 0) === 0,
    },
    ai: {
      usedTodayHundredthsCent: aiUsedTodayHundredthsCent,
      dailyCapHundredthsCent: user.aiDailyCapHundredthsCent,
    },
    counts: { devicesTotal, devicesOnline, leads, campaigns, mailboxes },
  });
}