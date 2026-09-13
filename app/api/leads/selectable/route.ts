import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { fetchSelectableData } from "@/lib/lead-selectable";

// Task 26, Piece 4 — picker data for the campaign "Pick from my leads" flow.
// GET /api/leads/selectable  (auth-gated)
//
// Returns everything the picker UI needs in one round trip:
//   jobs:  the user's recent extraction/upload SearchJobs, each with its total
//          lead count and its validationStatus="valid" count (so the dropdown can
//          show "N valid" and gray out jobs with nothing valid to select).
//   leads: every one of the user's VALID leads (id/email/names/searchJobId), so the
//          picker can offer "select all valid across everything" without a second call.
//
// This is a read-only convenience endpoint; the WRITE side (from-leads) re-validates
// ownership + validity server-side and never trusts what the client filtered to.
//
// Task 37 — the query/shape now lives in lib/lead-selectable.ts (shared with the
// agent's list_lead_sources inline widget) so both callers reuse ONE implementation.

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const data = await fetchSelectableData(session.userId);
  return NextResponse.json(data);
}