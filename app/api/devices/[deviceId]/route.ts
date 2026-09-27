import { NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import { removeDevice } from "@/lib/vantra-link";

export const dynamic = "force-dynamic";

// TASK_128 §15 — remove a device (the owner's Delete button, both tiers).
//
//   DELETE              → uninstall the agent in Vantra (TRMM, tenant-checked)
//                         and then hide the local row
//   DELETE ?local=1     → hide the local row ONLY, leaving the agent installed
//                         (the escape hatch for an agent that cannot be removed
//                         through the service at all)
//
// Direct-execute, like every other MANUAL console tool (Wake/Reboot/Run now/
// PIN/maintenance): the approval rail in this codebase exists for
// AGENT-initiated requests, not for a user's own click — and the confirm step
// (with the extra warning for a Private device) lives in the UI, where the
// owner asked for it.
//
// An OFFLINE machine is still removable — TRMM removes the agent record whether
// or not the box answers. Never silent: if the removal genuinely did not happen
// the API answers 503 `agent_offline` and the row is left exactly as it was, so
// the UI can say WHY instead of hiding a failure.
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { deviceId } = await params;
  const localOnly = new URL(req.url).searchParams.get("local") === "1";

  try {
    const result = await removeDevice({ userId: session.userId, deviceId, localOnly });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const code = err instanceof Error ? err.message : "remove_failed";
    const status = code === "device_not_found" ? 404 : code === "agent_offline" ? 503 : 502;
    return NextResponse.json({ error: code }, { status });
  }
}
