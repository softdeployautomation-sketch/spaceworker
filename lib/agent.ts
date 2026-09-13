import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { channelryAiChat } from "@/lib/channelry-ai";
import { MAILBOX_SAFE_SELECT } from "@/lib/mailbox-safe-select";
import { fetchSelectableData, PickerJob } from "@/lib/lead-selectable";

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

These must be your FIRST instinct for that class of question — the same reason
PROPOSE_JOB / PROPOSE_CAMPAIGN are tool calls and not prose. Never fall back to
"please type your job id" or "go upload a file first" in plain text.

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
];

export interface MailboxOption {
  id: string;
  label: string;
  username: string;
}

// Task 37 — an assistant turn that, instead of proposing something, asks the
// user to make a structured pick from a FINITE, known set. The chat panel
// renders the SAME real component the app already uses for that choice (there
// is deliberately no second, simplified widget, and never a raw text prompt for
// something with a finite set of options).
export type InlineWidget =
  | { type: "lead_source_picker"; jobs: PickerJob[] }
  | { type: "lead_upload" }
  | { type: "mailbox_picker"; mailboxes: MailboxOption[] };

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
    kind: "job" | "campaign";
    payload: Record<string, unknown>;
    proposal: string | null;
    expiresAt: string;
  } | null;
  // Non-null when this turn asked the user to make an inline structured pick
  // (lead source / upload / mailbox). Mutually exclusive with pendingAction.
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

// All tool names the agent may emit. PROPOSE_* produce a pending action;
// the widget tools produce an inline structured pick instead.
const WIDGET_TOOL_NAMES = new Set(["list_lead_sources", "request_lead_upload", "list_mailboxes"]);

function findToolCall(toolCalls: unknown): { name: string; args: Record<string, unknown> } | null {
  if (!Array.isArray(toolCalls)) return null;
  for (const tc of toolCalls) {
    if (typeof tc !== "object" || tc === null) continue;
    const name = String((tc as Record<string, unknown>).name ?? "");
    if (
      name === "propose_job" ||
      name === "propose_campaign" ||
      WIDGET_TOOL_NAMES.has(name)
    ) {
      return { name, args: coerceArgs((tc as Record<string, unknown>).arguments) };
    }
  }
  return null;
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

  const reply = result.content;
  const tool = findToolCall(result.tool_calls);
  const isWidget = tool !== null && WIDGET_TOOL_NAMES.has(tool.name);

  // For a widget tool, resolve the inline widget NOW so its snapshot is persisted
  // with the message and survives a reload (same as toolCall does for plans).
  const inlineWidget = isWidget ? await buildInlineWidget(tool!.name, opts.userId) : null;

  // Persist the assistant's message (with the tool snapshot for the plan card,
  // or the inline widget snapshot for a structured pick).
  await prisma.agentMessage.create({
    data: {
      threadId: thread.id,
      role: "assistant",
      content: reply,
      toolCall:
        tool && !isWidget
          ? ({ name: tool.name, args: tool.args } as Prisma.InputJsonValue)
          : Prisma.DbNull,
      inlineWidget: inlineWidget ? (inlineWidget as Prisma.InputJsonValue) : Prisma.DbNull,
    },
  });

  if (!tool || isWidget) {
    return { reply, pendingAction: null, inlineWidget, usage: result.usage };
  }

  // Intercept: persist a pending action, and ONLY a pending action. No real job
  // or campaign is created here — that happens on human approval in the route.
  const kind = tool.name === "propose_job" ? "job" : "campaign";
  const pendingAction = await prisma.agentPendingAction.create({
    data: {
      userId: opts.userId,
      kind,
      status: "pending",
      payload: buildPayload(kind, tool.args) as object,
      proposal: reply || null,
      expiresAt: new Date(Date.now() + AGENT_PROPOSAL_TTL_MS),
    },
    select: { id: true, kind: true, payload: true, proposal: true, expiresAt: true },
  });

  return {
    reply,
    pendingAction: {
      id: pendingAction.id,
      kind: pendingAction.kind === "campaign" ? "campaign" : "job",
      payload: pendingAction.payload as Record<string, unknown>,
      proposal: pendingAction.proposal,
      expiresAt: pendingAction.expiresAt.toISOString(),
    },
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