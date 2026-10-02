import { serveSiteFile } from "@/lib/hosting/serve";
import { resolveSiteServe } from "@/lib/hosting/sites";

// TASK_155 P3 — public PREVIEW route: GET /pv/<token>/<path…>.
//
// Serves the LOCAL engine's staging tree (the premium engine's preview is a
// *.pages.dev URL served by Cloudflare). World-readable by an opaque token, but
// always `X-Robots-Tag: noindex` — a preview is a real URL a user shares to
// check, never something to index. An expired preview, an unknown token, a
// cloudflare site or a path that escapes the tree is a clean 404.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string; path?: string[] }> }
) {
  const { token, path } = await params; // MUST await — async in Next.js 16
  const rel = (path ?? []).join("/");

  const resolved = await resolveSiteServe("pv", token, rel);
  if (!resolved.ok) {
    return new Response("Not found", { status: resolved.status });
  }
  return serveSiteFile(resolved.value.absPath, { noindex: true });
}
