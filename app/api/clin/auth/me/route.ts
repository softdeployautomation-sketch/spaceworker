import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session-user";
import { db } from "@/lib/db";
import { readClineCredentials } from "@/lib/clin/token-store";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await db.cyberLabAgentSettings.findUnique({
    where: { userId: user.id },
    select: {
      clineModelId: true,
      clineApiEndpoint: true,
      updatedAt: true,
    },
  });

  const stored = await readClineCredentials(user.id);

  return NextResponse.json({
    connected: stored.ok,
    email: stored.ok ? stored.credentials.email ?? null : null,
    accountId: stored.ok ? stored.credentials.accountId ?? null : null,
    expires: stored.ok ? stored.credentials.expires ?? null : null,
    needsReconnect: !stored.ok && stored.reason === "unreadable",
    message:
      !stored.ok && stored.reason === "unreadable"
        ? "Stored Cline login can no longer be read on this server. Log in again."
        : null,
    modelId: settings?.clineModelId ?? null,
    apiEndpoint: settings?.clineApiEndpoint ?? null,
    updatedAt: settings?.updatedAt ?? null,
  });
}
