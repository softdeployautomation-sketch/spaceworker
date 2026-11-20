# TASK_258 — MainStreet Shield: Full Architecture Restructure + Security Hardening

**Status:** RESEARCH / PLANNING — NO CODE CHANGES YET  
**Mode:** Senior Verification Engineer, deep research phase  
**Playbook:** HOW_WE_MOVE_FAST.md (§0–§4)  
**Goal:** Restructure MainStreet Shield into a self-improving cybersecurity platform with password auth, user deletion, working Lab Console/Assets/Workflows, Cline agent integration (ported from SpaceWorker), bug-hunter framework orchestration, defense monitoring, rate limiting, and full security hardening.

---

## 1. EXECUTIVE SUMMARY

The owner wants MainStreet Shield to become a full offensive+defensive cybersecurity platform:

1. **Auth fix:** Add password authentication (currently email-only — anyone who knows an email can log in).
2. **User management:** Add delete-user with warning (to clean up previous/test users).
3. **Working features:** Lab Console, Assets, Workflows currently 404 — must work.
4. **Cline agent port:** Move SpaceWorker's working CyberLab/cline integration into MainStreet Shield settings for Tier 3+ users.
5. **Bug-hunter orchestration:** Integrate existing bug-hunter frameworks (repos already on GitHub) controlled by the Cline agent ("MSS Agent"), with multiple concurrent agents (user-selectable 1–3).
6. **Self-improving workflows:** Cline auto-generates and saves attack/defense workflows after each scenario run (record successes/failures).
7. **Defense phase:** Real-time monitoring of user-added assets, AI raises alarms on flags.
8. **Security-first:** Research deep flaws in both repos + server, prioritize fixes, no rate limiting currently, consider Cloudflare frontend.
9. **Research first, then split into subtasks:** This document is the big task. Subsequent tasks hand off to cline one at a time.

**Rule from owner:** No code fixes yet. Research + architecture only. Then prioritize, then split, then hand to cline.

---

## 2. CURRENT STATE ANALYSIS

### 2.1 mainstreet-shield (deployed at mainstreetmint.click)

| Area | State | Details |
|------|-------|---------|
| Auth | Email-only, no password | `lib/auth.ts`: creates JWT `shield-session` (HS256, 7d, HttpOnly). `signup`/`login` accept email only. `User.password` column exists in Prisma but is never set/verified. |
| Referral gate | Middleware | `middleware.ts` requires `sw_ref` cookie for `/login`, `/signup`, `/shield`, `/dashboard`, `/agent`, `/company`. `/r/[code]` sets cookie. |
| Dashboard | Partially works | Shows tier cards, referral section, "Lab Console" link → `/shield` (404 per user report). Assets/Workflows tabs exist in nav but targets unclear. |
| Settings | Works partially | Shows email, role, tier, referral link + CopyButton. No password management. |
| CyberLab | Placeholder only | `app/cyberlab/page.tsx` is a static HTML mock (nmap/nuclei output hardcoded). No real agent, no scenarios, no runs. |
| Shield VM | Stubbed | `app/api/shield/linux-vm/start/route.ts` has TODO for virsh start. VNC access returns password/clineToken in plaintext. |
| MSS Agent | Basic | `lib/mss-agent.ts`: GET creates/retrieves VM session; POST approves destructive commands. Uses `clineToken` from VncAccess. |
| Rate limiting | NONE | No rate limiting on any API endpoint. |
| Password | Missing | `User.password` is `String?` in schema, never populated. |
| User deletion | Missing | No delete-user endpoint or UI. |
| 404s | Confirmed | Lab Console (`/shield`), Assets, Workflows all return 404 per user. |

### 2.2 spaceworker (reference implementation — WORKING CyberLab)

| Area | State | Details |
|------|-------|---------|
| Auth | Email-only + session | Similar JWT model, but has `requireAdminSession`, admin panel. |
| CyberLab | Full implementation | `lib/lab/cline-agent.ts` (ClineCore + @cline/sdk), `lib/lab/engine.ts` (orchestrator), `lib/lab/runner.ts` (smoke dry-run), `lib/lab/recon-runner.ts`, `lib/lab/live-runner.ts` (real egress), `lib/lab/tool-bridge.ts` (mailer/extractor/devices deep-links), `lib/lab/evidence.ts`, `lib/lab/episode.ts` (signed), `lib/lab/gate.ts` (consent+entitlement+AUP), `lib/lab/targets.ts` (preflight), `lib/lab/victim-sensor.ts`, `lib/lab/scenarios.ts`, `lib/lab/catalog-seed.ts` (ATT&CK), `lib/lab/research.ts`, `lib/lab/tools.ts`. |
| Prisma lab models | Full | LabScenario, LabRange, LabTarget, LabEpisode, LabConsent, LabAbuseReport, CyberLabAgentSettings, CyberLabAgentSession, CyberLabContextDocStep, CyberLabKillSwitch. |
| Admin cyberlab dials | Working | `app/api/admin/cyberlab/route.ts` (enabled, RAM, concurrent ranges, max targets, sentinel thresholds, consent version). |
| Admin runs/episodes | Working | `runs/route.ts` (all runs + abuse reports + signature verification), `episodes/[id]/route.ts` (attack view + defence view + victim sensor), `research/route.ts` (catalog + research state). |
| Tool bridge | Working | `lib/lab/tool-bridge.ts`: deep-links to mailer/extractor/devices with sessionStorage context, strict validation. |
| Cline agent SDK | Working | `@cline/sdk` ^0.2.0, `ClineCore`, `formatProviderOAuthApiKey`, OAuth token precedence (request > oauth > manual). |

### 2.3 Server (VPS 207.244.224.57)

| Component | State |
|-----------|-------|
| mainstreet-shield | Deployed via GitHub workflow → rsync, `next start -p 3000` |
| spaceworker | `spaceworker.service` on port 3500 |
| vantra | RMM API on 127.0.0.1:3300 |
| nats | Ports 4222 + 9235 |
| meshcentral | `wss://mesh.instaweb.top` |
| Postgres | Separate DBs per service |
| Rate limiting | NONE at any layer |
| Cloudflare | Not in use |

---

## 3. SECURITY GAP ANALYSIS (DEEP)

### Critical (must fix first)

| # | Flaw | Location | Impact |
|---|------|----------|--------|
| S-1 | **No password auth** — email-only login | `mainstreet-shield/lib/auth.ts`, `signup/route.ts`, `login/route.ts` | Anyone who knows a registered email can fully authenticate and access the lab. Account takeover by email enumeration. |
| S-2 | **No rate limiting** — all APIs | Every `app/api/*/route.ts` in mainstreet-shield | Brute-force login, signup spam, API abuse, referral code enumeration. |
| S-3 | **No CSRF protection** — form posts | `login/page.tsx` (form), `signup/page.tsx` (form) | Cross-site request forgery on state-changing operations. |
| S-4 | **Weak/default SESSION_SECRET** | `lib/auth.ts:7-9`, `signup/route.ts:13-15` | Falls back to `dev-secret-change-me` — JWT forgeable if env missing. |
| S-5 | **VNC/clineToken in plaintext** | `app/api/vnc-access/route.ts`, `lib/mss-agent.ts` | Sensitive credentials returned over HTTP without additional encryption. |
| S-6 | **No account lockout** | `login/route.ts` | Unlimited password/email guessing attempts. |

### High

| # | Flaw | Location | Impact |
|---|------|----------|--------|
| S-7 | **No MFA** | Auth flow | Single factor only (email). |
| S-8 | **No password complexity** | Schema `password String?` | Weak passwords allowed once added. |
| S-9 | **`sw_ref` cookie lacks Secure/HttpOnly** | `middleware.ts:60` | Cookie may be sent over HTTP, accessible via JS. |
| S-10 | **No security headers** | `middleware.ts`, `layout.tsx` | No CSP, HSTS, X-Frame-Options, etc. |
| S-11 | **Admin service token hardcoded** | `spaceworker/admin-panel.tsx:5933` (noted, not fixed) | Secret leakage in client bundle. |
| S-12 | **No audit logging** | Most API routes | No trace of who did what. |

### Medium

| # | Flaw | Location | Impact |
|---|------|----------|--------|
| S-13 | **No CORS restrictions** | API routes | Potential cross-origin abuse. |
| S-14 | **No input sanitization beyond zod** | Various | XSS/injection possible if zod misses edge cases. |
| S-15 | **User deletion missing** | No endpoint/UI | Can't remove test/compromised accounts. |
| S-16 | **Lab Console 404** | `/shield` route missing | Users can't access the core feature. |

---

## 4. RESEARCH FINDINGS (WEB + CODEBASE)

### 4.1 Bug-hunter / attack frameworks already on GitHub (candidates for integration)

The owner wants to leverage **existing bug-hunter repos** that work with cline as the MSS Agent. Candidates to research (not yet evaluated):

| Category | Framework examples | Notes |
|----------|-------------------|-------|
| Recon/scanning | nuclei, nmap, subfinder, amass, httpx | Already referenced in spaceworker cyberlab mock |
| Web vuln scanning | nuclei templates, zap, burp suite (community) | nuclei is CLI-based, easy to orchestrate |
| Credential testing | hydra, medusa | For authenticated scanning |
| Exploitation | metasploit-framework, exploitdb | Heavy, needs careful gating |
| Password attacks | hashcat, john | For offline credential auditing |
| Cloud security | prowler, scoutsuite | For cloud asset auditing |
| API security | ffuf, ffufapi, burp | For API endpoint testing |
| Cline agent SDK | `@cline/sdk` ^0.2.0 | Already in both package.json files |

**Research approach:** Scan GitHub for "bug bounty automation", "recon framework", "automated pentest framework", "nuclei workflow orchestrator", "cline agent cybersecurity". Evaluate each for:
- CLI-based (orchestratable by agent)
- Safe defaults (no real damage without consent)
- Output parseable (JSON)
- Active maintenance
- License compatibility

### 4.2 Cline agent integration pattern (from spaceworker)

`spaceworker/lib/lab/cline-agent.ts` shows the pattern:
- `ClineCore` from `@cline/sdk`
- API key resolution: explicit request key > OAuth token (decrypted/refreshed) > manual stored key
- `formatProviderOAuthApiKey("cline", { access: oauthToken })` — WorkOS JWT format
- Tool approval gate: `ToolApprovalRequest` / `ToolApprovalResult` from `@cline/shared`
- Session management: `cyberLabAgentSession`, `CyberLabAgentSettings`, `CyberLabContextDocStep`
- Idle session sweep (`sweepIdleSessions`)
- Destructive command gating with human approval

### 4.3 Self-improving workflow concept

The owner wants Cline to:
1. Run an attack scenario against a user-provided target
2. Record success/failure of each technique
3. Auto-generate a workflow from successful techniques
4. Save the workflow so the user can re-run it against other targets
5. Support 1–3 concurrent agents (user preference)

This maps to spaceworker's:
- `LabEpisode` (signed manifest of what ran)
- `LabRange` (isolated run environment with TTL)
- `LabScenario` (reusable attack scenario definition)
- Evidence artefacts (timeline.json, surface.json, detections.json)
- Telemetry signatures (what a defender would see)

---

## 5. ARCHITECTURE VISION (TARGET STATE)

### 5.1 Auth (Phase 0 — immediate)

```
User registration:
  - email + password (bcrypt hash, min 12 chars)
  - optional referral code (existing gate preserved)
  - email verification NOT required (owner wants simplicity)
  - session JWT: shield-session (existing)

User login:
  - email + password verification
  - rate limited (5 attempts/min per IP + email)
  - account lockout (15 min after 5 failures)
  - session JWT (existing)

Settings:
  - change password (require current password)
  - delete account (with confirmation warning + email re-auth)
  - view/manage referral link
  - Cline API key configuration (manual key input for Tier 3+)
```

### 5.2 Lab Console + Assets + Workflows (Phase 1)

All three must work (currently 404):

```
Assets:
  - Add targets (IPs, domains, URLs) — Tier 1 can view, Tier 5 can manage
  - List assets with status (in scope / out of scope / testing)
  - Delete assets

Workflows:
  - List saved attack/defense workflows (auto-generated by Cline after runs)
  - Run a workflow against selected assets
  - View workflow results (success/failure per technique)
  - Delete workflows

Lab Console:
  - Linux VM control (start/stop, VNC access) — Tier 5 only
  - MSS Agent access (Cline integration) — Tier 3+
  - Real noVNC desktop
```

### 5.3 Cline Agent / MSS Agent (Phase 2 — ported from SpaceWorker)

```
Settings (Tier 3+):
  - Cline API key input (manual key, stored encrypted)
  - Agent concurrency selector (1, 2, or 3 agents)
  - Agent mode: Assist / Full control
  - Destructive command approval gate (human-in-the-loop)

CyberLab engine:
  - Gate: consent (AUP), entitlement (tier), daily run cap
  - Pre-flight: target attestation (only owned/authorized targets)
  - Range: isolated run environment with TTL
  - Runner: smoke (dry-run), recon (simulated), live (real egress — gated)
  - Episode: signed manifest, telemetry signatures, victim sensor
  - Tool bridge: deep-links to mailer/extractor/devices
  - Research catalog: ATT&CK techniques, tool seeding
```

### 5.4 Bug-hunter orchestration (Phase 3)

```
Attack scenario flow:
  1. User adds company/target details in Assets
  2. User selects bug-hunter framework(s) (nuclei, nmap, etc.)
  3. Cline agent (MSS Agent) orchestrates the framework
  4. Multiple concurrent agents (1–3, user preference)
  5. Each agent records success/failure per technique
  6. Cline auto-generates workflow from successful techniques
  7. Workflow saved for reuse against other targets

Defense phase:
  1. User adds app/web/asset info to monitor
  2. AI watches in real time (telemetry signatures)
  3. AI raises alarms on flags
  4. User reviews and triages
```

### 5.5 Infrastructure (Phase 4 — optional)

| Consideration | Recommendation | Reason |
|--------------|---------------|--------|
| Cloudflare frontend | Research | DDoS protection, WAF, rate limiting at edge, SSL |
| Rate limiting | Implement at app + edge | Redis-backed sliding window |
| Security headers | CSP, HSTS, X-Frame-Options | Standard hardening |
| Secrets rotation | Don't hardcode tokens | Use env vars only |

---

## 6. BIG TASK BREAKDOWN (PRIORITIZED SUBTASKS)

This is the master task. It must be split into smaller tasks and handed to cline one at a time. **Priority order:**

### Phase 0: Auth & User Management (S0)

| Sub-task | Description | Priority | Status |
|----------|-------------|----------|--------|
| S0-1 | Add password hashing (bcrypt) to signup/login | P0 | DONE — commit 00ef11e |
| S0-2 | Add password verification middleware (require password for authenticated routes) | P0 | DONE — commit 6ccccda |
| S0-3 | Add rate limiting to auth endpoints (login/signup) | P0 | |
| S0-4 | Add account lockout after N failures | P0 | |
| S0-5 | Fix SESSION_SECRET default (fail if missing in production) | P0 | |
| S0-6 | Add delete-user endpoint + UI with warning — admin panel (Users \& Tiers) AND user Settings | P1 | DONE — commit 00ef11e |
| S0-7 | Add change-password in Settings | P1 | |
| S0-8 | Clean up test/previous users (owner-requested) | P1 | |
| S0-9 | Fix /api/auth/logout 404 — add dedicated POST route | P0 | DONE — commit ce7866e |

### Phase 1: Working Features (S1)

| Sub-task | Description | Priority | Status |
|----------|-------------|----------|--------|
| S1-1 | Fix Lab Console (/shield) — VM optional, tools run from server | P0 | DONE — commit 00ef11e |
| S1-2 | Fix Assets page — CRUD for targets (IPs, domains, URLs) | P0 |
| S1-3 | Fix Workflows page — list/run/delete saved workflows | P0 |
| S1-4 | Fix dashboard navigation to point to working routes | P0 |
| S1-5 | Tier-gating: Tier 5 = VM + full access, Tier 3 = agent only, Tier 1 = view only | P0 |

### Phase 2: Cline Agent Port (S2)

| Sub-task | Description | Priority |
|----------|-------------|----------|
| S2-1 | Port `lib/lab/cline-agent.ts` from spaceworker to mainstreet-shield | P0 |
| S2-2 | Port `lib/lab/engine.ts` (orchestrator) | P0 |
| S2-3 | Port `lib/lab/runner.ts`, `recon-runner.ts`, `live-runner.ts` | P0 |
| S2-4 | Port `lib/lab/evidence.ts`, `episode.ts`, `gate.ts`, `targets.ts`, `victim-sensor.ts` | P0 |
| S2-5 | Port `lib/lab/tool-bridge.ts`, `scenarios.ts`, `catalog-seed.ts`, `research.ts`, `tools.ts` | P1 |
| S2-6 | Port Prisma lab models (LabScenario, LabRange, LabTarget, LabEpisode, LabConsent, LabAbuseReport, CyberLabAgent*) | P0 |
| S2-7 | Port admin cyberlab dials API | P1 |
| S2-8 | Add Cline API key settings (Tier 3+) with encryption | P0 |
| S2-9 | Add agent concurrency selector (1–3) | P1 |
| S2-10 | Add destructive command approval gate | P0 |

### Phase 3: Bug-hunter Orchestration (S3)

| Sub-task | Description | Priority |
|----------|-------------|----------|
| S3-1 | Research and select bug-hunter frameworks (nuclei, nmap, etc.) | P0 |
| S3-2 | Build framework orchestrator (CLI invocation, JSON output parsing) | P0 |
| S3-3 | Add attack scenario UI (add company details, select framework, run) | P1 |
| S3-4 | Add concurrent agent support (1–3) | P1 |
| S3-5 | Auto-generate workflows from successful techniques | P2 |
| S3-6 | Save/load workflows for reuse | P2 |
| S3-7 | Record success/failure per technique (signed episodes) | P0 |

### Phase 4: Defense Monitoring (S4)

| Sub-task | Description | Priority |
|----------|-------------|----------|
| S4-1 | Add asset monitoring UI (add app/web info to watch) | P1 |
| S4-2 | Build real-time telemetry collection | P1 |
| S4-3 | AI alarm engine (flag detection, raise alarms) | P2 |
| S4-4 | Alarm triage UI | P2 |

### Phase 5: Infrastructure Hardening (S5)

| Sub-task | Description | Priority |
|----------|-------------|----------|
| S5-1 | Research Cloudflare frontend migration | P2 |
| S5-2 | Add security headers (CSP, HSTS, etc.) | P1 |
| S5-3 | Add CORS restrictions | P1 |
| S5-4 | Add audit logging | P1 |
| S5-5 | Fix `sw_ref` cookie flags (Secure/HttpOnly) | P1 |

---

## 7. VERIFICATION CHECKLIST (FOR SENIOR VERIFICATION AGENT)

These are the checks I will run after each cline task completes:

| ID | Check | Command / Method |
|----|-------|------------------|
| V-1 | `tsc --noEmit` = 0 in both repos | `cd <repo> && npx tsc --noEmit` |
| V-2 | `prisma validate` OK (no schema breakage) | `npx prisma validate` |
| V-3 | Password signup works (201, bcrypt hash stored) | Live HTTP POST /api/auth/signup with password |
| V-4 | Password login works (200, session cookie set) | Live HTTP POST /api/auth/login with password |
| V-5 | Wrong password rejected (401) | Live HTTP POST with wrong password |
| V-6 | Rate limiting triggers (429 after N attempts) | Live repeated login attempts |
| V-7 | Account lockout after 5 failures | Live test |
| V-8 | Delete user with warning works | Live HTTP DELETE /api/admin/users/[id] + UI |
| V-9 | Lab Console `/shield` returns 200 (not 404) | Live GET /shield |
| V-10 | Assets CRUD works | Live HTTP GET/POST/DELETE /api/assets |
| V-11 | Workflows CRUD works | Live HTTP GET/POST/DELETE /api/workflows |
| V-12 | Cline agent settings save/load (Tier 3+) | Live test |
| V-13 | Agent concurrency (1–3) works | Live test |
| V-14 | Bug-hunter framework runs against target | Live test with nuclei/nmap |
| V-15 | Workflow auto-generation after successful run | Live test |
| V-16 | No secrets committed (.env, tokens) | `git diff --stat` + grep |
| V-17 | No migration needed (schema additive only) | `prisma migrate status` |
| V-18 | Security headers present | Live HTTP response headers |

---

## 8. RULES FOR CLINE (HANDOFF)

1. **NO DEPLOY** — Deploy is owner's decision only.
2. **NO `prisma migrate`/`db push`/schema change** unless explicitly approved per subtask (schema is additive: new tables + password column already exists).
3. **`npx tsc --noEmit` must be 0** in BOTH repos before reporting.
4. **Never print/commit `.env`, `MAINSTREET_SERVICE_TOKEN`, `SESSION_SECRET`, or any keys.**
5. **Update progress log** in the task file before starting and after finishing each sub-task.
6. **Do not touch:** middleware `/signup ?ref` stamping semantics, `app/r/[code]/route.ts` cookie attrs, `ReferralLink @@map`, mainstreet proxies, hardcoded service token (note, don't fix), CyberLab subtab (already removed in spaceworker), cyberlab removal.
7. **Work one sub-task at a time.** Report completion before starting the next.
8. **Research first, code second.** For S3-1 (bug-hunter framework selection), do web research before writing code.

---

## 9. NEXT STEPS (FOR OWNER)

**Completed (DONE):**
- S0-1 — Password authentication (bcrypt) — commit 00ef11e
- S0-6 — Delete user with warning (admin + Settings) — commit 00ef11e
- S1-1 — Lab Console `/shield` (VM optional, tools run from server) — commit 00ef11e
- S0-9 — Fix `/api/auth/logout` 404 — commit ce7866e
- S0-2 — Password verification middleware — commit 6ccccda

**Recommended next priorities (pick one):**

1. **S0-3 — Rate limiting on auth endpoints** (P0) — login/signup brute-force protection
2. **S1-2 — Assets page CRUD** (P0) — add/view/delete monitored targets (IPs, domains, URLs)
3. **S0-8 — Clean up test/previous users** (P1) — delete via admin Users & Tiers

**Deploy decision:** Commits `ce7866e` and `6ccccda` are on `main` but NOT yet deployed to `mainstreetmint.click`. You must dispatch the deploy workflow before live verification can run for any new changes.

**Cloudflare research:** Part of S5-1 — will research once we reach Phase 5.

**This document is the big task.** When you're ready, tell me which sub-task to hand off to cline, and I'll write the implementation spec using `task/PROMPT_TASK_AGENT.md`.

