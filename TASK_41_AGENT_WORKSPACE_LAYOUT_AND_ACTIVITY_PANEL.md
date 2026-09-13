# Task 41 — Agent workspace layout: expandable inline widgets + a persistent activity panel

**Status: ready for Cline, after Task 38 lands and is reviewed.** Pure frontend/UX — no schema or backend change. Builds on `app/dashboard/automations/page.tsx`'s existing chat panel (Task 31/37/38) and its inline-widget system; this task restructures how that content is LAID OUT and DISCLOSED, not what data it shows.

## The ask, as given (2026-09-13), live-testing feedback on Task 38's chat

> i think its best user can enlarge or bring out from chat the inline stuff, or when it get to a point of interaction, so users can see whats going on, and have a conversation at the same time without scrolling. the modal showing this actions the agent is performing should appear ontop and should transition nicely, we need to style the platform, and so users can also bring out other neccessary inline stuff that still require conversation, like the test message and also other things, and users might want to see the activity of the agent going on without missing track and adding more decisions, so they can see the stage while just chatting, and during the campaign, agent can handle most of the task.

## Why this is real, not just polish

The "Ask the agent" panel today is a `max-h-80 overflow-y-auto` chat box inside a fixed 380px sidebar column (`app/dashboard/automations/page.tsx` ~line 640's `xl:grid-cols-[minmax(0,1fr)_380px]`, chat box at ~line 966). Every inline widget Task 37/38 built (`lead_source_picker`, `mailbox_picker`, `campaign_status_list`, `diagnostics_result`, `lead_upload`) renders INSIDE that cramped box, inline with chat bubbles. As Task 38 adds genuinely multi-step agent flows (check status → run diagnostics → propose pin → approve, potentially across several turns), two real problems show up:

1. A widget with real content (a diagnostics checklist, a list of stuck campaigns) is squeezed into the same narrow column as chat bubbles — no room to read it AND keep typing.
2. There's no way to see "what has the agent done so far in this whole flow" without scrolling back through raw chat history — the individual steps (checked status, ran diagnostics, proposed pin) are just separate bubbles with no larger sense of "stage."

## 1. An expand/pop-out affordance on inline widgets

Every inline widget component (`InlineLeadSourcePicker`, `InlineMailboxPicker`, `InlineCampaignStatusList`, `InlineDiagnosticsResult`, `InlineLeadUpload`) gets a small expand icon-button in its corner. Clicking it opens that EXACT SAME component (not a duplicate/simplified one — reuse the component instance's props) inside a **slide-in drawer** anchored to one side of the viewport (right edge reads most natural given the existing sidebar-on-the-right layout), animated in with a CSS transition (`transition-transform duration-200 ease-out` or equivalent Tailwind utilities — this codebase has no animation library and doesn't need one for a single slide/fade).

**Critical constraint from the ask**: the drawer must NOT cover/replace the chat — the chat (with its message list and input box) stays visible and usable at the same time, either beside the drawer (on wide screens, shrink the chat column rather than overlay it) or the drawer sits as a translucent-backed overlay that doesn't block the input ("have a conversation at the same time without scrolling"). Closing the drawer returns the widget to its normal inline home in the chat (it's the same state, just displayed differently — no separate "expanded" data fetch or duplicate state).

Generalize this as ONE reusable pattern (e.g. a `<ExpandableInline>` wrapper component each inline widget opts into), not five bespoke implementations — the ask explicitly names future cases too ("other necessary inline stuff that still require conversation, like the test message and also other things"), so whatever gets built here should be trivial to wrap around a future widget type without new plumbing.

## 2. A persistent "Agent activity" panel

A running, chronological, human-readable log of what the agent has actually done in this thread — distinct from the raw chat transcript, which mixes prose with widget noise and requires scrolling to reconstruct a multi-step flow. This is derivable ENTIRELY from state already being fetched (`agentMessages`, `agentPending`, `agentOutcomes`) — no new backend endpoint needed. One line per meaningful event, e.g.:

- "Checked campaign status — 2 stuck"
- "Ran diagnostics on 'Q3 outreach' — subject: clean, body: spam"
- "Proposed pinning the clean subject for 50 sends — awaiting your approval"
- "Pin applied — 50 sends locked"

Build a small pure function (e.g. `deriveActivityLog(messages, pending, outcomes)`) that walks the existing data and produces these entries — keep it in the same file or a small new `lib/agent-activity.ts` if that reads cleaner, but it's presentation logic, not a new data model. Show this panel persistently alongside the chat (a second column on wide screens; a toggle/tab on narrow ones — see layout note below) so a user "just chatting" can glance at it and see the stage of a longer flow without losing track, per the ask's "during the campaign, agent can handle most of the task" — this panel is what lets a hands-off user still feel oriented.

## 3. Layout restructure — split on demand, not always-on

**Refined 2026-09-13** (owner, after seeing the plain single-column chat live): don't permanently reserve screen space for the activity panel. Default state is exactly what exists today — one column, just the chat, full width of the sidebar. The moment the agent produces something worth a second view (an inline widget, or the first entry in the activity log for this turn), the panel **automatically splits into two** — chat on one side, activity/widget detail on the other — with a smooth transition (width/opacity, not an abrupt reflow). When there's nothing to show (a fresh thread, or after the user's cleared everything relevant), it can collapse back to the single-column chat.

- **Wide screens (`xl:` and up)**: single column by default; auto-splits to two side-by-side panels (chat + activity) the first time there's something to show. `grid-template-columns` transitioning between `[1fr]` and `[minmax(0,1fr)_320px]` (or similar) driven by whether the activity log is non-empty is the natural implementation — a CSS transition on the grid handles the "nicely" part of the ask.
- **Narrow/mobile**: the same on-demand logic applies, but a second SIDE-BY-SIDE column doesn't fit — fall back to a tab switcher that appears (with a small badge/dot indicating new activity) only once there's something in it, rather than showing an empty "Activity" tab from the start.
- The expand-drawer from item 1 is a separate, further zoom-in on ONE widget's full detail — it can be invoked whether the layout is currently split or not, and layers on top either way.

## Explicitly out of scope

- Any new agent tool, backend endpoint, or data model — this is pure presentation over existing state.
- A generic "notification/toast" system — the activity panel is a persistent log inside this page, not a cross-app notification (that's Task 39's separate concern).
- Redesigning the rest of the dashboard ("we need to style the platform" is acknowledged as a real, larger ambition, but this task scopes to the agent chat/activity surface specifically — a full design-system pass is a separate, much bigger initiative to scope on its own if wanted).

## Verification expected

- `npx tsc --noEmit` / `npm run build` clean.
- Confirm the DEFAULT state (fresh thread, no widgets yet) still looks exactly like today's single-column chat — the split must be earned by real content, never shown empty.
- Trigger a multi-step flow live (ask about a stuck campaign → run diagnostics → propose a pin) and confirm the layout auto-splits on the first widget, the activity panel shows all three steps without needing to scroll the chat to find them, and the split transition is smooth rather than an abrupt jump.
- Confirm expanding a widget (e.g. `diagnostics_result` with several probes) opens the drawer with a visible slide/fade transition, and that the chat input is still reachable/usable while the drawer is open — not blocked by a full-screen backdrop.
- Confirm collapsing back to mobile width degrades to the tab switcher (badged only once there's real activity) rather than an overlapping/broken layout — check at ~400px width per this app's existing responsive convention.

## Note — a related bug fixed separately (2026-09-13)

While testing this live, the owner also hit a case where the agent's reply described a lead-source picker in plain prose ("**Please choose a lead source:** [Select a finished lead source]") instead of actually calling `list_lead_sources` — nothing clickable rendered at all. That's a `lib/agent.ts` model-reliability issue (the relay sometimes skips the tool call despite the system prompt), fixed independently of this task via a corrective `detectMissedWidgetIntent` fallback plus a strengthened system-prompt rule — not something this task needs to touch. Once this task's expand/activity UI lands, that corrective widget will display exactly like a normal one.
