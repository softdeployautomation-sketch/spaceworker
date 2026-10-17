// TASK_217 D2 — the run service: consent → execute the probe pack → judge →
// persist. This is the ONLY place the assembled script is ever sent to a
// device, and it is sent straight to the EXISTING `runCommandNow` (which
// enforces ownership via requireOwnedDevice and writes the customer-visible
// device_run_now audit row). The client never builds or ships the script.
//
// Consent: the LAN audit reuses the append-only `LabConsent` table with its
// OWN scope ("lan-audit"), so a lab consent does not silently grant an audit
// and vice versa. The check is scope-aware (lib/lab/consent.currentConsent is
// version-only, so we query the scoped row directly).

import "server-only";

import { db } from "@/lib/db";
import { runCommandNow } from "@/lib/device-tools";

import { judgeAudit, parseAuditOutput, type VerdictCard } from "./judge";
import { buildAuditScript } from "./probes";

/** The LabConsent.scope this feature records and requires. */
export const LAN_AUDIT_CONSENT_SCOPE = "lan-audit";

/** Thrown for the honest refusal paths; the route maps code → status. */
export class LanAuditRefusedError extends Error {
  constructor(
    public code: "consent_required" | "device_unreachable",
    message: string,
  ) {
    super(message);
    this.name = "LanAuditRefusedError";
  }
}

/** The user's lan-audit consent row (any terms version), or null. */
export async function lanAuditConsent(userId: string) {
  return db.labConsent.findFirst({
    where: { userId, scope: LAN_AUDIT_CONSENT_SCOPE },
    orderBy: { signedAt: "desc" },
    select: { id: true, termsVersion: true, signedAt: true },
  });
}

export interface LanAuditRunResult {
  auditId: string;
  verdict: string;
  worstSeverity: string;
  leakCount: number;
  passCount: number;
  infoCount: number;
  noData: boolean;
  cards: VerdictCard[];
  ranAt: Date;
}

/**
 * Run one audit: consent gate → build the pack server-side → execute via the
 * existing runCommandNow → parse the marker block → judge → persist run +
 * findings. A device that returns no marker block (offline, old agent) is
 * persisted as a `noData` run so the attempt is visible in history, not lost.
 */
export async function runLanAudit(opts: {
  userId: string;
  deviceId: string;
}): Promise<LanAuditRunResult> {
  const consent = await lanAuditConsent(opts.userId);
  if (!consent) {
    throw new LanAuditRefusedError("consent_required", "lan_audit_consent_required");
  }

  const script = buildAuditScript();

  let output: string | null;
  try {
    ({ output } = await runCommandNow({
      userId: opts.userId,
      deviceId: opts.deviceId,
      cmd: script,
      shell: "powershell",
      timeoutSeconds: 90,
      runAsUser: false,
    }));
  } catch (err) {
    // requireOwnedDevice / Vantra failures land here (offline, not owned, …).
    if (err instanceof Error && err.message === "not_found") {
      throw new LanAuditRefusedError("device_unreachable", "device_not_found");
    }
    throw new LanAuditRefusedError(
      "device_unreachable",
      err instanceof Error ? err.message.slice(0, 200) : "device_unreachable",
    );
  }

  const results = parseAuditOutput(output);

  if (!results) {
    // Honest no-data: persist the attempt (so history shows it ran) with zero
    // findings, and let the UI say "no audit data returned" rather than fake a
    // PASS.
    const audit = await db.securityAudit.create({
      data: {
        userId: opts.userId,
        deviceId: opts.deviceId,
        consentId: consent.id,
        verdict: "INFO",
        worstSeverity: "none",
        noData: true,
      },
      select: { id: true, createdAt: true },
    });
    return {
      auditId: audit.id,
      verdict: "INFO",
      worstSeverity: "none",
      leakCount: 0,
      passCount: 0,
      infoCount: 0,
      noData: true,
      cards: [],
      ranAt: audit.createdAt,
    };
  }

  const { cards, summary } = judgeAudit(results);

  const audit = await db.securityAudit.create({
    data: {
      userId: opts.userId,
      deviceId: opts.deviceId,
      consentId: consent.id,
      verdict: summary.leaks > 0 ? "LEAK" : summary.passes > 0 && summary.infos === 0 ? "PASS" : "INFO",
      worstSeverity: summary.worstSeverity,
      leakCount: summary.leaks,
      passCount: summary.passes,
      infoCount: summary.infos,
      // Persist the NORMALIZED, post-scrub probe results for transparency.
      rawJson: results as unknown as object[],
      noData: false,
    },
    select: { id: true, createdAt: true },
  });

  if (cards.length > 0) {
    await db.auditFinding.createMany({
      data: cards.map((c) => ({
        auditId: audit.id,
        probe: c.probe,
        title: c.title,
        verdict: c.verdict,
        severity: c.severity,
        evidence: c.evidence,
        remediation: c.remediation,
      })),
    });
  }

  return {
    auditId: audit.id,
    verdict: summary.leaks > 0 ? "LEAK" : summary.passes > 0 && summary.infos === 0 ? "PASS" : "INFO",
    worstSeverity: summary.worstSeverity,
    leakCount: summary.leaks,
    passCount: summary.passes,
    infoCount: summary.infos,
    noData: false,
    cards,
    ranAt: audit.createdAt,
  };
}
