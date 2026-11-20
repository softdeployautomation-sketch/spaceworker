# Cyber Lab Acceptable-Use Policy (AUP) — v2026-10-02 (DRAFT for lawyer review)

> **Status: DRAFT.** This is the text that goes to the lawyer (PLAN_TASK_156 §7 C0/C6).
> Do NOT bump `AdminSetting.cyberlabConsentTermsVersion` to a new value until that
> review returns.

> **Single source of truth:** `lib/lab/aup.ts` (`CYBERLAB_AUP_SECTIONS`,
> `canonicalAupText()`). This doc is a rendered copy for reviewers who read markdown;
> the onboarding screen (`components/cyberlab-aup.tsx`) and the consent hash
> (`LabConsent.hash` via `lib/lab/consent.ts`) both read that module, so the wording
> a user accepts and the wording hashed into their consent row can never drift. If
> this doc and that module ever disagree, the module wins and this doc gets fixed.

## Cyber Lab Acceptable-Use Policy v2026-10-02

*Last updated: 2 October 2026*

### 1. What the Cyber Lab is

The Cyber Lab runs offensive and defensive security tooling to simulate real-world
attacks against systems you own or are explicitly authorised to test, and to train
your team's defences. Every run is recorded as an evidence-trailed episode.

It exists so you can see what an attacker would do to your own environment, and
what a defender would see — not to attack anyone else.

### 2. Authorized targets only

You may only point a lab run at a target that you have added to your attested
inventory and that you own or have written permission to test. You must be able to
produce that authorisation on request.

The lab refuses any target that is not in your attested inventory, before anything
runs. Cloud, CDN and third-party ranges are refused by policy. A refusal is
logged, and repeated attempts to reach non-attested space can freeze your account
automatically.

Never target a third party, a public IP range, or infrastructure you do not
control — even to 'test' it.

### 3. What is never allowed (hard lines)

No targeting of third parties. No mass internet scanning. No spam, phishing or
fraud aimed at anyone outside your own organisation's consenting, attested
recipients. No spoofing of domains you do not control.

No ransomware-class or otherwise destructive payloads outside a disposable,
isolated lab range. No tooling whose only purpose is to harm others.

These limits are not configurable and are the same for every tier. Violating them
is a breach of this policy and of the Terms of Service, and will end your access.

### 4. The abuse sentinel watches every run

Full capability is only offered because every run is monitored: targets are
checked against your attested inventory, egress is monitored against the scenario
allowlist, request intent is classified before execution, and velocity/pattern
anomalies are scored.

A refusal or anomaly creates an abuse report, notifies the platform operator with
an evidence bundle attached, and may freeze your account. A frozen account can be
appealed for human review.

### 5. Evidence, audit and no history deletion

Episodes are signed and the audit trail is append-only. Your consent record is
never edited, only superseded by a newer version. There is deliberately no
'delete history' path.

This protects you as much as us: it is the record that shows exactly what was
run, against what, and by whom.

### 6. Cooperation with law enforcement

If an abuse report, complaint or lawful request arrives about lab activity on your
account, we will disclose the relevant records — targets, timings, evidence — to
law enforcement or to a party alleging harm, when legally required or when we
determine in good faith it is necessary to prevent serious harm or comply with
the law.

Do not use the Cyber Lab for anything you would not be willing to explain to the
authorities.

### 7. Your responsibility and enforcement

You are responsible for the targets you attest to and the runs you start. Access
may be suspended or terminated, without notice, if we reasonably believe you have
breached this policy — including while we investigate a report. A terminated
account found to have breached this policy is not entitled to a refund.

By accepting, you confirm you have read this policy, that any target you attest
to is yours or authorised, and that you accept these limits.

---

## How consent is recorded (C0 gate)

Acceptance is an append-only `LabConsent` row: `(userId, termsVersion, scope,
ip, hash)` where `hash = sha256(userId:termsVersion:canonicalAUPtext)`. The gate
(`lib/lab/gate.ts`) only honours consent for the CURRENT
`AdminSetting.cyberlabConsentTermsVersion`, so bumping that dial forces
re-acceptance. There is no update or delete — only a newer version supersedes.

Gating order (PLAN_156 §12.9, BINDING): the lab opens only when the platform
switch is on AND the user holds the PREMIUM `cyberlab` entitlement AND they have
accepted the current AUP. There is no staff badge and no staff gate in
SpaceWorker. Accepting this DRAFT text is not legal advice and does not by itself
authorise a customer-facing offensive run — that waits on the lawyer's sign-off
and the §5.2 sentinel (C2+/C6).
