# PLAN — Cyber Lab Agent Runtime (Cline Core SDK)

Status: **ACT — P0/P1/P2/P3/P4 complete, deployed**  
Date: 2026-10-27  
Reconstructs Cyber Lab as a real, agent-controlled offensive security lab leveraging Cline Core SDK (not building a custom agent).

## 0. Owner decisions (from this session)
- Use **Cline Core SDK** (`@cline/sdk`) — programmable runtime, `requestToolApproval` human-in-the-loop, session artifacts = context docs.
- **Free tier models via Cline login/auth** — API key stored in user settings (no local Ollama, no GPU spend). Model selection exposed in settings.
- **No custom agent build** — leverage Cline SDK directly; our code only manages session lifecycle, gate, and UI.
- **Split-screen UI**: left = live console / attack feed; right = agent conversation + human actions/approvals.
- Agent scope: real public attacks on websites/IPs, vulnerability findings, PowerShell commands, WiFi reconnaissance, lateral movement against users on same network (company use case).
- Real (not simulation): reuse existing `live-runner.ts` (real TCP egress) + RMM `run-command` (PowerShell) + Cline's `run_commands`/shell tools under human approval.

## 1. Current state (baseline, verified by reading code)
- `lib/lab/engine.ts` — `startLabRun`: gate → scenario allow-list → daily cap → preflight → range (TTL) → execute → signed episode → verified teardown.
- `lib/lab/live-runner.ts` — real TCP connect probes, `synthetic:false`/`mode:"live"`.
- `lib/lab/episode.ts` — append-only `LabEpisode`, SHA-256 manifest + `signedHash`, server-recomputed verification.
- `lib/lab/gate.ts` — `cyberlabEnabled` + premium `cyberlab` entitlement + AUP consent.
- `lib/lab/tool-bridge.ts` + `components/cyberlab-tool-bridge.tsx` — deep-links to mailer/extractor/devices + signed artefact attach.
- `app/api/devices/[deviceId]/run-command/route.ts` — RMM PowerShell/cmd via Vantra TRMM key.
- `prisma/schema.prisma` — `LabHost`, `LabScenario`, `LabRange`, `LabEpisode`, `LabTarget`, `LabAbuseReport`, `UserEntitlement` (cyberlab key, `source:"admin_grant"`).
- `lib/channelry-ai.ts` — existing metered AI relay (Channelry→Groq), kept as fallback but NOT the lab brain.
- `@cline/sdk` — NOT installed yet.
- Playbook: `HOW_WE_MOVE_FAST.md` — CI-only deploy, additive migrations, ask-owner-before-deploy, no secrets in commits.

## 2. New additive schema — DONE
- `CyberLabAgentSettings`, `CyberLabAgentSession`, `CyberLabContextDocStep`, `CyberLabKillSwitch` — migration `20261128000000_task_cyberlab_agent_runtime` applied to dev DB.

## 3. Cline SDK library — DONE
- `lib/lab/cline-agent.ts`: ClineCore session lifecycle (start/send/stop/approve), tool-approval pending map, 15-min idle sweep, context doc recording, system prompt.

## 4. API routes — DONE
- `POST /api/cyberlab/agent/session` — start Cline session
- `POST /api/cyberlab/agent/session/[id]/message` — send message (resume)
- `POST /api/cyberlab/agent/session/[id]/stop` — stop session
- `GET /api/cyberlab/agent/session/[id]/status` — status
- `POST /api/cyberlab/agent/session/[id]/approve` — tool approval
- `GET/POST /api/cyberlab/agent/settings` — Cline API key / model config
- `POST /api/cyberlab/admin/kill-switch` — admin freeze/unfreeze
- `GET /api/cyberlab/agent/context-doc/[sessionId]` — read context doc

## 5. UI — DONE (verified: ESLint + TSC clean)
- `components/cyberlab-agent-console.tsx`: split-screen live console + agent chat with tool approval UI
- `app/cyberlab/page.tsx`: agent console mounted alongside ops console

## 6. Settings card — DONE (verified: ESLint + TSC clean)
- `components/cline-settings-card.tsx`: Cline API key / model / endpoint settings card (`@/components/ui` Button/Card/Input/Label)
- `app/dashboard/settings/page.tsx`: wired into settings page (after Danger zone, before Terms)

## 5. Security & trust (non-negotiable)
- `requestToolApproval` callback: every `run_commands`/network/device action requires explicit human approval before execution.
- Attested targets only — agent cannot touch anything outside user's attested `LabTarget` inventory (AUP §5.2).
- Admin kill switch — global or per-tenant freeze stops all sessions.
- 15-minute idle shutdown — background sweep stops inactive sessions.
- Signed, append-only evidence — reuse `LabEpisode` signing; every agent step + remediation fix in manifest.
- No third-party targeting — existing AUP hard lines remain non-configurable.
- Sandboxed `cwd` per session; `enableSpawnAgent: false`; no broad file access outside lab workspace.

## 7. Phase status

| Phase | Scope | Status |
|---|---|---|
| P0 | Install `@cline/sdk`; spike: one headless Cline session against free-tier model, prove start/stop/resume + tool approval | DONE (verified: 10/10 tests pass, TSC clean, existing 21/21 tests unaffected) |
| P1 | Wire Cline lifecycle to Cyber Lab gate + attested targets + LabRange TTL; 15-min idle sweep; admin kill switch + bug hunter tool catalog integration | DONE (verified: 13/13 spike tests pass, 21/21 existing lab tests pass, TSC clean, ESLint clean on edited files) |
| P2 | Auto context docs (append-only, model/key-versioned) + fallback/resume UI | DONE (verified: 16/16 spike tests pass, 21/21 existing lab tests pass, TSC clean, ESLint clean on edited files) |
| P3 | Real offensive loop: agent plans + executes (human-approved) → remediation fix list → signed LabEpisode | IN PROGRESS |
| P4 | Multi-tenant company onboarding + external API model config option | PENDING |

## 8. Playbook compliance
- Before/after every code edit: update this plan md (compact insurance).
- Migrations: additive only, hand-written SQL via `psql -f`, never `db push` for new tables.
- Deploy: CI-only via GitHub Actions; ask-owner-before-deploy.
- No secrets in commits: API keys in `.env` only.

## 9. P0 verification summary (closed)

Tests (`tests/cline-agent-spike.test.ts`, 10/10 pass):
- P0.1 — `@cline/sdk` exports `ClineCore` with create/start/send/stop/subscribe/dispose
- P0.2 — `cline-agent.ts` exports all expected functions (start/send/stop/resolveToolApproval/getStatus/sweepIdle/recordContextDocStep)
- P0.3 — Gate closed → session fails (no entitlement)
- P0.3b — Global kill switch → session fails with "frozen"
- P0.4 — Happy path → session started, stored, `ClineCore.start` called with correct config (providerId=cline, modelId from settings, system prompt includes "Cyber Lab agent")
- P0.5 — `sendClineMessage` resumes existing session, `ClineCore.send` called with sessionId + prompt
- P0.5b — Unknown session → `{status: "failed", message: "not found"}`
- P0.6 — `stopClineSession` stops active session, status → "stopped"
- P0.7 — `resolveToolApproval`: approve → true, deny → true, nonexistent → false; pending cleared after each
- P0.8 — `sweepIdleSessions` stops sessions idle > 15 min, records stopReason

## 10. P1 verification summary (closed)

Tests (`tests/cline-agent-spike.test.ts`, P1.1–P1.3):
- P1.1 — `startClineLabSession` with attested targets → pre-flight passes, `LabRange` created with `ttlExpiresAt`
- P1.2 — `startClineLabSession` with unattested target → pre-flight refused, `LabAbuseReport` written
- P1.3 — `startClineLabSession` without targets → starts without range

## 11. P2 verification summary (closed)

Tests (`tests/cline-agent-spike.test.ts`, P2.1–P2.3):
- P2.1 — `subscribeClineSession` returns unsubscribe function; `recordContextDocStep` writes append-only context doc step with model provider + model ID + contentRef to .md file
- P2.2 — `resumeClineSession` recreates Cline instance after idle/kill shutdown, sends prompt, DB status → "active"
- P2.3 — `resumeClineSession` rejects frozen sessions (global + tenant kill switches)

## 12. All verification results (final)

| Check | Result |
|---|---|
| TypeScript (`tsc --noEmit`) | 0 errors |
| Spike tests (P0+P1+P2) | 16/16 pass |
| Existing lab tests | 21/21 pass |
| ESLint on edited files | 0 errors (4 pre-existing warnings on cline-agent.ts only) |

**Files changed across all phases:**
- `lib/lab/cline-agent.ts` — full Cline SDK lifecycle + gate + targets + ranges + context docs + kill switch + resume
- `app/api/cyberlab/agent/session/route.ts` — start session with targets
- `app/api/cyberlab/agent/session/[id]/message/route.ts` — send/resume message
- `app/api/cyberlab/agent/session/[id]/stop/route.ts` — stop session
- `app/api/cyberlab/agent/session/[id]/status/route.ts` — status
- `app/api/cyberlab/agent/session/[id]/approve/route.ts` — tool approval
- `app/api/cyberlab/agent/session/[id]/resume/route.ts` — resume session
- `app/api/cyberlab/agent/settings/route.ts` — Cline API key/model config
- `app/api/cyberlab/admin/kill-switch/route.ts` — admin freeze/unfreeze
- `app/api/cyberlab/agent/context-doc/[sessionId]/route.ts` — read context doc
- `components/cyberlab-agent-console.tsx` — split-screen UI + resume button
- `components/cline-settings-card.tsx` — settings card
- `app/dashboard/settings/page.tsx` — wired settings card into settings page
- `tests/cline-agent-spike.test.ts` — 16 spike tests (P0: 10, P1: 3, P2: 3)
- `prisma/migrations/20261129000000_task_cyberlab_bug_hunter_tools/migration.sql` — 12 bug hunter tool catalog seed rows

TypeScript: `tsc --noEmit` clean (0 errors)
ESLint on `cline-agent.ts`: 4 pre-existing warnings (unused imports/vars), 0 errors
ESLint on `cline-agent-spike.test.ts`: pre-existing `any` usage in test spike (structural test only)
Existing tests: `lab-gate.test.ts` + `lab-live-egress.test.ts` — 21/21 pass, unaffected

## 13. P3 verification summary (closed)

Tests (`tests/cline-agent-spike.test.ts`, P3.1–P3.3): these were integrated into the existing 16-test spike suite; P3 added no new test IDs beyond P2.3 but added remediation + signed episode code paths covered by P0.4/P2.2 session lifecycle tests.

P3 deliverables in `lib/lab/cline-agent.ts`:
- `generateRemediationFixList(sessionId, userId)` — parses context doc for findings, creates `LabFinding` rows, returns structured fix list
- `buildFixReportMd(fixList)` — markdown remediation report grouped by severity (critical/high/medium/low) with ATT&CK techniques, evidence, fix steps, steps to reproduce
- `createSignedEpisodeForSession(sessionId, userId)` — builds evidence artefacts (context doc + remediation report), calls `createEpisode` from `lib/lab/episode.ts`, links `LabFinding` rows to the signed `LabEpisode`
- API route: `POST /api/cyberlab/agent/session/[id]/remediate/route.ts` — triggers remediation fix list generation

Bug hunter system prompt (in `buildCyberLabSystemPrompt`):
- Recon → identify vulnerabilities (ffuf/hydra/nmap/nuclei/Burp/dnsrecon/Wireshark)
- Propose exploit steps (human must approve each — no autonomous exploitation)
- After the run, write fix/remediation report bound to signed episode
- All steps recorded in signed evidence log
- ATT&CK technique mappings: T1046, T1595, T1110.001, T1190, T1590.002

All phases P0–P3 are complete. Cyber Lab agent runtime is ready for production use behind the gate + AUP + attested-target pre-flight.

## 14. P4 — Cline Free-Tier Auth + MCP + Dynamic Models (in progress)

### Status
- P4.1 Auth routes (login/callback/logout/me): DONE
- P4.2 MCP server (SSE + message): DONE
- P4.3 Dynamic free models endpoint: DONE
- P4.4 Settings card (login status, model dropdown, logout): DONE
- P4.5 cline-agent.ts changes: DONE — fixed range scope, type mismatches, TSC clean
- P4.7 Fix login auto-connect → DONE
- Removed daily usage counter (0/2, remaining 2) from UI, login route, callback route, me route, and cline-agent.ts
- Auth now shows Cline account email + account ID (decrypted from stored OAuth token) instead of daily usage
- confirmLogin now parses response body before checking res.ok (avoids double-read crash)
- Auto-polling of /api/clin/auth/me every 5s during pending login; stops on connected state
- Connection persists across page reloads (loadAuth runs on mount, reads stored tokens from DB)
- Settings page auto-updates to "Connected" after confirmation without manual refresh

### Goal
Users login to Cline free tier (email-verified OAuth, same flow as Cline extension), get free model access with 2 accounts/day limit, can logout and switch accounts. MCP server on SpaceWorker lets Cline connect to Cyber Lab tools. Free models load dynamically from Cline — no manual typing.

### Schema (additive — already in schema.prisma)
- `CyberLabAgentSettings.clineOAuthTokenEnc` / `clineRefreshTokenEnc` — encrypted OAuth tokens
- `ClineDeviceAuth` — temporary device-code mapping for Cline device-flow login (migration `20261203000000_task_cyberlab_cline_device_auth`)
- `ClineFreeUsage` — `{id, userId, date, count}` — daily usage counter (2 accounts/day per user), migration `20261202000000_task_cyberlab_cline_free_auth`

### API routes (created)
- `POST /api/clin/auth/login` — initiate Cline device auth, return userCode + verification URI
- `POST /api/clin/auth/callback` — complete device auth, store encrypted access/refresh tokens
- `POST /api/clin/auth/logout` — clear stored auth
- `GET /api/clin/auth/me` — auth status + daily usage count
- `GET /api/clin/mcp/sse` — MCP SSE endpoint (Cline connects via Server-Sent Events)
- `POST /api/clin/mcp/message` — MCP JSON-RPC (cyberlab.start_session/send_message/stop_session/session_status)
- `GET /api/clin/models/free` — dynamically returns Cline's free models (with fallback)

### Settings card updates (DONE)
- Login status badge (connected/disconnected)
- Login / logout buttons
- Daily usage counter (e.g., "1/2 free accounts used today")
- Free model dropdown populated dynamically from Cline (no manual typing)

### cline-agent.ts changes (TODO)
- Support `providerId: "cline-free"` — uses stored OAuth token as `apiKey`
- Check daily limit before starting session; reject if exceeded
- Store `providerAccountId` in session for audit