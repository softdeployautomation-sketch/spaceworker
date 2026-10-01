import { NextResponse } from "next/server";

import { recordServe, resolveServe } from "@/lib/hosting/files";
import { resolveProvider } from "@/lib/hosting/providers";

// TASK_155 P1 — public download route: GET /hf/<token>.
//
// World-readable by design, exactly like /r/<token> (app/r/[token]/route.ts): the
// token is an OPAQUE LOOKUP KEY sitting in a link, NOT a bearer secret. An
// unknown / expired / private / withheld token must be a clean 404 (or 429 when
// the owner's monthly bandwidth cap is hit) — never a stack trace.
//
// The SERVED FILENAME is a header derived from the row's `dispositionFilename`,
// so renaming an artifact changes only that header and NEVER the bytes (§4). The
// body is streamed from the storage provider, so a 512 MB EXE never sits in RAM.
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params; // MUST await — async in Next.js 16

  const resolved = await resolveServe(token);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.message, code: resolved.code }, { status: resolved.status });
  }
  const asset = resolved.value;

  let body: ReadableStream<Uint8Array>;
  try {
    body = await resolveProvider(asset.provider).read({
      storagePath: asset.storagePath,
      externalId: asset.externalId,
    });
  } catch {
    // The row says bytes exist but the provider can't produce them — treat it as
    // gone rather than leaking an internal error.
    return NextResponse.json({ error: "Not found", code: "not_found" }, { status: 404 });
  }

  // Best-effort accounting; never blocks or breaks the download.
  void recordServe(asset, asset.bytes);

  const asciiFallback = asset.dispositionFilename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
  const encoded = encodeURIComponent(asset.dispositionFilename);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": asset.mime || "application/octet-stream",
      "Content-Length": String(asset.bytes),
      // Force a download with the (possibly renamed) filename; RFC 5987 filename*
      // carries the true UTF-8 name, the plain filename is the ASCII fallback.
      "Content-Disposition": `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`,
      // Immutable: a token's bytes never change (a rename rewrites a header, a
      // re-upload mints a new token), so this is safe and cheap.
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
