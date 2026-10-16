import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TAP_SLOP_PX,
  TAP_MAX_MS,
  LONG_PRESS_MS,
  classifyGesture,
  mapTouchToLocal,
  distance,
  buildTouchInjectionScript,
  toggleMod,
  noMods,
  MOD_KEYS,
} from "../lib/touch-controls";

// classifyGesture — pin every branch (pure, no DOM).
test("classifyGesture: a quick, near-stationary touch is a tap", () => {
  assert.equal(classifyGesture({ elapsedMs: 120, maxMovePx: 2 }), "tap");
});

test("classifyGesture: any movement beyond the slop is a drag, however fast", () => {
  assert.equal(classifyGesture({ elapsedMs: 40, maxMovePx: TAP_SLOP_PX + 1 }), "drag");
});

test("classifyGesture: a long stationary hold is a longpress (right-click)", () => {
  assert.equal(classifyGesture({ elapsedMs: LONG_PRESS_MS + 100, maxMovePx: 0 }), "longpress");
});

test("classifyGesture: a stationary hold between tap and long-press falls back to tap", () => {
  // Between TAP_MAX_MS and LONG_PRESS_MS, no movement — not a drag, not yet a
  // long-press. Tap is the least surprising emit.
  const mid = (TAP_MAX_MS + LONG_PRESS_MS) / 2;
  assert.equal(classifyGesture({ elapsedMs: mid, maxMovePx: 0 }), "tap");
});

test("classifyGesture: exactly at the tap ceiling is still a tap", () => {
  assert.equal(classifyGesture({ elapsedMs: TAP_MAX_MS, maxMovePx: 0 }), "tap");
});

test("classifyGesture: movement wins over a long elapsed time (drag, not longpress)", () => {
  assert.equal(classifyGesture({ elapsedMs: 900, maxMovePx: 50 }), "drag");
});

// mapTouchToLocal — clamping to the element box.
test("mapTouchToLocal: maps a touch inside the box to local pixel space", () => {
  assert.deepEqual(mapTouchToLocal(150, 80, { left: 100, top: 50, width: 400, height: 300 }), {
    x: 50,
    y: 30,
  });
});

test("mapTouchToLocal: clamps a touch left/above the box to 0", () => {
  assert.deepEqual(mapTouchToLocal(10, 5, { left: 100, top: 50, width: 400, height: 300 }), {
    x: 0,
    y: 0,
  });
});

test("mapTouchToLocal: clamps a touch past the box to its far edge (never negative/NaN)", () => {
  assert.deepEqual(mapTouchToLocal(9999, 9999, { left: 100, top: 50, width: 400, height: 300 }), {
    x: 400,
    y: 300,
  });
});

test("mapTouchToLocal: never emits NaN for a degenerate zero-size rect", () => {
  const p = mapTouchToLocal(50, 50, { left: 0, top: 0, width: 0, height: 0 });
  assert.equal(Number.isFinite(p.x), true);
  assert.equal(Number.isFinite(p.y), true);
});

// distance — pure helper used by the gesture path.
test("distance: computes Euclidean distance between two points", () => {
  assert.equal(distance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
});

// buildTouchInjectionScript — the injected IIFE must be self-contained and
// defensive. Assert the structural markers that keep it safe, not the whole blob.
test("buildTouchInjectionScript: is a self-contained IIFE with no outer-scope refs", () => {
  const src = buildTouchInjectionScript();
  assert.ok(src.includes("(() => {"), "wrapped in an IIFE");
  assert.ok(src.includes("try {"), "defensive try/catch");
  assert.ok(src.includes("__swTouchInstalled"), "idempotence guard");
});

// Sticky-modifier helpers (S2 keyboard bar).
test("toggleMod: flips exactly one modifier and returns a NEW object", () => {
  const start = { ctrl: false, alt: false, shift: false };
  const next = toggleMod(start, "ctrl");
  assert.deepEqual(next, { ctrl: true, alt: false, shift: false });
  assert.notEqual(next, start, "returns a new object (React-safe, no mutation)");
  assert.deepEqual(start, { ctrl: false, alt: false, shift: false }, "input untouched");
});

test("toggleMod: modifiers are independent", () => {
  let m = { ctrl: false, alt: false, shift: false };
  m = toggleMod(m, "ctrl");
  m = toggleMod(m, "shift");
  assert.deepEqual(m, { ctrl: true, alt: false, shift: true });
  m = toggleMod(m, "ctrl"); // release one, the other stays
  assert.deepEqual(m, { ctrl: false, alt: false, shift: true });
});

test("noMods: true only when every modifier is off", () => {
  assert.equal(noMods({ ctrl: false, alt: false, shift: false }), true);
  assert.equal(noMods({ ctrl: true, alt: false, shift: false }), false);
  assert.equal(noMods({ ctrl: false, alt: false, shift: true }), false);
});

test("MOD_KEYS: exactly the three sticky modifiers", () => {
  assert.deepEqual([...MOD_KEYS], ["ctrl", "alt", "shift"]);
});

test("buildTouchInjectionScript: synthesises the mouse events Neko understands", () => {
  const src = buildTouchInjectionScript();
  for (const type of ["mousedown", "mousemove", "mouseup", "wheel", "keydown", "keyup"]) {
    assert.ok(src.includes(type), `emits ${type}`);
  }
});

test("buildTouchInjectionScript: bakes in the tuned thresholds", () => {
  const src = buildTouchInjectionScript();
  assert.ok(src.includes(String(TAP_SLOP_PX)), "tap slop");
  assert.ok(src.includes(String(LONG_PRESS_MS)), "long-press ms");
});
