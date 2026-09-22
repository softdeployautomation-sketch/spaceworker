# PLAN — Task 91: Cyber Lab — red-team features, attack/defense training ground, usage policy

> **⚠️ SUPERSEDED 2026-09-22 — merged into `PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md`
> (lab starts on personal VMs, staff-badge live access, customer no-egress
> fences deferred to L4; training moved to the LATER plan). Do not build
> from this file.**

**Status: draft for owner review — not started.**
**Date drafted: 2026-09-22.**
**Owner's one-line version:** give SpaceWorker real features + extensions for
cybersecurity users and red teams, build a mechanism to test attacks on VMs,
learn from it, and defend SpaceWorker users with what we learn — so users can
use SpaceWorker as both a **defending and an attack training ground**.

**Companion plans:** `PLAN_TASK_89_DEVICE_AI_AGENT.md` (agent surface the lab
feeds findings into), `PLAN_TASK_90_OWN_AI_MODEL_AND_AGENT.md` (the lab is the
biggest producer of training data for our model).

---

## 1. Why this is a strong product (and why it must be built carefully)

- SpaceWorker already has device trust (EXE), remote control (Vantra), an
  AI agent with a human gate, and admin visibility. That is 80% of a managed
  detection-and-response posture — the missing piece is **reliable knowledge
  of how attacks actually happen**, which only comes from running them.
- Red teams and defenders today duct-tape separate tools (C2, emulation
  platforms, SIEMs, report editors). A product where the same platform runs
  the attack range, records the episode, writes the report, and ships the
  resulting detections to real endpoints is a category nobody ships end-to-end.
- The training-data flywheel is unique to us: every lab episode becomes
  fine-tuning data (Task 90) and every validated detection ships to users
  (Task 89 Phase F toolbelt).

## 2. Research anchors (verified 2026-09-22)

| Project | License | Role in our lab |
|---|---|---|
| **MITRE Caldera** (now under the Apache org, v5.1.0+) | Apache-2.0 | **The attack engine.** Automated adversary emulation on ATT&CK, async C2 + REST API, plugin system (Atomic Red Team). Its own docs warn the UI is not hardened for exposure (and it had CVE-2025-27364) — this plan keeps it isolated, per §4 |
| **Atomic Red Team** | (bundled w/ Caldera) | Baseline scenario library: atomic tests mapped to ATT&CK techniques |
| **CAI** (Alias Robotics, archived 2026-08-28) | MIT core + proprietary extras | Agent *patterns* only: recon/exploit/report agent roles, and their lesson that agents must be bounded per-phase — our lab agent orchestrates Caldera via its REST API rather than free-forming commands |
| **Vantra RMM** | ours | The **defense telemetry collector**: victim VMs in the lab run the Vantra agent, so every attack is observed with exactly the telemetry real users emit — what the lab teaches transfers directly to what we can detect for users |

## 3. Product shape

**A. For SpaceWorker defenders (all users):**
- Lab-validated **detection packs**: when an episode demonstrates technique T,
  we derive a detection (Sigma-class rule / hardening task) and ship it
  through the Task 89 security toolbelt as a runnable check, plus "you are
  exposed to T" findings in the weekly security digest.
- **Attack-story digests**: plain-language "here is how this attack would hit
  a PC like yours, and what it would look like" — powered by our model (Task 90).

**B. For red teams / security pros (pro tier):**
- Scenario catalogs (ATT&CK-mapped), one-click emulation against **their
  authorized ranges**, episode timelines, IOC packs, auto-generated findings
  reports with retest tracking, exportable MITRE coverage matrices.
- Integration points SpaceWorker already has: `browser-server` automation
  (social-engineering-adjacent simulation is OUT of scope — see §4),
  mailbox infra (phishing simulation *only* inside a user-attested range).

**C. Attack training ground (the new surface):**
- Per-user disposable lab ranges: the user picks a scenario ("Kerberoast
  101", "RDP lateral movement", "ransomware staging"), SpaceWorker spins
  isolated VMs, the user (or our guided agent) attacks, then gets scored
  output + narration + the matching defense lesson.
- Guided mode: our agent walks beginners through each step, explains the
  telemetry each step produces, then flips to the defender view. This is
  the demo that sells.

## 4. Usage policy & abuse controls (scoped BEFORE the lab ships — non-negotiable)

1. **Isolation is absolute:** lab networks have no internet egress by default;
   Caldera/agents live on a dedicated lab host, never the production VPS
   (Caldera is explicitly not hardened for exposure). Allow-list egress only
   if a scenario needs package fetches, via a fully logged proxy.
2. **Authorization attestation:** every range run requires the user's signed
   attestation that all targets are theirs/authorized; recorded immutably
   (`LabConsent`); commercial scenarios gated to a vetted pro tier.
3. **Hard technical fences:** no scenario primitives for attacking third
   parties (no spam/fraud tooling, no mass-scanning public ranges, no
   ransom-deployment payloads — staging/encryption drills only inside the
   range, destructive payloads simulated). Scenario catalog is allow-listed;
   free-form commands exist only inside disposable range VMs.
4. **Tenant isolation:** a user's range VMs are cryptographically theirs
   (per-range creds), torn down on schedule (default TTL 24h), zero
   cross-user reachability.
5. **Audit everything:** every scenario start/stop, every egress, every agent
   command — append-only, admin-visible; panic switch freezes all ranges.
6. **ToS + AUP page:** the attack surface is a *training ground on machines
   SpaceWorker/the user owns*; a lawyer-reviewed AUP is a launch blocker
   for Phase C/D, not an afterthought.
7. **Model/agent guardrails (ties to Task 90):** cyber-agent prompts and
   tool schemas enforce the fence rules; refusal paths logged; no customer
   data in lab prompts.

## 5. Architecture

```
[SpaceWorker web] --(scenario mgmt, reports, tiers)--> [Lab API (lab host)]
                                                          |
                      +-----------------------------------+------------------+
                      |                                   |                  |
               [Caldera (Apache-2.0)]              [Victim VM pool]     [Range router]
                ATT&CK emulation, REST           Vantra agent inside,     isolated VLANs,
                driven by our agent              telemetry captured       no egress
                                                          |
                                            [Episode recorder -> findings]
                                               |                  |
                                     [Detection pack build]  [Training data -> Task 90]
```

- **Lab host options (Q1):** (a) rented GPU box shared with Task 90 (runs
  ranges when not training — cheap start, single bill), (b) dedicated
  Proxmox box (better isolation, one-time cost), (c) cloud burst per run.
  Recommendation: (a) to start; move to (b) when concurrency demands.
- The episode recorder normalizes Caldera ops + Vantra telemetry into
  `LabEpisode` (timeline, techniques, telemetry signatures, outcome,
  narration) — the artifact every other feature consumes.

## 6. Schema additions (draft)

- `LabScenario` (slug, name, attckTechniques[], difficulty, tier, packRef)
- `LabRange` (userId, scenarioId, state, ttl, networkId, createdAt)
- `LabEpisode` (rangeId, timeline Json, telemetrySignatures Json, outcome, narration)
- `LabFinding` (episodeId, techniqueId, detectionRef, severity)
- `DetectionPack` (version, rules Json, scenariosCovered[], shippedTo)
- `LabConsent` (userId, rangeId, attestation, ip, userAgent, signedAt)
- Extend Task 89's `AgentPendingAction.kind` with "lab-action" (gated like everything else).

## 7. Phased delivery

### Phase A - Lab foundation (backend only)
- A1: Stand up lab host + VLAN isolation + egress proxy with logging.
- A2: Caldera deployed (hardened config, token auth), smoke-tested against a
  throwaway VM running the Vantra agent.
- A3: Episode recorder v1: Caldera REST + telemetry -> `LabEpisode`.
- **Exit:** one scenario ("password spraying vs a lab VM") runs end-to-end
  and produces a coherent episode report.

### Phase B - From episode to defense
- B1: Detection derivation workflow: episode -> candidate rule -> validated
  against the episode telemetry -> `DetectionPack` v1.
- B2: Ship the pack through Task 89's toolbelt (checks + digest) to devices.
- **Exit:** what the lab teaches reaches real users as working checks.

### Phase C - Cyber Lab UI + pro tier
- C1: SpaceWorker "Cyber Lab" section: scenario catalog, run/stop, live
  timeline, episode report, exports (IOC/Markdown).
- C2: Entitlements: pro tier flag, attestation flow, TTL enforcement.
- **Exit:** red-team users can run authorized scenarios and export reports.

### Phase D - Attack training ground (self-serve)
- D1: Disposable per-user ranges (templates, TTL, scoring).
- D2: Guided mode: agent narrates each step, then flips to the defender view.
- D3: Light progress/gamification (optional).
- **Exit:** a beginner goes from "what is kerberoasting" to "I did it, here's
  how I'd detect it" inside SpaceWorker.

### Phase E - Flywheel
- E1: Episode -> training-data pipeline feeding Task 90 Phase D.
- E2: Monthly "new scenario + new detection" release cadence as marketing.

## 8. Open questions for the owner

- Q1: Lab host — shared GPU rental to start (recommended), dedicated Proxmox
  box, or cloud burst? (Budget + where the hardware lives.)
- Q2: Launch tier structure — which scenarios are free / pro / vetted-pro?
- Q3: Phishing-simulation scenarios: include (mailbox infra exists) or
  exclude from v1 regardless of the policy page? (Sensitivity call.)
- Q4: Legal review of AUP + attestations before Phase C — who signs off?
- Q5: Is "user attacks their own VMs" the ceiling, or do we ever host
  shared/community ranges (more marketing, more policy surface)?

## 9. Suggested first slice

Phase A only (A1–A3): isolated lab host + Caldera + one scenario + episode
recorder. No user-facing surface, no spend beyond the lab host — and it
immediately starts producing episodes that feed Task 90's training and Phase
B's detection packs. The policy doc (§4) is drafted in parallel so Phases
C/D launch with the fences already in place.


