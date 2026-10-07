"use client";

// TASK_181 — wrapper-mode context, the mirror of build-target-context.tsx.
//
// wrapperMode() in lib/wrapper-mode.ts is "server-only" (it reads process.env),
// so the dashboard layout resolves it ONCE server-side and injects it here for
// client nav/copy consumers (dashboard-nav, device-list, settings). Same
// fail-closed property as the build-target context: NO provider value (hosted
// web, flag unset) ⇒ undefined ⇒ every consumer renders exactly today's full-web
// behaviour.
//
// Deliberately a separate context from BuildTargetContext: the two flags mean
// opposite things (D2 — buildTarget = local runtime without the DB, wrapper =
// server-bound WITH it), so conflating them in one stringly-typed channel would
// let a future "buildTarget" value silently toggle wallet/logout visibility.

import { createContext, useContext } from "react";

import type { WrapperMode } from "@/lib/wrapper-mode";

const WrapperModeContext = createContext<WrapperMode | null>(null);

export function WrapperModeProvider({
  children,
  value,
}: {
  children: React.ReactNode;
  value: WrapperMode | null;
}) {
  return <WrapperModeContext.Provider value={value}>{children}</WrapperModeContext.Provider>;
}

export function useWrapperMode(): WrapperMode | null {
  return useContext(WrapperModeContext);
}
