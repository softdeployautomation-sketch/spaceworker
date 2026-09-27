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

// Self-hosted, standalone build (2026-09-27 — the self-hosted product line).
// Orthogonal to BUILD_TARGET (which product variant is built): a self-hosted
// deployment can in principle be any variant. Gates everything that only
// makes sense for OUR shared hosting — the storefront/payments/wallets/
// pooled-AI-usage/our-own-license-issuance admin tabs and their API routes,
// the hosted-EXE trial/account-linking flow (lib/exe-runtime.ts), and the
// cross-origin admin-console iframe embed (next.config.ts's CSP). The web app
// never sets this (same discipline as BUILD_TARGET/SPACEWORKER_LOCAL_EXE) —
// only a self-hosted build's own .env ever does.
export function isSelfHosted(): boolean {
  return process.env.SELF_HOSTED === "true";
}