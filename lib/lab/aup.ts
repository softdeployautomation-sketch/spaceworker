// TASK_156 C0 (PLAN_TASK_156 §7 C0) — the Cyber Lab Acceptable-Use Policy / consent
// text.
//
// The owner's rule (§7 C0): "Nothing runs before this exists." This module is the
// VERSIONED AUP text the onboarding screen shows and that `LabConsent` records
// acceptance of. The version string MUST match
// `AdminSetting.cyberlabConsentTermsVersion` (default "2026-10-02"): bumping that
// dial forces every user to re-accept, because consent is recorded per
// (userId, termsVersion) and the gate only honours the CURRENT version.
//
// Pure constants (no server-only import) so both the server gate
// (lib/lab/gate.ts) and the onboarding client component
// (components/cyberlab-aup.tsx) read the SAME text — the acceptance can never be
// against a re-worded copy.
//
// HONEST LIMIT (§12.9 + §8): premium gating is AUTHORIZATION HYGIENE, not a legal
// fence. This AUP is the fence, and PLAN_TASK_156 requires a lawyer's sign-off on
// the text before any offensive run is customer-facing. This text is the DRAFT that
// goes to the lawyer; do not bump `cyberlabConsentTermsVersion` to a new value
// until that review returns.

/** The AUP version the C0 gate enforces. Mirrors AdminSetting.cyberlabConsentTermsVersion. */
export const CYBERLAB_AUP_VERSION = "2026-10-02";

export const CYBERLAB_AUP_TITLE = "Cyber Lab Acceptable-Use Policy";

/** Shown next to the version stamp everywhere the AUP is surfaced. */
export const CYBERLAB_AUP_UPDATED = "Last updated: 2 October 2026";

export interface AupSection {
  heading: string;
  /** Each entry is one paragraph. */
  body: string[];
}

// Plain-language, deliberate. Every "hard line" from PLAN_TASK_156 §5.2 and §12
// appears here verbatim in spirit, because a refusal the user can read in advance
// is the point (§12.6: "a refused target shows why").
export const CYBERLAB_AUP_SECTIONS: AupSection[] = [
  {
    heading: "1. What the Cyber Lab is",
    body: [
      "The Cyber Lab runs offensive and defensive security tooling to simulate real-world attacks against systems you own or are explicitly authorised to test, and to train your team's defences. Every run is recorded as an evidence-trailed episode.",
      "It exists so you can see what an attacker would do to your own environment, and what a defender would see — not to attack anyone else.",
    ],
  },
  {
    heading: "2. Authorized targets only",
    body: [
      "You may only point a lab run at a target that you have added to your attested inventory and that you own or have written permission to test. You must be able to produce that authorisation on request.",
      "The lab refuses any target that is not in your attested inventory, before anything runs. Cloud, CDN and third-party ranges are refused by policy. A refusal is logged, and repeated attempts to reach non-attested space can freeze your account automatically.",
      "Never target a third party, a public IP range, or infrastructure you do not control — even to 'test' it.",
    ],
  },
  {
    heading: "3. What is never allowed (hard lines)",
    body: [
      "No targeting of third parties. No mass internet scanning. No spam, phishing or fraud aimed at anyone outside your own organisation's consenting, attested recipients. No spoofing of domains you do not control.",
      "No ransomware-class or otherwise destructive payloads outside a disposable, isolated lab range. No tooling whose only purpose is to harm others.",
      "These limits are not configurable and are the same for every tier. Violating them is a breach of this policy and of the Terms of Service, and will end your access.",
    ],
  },
  {
    heading: "4. The abuse sentinel watches every run",
    body: [
      "Full capability is only offered because every run is monitored: targets are checked against your attested inventory, egress is monitored against the scenario allowlist, request intent is classified before execution, and velocity/pattern anomalies are scored.",
      "A refusal or anomaly creates an abuse report, notifies the platform operator with an evidence bundle attached, and may freeze your account. A frozen account can be appealed for human review.",
    ],
  },
  {
    heading: "5. Evidence, audit and no history deletion",
    body: [
      "Episodes are signed and the audit trail is append-only. Your consent record is never edited, only superseded by a newer version. There is deliberately no 'delete history' path.",
      "This protects you as much as us: it is the record that shows exactly what was run, against what, and by whom.",
    ],
  },
  {
    heading: "6. Cooperation with law enforcement",
    body: [
      "If an abuse report, complaint or lawful request arrives about lab activity on your account, we will disclose the relevant records — targets, timings, evidence — to law enforcement or to a party alleging harm, when legally required or when we determine in good faith it is necessary to prevent serious harm or comply with the law.",
      "Do not use the Cyber Lab for anything you would not be willing to explain to the authorities.",
    ],
  },
  {
    heading: "7. Your responsibility and enforcement",
    body: [
      "You are responsible for the targets you attest to and the runs you start. Access may be suspended or terminated, without notice, if we reasonably believe you have breached this policy — including while we investigate a report. A terminated account found to have breached this policy is not entitled to a refund.",
      "By accepting, you confirm you have read this policy, that any target you attest to is yours or authorised, and that you accept these limits.",
    ],
  },
];

/**
 * The canonical, hashed form of the AUP text for a given version — the exact string
 * `LabConsent.hash` is computed over (together with userId + termsVersion) so the
 * text a user accepted is provable even after the wording is later revised.
 *
 * Deterministic: version + headings + bodies, newline-joined, no locale-dependent
 * formatting. Two callers of the same version always get byte-identical output.
 */
export function canonicalAupText(version: string = CYBERLAB_AUP_VERSION): string {
  const lines: string[] = [`${CYBERLAB_AUP_TITLE} v${version}`];
  for (const section of CYBERLAB_AUP_SECTIONS) {
    lines.push("", section.heading);
    for (const para of section.body) lines.push(para);
  }
  return lines.join("\n");
}
