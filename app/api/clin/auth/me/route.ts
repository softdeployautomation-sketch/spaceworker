import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session-user";
import { db } from "@/lib/db";
import { createHash } from "node:crypto";

function decryptToken(token: string): string {
  const key = process.env.CLINE_TOKEN_ENCRYPTION_KEY ?? "spaceworker-default-key-change-me";
  const enc = Buffer.from(token, "base64").toString("binary");
  let result = "";
  for (let i = 0; i < enc.length; i++) {
    result += String.fromCharCode(enc.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return result;
}

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

  const connected = !!settings?.clineOAuthTokenEnc;

  let email: string | null = null;
  let accountId: string | null = null;
  if (connected && settings?.clineOAuthTokenEnc) {
    try {
      const decrypted = decryptToken(settings.clineOAuthTokenEnc);
      const parsed = JSON.parse(decrypted);
      email = parsed.email ?? null;
      accountId = parsed.accountId ?? parsed.subject ?? null;
    } catch {
      // token may not be JSON; leave email/accountId null
    }
  }

  return NextResponse.json({
    connected,
    email,
    accountId,
    modelId: settings?.clineModelId ?? null,
    apiEndpoint: settings?.clineApiEndpoint ?? null,
    updatedAt: settings?.updatedAt ?? null,
  });
}