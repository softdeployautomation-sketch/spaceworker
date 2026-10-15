// TASK_156B S7-B (PLAN_CYBERLAB_NEXT_S7 §1 Slice B) — the tool bridge's PURE
// core: deep-links out to the real tools (mailer campaigns / extractor /
// RMM devices) with a return-to-run context, validated on the way back in.
//
// Design constraints (plan hard lines), all deliberate:
//   - Deep-links, NOT clones: the tool pages are untouched (other teams'
//     files). The return path is the CONSTANT "/cyberlab" — there is no
//     user-controlled redirect anywhere in this module, so there is no open
//     redirect surface to audit.
//   - The context travels in sessionStorage (same-origin, per-tab), written
//     synchronously on the click that leaves and read when the console
//     remounts. Everything read back is re-validated: shape, known tool id,
//     strict rangeId pattern, and a 24h freshness window — a tampered or
//     stale entry simply reads as null (the banner never appears), never as
//     an error or an arbitrary URL.
//   - Dependency-free and client-safe (no "server-only", no db): the same
//     validation runs in tests, in the browser, and (via BRIDGE_TOOL_IDS /
//     BRIDGE_MAX_CONTENT_CHARS) as the API's allow-list and size cap.

/** Storage key for the pending bridge context (sessionStorage, per-tab). */
export const BRIDGE_STORAGE_KEY = "cyberlab.bridge.v1";

/** A bridge context older than this is ignored (you left the tool long ago). */
export const BRIDGE_CONTEXT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Hard cap on pasted tool output — the API enforces the same number. */
export const BRIDGE_MAX_CONTENT_CHARS = 65_536;

/** The tools the lab bridges to. Href targets are the existing app routes. */
export const BRIDGE_TOOL_IDS = ["mailer", "extract", "devices"] as const;

export type BridgeToolId = (typeof BRIDGE_TOOL_IDS)[number];

export interface BridgeTool {
  id: BridgeToolId;
  label: string;
  href: string;
  /** What you do there, in one honest line. */
  hint: string;
}

export const BRIDGE_TOOLS: BridgeTool[] = [
  {
    id: "mailer",
    label: "Mailer — phishing sim",
    href: "/dashboard/campaigns",
    hint: "Send the simulated phishing campaign to your own mailbox and watch what a real target would click.",
  },
  {
    id: "extract",
    label: "Extractor — credential capture",
    href: "/dashboard/extract",
    hint: "Run the credential-capture flow against data you own to see how little it takes.",
  },
  {
    id: "devices",
    label: "Devices — RMM access",
    href: "/dashboard/devices",
    hint: "Reach a device you own over the agent — the phase-2 “now I’m inside” step.",
  },
];

/** A recorded round-trip: which tool, for which lab run, when. */
export interface BridgeContext {
  toolId: BridgeToolId;
  rangeId: string;
  at: number;
}

/**
 * Range ids are cuids — lowercase alphanumerics only. Anything else (path
 * separators, encoded dots, foreign shapes) is refused at BOTH ends so a
 * tampered context can never smuggle a different id into the attach call.
 */
const RANGE_ID_RE = /^[a-z0-9]{10,64}$/;

export function isBridgeToolId(value: unknown): value is BridgeToolId {
  return typeof value === "string" && (BRIDGE_TOOL_IDS as readonly string[]).includes(value);
}

export function bridgeTool(id: string): BridgeTool | null {
  return BRIDGE_TOOLS.find((t) => t.id === id) ?? null;
}

export function isRangeId(value: unknown): value is string {
  return typeof value === "string" && RANGE_ID_RE.test(value);
}

/** The deep-link href. A context-less link (no run open) is still valid. */
export function bridgeHref(toolId: BridgeToolId, rangeId?: string | null): string {
  const tool = bridgeTool(toolId);
  if (!tool) throw new Error(`unknown_bridge_tool (${toolId})`);
  return isRangeId(rangeId) ? `${tool.href}?labBridge=${encodeURIComponent(rangeId)}` : tool.href;
}

/** Serialise a context for sessionStorage. Invalid input returns null — never throws. */
export function serializeBridgeContext(ctx: BridgeContext): string | null {
  if (!isBridgeToolId(ctx.toolId) || !isRangeId(ctx.rangeId)) return null;
  if (!Number.isFinite(ctx.at)) return null;
  return JSON.stringify({ toolId: ctx.toolId, rangeId: ctx.rangeId, at: ctx.at });
}

/**
 * Parse + re-validate a stored context. Strict by construction: wrong JSON,
 * wrong shape, unknown tool, bad rangeId, or a context older than the
 * freshness window (or stamped in the future) all read as null. The banner
 * simply doesn't appear — an invalid context is indistinguishable from none.
 */
export function parseBridgeContext(raw: string | null, nowMs: number): BridgeContext | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const ctx = parsed as Record<string, unknown>;
  if (!isBridgeToolId(ctx.toolId)) return null;
  if (!isRangeId(ctx.rangeId)) return null;
  if (typeof ctx.at !== "number" || !Number.isFinite(ctx.at)) return null;
  const age = nowMs - ctx.at;
  // Allow a small clock skew forward; refuse anything stale.
  if (age > BRIDGE_CONTEXT_MAX_AGE_MS || age < -5 * 60 * 1000) return null;
  return { toolId: ctx.toolId, rangeId: ctx.rangeId, at: ctx.at };
}
