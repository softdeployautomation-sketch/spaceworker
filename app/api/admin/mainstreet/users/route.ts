import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-auth";
import { env } from "@/lib/env";

// GET /api/admin/mainstreet/users — proxy to MainStreet Shield's user list API
// SpaceWorker admin calls this to view MainStreet Shield users
export async function GET(req: Request) {
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

  const { searchParams } = new URL(req.url);
  const tier = searchParams.get("tier");
  const search = searchParams.get("search");

  try {
    const res = await fetch(
      `https://mainstreetmint.click/api/admin/users?tier=${tier ?? ""}&search=${search ?? ""}`,
      {
        method: "GET",
        headers: {
          "X-Service-Token": serviceToken,
        },
      }
    );

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        { error: data.error ?? "failed to fetch users" },
        { status: res.status }
      );
    }

    return NextResponse.json({ users: data.users ?? [] });
  } catch {
    return NextResponse.json(
      { error: "failed to reach MainStreet Shield" },
      { status: 502 }
    );
  }
}
