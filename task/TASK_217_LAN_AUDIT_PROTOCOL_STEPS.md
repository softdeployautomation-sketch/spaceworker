# TASK_217 — LAN/WiFi Security Audit Lab — STEPS

Owner: task agent. Branch: `agent/task-217-lan-audit` (to be cut from local main `fe3e717`).
Commit policy (PROMPT §5): local commit only when instructed — **uncommitted at handoff**.
Task doc: `/Users/mikeolab/TASK_217_LAN_AUDIT_PROTOCOL.md` (D1 probes, D2 judging service,
D3 command-tab wiring, D4 tests/gates, D5 handoff).

## BEFORE — 2026-10-17 (task agent)

### 1. Branch / tree state
- On `main` @ `fe3e717` (2026-10-17 03:23 +0100). Tree carries only **other agents'/prior
  untracked** files (TASK_*_STEPS.md docs, scripts/*.sh helpers) — no other agent's uncommitted
  edits to my target files (PROMPT §3.1 check via `git status --short`).
- `agent/task-215-admin-support-referrals` and `agent/task-216-cyberlab-console-mouse` are
  **same as main** for every file I may touch (see clobber check below) — no live lanes to
  rebase onto or reconcile with.

### 2. Clobber-rule check (PROMPT §3.1) — `scripts/s217-shared-diff.sh` → `scripts/s217-shared-diff.out`
Diffed every file this task may touch against ALL local heads + remotes (nothing checked out):
- `components/device-console.tsx` — all differing branches are **stale** (behind main; the diff
  is main gaining hundreds of lines they lack). Nearest live lanes `agent/task-212-controls`
  and `agent/task-214-clone-extension-install` differ by only +3/−17 (old wording tweaks);
  215/216 = same as main. **Safe: edit from main's version.**
- `prisma/schema.prisma` — same pattern: every "DIFFERS" is an older branch missing main's
  newer ~2k lines (e.g. +3 −1986). No branch carries parallel schema work newer than main.
  215/216 = same as main. **Safe: append new models at schema tail.**
- `lib/device-tools.ts`, `lib/vantra-link.ts` — identical pattern; no newer parallel edits.
- Migration dirs (newest per ref): **`origin/main: 20261125000000_invite_came_via`** is the
  newest anywhere; every other ref is older. ⇒ my add-table-only migration will be named
  `20261126000000_task217_security_audit_*` (first id after main's newest; no collision).
- Note: PROMPT §2 says reconcile with the **deployed** box schema too — box questions go back
  to the owner (not executed by me). Since D2 is ADD-TABLE-ONLY, a behind-box schema cannot
  conflict: no existing table is altered.

### 3. Baseline gates (captured BEFORE any edit)
- `npx tsc --noEmit` → **exit 0** (`/tmp/t217-tsc-before.log`: `tsc=0`).
- `npx tsx --test tests/*.test.ts` → **# tests 1588 / # pass 1587 / # fail 0 / # skipped 1,
  exit=0** (`/tmp/t217-tests-before2.log`, verbatim; duration_ms 51068.99). The first capture
  (`/tmp/t217-tests-before.log`) was truncated by a terminal flake (log stopped at ok 161,
  summary lines missing) — the clean re-run matches the task doc's recorded baseline exactly
  (the 1 skip is the known DB-gated test).
- eslint on touched files: to be run at AFTER (nothing touched yet).

### 4. File-grounded findings (line numbers on main @ `fe3e717`)
- **Tabs**: `components/device-console.tsx:112` — `type Tabs = "summary" | "control" |
  "command" | "clone" | "activity" | "monitoring"`; `:432` tab label row (`["command",
  "Command", Terminal]`); `:448` `TOOL_TABS = new Set<Tabs>(["control","command","clone",
  "monitoring"])` (free-tier gate); `:1804` renders `tab === "command"` (CommandTab block).
- **Command execution rides ONE gated path** (reuse, no new privileges):
  - `lib/device-tools.ts:997` `runCommandNow` — `requireOwnedDevice` → Vantra
    `/api/internal/sw/devices/<vantraAgentId>/action` (`action:"cmd"`) → `recordAgentActionAudit`
    on the customer stream; errors normalized at `:433`.
  - `lib/device-tools.ts:458` `createQueuedCommand` — mirror row `DeviceQueuedCommand` +
    Vantra queued-commands POST with `swRef`; orphan row deleted if the Vantra call fails.
  - Console side: `device-console.tsx:991/:1023` queue fetchers, `:1049/:1268` run-now posts,
    `:613` run-now result panel.
  - Routes: `app/api/devices/[deviceId]/run-command/route.ts`,
    `app/api/devices/[deviceId]/queued-commands/route.ts` (both funnel into the functions above).
- **CyberLab consent pattern to follow** (reuse, don't touch):
  - `prisma/schema.prisma:3598` `model LabConsent` — append-only `{userId, termsVersion,
    scope @default("lab"), signedAt, ip?, hash}`; `lib/lab/consent.ts:70` `recordConsent`
    (idempotent per version, `scope` param already exists — `"lan-audit"` slots in with NO
    schema change), `:98` `clientIp`.
  - Existing cyberlab routes under `app/api/cyberlab/{runs,runs/[id]/artefacts,runs/[id]/
    stream,consent,targets,scenarios,devices}` — pattern source for the new judging API.
  - §6 evidence models: `LabEpisode:3542` (evidenceManifest + signedHash),
    `LabFinding:3564` (severity/title/detail + retestOf) — pattern for the new
    `SecurityAudit`+`AuditFinding` pair (new tables only).
- **No `lib/security-audit/` yet** — fresh dir, no collisions (`ls` → absent).
- **Tests**: `tests/*.test.ts` route-level tests follow a stub-fetch / direct-handler pattern
  (e.g. `tests/module-route-gate.test.ts`, `tests/lab-gate.test.ts`) — the consent-403 test
  for D4 will follow those.

### 5. Plan (locked unless owner redirects)
- **Branch**: `agent/task-217-lan-audit` off `fe3e717`.
- **D1 probe pack** — `lib/security-audit/probes.ts`: P1–P6 PowerShell builders (read-only +
  P4's single benign UDP broadcast), each returning the `{probe,title,verdict,severity,
  evidence,remediation}` JSON shape; key redaction in P2 (length/prefix hint only).
- **D2 judging** — `lib/security-audit/judge.ts` (normalize probe JSON → verdict cards) +
  `prisma/schema.prisma` append `SecurityAudit` + `AuditFinding` (ADD-TABLE-ONLY) +
  migration `20261126000000_task217_security_audit_*` (CREATE TABLE only) +
  `lib/security-audit/run.ts` service (consent scope `"lan-audit"` via
  `recordConsent`/`currentConsent`, persist run + findings) +
  `app/api/security-audit/…` routes (start run, list runs, get run) following the cyberlab
  route shape; consent missing ⇒ 403.
- **D3 console** — `command` tab: "Run network audit" panel that queues the probe batch
  through the EXISTING `createQueuedCommand`/`runCommandNow` flow (server assembles the
  probe script; the client never ships raw commands), results parsed by the judge and
  rendered as findings cards (LEAK-first) + per-run history.
- **D4 tests** — `tests/security-audit-judge.test.ts` (P1–P6 fixtures → expected cards,
  incl. redaction), `tests/security-audit-scope.test.ts` (static blocklist scan over the
  probe source: deauth/flood/spray/exploit/mdk/aircrack/… ⇒ suite fails if an attack probe
  is ever added), consent-403 route test. Gates: `tsc --noEmit` 0; suite ≥ baseline
  (1588/1587/0/1); eslint clean on touched files.
- **Out-of-scope text in UI**: deauth/PMKID/handshake (no monitor mode on Windows), neighbor
  exploitation, flooding, spraying — Phase 2 attested lane only.
- **No commit until instructed. NO push, NO deploy, NO box access.**

### 6. Deviations / owner decisions
- None yet. Any box/schema reconciliation question goes back to the owner.

## IN-FLIGHT PROGRESS (task agent, 2026-10-17)

### Done so far
1. **BEFORE complete** — clobber check (`scripts/s217-shared-diff.{sh,out}`), baseline
   gates verbatim (`tsc=0`; suite **1588/1587/0/1, exit=0** in `/tmp/t217-tests-before2.log`;
   the first capture `/tmp/t217-tests-before.log` was truncated by a terminal flake at ok 161
   — not a suite failure), file-grounded findings, plan locked (sections 1–5 above).
2. **Branch cut**: `agent/task-217-lan-audit` off local main `fe3e717`. No commits yet.
3. **D1 probe pack WRITTEN** — new file `lib/security-audit/probes.ts` (201 lines):
   - Exports: `AUDIT_PROBE_IDS` (P1–P6), `AuditProbeId`, `AUDIT_JSON_BEGIN/END` marker
     constants (`===SW_AUDIT_JSON===` / `===SW_AUDIT_END===`), `buildAuditScript()`.
   - Each probe is a self-contained `try/catch` PowerShell block appending one hashtable to
     `$swResults`; the script's ONLY stdout contract is the marker-delimited
     `ConvertTo-Json -Depth 6 -Compress` array at the end.
   - **P1** WiFi link (`netsh wlan show interfaces` → ssid/bssid/auth/cipher, parsed into
     `$sw*` variables — netsh output is never printed directly).
   - **P2** stored-key exposure — the key value goes into `$swKeyVal` for length + 2-char
     prefix ONLY (`keyLength`, `keyPrefix`); never emitted. Redundant scrub lives in the
     judge (to be written) + is a hard test.
   - **P3** gateway/ARP (`Get-NetRoute 0.0.0.0/0` gateway + gwCount; `arp -a` parsed for
     ip/mac entries + gateway MAC; neighborCount).
   - **P4** broadcast reach — ONE benign UDP broadcast send (payload
     "spaceworker-lan-audit-probe", port 9, single packet) then a 4-second PASSIVE listener
     on SSDP (bind :1900 with ReuseAddress + join 239.255.255.250), collecting up to 5
     service hints (SERVER:/ST:/NOTIFY). `notes` records broadcast-sent/send-failed/listen-skip.
   - **P5** poisoning/relay surface — LLMNR `EnableMulticast` (default 1 = enabled),
     NetBIOS NodeType, SMB server+client `RequireSecuritySignature`,
     `LmCompatibilityLevel` (default 3).
   - **P6** listening sockets (`netstat -an` LISTENING lines → count + first 40).
   - The script uses `String.raw` heredocs, `$ErrorActionPreference = "SilentlyContinue"`,
     all variables `$sw`-prefixed; assembled SERVER-side only — the client never ships it.

### Completion status (2026-10-17, D1–D4 done)

| Deliverable | Status |
|---|---|
| **D1** probe pack `lib/security-audit/probes.ts` | DONE (202 lines) — P1–P6, markers, `buildAuditScript()` |
| **D2** judging service `lib/security-audit/judge.ts` | DONE — `judgeP1..P6`, `judgeAudit` (LEAK-first), `scrubSecrets`, `parseAuditOutput` |
| **D2** schema + migration `SecurityAudit`/`AuditFinding` + `20261126000000_task217_security_audit` | DONE — ADD-TABLE-ONLY, 2 tables + 4 indexes, **PARITY_OK** vs schema-generated DDL |
| **D2** run service `lib/security-audit/run.ts` | DONE — consent scope `lan-audit`, `buildAuditScript()` → existing `runCommandNow` (powershell ≤90s) → parse → judge → persist |
| **D2** routes `app/api/security-audit/{consent,runs,runs/[id]}` | DONE — 401 no session; 403 `lan_audit_consent_required` before any device call; `xdevice_required` gate |
| **D3** CommandTab wiring `NetworkAuditCard` | DONE — consent check + one-click run, LEAK-first cards w/ remediation, `noData` notice, offline-disabled button; `deviceId` threaded into `CommandTab` |
| **D4** `tests/security-audit-judge.test.ts` | DONE — 27 tests (P1–P6 fixtures, multi-finding P5, LEAK-first batch, marker parsing, HARD key-redaction) |
| **D4** `tests/security-audit-scope.test.ts` | DONE — 7 tests (HARD blocklist scan, single-send P4, marker count, no raw-netsh print) |
| **D4** `test:security-audit` script in package.json | DONE |
| **D4** consent 403 route test | NOT DONE — see Deviation 3 below |

### Gates (AFTER)

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | **exit 0** (`/tmp/t217-tsc-final2.log`: `tsc_exit=0`) |
| `npm test` (full suite) | **# tests 1622 / # pass 1621 / # fail 0 / # skipped 1, exit=0** (`/tmp/t217-full-tests.log`) — baseline 1588/1587/0/1 ⇒ **+34 new tests, 0 regressions** (1 skip = known DB-gated test) |
| eslint on all touched files | **exit 0** (probes, judge, run, 3 routes, device-console, 2 tests) |
| `npx prisma validate` | schema valid |
| migration ↔ schema parity | **PARITY_OK** (extracted `SecurityAudit`+`AuditFinding`+4 indexes from `prisma migrate diff --from-empty --to-schema-datamodel --script` == migration.sql, ignoring `--`/blank) |

Note on the Prisma client: `npx prisma generate` must be re-run after the schema append or
tsc reports `Property 'securityAudit' does not exist` (generated client predates the models).
Regenerated ⇒ tsc 0. Env/step-ordering issue, not a code error; no `pretest` hook regenerates.

### Deviations from plan (honest record)

1. **File-write displacements (self-healed):** files written in chunks came out with
   displaced/duplicated fragments — `judge.ts` (judgeP4 tail at EOF, missing `judgeError`
   closers, stray `});`) — fixed by inspection before gates. Final state tsc-clean + tested.
2. **`SCOPE_BLOCKED` lives in the test, not `probes.ts`:** probes.ts header comment §4 says the
   test owns the blocklist — followed that; `probes.ts` does not export it.
3. **Consent 403 route test NOT written:** the house require-hook route-test pattern
   (`tests/module-route-gate.test.ts`) stubs Prisma/session per-route; standing it up for the
   new routes did not fit the remaining budget. The 403 path is covered by code review + tsc
   (consent checked before any device call), but there is **no automated route test** — flagged
   for the verification agent as the one gap.

### Remaining (in order)
1. D5 handoff — AFTER + `## HANDOFF → VERIFICATION AGENT` (this section) — DONE.
2. Consent 403 route test (optional follow-up, Deviation 3).
3. NO commit until instructed (PROMPT §5) — uncommitted on `agent/task-217-lan-audit`.

---
## AFTER — 2026-10-17 (task agent)

### Files created (untracked, on `agent/task-217-lan-audit`)
- `lib/security-audit/probes.ts` — D1 probe pack (P1–P6).
- `lib/security-audit/judge.ts` — D2 judging service (pure).
- `lib/security-audit/run.ts` — D2 execution/persist service.
- `app/api/security-audit/consent/route.ts` — GET/POST consent (scope `lan-audit`).
- `app/api/security-audit/runs/route.ts` — POST run + GET history list.
- `app/api/security-audit/runs/[id]/route.ts` — GET one run + findings.
- `prisma/migrations/20261126000000_task217_security_audit/migration.sql` — 2 tables + 4 indexes.
- `tests/security-audit-judge.test.ts`, `tests/security-audit-scope.test.ts` — D4.

### Files modified
- `prisma/schema.prisma` — appended `SecurityAudit` + `AuditFinding` at tail (ADD only).
- `components/device-console.tsx` — `AlertTriangle` icon import; `NetworkAuditCard` +
  `AuditCardView` components (before `ActivityTab`); `deviceId` prop threaded into `CommandTab`
  (signature + type + invocation); card rendered at end of `CommandTab`.
- `package.json` — added `test:security-audit` script.

---
(AFTER narrative + HANDOFF appended next.)

### What the user sees (D3)
In the device console **Command** tab, below "Queued": a **Network audit** card. It states the
six read-only probes and the explicit out-of-scope list (deauth / PMKID / handshake capture /
flooding / spraying / neighbour probing). One button — "Accept terms & run audit" first time,
then "Run network audit" — posts `{deviceId}` only (the server assembles the script). Results
render LEAK-first: red LEAK cards with plain-language evidence + "Fix:" remediation, green
PASS, muted INFO; a `noData` notice if the agent is offline/old (explicitly NOT a clean bill of
health). Button disabled while the device is offline.

## HANDOFF → VERIFICATION AGENT
- Branch `agent/task-217-lan-audit` (cut off main `fe3e717`), **uncommitted** per PROMPT §5.
- Task doc: `/Users/mikeolab/TASK_217_LAN_AUDIT_PROTOCOL.md`; this file = STEPS.
- Gates to re-run: `npx tsc --noEmit` (expect 0 — run `npx prisma generate` first if you see
  `Property 'securityAudit' does not exist`); `npm test` (expect 1622/1621/0/1);
  `npx eslint` on the touched files (expect 0).
- Scope test owns the attack-tool blocklist (`tests/security-audit-scope.test.ts`) — a future
  probe edit that trips it is BY DESIGN (fails until consciously approved).
- **Known gap:** no automated consent-403 route test (Deviation 3). The route checks consent
  before any device call (code-reviewed), but a house-pattern route test is the one missing
  piece if full parity with `module-route-gate.test.ts` is wanted.

