import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { channelryAiChat } from "@/lib/channelry-ai";
import { MAILBOX_SAFE_SELECT } from "@/lib/mailbox-safe-select";
import { fetchSelectableData, PickerJob } from "@/lib/lead-selectable";
import {
  DeliverabilityError,
  runCampaignDiagnostics,
  type DiagnosticsProbeOutcome,
} from "@/lib/deliverability";
import type { AgentActionKind } from "@/lib/agent-executor";

// Task 31, item 3 — the Automations "Ask the agent" feature.
//
// The agent's job is INTERPRETING INTENT into parameters for SpaceWorker's own
// existing REST endpoints — not new backend capability. It routes through the
// Channelry external-AI relay's tool-calling mode (see lib/channelry-ai.ts) and
// exposes `propose_job` / `propose_campaign` as its tools.
//
// The critical property, mirroring Channelry's own "Agent Decider System"
// precedent (approval-gated tool calls), reimplemented here in our own schema:
// the agent NEVER creates a real SearchJob or EmailCampaign. Emitting a tool
// call only persists an AgentPendingAction row (kind "job"/"campaign") with a
// one-hour TTL. A human Approve (PATCH /api/agent/actions/[id]/approve) is what
// turns that pending row into a real job/campaign, through the exact same
// creation helpers POST /api/jobs and POST /api/campaigns use.

export const AGENT_PROPOSAL_TTL_MS = 60 * 60 * 1000; // 1 hour
const MESSAGE_HISTORY_LIMIT = 12;

// The system prompt encodes what this session proved works for converting a
// vague goal ("AI apps outreach") into GOOD find/location terms: broad-but-
// specific industry + role phrasing. The worker's own expansion machinery
// (worker/automation.py) does the rest — the agent only picks the BASE terms.
const AGENT_SYSTEM_PROMPT = `You are the SpaceWorker lead-generation agent. Your job is to turn the user's
plain-language request into a precise plan and present it for approval.

You help with two kinds of task, each mapped to a tool:

1. PROPOSE_JOB — when the user asks you to find/collect/gather leads, contacts,
   prospects, or emails for an audience (e.g. "up to 10,000 leads for AI-apps
   outreach"). You pick strong find terms (specific industry + role phrasing,
   e.g. "AI startup head of growth", "SaaS founder CTO") and broad-but-specific
   location terms. Do NOT invent terms that are so broad they are useless
   ("businesses", "companies") — pick terms a real decision-maker would search.
   The tool call only prepares the plan; it does NOT run anything.

2. PROPOSE_CAMPAIGN — when asked to follow up on a finished extraction by
   planning an email campaign, given the finished SearchJob id. Draft a clear
   campaign name plus one subject line and one HTML body.

Gathering what you need (never ask in prose for a finite, known set of options):
3. LIST_LEAD_SOURCES — as soon as you need a finished extraction/upload to build
   a campaign from and the user hasn't given you a SearchJob id, call this
   instead of asking in text. It shows a real dropdown of the user's own
   finished lead sources in the chat. The choice comes back as a follow-up
   message naming the job id — then propose the campaign with that id.
4. REQUEST_LEAD_UPLOAD — when you need a lead source but the user has no usable
   extraction/upload at all, call this to offer the upload dropzone inline.
   After an upload completes, the new job id comes back in the follow-up.
5. LIST_MAILBOXES — when you need to know which sending mailbox(es) the
   campaign should send from and the user hasn't specified them, call this so
   they pick from a checkbox list in the chat instead of typing names.

Deliverability (Task 38 — stickiness / stuck campaigns):
6. CHECK_CAMPAIGN_STATUS — when the user asks about a stuck/paused campaign (or
   after you propose a campaign), call this to see their campaigns stuck in
   pending_test_confirm or paused_deliverability (id, name, status, most recent
   landed-in/error, seed-vs-override mailbox). This is how you (and the user) see
   "where things are stuck" without leaving the panel.
7. RUN_DIAGNOSTICS — when a campaign is paused_deliverability or
   pending_test_confirm, offer to run the isolation diagnostics to isolate WHICH
   element (subject / body / From address) is triggering spam. On the platform's
   verified seed mailbox (no personal test-recipient override) this executes
   AUTONOMOUSLY right away — reading an objective IMAP-confirmed signal needs no
   permission — and returns the probe results inline. On a personal test-recipient
   override it instead creates an approval card, because the probes fire real test
   emails to the user's own inbox — ask before you send those.
8. PROPOSE_PIN — once a diagnostic probe comes back clean (landed in the inbox),
   recommend pinning that exact subject/body/From combination for the next batch of
   upcoming sends, and explain the tradeoff in ONE sentence BEFORE the tool call
   (mirrors the "surface your reasoning first" rule). A pin is NEVER autonomous — it
   always creates an approval card, even on the seed mailbox.
9. PROPOSE_SWITCH_SUBJECT — when a campaign is stuck and there's a different subject
   to rotate to, propose switching it. Rotating a live campaign's subject is a real,
   visible action, so it always goes through an approval card too — only READING
   diagnostics is autonomous; CHANGING what a campaign sends never is.

These must be your FIRST instinct for that class of question — the same reason
PROPOSE_JOB / PROPOSE_CAMPAIGN are tool calls and not prose. Never fall back to
"please type your job id" or "go upload a file first" in plain text.

CRITICAL — never describe a picker, you must CALL it: if you catch yourself about
to write something like "**Please choose a lead source:**" followed by a
placeholder like "[Select a finished lead source]" or "[choose one]" — STOP. That
placeholder is not a real control; the user cannot click it and the conversation
dead-ends. That exact situation means you should have called LIST_LEAD_SOURCES (or
LIST_MAILBOXES / REQUEST_LEAD_UPLOAD) instead of writing about it. The rule is
simple: if the very next thing the user needs to do is pick from a finite list or
upload a file, your response must BE the tool call, not a sentence describing one.

Rules:
- Always surface your reasoning in plain text BEFORE (or alongside) your tool
  call so the user sees a reviewable card.
- If the request is genuinely ambiguous with no finite option set (e.g. audience
  size, tone), one short clarifying question is fine.
- Never claim you ran or started a job — you only propose. The user must
  approve.
- Prefer planning a single job/campaign per turn. If more is asked, propose the
  first and mention the rest.`;

// OpenAI function-calling tool shapes, forwarded verbatim to the relay's
// tool-calling mode. `propose_job` mirrors the supported params of the real
// POST /api/jobs flow (find/location terms, minResults, maxDurationMinutes,
// emailDomains); `propose_campaign` mirrors the create-campaign content inputs.
const AGENT_TOOLS: unknown[] = [
  {
    type: "function",
    function: {
      name: "propose_job",
      description:
        "Propose a lead-extraction job the user has asked for. Prepares a plan for human approval; it does not run the job. Call this when the user requests leads/contacts/prospects/emails for an audience.",
      parameters: {
        type: "object",
        properties: {
          find_terms: {
            type: "array",
            items: { type: "string" },
            description: "Specific industry + role search phrases (2-6 of them).",
          },
          location_terms: {
            type: "array",
            items: { type: "string" },
            description: "Optional broad-but-specific location terms (countries, states, cities).",
          },
          min_results: {
            type: "integer",
            description: "Target number of leads, if the user asked for a count.",
          },
          max_duration_minutes: {
            type: "integer",
            description: "Max runtime the job should be allowed (1-180).",
          },
          estimated_time_minutes: {
            type: "integer",
            description: "A reasonable estimate of how long this job will take.",
          },
          email_domains: {
            type: "array",
            items: { type: "string" },
            description: "Optional domains to filter results to.",
          },
        },
        required: ["find_terms"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_campaign",
      description:
        "Propose an email campaign against a FINISHED SearchJob's leads. Called only after an extraction has completed, when the user wants to follow up. Prepares a plan for human approval; it does not create the campaign.",
      parameters: {
        type: "object",
        properties: {
          search_job_id: { type: "string", description: "The finished SearchJob id to pull recipients from." },
          name: { type: "string", description: "Short campaign name." },
          subject: { type: "string", description: "One subject line." },
          body_html: { type: "string", description: "One HTML email body." },
          mailbox_ids: {
            type: "array",
            items: { type: "string" },
            description: "Sending mailbox ids, if the user named specific ones.",
          },
        },
        required: ["search_job_id", "name", "subject", "body_html"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_lead_sources",
      description:
        "Offer the user a real dropdown of their own FINISHED lead sources (extractions/uploads) when you need one to build a campaign from but they haven't given you a SearchJob id. Call this INSTEAD of asking in prose. Returns an inline lead_source_picker widget; the user's choice comes back as the next message.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "request_lead_upload",
      description:
        "Offer the user the existing upload dropzone INLINE when you need a lead source but they have no usable extraction/upload yet. Call this INSTEAD of telling them to go upload a file. Returns an inline lead_upload widget; the new job id comes back as the next message.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_mailboxes",
      description:
        "Offer the user a checkbox list of their sending mailboxes when you need to know which mailbox(es) a campaign should send from and they haven't specified them. Call this INSTEAD of asking in prose. Returns an inline mailbox_picker widget; the selection comes back as the next message.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "check_campaign_status",
      description:
        "Show the user their campaigns currently stuck at pending_test_confirm or paused_deliverability (id, name, most recent landed-in/error, and whether it tests against the platform seed mailbox or a personal test-recipient override). Call this when the user asks about a stuck/paused campaign, or after proposing a campaign. Returns an inline campaign_status_list widget.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "run_diagnostics",
      description:
        "Run the isolation diagnostics on a campaign to find which element (subject / body / From address) is triggering spam. On the platform's verified seed mailbox (no personal test-recipient override) it RUNS AUTONOMOUSLY and returns an inline diagnostics_result widget. On a personal test-recipient override it instead creates an approval card first (the probes fire real test emails to the user's own inbox — ask before sending those).",
      parameters: {
        type: "object",
        properties: {
          campaign_id: { type: "string", description: "The campaign's id." },
          keys: {
            type: "array",
            items: { type: "string", enum: ["subject", "body", "emptyBody", "from"] },
            description: "Optional subset of probes to run — omit to run all four.",
          },
        },
        required: ["campaign_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_pin",
      description:
        "Propose pinning a proven-good subject/body/from combination onto a campaign for the next batch of sends (a temporary window that pauses normal rotation). ALWAYS creates an approval card the user must confirm — never auto-applied, even on the seed mailbox. Call this after a diagnostic probe comes back clean.",
      parameters: {
        type: "object",
        properties: {
          campaign_id: { type: "string", description: "The campaign's id." },
          subject: { type: "string", description: "The exact subject to pin." },
          body_html: { type: "string", description: "The exact body HTML to pin (may be empty)." },
          from_address: { type: "string", description: "Optional exact From address to pin." },
          pin_count: {
            type: "integer",
            description: "Optional number of sends to keep this pinned (clamped 1-1000; defaults to the campaign's batch size).",
          },
        },
        required: ["campaign_id", "subject"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_switch_subject",
      description:
        "Propose rotating a stuck campaign to its next independent subject. Rotating a live campaign's subject is a real, visible change, so it ALWAYS creates an approval card — never auto-applied, even on the seed mailbox.",
      parameters: {
        type: "object",
        properties: {
          campaign_id: { type: "string", description: "The campaign's id." },
        },
        required: ["campaign_id"],
      },
    },
  },
];

export interface MailboxOption {
  id: string;
  label: string;
  username: string;
}

// Task 38 — one stuck campaign row in a campaign_status_list widget. The status is
// pending_test_confirm or paused_deliverability, with the most recent check result
// and whether it tests against the platform seed mailbox (auto-verified) or the
// user's personal test-recipient override (human-eyeballed).
export interface CampaignStatusItem {
  id: string;
  name: string;
  status: string;
  landedIn: string | null;
  lastError: string | null;
  overrideRecipient: boolean;
}

// Task 37 — an assistant turn that, instead of proposing something, asks the
// user to make a structured pick from a FINITE, known set. The chat panel
// renders the SAME real component the app already uses for that choice (there
// is deliberately no second, simplified widget, and never a raw text prompt for
// something with a finite set of options).
//
// Task 38 — two more widgets: campaign_status_list (where things are stuck) and
// diagnostics_result (the same probe-checklist visual as the campaign detail
// page, returned either autonomically on the seed mailbox or after an approval).
export type InlineWidget =
  | { type: "lead_source_picker"; jobs: PickerJob[] }
  | { type: "lead_upload" }
  | { type: "mailbox_picker"; mailboxes: MailboxOption[] }
  | { type: "campaign_status_list"; campaigns: CampaignStatusItem[] }
  | {
      type: "diagnostics_result";
      results: DiagnosticsProbeOutcome[];
      // Non-null when the probes were sent to a personal test-recipient override
      // (the user must eyeball their own inbox); null when a seed mailbox
      // auto-verified placement.
      overrideRecipient?: string | null;
      // A hard blocker (no active mailbox / no seed configured / campaign missing)
      // surfaced as an error note instead of a crash.
      error?: string | null;
    };

export interface AgentThreadMessage {
  id: string;
  role: string;
  content: string;
  toolCall: unknown;
  inlineWidget: InlineWidget | null;
  createdAt: string;
}

export interface AgentTurnResult {
  reply: string;
  // Non-null when this turn produced a pending (not yet approved) proposal.
  pendingAction: {
    id: string;
    kind: AgentActionKind;
    payload: Record<string, unknown>;
    proposal: string | null;
    expiresAt: string;
  } | null;
  // Non-null when this turn asked the user to make an inline structured pick /
  // read (lead source / upload / mailbox / campaign status / diagnostics result).
  // Mutually exclusive with pendingAction.
  inlineWidget: InlineWidget | null;
  usage: unknown;
}

async function getOrCreateThread(userId: string) {
  const existing = await prisma.agentThread.findFirst({ where: { userId } });
  if (existing) return existing;
  return prisma.agentThread.create({ data: { userId } });
}

function coerceArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === "object" && raw !== null) return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
    } catch {
      // fall through
    }
  }
  return {};
}

function normStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    const s = typeof v === "string" ? v.trim() : "";
    if (s) out.push(s);
  }
  return out;
}

function pickString(value: unknown): string | undefined {
  const s = typeof value === "string" ? value.trim() : "";
  return s || undefined;
}

function pickInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.floor(n);
  }
  return undefined;
}

// Every tool name the agent may emit. Widget/execute tools produce an inline
// structured read; PROPOSE_* tools produce a pending (approval-gated) action.
const ALL_TOOL_NAMES = new Set([
  "propose_job",
  "propose_campaign",
  "list_lead_sources",
  "request_lead_upload",
  "list_mailboxes",
  "check_campaign_status",
  "run_diagnostics",
  "propose_pin",
  "propose_switch_subject",
]);

function findToolCall(toolCalls: unknown): { name: string; args: Record<string, unknown> } | null {
  if (!Array.isArray(toolCalls)) return null;
  for (const tc of toolCalls) {
    if (typeof tc !== "object" || tc === null) continue;
    const name = String((tc as Record<string, unknown>).name ?? "");
    if (ALL_TOOL_NAMES.has(name)) {
      return { name, args: coerceArgs((tc as Record<string, unknown>).arguments) };
    }
  }
  return null;
}

// Confirmed live (2026-09-13): despite the system prompt's explicit instruction,
// the relay's underlying model sometimes DESCRIBES a picker in prose instead of
// actually calling the tool that renders one — e.g. replying "**Please choose a
// lead source:** [Select a finished lead source]" as literal text, with no
// tool_calls at all. That leaves nothing clickable, so the user hits a dead end.
// This detects the unmistakable cases (the reply is unambiguously asking the user
// to pick from one of these three finite sets) and synthesizes the REAL widget
// anyway, via the exact same processToolCall path a genuine tool call would use —
// a corrective fallback for a demonstrated model-reliability gap, not a guess.
function detectMissedWidgetIntent(replyText: string): "list_lead_sources" | "list_mailboxes" | "request_lead_upload" | null {
  const t = replyText.toLowerCase();
  const asksToPick = /\b(choose|pick|select)\b/.test(t);
  if (/\blead[\s-]?source/.test(t) && asksToPick) return "list_lead_sources";
  if (/\bupload\b/.test(t) && /\b(no|don't have|do not have|haven't)\b/.test(t)) return "request_lead_upload";
  if (/\bmailbox(es)?\b/.test(t) && asksToPick) return "list_mailboxes";
  return null;
}

// Where the user's stuck campaigns are, for the campaign_status_list widget.
async function loadCampaignsForStatus(userId: string): Promise<CampaignStatusItem[]> {
  const rows = await prisma.emailCampaign.findMany({
    where: { userId, status: { in: ["pending_test_confirm", "paused_deliverability"] } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      status: true,
      testRecipientOverride: true,
      checks: {
        orderBy: { checkedAt: "desc" },
        take: 1,
        select: { landedIn: true, error: true },
      },
    },
  });
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status,
    landedIn: c.checks[0]?.landedIn ?? null,
    lastError: c.checks[0]?.error ?? null,
    overrideRecipient: Boolean(c.testRecipientOverride?.trim()),
  }));
}

// Shields the diagnostics tool from running probes against an override-mode
// campaign autonomously: returns the override address if set (the campaign needs
// an approval card first), null on the seed mailbox (safe to read autonomously).
async function resolveDiagOverride(campaignId: string, userId: string): Promise<string | null> {
  const c = await prisma.emailCampaign.findFirst({
    where: { id: campaignId, userId },
    select: { testRecipientOverride: true },
  });
  return c?.testRecipientOverride?.trim() || null;
}

// A widget tool triggers NO AgentPendingAction (nothing is being proposed yet) —
// it tells the chat panel to render a real component so the user can make a
// structured pick instead of digging up an id (or uploading a file) elsewhere.
async function buildInlineWidget(
  name: string,
  userId: string
): Promise<InlineWidget | null> {
  if (name === "list_lead_sources") {
    const { jobs } = await fetchSelectableData(userId);
    return { type: "lead_source_picker", jobs };
  }
  if (name === "request_lead_upload") {
    // No data needed — the widget IS the existing upload dropzone. The frontend
    // posts to POST /api/leads/upload and auto-advances on success.
    return { type: "lead_upload" };
  }
  if (name === "list_mailboxes") {
    const mailboxes = await prisma.mailbox.findMany({
      where: { userId },
      select: MAILBOX_SAFE_SELECT,
      orderBy: { createdAt: "asc" },
    });
    return {
      type: "mailbox_picker",
      mailboxes: mailboxes.map((m) => ({ id: m.id, label: m.label, username: m.username })),
    };
  }
  return null;
}

// The per-tool outcome of an AGENT_TOOLS call:
//  - "widget"  — produce an inline structured read (nothing proposed; may actually
//                execute in the same turn, e.g. autonomous seed-mailbox diagnostics).
//  - "pending" — a proposal awaiting human approval (job / campaign / pin /
//                switch_subject / diagnostics-override).
type ProcessedTool =
  | { kind: "widget"; inlineWidget: InlineWidget }
  | { kind: "pending"; actionKind: AgentActionKind; payload: Record<string, unknown> };

async function processToolCall(
  name: string,
  args: Record<string, unknown>,
  userId: string
): Promise<ProcessedTool | null> {
  // Pure widget picks (no execution, no proposal).
  if (
    name === "list_lead_sources" ||
    name === "request_lead_upload" ||
    name === "list_mailboxes"
  ) {
    const inlineWidget = await buildInlineWidget(name, userId);
    return inlineWidget ? { kind: "widget", inlineWidget } : null;
  }

  if (name === "check_campaign_status") {
    return {
      kind: "widget",
      inlineWidget: { type: "campaign_status_list", campaigns: await loadCampaignsForStatus(userId) },
    };
  }

  if (name === "run_diagnostics") {
    const campaignId = pickString(args.campaign_id) ?? "";
    const keys = normStringArray(args.keys);
    if (!campaignId) return null;
    // Override mode → an approval card first (probes send real mail to the user's
    // own inbox). Seed mailbox (override null) → the ONE autonomous action: run now.
    const override = await resolveDiagOverride(campaignId, userId);
    if (override) {
      return {
        kind: "pending",
        actionKind: "diagnostics",
        payload: { campaign_id: campaignId, keys },
      };
    }
    try {
      const { results } = await runCampaignDiagnostics({ campaignId, userId, keys });
      return { kind: "widget", inlineWidget: { type: "diagnostics_result", results } };
    } catch (err) {
      const message =
        err instanceof DeliverabilityError ? err.message : "Diagnostics failed to run.";
      return {
        kind: "widget",
        inlineWidget: { type: "diagnostics_result", results: [], error: message },
      };
    }
  }

  if (name === "propose_pin") {
    return {
      kind: "pending",
      actionKind: "pin",
      payload: {
        campaign_id: pickString(args.campaign_id) ?? "",
        subject: pickString(args.subject) ?? "",
        body_html: typeof args.body_html === "string" ? args.body_html : "",
        from_address: pickString(args.from_address),
        pin_count: pickInt(args.pin_count),
      },
    };
  }

  if (name === "propose_switch_subject") {
    return {
      kind: "pending",
      actionKind: "switch_subject",
      payload: { campaign_id: pickString(args.campaign_id) ?? "" },
    };
  }

  if (name === "propose_job") {
    return { kind: "pending", actionKind: "job", payload: buildPayload("job", args) };
  }
  if (name === "propose_campaign") {
    return { kind: "pending", actionKind: "campaign", payload: buildPayload("campaign", args) };
  }
  return null;
}

// Persist an approval-gated proposal. The pending action is the ONLY thing written
// here; the real mutation happens on Approve in lib/agent-executor.ts.
async function persistPendingAction(opts: {
  userId: string;
  actionKind: AgentActionKind;
  payload: Record<string, unknown>;
  proposal: string | null;
}): Promise<{
  id: string;
  kind: AgentActionKind;
  payload: Record<string, unknown>;
  proposal: string | null;
  expiresAt: string;
}> {
  const row = await prisma.agentPendingAction.create({
    data: {
      userId: opts.userId,
      kind: opts.actionKind,
      status: "pending",
      payload: opts.payload as object,
      proposal: opts.proposal,
      expiresAt: new Date(Date.now() + AGENT_PROPOSAL_TTL_MS),
    },
    select: { id: true, kind: true, payload: true, proposal: true, expiresAt: true },
  });
  return {
    id: row.id,
    kind: row.kind as AgentActionKind,
    payload: row.payload as Record<string, unknown>,
    proposal: row.proposal,
    expiresAt: row.expiresAt.toISOString(),
  };
}

export async function listThreadMessages(userId: string): Promise<AgentThreadMessage[]> {
  const thread = await prisma.agentThread.findFirst({ where: { userId } });
  if (!thread) return [];
  const rows = await prisma.agentMessage.findMany({
    where: { threadId: thread.id },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  return rows.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    toolCall: m.toolCall,
    inlineWidget: m.inlineWidget as InlineWidget | null,
    createdAt: m.createdAt.toISOString(),
  }));
}

export async function runAgentTurn(opts: { userId: string; message: string }): Promise<AgentTurnResult> {
  const thread = await getOrCreateThread(opts.userId);

  await prisma.agentMessage.create({
    data: { threadId: thread.id, role: "user", content: opts.message },
  });

  // Build the prompt: system + recent history (without tool drafts) + this turn.
  const history = await prisma.agentMessage.findMany({
    where: { threadId: thread.id },
    orderBy: { createdAt: "asc" },
    take: MESSAGE_HISTORY_LIMIT * 2,
  });
  const dialogue = history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-MESSAGE_HISTORY_LIMIT)
    .map((m) => ({ role: m.role, content: m.content }));

  const result = await channelryAiChat({
    messages: [{ role: "system", content: AGENT_SYSTEM_PROMPT }, ...dialogue],
    tools: AGENT_TOOLS,
    max_tokens: 900,
    external_user_id: opts.userId,
  });

  const tool = findToolCall(result.tool_calls);
  let processed = tool ? await processToolCall(tool.name, tool.args, opts.userId) : null;

  // No tool call at all, but the reply is unmistakably describing one of the three
  // finite-choice widgets in prose (see detectMissedWidgetIntent) — synthesize the
  // real widget the model should have called for, rather than leaving the user
  // with dead placeholder text and no way to proceed without leaving the chat.
  if (!processed) {
    const missed = detectMissedWidgetIntent(result.content);
    if (missed) processed = await processToolCall(missed, {}, opts.userId);
  }

  // A widget/execute tool resolves its inline widget NOW so the snapshot is
  // persisted with the message and survives a reload (same discipline as toolCall
  // for plans). Autonomous seed-mailbox diagnostics is handled inside processToolCall.
  const inlineWidget = processed?.kind === "widget" ? processed.inlineWidget : null;

  // Found live (2026-09-13): the relay occasionally returns a genuinely empty
  // completion for casual/off-task input ("hello") with no tool call either. A
  // widget or a pending-action proposal already gives the turn real content to
  // show, so only substitute a fallback when there's truly nothing else — never
  // let an assistant turn render as a silent, stuck-looking blank bubble.
  const reply =
    result.content.trim().length > 0 || inlineWidget || processed?.kind === "pending"
      ? result.content
      : "I can help you find leads, plan a campaign, or check on one that's stuck — what would you like to do?";

  // Persist the assistant's message (with the tool snapshot for a pending plan,
  // or the inline widget snapshot for a structured pick / read).
  await prisma.agentMessage.create({
    data: {
      threadId: thread.id,
      role: "assistant",
      content: reply,
      toolCall:
        tool && processed?.kind === "pending"
          ? ({ name: tool.name, args: tool.args } as Prisma.InputJsonValue)
          : Prisma.DbNull,
      inlineWidget: inlineWidget ? (inlineWidget as Prisma.InputJsonValue) : Prisma.DbNull,
    },
  });

  if (processed?.kind !== "pending") {
    return { reply, pendingAction: null, inlineWidget, usage: result.usage };
  }

  // Intercept: persist a pending action, and ONLY a pending action. No real job,
  // campaign, pin, subject switch, or probe run is executed here — that happens on
  // human approval in lib/agent-executor.ts (the sole mutation path).
  const pendingAction = await persistPendingAction({
    userId: opts.userId,
    actionKind: processed.actionKind,
    payload: processed.payload,
    proposal: reply || null,
  });

  return {
    reply,
    pendingAction,
    inlineWidget: null,
    usage: result.usage,
  };
}

function buildPayload(kind: "job" | "campaign", args: Record<string, unknown>): Record<string, unknown> {
  if (kind === "job") {
    return {
      find_terms: normStringArray(args.find_terms),
      location_terms: normStringArray(args.location_terms),
      min_results: pickInt(args.min_results),
      max_duration_minutes: pickInt(args.max_duration_minutes),
      estimated_time_minutes: pickInt(args.estimated_time_minutes),
      email_domains: normStringArray(args.email_domains),
    };
  }
  return {
    search_job_id: pickString(args.search_job_id) ?? "",
    name: pickString(args.name) ?? "",
    subject: pickString(args.subject) ?? "",
    body_html: pickString(args.body_html) ?? "",
    mailbox_ids: normStringArray(args.mailbox_ids),
  };
}