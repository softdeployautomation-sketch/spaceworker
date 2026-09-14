import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { requireAdminSession } from "@/lib/admin-auth";
import {
  ChannelryAiError,
  channelryAiChat,
  channelryAiConfigured,
} from "@/lib/channelry-ai";
import { startOfTodayUTC } from "@/lib/agent";

// /api/admin/ai-usage — Task 40 admin visibility + real-time per-user AI cap
// adjustment.
//   GET   → every user (email, today's summed usage from AiUsageLog, their cap)
//           plus a total-used-today rollup and the CURRENT pooled usage/cap from
//           Channelry itself (a single cheap plain-completion ping, same cost
//           class as the admin Test-connection button — admin-only + rare).
//   PATCH { userId, aiDailyCapHundredthsCent } → updates one user's cap
//           immediately (a plain DB write; the very next agent turn reads it
//           live, so no deploy/restart). Clamped into [0, 500000] — can't exceed
//           the whole pooled client cap.
//
// Units are hundredths of a cent throughout, matching Channelry's own usage
// block (cost_hundredths_cent). Never divide by 100 here.
const POOL_CAP_HUNDREDTHS_CENT = 500000; // Channelry's $50/day pooled client cap

export async function GET() {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const start = startOfTodayUTC();

  const [users, rows] = await Promise.all([
    prisma.user.findMany({
      select: { id: true, email: true, aiDailyCapHundredthsCent: true },
      orderBy: { email: "asc" },
    }),
    prisma.aiUsageLog.groupBy({
      by: ["userId"],
      where: { createdAt: { gte: start } },
      _sum: { costHundredthsCent: true },
    }),
  ]);

  const usedByUser = new Map<string, number>(
    rows.map((r) => [r.userId, r._sum.costHundredthsCent ?? 0])
  );
  const usersWithUsage = users.map((u) => ({
    userId: u.id,
    email: u.email,
    usedTodayHundredthsCent: usedByUser.get(u.id) ?? 0,
    aiDailyCapHundredthsCent: u.aiDailyCapHundredthsCent,
  }));
  const totalUsedTodayHundredthsCent = usersWithUsage.reduce(
    (sum, u) => sum + u.usedTodayHundredthsCent,
    0
  );

  // Pooled ground truth from Channelry — the only place the whole-pool spend is
  // authoritative. Surfaced once per page load, not per-row. Non-fatal on
  // failure: the per-user breakdown is still useful without the pooled numbers.
  let pooled: {
    usedTodayHundredthsCent: number | null;
    capHundredthsCent: number | null;
    error?: string;
  } | null = null;
  if (channelryAiConfigured()) {
    try {
      const res = await channelryAiChat({
        system: "Reply with exactly one word.",
        user: "ping",
        max_tokens: 8,
        temperature: 0,
        external_user_id: "__admin_usage_dashboard__",
      });
      pooled = {
        usedTodayHundredthsCent: res.usage.used_today_hundredths_cent ?? null,
        capHundredthsCent: res.usage.cap_hundredths_cent ?? null,
      };
    } catch (err) {
      pooled = {
        usedTodayHundredthsCent: null,
        capHundredthsCent: null,
        error:
          err instanceof ChannelryAiError ? err.message : "unavailable",
      };
    }
  }

  return NextResponse.json({
    users: usersWithUsage,
    totalUsedTodayHundredthsCent,
    pooled,
    poolCapHundredthsCent: POOL_CAP_HUNDREDTHS_CENT,
  });
}

export async function PATCH(req: Request) {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { userId?: unknown; aiDailyCapHundredthsCent?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { userId, aiDailyCapHundredthsCent } = body;
  if (typeof userId !== "string" || userId.trim().length === 0) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }

  const cap = Number(aiDailyCapHundredthsCent);
  // Reject NaN / negative with a 400 (per the task); clamp only the upper bound
  // so an individual user can never be granted more than the whole pooled cap.
  if (!Number.isFinite(cap) || cap < 0) {
    return NextResponse.json(
      { error: "aiDailyCapHundredthsCent must be a non-negative number" },
      { status: 400 }
    );
  }
  const clamped = Math.min(POOL_CAP_HUNDREDTHS_CENT, Math.floor(cap));

  const user = await prisma.user
    .update({
      where: { id: userId },
      data: { aiDailyCapHundredthsCent: clamped },
      select: { id: true, email: true, aiDailyCapHundredthsCent: true },
    })
    .catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  return NextResponse.json({
    userId: user.id,
    email: user.email,
    aiDailyCapHundredthsCent: user.aiDailyCapHundredthsCent,
  });
}