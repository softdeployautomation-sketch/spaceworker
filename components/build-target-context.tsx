"use client";

// EXE build-target context (Task 27 Part A "four build targets, one core").
//
// The build target is resolved ONCE by the dashboard layout (a server component
// that reads BUILD_TARGET via lib/exe-build-target.ts, which is "server-only")
// and injected here so any client nav consumer can read it without importing the
// server-only lib or having buildTarget prop-drilled to it. useNavItems() falls
// back to this context when no explicit arg is passed, so a future consumer that
// forgets to thread buildTarget can't silently leak the full web nav into an EXE
// build. The hosted web app provides no value -> undefined -> full nav.

import { createContext, useContext } from "react";

const BuildTargetContext = createContext<string | undefined>(undefined);

export function BuildTargetProvider({
  children,
  value,
}: {
  children: React.ReactNode;
  value?: string;
}) {
  return <BuildTargetContext.Provider value={value}>{children}</BuildTargetContext.Provider>;
}

export function useBuildTarget(): string | undefined {
  return useContext(BuildTargetContext);
}
