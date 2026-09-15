import "server-only";

// Build-target switch for the "four build targets, one core" desktop EXEs (Task 27
// Part A). A single Next.js codebase is compiled with a build-time env var deciding
// which dashboard routes/nav survive into a given EXE. Defaults to the Extractor
// build — the current, customer-blocked, sole priority per the plan's 2026-09-15
// update. The web app never sets this and never enters a desktop path, because every
// consumer here is additionally gated by isLocalExeRuntime() (see lib/exe-runtime.ts).

export type ExeBuildTarget = "extractor" | "mailer" | "combined" | "automation";

export const EXE_BUILD_TARGETS: ExeBuildTarget[] = ["extractor", "mailer", "combined", "automation"];

export function isExeBuildTarget(value: string): value is ExeBuildTarget {
  return EXE_BUILD_TARGETS.includes(value as ExeBuildTarget);
}

/** Reads BUILD_TARGET from the environment, defaulting to "extractor". */
export function exeBuildTarget(): ExeBuildTarget {
  const raw = process.env.BUILD_TARGET ?? "";
  return isExeBuildTarget(raw) ? raw : "extractor";
}