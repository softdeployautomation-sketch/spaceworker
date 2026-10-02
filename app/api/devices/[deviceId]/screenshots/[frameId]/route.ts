import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { getSession } from "@/lib/session";
import {
  assertSafeFramePath,
  deleteFrameForUser,
  frameAbsPath,
} from "@/lib/device-screenshots";

export const dynamic = "force-dynamic";

// TASK_127 Phase 1 — serve ONE stored frame to the device's owner.
//
// Frames are deliberately NOT static assets and NOT public URLs: the screenshot
// root sits outside the application directory precisely so nothing can reach
// these files without passing this check. Two gates here, both required:
//
//   1. OWNERSHIP — the frame is looked up by its id AND its device's userId, so
//      guessing a frame id gets a 404, never somebody else's screen.
//   2. PATH SAFETY — the stored path is data, so it goes through the same
//      traversal guard the writer uses before any file is opened.
//
// `private, no-store` on the response: this is a picture of a person's desktop,
// so it must not sit in a shared cache or a proxy.

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ deviceId: string; frameId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { deviceId, frameId } = await params;

  const frame = await db.deviceScreenshot.findFirst({
    where: {
      id: frameId,
      deviceId,
      device: { userId: session.userId },
      status: "captured",
    },
    select: { filePath: true },
  });
  if (!frame?.filePath) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let bytes: Buffer;
  try {
    const abs = frameAbsPath(frame.filePath);
    assertSafeFramePath(abs);
    bytes = await readFile(abs);
  } catch {
    // The row outlived its file (a purge that crashed between unlink and delete,
    // or a manual cleanup). Report it as gone rather than as a server error.
    return NextResponse.json({ error: "Frame file is gone" }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "private, no-store",
      // Belt and braces: even if a browser ever renders it inline, it is a PNG,
      // never anything that can execute.
      "Content-Disposition": "inline; filename=\"frame.png\"",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * TASK_157 — the owner permanently deletes one frame.
 *
 * THE BUG THIS FIXES: the "×" on a timeline card had no endpoint behind it. The
 * route only ever exported GET, so the button could not do anything — which is
 * exactly the symptom reported ("I clicked the × on each frame and it won't
 * leave"). The frames that could not be captured, and the ones nobody wants
 * sitting in the timeline, had no way out.
 *
 * Gates, in the same order and shape as the GET above:
 *   1. SESSION — no session, 401.
 *   2. OWNERSHIP — resolved inside deleteFrameForUser by (frameId, device.userId).
 *      A frame that is not the caller's is a 404, never a 403, so the endpoint
 *      cannot be used to discover that an id exists.
 *
 * Deleting the row and the PNG is permanent and there is no undo, so the UI
 * confirms first. We deliberately do NOT add a soft-delete/recycle-bin: nothing
 * else in the product has one, retention is already the "it goes away" mechanism,
 * and a second lifecycle would be a much larger change than the reported bug.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ deviceId: string; frameId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { frameId } = await params;

  const outcome = await deleteFrameForUser(frameId, session.userId);
  if (outcome === "not_found") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, frameId });
}
