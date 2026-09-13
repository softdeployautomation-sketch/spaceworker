import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { channelryAiChat } from "@/lib/channelry-ai";

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

Rules:
- Always surface your reasoning in plain text BEFORE (or alongside) your tool
  call so the user sees a reviewable card.
- If the request is ambiguous, ask one short clarifying question instead of
  guessing wildly.
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
];

export interface AgentThreadMessage {
  id: string;
  role: string;
  content: string;
  toolCall: unknown;
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

function findToolCall(toolCalls: unknown): { name: string; args: Record<string, unknown> } | null {
  if (!Array.isArray(toolCalls)) return null;
  for (const tc of toolCalls) {
    if (typeof tc !== "object" || tc === null) continue;
    const name = String((tc as Record<string, unknown>).name ?? "");
    if (name === "propose_job" || name === "propose_campaign") {
      return { name, args: coerceArgs((tc as Record<string, unknown>).arguments) };
    }
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

  // Persist the assistant's message (with the tool snapshot for the plan card).
  await prisma.agentMessage.create({
    data: {
      threadId: thread.id,
      role: "assistant",
      content: reply,
      toolCall: tool ? ({ name: tool.name, args: tool.args } as Prisma.InputJsonValue) : Prisma.DbNull,
    },
  });

  if (!tool) {
    return { reply, pendingAction: null, usage: result.usage };
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