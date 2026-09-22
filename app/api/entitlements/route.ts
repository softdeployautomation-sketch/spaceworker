import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { listEffectiveEntitlements } from "@/lib/entitlements";

// Task 92 — the signed-in user's own effective entitlements (what's on, and
// why: premium vs grant). Powers Settings/Billing visibility now; the store
// (Task 99) and feature gates read lib/entitlements.ts server-side.

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { keys, premium, grants } = await listEffectiveEntitlements(session.userId);
  return NextResponse.json({ keys, premium, grants });
}