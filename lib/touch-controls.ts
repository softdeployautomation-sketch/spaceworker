// TASK_208 — touch → mouse/keyboard translation for the private browser (and,
// later, the MeshCentral console — TASK_207). The private-browser viewer (Neko)
// is a same-origin iframe (served via the /browser/<id>/ proxy — see
// lib/browser-session-serialize.ts), so we can install these handlers directly
// into its document. On mobile there is no pointer: one finger currently just
// moves the remote cursor and the OS keyboard never reaches the remote app.
// This module turns touch into real mouse events and exposes a keyboard bridge.
//
// Split into (a) PURE, unit-testable gesture logic + coordinate mapping, and
// (b) a self-contained injection script that runs inside the iframe and wires
// the pure logic to real DOM events. The pure half is what
// tests/agent-touch-controls.test.ts exercises; the injected half is defensive
// (try/catch, best-effort) and degrades to Neko's default if the DOM changes.

/** Semantic gesture a touch sequence resolves to. */
export type GestureKind = "none" | "tap" | "drag" | "longpress";

export interface Point {
  x: number;
  y: number;
}

/** A touch/click target's on-screen box, used to normalise coordinates. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

// Thresholds (px / ms) that separate a tap from a drag from a long-press.
// Tuned for a phone: a tap is a quick, near-stationary touch; a drag moves
// beyond TAP_SLOP_PX; a long-press is a stationary hold past LONG_PRESS_MS
// (used for right-click).
export const TAP_SLOP_PX = 10;
export const TAP_MAX_MS = 350;
export const LONG_PRESS_MS = 550;

/**
 * Classify a finished touch from its start and end samples. Pure — no DOM —
 * so tests can pin every branch. `elapsedMs` is end−start; `maxMovePx` is the
 * largest distance the touch travelled from its start point at any sample.
 */
export function classifyGesture(opts: {
  elapsedMs: number;
  maxMovePx: number;
}): GestureKind {
  const { elapsedMs, maxMovePx } = opts;
  if (maxMovePx > TAP_SLOP_PX) return "drag";
  if (elapsedMs >= LONG_PRESS_MS) return "longpress";
  if (elapsedMs <= TAP_MAX_MS) return "tap";
  // Stationary but held between TAP_MAX_MS and LONG_PRESS_MS — a press that
  // didn't become a long-press; a tap is the least surprising emit.
  return "tap";
}

/**
 * Map a touch's viewport coordinates onto the target element's LOCAL pixel
 * space (0..width / 0..height), clamped to the box. Neko measures mouse events
 * against the video element, so we hand it coordinates in that same space.
 * Clamped so an off-box touch can never produce NaN/out-of-range that would
 * throw inside the remote client.
 */
export function mapTouchToLocal(clientX: number, clientY: number, rect: Rect): Point {
  const x = Math.min(Math.max(clientX - rect.left, 0), rect.width);
  const y = Math.min(Math.max(clientY - rect.top, 0), rect.height);
  return { x, y };
}

/** Distance between two points (for the pure classify path and tests). */
export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Sticky modifier state for the on-screen keyboard bar (S2). The bar holds
 * Ctrl/Alt/Shift "down" across multiple keypresses (Ctrl+C, Ctrl+Shift+T, …)
 * until the user taps the modifier again — the classic VNC behaviour. Pure so
 * the toggle semantics are unit-testable; the React bar just renders it.
 */
export interface Mods {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export const MOD_KEYS: ReadonlyArray<keyof Mods> = ["ctrl", "alt", "shift"] as const;

/** Toggle one modifier; returns a NEW object (no mutation — React-safe). */
export function toggleMod(mods: Mods, key: keyof Mods): Mods {
  return { ...mods, [key]: !mods[key] };
}

/** True when every modifier is off (used to auto-clear the bar's active state). */
export function noMods(mods: Mods): boolean {
  return !mods.ctrl && !mods.alt && !mods.shift;
}


/**
 * The JavaScript injected into the same-origin iframe. A self-contained IIFE:
 * it polls briefly for Neko's video/canvas surface, then installs touch handlers
 * that synthesise mouse events Neko already understands (so drag/tap/right-click
 * and wheel-scroll all work), plus a tiny keyboard bridge the parent can call.
 * Entirely wrapped defensively — if Neko's DOM changes, nothing here can break
 * the embed because every handler is try/catch and every lookup is optional.
 *
 * This is a STRING because it is injected via a <script> node into the iframe's
 * contentDocument and must run entirely in that realm. It intentionally
 * references no outer-scope variables.
 */
export function buildTouchInjectionScript(): string {
  return `(() => {
  try {
    if (window.__swTouchInstalled) return;
    window.__swTouchInstalled = true;

    var SLOP = ${TAP_SLOP_PX};
    var LONG_MS = ${LONG_PRESS_MS};

    // Neko renders the remote stream into a <video> (WebRTC) or <canvas>.
    // Prefer the largest such surface; fall back to body so touch still lands.
    function surface() {
      var nodes = document.querySelectorAll("video, canvas");
      var best = null, bestArea = 0;
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        var a = (n.clientWidth || 0) * (n.clientHeight || 0);
        if (a > bestArea) { bestArea = a; best = n; }
      }
      return best || document.body;
    }

    function fire(el, type, x, y, button) {
      var r = (el === document.body ? { left: 0, top: 0 } : el.getBoundingClientRect());
      var ev = new MouseEvent(type, {
        bubbles: true, cancelable: true, view: window,
        clientX: r.left + x, clientY: r.top + y,
        screenX: r.left + x, screenY: r.top + y,
        button: button || 0, buttons: type === "mouseup" ? 0 : (button === 2 ? 2 : 1)
      });
      el.dispatchEvent(ev);
    }

    function wheel(el, dx, dy) {
      var r = el.getBoundingClientRect();
      el.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true, cancelable: true, view: window,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
        deltaX: dx, deltaY: dy
      }));
    }

    function local(el, t) {
      var r = el.getBoundingClientRect();
      return {
        x: Math.min(Math.max(t.clientX - r.left, 0), r.width),
        y: Math.min(Math.max(t.clientY - r.top, 0), r.height)
      };
    }

    var start = null, moved = false, longTimer = null, firedLong = false;
    var twoFinger = false, lastMidY = null;

    function onStart(e) {
      var el = surface();
      if (e.touches.length >= 2) {
        twoFinger = true; firedLong = false; if (longTimer) clearTimeout(longTimer);
        lastMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        return;
      }
      var t = e.touches[0]; if (!t) return;
      var p = local(el, t);
      start = { el: el, p: p, t: Date.now() }; moved = false; firedLong = false;
      fire(el, "mousedown", p.x, p.y, 0);
      if (longTimer) clearTimeout(longTimer);
      longTimer = setTimeout(function () {
        if (start && !moved) { firedLong = true; fire(el, "mouseup", start.p.x, start.p.y, 0); fire(el, "mousedown", start.p.x, start.p.y, 2); }
      }, LONG_MS);
      e.preventDefault();
    }

    function onMove(e) {
      if (!start) return;
      if (twoFinger && e.touches.length >= 2) {
        var midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        var dy = lastMidY == null ? 0 : lastMidY - midY; lastMidY = midY;
        wheel(surface(), 0, dy); e.preventDefault(); return;
      }
      var t = e.touches[0]; if (!t) return;
      var el = start.el; var p = local(el, t);
      if (Math.hypot(p.x - start.p.x, p.y - start.p.y) > SLOP) moved = true;
      fire(el, "mousemove", p.x, p.y, 0);
      e.preventDefault();
    }

    function onEnd(e) {
      if (twoFinger) { if (e.touches.length < 2) { twoFinger = false; lastMidY = null; } return; }
      if (!start) return;
      var el = start.el, p = start.p;
      if (longTimer) clearTimeout(longTimer);
      if (firedLong) { fire(el, "mouseup", p.x, p.y, 2); }
      else { fire(el, "mouseup", p.x, p.y, 0); }
      start = null;
      if (e.cancelable) e.preventDefault();
    }

    function install(el) {
      if (!el || el.__swTouchBound) return;
      el.__swTouchBound = true;
      var opts = { passive: false };
      el.addEventListener("touchstart", onStart, opts);
      el.addEventListener("touchmove", onMove, opts);
      el.addEventListener("touchend", onEnd, opts);
      el.addEventListener("touchcancel", onEnd, opts);
    }

    // Keyboard bridge: the parent calls window.__swKey(key, down, mods) to send
    // a keydown/keyup into this document (Neko listens on the focused element /
    // document). Kept tiny and realm-local.
    window.__swKey = function (key, down, mods) {
      try {
        var target = document.activeElement || document.body;
        var ev = new KeyboardEvent(down ? "keydown" : "keyup", {
          key: key, bubbles: true, cancelable: true, view: window,
          ctrlKey: !!(mods && mods.ctrl), altKey: !!(mods && mods.alt),
          shiftKey: !!(mods && mods.shift), metaKey: !!(mods && mods.meta)
        });
        target.dispatchEvent(ev);
      } catch (err) { /* best-effort */ }
    };

    // Neko mounts its surface after the WebRTC handshake, so poll briefly.
    var tries = 0;
    var iv = setInterval(function () {
      var el = surface();
      if (el && el !== document.body) { install(el); }
      if (++tries > 40) clearInterval(iv);
    }, 250);
    install(document.body);
  } catch (err) { /* never break the embed */ }
})();`;
}

