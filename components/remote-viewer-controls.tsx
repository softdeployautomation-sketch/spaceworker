"use client";

// TASK_212 D2+D3 — the SpaceWorker remote-viewer controls, shared between the
// embedded private-browser panel and the pop-out wrapper tab.
//
// Owner: the mobile embed "didn't add a mouse controller", and the pop-out tab
// "is not embedded with the controllers". This component IS those controls:
// an on-screen mouse pad (move / left-tap / right-click / double-click /
// hold-drag / scroll) plus TASK_208's keyboard bar, talking to the (same-
// origin) Neko iframe exclusively through the injected `__swMouse`/`__swKey`
// bridges in lib/touch-controls.ts — never touching the frame's DOM directly,
// so a Neko upgrade that changes its internals degrades to "controls do
// nothing" instead of breaking the stream. Always rendered, collapsed by
// default (TASK_216: the old `pointer: coarse` gate UNMOUNTED the whole
// controller whenever the primary pointer flipped to a mouse — the owner's
// "the mouse toggle disappears when the mouse approaches it" — and left plain
// desktop pop-out tabs with zero controls), and safe-area aware for notched
// phones in both orientations.

import { useCallback, useRef, useState } from "react";

import {
  buildTouchInjectionScript,
  MOD_KEYS,
  noMods,
  padClickSpecs,
  padDoubleClickSpecs,
  padDragSpecs,
  padMoveSpecs,
  padScrollSpecs,
  toggleMod,
  type PadSpec,
} from "@/lib/touch-controls";

// ---------------------------------------------------------------------------
// Neko cursor-doubling fix + touch-control injection (TASK_208 S2, moved here
// verbatim from browser-session-panel.tsx in TASK_212 D3 so the pop-out tab
// and the panel share ONE installer — no fork).
//
// Neko renders the remote OS's cursor baked directly into the video stream,
// but its own client doesn't hide the LOCAL cursor while hovering over that
// video — so users see two: the real remote one in the pixels, plus the
// host browser's own arrow on top. Confirmed no cursor-hiding logic exists in
// Neko's shipped client JS/CSS (checked directly). The iframe is same-origin
// (served through our own domain via the /browser/<id>/ proxy), so we can
// reach into its document and fix this ourselves rather than waiting on
// upstream — best-effort, wrapped in try/catch in case a future Neko version
// changes its DOM shape or this ever isn't same-origin for some reason.
function hideRemoteCursorDoubling(frame: HTMLIFrameElement) {
  try {
    const doc = frame.contentDocument;
    if (!doc) return;
    const style = doc.createElement("style");
    style.textContent = "* { cursor: none !important; }";
    doc.head.appendChild(style);
  } catch {
    /* cross-origin or blocked for some other reason — leave the default cursor */
  }
}

// TASK_208 S2 / TASK_212 D2 / TASK_216 — the ONE installer for the pop-out tab
// and the panel (no fork). Idempotent, with a HEAL path (TASK_216): the old
// check was `getElementById("sw-touch-controls")` alone, but the injected
// script sets its realm-side `__swTouchInstalled` flag ONLY on success now —
// so a script element whose install threw mid-way means "partial install" and
// must be removed and re-injected from scratch, not treated as done. (Before
// TASK_216 that half-install was permanent: element present → every retry
// skipped → dead bridge — the owner's "embedded never worked since 212".)
// Called on every iframe load AND lazily by the pad/key senders when they
// find the bridge missing.
export function ensureTouchControls(frame: HTMLIFrameElement | null): void {
  if (!frame) return;
  try {
    const doc = frame.contentDocument;
    if (!doc) return; // cross-origin — can't inject (shouldn't happen: /browser/ proxy is same-origin)
    const win = doc.defaultView as
      | (Window & { __swTouchInstalled?: boolean })
      | null;
    const existing = doc.getElementById("sw-touch-controls");
    if (existing && win?.__swTouchInstalled) return; // fully installed — idempotent
    if (existing) existing.remove(); // partial install — retry clean
    const script = doc.createElement("script");
    script.id = "sw-touch-controls";
    script.textContent = buildTouchInjectionScript();
    (doc.body || doc.documentElement).appendChild(script);
  } catch {
    /* leave Neko's defaults */
  }
}

// Thin onLoad adapter over ensureTouchControls — kept under its TASK_208 name
// because both call sites (panel + pop-out) wire it as onLoad={installTouchControls}.
export function installTouchControls(e: React.SyntheticEvent<HTMLIFrameElement>) {
  hideRemoteCursorDoubling(e.currentTarget);
  ensureTouchControls(e.currentTarget);
}

type SwWindow = Window & {
  __swKey?: (k: string, d: boolean, m: unknown) => void;
  __swMouse?: (spec: PadSpec) => void;
};

export function RemoteViewerControls({
  getFrame,
}: {
  /** Resolve the live Neko iframe (same-origin). Called per interaction; null = frame gone. */
  getFrame: () => HTMLIFrameElement | null;
}) {
  const [mods, setMods] = useState({ ctrl: false, alt: false, shift: false });
  // Pad UI state: collapsed by default (never permanently covering the
  // stream), and drag mode is a sticky toggle like the modifiers.
  const [padOpen, setPadOpen] = useState(false);
  const [dragArmed, setDragArmed] = useState(false);

  // Send a batch of pad specs into the frame's injected __swMouse bridge.
  // TASK_216: if the bridge is missing (script never ran, or its install threw
  // mid-way and the success flag stayed unset), HEAL by re-running the
  // installer before giving up — a tap must not be silently dropped.
  // try/catch per batch — if the frame navigated mid-batch this must never
  // throw (precedent: sendKey in TASK_208).
  const sendSpecs = useCallback(
    (specs: PadSpec[]) => {
      if (specs.length === 0) return;
      try {
        const frame = getFrame();
        let win = frame?.contentWindow as SwWindow | null;
        if (!win?.__swMouse) {
          ensureTouchControls(frame); // heal a missing/partial bridge, then retry once
          win = frame?.contentWindow as SwWindow | null;
        }
        if (!win?.__swMouse) return;
        for (const spec of specs) win.__swMouse(spec);
      } catch {
        /* frame gone / cross-origin — ignore */
      }
    },
    [getFrame]
  );

  // Forward a key into the Neko iframe via the injected __swKey bridge — with
  // the same TASK_216 heal-on-missing path as sendSpecs.
  const sendKey = useCallback(
    (key: string, down: boolean) => {
      try {
        const frame = getFrame();
        let win = frame?.contentWindow as SwWindow | null;
        if (!win?.__swKey) {
          ensureTouchControls(frame);
          win = frame?.contentWindow as SwWindow | null;
        }
        win?.__swKey?.(key, down, mods);
      } catch {
        /* frame gone / cross-origin — ignore */
      }
    },
    [getFrame, mods]
  );

  // --- the pad surface: a trackpad. Drag = move the remote cursor; a quick
  // stationary tap = left click; with drag armed, press/hold/slide/release =
  // hold-the-button dragging (windows, marquee selections).
  const padRef = useRef<HTMLDivElement | null>(null);
  const stroke = useRef<{ x: number; y: number; moved: boolean; down: boolean }>({
    x: 0,
    y: 0,
    moved: false,
    down: false,
  });

  const onPadDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      // TASK_216: capture the pointer so the stroke survives the finger/pen
      // leaving the pad mid-drag — without this, a release outside the pad
      // never reaches onPadUp and the remote button stays stuck DOWN.
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* unsupported/failed capture — degrade to the old uncaptured stroke */
      }
      stroke.current = { x: e.clientX, y: e.clientY, moved: false, down: true };
      if (dragArmed) sendSpecs(padDragSpecs(true));
    },
    [dragArmed, sendSpecs]
  );
  const onPadMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!stroke.current.down) return;
      e.preventDefault();
      const dx = e.clientX - stroke.current.x;
      const dy = e.clientY - stroke.current.y;
      if (dx !== 0 || dy !== 0) {
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) stroke.current.moved = true;
        sendSpecs(padMoveSpecs(dx, dy));
        stroke.current.x = e.clientX;
        stroke.current.y = e.clientY;
      }
    },
    [sendSpecs]
  );
  const onPadUp = useCallback(
    (e?: React.PointerEvent<HTMLDivElement>) => {
      if (!stroke.current.down) return;
      if (e) {
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* already released (e.g. pointercancel) — nothing to undo */
        }
      }
      stroke.current.down = false;
      if (dragArmed) {
        sendSpecs(padDragSpecs(false));
      } else if (!stroke.current.moved) {
        sendSpecs(padClickSpecs(0)); // stationary tap = left click
      }
    },
    [dragArmed, sendSpecs]
  );

  const btn =
    "rounded border border-zinc-300 px-2.5 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800";
  const btnOn =
    "rounded border border-zinc-900 bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-white transition-colors dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900";

  return (
    <div className="mt-2 rounded-lg border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-900">
      {/* collapse toggle — the whole controller is opt-in so it never covers the stream */}
      <button
        type="button"
        onClick={() => setPadOpen((v) => !v)}
        aria-expanded={padOpen}
        className="flex w-full touch-manipulation select-none items-center justify-between rounded px-1 py-1 text-xs font-medium text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
      >
        <span>🖱 Mouse &amp; keyboard</span>
        <span aria-hidden>{padOpen ? "▾" : "▴"}</span>
      </button>

      {padOpen && (
        <>
          {/* pad + action buttons side by side in landscape, stacked in
              portrait — flex-wrap handles both orientations without a media
              query (D5). */}
          <div className="mt-2 flex flex-wrap items-stretch gap-2 pb-[max(0rem,env(safe-area-inset-bottom))]">
            <div
              ref={padRef}
              onPointerDown={onPadDown}
              onPointerMove={onPadMove}
              onPointerUp={onPadUp}
              onPointerCancel={onPadUp}
              className="relative h-24 min-w-40 flex-1 touch-none select-none rounded-md border border-dashed border-zinc-300 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950"
            >
              <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] text-zinc-400">
                {dragArmed
                  ? "drag mode — hold & slide, release to drop"
                  : "trackpad — slide to move, tap to click"}
              </span>
            </div>
            <div className="flex flex-col justify-between gap-1.5">
              <div className="flex flex-wrap gap-1.5">
                <button type="button" onClick={() => sendSpecs(padClickSpecs(0))} className={btn}>
                  Left
                </button>
                <button type="button" onClick={() => sendSpecs(padClickSpecs(2))} className={btn}>
                  Right
                </button>
                <button type="button" onClick={() => sendSpecs(padDoubleClickSpecs())} className={btn}>
                  Double
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => setDragArmed((v) => !v)}
                  className={dragArmed ? btnOn : btn}
                  aria-pressed={dragArmed}
                >
                  Drag
                </button>
                <button
                  type="button"
                  onClick={() => sendSpecs(padScrollSpecs(-1))}
                  className={btn}
                  aria-label="Scroll up"
                >
                  ▲
                </button>
                <button
                  type="button"
                  onClick={() => sendSpecs(padScrollSpecs(1))}
                  className={btn}
                  aria-label="Scroll down"
                >
                  ▼
                </button>
              </div>
            </div>
          </div>

          {/* keyboard bar — TASK_208 S2, same semantics, now shared */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {MOD_KEYS.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMods((prev) => toggleMod(prev, m))}
                className={`rounded border px-2.5 py-1.5 text-xs font-medium capitalize transition-colors ${
                  mods[m] ? btnOn : btn
                }`}
              >
                {m}
              </button>
            ))}
            {(
              [
                ["Escape", "Esc"],
                ["Tab", "Tab"],
                ["Backspace", "⌫"],
                ["Enter", "⏎"],
                ["ArrowLeft", "←"],
                ["ArrowUp", "↑"],
                ["ArrowDown", "↓"],
                ["ArrowRight", "→"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  sendKey(key, true);
                  sendKey(key, false);
                }}
                className={btn}
              >
                {label}
              </button>
            ))}
            <input
              type="text"
              value=""
              onChange={() => {
                /* capture-only: the field stays empty; keys are forwarded into the frame */
              }}
              onKeyDown={(e) => {
                e.preventDefault(); // never type into this field — forward instead
                sendKey(e.key, true);
              }}
              onKeyUp={(e) => {
                e.preventDefault();
                sendKey(e.key, false);
              }}
              placeholder="Type here…"
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              className="min-w-32 flex-1 rounded border border-zinc-300 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700"
            />
          </div>
          {noMods(mods) ? null : (
            <p className="mt-1 text-[11px] text-zinc-400">
              {MOD_KEYS.filter((m) => mods[m]).join(" + ")} held
            </p>
          )}
        </>
      )}
    </div>
  );
}

