"use client";

import { createContext, useCallback, useContext, useEffect, useRef } from "react";

// 2026-09-27 — lets any dashboard page hand the floating agent widget a
// short, COMPACT summary of what's actually on screen right now (e.g. real
// device names + statuses), instead of the widget only ever knowing the
// route name. Deliberately opt-in and per-page: a page that never calls
// useSetAgentPageContext just leaves the widget with its generic
// route-derived label — this is "just the context of the tab it's in," never
// a global dump of every page's state, and never raw HTML/DOM.
//
// Cost stays bounded the same way as the original page-label design: this is
// still one short string, capped, injected into a single system message for
// just the current turn (see runAgentTurn's pageContext) — a richer summary
// here doesn't change that shape, it just makes the string itself more
// useful.

const MAX_CONTEXT_LEN = 500;

interface AgentPageContextValue {
  getContext: () => string | null;
  setContext: (value: string | null) => void;
}

const AgentPageContext = createContext<AgentPageContextValue | null>(null);

export function AgentPageContextProvider({ children }: { children: React.ReactNode }) {
  // A ref, not state — pages update this on every data refresh (e.g. every
  // device poll), and that must never re-render the whole shell/widget tree.
  // The widget itself only reads it lazily, at send-time.
  const ref = useRef<string | null>(null);

  const setContext = useCallback((value: string | null) => {
    ref.current = value ? value.slice(0, MAX_CONTEXT_LEN) : null;
  }, []);
  const getContext = useCallback(() => ref.current, []);

  return (
    <AgentPageContext.Provider value={{ getContext, setContext }}>
      {children}
    </AgentPageContext.Provider>
  );
}

/** Widget-side: read the current page's opted-in context, if any. */
export function useAgentPageContext(): AgentPageContextValue | null {
  return useContext(AgentPageContext);
}

/**
 * Page-side: register a compact summary of what THIS page is showing right
 * now. Call with `null` to clear (e.g. on unmount, or while data is still
 * loading) rather than leaving a stale summary behind.
 */
export function useSetAgentPageContext(value: string | null) {
  const ctx = useContext(AgentPageContext);
  useEffect(() => {
    ctx?.setContext(value);
  }, [ctx, value]);
}
