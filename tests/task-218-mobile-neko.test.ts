// TASK_218 D4 — pins for the private-browser controls follow-up (TASK_216
// regression + mobile tap-through).
//
// Owner symptoms: (1) mobile — our pad/keyboard are clickable but taps on the
// stream never reach Neko's control; (2) desktop pop-out — the Mouse &
// keyboard card "disappeared" since the 216 deploy (verdict: H5, stale tab,
// no code regression — pinned here so the unconditional mounts can't silently
// change); (3) dead-end screens must never read as "controls missing".
//
// What's unit-testable: the pure injection script's binding/dispatch contract
// (capture phase, dedup, media-over-body dispatch, no-give-up rebind), source
// pins on the pop-out bfcache guard, and the dead-end wording. Real-device
// taps/hover remain owner-acceptance manual (TASK_218 owner acceptance).

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { buildTouchInjectionScript } from "../lib/touch-controls";

const ROOT = join(__dirname, "..");

function src(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("TASK_218 — injected bridge script (D2 mobile tap-through)", () => {
  const script = buildTouchInjectionScript();

  it("binds the document root in CAPTURE phase (before Neko can stopPropagation)", () => {
    assert.ok(
      script.includes("var opts = { passive: false, capture: true };"),
      "listeners must be non-passive AND capture — bubble listeners on body never fired on mobile because Neko's own handlers stop propagation",
    );
    assert.ok(
      script.includes("install(document);"),
      "the document root binding must exist — it works before <body> or the video mount, and fires before any descendant handler",
    );
  });

  it("never dispatches synthetic mouse events at body while a media element exists", () => {
    assert.ok(
      script.includes("return best || nodes[0] || document.body;"),
      "a zero-area/late video must still win over body — events targeted at body never traverse the video subtree, so Neko's listeners on the <video> never see them",
    );
  });

  it("dedupes one touch across every bound node", () => {
    assert.ok(script.includes("function seen(e)"), "the per-event dedup helper must exist");
    assert.ok(script.includes("__swTouchSeen"), "the dedup marker must be stamped on the event");
    for (const handler of ["onStart", "onMove", "onEnd"]) {
      assert.ok(
        new RegExp(`function ${handler}\\(e\\) \\{\\s*if \\(seen\\(e\\)\\) return;`).test(script),
        `${handler} must bail when another bound node already handled the event`,
      );
    }
  });

  it("keeps re-binding the live surface past the old 10s window (late/remounted video)", () => {
    assert.ok(
      !script.includes("clearInterval(iv)"),
      "the surface watcher must not give up — mobile mounts the video after the WebRTC handshake and remounts it on rotation/resume",
    );
    assert.ok(script.includes("setInterval(function () {"), "the rebind watcher must still poll");
  });

  it("leaves Neko's own chrome (buttons/links/inputs/ARIA) native", () => {
    assert.ok(
      script.includes("function isNekoControl(t)"),
      "the native-chrome skip must exist — translating a menu tap would aim it at the remote desktop and preventDefault would swallow it",
    );
    assert.ok(
      /function onStart\(e\) \{\s*if \(seen\(e\)\) return;\s*var el = surface\(\);\s*if \(isNekoControl\(e\.target\)\) return;/.test(
        script,
      ),
      "the skip must run in onStart before any translation/preventDefault",
    );
  });

  it("keeps the TASK_216 retryability contract (regression)", () => {
    assert.ok(script.includes("if (window.__swTouchInstalled) return;"), "idempotency early-return");
    const flagAt = script.indexOf("window.__swTouchInstalled = true;");
    assert.ok(flagAt > -1);
    assert.equal(
      (script.match(/window\.__swTouchInstalled\s*=\s*true/g) ?? []).length,
      1,
      "exactly one success-marker assignment",
    );
    assert.ok(flagAt > script.indexOf("window.__swMouse = function"));
    assert.ok(flagAt > script.indexOf("window.__swKey = function"));
  });
});

describe("TASK_218 — D1 pop-out restore (H5: stale tab, mounts stay unconditional)", () => {
  const view = src("components/browser-popout-view.tsx");

  it("refreshes a tab restored from the back/forward cache", () => {
    assert.ok(view.includes('addEventListener("pageshow"'), "the pageshow listener must exist");
    assert.ok(view.includes("e.persisted"), "only bfcache restorations reload");
    assert.ok(view.includes("window.location.reload()"), "restore → one reload (stale DOM + dead WebRTC)");
  });

  it("still mounts the controller unconditionally (the owner-visible regression pin)", () => {
    assert.ok(view.includes("<RemoteViewerControls"), "the pop-out tab renders the shared controller");
    assert.match(view, /onLoad=\{installTouchControls\}/);
  });

  it("the 'Open in new tab' button still opens the wrapper route (task-212 contract)", () => {
    assert.ok(
      src("components/browser-session-panel.tsx").includes("popoutHrefFor(s.id)"),
      "never the bare Neko URL",
    );
  });
});

describe("TASK_218 — D3 dead-end honesty (H6)", () => {
  it("the pop-out dead-end names the missing controls, not just the dead session", () => {
    const page = src("app/browser-popout/[sessionId]/page.tsx");
    assert.ok(
      page.includes("keyboard controls are only available"),
      "'session has ended' alone read to the owner as missing controls — the line must connect the two",
    );
  });

  it("the embedded paused-after-pop-out placeholder still explains itself", () => {
    const panel = src("components/browser-session-panel.tsx");
    assert.ok(panel.includes("open in its own tab"), "the placeholder must say why the embedded view is paused");
    assert.ok(panel.includes("Reconnect here instead"), "the escape hatch must stay");
  });
});
