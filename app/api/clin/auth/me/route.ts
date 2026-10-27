import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session-user";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await db.cyberLabAgentSettings.findUnique({
    where: { userId: user.id },
    select: {
      clineOAuthTokenEnc: true,
      clineRefreshTokenEnc: true,
      clineModelId: true,
      clineApiEndpoint: true,
      updatedAt: true,
    },
  });

  const today = new Date().toISOString().slice(0, 10);
  const usage = await db.clineFreeUsage.findUnique({
    where: { userId_date: { userId: user.id, date: today } },
  });

  const connected = !!settings?.clineOAuthTokenEnc;
  const dailyCount = usage?.count ?? 0;
  const dailyLimit = 2;

  return NextResponse.json({
    connected,
    email: undefined, // not stored in plaintext; can be decrypted if needed
    modelId: settings?.clineModelId ?? null,
    apiEndpoint: settings?.clineApiEndpoint ?? null,
    updatedAt: settings?.updatedAt ?? null,
    dailyCount,
    dailyLimit,
    dailyRemaining: Math.max(0, dailyLimit - dailyCount),
  });
}