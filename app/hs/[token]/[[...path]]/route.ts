import { serveSiteFile } from "@/lib/hosting/serve";
import { resolveSiteServe } from "@/lib/hosting/sites";

// TASK_155 P3 — public LIVE route: GET /hs/<token>/<path…>.
//
// Serves the LOCAL engine's live tree (the newest PUBLISHED revision of a site
// whose engine is "local"). The premium engine's live site is a *.pages.dev URL
// served by Cloudflare. World-readable by an opaque, stable token; an unknown
// token, a cloudflare site, a path that escapes the tree, or no published
// revision at all is a clean 404.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string; path?: string[] }> }
) {
  const { token, path } = await params; // MUST await — async in Next.js 16
  const rel = (path ?? []).join("/");

  const resolved = await resolveSiteServe("hs", token, rel);
  if (!resolved.ok) {
    return new Response("Not found", { status: resolved.status });
  }
  return serveSiteFile(resolved.value.absPath, { noindex: false, immutable: true });
}
