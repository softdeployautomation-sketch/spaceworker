import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-auth";
import { env } from "@/lib/env";

// POST /api/admin/mainstreet/invites — proxy to MainStreet Shield's invite API
// SpaceWorker admin calls this to generate MainStreet Shield referral codes
export async function POST(req: Request) {
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
  const { email, expiresInDays } = body;

  try {
    const res = await fetch(
      "https://mainstreetmint.click/api/admin/invites",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Service-Token": serviceToken,
        },
        body: JSON.stringify({
          email: email ?? null,
          expiresInDays: expiresInDays ?? 7,
        }),
      }
    );

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        { error: data.error ?? "failed to create invite" },
        { status: res.status }
      );
    }

    return NextResponse.json({ ok: true, invite: data.invite });
  } catch {
    return NextResponse.json(
      { error: "failed to reach MainStreet Shield" },
      { status: 502 }
    );
  }
}