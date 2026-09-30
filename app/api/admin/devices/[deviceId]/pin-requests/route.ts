import { NextResponse } from "next/server";

import { getAdminSession } from "@/lib/admin-auth";
import { adminCommandErrorStatus, splitDeviceError } from "@/lib/admin-devices";
import { adminExecutePinRequest, adminListPinRequests } from "@/lib/device-tools";

export const dynamic = "force-dynamic";

// TASK_148 — the admin PIN collect.
//
// SILENT console-side, and this is the route that makes it true. A PIN request
// stores the COLLECTED PIN on the DevicePinRequest row, and the owner's console
// reads that table by {deviceId, userId} with no other filter — so without the
// `origin` column (see prisma/schema.prisma) an admin collect would put both the
// request and the PIN itself into the reported user's own PIN panel. These rows
// are written origin="admin", the customer list filters on that column, and this
// is the only reader that sees them.
//
// NOT silent device-side: the prompt appears on the machine and the person at
// the keyboard types the code. That is what "collect a PIN" means.
//
//   POST { pinLength: 4|6|8 } → { ok, pinRequestId, expiresAt }
//   GET                       → { ok, requests: [{ …, pin }] }

const PIN_LENGTHS: ReadonlySet<number> = new Set([4, 6, 8]);

// Mirrors the customer PIN route's mapping (app/api/devices/[deviceId]/
// pin-requests/route.ts) so one device layer keeps one error contract, then
// falls through to the shared admin mapping for everything else.
function pinErrorStatus(code: string): number {
  if (code === "bad_pin_length") return 400;
  if (code.startsWith("vantra_503")) return 503;
  return adminCommandErrorStatus(code);
}

export async function POST(req: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const isAdmin = await getAdminSession();
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { deviceId } = await params;

  let body: { pinLength?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const pinLength = Number(body.pinLength);
  if (!PIN_LENGTHS.has(pinLength)) {
    return NextResponse.json({ error: "pinLength must be 4, 6, or 8" }, { status: 400 });
  }

  try {
    const result = await adminExecutePinRequest({ deviceId, pinLength });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const { code, message } = splitDeviceError(err);
    return NextResponse.json(
      { error: message, code },
      // A PIN is a device prompt: an offline machine is 503, not a bad request.
      { status: pinErrorStatus(code) },
    );
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const isAdmin = await getAdminSession();
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { deviceId } = await params;

  try {
    const requests = await adminListPinRequests({ deviceId });
    return NextResponse.json({
      ok: true,
      // Dates → ISO strings for the wire, same as every other admin read model.
      requests: requests.map((r) => ({
        ...r,
        expiresAt: r.expiresAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    const { code, message } = splitDeviceError(err);
    return NextResponse.json({ error: message, code }, { status: pinErrorStatus(code) });
  }
}
