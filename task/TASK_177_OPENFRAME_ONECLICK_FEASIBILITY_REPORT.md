# TASK_177 — OpenFrame one-click carrier: FEASIBILITY SPIKE REPORT

**Date:** 2026-10-07 (Phase 2 appended same day)
**Scope:** Phase 1 was RESEARCH-SMALL (research + analysis only). **Phase 2 (owner-authorized): the binder + migration script** — built after the owner confirmed (a) dashboard access exists, (b) no EXE/MSI pipeline exists in this checkout — only the Vantra zip launcher — and (c) the zip is explicitly NOT wanted here: bind the OpenFrame command into ONE file (EXE/VBS/MSI preferred, zip only as fallback).

---

## 0. Phase 2 outcome (read this first)

**Owner clarifications that changed the spike:**

1. OpenFrame dashboard access: **CONFIRMED** (the only live-account blocker in §5 is lifted — minting is possible).
2. "Our current pipeline just works with the vantra link for zip generation" — the `build-exe.sh`/`msi-builder` carrier pipeline in the task doc **does not exist and never did** in this checkout. F1 is confirmed by the owner, not just by tree inspection. There is **no** EXE/MSI toolchain here (checked on this machine: no `pwsh`, no MinGW `gcc`, no `wixl`, no `makensis`; only `windows-latest` GitHub runners in CI).
3. Decision: **zip is NOT the carrier for this task.** Preferred: single file — EXE, VBS, or MSI. Zip = fallback only.
4. OpenFrame's script is PS-only (they ship no EXE); we must bind it ourselves, and later run a script to move the device from their dashboard to ours.

**What Phase 2 built (all mint-time, nothing baked at build time):**

| File | Role |
|---|---|
| `lib/openframe-carrier.ts` | The binder: fail-closed validation of the 5 tenant values → exact OpenFrame install command → **generic** PS-command-to-`.vbs` renderer (hidden launch, optional UAC elevation). |
| `tests/openframe-carrier.test.ts` | The TASK_177 gate as a committed test (§Gate below). |
| `scripts/mint-openframe-carrier.ts` | CLI: render one carrier `.vbs` per device (values via argv only; output to gitignored `out/`). |
| `scripts/migrate-openframe-to-spaceworker.ps1` | Move a device OFF OpenFrame (stop/delete `com.openframe.client`, run agent `uninstall` for server-side deregistration, clean leftovers) and ONTO our install command. |
| `package.json` | `npm run test:openframe`. |

**Gate status after Phase 2:** the **mechanical half now PASSES as a committed test** — two mints with two different value sets render byte-identical carriers after value substitution (diff = values only), each render carries its own values and never the other's, bad values fail closed. The **environment half remains**: nobody has double-clicked a minted `.vbs` on a real Windows box yet. That is now a 5-minute owner action, not a research blocker (see §6).

**Carrier decision (owner's preference mapped to reality):**

- **Now: `.vbs`** — pure text, mint = string render, zero toolchain, single file. Runs hidden + one UAC consent on double-click. VBScript is deprecated on Win11 24H2+/Server 2025 but **still enabled by default** (Microsoft's published roadmap only disables it by default in a future 2027 release — verify before relying past then).
- **Phase 3: EXE** — the durable carrier. Needs a Windows build; this repo already has `windows-latest` CI (`.github/workflows/build-exe.yml`). Wrap the same rendered command in a tiny launcher EXE + embedded manifest (requireAdministrator) when SmartScreen/branding matters.
- **MSI:** only if a customer demands MSI (heaviest; `wixl`/WiX toolchain to add).
- **Zip:** fallback only, per owner.



## 1. Objective

Prove the OpenFrame RMM command can be bound as a **single-click carrier** that runs silently on one click and can later be code-signed. The carrier must be **dynamic per customer at mint time** — a single carrier shape whose per-customer values (`serverUrl`, `initialKey`, `orgId`, `userId`, `machine-id`) are supplied AT MINT TIME per link/customer, **not** baked once at build time.

## 2. The gate (pass/fail)

- **PASS:** mint twice with two different placeholder sets → the two renders diff ONLY the values → **both run the RIGHT values silently** on a Windows VM (or owner hardware).
- **FAIL:** static bake — one EXE with one device key compiled in.

## 3. Evidence basis (what I verified in the repo, not assumed)

- No OpenFrame credentials / dashboard access in this environment (`.env` holds no OpenFrame account; no OpenFrame API keys).
- The carrier-builder pipeline named by the task ("verified 2026-10-07, not assumed") does **not** exist in this checkout:
  - `build-exe.sh`, `msi-builder/src/launcher.c`, `launcher.vbs`, `signing/SIGNING.md`, `osslsigncode` → **0 matches** (excluding `node_modules`/`engine-dist`).
  - The only tracked `build-exe*` file is `.github/workflows/build-exe.yml`, which builds the **Tauri Extractor EXE** (`tauri build --config src-tauri/tauri.extractor.conf.json`, NSIS bundle + standalone Next.js runtime + Rust sidecar) — a licensable desktop app, **not** a per-customer carrier. This is a real discrepancy, see §4.
- OpenFrame appears **nowhere** in the product code — only in the task doc, the two prompt templates, the senior handoff, and unrelated `screen-timeline`/`device-console` components.

## 4. Key findings

### F1 — The "what exists today" section does not reproduce
The task describes an OpenFrame carrier generator: `build-exe.sh` → MinGW-compiled `msi-builder/src/launcher.c` with an embedded `launcher.vbs` RCDATA resource → `installer.exe` (`requireAdministrator` manifest, `wscript` hidden run, VBS downloads + `msiexec /quiet`), plus `signing/SIGNING.md` (OV vs EV, `osslsigncode`). **None of these artifacts are present.** The actual desktop build pipeline is the Tauri Extractor (§3). This means the carrier infrastructure the task is inspecting does not exist in this tree and would first need to be (re)produced or pointed at the real generator before the gate can be exercised.

### F2 — Value classification (derived from the OpenFrame command shape)
```
Set-Location ~; Invoke-WebRequest
  -Uri 'https://<SERVER>/v0/api/assets/download?agent=client'
  -Headers @{ 'x-machine-id' = '<MACHINE>' }
; Expand-Archive; & client install
  --serverUrl <SERVER> --initialKey <KEY> --orgId <ORG> --userId <USER>
```
- `machine-id` → **per-device** (sent as `x-machine-id` header)
- `initialKey` → **per-device** agent key
- `serverUrl` / `orgId` → **per-org** (tenant endpoint + tenant id)
- `userId` → **per-user**
- **Conclusion:** every one of the five values must be parameterized at mint/run time. Nothing can be baked at build time. The carrier MUST accept values per-mint, per-link.


### F3 — Manual path probe (same carrier shape carries OUR install command)
The carrier is a **template**: a small launcher (VBS or PowerShell) that downloads the client artifact and invokes `client install` with substituted parameters. The same shape can carry **our** install command instead of OpenFrame's (stopgap not fork) — the launcher template is shared; only the parameter payload differs. So the carrier shell is reusable; the binding points are the per-mint values.

### F4 — Carrier ranking (from the task, evaluated here)
1. **(a) VBS-to-EXE via existing `build-exe.sh`** — cheapest; VBS text is per-mint dynamic; single branded EXE; no zip dependency. **Recommended.**
2. **(b) PS-bridge `.lnk` + zip** — proven (TASK_176) but carries the zip; higher per-mint surface area.
3. **(c) MSI via `build.sh`/wixl — heaviest; only if the customer demands MSI now.

### F5 — Sign reality check
An **unsigned** carrier WILL SmartScreen-warn on first run ("Unknown Publisher"). The customer tolerates one Unknown-Publisher prompt until a signing cert lands. Effort + lead time to get OV/EV + `osslsigncode` is real; the task explicitly says **never buy anything** during this spike. Re-signing/rebundling cost on future releases is a known follow-up. Signing does not affect the gate's dynamic-binding outcome — it is a post-gate concern.

## 5. Gate verdict

- **Technique: PASS (mechanical half, committed as `npm run test:openframe`).** `tests/openframe-carrier.test.ts` executes the gate's diff half directly: two mints with two different value sets → the renders normalize to byte-identical strings (diff = values ONLY, template mint-invariant), each carrier contains its own five values and never the other mint's, and every bad tenant value fails closed (scheme/path/command smuggling into `serverUrl`, bad UUIDs, spaces/quotes in `initialKey`).
- **Environment half: PENDING OWNER ACTION (5 minutes, not a research blocker).** The "runs silently on Windows" confirmation now reduces to: run `scripts/mint-openframe-carrier.ts` twice with two real value sets from the dashboard → double-click both `.vbs` files on a Windows box → confirm one UAC prompt, no console window, device appears in the OpenFrame dashboard with the right user/org. (The old blockers are gone: dashboard access confirmed; the missing `build-exe.sh` pipeline is irrelevant — Phase 2 renders plain text, no toolchain.)
- → **Result: GATE PASSES mechanically / one manual Windows confirmation outstanding.** Still do not ship any carrier with baked-in per-device values — values enter only at mint time (enforced by validation + tests).

## 6. Recommended next step (Phase 3 checklist)

1. **Windows confirmation (the last gate item):**
   `npx tsx scripts/mint-openframe-carrier.ts --serverUrl <dash> --machineId <uuid> --initialKey <key> --orgId <uuid> --userId <uuid>` → copy `out/openframe-carrier.vbs` to a Windows box → double-click → expect one UAC prompt, no console, device shows up in the OpenFrame dashboard. Repeat with a second value set to eyeball the diff-live-in-prod. Verify `openframe-client.exe install` runs as service `com.openframe.client`.
2. **Migration rehearsal:** on that same box run `scripts/migrate-openframe-to-spaceworker.ps1 -InstallCommand '<our command>'` from an elevated shell → confirm the device leaves the OpenFrame dashboard and appears in ours. (Script is written but NOT yet executed anywhere — no Windows host has run it; brace/paren balance and PS best-practices checked, runtime behavior unproven.)
3. **Phase 3 EXE carrier:** when SmartScreen/branding demands it, wrap the same rendered command in a launcher EXE on the existing `windows-latest` CI (manifest `requireAdministrator`, window hidden). The binder already separates template (build-time) from values (mint-time) — the EXE wraps the same command string, so the gate invariant carries over unchanged.
4. **Signing:** unchanged from §F5 — never buy anything without explicit owner go-ahead; unsigned carriers show one SmartScreen/Unknown-Publisher prompt.

## 7. Hygiene (from the task)

- **NEVER** paste live `initialKey`/`orgId`/`userId`/`machine-id` into a doc, test, log, or committed file. Use REDACTED placeholders (`<SERVER>`, `<ORG>`, `<USER>`, `<KEY>`, `<MACHINE>`) throughout.
- Rotate the OpenFrame key that was pasted into chat, per the task's recommendation.
- No OpenFrame automation, no cert purchase, no keys in the repo (out of scope).
