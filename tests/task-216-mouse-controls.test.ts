// TASK_216 D4 — pins for the private-browser mouse fixes (TASK_212 fallout).
//
// Owner symptoms: (a) desktop — the mouse toggle "disappears when the mouse
// approaches it" (the old `pointer: coarse` gate UNMOUNTED the whole
// controller when the primary pointer flipped to a mouse, and plain desktop
// pop-out tabs had zero controls at all); (b) mobile — taps unresponsive /
// "embedded never worked" (the injected script set its `__swTouchInstalled`
// guard flag BEFORE doing the work, so one mid-script throw bricked the
// bridge permanently and every retry — gated on the script element id alone —
// was skipped); (c) a drag stroke released outside the pad left the remote
// button stuck down (no pointer capture).
//
// What's unit-testable here: the pure injection script's guard ordering, and
// source pins on the component fixes. Hover/feel is owner-acceptance manual
// (TASK_216 §Owner acceptance).

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { buildTouchInjectionScript } from "../lib/touch-controls";

const ROOT = join(__dirname, "..");

function src(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("TASK_216 — injected bridge script (lib/touch-controls.ts)", () => {
  const script = buildTouchInjectionScript();

  it("keeps the in-realm idempotency early-return", () => {
    assert.ok(
      script.includes("if (window.__swTouchInstalled) return;"),
      "the script must still skip a realm that is already fully installed",
    );
  });

  it("sets the success flag only AFTER the bridges are defined (retryable installs)", () => {
    const flagAt = script.indexOf("window.__swTouchInstalled = true;");
    assert.ok(flagAt > -1, "the success flag must be assigned somewhere");
    const mouseAt = script.indexOf("window.__swMouse = function");
    const keyAt = script.indexOf("window.__swKey = function");
    assert.ok(mouseAt > -1, "__swMouse bridge must be defined");
    assert.ok(keyAt > -1, "__swKey bridge must be defined");
    assert.ok(flagAt > mouseAt, "__swTouchInstalled must be set AFTER __swMouse — a mid-script throw must leave the realm retryable (the TASK_212 order bricked the bridge forever)");
    assert.ok(flagAt > keyAt, "__swTouchInstalled must be set AFTER __swKey — same retryability rule");
  });

  it("assigns the success flag exactly once (no early optimistic set)", () => {
    const assignments = script.match(/window\.__swTouchInstalled\s*=\s*true/g) ?? [];
    assert.equal(assignments.length, 1, "exactly one success-marker assignment");
  });

  it("exposes every pad command kind the controller sends", () => {
    for (const kind of ["move", "down", "up", "wheel"]) {
      assert.ok(
        script.includes(`spec.kind === "${kind}"`),
        `__swMouse must handle the "${kind}" kind (pad spec shape from lib/touch-controls.ts)`,
      );
    }
  });
});

describe("TASK_216 — controller component (components/remote-viewer-controls.tsx)", () => {
  const component = src("components/remote-viewer-controls.tsx");

  it("no longer unmounts on desktop (the touchUi gate is gone)", () => {
    assert.ok(
      !/if\s*\(\s*!touchUi\s*\)\s*return null/.test(component),
      "the `if (!touchUi) return null` gate unmounted the toggle whenever the primary pointer flipped to a mouse — the owner's 'toggle disappears on approach'",
    );
    assert.ok(
      !component.includes("useTouchUi"),
      "the pointer:coarse detector must be gone with the gate — the controller is always rendered (collapsed)",
    );
  });

  it("heals a missing/partial bridge install instead of silently dropping input", () => {
    assert.ok(component.includes("export function ensureTouchControls"), "the installer must be exported as ensureTouchControls (heal path)");
    assert.ok(
      component.includes("__swTouchInstalled"),
      "ensureTouchControls must consult the realm-side SUCCESS flag, not just the script element id",
    );
    assert.ok(
      component.includes("existing.remove()"),
      "a partial install (element present, success flag unset) must be removed and re-injected",
    );
    assert.ok(
      component.includes("ensureTouchControls(frame)"),
      "sendSpecs/sendKey must call the heal path when the bridge is missing",
    );
  });

  it("captures the pad pointer so a stroke can't get stuck down", () => {
    assert.ok(component.includes("setPointerCapture"), "onPadDown must capture the pointer (release outside the pad used to leave the remote button held)");
    assert.ok(component.includes("releasePointerCapture"), "onPadUp must release the captured pointer");
  });

  it("taps the collapse toggle without double-tap-zoom/300ms delays", () => {
    assert.ok(
      component.includes("touch-manipulation"),
      "the toggle must set touch-action: manipulation so a mobile tap is a plain click",
    );
  });
});

describe("TASK_216 — both surfaces still wire the shared installer", () => {
  it("embedded panel iframe", () => {
    assert.ok(
      src("components/browser-session-panel.tsx").includes("onLoad={installTouchControls}"),
      "the embedded Neko iframe must keep onLoad={installTouchControls}",
    );
  });

  it("pop-out tab iframe", () => {
    assert.ok(
      src("components/browser-popout-view.tsx").includes("onLoad={installTouchControls}"),
      "the pop-out Neko iframe must keep onLoad={installTouchControls}",
    );
  });
});
