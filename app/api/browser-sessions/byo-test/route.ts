import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { checkIpThroughProxy, PROXY_SCHEMES, type ProxyScheme } from "@/lib/browser-proxy";

// POST /api/browser-sessions/byo-test — test-connect a BYO proxy BEFORE trusting
// it (same discipline as Task 4's mailbox test-connection). A live IP check is
// performed through the candidate proxy; success proves it resolves traffic.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    host?: string;
    port?: number;
    scheme?: string;
    username?: string;
    password?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const host = String(body.host ?? "").trim();
  const port = Number(body.port ?? 0);
  const scheme = (String(body.scheme ?? "").trim() || "http") as ProxyScheme;
  const username = String(body.username ?? "").trim();
  const password = String(body.password ?? "");

  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return NextResponse.json({ error: "A valid host and port are required" }, { status: 400 });
  }
  if (!PROXY_SCHEMES.includes(scheme)) {
    return NextResponse.json(
      { error: `scheme must be one of: ${PROXY_SCHEMES.join(", ")}` },
      { status: 400 }
    );
  }

  try {
    const ip = await checkIpThroughProxy({
      scheme,
      host,
      port,
      username: username || undefined,
      password: password || undefined,
    });
    return NextResponse.json({ ok: true, ip, scheme, host });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Test-connect failed" },
      { status: 200 }
    );
  }
}