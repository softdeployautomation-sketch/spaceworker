# PLAN — Task 89: SpaceWorker Device AI Agent ("the assistant that minds your PC")

> **⚠️ SUPERSEDED 2026-09-22 — merged into `PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md`
> (priority order changed: Vantra plugin, cookie vault/private browser, WoL
> first). Do not build from this file.**

**Status: draft for owner review — not started.**
**Date drafted: 2026-09-22.**
**Owner's one-line version:** AI agents that help users handle their devices
better — watch activity over time, summarize what was done, trigger background
actions, help reply to email/customers, act from the phone while the PC is
handled remotely — with Vantra RMM added as a plugin so SpaceWorker-only users
get device superpowers too, all behind a hard human-approval gate.

---

## 1. What already exists (build on this — do not rebuild)

SpaceWorker already shipped most of the agent skeleton in Tasks 31/37/39/40/41/43:

| Capability | Where it lives today |
|---|---|
| AI brain w/ tool-calling + cost attribution | Channelry relay (`lib/agent.ts runAgentTurn`) — Task 31 |
| Human-approval gate for agent actions | `AgentPendingAction`: proposal → `pending` → human `approved` → `executed` exactly once, 1h TTL — Task 37 |
| Staged proposals / inline plan cards | Task 37 |
| Per-user daily AI cost caps + admin control | `AiUsageLog`, `User.aiDailyCapHundredthsCent` — Task 40 |
| Agent workspace UI (chat + activity panel) | Task 41 |
| Prepaid AI credits / topups | Task 43 |
| Multi-channel notifications (reach user off-device) | Task 39 |
| Mailboxes + email send/reply plumbing | `Mailbox`, `EmailQueueItem` |
| Device-resident EXE (Tauri, machine-bound licenses, 24h trials) | `src-tauri/`, `ExeLicense` |
| Sibling RMM w/ per-org agent allowlists | Vantra (Task 82 org allowlist) |

The genuinely NEW work: **device-side telemetry + control surface in the EXE**,
the **Vantra plugin link**, the **phone approval loop**, the **cookie vault**,
and **power/keep-awake tooling**.

## 2. Product shape (what the user actually gets)

1. **Activity summaries ("what did I do today?")** — the EXE samples foreground
   app/window titles (NOT keystrokes, NOT screen content); the agent condenses
   them into timeline digests ("2h Excel — invoice run, 45min Chrome — customer
   portal"). Lands in agent chat; optional end-of-day email/push.
2. **Email/customer-reply copilot** — agent drafts replies using mailbox
   context; proposal card shows the draft; user approves, edits, or rejects
   **from phone or PC**; only approval sends.
3. **Background actions with a gate** — anything mutating (open app, cleanup,
   toggle, send mail) is a staged proposal. Read-only stuff (summaries, health)
   runs without approval, per-user toggle.
4. **Phone command surface** — push carries proposal + Quick approve / Edit /
   Reject; user replies from phone, PC executes.
5. **Keep-awake / always-reachable** — one-tap "keep this PC on" (indefinite
   or timed) + wake-on-LAN, so agent and remote sessions always reach it.
6. **Browser cookie vault (opt-in, later phase)** — EXE exports named cookie
   sessions (consented) so the agent can act AS the user on portals. Encrypted
   at rest, never displayed, per-vault expiry + revocation.
7. **Vantra plugin** — SpaceWorker-only users get device monitoring/remote
   control via an auto-provisioned Vantra org behind the scenes; SpaceWorker's
   agent is the front-end ("more advanced than Vantra").
8. **Cybersecurity tools** (Michael-built, Phase F) — plug-in checks the agent
   reports and fixes: AV, patches, open RDP, weak settings.

## 3. Architecture

```
[SpaceWorker EXE (Tauri)]                [SpaceWorker web (Next.js)]
  - telemetry sampler (foreground apps)    - agent chat + digest UI
  - action executor (approved only)        - phone-style proposal inbox
  - keep-awake / WoL trigger               - admin: caps, gates, vault audit
  - cookie vault (opt-in, encrypted)              |
  - embed/bridge Vantra agent              - Channelry AI relay (brain)
        |  mTLS/poll (same pattern as today's EXE<->server)     |
        +-----------------> /opt/spaceworker API <--------------+
                                   |
                        [Vantra API - plugin mode]
                          per-SpaceWorker-user org,
                          agent inventory, remote ops
```

Key decisions to lock before coding:

- **D1 - Vantra plugin mechanism (pick one):**
  a) *Bridge*: SpaceWorker EXE bundles/installs the Vantra agent service
     silently, registered into an auto-created Vantra org per SpaceWorker user
     (org name = `sw-<userId>`, added to Task 82 allowlist). SpaceWorker web
     proxies device ops through Vantra's API with a server-only token.
     Pros: full RMM power day one. Cons: two agents on one box.
  b) *Native*: SpaceWorker EXE grows its own heartbeat + remote-exec channel
     into the SpaceWorker API (no Vantra agent); Vantra used only as ops UI.
     Pros: single agent. Cons: re-implements RMM basics.
  **Recommendation: (a) bridge** - Task 82's per-org allowlist was built for
  exactly this; owner already runs both EXEs side-by-side on the VM.
- **D2 - Telemetry privacy floor:** window titles + app names only, sampled
  <=1/min, stored as rollups (not raw stream) after 24h, per-user master
  switch, visible "agent is watching" indicator in the EXE. No keystrokes,
  no screenshots, no content scraping - non-negotiable for trust.
- **D3 - Cookie vault:** DPAPI-encrypted locally, server copy AES-256-GCM
  with a per-user key, auto-expiry per vault, full audit row per use. Never
  in logs, exports, or AI prompts - the agent receives *session capability*,
  not raw cookies.
- **D4 - Gate rule stays absolute:** every mutating device/email action is a
  staged proposal with TTL, one-time execution, full audit trail (mirror
  `AgentPendingAction` semantics device-side). The phone approve/edit/reject
  loop is the same gate, just a second door.

## 4. Phased delivery

### Phase A - Device agent foundation (EXE + API)
- A1: EXE heartbeat v2: device inventory + online status into SpaceWorker DB
  (`Device`, `DeviceHeartbeat` models; machine-bound like `ExeLicense`).
- A2: Telemetry sampler (foreground app/window, <=1/min) -> local ring buffer ->
  batched upload; `ActivityRollup` model; per-user toggle + tray indicator.
- A3: Digest: Channelry call condenses rollups -> `AgentMessage` in a pinned
  "Device digest" thread; end-of-day push/email option.
- A4: Keep-awake tool: Tauri `SetThreadExecutionState` + `DevicePowerPolicy`
  (indefinite/timed) + one-tap command button in web. User-initiated both ways,
  so no proposal gate needed for this one.
- **Exit:** user sees "what was done on the PC" and can keep it awake.

### Phase B - The gate goes mobile (phone approval loop)
- B1: Proposal push: reuse Task 39 channels; payload = plan card + risk note +
  Approve/Edit/Reject deep links, delivered to phone.
- B2: Tokenized one-tap endpoints (signed, short-TTL, single-use) so approve
  from phone needs no full login; every tap -> `AgentPendingAction` audit row.
- B3: Edit-then-approve: phone form edits payload fields before execution.
- **Exit:** agent proposes "reply to this customer" -> user approves from
  phone -> it sends.

### Phase C - Email copilot (agent replies to customers)
- C1: Inbound-mail watcher per connected `Mailbox` -> agent drafts reply with
  mailbox/campaign context -> staged proposal (never auto-send).
- C2: Thread memory: one `AgentThread` per mailbox conversation.
- C3: Guardrails: send-rate limits, recipient allow/deny, draft expiry, and an
  "autopilot per-mailbox" switch (default OFF) that downgrades approval to
  notify-only for LOW-risk replies only.
- **Exit:** near-hands-off replies with the gate intact.

### Phase D - Vantra plugin (device superpowers for SpaceWorker-only users)
- D1: Server-side Vantra org provisioning per SpaceWorker user (`VantraLink`
  model: orgId, agentTokenEnc, status) using the Task 82 per-org allowlist.
- D2: SpaceWorker EXE installs/bridges the Vantra agent silently on first
  "enable device agent" toggle; health surfaced in SpaceWorker UI.
- D3: Device tools for the agent via Vantra API: run script, reboot, wake,
  remote-session request - each wrapped as a gated proposal.
- D4: Packaging: device-agent features metered against AI credits (Task 43) +
  a "Device" tier flag on `User`.
- **Exit:** SpaceWorker-only user gets Vantra-class device control inside
  SpaceWorker, no Vantra signup.

### Phase E - Cookie vault + act-as-me
- E1: EXE vault capture (Chrome/Edge/Firefox cookie stores, DPAPI-decrypted
  locally, re-encrypted before upload), per-site vaults, expiry, revocation UI.
- E2: Agent capability: "open portal X as me, read Y" via headless browser
  (reuse SpaceWorker's existing `browser-server` automation).
- E3: Audit + kill-switch: every vault use logged; vault auto-freezes on
  new-device login, unknown IP, or the manual panic button.
- **Exit:** agent checks a customer portal with the user's session and drafts
  the reply using live data.

### Phase F - Cybersecurity toolbelt (Michael-built checks)
- F1: Plugin interface the agent calls: AV present, Defender status, pending
  patches, open RDP/SMB, disk encryption, startup junk.
- F2: Weekly "security digest" + one-click fixes (each fix = gated action).
- **Exit:** the digest becomes a selling point, not just a summary.

## 5. Schema additions (draft)

- `Device` (userId, machineId, name, os, lastSeen, powerPolicyId)
- `DeviceHeartbeat` (deviceId, ts, metrics Json) - rollup/TTL old rows
- `ActivityRollup` (deviceId, windowStart, appBuckets Json)
- `DevicePowerPolicy` (deviceId, mode "off"|"timed"|"indefinite", until)
- `VantraLink` (userId, orgId, agentTokenEnc, status)
- `CookieVaultItem` (userId, deviceId, siteLabel, encBlob, expiresAt, revokedAt)
- `AgentActionAudit` (userId, deviceId?, pendingActionId?, channel "web"|"phone", outcome)
- Extend `AgentPendingAction.kind`: add "device" | "email-reply" | "power" | "security-fix"

## 6. Security / privacy gates (owner sign-off required)

1. Telemetry = metadata only; master toggle; tray indicator; 24h raw retention.
2. No cookies/credentials ever enter an AI prompt or a log line.
3. Every mutating action = staged proposal + one-time execution + audit row.
4. Phone one-tap endpoints: signed, single-use, short TTL, device-bound.
5. Vantra plugin tokens server-only; org per user (Task 82 allowlist) so no
   cross-user org access is possible.
6. Panic switch: one click pauses ALL agent device actions + freezes vaults.

## 7. Open questions for the owner

- Q1: Phase D mechanism - bundle the Vantra agent (recommended) vs native channel?
- Q2: Digests free, or metered against AI credits from day one?
- Q3: Cookie vault: which browsers first (Chrome/Edge assumed), and which site
  is the flagship demo (webmail? a customer portal?)
- Q4: Autopilot for LOW-risk email replies - allow at all, or always approve?
- Q5: Phone surface = push + PWA for now, or native mobile app in scope?
- Q6: Naming - "SpaceWorker Assistant"? (marketing copy depends on it)

## 8. Suggested first slice (if approved)

Phase A only (A1-A4). It is self-contained, ships real value ("summarize my PC
day" + "keep my PC on"), touches no cookies and no Vantra, and lays down the
`Device`/telemetry/audit scaffolding every later phase needs. Shape: one
hand-written SQL migration (per HOW_WE_MOVE_FAST section 3), three Rust
modules in the EXE (sampler, power policy, uploader), three API routes, one
digest agent tool, digest UI inside the existing Task 41 agent workspace.



