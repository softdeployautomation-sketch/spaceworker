// TASK_127 Phase 1 — the screen-capture SERVICE.
//
//   ExecStart=/usr/bin/npx tsx browser-capture/server.ts   (deploy/screenshot-capture.service)
//
// A small, long-running HTTP process that owns the headless Chromium, so the
// browser never runs inside the Next.js app (the same reason
// deploy/spaceworker-browser.service exists) and never inside the app's systemd
// cgroup, where a heavy browser could get the WEB APP killed by its own limits.
//
// It is deliberately dumb: it knows how to take one screenshot of one console
// URL and nothing else. It has no database, no session secret, and no idea which
// devices exist — the app decides all of that and hands it a ready-to-use
// request (see app/api/internal/screenshot-sweep/route.ts). That keeps the
// trust boundary at the existing localhost Bearer secret, and keeps this process
// importable as plain Node code (no lib/ — see capture.ts's header for why that
// matters).
//
// Conventions mirror browser-server/server.ts on purpose: same Bearer scheme,
// same port-from-env style, same one-line "listening on" log.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { CaptureError, captureScreen, type CaptureRequest } from "./capture";

const HOST = process.env.SCREENSHOT_CAPTURE_HOST ?? "127.0.0.1";
/**
 * 3403, chosen to sit beside its siblings: 3401 is browser-server, 3402 is the
 * relay ingress. Nothing else listens here, and it is bound to loopback only.
 */
const PORT = Number(process.env.SCREENSHOT_CAPTURE_PORT ?? 3403);
const TOKEN = process.env.SCREENSHOT_CAPTURE_TOKEN;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Same shape as browser-server's token check: an unset/empty token can never
 * authenticate anything, so a misconfigured service refuses every request rather
 * than becoming an open screenshot endpoint on the box.
 */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? "";
  return TOKEN !== undefined && TOKEN.length > 0 && header === `Bearer ${TOKEN}`;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    // This endpoint's body is a few hundred bytes of URL/path/token. A cap keeps
    // a stray or hostile localhost caller from ballooning this process's memory.
    if (total > 64 * 1024) throw new CaptureError("request_too_large");
    chunks.push(buf);
  }
  if (total === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

/** Validate the wire shape into a CaptureRequest, so capture.ts stays typed. */
function parseRequest(body: Record<string, unknown>): CaptureRequest {
  const str = (key: string): string => {
    const value = body[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new CaptureError(`missing_field_${key}`);
    }
    return value;
  };
  return {
    consoleUrl: str("consoleUrl"),
    cookieName: str("cookieName"),
    cookieValue: str("cookieValue"),
    cookieDomain: str("cookieDomain"),
    secureCookie: body.secureCookie === true,
    outputPath: str("outputPath"),
  };
}

const server = createServer(async (req, res) => {
  if (!authorized(req)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }
  if (req.method !== "POST" || !req.url?.startsWith("/capture")) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }

  try {
    const body = await readJson(req);
    const result = await captureScreen(parseRequest(body));
    // 200 even for a failed capture: "the frame could not be taken" is a normal
    // outcome the app records as a failed DeviceScreenshot row. A 5xx here would
    // make an expected failure look like the service itself is broken.
    sendJson(res, 200, result);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "capture_error";
    // 400 for a malformed request (the app's bug), 200-style reporting for
    // capture problems — the caller keys on `reason` either way.
    const status = reason.startsWith("missing_field_") || reason === "request_too_large" ? 400 : 500;
    sendJson(res, status, { ok: false, failureReason: reason });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`screenshot capture service listening on ${HOST}:${PORT}`);
});
