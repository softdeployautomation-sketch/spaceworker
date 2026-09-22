# Task 98 — Cyber Lab staff track (L1–L3) + Michael MT-2/MT-3 contracts

**Status: ready to PLAN; build after TASK_93 (Vantra agents exist for victim VMs).**
**Plan: `PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md` §CYBER LAB TRACK (L1–L3), §FINALIZED DECISIONS M5.**

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

## Michael MT-2 + MT-3 contracts (isolated build → owner integrates)
- **MT-2 Scenario pack**: 5 launch scenarios (ATT&CK-mapped Caldera adversary profiles + Atomic tests), e.g. password spraying, RDP lateral movement, persistence via run-keys, kerberoasting, ransomware staging. Deliverable: Caldera profiles (YAML) + per-scenario doc (expected telemetry the Vantra agent should emit, blast radius, cleanup). Repo: `michael-fork` branch `michael/cyber-lab-scenarios`, folder `michael/cyber-lab/scenarios/` + README per template.
- **MT-3 Detection derivation**: per scenario, a Sigma-class detection rule + a hardening check script (AV present, Defender status, open RDP, run-key persistence, SMB settings) — the checks become Task 89 toolbelt entries. Rules validated against episode telemetry before acceptance. Folder `michael/cyber-lab/detections/` + README per template.
- Both: no customer data, no third-party-attack primitives, scenarios only reference lab VMs (see plan L4 fences for the future customer track).

## Acceptance
- "Password spraying vs a lab VM" runs end-to-end: Caldera executes → Vantra agent telemetry captured → `LabEpisode` coherent → MT-3 rule validates → `DetectionPack` v1 ships to a test user's digest.
- Staff badge gates everything; panic switch halts a live range; `tsc --noEmit` clean; §2 deploy.
