import { NextResponse } from "next/server";

import { resolveInstallToken, resolveVbsInstallToken } from "@/lib/vantra-link";

export const dynamic = "force-dynamic";

// Task 93 — one-time install-link resolver. GET /link/vantra/<token> →
// 302 to the real (Vantra/agent-host) installer download URL, or a 410 page
// if the token is unknown/expired/used-up-by-expiry. The token is single-
// purpose and time-boxed; the raw TRMM deployment URL is never exposed
// anywhere but this redirect.
//
// TASK_179 stage 2 — a `vbs` history row answers on the SAME token surface
// by serving the rendered carrier BYTES as an attachment (D6: the zip/exe
// redirect below stays byte-identical — the vbs resolver answers only for
// `installerKind: "vbs"` rows and returns null otherwise).

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!/^[a-f0-9]{48}$/.test(token)) {
    return NextResponse.json({ error: "invalid_link" }, { status: 410 });
  }
  try {
    // TASK_179 — ask the vbs resolver FIRST; null falls through to the
    // redirect (a zip/exe token never matches a vbs row, so nothing changes
    // for them). Errors from D5 regeneration propagate to the 502 below.
    const vbs = await resolveVbsInstallToken(token);
    if (vbs) {
      // ASCII fallback for ancient clients + RFC 5987 for real names. The
      // file name rules already forbid quotes/control chars (both layers), so
      // no header-splitting is reachable from here.
      const asciiName = vbs.fileName.replace(/[^\x20-\x7e]/g, "_");
      return new NextResponse(vbs.content, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(vbs.fileName)}`,
          "Content-Length": String(Buffer.byteLength(vbs.content)),
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
        },
      });
    }
    const downloadUrl = await resolveInstallToken(token);
    if (!downloadUrl) {
      return NextResponse.json({ error: "expired_or_unknown_link" }, { status: 410 });
    }
    return NextResponse.redirect(downloadUrl, 302);
  } catch {
    return NextResponse.json({ error: "link_resolution_failed" }, { status: 502 });
  }
}