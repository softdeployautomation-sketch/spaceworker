import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session-user";
import { pollClineDeviceAuth } from "@/lib/clin/device-auth";
import { clinePollResponse } from "@/lib/clin/auth-response";

export const dynamic = "force-dynamic";

/**
 * TASK_246 — kept as an alias of `/api/clin/auth/poll` for clients built before
 * the auto-poll existed. Both go through the same server-side poller, so a
 * "Confirm" click and the background timer can never disagree or double-spend
 * the one-time device code.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { deviceCode?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    // Empty body: poll the user's newest pending code.
  }

  const deviceCode =
    typeof body.deviceCode === "string" && body.deviceCode.length > 0 ? body.deviceCode : undefined;

  const result = await pollClineDeviceAuth({
    userId: user.id,
    deviceCode,
    windowSeconds: 15,
    pollIntervalSeconds: 5,
  });
  return clinePollResponse(result);
}
