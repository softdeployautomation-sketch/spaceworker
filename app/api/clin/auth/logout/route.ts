import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session-user";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await db.cyberLabAgentSettings.update({
    where: { userId: user.id },
    data: {
      clineOAuthTokenEnc: null,
      clineRefreshTokenEnc: null,
      updatedAt: new Date(),
    },
  });

  return NextResponse.json({ ok: true, message: "Cline account disconnected" });
}