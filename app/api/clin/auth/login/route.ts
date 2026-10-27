import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session-user";
import { db } from "@/lib/db";
import { startClineDeviceAuth } from "@cline/sdk";

export const dynamic = "force-dynamic";

export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Check if user already has an active Cline OAuth connection
  const existing = await db.cyberLabAgentSettings.findUnique({
    where: { userId: user.id },
    select: { clineOAuthTokenEnc: true, clineRefreshTokenEnc: true, updatedAt: true },
  });
  if (existing?.clineOAuthTokenEnc) {
    return NextResponse.json({
      alreadyConnected: true,
      email: undefined,
      message: "Cline account already connected. Log out first to connect a different account.",
    });
  }

  try {
    const deviceAuth = await startClineDeviceAuth();

    // Store the device code temporarily so the callback can associate it with this user
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