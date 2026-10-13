// TASK_156 C2a (PLAN_TASK_156 §7 C2 item 2, §5.2 lines 1–3) — the db-backed
// half of pre-flight: loads the user's attested inventory, runs the pure check
// (lib/lab/targets-core.ts), and — on any refusal — writes the immutable
// `LabAbuseReport` before refusing. §5.2 is explicit that the refusal path is
// part of the safety story: "record EVERY refusal — who, what, when, where
// from, why — via LabAbuseReport". A silent 403 would lose that trail.
//
// Boundary note: a VALUE that fails normalisation at ATTEST time is a plain
// validation error (400), not abuse — nobody was refused a run yet. The audit
// trail fires when a run is refused (unattested/stale/mismatched targets),
// which is the sentinel's job.
//
// Honest limit: attestation is a DECLARATION by the operator that they own /
// are authorised for the asset ("I attest I own or am authorized...", C0 AUP).
// C2a cannot verify ownership of an arbitrary address from the platform side —
// that verification exists only inside the lab ranges (C2b). This is stated in
// the AUP and is one reason the run itself is confined to the range.

import "server-only";

import { db } from "@/lib/db";
import {
  LAB_ATTESTATION_MAX_AGE_DAYS,
  normalizeTarget,
  preflightTargets,
  type NormalizedTarget,
  type PreflightInput,
  type PreflightIssue,
} from "./targets-core";

export {
  LAB_ATTESTATION_MAX_AGE_DAYS,
  ipInCidr,
  normalizeTarget,
  preflightTargets,
} from "./targets-core";
export type {
  AttestedRow,
  LabTargetKind,
  NormalizedTarget,
  PreflightInput,
  PreflightIssue,
  PreflightRefusalReason,
} from "./targets-core";

/** Thrown when a run's targets fail pre-flight; the refusal is already audited. */
export class TargetRefusedError extends Error {
  readonly issues: PreflightIssue[];
  constructor(message: string, issues: PreflightIssue[]) {
    super(message);
    this.name = "TargetRefusedError";
    this.issues = issues;
  }
}

/** The user's attested inventory, newest attestation first. */
export async function listLabTargets(userId: string) {
  return db.labTarget.findMany({ where: { userId }, orderBy: { attestedAt: "desc" } });
}

/**
 * Attest (or re-attest) one target. Normalisation happens here so the stored
 * value IS the canonical form the pre-flight matches against. Invalid values
 * are a validation error, never an audit event (see boundary note above).
 */
export async function attestTarget(input: { userId: string; kind: string; value: string }) {
  const norm = normalizeTarget(input.kind, input.value);
  if (!norm) throw new Error(`invalid_target (${input.kind}: ${input.value})`);
  const now = new Date();
  return db.labTarget.upsert({
    where: { userId_kind_value: { userId: input.userId, kind: norm.kind, value: norm.value } },
    update: { attestedAt: now },
    create: { userId: input.userId, kind: norm.kind, value: norm.value, attestedAt: now },
  });
}

/**
 * Pre-flight a run: every target must match a FRESH attested row for this
 * user (bound to this range when the row is range-bound). Any refusal writes
 * one `LabAbuseReport` (reason `preflight_target_refused`, severity medium,
 * evidence = what was requested vs why each was pruned, plus the caller's
 * source ip when known) and throws `TargetRefusedError`.
 */
export async function preflightRunTargets(params: {
  userId: string;
  rangeId: string | null;
  targets: PreflightInput[];
  sourceIp?: string | null;
}): Promise<NormalizedTarget[]> {
  const rows = await db.labTarget.findMany({ where: { userId: params.userId } });
  const { kept, pruned } = preflightTargets(
    rows.map((r) => ({ kind: r.kind, value: r.value, rangeId: r.rangeId, attestedAt: r.attestedAt })),
    params.targets,
    { rangeId: params.rangeId },
  );
  if (pruned.length > 0) {
    await db.labAbuseReport.create({
      data: {
        userId: params.userId,
        rangeId: params.rangeId,
        reason: "preflight_target_refused",
        severity: "medium",
        evidenceJson: {
          requested: params.targets.map((t) => ({ kind: t.kind, value: t.value })),
          pruned: pruned.map((p) => ({ kind: p.kind, value: p.value, reason: p.reason })),
          sourceIp: params.sourceIp ?? null,
          at: new Date().toISOString(),
        },
      },
    });
    throw new TargetRefusedError(
      `target pre-flight refused: ${pruned.map((p) => `${p.value} (${p.reason})`).join(", ")}`,
      pruned,
    );
  }
  return kept;
}
