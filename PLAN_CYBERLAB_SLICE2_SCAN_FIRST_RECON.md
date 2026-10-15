# PLAN — CyberLab Slice 2: Scan-first recon (no attested device required)

Status: **BUILDING — owner approved Slice 2 (PLAN_CYBERLAB_V2_EXPECTED_OUTCOME.md §6 gate 2).**
Written 2026-10-14. Playbook: `HOW_WE_MOVE_FAST.md`. Prior: `PLAN_CYBERLAB_V2_EXPECTED_OUTCOME.md`, `TASK_156B_CYBERLAB_STANDALONE_UI_STEPS.md`.

---

## 0. The expected outcome (owner's words)

> "no real world attack start with an attested device, they start with different planning on how to break in. so we need to be able to break in in different ways, record those break in and then we can plan a secure flow for such not to happen to us"
>
> "the initial plan is to be able to run scans, look for vulnerabilities first before we can then use the agent as a simulation"

CyberLab's first step must be **scan-first recon**: declare a scope you're authorized to test, *find* the attack surface — **without** first owning/attesting a device. The attested-device agent-as-malware simulation (smoke) stays, but is no longer the *only* way in.

## 1. The honest scope of "scan" today (do NOT overclaim)

**The platform is dry-run only.** `lib/lab/runner.ts` generates SYNTHETIC telemetry; no packet leaves the platform. Real scanning is C2b (owner infra / owned metal). So Slice 2 delivers a **simulated recon phase** that:

- Runs WITHOUT a pre-attested device (the whole point of gate 2).
- Produces a **signed, synthetic, clearly-labelled** recon evidence bundle (`synthetic: true`, `mode: "dry-run"`), exactly like the smoke scenario.
- Is gated by the SAME §12.9 door (enabled + `cyberlab` entitlement + current-AUP consent) — unchanged.
- Records the declared scope in the signed episode (auditable).

Nothing here is a "real scan." The UI and artefacts say so, in the same words the smoke scenario already uses. This is the foundation for the later real-scan (C2b) and agent-sim phases.

## 2. Confirmed codebase facts (real reads, 2026-10-14)

- **The gate to relax** is `preflightRunTargets` (engine step 4) — today every target must match a FRESH attested `LabTarget` row or the run is refused (403 + `LabAbuseReport`). `lib/lab/engine.ts:70`.
- **Scenario is the clean seam.** `startLabRun` already branches on `slug === SMOKE_SCENARIO_SLUG` (engine.ts:39). A recon scenario with `klass: "recon"` lets me branch cleanly and leave the attested smoke path byte-for-byte unchanged.
- **Scenario allow-list** = `getEnabledScenarios` (db rows). `ensureSmokeScenario()` self-heals one row (scenarios.ts:19); the scenarios route calls it (route.ts:19). I add `ensureReconScenario()` the same way.
- **Runner contract**: `generateSmokeTelemetry` returns `{ artefacts, timeline, techniques, telemetrySignatures }` and THROWS if synthetic telemetry references a non-declared value (runner.ts:98). Recon reuses this exact hard line.
- **Range lifecycle / episode / teardown** (steps 5,7,8) are shared and unchanged — recon runs are first-class signed episodes.
- **Console**: `start(slug)` requires selected attested targets (cyberlab-ops-console.tsx:337-343); scenarios render one "Start" button each (line ~638). I add a scan-first section that declares scope inline, no attested selection.
- **No schema migration.** Recon reuses `LabScenario` (klass "recon") + the existing range/episode/abuse tables. The deploy still needs the earlier `sourceDeviceId` db push, but Slice 2 adds no new column.

## 3. Build (this turn)

Pure + db halves, mirroring the existing `targets-core.ts` (pure) / `targets.ts` (db) split:

1. **`lib/lab/recon-core.ts`** (pure, no server-only) — `RECON_TECHNIQUE_IDS`, `RECON_SIGNATURE_IDS`, `RECON_MIN_NETWORK_PREFIX`, and `validateReconScope(targets) → { kept, invalid, tooBroad }`. Normalizes each target (reuse `normalizeTarget`); rejects non-normalizable (`invalid`); rejects a `network` kind broader than `RECON_MIN_NETWORK_PREFIX` (`tooBroad` — the "no unscoped scanning of third parties" guard, a documented policy constant); collapses duplicates.
2. **`lib/lab/recon-runner.ts`** (pure) — `generateReconTelemetry({ rangeId, scenarioSlug, targets, startedAt, endedAt }) → SmokeTelemetry`-shaped. Synthetic `surface.json` (enumerated surface per declared target) + `detections.json`; timeline `range.created → recon.scope_declared → recon.host_enumerated(×targets) → detection.synthetic_trip → range.destroyed`. Hard line: THROWS if any emitted value is outside the declared set.
3. **`lib/lab/scenarios.ts`** — `RECON_SCENARIO_SLUG = "recon-attack-surface"`, `ensureReconScenario()` (idempotent upsert, `klass: "recon"`, blast radius = "None — simulated recon; no packet leaves the platform").
4. **`lib/lab/engine.ts`** — recon branch: when `scenario.klass === "recon"`, run `validateReconScope` instead of attested `preflightRunTargets`; `invalid` → `LabRunRefusedError` (validation, no abuse report — matches the attest boundary note); `tooBroad` → `LabAbuseReport` (reason `recon_scope_refused`, low) + `TargetRefusedError` (403). Then `generateReconTelemetry`. Everything else (gate, caps, governor, range, episode, teardown) is shared and unchanged.
5. **`app/api/cyberlab/scenarios/route.ts`** — also `await ensureReconScenario()` so recon is always available.
6. **`components/cyberlab-ops-console.tsx`** — a "Scan-first recon" section (scope kind + value input + "Run recon (simulated)" button) that POSTs the declared scope to `/api/cyberlab/runs` with the recon slug; attested scenarios stay in their own section. Honest copy: simulated, no device needed, nothing leaves the platform.
7. **`tests/lab-recon.test.ts`** — pure tests (`validateReconScope`, `generateReconTelemetry` hard line) + engine integration (recon runs to a signed episode WITHOUT any attested target; smoke STILL requires attestation; too-broad scope refused + audited). Wired into `package.json` `test:lab`.

## 4. Hard lines (carried, unchanged)

- Nothing on screen moves unless a real event moved it. Rings are layout, not latency.
- `signatureValid` is always server-recomputed from the stored row.
- `SIMULATION · YOUR EQUIPMENT` watermark on every panel.
- **Scan-first safety:** recon is non-invasive and simulated today; a `network` scope may not be broader than `RECON_MIN_NETWORK_PREFIX` (no unscoped scanning of third parties); the moment anything touches a real host (C2b) it re-enters attested-target + verified-teardown.
- The attested-device smoke path is untouched — attested runs still require a fresh attested `LabTarget`.
- Local commit on `main` only; no push / no deploy. Zero file overlap with the hosting agent except none here (Slice 2 touches only cyberlab-scoped files).

## 5. Gates

`tsc --noEmit` 0 · eslint on changed files 0 · `npm run test:lab` green (was 57). Local commit only.

