import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session-user";
import { pollClineDeviceAuth } from "@/lib/clin/device-auth";
import { clinePollResponse } from "@/lib/clin/auth-response";

export const dynamic = "force-dynamic";

/**
 * TASK_246 — the endpoint the settings card polls while the user approves the
 * code on cline.bot. This is what makes "auto connect" real: the server (not
 * the UI) exchanges the device code, so `/me` starts reporting connected.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { deviceCode?: unknown; windowSeconds?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    // Empty body is valid: fall back to the user's newest pending code.
  }

  const deviceCode =
    typeof body.deviceCode === "string" && body.deviceCode.length > 0 ? body.deviceCode : undefined;
  const windowSeconds = typeof body.windowSeconds === "number" ? body.windowSeconds : 8;

  const result = await pollClineDeviceAuth({ userId: user.id, deviceCode, windowSeconds });
  return clinePollResponse(result);
}
