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

// ---------------------------------------------------------------------------
// TASK_212 D2 — the on-screen MOUSE controller (pure half).
//
// Owner: "you didn't add a mouse controller for the mobile". TASK_208 gave
// touch→mouse translation directly on the stream (tap/long-press/two-finger),
// but there is no way to precisely move the remote cursor, right-click on
// demand, double-click, or hold-drag — the classic VNC/TeamViewer mouse pad.
// This is that pad's logic: a virtual cursor in surface-local pixels plus the
// exact event-spec sequences each button emits into the frame via the
// `__swMouse` bridge (injected alongside `__swKey`). React-free and DOM-free
// so tests can pin every branch; the component in
// components/remote-viewer-controls.tsx is a thin renderer over it.
// ---------------------------------------------------------------------------

/** A virtual cursor position in surface-local pixel space. */
export interface PadCursor {
  x: number;
  y: number;
}

/** Surface dimensions the cursor is clamped inside. */
export interface PadBounds {
  width: number;
  height: number;
}

/**
 * How fast pad drags move the remote cursor, relative to the finger.
 * >1 because a phone trackpad is much smaller than the remote desktop — 1:1
 * makes the far corners unreachable without awkward repeated strokes.
 */
export const PAD_SPEED = 1.5;

/** One instruction the parent sends into the frame; `__swMouse` turns it into real DOM events. */
export type PadSpec =
  | { kind: "move"; dx: number; dy: number }
  | { kind: "down"; button: 0 | 2 }
  | { kind: "up"; button: 0 | 2 }
  | { kind: "wheel"; dy: number };

/** Clamp a cursor into the surface box (never negative, never past the edge, finite). */
export function clampCursor(c: PadCursor, bounds: PadBounds): PadCursor {
  const w = Number.isFinite(bounds.width) && bounds.width > 0 ? bounds.width : 0;
  const h = Number.isFinite(bounds.height) && bounds.height > 0 ? bounds.height : 0;
  return {
    x: Math.min(Math.max(Number.isFinite(c.x) ? c.x : 0, 0), w),
    y: Math.min(Math.max(Number.isFinite(c.y) ? c.y : 0, 0), h),
  };
}

/** Relative pad drag → a scaled, clamped move spec list. */
export function padMoveSpecs(dx: number, dy: number): PadSpec[] {
  const sx = (Number.isFinite(dx) ? dx : 0) * PAD_SPEED;
  const sy = (Number.isFinite(dy) ? dy : 0) * PAD_SPEED;
  if (sx === 0 && sy === 0) return [];
  return [{ kind: "move", dx: sx, dy: sy }];
}

/** Left/right click = down then up on the same button, at the current cursor. */
export function padClickSpecs(button: 0 | 2): PadSpec[] {
  return [
    { kind: "down", button },
    { kind: "up", button },
  ];
}

/** Double-click = two left clicks back to back (the frame debounces nothing; browsers expect this shape). */
export function padDoubleClickSpecs(): PadSpec[] {
  return [...padClickSpecs(0), ...padClickSpecs(0)];
}

/**
 * Drag toggle: press = left button down, release = left button up. While
 * engaged, pad moves keep the button held, so sliding drags windows/marquees
 * exactly like a real mouse button being held while moving.
 */
export function padDragSpecs(pressed: boolean): PadSpec[] {
  return [{ kind: pressed ? "down" : "up", button: 0 }];
}

/** Scroll buttons: a wheel notch up (negative dy) or down (positive dy). */
export function padScrollSpecs(direction: -1 | 1): PadSpec[] {
  const dy = direction * 120; // one conventional wheel notch in deltaMode=0 pixels
  return [{ kind: "wheel", dy }];
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
    // Idempotency guard. TASK_216: the flag used to be SET here, before any of
    // the work below — so a single mid-script throw (outer catch swallows it)
    // left the realm permanently "installed" with a dead/half-defined bridge
    // and every retry skipped (owner: embedded controls never worked). Now the
    // flag is only assigned AFTER everything installed successfully, so a
    // failed install stays retryable; the parent re-injects via
    // ensureTouchControls (components/remote-viewer-controls.tsx).
    if (window.__swTouchInstalled) return;

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

    // TASK_212 D2 — mouse bridge. The parent's on-screen pad calls
    // window.__swMouse(spec) with {kind:"move"|"down"|"up"|"wheel", ...}.
    // The virtual cursor lives HERE (realm-local, clamped to the surface), so
    // the parent never needs surface geometry — it only sends relative deltas
    // and button commands. Same defensive posture as __swKey.
    var swCur = null; // {x, y} in surface-local px; created lazily at centre
    function swEnsureCur(el) {
      var r = el.getBoundingClientRect();
      if (!swCur) swCur = { x: (r.width || 0) / 2, y: (r.height || 0) / 2 };
      var w = r.width || 0, h = r.height || 0;
      swCur.x = Math.min(Math.max(isFinite(swCur.x) ? swCur.x : 0, 0), w);
      swCur.y = Math.min(Math.max(isFinite(swCur.y) ? swCur.y : 0, 0), h);
      return swCur;
    }
    window.__swMouse = function (spec) {
      try {
        if (!spec || typeof spec !== "object") return;
        var el = surface();
        var cur = swEnsureCur(el);
        if (spec.kind === "move") {
          var r = el.getBoundingClientRect();
          cur.x = Math.min(Math.max(cur.x + (spec.dx || 0), 0), r.width || 0);
          cur.y = Math.min(Math.max(cur.y + (spec.dy || 0), 0), r.height || 0);
          fire(el, "mousemove", cur.x, cur.y, 0);
        } else if (spec.kind === "down" || spec.kind === "up") {
          var b = spec.button === 2 ? 2 : 0;
          fire(el, spec.kind === "down" ? "mousedown" : "mouseup", cur.x, cur.y, b);
        } else if (spec.kind === "wheel") {
          wheel(el, 0, spec.dy || 0);
        }
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
    // TASK_216 — success marker LAST: everything above defines the bridges and
    // binds the listeners, so reaching this line is the only proof the install
    // actually completed. (See the guard comment at the top of this script.)
    window.__swTouchInstalled = true;
  } catch (err) { /* never break the embed */ }
})();`;
}

