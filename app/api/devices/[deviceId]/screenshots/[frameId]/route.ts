import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { getSession } from "@/lib/session";
import { assertSafeFramePath, frameAbsPath } from "@/lib/device-screenshots";

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
