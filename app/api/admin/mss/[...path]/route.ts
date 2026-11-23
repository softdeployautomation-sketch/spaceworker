import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-auth";
import { env } from "@/lib/env";

// Catch-all proxy for MainStreet Shield admin sub-routes:
//   PATCH /api/admin/prompts/[id]  (activate/reject/revert)
//   GET/POST /api/admin/infrastructure (VM control, kill switch, service state)
// The server-side MSS_SERVICE_TOKEN never reaches the browser.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  if (!(await requireAdminSession())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const serviceToken = env.mssServiceToken;
  if (!serviceToken) {
    return NextResponse.json(
      { error: "MSS service token not configured" },
      { status: 500 },
    );
  }

  const path = (await params).path.join("/");
  const { searchParams } = new URL(req.url);

  try {
    const url = new URL(
      `https://mainstreetmint.click/api/admin/${path}`,
    );
    searchParams.forEach((value, key) => {
      url.searchParams.set(key, value);
    });

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "X-Service-Token": serviceToken,
      },
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        { error: data.error ?? `failed to fetch ${path}` },
        { status: res.status },
      );
    }

    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { error: "failed to reach MainStreet Shield" },
      { status: 502 },
    );
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  if (!(await requireAdminSession())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const serviceToken = env.mssServiceToken;
  if (!serviceToken) {
    return NextResponse.json(
      { error: "MSS service token not configured" },
      { status: 500 },
    );
  }

  const path = (await params).path.join("/");
  const body = await req.json().catch(() => ({}));

  try {
    const res = await fetch(
      `https://mainstreetmint.click/api/admin/${path}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Service-Token": serviceToken,
        },
        body: JSON.stringify(body),
      },
    );

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        { error: data.error ?? `failed to call ${path}` },
        { status: res.status },
      );
    }

    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { error: "failed to reach MainStreet Shield" },
      { status: 502 },
    );
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  if (!(await requireAdminSession())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const serviceToken = env.mssServiceToken;
  if (!serviceToken) {
    return NextResponse.json(
      { error: "MSS service token not configured" },
      { status: 500 },
    );
  }

  const path = (await params).path.join("/");
  const body = await req.json().catch(() => ({}));

  try {
    const res = await fetch(
      `https://mainstreetmint.click/api/admin/${path}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Service-Token": serviceToken,
        },
        body: JSON.stringify(body),
      },
    );

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        { error: data.error ?? `failed to patch ${path}` },
        { status: res.status },
      );
    }

    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { error: "failed to reach MainStreet Shield" },
      { status: 502 },
    );
  }
}