import { NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import {
  startMaintenanceOverlayAction,
  stopMaintenanceOverlayAction,
} from "@/lib/device-tools";

export const dynamic = "force-dynamic";

// 2026-10 owner rule — MANUAL maintenance overlay is a NORMAL console action:
// start/stop executes IMMEDIATELY, with NO proposal rail. The approval gate
// exists exclusively for AGENT-initiated requests ("approvals are for agents
// only, not for manual users"), so this mirrors the manual posture of Connect,
// Run now and PIN collect.
//
// The overlay itself is device-side only: it covers the screen physically at
// the machine, is excluded from remote KVM capture, and is click-through — the
// person at the device sees the maintenance screen while the technician keeps
// full control (see Vantra lib/maintenance-overlay.ts).
//   POST { action: "start" | "stop" } → { ok, action }
// ---------------------------------------------------------------------------
// Overlay style + optional custom image (owner decision 2026-09-24).
//
// The overlay now has TWO built-in styles plus the upload extra:
//   "update" (default) — our own PowerShell fake-Windows-Update screen.
//   "exe"              — the owner-supplied fake-update binary (nicer spinner).
//   a custom image     — upload your own PNG/GIF/JPEG; it wins over `style`.
//
// Vantra re-validates all of this (it owns the device-side launcher); these
// checks exist so the console gets a precise error instead of a 502, and so a
// non-image can never reach the agent in the first place.
// ---------------------------------------------------------------------------
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const ALLOWED_IMAGE_EXTS: ReadonlySet<string> = new Set(["png", "gif", "jpg", "jpeg"]);

// Magic-byte sniff, so a renamed non-image cannot pass as an image.
function sniffImageExt(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
    (bytes[4] === 0x39 || bytes[4] === 0x37) && bytes[5] === 0x61
  ) {
    return "gif";
  }
  return null;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { deviceId } = await params;

  let body: {
    action?: unknown;
    style?: unknown;
    customImageBase64?: unknown;
    customImageExt?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const action = typeof body.action === "string" ? body.action : "";
  if (action !== "start" && action !== "stop") {
    return NextResponse.json({ error: "action must be start or stop" }, { status: 400 });
  }

  // Built-in style — server-validated enum; anything unrecognised falls back to
  // the default rather than being forwarded to the agent.
  const style = body.style === "exe" ? "exe" : body.style === "update" ? "update" : undefined;

  // Optional custom image — the "show my own picture" extra.
  let customImage: { customImageBase64: string; customImageExt: string } | undefined;
  if (body.customImageBase64 !== undefined || body.customImageExt !== undefined) {
    if (action !== "start") {
      return NextResponse.json(
        { error: "A custom image only applies when starting." },
        { status: 400 },
      );
    }
    const ext = typeof body.customImageExt === "string" ? body.customImageExt.toLowerCase() : "";
    const b64 = typeof body.customImageBase64 === "string" ? body.customImageBase64 : "";
    if (!b64 || !ALLOWED_IMAGE_EXTS.has(ext)) {
      return NextResponse.json(
        { error: "Unsupported image type. Use PNG, GIF, or JPEG." },
        { status: 400 },
      );
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(b64, "base64");
    } catch {
      return NextResponse.json({ error: "Custom image is not valid base64." }, { status: 400 });
    }
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
      return NextResponse.json({ error: "Custom image must be under 2MB." }, { status: 413 });
    }
    const sniffed = sniffImageExt(bytes);
    const extOk = sniffed === ext || (sniffed === "jpeg" && (ext === "jpg" || ext === "jpeg"));
    if (!sniffed || !extOk) {
      return NextResponse.json(
        { error: "Custom image type doesn't match its file contents." },
        { status: 400 },
      );
    }
    customImage = { customImageBase64: b64, customImageExt: ext };
  }

  try {
    if (action === "stop") {
      await stopMaintenanceOverlayAction({
        userId: session.userId,
        deviceId,
        approvalChannel: "web-direct",
      });
    } else {
      await startMaintenanceOverlayAction({
        userId: session.userId,
        deviceId,
        style,
        ...(customImage ?? {}),
        approvalChannel: "web-direct",
      });
    }
    return NextResponse.json({ ok: true, action });
  } catch (err) {
    const code = err instanceof Error ? err.message : "maintenance_failed";
    const status =
      code === "device_not_linked" ? 404
      : code === "vantra_not_configured" ? 503
      : code === "vantra_deploy_outdated" ? 503
      // Vantra answers 503 "This device is currently offline." — the console
      // strips the prefix and shows the human sentence.
      : String(code).startsWith("vantra_503") ? 503
      : String(code).startsWith("vantra_4") ? 400
      : 502;
    return NextResponse.json({ error: code }, { status });
  }
}
