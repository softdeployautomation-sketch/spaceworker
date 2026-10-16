import fs from "node:fs/promises";

import { NextResponse } from "next/server";

import { engineArtifactPath } from "@/lib/clone-engine-dist";

export const dynamic = "force-dynamic";

// TASK_214 D6 (P6b) — the force-install distribution path. DELIBERATELY
// PUBLIC: unlike /api/clone-engine (HMAC + device-bound), Chrome's
// auto-updater fetches the update manifest and the CRX ANONYMOUSLY — no
// cookie, no HMAC, nothing to sign with. This is a decision, not an accident:
// the extension is not secret (anyone may install it), the CRX is served
// exactly as packed by the signed build, and the manifest reveals only the
// extension id + version that any installed copy already knows.
//
// The allowlist below is the entire surface: exactly the two D6 files, read
// from engine-dist via the same manifest-validated path helper as the signed
// route (no traversal, no serving of the Windows binaries — those stay on
// the HMAC route where a leaked URL is useless).
const FORCELIST_FILES: Record<string, string> = {
  "clone-extension.crx": "application/x-chrome-extension",
  "clone-ext-update.json": "application/json",
};

export async function GET(req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const contentType = FORCELIST_FILES[file];
  if (!contentType) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const filePath = await engineArtifactPath(file).catch(() => null);
  if (!filePath) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const bytes = await fs.readFile(filePath).catch(() => null);
  if (!bytes) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Long-ish cache is safe and deliberate: the manifest/CRX change only when
  // the extension version changes, and a stale CRX cannot install over a
  // newer one (Chrome compares versions, it does not blindly overwrite).
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(bytes.byteLength),
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300",
    },
  });
}