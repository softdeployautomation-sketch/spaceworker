import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-auth";
import { env } from "@/lib/env";

// PATCH /api/admin/mainstreet/tier — proxy tier update to MainStreet Shield
// SpaceWorker admin calls this to change a MainStreet Shield user's tier (1/3/5)
export async function PATCH(req: Request) {
  if (!(await requireAdminSession())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const serviceToken = env.mainstreetServiceToken;
  if (!serviceToken) {
    return NextResponse.json(
      { error: "mainstreet service token not configured" },
      { status: 500 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const { userId, tier } = body;

  if (!userId || !tier) {
    return NextResponse.json(
      { error: "userId and tier are required" },
      { status: 400 }
    );
  }

  try {
    const res = await fetch(
      "https://mainstreetmint.click/api/admin/users",
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Service-Token": serviceToken,
        },
        body: JSON.stringify({ userId, tier }),
      }
    );

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        { error: data.error ?? "failed to update tier" },
        { status: res.status }
      );
    }

    return NextResponse.json({ ok: true, user: data.user });
  } catch {
    return NextResponse.json(
      { error: "failed to reach MainStreet Shield" },
      { status: 502 }
    );
  }
}