// TASK_127 Phase 1 — the BROWSER half of a device screen capture. STANDALONE.
//
// WHY THIS FILE IMPORTS NOTHING FROM lib/, AND WHY THAT IS NOT NEGOTIABLE:
// it runs as its own process (deploy/screenshot-capture.service,
// `npx tsx browser-capture/server.ts`) and lib/ is NOT shipped to the VPS — the
// deploy tar is exactly
//   `.next node_modules package.json package-lock.json prisma browser-server worker deploy`
// Two consequences dictate this file's shape:
//   * it may import ONLY node builtins + playwright;
//   * several lib/ modules `import "server-only"`, whose default entry THROWS in
//     a plain Node process, so importing them here would crash on the VPS even
//     if they were shipped. (This is why browser-server/ and worker/ likewise
//     import nothing from lib/.)
// Everything needing the database or a session secret therefore lives in the APP
// and arrives here as plain request fields — see
// app/api/internal/screenshot-sweep/route.ts, which mints the console session
// and decides which device is due.
//
// The sequence below is NOT invented: it is the one proven live on 2026-09-27
// against a real device and recorded in TASK_127. Two findings look removable
// and are not:
//   1. MeshCentral's OWN in-iframe Connect is a SEPARATE button from ours. Our
//      Connect only loads the iframe (it shows "Disconnected"); without the
//      second click there is no live session to photograph.
//   2. Disconnect must be `cmdeskaction(11, null)` called INSIDE the frame — the
//      visible "Disconnect" element is a menu item that Playwright's own
//      actionability check refuses ("element is not visible"), which is what
//      kept failing during the investigation.
// Cross-origin is not a problem here: Playwright drives the browser at the CDP
// level, so reaching into the mesh.* frame works normally, which it would not
// for an in-page `contentDocument` query.

import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { chromium, type Browser, type Frame, type Page } from "playwright";

// --- timeouts -------------------------------------------------------------
// Every step is bounded so a hung page surfaces as a FAILED capture row with a
// clear reason, instead of a worker sitting in "capturing" and holding a
// governor slot until the reaper notices.

/** Whole-capture watchdog. */
const CAPTURE_TIMEOUT_MS = 75_000;
/** Loading the console page. */
const GOTO_TIMEOUT_MS = 25_000;
/** Waiting for the mesh iframe to appear after our Connect. */
const FRAME_TIMEOUT_MS = 20_000;
/** Waiting for MeshCentral to report a live session. */
const CONNECTED_TIMEOUT_MS = 25_000;
/**
 * How long to let the remote desktop actually paint once the session reports
 * Connected. The investigation's frame was taken "a few seconds" in; taking it
 * too early yields a black or half-drawn image, which is worse than useless for
 * a summary meant to describe what is on screen.
 */
const SETTLE_MS = 7_000;

const VIEWPORT = { width: 1440, height: 900 };

/** The mesh frame is identified by URL — it is a different origin from the app. */
const MESH_FRAME_MATCHERS = ["meshcentral", "mesh."];

export class CaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureError";
  }
}

/** Everything this process needs to take one frame. No DB, no secrets of its own. */
export interface CaptureRequest {
  /** Absolute console URL, e.g. https://spaceworker.top/console/<deviceId>. */
  consoleUrl: string;
  /** Session cookie name (the app owns that constant; passed in, never assumed). */
  cookieName: string;
  /** A session token the APP minted. Held in memory only, never logged. */
  cookieValue: string;
  /** Host the cookie is scoped to (the app's own host). */
  cookieDomain: string;
  /** True when consoleUrl is https (the cookie must then be Secure). */
  secureCookie: boolean;
  /** Absolute path to write the PNG to. The APP owns the storage layout. */
  outputPath: string;
}

export interface CaptureResult {
  ok: boolean;
  /** Present when ok is false — a stable, greppable reason. */
  failureReason?: string;
  bytes?: number;
  width?: number;
  height?: number;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new CaptureError(`timeout_waiting_for_${what}`)), ms),
    ),
  ]);
}

/**
 * Chromium launch args, kept deliberately minimal.
 *

/** Poll `page.frames()` until the MeshCentral viewer frame shows up. */
async function waitForMeshFrame(page: Page, timeoutMs = FRAME_TIMEOUT_MS): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = page
      .frames()
      .find((f: Frame) => MESH_FRAME_MATCHERS.some((needle) => f.url().includes(needle)));
    if (frame) return frame;
    await page.waitForTimeout(500);
  }
  throw new CaptureError("mesh_frame_not_found");
}

/**
 * Wait until MeshCentral's own toolbar reports a live session.
 *
 * Reads the frame's rendered TEXT rather than a specific element: the exact
 * toolbar markup is MeshCentral's to change, while Connected/Disconnected is the
 * wording a human uses to tell the states apart. "Disconnected" contains
 * "connected", so the negative case is checked first.
 */
async function waitForConnected(frame: Frame, timeoutMs = CONNECTED_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let text = "";
    try {
      text = await frame.evaluate(() => document.body?.innerText ?? "");
    } catch {
      // The frame can be mid-navigation; treat it as "not yet".
    }
    if (/connected/i.test(text) && !/disconnected/i.test(text)) return;
    await frame.waitForTimeout(500);
  }
  throw new CaptureError("mesh_session_not_connected");
}

/**
 * Enable the Input (control) toggle the way the proven sequence did — WITHOUT
 * `force`, and never fatally.
 *
 * WHY PHASE 1 TOUCHES THIS AT ALL: the confirmed frame was taken with this
 * checkbox ticked, so this preserves the proven state rather than trusting that
 * a view-only session paints the same pixels. Phase 1 itself NEVER dispatches
 * input (no mouse or keyboard event is sent anywhere in this file) — ticking the
 * box grants a capability nothing here uses.
 *
 * WHY IT IS NON-FATAL: the investigation found that forcing this check risks
 * landing a stray click on the live desktop (a context menu opened on the real
 * machine during testing). So if the box is not plainly actionable the capture
 * continues anyway: a possibly view-only frame beats no frame, and beating on
 * somebody's desktop to get one is never acceptable.
 */
async function enableInputToggle(frame: Frame): Promise<boolean> {
  try {
    const box = frame.locator("#DeskControl");
    await box.waitFor({ state: "visible", timeout: 5_000 });
    if (await box.isChecked()) return true;
    await box.check({ timeout: 5_000 }); // no `force: true` — deliberately
    return true;
  } catch {
    return false;
  }
}

/** Best-effort clean disconnect — see finding (2) in this file's header. */
async function disconnectFrame(frame: Frame): Promise<void> {
  try {
    await frame.evaluate(() => {
      const fn = (globalThis as Record<string, unknown>).cmdeskaction;
      if (typeof fn === "function") (fn as (a: number, b: null) => void)(11, null);
    });
  } catch {
    // The browser is closed immediately after; a failure here must never turn a
    // successfully captured frame into a failed row.
  }
}

/**
 * Capture one frame of one device's screen.
 *
 * Returns a result rather than throwing for the EXPECTED failure modes the task
 * doc calls out (the session never came up), so the caller records a clear
 * `failureReason`. Genuinely unexpected failures still throw; the caller turns
 * those into failed rows too, so no path can leave a row stuck in "capturing".
 *
 * The caller is responsible for everything it owns: that the device is online,
 * that a slot was granted, and that `outputPath`'s directory exists.
 */
export async function captureScreen(req: CaptureRequest): Promise<CaptureResult> {
  if (!isAbsolute(req.outputPath)) {
    // The app always sends an absolute path (it owns the storage root). A
    // relative one would be written wherever this process happens to be
    // running, which is never intended.
    throw new CaptureError("output_path_must_be_absolute");
  }

  // A holder object rather than plain locals: TypeScript cannot see assignments
  // made inside the async closure below, so locals would be narrowed to `null`
  // (and then `never`) at the cleanup site.
  const held: { browser: Browser | null; frame: Frame | null } = { browser: null, frame: null };

  const run = async (): Promise<CaptureResult> => {
    try {
      held.browser = await chromium.launch({ headless: true, args: launchArgs() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Surface the one-line fix at the point of failure (see launchArgs).
      if (/sandbox/i.test(message)) {
        throw new CaptureError(
          `chromium_sandbox: ${message} — set SCREENSHOT_CHROMIUM_NO_SANDBOX=1 for screenshot-capture.service if this host forbids unprivileged user namespaces`,
        );
      }
      throw new CaptureError(`chromium_launch_failed: ${message}`);
    }

    // A fresh, throwaway profile per capture: no stored state, nothing reused
    // between devices or between ticks.
    const context = await held.browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      storageState: undefined,
    });

    // The session cookie is set for the APP host only. The mesh frame is a
    // different origin and deliberately does not receive it.
    await context.addCookies([
      {
        name: req.cookieName,
        value: req.cookieValue,
        domain: req.cookieDomain,
        path: "/",
        httpOnly: true,
        secure: req.secureCookie,
        sameSite: "Lax",
      },
    ]);

    const page = await context.newPage();

    // 1) Our own console page, then OUR Connect button (loads the iframe only).
    await page.goto(req.consoleUrl, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });
    const ourConnect = page.getByRole("button", { name: /^connect$/i });
    await withTimeout(ourConnect.waitFor({ state: "visible" }), GOTO_TIMEOUT_MS, "our_connect");
    await ourConnect.click({ timeout: 10_000 });

    // 2) MeshCentral's OWN Connect, INSIDE the frame — without this click there
    //    is no live session (the iframe just says "Disconnected").
    held.frame = await waitForMeshFrame(page);
    const meshConnect = held.frame.getByRole("button", { name: /^connect$/i }).first();
    await withTimeout(
      meshConnect.waitFor({ state: "visible" }),
      FRAME_TIMEOUT_MS,
      "mesh_connect",
    );
    await meshConnect.click({ timeout: 10_000 });

    // 3) Wait for a genuinely live session, then let the desktop paint.
    await waitForConnected(held.frame);
    await page.waitForTimeout(SETTLE_MS);

    // 4) Match the proven state, without `force` and without caring if it fails.
    await enableInputToggle(held.frame);

    // 5) A PAGE-level screenshot, which is what the investigation proved
    //    captures the real remote desktop (icons, wallpaper, taskbar).
    await page.screenshot({ path: req.outputPath, fullPage: false, type: "png" });
    const written = await stat(req.outputPath);
    if (written.size === 0) return { ok: false, failureReason: "empty_frame" };

    return {
      ok: true,
      bytes: written.size,
      width: VIEWPORT.width,
      height: VIEWPORT.height,
    };
  };

  try {
    return await withTimeout(run(), CAPTURE_TIMEOUT_MS, "capture");
  } finally {
    // Disconnect BEFORE closing, so the mesh side sees a clean end of session
    // rather than a dropped socket. Both steps are best-effort: a failure here
    // must never mask the capture's own result.
    if (held.frame) await disconnectFrame(held.frame);
    if (held.browser) {
      try {
        await held.browser.close();
      } catch {
        // Already gone.
      }
    }
  }
}

/**
 * Chromium launch args, kept deliberately minimal.
 *
 * A headless Chromium on a host whose kernel forbids unprivileged user
 * namespaces cannot start its own sandbox and the launch fails outright. The
 * default here stays SECURE (sandbox ON); an owner who hits that error flips the
 * env var rather than editing code, and the error message says so — the fix is
 * then visible at the point of failure instead of buried in a doc.
 */
function launchArgs(): string[] {
  const args = ["--disable-dev-shm-usage"];
  if (process.env.SCREENSHOT_CHROMIUM_NO_SANDBOX === "1") args.push("--no-sandbox");
  return args;
}
