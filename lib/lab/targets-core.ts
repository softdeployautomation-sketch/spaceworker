// TASK_156 C2a (PLAN_TASK_156 §7 C2 item 2, §5.2 line 1, §6 LabTarget) — the
// PURE pre-flight core: target normalisation + the attested-set check.
//
// The legal spine of the product is `LabTarget` — "Every scenario target must
// match a row here for that user, checked pre-flight" (schema comment) — and
// §5.2 requires that proof be re-checked "at the moment of every run", not
// trusted from a past run. This module is the pure half of that check: no db,
// no server-only, testable on a bare machine. lib/lab/targets.ts is the
// db-backed half (loads the rows, writes the LabAbuseReport on refusal).
//
// Refusal reasons are explicit so the audit trail and the UI can be honest:
//   not_normalized      — the value is not a valid member of its declared kind.
//   unattested          — no LabTarget row matches (the §5.2 refusal).
//   stale_attestation   — the row exists but is older than the freshness window
//                         ("proven at the moment of every run" made concrete).
//   range_mismatch      — the row is bound to a different lab range.

import { isIP } from "node:net";

/** The LabTarget.kind vocabulary (schema §6). */
export type LabTargetKind = "host" | "network" | "url" | "domain" | "email";

export type PreflightRefusalReason = "not_normalized" | "unattested" | "stale_attestation" | "range_mismatch";

export interface PreflightInput {
  kind: string;
  value: string;
}

export interface NormalizedTarget {
  kind: LabTargetKind;
  value: string;
}

export interface PreflightIssue {
  kind: string;
  value: string;
  reason: PreflightRefusalReason;
}

/** An attested-inventory row as the pure checker sees it. */
export interface AttestedRow {
  kind: string;
  value: string;
  rangeId: string | null;
  attestedAt: Date;
}

export interface PreflightWindow {
  /** The range the run will use; rows bound to other ranges do not count. */
  rangeId?: string | null;
  /** Freshness policy — see LAB_ATTESTATION_MAX_AGE_DAYS. */
  maxAgeDays?: number;
  now?: Date;
}

export const LAB_TARGET_KINDS: readonly LabTargetKind[] = ["host", "network", "url", "domain", "email"];

/**
 * Policy constant (not a setting): an attestation older than this must be
 * renewed before a run may use it. 90 days is deliberately conservative —
 * §5.2 says the attested set must be PROVEN at run time, and an unbounded
 * attestation is a promise, not a proof.
 */
export const LAB_ATTESTATION_MAX_AGE_DAYS = 90;

const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** IPv4 | IPv4-mapped text | hostname (lowercased, brackets stripped). */
function normalizeHost(value: string): string | null {
  const v = value.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (isIP(v) === 4 || isIP(v) === 6) return v;
  return HOSTNAME_RE.test(v) ? v : null;
}

/** "addr/prefix" with a valid prefix for the address family. */
function normalizeNetwork(value: string): string | null {
  const parts = value.trim().toLowerCase().split("/");
  if (parts.length !== 2) return null;
  const [addr, prefix] = parts;
  const family = isIP(addr);
  const p = Number(prefix);
  if (!addr || !Number.isInteger(p)) return null;
  if (family === 4 && p >= 0 && p <= 32) return `${addr}/${p}`;
  if (family === 6 && p >= 0 && p <= 128) return `${addr}/${p}`;
  return null;
}

function normalizeUrl(value: string): string | null {
  try {
    const u = new URL(value.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

function normalizeDomain(value: string): string | null {
  const d = value.trim().toLowerCase().replace(/\.$/, "");
  return HOSTNAME_RE.test(d) && d.includes(".") ? d : null;
}

function normalizeEmail(value: string): string | null {
  const e = value.trim().toLowerCase();
  return EMAIL_RE.test(e) ? e : null;
}

const NORMALIZERS: Record<LabTargetKind, (value: string) => string | null> = {
  host: normalizeHost,
  network: normalizeNetwork,
  url: normalizeUrl,
  domain: normalizeDomain,
  email: normalizeEmail,
};

/** Canonical form of a target, or null when the value is not valid for its kind. */
export function normalizeTarget(kind: string, value: string): NormalizedTarget | null {
  if (!(LAB_TARGET_KINDS as readonly string[]).includes(kind)) return null;
  const normalized = NORMALIZERS[kind as LabTargetKind](value);
  return normalized === null ? null : { kind: kind as LabTargetKind, value: normalized };
}

/** Expand an IPv6 literal to its 8 hex groups (for prefix math). */
function expandV6(s: string): string {
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail === undefined ? [] : tail.split(":");
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  const groups = [...h, ...Array(Math.max(fill, 0)).fill("0"), ...t];
  // Each group is exactly 4 hex digits ("": "" .padStart(4,"0") === "0000") — a
  // shorter group would silently shrink the parsed BigInt and break v6 matching.
  return groups.map((g) => g.padStart(4, "0")).join("");
}

/** True when `ip` sits inside `cidr` (v4 and v6; mixed families are false). */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [net, prefixStr] = cidr.split("/");
  const p = Number(prefixStr);
  const a = isIP(ip);
  const b = isIP(net);
  if (!a || !b || a !== b || !Number.isInteger(p)) return false;
  if (a === 4) {
    const toInt = (s: string) => s.split(".").reduce((acc, o) => acc * 256 + Number(o), 0);
    const mask = p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0;
    return ((toInt(ip) & mask) >>> 0) === ((toInt(net) & mask) >>> 0);
  }
  const toBig = (s: string) => BigInt(`0x${expandV6(s)}`);
  const mask = p === 0 ? BigInt(0) : ((BigInt(1) << BigInt(p)) - BigInt(1)) << BigInt(128 - p);
  return (toBig(ip) & mask) === (toBig(net) & mask);
}

/**
 * The pre-flight check: every requested target must normalise AND match a
 * fresh attested row (and, if the row is range-bound, the run's range).
 * Returns the normalised targets that may be used and the refused ones with
 * reasons. Never throws — the caller decides how a refusal is surfaced and
 * audited.
 */
export function preflightTargets(
  attested: AttestedRow[],
  targets: PreflightInput[],
  window: PreflightWindow = {},
): { kept: NormalizedTarget[]; pruned: PreflightIssue[] } {
  const now = window.now ?? new Date();
  const maxAgeMs = (window.maxAgeDays ?? LAB_ATTESTATION_MAX_AGE_DAYS) * 86_400_000;
  const kept: NormalizedTarget[] = [];
  const pruned: PreflightIssue[] = [];
  for (const t of targets) {
    const norm = normalizeTarget(t.kind, t.value);
    if (!norm) {
      pruned.push({ kind: t.kind, value: t.value, reason: "not_normalized" });
      continue;
    }
    const row = attested.find((r) => r.kind === norm.kind && r.value === norm.value);
    if (!row) {
      pruned.push({ kind: norm.kind, value: norm.value, reason: "unattested" });
      continue;
    }
    if (now.getTime() - row.attestedAt.getTime() > maxAgeMs) {
      pruned.push({ kind: norm.kind, value: norm.value, reason: "stale_attestation" });
      continue;
    }
    if (row.rangeId && window.rangeId && row.rangeId !== window.rangeId) {
      pruned.push({ kind: norm.kind, value: norm.value, reason: "range_mismatch" });
      continue;
    }
    if (!kept.some((k) => k.kind === norm.kind && k.value === norm.value)) kept.push(norm);
  }
  return { kept, pruned };
}

