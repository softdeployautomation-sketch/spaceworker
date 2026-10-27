import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session-user";
import { db } from "@/lib/db";
import { completeClineDeviceAuth } from "@cline/sdk";
import { createHash } from "node:crypto";

export const dynamic = "force-dynamic";

const CLINE_API_BASE_URL = process.env.CLINE_API_BASE_URL ?? "https://api.cline.com";

function encryptToken(token: string): string {
  // Simple XOR-based obfuscation for at-rest storage.
  // In production, use a proper encryption library with a key from env.
  const key = process.env.CLINE_TOKEN_ENCRYPTION_KEY ?? "spaceworker-default-key-change-me";
  let result = "";
  for (let i = 0; i < token.length; i++) {
    result += String.fromCharCode(token.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return Buffer.from(result).toString("base64");
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { deviceCode?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { deviceCode } = body;
  if (!deviceCode) {
    return NextResponse.json({ error: "deviceCode required" }, { status: 400 });
  }

  // Idempotent: if tokens already stored for this user, auth is already complete
  const existing = await db.cyberLabAgentSettings.findUnique({
    where: { userId: user.id },
    select: { clineOAuthTokenEnc: true },
  });
  if (existing?.clineOAuthTokenEnc) {
    await db.clineDeviceAuth.delete({ where: { deviceCode } }).catch(() => {});
    return NextResponse.json({ ok: true, message: "Cline account already connected" });
  }

  // Look up the device code mapping to confirm this user initiated the flow
  const deviceAuth = await db.clineDeviceAuth.findUnique({
    where: { deviceCode },
  });
  if (!deviceAuth || deviceAuth.userId !== user.id) {
    return NextResponse.json({ error: "Device code not found or not yours" }, { status: 404 });
  }
  if (deviceAuth.expiresAt < new Date()) {
    await db.clineDeviceAuth.delete({ where: { deviceCode } });
    return NextResponse.json({ error: "Device code expired" }, { status: 410 });
  }

  try {
    // Poll for completion (bounded — will resolve when user completes auth or timeout)
    const credentials = await completeClineDeviceAuth({
      deviceCode,
      expiresInSeconds: 15, // short poll window; frontend retries
      pollIntervalSeconds: 5,
      apiBaseUrl: CLINE_API_BASE_URL,
    });

    // Store encrypted tokens
    await db.cyberLabAgentSettings.upsert({
      where: { userId: user.id },
      update: {
        clineOAuthTokenEnc: encryptToken(credentials.access),
        clineRefreshTokenEnc: encryptToken(credentials.refresh),
        updatedAt: new Date(),
      },
      create: {
        userId: user.id,
        clineOAuthTokenEnc: encryptToken(credentials.access),
        clineRefreshTokenEnc: encryptToken(credentials.refresh),
      },
    });

    // Clean up device code
    await db.clineDeviceAuth.delete({ where: { deviceCode } });

    return NextResponse.json({
      ok: true,
      email: credentials.email,
      accountId: credentials.accountId,
      message: "Cline account connected successfully",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to complete Cline device auth";
    if (/timeout|timed out|pending|not yet/i.test(msg)) {
      return NextResponse.json({ error: "Still pending - complete verification on Cline", pending: true }, { status: 202 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}