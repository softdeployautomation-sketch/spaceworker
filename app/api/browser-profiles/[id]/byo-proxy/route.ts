import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { encryptProxySecret, PROXY_SCHEMES, type ProxyScheme } from "@/lib/browser-proxy";

// PUT /api/browser-profiles/[id]/byo-proxy — add/edit a profile's own BYO proxy
// (host, port, protocol, auth). Credentials are AES-256-GCM encrypted before
// storage; a blank password keeps the existing one (mirrors mailbox editing).
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params; // MUST await — async in Next.js 16

  const profile = await prisma.browserProfile.findFirst({
    where: { id, userId: session.userId },
  });
  if (!profile) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
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

  // Encrypt the new password (if provided); otherwise keep the existing blob.
  const byoProxyAuth =
    password.length > 0
      ? encryptProxySecret({ scheme, host, port, username, password })
      : profile.byoProxyAuth;

  const updated = await prisma.browserProfile.update({
    where: { id: profile.id },
    data: {
      byoProxyHost: host,
      byoProxyPort: port,
      byoProxyScheme: scheme,
      byoProxyUsername: username || null,
      byoProxyAuth,
    },
    select: {
      id: true,
      name: true,
      byoProxyHost: true,
      byoProxyPort: true,
      byoProxyScheme: true,
      byoProxyUsername: true,
    },
  });

  return NextResponse.json({ ...updated, hasByo: Boolean(byoProxyAuth) });
}