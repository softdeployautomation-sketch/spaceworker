import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session-user";
import { db } from "@/lib/db";
import { startClineDeviceAuth } from "@cline/sdk";
import { readClineCredentials, clearClineCredentials } from "@/lib/clin/token-store";

export const dynamic = "force-dynamic";

export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // TASK_246: a stored token we can no longer decrypt must not block re-login.
  const stored = await readClineCredentials(user.id);
  if (stored.ok) {
    return NextResponse.json({
      alreadyConnected: true,
      email: stored.credentials.email ?? undefined,
      message: "Cline account already connected. Log out first to connect a different account.",
    });
  }
  if (stored.reason === "unreadable") {
    await clearClineCredentials(user.id);
  }

  try {
    const deviceAuth = await startClineDeviceAuth();

    // One pending login per user: drop this user's previous codes (expired or
    // abandoned) before recording the new one. This is also the housekeeping
    // that keeps the table from growing forever.
    await db.clineDeviceAuth.deleteMany({ where: { userId: user.id } });
    await db.clineDeviceAuth.create({
      data: {
        deviceCode: deviceAuth.deviceCode,
        userId: user.id,
        userCode: deviceAuth.userCode,
        expiresAt: new Date(Date.now() + deviceAuth.expiresInSeconds * 1000),
      },
    });

    return NextResponse.json({
      deviceCode: deviceAuth.deviceCode,
      userCode: deviceAuth.userCode,
      verificationUri: deviceAuth.verificationUri,
      verificationUriComplete: deviceAuth.verificationUriComplete,
      expiresInSeconds: deviceAuth.expiresInSeconds,
      expiresAt: new Date(Date.now() + deviceAuth.expiresInSeconds * 1000).toISOString(),
      pollIntervalSeconds: deviceAuth.pollIntervalSeconds,
      message: `Visit ${deviceAuth.verificationUri} and enter code: ${deviceAuth.userCode}`,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to start Cline device auth" },
      { status: 500 },
    );
  }
}
