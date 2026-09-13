import "server-only";

import { env } from "./env";

// Task 31 — SpaceWorker's consumer side of the Channelry external-AI relay.
// The Channelry Worker (`channelry-admin`) exposes a single authenticated
// endpoint that fronts its pooled Groq integration with per-client cost
// attribution. SpaceWorker is registered there as the `spaceworker` client
// (daily_pool $50, admin-adjustable on Channelry's side without a redeploy).
//
// This module is THE one place every SpaceWorker caller (the admin "Test
// connection" button today, the Automations AI agent tomorrow) talks to that
// endpoint through — matching this codebase's established discipline where
// `lib/campaign-create.ts`, `lib/deliverability.ts`, etc. are each the single
// implementation of their concern. No raw `fetch(CHANNELRY_AI_ENDPOINT)`
// calls live anywhere else.

export const CHANNELRY_AI_ENDPOINT =
  "https://channelry-admin.olowolabiakinwale.workers.dev/external/ai-chat";

/** Normalized usage block the relay returns (units: hundredths of a cent). */
export interface ChannelryAiUsage {
  mode: string;
  cost_hundredths_cent: number;
  used_today_hundredths_cent?: number;
  cap_hundredths_cent?: number;
}

export interface ChannelryAiToolCall {
  id?: string;
  name: string;
  arguments: unknown;
}

export interface ChannelryAiChatOptions {
  // Plain-completion mode: pass `system`/`user`.
  system?: string;
  user?: string;
  // Tool-calling mode: pass `messages` (and optionally `tools`).
  messages?: Array<{ role: string; content: string }>;
  tools?: unknown[];
  max_tokens?: number;
  temperature?: number;
  json_mode?: boolean;
  // SpaceWorker's own opaque user id. Channelry attributes cost per-client
  // (SpaceWorker) only — this field is what lets SpaceWorker break down ITS
  // OWN daily pool by its own user later if it ever wants to. Never hardcode
  // or omit it, even if every caller today just passes an internal id.
  external_user_id: string;
}

export interface ChannelryAiResult {
  content: string;
  tool_calls?: ChannelryAiToolCall[];
  usage: ChannelryAiUsage;
}

export type ChannelryAiErrorCode =
  | "unconfigured"
  | "unauthorized"
  | "inactive"
  | "over_cap"
  | "temporarily_unavailable"
  | "bad_request";

/**
 * Typed failure for every non-success path. The message is deliberately
 * end-user-safe already: 502 upstream Groq errors surface as a generic "AI
 * service temporarily unavailable" (never the raw upstream message, per the
 * contract), and the `.code` field lets callers branch programmatically.
 */
export class ChannelryAiError extends Error {
  readonly code: ChannelryAiErrorCode;
  readonly status: number;
  constructor(code: ChannelryAiErrorCode, message: string, status: number) {
    super(message);
    this.name = "ChannelryAiError";
    this.code = code;
    this.status = status;
  }
}

/** True when CHANNELRY_AI_API_KEY is set — the relay is usable at all. */
export function channelryAiConfigured(): boolean {
  return env.channelryAiApiKey.trim().length > 0;
}

function toUsage(raw: unknown): ChannelryAiUsage {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    mode: typeof r.mode === "string" ? r.mode : "unknown",
    cost_hundredths_cent:
      typeof r.cost_hundredths_cent === "number" ? r.cost_hundredths_cent : 0,
    used_today_hundredths_cent:
      typeof r.used_today_hundredths_cent === "number" ? r.used_today_hundredths_cent : undefined,
    cap_hundredths_cent:
      typeof r.cap_hundredths_cent === "number" ? r.cap_hundredths_cent : undefined,
  };
}

/**
 * POST a completion to the Channelry external-AI relay. Attaches the Bearer
 * key from env (never committed), returns a typed result, and maps the relay's
 * error statuses to explicit, informative ChannelryAiError failures instead of
 * a generic throw:
 *
 *   401 → "unauthorized"        (bad/inactive key)
 *   403 → "inactive"            (client deactivated on Channelry's side)
 *   429 → "over_cap"            (SpaceWorker's own daily pool exhausted)
 *   502 → "temporarily_unavailable" (upstream Groq error — never leak raw msg)
 *   network failure → "temporarily_unavailable"
 *   key unset → "unconfigured"  (fail closed, never a fake/empty key)
 */
export async function channelryAiChat(
  opts: ChannelryAiChatOptions
): Promise<ChannelryAiResult> {
  if (!channelryAiConfigured()) {
    throw new ChannelryAiError(
      "unconfigured",
      "AI is not configured — set CHANNELRY_AI_API_KEY.",
      0
    );
  }

  const payload: Record<string, unknown> = {
    external_user_id: opts.external_user_id,
  };
  if (opts.system !== undefined) payload.system = opts.system;
  if (opts.user !== undefined) payload.user = opts.user;
  if (opts.messages !== undefined) payload.messages = opts.messages;
  if (opts.tools !== undefined) payload.tools = opts.tools;
  if (opts.max_tokens !== undefined) payload.max_tokens = opts.max_tokens;
  if (opts.temperature !== undefined) payload.temperature = opts.temperature;
  if (opts.json_mode !== undefined) payload.json_mode = opts.json_mode;

  let res: Response;
  try {
    res = await fetch(CHANNELRY_AI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.channelryAiApiKey}`,
      },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new ChannelryAiError(
      "temporarily_unavailable",
      "AI service temporarily unavailable.",
      0
    );
  }
if (res.status === 401) {
    throw new ChannelryAiError(
      "unauthorized",
      "The Channelry AI key was rejected (401). Check CHANNELRY_AI_API_KEY or whether the client was deactivated.",
      401
    );
  }
  if (res.status === 403) {
    throw new ChannelryAiError(
      "inactive",
      "The Channelry AI client is deactivated (403). Re-enable it in the Channelry admin panel.",
      403
    );
  }
  if (res.status === 429) {
    let detail = "";
    try {
      const b = (await res.json()) as Record<string, unknown>;
      const used = typeof b.used_hundredths_cent === "number" ? b.used_hundredths_cent : undefined;
      const cap = typeof b.cap_hundredths_cent === "number" ? b.cap_hundredths_cent : undefined;
      if (used !== undefined && cap !== undefined) {
        detail = ` (${used}/${cap} hundredths of a cent used today)`;
      }
    } catch {
      // body unreadable — keep the plain message
    }
    throw new ChannelryAiError(
      "over_cap",
      `The SpaceWorker AI daily cap is exhausted (429).${detail} It resets at Channelry's day boundary.`,
      429
    );
  }

  if (!res.ok) {
    // 502 = upstream Groq failure. Surface as generic, don't leak the raw
    // upstream message to end users; anything else non-ok is bad_request.
    if (res.status === 502) {
      throw new ChannelryAiError(
        "temporarily_unavailable",
        "AI service temporarily unavailable.",
        502
      );
    }
    throw new ChannelryAiError(
      "bad_request",
      `AI service returned an unexpected error (${res.status}).`,
      res.status
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ChannelryAiError(
      "bad_request",
      "AI service returned an unreadable response.",
      502
    );
  }

  const record = (typeof body === "object" && body !== null ? body : {}) as Record<
    string,
    unknown
  >;
  if (typeof record.content !== "string") {
    throw new ChannelryAiError(
      "bad_request",
      "AI service returned a malformed response.",
      502
    );
  }

  // Root-caused live 2026-09-13: the relay returns the standard OpenAI
  // function-calling shape — {id, type: "function", function: {name,
  // arguments}} — but this mapping was reading tc.name/tc.arguments directly,
  // which don't exist at that level. Every tool call has been silently turned
  // into { name: "", arguments: null } since Task 31's first implementation —
  // findToolCall (lib/agent.ts) then correctly found no matching name and
  // treated a perfectly valid tool call as if the model had said nothing,
  // which is what produced the "agent won't do anything, just repeats a
  // generic reply" symptom on ANY request that should have triggered a tool.
  // Read the nested function.* fields (with a flat fallback retained in case
  // any caller ever gets the older shape) rather than the top level.
  const toolCallsRaw = Array.isArray(record.tool_calls) ? record.tool_calls : undefined;
  const tool_calls = toolCallsRaw?.map((tc) => {
    const t = (typeof tc === "object" && tc !== null ? tc : {}) as Record<string, unknown>;
    const fn = (typeof t.function === "object" && t.function !== null ? t.function : {}) as Record<string, unknown>;
    return {
      id: typeof t.id === "string" ? t.id : undefined,
      name: typeof fn.name === "string" ? fn.name : (typeof t.name === "string" ? t.name : ""),
      arguments: fn.arguments ?? t.arguments ?? null,
    };
  });

  return {
    content: record.content,
    tool_calls,
    usage: toUsage(record.usage),
  };
}