# Task 98 — Cyber Lab staff track (L1–L3) + Michael MT-2/MT-3 contracts

**Status: READY TO BUILD — TASK_93 (Vantra plugin) is DONE, deployed +
live-verified 2026-09-22, so victim VMs can run the real Vantra agent now.
Not started as of 2026-09-27. Tracked separately from the self-hosted
project (own branch, own priority — see below); does not block or get
blocked by it.**
**Plan: `PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md` §CYBER LAB TRACK (L1–L3), §FINALIZED DECISIONS M5, §L4 (2026-09-27 ID-verification refinement).**

## Owner re-confirmation (2026-09-27)

Re-affirms this task's existing scope, no redesign needed:
- SpaceWorker's own servers still can't host isolated attack-lab
  infrastructure — L1's "personal VMs" constraint (owner's LAN box + spare
  VPS) is the real, current state, not a placeholder. Users/staff bring
  their own VMs; SpaceWorker ships the tooling + orchestration, not the
  hardware.
- The goal explicitly framed by the owner: attackers already have and will
  always have these tools regardless of whether we build this — the value
  SpaceWorker adds is giving defenders (and our own detection pipeline) the
  SAME real staging knowledge attackers use, so we can defend what we
  otherwise wouldn't know to look for. This is the "why" to keep front-of-mind
  when scoping which scenarios/tools are worth building first — breadth of
  real current attack stages/techniques matters more here than polish.
- Full tool provisioning is deliberately unrestricted for this dev phase
  (staff-only, per L2) — the owner explicitly does NOT want the eventual
  user-facing access gate (ID verification, see plan §L4) designed or built
  yet. Build the real tools first; scope gating once there's something worth
  gating.

## Future: L4 access tiers (do not build yet — tracked here for continuity)

When this moves beyond staff-only, the plan's L4 section (updated
2026-09-27) splits access into two tiers instead of one attestation
checkbox:
- **Attestation-gated** (lighter): attack-story digests, detection-pack
  consumption, guided narrated scenario walkthroughs, MITRE coverage
  reports.
- **ID-verification-gated** (stricter): anything that hands the user a
  working attack primitive — real exploit tooling, live C2 against their
  own range, free-form Caldera command access. Rationale: accountability,
  not prevention — a bad actor can get these tools elsewhere regardless, but
  a verified identity means SpaceWorker can trace and act on misuse.
- The verification mechanism itself (provider, exact unlock boundary,
  ID-data retention/privacy handling, appeals/revocation) is intentionally
  UNSCOPED until L1–L3 produce a real tool set — that's its own future task,
  not part of this one.

## Read first (mandatory)
- **`HOW_WE_MOVE_FAST.md`** §0–§3 (as TASK_92) — lab hosts are personal VMs (`myrat@192.168.0.103` VM + spare VPS), NOT the production VPS.
- **`PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md`** §CYBER LAB TRACK, §SCHEMA (`LabScenario`/`LabRange`/`LabEpisode`/`LabFinding`/`DetectionPack`/`LabConsent`), M5.
- **MITRE Caldera** (Apache-2.0, v5.1.0+): REST API + agent model. Its docs warn the UI is not internet-hardened — staff-track only, auth on, never the prod VPS.

## Goal
Internal staff-only attack lab on personal VMs: run real scenarios, record episodes, derive detection packs shipped to users. Training is explicitly OUT (LATER plan) — episodes are stored structured for it.

## Deliverables
1. **L1 Lab foundation**: Caldera deployed on a lab host (hardened config, token auth) driving victim VMs that run the Vantra agent; episode recorder → `LabEpisode` (timeline, techniques, telemetry signatures, outcome).
2. **L2 Staff badge**: SpaceWorker-side staff flag (mirror of Vantra's admin pattern) grants full lab access; everything audited; panic switch freezes all ranges; no customer data on lab VMs.
3. **L3 Detection pipeline**: episode → candidate rule (Sigma-class) → validate against episode telemetry → `DetectionPack` → surfaced via the Assistant security toolbelt (digest + checks) to real users.
4. **Migration**: `LabScenario`, `LabRange`, `LabEpisode`, `LabFinding`, `DetectionPack`, `LabConsent` + `AgentPendingAction` kind "lab-action" (lab runs are gated like everything else).
5. **Admin limits (CROSS-TRACK RULE 7):** lab VMs + Caldera are RAM consumers on lab hosts — concurrent ranges, concurrent Caldera runs, and per-staff range caps are AdminSetting keys surfaced in the admin panel with live counts. No hardwired limits.

## Michael MT-2 + MT-3 contracts (isolated build → owner integrates)
- **MT-2 Scenario pack**: 5 launch scenarios (ATT&CK-mapped Caldera adversary profiles + Atomic tests), e.g. password spraying, RDP lateral movement, persistence via run-keys, kerberoasting, ransomware staging. Deliverable: Caldera profiles (YAML) + per-scenario doc (expected telemetry the Vantra agent should emit, blast radius, cleanup). Repo: `michael-fork` branch `michael/cyber-lab-scenarios`, folder `michael/cyber-lab/scenarios/` + README per template.
- **MT-3 Detection derivation**: per scenario, a Sigma-class detection rule + a hardening check script (AV present, Defender status, open RDP, run-key persistence, SMB settings) — the checks become Task 89 toolbelt entries. Rules validated against episode telemetry before acceptance. Folder `michael/cyber-lab/detections/` + README per template.
- Both: no customer data, no third-party-attack primitives, scenarios only reference lab VMs (see plan L4 fences for the future customer track).

## Acceptance
- "Password spraying vs a lab VM" runs end-to-end: Caldera executes → Vantra agent telemetry captured → `LabEpisode` coherent → MT-3 rule validates → `DetectionPack` v1 ships to a test user's digest.
- Staff badge gates everything; panic switch halts a live range; `tsc --noEmit` clean; §2 deploy.
