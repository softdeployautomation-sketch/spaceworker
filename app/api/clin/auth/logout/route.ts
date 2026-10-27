import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session-user";
import { db } from "@/lib/db";
import { clearClineCredentials } from "@/lib/clin/token-store";

export const dynamic = "force-dynamic";

export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // updateMany: logging out before ever connecting used to throw P2025 → HTML 500.
  await clearClineCredentials(user.id);
  await db.clineDeviceAuth.deleteMany({ where: { userId: user.id } });

  return NextResponse.json({ ok: true, message: "Cline account disconnected" });
}
