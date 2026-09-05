import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-auth";
import {
  CONTROLLABLE_UNITS,
  SERVICE_ACTIONS,
  controlService,
  getServiceState,
} from "@/lib/services-control";

// GET /api/admin/services — live state of every controllable unit.
export async function GET() {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const states = await Promise.all(CONTROLLABLE_UNITS.map((unit) => getServiceState(unit)));
    return NextResponse.json(states);
  } catch (err) {
    return NextResponse.json(
      { error: "Couldn't read service state", detail: String(err) },
      { status: 502 }
    );
  }
}

// POST /api/admin/services — { unit, action } where action is
// "start" | "stop" | "restart". The allowlist is enforced both here (zod-
// style manual check) and again inside controlService itself — defense in
// depth, matching the pattern already used for other admin mutation routes.
export async function POST(req: Request) {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  // A JSON body of `null`/a bare string/number parses successfully above but
  // isn't an object — reading .unit off it would throw outside this try/catch
  // and surface as an opaque 500 instead of the same clean 400 every other
  // malformed-input case here returns.
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const unit = String((body as Record<string, unknown>).unit ?? "");
  const action = String((body as Record<string, unknown>).action ?? "");
  if (!(CONTROLLABLE_UNITS as readonly string[]).includes(unit)) {
    return NextResponse.json({ error: `Unit is not controllable: ${unit}` }, { status: 400 });
  }
  if (!SERVICE_ACTIONS.includes(action as (typeof SERVICE_ACTIONS)[number])) {
    return NextResponse.json({ error: `Invalid action: ${action}` }, { status: 400 });
  }

  try {
    await controlService(unit, action);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: "Service control command failed", detail: String(err) },
      { status: 502 }
    );
  }
}
