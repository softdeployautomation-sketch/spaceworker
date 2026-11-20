# DESIGN — Devices page (SpaceWorker web) — v1 scope for sign-off

> Reference: PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md (V1–V2 parity, P2 Browser Clone seams) · HOW_WE_MOVE_FAST.md · TASK_95 (implements this) · TASK_97 (future consumer)

**Status: DRAFT — awaiting owner sign-off before implementation.**

## 1. Research anchor — patterns we're copying (why it looks like this)

| Product | Pattern we take |
|---|---|
| **Tailscale admin** | Machine list = calm table/cards, status FIRST (green dot + "online 3m ago"), every action behind an explicit …-menu. No raw IDs in headings. |
| **Synology DSM / Unraid** | One device = one "console" page with tabbed sections (Overview / Actions / Software / History), not one long scary page. |
| **Datadog infrastructure** | Every number carries a timestamp ("checked in 2m ago") — trust through freshness. |
| **Apple Screen Time / iOS Screen Sharing** | Consent surfaces: an always-visible line telling the user the agent can see activity and how to stop it (our privacy floor, made visible). |

**Core principles for our page:** (1) status before identity, (2) destructive/remote actions never one-click-visible-as-primary, (3) the human gate is part of the UI, not a hidden step, (4) everything timestamps, (5) raw org ids / install tokens NEVER surface in headings.

## 2. What's wrong with the current page (from owner screenshot)

1. Raw org id `sw-cmtl47…` as the card heading — meaningless to users.
2. `pending_install` enum shown raw; "New install link" is the FIRST thing on the page — it's a one-time setup action, not the page's purpose.
3. "No devices linked yet" contradicts the just-installed agent (data/sync issue to fix in TASK_95, but the empty state must also be honest and instructive).
4. wake/reboot/shutdown as always-visible buttons on a status row — invites accidental clicks; reboot/shutdown are gated proposals and must look like it.
5. No freshness ("synced 22/09" is not "2m ago"), no device detail surface, no place for the upcoming manual toolset or agent proposals to live.

## 3. Information architecture

```
/dashboard/devices                  ← list page (calm)
/dashboard/devices/[agentId]        ← device console (tabs)
```

### 3a. List page — top to bottom
1. **Header row:** "Devices" + one-line description + freshness note.
2. **Summary strip** (3 chips, click = filter): ● N online · ○ N offline · ⚠ N needs attention (agent offline >24h or pending proposals).
3. **Device cards/table** — one row per DEVICE (not per link): hostname, status dot + "last seen 2m ago", OS icon, agent version, public/private badge (agent family), pending-proposal count. Row click → console.
4. **Empty state (honest):** "No devices yet — install the Vantra agent to add your first machine" + button "Add a device" (opens the setup panel below). After ≥1 device, the panel collapses into a link.
5. **Setup section (collapsed by default, "Add a device" opens it):** install-link flow, friendly copy, steps 1-2-3, copyable link, expiry note. THIS is where "New install link" lives — never above the device list.
6. **Panic stop:** stays top-right but with confirm dialog + "what this stops" list (actions, clone jobs, vaults, sessions).

### 3b. Device console `/dashboard/devices/[agentId]` — tabs
| Tab | Contents (now / future) |
|---|---|
| **Overview** | status, uptime, OS/CPU/RAM/disk, agent version, "checked in Xm ago"; alerts summary; **digest panel** (from Task 92) when telemetry enabled |
| **Actions** | manual tools, grouped, ALL as gated proposals (TASK_95/V2): Power (wake · reboot · shutdown), Session (remote session launch), Scripts (pick + run, shows last result), later: Browser Clone (P2, disabled w/ "coming soon" until TASK_97). Each button opens a proposal card: what will happen → Approve → shows pending state + Telegram-approval hint (TASK_94) |
| **Activity** | proposals history (approved/edited/rejected/expired) + audit rows (Task 92 `AgentActionAudit`) |
| **Settings** | per-device toggles: telemetry on/off, digest on/off, keep-awake (TASK_96), agent family shown read-only (public/private) |

## 4. States & copy rules

- Status words: `Online` / `Offline · last seen 3h ago` / `Asleep` (offline but keep-awake expected) — never raw enums.
- `pending_install` → "Waiting for install — link expires in 3 days".
- Every gated action button: primary label = the verb ("Reboot"), with a small "needs your approval" affordance; the proposal card is the confirmation, NOT a window.confirm.
- Freshness everywhere: `now-relative` timestamps with absolute on hover.
- No raw ids in UI copy; ids only in copy-buttons inside the setup panel.

## 5. Non-goals for this pass

- No new backend: the console reads existing `/api/devices` + adds list/detail/proposal endpoints per TASK_95's contract.
- Browser Clone now has a **dedicated console tab** (not a disabled action) — see `DESIGN_BROWSER_CLONE_UI_AND_FLOW.md` §2. The console's `TABS` array gains `["clone", "Browser clone", Globe]` and the Summary gains a compact clone card. Session views open in a new full-screen tab.
- No mobile-specific layout beyond responsive stacking (phone approvals happen in Telegram per TASK_94).

## 6. Implementation split (when signed off)

1. TASK_95-a: list page rebuild + honest empty state + collapsed setup panel (+ the sync fix so the installed agent actually appears).
2. TASK_95-b: device console shell (Overview + Activity) reading real data.
3. TASK_95-c: Actions tab with the 3 proposal types wired to the existing gated flow (+ Telegram hint once TASK_94 lands).
4. Keep-awake toggles land with TASK_96 in Settings tab.
