import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { isSameOriginConnectUrl, popoutHrefFor } from "../lib/browser-popout";
import {
  PAD_SPEED,
  buildTouchInjectionScript,
  clampCursor,
  padClickSpecs,
  padDoubleClickSpecs,
  padDragSpecs,
  padMoveSpecs,
  padScrollSpecs,
} from "../lib/touch-controls";

// TASK_212 — binding gate §6: pop-out target builder (wrapper route +
// same-origin guard), D2 mouse-pad gesture thresholds, and the orientation/
// layout contract for full-screen. Style follows the two existing precedents:
// pure assertions for the pure logic (tests/agent-touch-controls.test.ts) and
// readFileSync source-contract pins for anything that only exists as JSX props
// across render trees (tests/console-mesh-scope.test.ts) — the layout facts
// can't be behavioural-tested without a browser, but they MUST not regress
// silently back to a fixed-height calc. A refactor that moves these contract
// strings must touch this file knowingly.

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

// ---------------------------------------------------------------------------
// D3 — pop-out target builder: href shape + same-origin guard (pure).
// ---------------------------------------------------------------------------

test("popoutHrefFor: points at the wrapper route, never the raw stream URL", () => {
  assert.equal(popoutHrefFor("sess-1"), "/browser-popout/sess-1");
});

test("popoutHrefFor: percent-encodes the id so metacharacters can't alter the path", () => {
  assert.equal(popoutHrefFor("a/b?c#d"), "/browser-popout/a%2Fb%3Fc%23d");
});

test("isSameOriginConnectUrl: accepts a connectUrl minted from our own origin", () => {
  assert.equal(
    isSameOriginConnectUrl("https://app.test/browser/abc", "https://app.test"),
    true,
  );
});

test("isSameOriginConnectUrl: refuses a different host — injection would silently die there", () => {
  assert.equal(
    isSameOriginConnectUrl("https://evil.test/browser/abc", "https://app.test"),
    false,
  );
});

test("isSameOriginConnectUrl: scheme and port are part of the origin", () => {
  assert.equal(
    isSameOriginConnectUrl("http://app.test/x", "https://app.test"),
    false,
    "http vs https is a different origin",
  );
  assert.equal(
    isSameOriginConnectUrl("https://app.test:8443/x", "https://app.test"),
    false,
    "an explicit different port is a different origin",
  );
  assert.equal(
    isSameOriginConnectUrl("https://app.test:443/x", "https://app.test"),
    true,
    "the default port normalises away (URL semantics)",
  );
});

test("isSameOriginConnectUrl: unparseable input is refused, never embedded blind", () => {
  assert.equal(isSameOriginConnectUrl("", "https://app.test"), false);
  assert.equal(isSameOriginConnectUrl("not a url", "https://app.test"), false);
  assert.equal(
    isSameOriginConnectUrl("/relative/path", "https://app.test"),
    false,
    "a relative string has no origin to compare",
  );
  assert.equal(isSameOriginConnectUrl("https://app.test/x", "::::"), false);
});

// ---------------------------------------------------------------------------
// D2 — the on-screen mouse pad (pure half): gesture thresholds + spec shapes.
// ---------------------------------------------------------------------------

test("padMoveSpecs: scales finger deltas by PAD_SPEED so far corners stay reachable", () => {
  assert.deepEqual(padMoveSpecs(10, -4), [
    { kind: "move", dx: 10 * PAD_SPEED, dy: -4 * PAD_SPEED },
  ]);
  assert.equal(PAD_SPEED, 1.5, "the tuned speed is a contract, not a knob");
});

test("padMoveSpecs: a stationary finger emits nothing (no useless mousemove)", () => {
  assert.deepEqual(padMoveSpecs(0, 0), []);
});

test("padMoveSpecs: non-finite deltas coerce to 0 instead of poisoning the cursor", () => {
  const specs = padMoveSpecs(Number.NaN, 2);
  assert.deepEqual(specs, [{ kind: "move", dx: 0, dy: 2 * PAD_SPEED }]);
  assert.ok(
    specs.every((s) => s.kind !== "move" || (Number.isFinite(s.dx) && Number.isFinite(s.dy))),
    "never emit a non-finite delta",
  );
});

test("padClickSpecs: a click is a down/up pair on the requested button", () => {
  assert.deepEqual(padClickSpecs(0), [
    { kind: "down", button: 0 },
    { kind: "up", button: 0 },
  ]);
  assert.deepEqual(padClickSpecs(2), [
    { kind: "down", button: 2 },
    { kind: "up", button: 2 },
  ]);
});

test("padDoubleClickSpecs: two left clicks back to back", () => {
  assert.deepEqual(padDoubleClickSpecs(), [
    { kind: "down", button: 0 },
    { kind: "up", button: 0 },
    { kind: "down", button: 0 },
    { kind: "up", button: 0 },
  ]);
});

test("padDragSpecs: press holds the button down, release lifts it", () => {
  assert.deepEqual(padDragSpecs(true), [{ kind: "down", button: 0 }]);
  assert.deepEqual(padDragSpecs(false), [{ kind: "up", button: 0 }]);
});

test("padScrollSpecs: one conventional wheel notch each way", () => {
  assert.deepEqual(padScrollSpecs(-1), [{ kind: "wheel", dy: -120 }]);
  assert.deepEqual(padScrollSpecs(1), [{ kind: "wheel", dy: 120 }]);
});

test("clampCursor: keeps the virtual cursor inside the surface box", () => {
  const bounds = { width: 400, height: 300 };
  assert.deepEqual(clampCursor({ x: 100, y: 50 }, bounds), { x: 100, y: 50 });
  assert.deepEqual(clampCursor({ x: -5, y: -1 }, bounds), { x: 0, y: 0 });
  assert.deepEqual(clampCursor({ x: 9999, y: 400 }, bounds), { x: 400, y: 300 });
});

test("clampCursor: NaN/Infinity and degenerate bounds never produce a NaN cursor", () => {
  assert.deepEqual(
    clampCursor({ x: Number.NaN, y: Number.POSITIVE_INFINITY }, { width: 400, height: 300 }),
    { x: 0, y: 0 },
    "non-finite is invalid, not 'far away' — both axes reset to the origin",
  );
  const p = clampCursor({ x: 5, y: 5 }, { width: 0, height: -10 });
  assert.equal(Number.isFinite(p.x) && Number.isFinite(p.y), true);
});

test("buildTouchInjectionScript: exposes the __swMouse bridge the pad drives", () => {
  const src = buildTouchInjectionScript();
  assert.ok(src.includes("window.__swMouse"), "mouse bridge installed on the frame window");
  assert.ok(src.includes('"move"'), "handles move specs");
  assert.ok(src.includes('"wheel"'), "handles wheel specs");
  assert.ok(src.includes("mousedown") && src.includes("mouseup"), "synthesises button events");
});

// ---------------------------------------------------------------------------
// D1/D3 — contracts inside the panel and wrapper route (render tree / server).
// ---------------------------------------------------------------------------

test("D1: the start overlay is visual only — pointer events pass through to the stream", () => {
  const src = read("components/browser-session-panel.tsx");
  assert.match(
    src,
    /<div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black">/,
    "the first-screen overlay must never eat the mouse (owner bug)",
  );
});

test("D3: 'Open in new tab' opens OUR wrapper route, never the raw Neko URL", () => {
  const src = read("components/browser-session-panel.tsx");
  assert.ok(src.includes("popoutHrefFor(s.id)"), "panel builds the wrapper href");
  assert.ok(
    !src.includes("window.open(s.connectUrl"),
    "the bare connectUrl must not be opened directly — it carries no controllers",
  );
});

test("D3: the embedded panel and the pop-out tab share ONE controller component", () => {
  const src = read("components/browser-session-panel.tsx");
  assert.ok(src.includes("<RemoteViewerControls"), "the panel renders the shared controller");
  const view = read("components/browser-popout-view.tsx");
  assert.match(
    view,
    /onLoad=\{installTouchControls\}/,
    "the pop-out iframe gets the same installer (cursor fix + injected bridges)",
  );
  assert.ok(view.includes("<RemoteViewerControls"), "the pop-out tab renders the same controller");
});

test("D3: the wrapper route auths, scopes to the owner, and applies the same-origin guard", () => {
  const src = read("app/browser-popout/[sessionId]/page.tsx");
  assert.ok(src.includes('redirect("/login")'), "anonymous visitors go to /login");
  assert.ok(src.includes("userId: session.sub"), "ownership-scoped lookup (another user's id → 404)");
  assert.ok(src.includes("isSameOriginConnectUrl("), "guard applied before any frame is embedded");
  assert.ok(
    !src.includes("searchParams"),
    "no ?url= — connectUrl embeds credentials and must never ride in a query string",
  );
});

// ---------------------------------------------------------------------------
// D4a/D4b/D5 — orientation/layout contract (browser-only otherwise).
// ---------------------------------------------------------------------------

test("D5: full-screen height lives on the page with safe-area padding, both orientations", () => {
  const src = read("app/console/[deviceId]/page.tsx");
  assert.ok(src.includes("h-[100dvh]"), "viewport-relative height tracks the on-screen keyboard");
  for (const inset of ["top", "bottom", "left", "right"]) {
    assert.ok(
      src.includes(`env(safe-area-inset-${inset})`),
      `padding honours safe-area-inset-${inset} under viewportFit:cover`,
    );
  }
});

test("D5: no component keeps a fixed viewport calc (the landscape-gap root cause)", () => {
  const src = read("components/device-console.tsx");
  assert.ok(
    !src.includes('fullScreen && "flex h-[calc(100vh-3rem)] flex-col"'),
    "the old calc height was moved up to the page — it must not come back",
  );
  assert.ok(
    src.includes('fullScreen && "flex min-h-0 flex-1 flex-col"'),
    "the screen container fills whatever strip + toolbox leave over instead",
  );
});

test("D4a: the full-screen new tab shows the SpaceWorker tool tabs as one compact row", () => {
  const src = read("components/device-console.tsx");
  assert.ok(
    src.includes('fullScreen && "shrink-0 px-2 py-1"'),
    "tab strip renders compact in full-screen (owner: no spaceworker tools in the new tab)",
  );
  // Scope the "not hidden" check to the STRIP's own block — the title bar
  // above it still hides in full-screen (TASK_103 NEW-2 chrome, line ~1629),
  // which is intentional and out of scope here.
  const stripAt = src.indexOf("tab strip — TASK_103");
  assert.ok(stripAt > -1, "the tab-strip block exists");
  const stripRegion = src.slice(stripAt, src.indexOf("TABS.map", stripAt));
  assert.ok(
    !stripRegion.includes('"hidden"'),
    "…so the strip can no longer be hidden outright in full-screen",
  );
});

test("D4b: a dismissible hint points at MeshCentral's own Input checkbox (no fake toggle)", () => {
  const src = read("components/device-console.tsx");
  assert.match(
    src,
    /isMobileViewport && fullScreen && !inputHintDismissed/,
    "hint shows on the reported surface (phone full-screen) and can be dismissed",
  );
  assert.ok(src.includes("Input"), "names MeshCentral's checkbox");
});

test("D4b: the raw-MC launcher card is bypassed in full-screen (its prefix stays verbatim)", () => {
  const src = read("components/device-console.tsx");
  assert.match(
    src,
    /isMobileViewport && !embedInPage && !fullScreen \?/,
    "full-screen embeds directly with the tools — the launcher only serves the cramped embed",
  );
  // tests/console-mesh-scope.test.ts:63 pins the same prefix — keep both green.
  assert.ok(src.includes("isMobileViewport && !embedInPage"), "TASK_207 prefix preserved");
});

// ---------------------------------------------------------------------------
// D4a regression — the remote desktop rendered as a tiny strip in the middle
// of the page.
//
// The full-screen flex chain that hands the viewport height to the iframe was
// broken ONE LINK ABOVE the iframe: ControlTab's own root was a plain block
// (`space-y-4`). A block does not divide free space, so every `flex-1` below
// it had nothing to grow into, the screen container fell back to content
// height and the iframe collapsed to the UA default 150px. MeshCentral scales
// the remote desktop to fit its viewport, so it painted a ~150px band — which
// is why MC's own "expand" button was equally tiny: it only ever fills the
// IFRAME's viewport, never the browser window.
//
// The chain must be unbroken, from the page down to the iframe. Each element
// is pinned below so a refactor cannot silently reintroduce a block in the
// middle and shrink the desktop again.
// ---------------------------------------------------------------------------

test("D4a regression: ControlTab's root is a flex column in full-screen (not a block)", () => {
  const src = read("components/device-console.tsx");
  const fnStart = src.indexOf("function ControlTab(");
  assert.ok(fnStart > -1, "ControlTab must exist");
  // The component's return block: from its first `return (` to the end of the
  // mesh branch that holds the iframe.
  const retAt = src.indexOf("return (", fnStart);
  assert.ok(retAt > -1, "ControlTab must return markup");
  const body = src.slice(retAt, src.indexOf("function MeshOnlyNotice", retAt));
  assert.match(
    body,
    /fullScreen \? "flex min-h-0 flex-1 flex-col gap-4" : "space-y-4"/,
    "ControlTab's root must become a flex column in full-screen — a block breaks the chain and collapses the iframe to 150px",
  );
  assert.ok(
    !/<div className="space-y-4">\s*\{\/\* Buttons row/.test(body),
    "ControlTab's root must not be an unconditional block wrapper",
  );
});

test("D4a regression: the full-screen flex chain to the iframe is unbroken", () => {
  const src = read("components/device-console.tsx");
  // Every link that must be a flex column for `flex-1` to mean anything.
  const chain = [
    'fullScreen && "flex min-h-0 flex-1 flex-col"', // tab body + screen container
    'fullScreen ? "flex min-h-0 flex-1 flex-col gap-4" : "space-y-4"', // ControlTab root
  ];
  for (const link of chain) {
    assert.ok(src.includes(link), `the chain must keep: ${link}`);
  }
  // The iframe itself must be allowed to shrink and grow.
  assert.ok(
    src.includes('fullScreen ? "min-h-0 flex-1" : "h-[70dvh] sm:h-[480px]"'),
    "the iframe must fill the leftover height in full-screen",
  );
  // The chrome above the screen must not be squeezed out of the flex column.
  assert.ok(
    src.includes('fullScreen && "shrink-0 px-2 py-1"'),
    "the compact tab strip must keep its height (shrink-0)",
  );
  assert.ok(
    src.includes("flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border bg-black/40"),
    "the toolbox line must keep its height (shrink-0)",
  );
});
