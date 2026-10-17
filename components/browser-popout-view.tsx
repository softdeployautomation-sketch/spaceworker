"use client";

// TASK_212 D3 — the pop-out tab's client view. Renders OUR chrome (same-origin
// Neko iframe + the shared mouse/keyboard controller) around the stream. The
// connectUrl is handed down from the server route (app/browser-popout/
// [sessionId]/page.tsx), which re-mints it from the DB after auth + ownership
// checks — the credential never appears in any client-provided string, and
// the same-origin guard (lib/browser-popout.ts) has already been applied
// before this component renders.
//
// D5: the layout is viewport-relative (100dvh) with safe-area padding so it
// works in BOTH landscape and portrait on a phone — the iframe fills whatever
// remains above the controls, and the controls wrap instead of overflowing.

import { useCallback, useRef } from "react";

import {
  RemoteViewerControls,
  installTouchControls,
} from "@/components/remote-viewer-controls";

export function BrowserPopoutView({ connectUrl }: { connectUrl: string }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const getFrame = useCallback(() => frameRef.current, []);

  return (
    <div className="flex h-[100dvh] flex-col bg-black pb-[max(0rem,env(safe-area-inset-bottom))] pl-[max(0rem,env(safe-area-inset-left))] pr-[max(0rem,env(safe-area-inset-right))] pt-[max(0rem,env(safe-area-inset-top))]">
      <iframe
        ref={frameRef}
        src={connectUrl}
        title="Private browser session"
        allow="clipboard-read; clipboard-write; autoplay; fullscreen"
        className="min-h-0 w-full flex-1 border-0 bg-black"
        onLoad={installTouchControls}
      />
      {/* Controls sit BELOW the stream (never covering it) and are ALWAYS
          rendered, collapsed by default — TASK_216 removed the old touchUi
          gate that unmounted them on desktop (the pop-out tab used to have
          ZERO controls with a mouse). The wrapper is dark to match the
          stream; the component keeps its own light/dark surface so it looks
          native on both themes. */}
      <div className="shrink-0 p-2">
        <RemoteViewerControls getFrame={getFrame} />
      </div>
    </div>
  );
}
