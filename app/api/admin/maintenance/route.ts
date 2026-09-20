import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminSession } from "@/lib/admin-auth";
import { getMaintenanceFlags, invalidateMaintenanceCache } from "@/lib/maintenance";

// Task 56 — admin-toggleable maintenance windows. GET returns the current flag
// values (from the cached reader, so what the admin sees is what the proxy
// enforces). PATCH flips either flag by field name; both flags default false and
// are independent (web vs EXE-API) so they stay correct once EXE-API traffic
// moves to its own hostname. Writes invalidate the read cache so the change is
// enforced immediately rather than after the ~8s proxy TTL.

const FIELDS: Array<{ key: "web" | "exeApi"; column: "maintenanceModeWeb" | "maintenanceModeExeApi" }> = [
  { key: "web", column: "maintenanceModeWeb" },
  { key: "exeApi", column: "maintenanceModeExeApi" },
];

export async function GET() {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const flags = await getMaintenanceFlags();
  return NextResponse.json(flags);
}

// PATCH — body: { field: "web" | "exeApi", value: boolean }
export async function PATCH(req: Request) {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let raw: { field?: unknown; value?: unknown };
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (typeof raw !== "object" || raw === null) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const field = String(raw.field ?? "");
  const row = FIELDS.find((f) => f.key === field);
  if (!row) {
    return NextResponse.json({ error: "Unknown field" }, { status: 400 });
  }
  if (typeof raw.value !== "boolean") {
    return NextResponse.json({ error: "value must be a boolean" }, { status: 400 });
  }

  const data = { [row.column]: raw.value };
  await prisma.adminSetting.upsert({
    where: { id: "singleton" },
    update: data,
    create: data,
  });
  invalidateMaintenanceCache();
  return NextResponse.json(await getMaintenanceFlags());
}