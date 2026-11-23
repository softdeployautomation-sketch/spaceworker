import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-auth";
import { env } from "@/lib/env";

// Proxy for MainStreet Shield admin prompts API (GET/POST /api/admin/prompts).
// SpaceWorker frontend calls this instead of calling MSS directly — the
// server-side MSS_SERVICE_TOKEN never reaches the browser.
export async function GET(req: Request) {
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

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");

  try {
    const url = new URL(
      "https://mainstreetmint.click/api/admin/prompts",
    );
    if (companyId) url.searchParams.set("companyId", companyId);

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "X-Service-Token": serviceToken,
      },
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        { error: data.error ?? "failed to fetch prompts" },
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

export async function POST(req: Request) {
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

  const body = await req.json().catch(() => ({}));
  const { key, body: promptBody, rationale } = body;

  if (!key || !promptBody) {
    return NextResponse.json(
      { error: "key and body are required" },
      { status: 400 },
    );
  }

  try {
    const res = await fetch(
      "https://mainstreetmint.click/api/admin/prompts",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Service-Token": serviceToken,
        },
        body: JSON.stringify({ key, body: promptBody, rationale }),
      },
    );

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        { error: data.error ?? "failed to create prompt draft" },
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