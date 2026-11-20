# Browser Clone — UI placement, launch modes & "same-IP router" findings

**Status: findings for owner sign-off. Pipeline is NEXT; UI comes after the first
real end-to-end clone.**
**Related:** `TASK_97_BROWSER_CLONE.md` (pipeline + MT-1 contract), `PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md` §PRIORITY P2,
`michael/browser-clone/README.md` + `engine/README-ENGINE.md`, `HOW_WE_MOVE_FAST.md` §0–§3.

---

## 1. Findings — most of what we were about to plan already exists

I read the merged engine (`michael/browser-clone/engine`, PR #2) before designing
anything. These are built and live-proven, so they are **integration work, not new
engineering**:

| Capability | Where | Notes |
|---|---|---|
| **The "router" (same-IP egress)** | `cmd/relay` | Work-PC egress relay: `--addr 127.0.0.1:8118 --token <bearer>`, CONNECT + plain HTTP, IPv4-first. Michael's README: relayed vs direct egress IP **proven identical** on a live VM→hosted test. |
| **Relay is enforced, not advisory** | `pkg/injection/injector.go` | `[IP CHECK 2]`: launch **aborts** if the relay is unreachable ("a clone launched without it would leak the hosted PC's IP and burn the carried sessions"). `[IP CHECK 4]`: background watchdog terminates the clone browser if the relay drops **>30s**. |
| **"Launch without the user's network"** | same file | **Already exists**: `launch --proxy-optional` downgrades an unreachable relay to a warning + audit event (`EvEgressMismatch`, `warning`) instead of failing. This is exactly the option you asked about. |
| **Full clone lifecycle CLI** | `cmd/hack-browser-clone` | `detect · clone · send/package · receive · inject · launch · status · status-all · revoke · expire · audit · preflight · provision-key · serve · list` |
| **Per-clone registry + audit** | `pkg/registry`, `pkg/audit` | Registry entry per clone; append-only audit events (launch/inject/egress-mismatch). This is what feeds "every clone has a date and is logged". |
| **Headless launch already used** | `headlessValidate` / `headlessCommand` | `--headless --no-sandbox --disable-gpu`; used today for [INJECT CHECK 5] profile validation. |
| **Installers** | `engine/scripts/*` | quarantine-first `install-relay.ps1`, `install-hosted.ps1`, `set-acls.ps1` — the agent can run these. |

**Consequence:** the CloneJob pipeline is mostly *orchestration + schema + UI*. The
transfer, validation, egress policy and revocation primitives are done.

---

## 2. UI placement — decision: 5th console tab + a Summary card

**Recommendation: a dedicated `Browser clone` tab in the device console, plus a
compact status card on Summary.** Not a dropdown action, not a toolbox entry.

Why a tab:

- A clone is **stateful** — lifecycle (job → captured → transferred → launched →
  active → expired/revoked), TTL, relay health, history. That is a *capability
  surface*, not a one-shot command. One-shot tools stay in the toolbox split
  (TASK_103); lifecycle objects get a tab.
- It carries **history** ("every clone has a date and is saved") — a list needs room.
- It upgrades the reservation already in `DESIGN_DEVICES_PAGE.md` §3b.

Final console tabs: `Summary · Remote control · Command · Browser clone · Activity`.

**Summary card (compact, always visible):**
`Cloned browser — inactive · last clone 2 Sep, expired` + primary button
`Open cloned browser` (enabled only when a live session exists) + `Manage clones →`
which switches to the tab.

**Session view opens in a NEW TAB**, full-screen, no dashboard chrome — same
treatment as the console `?full=1` fix (TASK_103): route
`/dashboard/devices/[deviceId]/clone/[cloneId]` rendered outside `app/dashboard/layout.tsx`
so the user gets the hosted browser session and its toolbar only.

---

## 3. Per-clone record — date, log, keep

One `CloneJob` row per clone (TASK_97 deliverable 1), surfaced as a history list in
the tab:

| Column (UI) | Field | Why |
|---|---|---|
| Date | `createdAt` (+ `launchedAt`) | your "every clone has a date" |
| Browser / profile | `browser`, `profileName` | Chrome/Edge/Firefox + profile |
| Status | `status` | `pending · capturing · transferring · ready · active · expired · revoked · failed` |
| Egress | `relayMode` (`relay` \| `direct`) + `egressVerified` | tells the truth about which IP the session used |
| Expires | `expiresAt` | TTL countdown |
| Actions | — | `Open` (new tab) · `Revoke` · `Delete record` |

Copy rule (consistent with the console): never raw enums — `Waiting for the work PC
to come online` instead of `pending`; `Expired 3 days ago · session closed` instead
of `expired`.

**Retention:** clone *records* are kept indefinitely (audit value); the *staging
material* (captured profiles) is deleted on revoke/expiry — consistent with the
plan's security classes. Admin caps per CROSS-TRACK RULE 7: per-user concurrent
clone cap, hosted-PC pool size, session TTL (all `AdminSetting` keys, no hardwired
limits).

---

## 4. Launch modes and the device-online dependency (the important finding)

| Mode | Egress IP | Needs work PC online? | Needs relay? | When to use |
|---|---|---|---|---|
| **Relay (default — "same IP")** | work PC's IP | **Yes** | **Yes** | Default. Keeps carried sessions valid — this is what makes the clone trustworthy. |
| **Direct egress** (`--proxy-optional`) | hosted PC's IP | No | No | "Launch even when the device is offline." Sessions may re-auth or trip fraud checks — must be labeled. |
| **Wake-then-clone** (composite, TASK_96) | work PC's IP | Yes (woken) | Yes | Best of both: wake the device (WoL / keep-awake), then run relay mode. |

**Key clarification:** *launching* a clone needs the **captured clone**, not the live
device — **except** in relay mode, where the work PC must be online to carry egress.

- device online → relay mode (same IP) or direct mode;
- device offline → **direct mode only**, or wake it first (TASK_96) then relay mode.

This is a **policy flag on the clone, not a hidden fallback**: if the user picks
"same IP" and the device/relay is down, the launch must **fail closed with a clear
message** (`Work PC offline — wake it, or start this session from our network`) and
the audit records which mode was actually used. The engine already behaves this way;
the UI must not paper over it.

---

## 5. Hidden window — findings

Two different meanings, very different answers:

1. **Not visible to the person at the hosted PC** → use **headless clone** on the
   hosted PC (the engine already launches headless for validation). The technician
   drives it through the session view / CDP. This is the sane, low-risk form of
   "run it without a window" and is what I recommend for the product.
2. **Not visible to the person at their own work PC** (clone in a second Windows
   desktop via `CreateDesktop`) → technically possible but **not implemented**,
   fragile across browser versions, and functionally identical to concealment.
   **Recommendation: do not build it.** If ever wanted, it must be an explicit,
   logged, consented mode with a visible indicator — never a default. Same risk class
   as the plan's "no anti-forensics" AUP fences.

Governing boundary (plan §P2, Michael's directive): AI tools receive **capabilities
and results**, never raw cookies/session material; browser/session material is a
higher security class than telemetry; every launch is audited; the global panic
switch covers clone jobs and live sessions.

---

## 6. Build order (pipeline first, then UI — as instructed)

1. **CloneJob pipeline** (TASK_97 deliverables 1–4): schema (`CloneJob`, `RelayHealth`,
   `HostedBrowserSession`), service layer that drives the agent
   (`clone → send → receive → inject → launch`), relay sidecar install + health,
   TTL + teardown, panic-switch integration.
2. **One real end-to-end device clone** — capture → transfer → launch → close, with a
   visible audit trail. No UI work until this passes.
3. **UI**: `Browser clone` tab + Summary card + new-tab session route + history list
   (§2–§3).
4. **Extras**: direct-egress toggle (explicit, labeled), revoke-all, admin caps.

## 7. Owner decisions (2026-10-01) + one still-open question

- **Direct egress mode** (`--proxy-optional`): **PREMIUM ONLY.** Free/standard users
  get relay mode only (same IP); the labeled direct-egress toggle is unlocked by the
  premium entitlement.
- **Clone records:** kept, and **users may delete their own**. **Inactive clones are
  auto-purged after 30 days** (`createdAt`/`lastUsedAt` older than 30 days and not
  `active`) — purge removes the record + staging material together. Active sessions
  are never purged by the sweep; they must expire or be revoked first.
- **Hosted PC:** **pooled** (not one-per-user) for now — the host is a shared resource.
  **Admin sets the pool cap**, same admin-panel mechanism as the other RAM consumers
  (CROSS-TRACK RULE 7 / admission-control). See **TASK_105** for the resource-governor
  automation that enforces caps across ALL high-RAM features, with premium priority and
  premium-queued-under-load behaviour.

### OPEN — Q1: what "session TTL" means (needs a yes/no)

A cloned browser session is a **live Chromium process + profile on the pooled host**;
it holds RAM the whole time it runs. TTL is what stops it running forever:

- **Idle timeout** = nobody touched the session for N minutes → close it. (Proposal: **60 min**)
- **Hard cap** = even if it's being actively used, close it after N hours. (Proposal: **8 h**)

The proposal is therefore: *"a clone closes after 60 minutes of no activity, and in any
case never stays open longer than 8 hours."* Both numbers are admin-adjustable keys.

Pick one:
- **(a)** accept 60 min idle / 8 h hard cap;
- **(b)** same but different numbers;
- **(c)** no automatic close — only the user closes it (not recommended: a forgotten
  session pins RAM on the pooled host indefinitely);
- **(d)** idle-only, no hard cap.


