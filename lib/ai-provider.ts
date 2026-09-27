import "server-only";

import { env } from "./env";

// Self-hosted build, Phase 2 — the self-hosted equivalent of
// lib/channelry-ai.ts. A self-hoster has no Channelry relay account, so
// there's nothing for CHANNELRY_AI_API_KEY to point at; instead they bring
// their own key for any OpenAI-compatible chat-completions endpoint (OpenAI
// itself, Groq, a local Ollama/vLLM instance, etc. — anything speaking the
// same `/chat/completions` shape, selected via AI_PROVIDER_BASE_URL).
//
// Deliberately mirrors ChannelryAiChatOptions / ChannelryAiResult /
// ChannelryAiError's shape (same field names, same error `.code` values)
// so every call site can branch with `isSelfHosted() ? aiProviderChat(...) :
// channelryAiChat(...)` and reuse its existing result-handling code
// unchanged — this module owns zero UI/response-shaping logic of its own.

export interface AiProviderToolCall {
  id?: string;
  name: string;
  arguments: unknown;
}

export interface AiProviderChatOptions {
  system?: string;
  user?: string;
  messages?: Array<{ role: string; content: string }>;
  tools?: unknown[];
  max_tokens?: number;
  temperature?: number;
  json_mode?: boolean;
  // Accepted for call-site parity with ChannelryAiChatOptions; the
  // self-hosted owner's own key has no per-external-user cost attribution to
  // do, so this is intentionally unused here.
  external_user_id: string;
}

export interface AiProviderResult {
  content: string;
  tool_calls?: AiProviderToolCall[];
  usage: { mode: string; cost_hundredths_cent: number };
}

export type AiProviderErrorCode =
  | "unconfigured"
  | "unauthorized"
  | "inactive"
  | "over_cap"
  | "temporarily_unavailable"
  | "bad_request";

export class AiProviderError extends Error {
  readonly code: AiProviderErrorCode;
  readonly status: number;
  constructor(code: AiProviderErrorCode, message: string, status: number) {
    super(message);
    this.name = "AiProviderError";
    this.code = code;
    this.status = status;
  }
}

/** True when AI_PROVIDER_API_KEY is set — self-hosted AI features are usable at all. */
export function aiProviderConfigured(): boolean {
  return env.aiProviderApiKey.trim().length > 0;
}

/**
 * TASK_130 — explicit credential override. The first-run wizard must test a
 * key the user just typed, BEFORE it's in .env / `env.aiProviderApiKey` (which
 * is evaluated once at boot and cannot see it). Rather than duplicate this
 * whole module into the setup route, every read of a credential below goes
 * through this override, and callers with no override get today's behaviour
 * byte-for-byte.
 */
export interface AiProviderOverride {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

function toMessages(opts: AiProviderChatOptions): Array<{ role: string; content: string }> {
  if (opts.messages && opts.messages.length > 0) return opts.messages;
  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  if (opts.user) messages.push({ role: "user", content: opts.user });
  return messages;
}

/**
 * POST a chat completion to the customer's configured AI_PROVIDER_BASE_URL
 * (default https://api.openai.com/v1), using AI_PROVIDER_API_KEY /
 * AI_PROVIDER_MODEL. Error mapping intentionally mirrors channelryAiChat's:
 *
 *   401 → "unauthorized"           (bad key)
 *   429 → "over_cap"               (the CUSTOMER's own provider rate limit,
 *                                    not a SpaceWorker-imposed cap)
 *   5xx / network failure → "temporarily_unavailable" (never leak raw upstream body)
 *   key unset → "unconfigured"
 */
export async function aiProviderChat(
  opts: AiProviderChatOptions,
  override: AiProviderOverride = {},
): Promise<AiProviderResult> {
  // TASK_130 — resolve credentials from the override first (the setup wizard's
  // not-yet-saved values), falling back to the boot-time env. `.trim()` here
  // means a whitespace-only override behaves the same as unconfigured.
  const apiKey = (override.apiKey ?? env.aiProviderApiKey).trim();
  if (apiKey.length === 0) {
    throw new AiProviderError(
      "unconfigured",
      "AI is not configured — set AI_PROVIDER_API_KEY in setup.",
      0,
    );
  }
  const baseUrl = (override.baseUrl ?? env.aiProviderBaseUrl).replace(/\/$/, "");
  const model = override.model ?? env.aiProviderModel;

  const payload: Record<string, unknown> = {
    model,
    messages: toMessages(opts),
  };
  if (opts.tools !== undefined) payload.tools = opts.tools;
  if (opts.max_tokens !== undefined) payload.max_tokens = opts.max_tokens;
  if (opts.temperature !== undefined) payload.temperature = opts.temperature;
  if (opts.json_mode) payload.response_format = { type: "json_object" };

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new AiProviderError("temporarily_unavailable", "AI service temporarily unavailable.", 0);
  }

  if (res.status === 401 || res.status === 403) {
    throw new AiProviderError(
      "unauthorized",
      `The configured AI provider key was rejected (${res.status}). Check AI_PROVIDER_API_KEY.`,
      res.status,
    );
  }
  if (res.status === 429) {
    throw new AiProviderError(
      "over_cap",
      "The configured AI provider rejected the request as rate-limited (429).",
      429,
    );
  }
  if (!res.ok) {
    if (res.status >= 500) {
      throw new AiProviderError("temporarily_unavailable", "AI service temporarily unavailable.", res.status);
    }
    const body = await res.text().catch(() => "");
    throw new AiProviderError(
      "bad_request",
      `AI provider returned an unexpected error (${res.status}): ${body.slice(0, 200)}`,
      res.status,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new AiProviderError("bad_request", "AI provider returned an unreadable response.", 502);
  }

  const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = (choices[0] ?? {}) as Record<string, unknown>;
  const message = (typeof first.message === "object" && first.message !== null
    ? first.message
    : {}) as Record<string, unknown>;

  const content = typeof message.content === "string" ? message.content : "";
  const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : undefined;
  const tool_calls = rawToolCalls?.map((tc) => {
    const t = (typeof tc === "object" && tc !== null ? tc : {}) as Record<string, unknown>;
    const fn = (typeof t.function === "object" && t.function !== null ? t.function : {}) as Record<
      string,
      unknown
    >;
    let parsedArgs: unknown = null;
    if (typeof fn.arguments === "string") {
      try {
        parsedArgs = JSON.parse(fn.arguments);
      } catch {
        parsedArgs = fn.arguments;
      }
    } else if (fn.arguments !== undefined) {
      parsedArgs = fn.arguments;
    }
    return {
      id: typeof t.id === "string" ? t.id : undefined,
      name: typeof fn.name === "string" ? fn.name : "",
      arguments: parsedArgs,
    };
  });

  return {
    content,
    tool_calls,
    // No pooled-cost attribution for a BYO key — always zero, kept only for
    // call-site shape parity with ChannelryAiResult.
    usage: { mode: "self_hosted_byo_key", cost_hundredths_cent: 0 },
  };
}
