import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { idleChipLabel, idleReadProvenanceFrom, type IdleChipDevice } from "../lib/device-idle";

// TASK_170 — mobile responsiveness of the device remote control + link inputs.
//
// WHY THIS FILE EXISTS: the owner's report was "the device remote control
// doesn't show the mesh console at all, it just shows a blue modal covering
// the screen" on mobile. The fix is layout/CSS only (same tabs, same tools,
// stacked/scrolling — never a forked mobile view, desktop pixel-unchanged),
// so the regression test asserts on the REAL component source: the class
// strings that admit small viewports must be present, and the fixed-pixel
// classes that forced sideways overflow must be gone (or demoted to sm: and
// up). A screenshot at 390px is the live proof; this pins the classes so a
// later edit can't silently reintroduce the overflow.

const HERE = dirname(fileURLToPath(import.meta.url));
const CONSOLE_SRC = readFileSync(join(HERE, "..", "components", "device-console.tsx"), "utf8");
const PANEL_SRC = readFileSync(join(HERE, "..", "components", "hosting-panel.tsx"), "utf8");

test("TASK_170: the remote iframe admits small viewports (dvh base, 480px only on sm+)", () => {
  assert.ok(
    CONSOLE_SRC.includes('"h-[70dvh] sm:h-[480px]"'),
    "embedded iframe must be viewport-relative below sm, 480px only on sm and up",
  );
  assert.ok(
    !CONSOLE_SRC.includes(': "h-[480px]"'),
    "the bare fixed-pixel iframe height must be gone",
  );
});

test("TASK_170: the toolbox dropdown cannot clip off the right edge on mobile", () => {
  assert.ok(
    CONSOLE_SRC.includes("max-sm:left-auto max-sm:right-0"),
    "toolbox panel must open right-aligned below sm",
  );
  assert.ok(
    CONSOLE_SRC.includes("max-w-[calc(100vw-2rem)]"),
    "toolbox panel must admit the viewport width",
  );
});

test("TASK_170: the launcher palette respects safe areas and scrolls on short screens", () => {
  assert.ok(
    CONSOLE_SRC.includes("overflow-y-auto bg-black/50"),
    "launcher backdrop must scroll instead of clipping on short viewports",
  );
  assert.ok(
    CONSOLE_SRC.includes("env(safe-area-inset-top)"),
    "launcher must clear the notch/status-bar area",
  );
});

test("TASK_170: no overlay renders over an active session on load or tab switch", () => {
  // Both overlays are state-gated: the launcher palette only on an explicit
  // user action, the toolbox backdrop only while its menu is open. Neither
  // may be tied to `mesh` (session exists) or to `tab` (tab selected).
  const launcherGate = CONSOLE_SRC.match(/\{launcherOpen && \([\s\S]{0,400}?fixed inset-0/);
  assert.ok(launcherGate, "launcher overlay must be gated on launcherOpen only");
  assert.ok(
    !CONSOLE_SRC.includes("mesh && launcherOpen") && !CONSOLE_SRC.includes("tab === \"control\" && launcherOpen"),
    "launcher must never auto-open from session/tab state",
  );
  const toolboxGate = CONSOLE_SRC.match(/\{open && \(\s*<>\s*<div className="fixed inset-0 z-10"/);
  assert.ok(toolboxGate, "toolbox backdrop must be gated on its own open state");
});

test("TASK_170: hosting link/domain inputs are fluid below sm (no fixed w-*)", () => {
  for (const fixed of ["w-72 rounded", "w-40 rounded", '"w-64 rounded']) {
    assert.ok(
      !PANEL_SRC.includes(`className="${fixed}`),
      `fixed-width input must be gone: ${fixed}`,
    );
  }
  assert.ok(PANEL_SRC.includes("sm:w-72"), "desktop widths return on sm and up");
  assert.ok(PANEL_SRC.includes("sm:w-40"), "desktop widths return on sm and up");
});


// TASK_154 N2 — the client chip must never render a CONNECTED device as a bare
// status word.
//
// WHY THIS FILE EXISTS: both the Devices list (components/device-list.tsx) and
// the console header (components/device-console.tsx) hand-rolled the same chip
// and BOTH deleted the idle text when `/api/devices` sent `idleSeconds: null`:
//
//     if (d.idleSeconds === null) return statusWord(d.status);   // bare "online"
//
// A bare "online" is indistinguishable from "online · active now", so a single
// MeshCentral hiccup (the bulk idle read fails, every row blanks for one poll)
// made an idle machine read as ACTIVE — the owner's "it shows, and then it goes
// away, even if the user is still idle". The fix is ONE helper both surfaces call
// (`idleChipLabel`) that LATCHES the last positive reading, ages it out against
// the SERVER's offline window, and otherwise says "activity unknown" rather than
// a bare status. This exercises the REAL helper — not a copy.

const now = Date.parse("2026-10-01T12:00:00.000Z");
const isoAgoMin = (m: number) => new Date(now - m * 60_000).toISOString();
const dev = (over: Partial<IdleChipDevice>): IdleChipDevice => ({
  id: "dev-default",
  name: "Dev",
  status: "online",
  lastSeenAt: isoAgoMin(0),
  idleSeconds: null,
  ...over,
});

test("N2: an idle reading survives a hiccup (null does NOT demote to bare 'online')", () => {
  assert.equal(idleChipLabel(dev({ id: "hold", idleSeconds: 720 }), { nowMs: now }), "online · idle 12 min");
  // poll 2 — the mesh hiccup: server says "unknown" (idleSeconds null).
  assert.equal(
    idleChipLabel(dev({ id: "hold", idleSeconds: null }), { nowMs: now + 20_000, readState: "unknown" }),
    "online · idle 12 min",
  );
  // poll 3 — a real reading again.
  assert.equal(idleChipLabel(dev({ id: "hold", idleSeconds: 720 }), { nowMs: now + 40_000 }), "online · idle 12 min");
});

test("N2: the latch CLEARS on a positively-active reading (< 60s)", () => {
  assert.equal(idleChipLabel(dev({ id: "clear", idleSeconds: 720 }), { nowMs: now }), "online · idle 12 min");
  // a genuine activity reading switches the chip immediately …
  assert.equal(idleChipLabel(dev({ id: "clear", idleSeconds: 20 }), { nowMs: now + 20_000 }), "online · active now");
  // … and having cleared, a later hiccup is honestly "unknown", not the old value.
  assert.equal(
    idleChipLabel(dev({ id: "clear", idleSeconds: null }), { nowMs: now + 40_000, readState: "unknown" }),
    "online · activity unknown",
  );
});

test("N2: 60s exactly is IDLE (boundary matches formatIdle), 59s is ACTIVE", () => {
  assert.equal(idleChipLabel(dev({ id: "b60", idleSeconds: 60 }), { nowMs: now }), "online · idle 1 min");
  assert.equal(idleChipLabel(dev({ id: "b59", idleSeconds: 59 }), { nowMs: now }), "online · active now");
});

test("N2: cold + unknown degrades HONESTLY — never a guessed 'active'", () => {
  assert.equal(
    idleChipLabel(dev({ id: "cold", idleSeconds: null }), { nowMs: now, readState: "unknown" }),
    "online · activity unknown",
  );
});

test("N2: a STALE reading older than the SERVER's window → R3 owns it", () => {
  const windowMs = 10 * 60_000;
  assert.equal(
    idleChipLabel(dev({ id: "age", idleSeconds: 720, lastSeenAt: isoAgoMin(11) }), {
      nowMs: now,
      onlineWindowMs: windowMs,
      readState: "stale",
      readAsOf: isoAgoMin(11),
    }),
    "offline · last seen 11 min ago",
  );
  // 9 minutes old is still inside the window: keep showing the reading.
  assert.equal(
    idleChipLabel(dev({ id: "age2", idleSeconds: 720 }), {
      nowMs: now,
      onlineWindowMs: windowMs,
      readState: "stale",
      readAsOf: isoAgoMin(9),
    }),
    "online · idle 12 min",
  );
});

test("N2: a LATCHED reading also ages out (a sustained outage cannot freeze forever)", () => {
  const windowMs = 10 * 60_000;
  // Seed a fresh reading at t0 (observed "now").
  assert.equal(
    idleChipLabel(dev({ id: "sust", idleSeconds: 720 }), { nowMs: now, onlineWindowMs: windowMs }),
    "online · idle 12 min",
  );
  // 11 minutes later, still no fresh reading: the latch itself is now older than
  // the window, so it is retired and R3 owns the device.
  assert.equal(
    idleChipLabel(dev({ id: "sust", idleSeconds: null, lastSeenAt: new Date(now).toISOString() }), {
      nowMs: now + 11 * 60_000,
      onlineWindowMs: windowMs,
    }),
    "offline · last seen 11 min ago",
  );
});

test("N2: R3 — an offline device is 'offline · last seen …'; the latch never applies", () => {
  assert.equal(
    idleChipLabel(dev({ id: "off", status: "offline", idleSeconds: null, lastSeenAt: isoAgoMin(30) }), { nowMs: now }),
    "offline · last seen 30 min ago",
  );
  // even a stale idle number attached to an offline device never shows idle.
  assert.equal(
    idleChipLabel(dev({ id: "off2", status: "offline", idleSeconds: 720, lastSeenAt: isoAgoMin(30) }), { nowMs: now }),
    "offline · last seen 30 min ago",
  );
});

test("N2: no path prints a bare status for a CONNECTED device", () => {
  for (const d of [
    dev({ id: "p1", status: "online", idleSeconds: 104 }),
    dev({ id: "p2", status: "online", idleSeconds: null }),
    dev({ id: "p3", status: "asleep", idleSeconds: null }),
  ]) {
    const label = idleChipLabel(d, { nowMs: now });
    assert.ok(label.includes("·"), `connected device must never be a bare status, got: "${label}"`);
    assert.notEqual(label, "online");
    assert.notEqual(label, "asleep");
  }
});

test("N2: distinct devices keep distinct latches", () => {
  assert.equal(idleChipLabel(dev({ id: "a1", idleSeconds: 720 }), { nowMs: now }), "online · idle 12 min");
  assert.equal(idleChipLabel(dev({ id: "b1", idleSeconds: null }), { nowMs: now }), "online · activity unknown");
});

test("N2: idleReadProvenanceFrom reads the always-on provenance, tolerating junk", () => {
  assert.deepEqual(
    idleReadProvenanceFrom({ onlineWindowMs: 600000, idle: { state: "stale", asOf: isoAgoMin(1) } }),
    { onlineWindowMs: 600000, state: "stale", asOf: isoAgoMin(1) },
  );
  assert.deepEqual(idleReadProvenanceFrom({}), { onlineWindowMs: null, state: "unknown", asOf: null });
  assert.deepEqual(idleReadProvenanceFrom(null), { onlineWindowMs: null, state: "unknown", asOf: null });
  assert.deepEqual(idleReadProvenanceFrom({ onlineWindowMs: "nope", idle: { state: "bogus", asOf: 5 } }), {
    onlineWindowMs: null,
    state: "unknown",
    asOf: null,
  });
});
