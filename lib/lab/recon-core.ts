// TASK_156B Slice 2 (PLAN_CYBERLAB_SLICE2_SCAN_FIRST_RECON.md §3.1) — the PURE
// scan-first recon scope check. Deliberately free of "server-only", db and
// network imports so the SAME module is imported by the server (engine branch)
// and testable on a bare machine — one validator, never two copies.
//
// WHY THIS EXISTS: the owner's scan-first vision (no attested device needed to
// START). Today's attested pre-flight (lib/lab/targets-core.ts preflightTargets)
// requires every target to match a FRESH attested LabTarget row — the opposite
// of scan-first. Recon relaxes that: the caller DECLARES a scope they are
// authorized to test (the AUP/consent gate still applies), and this module
// validates it is well-formed and NOT dangerously broad.
//
// The one safety constant that matters (PLAN §4 hard line "no unscoped scanning
// of third parties"): a `network` scope may not be broader than
// RECON_MIN_NETWORK_PREFIX. A /8 or /16 is "scan the internet"; a /24 is a
// declared, bounded scope. This is a POLICY constant, not a setting — tightening
// it later is a one-line change with a test, loosening it needs the owner.
//
// HONEST LIMIT: recon is SIMULATED today (synthetic telemetry, no packet leaves
// the platform). The breadth guard is still enforced because it is the exact
// rule the real C2b scanner must obey, and enforcing it now means the simulated
// and live paths agree. The moment anything touches a real host, the attested-
// target + verified-teardown discipline re-enters (PLAN §4).

import { normalizeTarget, type LabTargetKind, type NormalizedTarget } from "./targets-core";

export type ReconScopeKind = LabTargetKind;

/**
 * The narrowest prefix a recon `network` scope may declare. 24 = a /24 (256
 * addresses). Anything numerically SMALLER (broader: /23, /16, /8, /0) is
 * refused as too_broad_scope. Deliberately conservative — see header.
 */
export const RECON_MIN_NETWORK_PREFIX = 24;

/** ATT&CK recon/discovery techniques the simulated recon phase exercises. */
export const RECON_TECHNIQUE_IDS = ["T1595.001", "T1595.002", "T1046"] as const;

/** Signature ids the simulated recon telemetry deliberately trips (the C5 seed). */
export const RECON_SIGNATURE_IDS = [
  "lab.recon.host_enumeration_sweep",
  "lab.recon.service_probe_pattern",
] as const;

export interface ReconScopeInput {
  kind: string;
  value: string;
}

export type ReconRefusalReason = "not_normalized" | "too_broad_scope";

export interface ReconScopeIssue {
  kind: string;
  value: string;
  reason: ReconRefusalReason;
}

export interface ReconScopeResult {
  /** Well-formed, in-scope targets the recon run may enumerate (duplicates collapsed). */
  kept: NormalizedTarget[];
  /** Values that are not valid for their declared kind (plain validation, not abuse). */
  invalid: ReconScopeIssue[];
  /** Well-formed but too broad to declare (the third-party-scanning guard; audited). */
  tooBroad: ReconScopeIssue[];
}

/** The numeric prefix of a normalized "addr/prefix" network value, or null. */
function networkPrefix(value: string): number | null {
  const idx = value.lastIndexOf("/");
  if (idx < 0) return null;
  const p = Number(value.slice(idx + 1));
  return Number.isInteger(p) ? p : null;
}

/**
 * Validate a declared recon scope. Pure and deterministic: same inputs → same
 * result. Never throws — the caller decides how each refusal is surfaced and
 * (for `tooBroad`) audited.
 *
 *   - not_normalized  — the value is not a valid member of its declared kind
 *                       (a plain validation error, never an abuse report —
 *                       mirrors the attest boundary note in lib/lab/targets.ts).
 *   - too_broad_scope — a `network` broader than RECON_MIN_NETWORK_PREFIX; the
 *                       caller writes a LabAbuseReport and refuses (§5.2).
 */
export function validateReconScope(targets: readonly ReconScopeInput[]): ReconScopeResult {
  const kept: NormalizedTarget[] = [];
  const invalid: ReconScopeIssue[] = [];
  const tooBroad: ReconScopeIssue[] = [];

  for (const t of targets) {
    const norm = normalizeTarget(t.kind, t.value);
    if (!norm) {
      invalid.push({ kind: t.kind, value: t.value, reason: "not_normalized" });
      continue;
    }
    if (norm.kind === "network") {
      const prefix = networkPrefix(norm.value);
      if (prefix === null || prefix < RECON_MIN_NETWORK_PREFIX) {
        tooBroad.push({ kind: norm.kind, value: norm.value, reason: "too_broad_scope" });
        continue;
      }
    }
    if (!kept.some((k) => k.kind === norm.kind && k.value === norm.value)) kept.push(norm);
  }

  return { kept, invalid, tooBroad };
}
