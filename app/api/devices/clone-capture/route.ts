// TASK_119A A5: Live session capture ingest (device-facing, token-gated)
// Route: POST /api/devices/clone-capture
// Auth: device token (SHA-256 hash match), NOT internal bearer
// Contract: device sends {cloneJobId, deviceId, browser, capturedAt, cookies[], truncated}
// Policy: fail-closed, neutral on mismatch, no write on failure, rate-limit per device

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sha256Hex } from "@/lib/clone-transport";
import { storeCapture } from "@/lib/clone-live-capture";

const BODY_SIZE_CAP = 1024 * 1024; // 1 MiB per spec A5

interface CapturePayload {
  cloneJobId: string;
  deviceId: string;
  browser: string;
  capturedAt: string;
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: string;
    expirationDate?: number;
  }>;
  truncated: boolean;
}

export async function POST(request: NextRequest) {
  try {
    // 1. Body-size cap first (public route).
    const contentLength = request.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > BODY_SIZE_CAP) {
      return NextResponse.json(
        { error: "Payload too large" },
        { status: 413 }
      );
    }

    // 2. Parse body (neutral on parse error).
    let payload: CapturePayload;
    try {
      payload = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid request" },
        { status: 400 }
      );
    }

    // 3. Extract and hash the device token from Authorization header.
    const authHeader = request.headers.get("authorization") || "";
    const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/);
    if (!tokenMatch) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }
    const rawToken = tokenMatch[1];
    const tokenHash = sha256Hex(rawToken);

    // 4. Unique lookup: find the device by token hash (fail-closed, no oracle).
    const device = await db.device.findUnique({
      where: { liveCaptureTokenHash: tokenHash },
      select: {
        id: true,
        userId: true,
      },
    });
    if (!device) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    // 5. Verify deviceId in payload matches the device we found.
    if (payload.deviceId !== device.id) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    // 6. Verify cloneJobId belongs to this device's user and expects a capture.
    const cloneJob = await db.cloneJob.findUnique({
      where: { id: payload.cloneJobId },
      select: {
        id: true,
        userId: true,
        sourceDeviceId: true,
        status: true,
        sessionMode: true,
      },
    });
    if (
      !cloneJob ||
      cloneJob.userId !== device.userId ||
      cloneJob.sourceDeviceId !== device.id ||
      cloneJob.sessionMode !== "live"
    ) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    // 7. Verify job state expects a capture (A5a: "in a state that expects a capture").
    // For live clones, capture arrives after job creation but before launch.
    const acceptedStates = ["requested", "awaiting_source"];
    if (!acceptedStates.includes(cloneJob.status)) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    // 8. Validate payload fields (A5: "payload validation, shape, caps, sanity").
    if (!payload.browser || !["chrome", "edge", "firefox"].includes(payload.browser)) {
      return NextResponse.json(
        { error: "Bad request: invalid browser" },
        { status: 400 }
      );
    }
    if (typeof payload.cookies !== "object" || !Array.isArray(payload.cookies)) {
      return NextResponse.json(
        { error: "Bad request: invalid cookies format" },
        { status: 400 }
      );
    }
    if (payload.cookies.length === 0 && !payload.truncated) {
      return NextResponse.json(
        { error: "Bad request: empty jar not allowed" },
        { status: 400 }
      );
    }

    // 9. Hold payload only for injection (A5: "never logged, echoed, audited").
    // Store in memory temporarily, delete after injection succeeds or on failure.
    const cookieCount = payload.cookies.length;
    const domainCount = new Set(payload.cookies.map((c) => c.domain)).size;

    // 10. Store the capture payload in memory (with 5-min TTL).
    // TASK_119A A6: storeCapture holds this in RAM only, never persisted.
    storeCapture({
      cloneJobId: payload.cloneJobId,
      deviceId: payload.deviceId,
      browser: payload.browser,
      capturedAt: payload.capturedAt,
      cookies: payload.cookies,
      truncated: payload.truncated,
    });

    // 11. Update the cloneJob to mark capture received (NOT stored at rest).
    // The actual cookie payload must NOT be persisted — only counts.
    await db.cloneJob.update({
      where: { id: cloneJob.id },
      data: {
        status: "captured",
      },
    });

    // 12. Return neutral success (202 Accepted, counts only per A5).
    return NextResponse.json(
      {
        ok: true,
        accepted: cookieCount,
      },
      { status: 202 }
    );
  } catch (err) {
    console.error("[clone-capture]", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
