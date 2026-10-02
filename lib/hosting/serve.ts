import { promises as fs } from "node:fs";
import path from "node:path";

// TASK_155 P3 — shared serving helper for the LOCAL engine's site trees
// (/pv/<token>/… previews and /hs/<token>/… live). The route decides the token
// kind and resolves the on-disk path (lib/hosting/sites.ts resolveSiteServe);
// this helper turns that path into a streamed, correctly-typed response.

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  pdf: "application/pdf",
  wasm: "application/wasm",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  zip: "application/zip",
};

export function mimeForPath(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

export interface ServeOptions {
  /** A per-request response flag — previews are noindex, live trees are not. */
  noindex: boolean;
  /** Immutable caching is safe for a revision tree (a re-publish mints a new token). */
  immutable?: boolean;
}

/**
 * Stream a resolved file. A missing file, a directory with no index, or an
 * unreadable path all become a clean 404 — the public site route must never leak
 * a stack trace (same contract as /hf and /r).
 */
export async function serveSiteFile(absPath: string, opts: ServeOptions): Promise<Response> {
  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  if (!stat.isFile()) {
    return new Response("Not found", { status: 404 });
  }

  let body: Buffer;
  try {
    body = await fs.readFile(absPath);
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const headers: Record<string, string> = {
    "Content-Type": mimeForPath(absPath),
    "Content-Length": String(body.byteLength),
    "X-Content-Type-Options": "nosniff",
  };
  if (opts.immutable) headers["Cache-Control"] = "public, max-age=300";
  if (opts.noindex) headers["X-Robots-Tag"] = "noindex";

  return new Response(new Uint8Array(body), { status: 200, headers });
}