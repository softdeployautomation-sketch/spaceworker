// TASK_156B REAL EGRESS (PLAN_CYBERLAB_REAL_EGRESS.md §1) — the PURE core of
// the LIVE server-egress scan. Deliberately free of "server-only", db and any
// socket import so the SAME module is imported by the server (engine branch)
// and is testable on a bare machine — one validator, never two copies (the
// recon-core.ts pattern).
//
// This is the OPPOSITE of recon: recon is SIMULATED (synthetic telemetry, no
// packet leaves the platform). A `live` run makes a REAL TCP connect OUT of the
// platform to the host the operator declared, so the team can actually break
// into — and record — their own VM. No simulated dry-run can prove that, which
// is the whole point of the tool.
//
// The friction=0 posture is the OWNER'S POLICY, expressed as DIALS rather than
// hard refusals: attestation-free scanning (like recon), an OPTIONAL /24
// breadth guard, and an OPTIONAL CIDR allow-list — all default OPEN, because
// CyberLab is grant-only, OFF the Premium Plus catch-all, and every operator is
// hand-verified by the owner before they ever see the button. The dials exist so
// the owner can re-tighten per-range during testing WITHOUT a rebuild; the MASTER
// switch (AdminSetting.cyberlabLiveEgressEnabled) is what makes any real packet
// possible at all, and it ships FALSE (dark).

import { isIP } from "node:net";

import { ipInCidr, normalizeTarget, type LabTargetKind, type NormalizedTarget } from "./targets-core";

export type LiveScopeKind = LabTargetKind;

/**
 * ATT&CK techniques the LIVE TCP service scan exercises — real connect events,
 * not simulated enumeration. T1046 (Network Service Discovery) is the core;
 * T1595.001/.002 are the active-scanning prelude the port sweep begins with.
 */
export const LIVE_TECHNIQUE_IDS = ["T1046", "T1595.001", "T1595.002"] as const;

/** Signature ids a live scan trips — real open-port observations, not synthetic. */
export const LIVE_SIGNATURE_IDS = ["lab.live.tcp_connect_probe", "lab.live.open_port_observed"] as const;

/**
 * The ports a live scan probes when the caller names none. A pragmatic service
 * set (SSH, HTTP, HTTPS, RDP, an alt-HTTP) that surfaces the usual "is my VM
 * actually exposed" answer without turning every run into a 65k-port hammer.
 */
export const LIVE_DEFAULT_PORTS: readonly number[] = [22, 80, 443, 3389, 8080];

/** A single declared target to sweep. */
export interface LiveScopeInput {
  kind: string;
  value: string;
}

export type LiveRefusalReason = "not_normalized" | "too_broad_scope" | "not_in_allow_list";

export interface LiveScopeIssue {
  kind: string;
  value: string;
  reason: LiveRefusalReason;
}

export interface LiveScopeOptions {
  /** If true, re-apply the /24 breadth guard to `network` scopes (default off). */
  scopeGuard?: boolean;
  /** The breadth-guard threshold when scopeGuard is on (recon's 24). */
  minNetworkPrefix?: number;
  /** CIDRs/hosts egress may reach; empty/omitted = allow all (friction=0). */
  allowList?: readonly string[];
}

export interface LiveScopeResult {
  kept: NormalizedTarget[];
  issues: LiveScopeIssue[];
}

/** A valid TCP port (1..65535) or null. */
export function normalizeLivePort(p: unknown): number | null {
  const n = typeof p === "string" ? Number(p) : p;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 65_535) return null;
  return n;
}

/**
 * True when `value` (an IP, a `addr/prefix`, or a hostname) is permitted by a
 * non-empty allow-list. Exact host match (case-insensitive) OR the value's base
 * IP sits inside one of the allow-list CIDRs. Empty list is handled by the
 * caller as "allow all" and never reaches here.
 */
export function inLiveAllowList(value: string, allowList: readonly string[]): boolean {
  const v = value.trim().toLowerCase();
  if (allowList.some((a) => a.trim().toLowerCase() === v)) return true;
  const base = v.split("/")[0];
  if (isIP(base)) return allowList.some((a) => a.includes("/") && ipInCidr(base, a.trim().toLowerCase()));
  return false;
}

/**
 * Validate the live scan's declared scope. Same shape as validateReconScope so
 * the engine can treat the two symmetrically, but the guards are OPTIONAL and
 * default off (friction=0). `not_normalized` is always refused — that is not a
 * policy guard, it is the target simply not being a usable address. Everything
 * else (breadth, allow-list) is only enforced when the owner turns the dial on.
 */
export function validateLiveScope(targets: readonly LiveScopeInput[], options: LiveScopeOptions = {}): LiveScopeResult {
  const kept: NormalizedTarget[] = [];
  const issues: LiveScopeIssue[] = [];
  const minPrefix = options.minNetworkPrefix ?? 24;
  const allowList = options.allowList ?? [];
  for (const t of targets) {
    const norm = normalizeTarget(t.kind, t.value);
    if (!norm) {
      issues.push({ kind: t.kind, value: t.value, reason: "not_normalized" });
      continue;
    }
    if (options.scopeGuard && norm.kind === "network") {
      const prefix = Number(norm.value.split("/")[1]);
      if (!Number.isInteger(prefix) || prefix < minPrefix) {
        issues.push({ kind: t.kind, value: t.value, reason: "too_broad_scope" });
        continue;
      }
    }
    if (allowList.length > 0 && !inLiveAllowList(norm.value, allowList)) {
      issues.push({ kind: t.kind, value: t.value, reason: "not_in_allow_list" });
      continue;
    }
    if (!kept.some((k) => k.kind === norm.kind && k.value === norm.value)) kept.push(norm);
  }
  return { kept, issues };
}
