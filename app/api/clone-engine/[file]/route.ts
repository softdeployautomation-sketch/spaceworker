import fs from "node:fs/promises";

import { NextResponse } from "next/server";

import { engineArtifactPath, verifyEngineSignature } from "@/lib/clone-engine-dist";

export const dynamic = "force-dynamic";

// TASK_114 — the agent's download endpoint for the clone-engine bundle.
//
// This route deliberately has NO session check: the caller is a Windows agent
// running as SYSTEM on the customer's device, which has no cookie. The auth is
// the HMAC signature minted by lib/clone-engine-dist.signedEngineUrl() during a
// signed-in setup request: it is bound to one artifact + one Device id, expires
// within an hour, and is compared in constant time. Without a valid signature
// this route reveals nothing (not even whether the artifact exists).
//   GET /api/clone-engine/<artifact>?d=<deviceId>&e=<exp>&s=<sig>
export async function GET(
  req: Request,
  { params }: { params: Promise<{ file: string }> },
) {
  const { file } = await params;
  const url = new URL(req.url);
  const deviceId = url.searchParams.get("d") ?? "";
  const exp = Number(url.searchParams.get("e") ?? "0");
  const sig = url.searchParams.get("s") ?? "";

  if (!verifyEngineSignature({ file, deviceId, exp, sig })) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const filePath = await engineArtifactPath(file).catch(() => null);
  if (!filePath) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const bytes = await fs.readFile(filePath).catch(() => null);
  if (!bytes) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": `attachment; filename="${file}"`,
      "Cache-Control": "no-store",
    },
  });
}
