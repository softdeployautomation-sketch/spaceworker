import { NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import {
  deletePinRequest,
  executePinRequest,
  listPinRequests,
} from "@/lib/device-tools";

export const dynamic = "force-dynamic";

// Task 95 — PIN request status for a device (owner's own session only).
// The PIN itself is readable once submitted — by its owner, in their session,
// from the device console. Rows are prunable; the token is stored only as a
// hash and never leaves this table.
//
// 2026-10 lifecycle rules:
//  • POST   — MANUAL collect executes IMMEDIATELY (no proposal rail; the
//             approval gate is exclusively for AGENT-initiated requests).
//  • GET    — only rows worth showing: a collected PIN, or the live request
//             still waiting on the person at the machine. Dead rows are
//             pruned server-side, so nothing cancelled/expired ever renders.
//  • DELETE — owner delete: cancels a still-waiting request (invalidating its
//             one-time token) or frees the UI by deleting a collected PIN.

const PIN_LENGTHS = new Set([4, 6, 8]);

// 2026-10 — MANUAL pin collect executes IMMEDIATELY (no proposal rail; the
// approval gate is exclusively for AGENT-initiated requests). Immediate when
// no schedule is given; queued on Vantra's sweep when scheduleKind is set.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { deviceId } = await params;

  let body: { pinLength?: unknown; scheduleKind?: unknown; wakeDelayMinutes?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const pinLength = Number(body.pinLength);
  if (!PIN_LENGTHS.has(pinLength)) {
    return NextResponse.json({ error: "pinLength must be 4, 6, or 8" }, { status: 400 });
  }
  const sk = body.scheduleKind === undefined ? undefined : String(body.scheduleKind);
  if (sk !== undefined && sk !== "next_checkin" && sk !== "after_wake") {
    return NextResponse.json({ error: "bad scheduleKind" }, { status: 400 });
  }
  const wakeDelayMinutes = sk === "after_wake" ? Math.max(0, Number(body.wakeDelayMinutes) || 0) : undefined;

  try {
    const result = await executePinRequest({
      userId: session.userId,
      deviceId,
      pinLength,
      ...(sk ? { scheduleKind: sk, wakeDelayMinutes: wakeDelayMinutes ?? 0 } : {}),
      approvalChannel: "web-direct",
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const code = err instanceof Error ? err.message : "pin_request_failed";
    const status =
      code === "bad_pin_length" ? 400
      : code === "device_not_linked" ? 404
      : code.startsWith("vantra_503") ? 503
      : 502;
    return NextResponse.json({ error: code }, { status });
  }
}

// 2026-10 — owner delete. ONE handler for both halves of the lifecycle:
//   • waiting request → cancels it (the row + one-time token go away, so a
//     late PIN post can't land);
//   • collected PIN    → removes it from the console once it's been read.
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { deviceId } = await params;

  let body: { pinRequestId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const pinRequestId = typeof body.pinRequestId === "string" ? body.pinRequestId : "";
  if (!pinRequestId) {
    return NextResponse.json({ error: "pinRequestId required" }, { status: 400 });
  }

  try {
    const deleted = await deletePinRequest({ userId: session.userId, deviceId, pinRequestId });
    if (deleted === 0) {
      // Already gone (pruned by TTL, or deleted in another tab) — the caller's
      // goal is "it must not be in the UI", which is satisfied either way.
      return NextResponse.json({ ok: true, deleted: 0, alreadyGone: true });
    }
    return NextResponse.json({ ok: true, deleted });
  } catch (err) {
    const code = err instanceof Error ? err.message : "pin_delete_failed";
    const status = code === "device_not_linked" ? 404 : 502;
    return NextResponse.json({ error: code }, { status });
  }
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { deviceId } = await params;

  try {
    const requests = await listPinRequests({ userId: session.userId, deviceId });
    return NextResponse.json({ ok: true, requests });
  } catch (err) {
    const code = err instanceof Error ? err.message : "pin_list_failed";
    const status = code === "device_not_linked" ? 404 : 502;
    return NextResponse.json({ error: code }, { status });
  }
}
