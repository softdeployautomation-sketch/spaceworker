import "server-only";

import { randomUUID, createHash } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ClineCore, formatProviderOAuthApiKey } from "@cline/sdk";
import { ToolApprovalRequest, ToolApprovalResult } from "@cline/shared";

import { db } from "@/lib/db";
import { getClineAccessToken } from "@/lib/clin/token-store";
import { cyberLabGate, type CyberLabGate } from "./gate";
import type { CyberLabAgentSettings, CyberLabAgentSession } from "@prisma/client";
import { preflightTargets, type PreflightInput } from "./targets-core";
import { TargetRefusedError } from "./targets";

// ---------------------------------------------------------------------------
// Testing seams — allow tests to inject fakes without touching Prisma or the SDK
// ---------------------------------------------------------------------------

let _dbOverride: typeof db | null = null;
let _gateOverride: typeof cyberLabGate | null = null;
let _clineCoreOverride: typeof ClineCore | null = null;
let _clineAccessTokenOverride: ((userId: string) => Promise<string | null>) | null = null;

export function setDbForTesting(database: typeof db): void {
  _dbOverride = database;
}

export function setGateForTesting(gate: typeof cyberLabGate): void {
  _gateOverride = gate;
}

export function setClineCoreForTesting(core: typeof ClineCore): void {
  _clineCoreOverride = core;
}

/** TASK_246: lets tests prove the decrypted OAuth token (not the blob) reaches the SDK. */
export function setClineAccessTokenResolverForTesting(
  resolver: ((userId: string) => Promise<string | null>) | null,
): void {
  _clineAccessTokenOverride = resolver;
}

export function setPendingApprovalForTesting(sessionId: string, request: ToolApprovalRequest): void {
  pendingApprovals.set(sessionId, { request, resolve: () => {}, reject: () => {}, createdAt: Date.now() });
}

function _db(): typeof db {
  return _dbOverride ?? db;
}

function _gate(): typeof cyberLabGate {
  return _gateOverride ?? cyberLabGate;
}

function _clineCore(): typeof ClineCore {
  return _clineCoreOverride ?? ClineCore;
}

async function _clineAccessToken(userId: string): Promise<string | null> {
  return (_clineAccessTokenOverride ?? getClineAccessToken)(userId);
}

type ClineKeySource = "request" | "oauth" | "manual" | "none";

/**
 * TASK_246 — one precedence rule for start and resume:
 * explicit request key > connected Cline OAuth token (decrypted + refreshed) > stored manual key.
 *
 * Before this, the OAuth branch required `providerId === "cline-free"` (never sent
 * by the session route) and passed the encrypted column as the API key.
 */
async function resolveClineApiKey(
  userId: string,
  settings: Pick<CyberLabAgentSettings, "clineApiKeyEnc"> | null,
  explicitKey?: string,
): Promise<{ apiKey?: string; source: ClineKeySource }> {
  if (explicitKey) return { apiKey: explicitKey, source: "request" };
  const oauthToken = await _clineAccessToken(userId);
  if (oauthToken) {
    // TASK_252 — provider "cline" authenticates OAuth sessions with the
    // `workos:<access>` key format. Passing the bare WorkOS JWT produced a 401
    // (`errorClass:"auth"`) even with a perfectly valid token.
    return {
      apiKey: formatProviderOAuthApiKey("cline", { access: oauthToken }),
      source: "oauth",
    };
  }
  if (settings?.clineApiKeyEnc) return { apiKey: settings.clineApiKeyEnc, source: "manual" };
  return { source: "none" };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONTEXT_DOC_ROOT = process.env.CYBERLAB_CONTEXT_DOC_ROOT ?? join(process.cwd(), "cyberlab-contexts");
const IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes idle → shutdown
const RANGE_TTL_MINUTES = Number(process.env.CYBERLAB_RANGE_TTL_MINUTES ?? 60); // range hard TTL

// ---------------------------------------------------------------------------
// In-flight approval state
// ---------------------------------------------------------------------------

interface PendingApproval {
  request: ToolApprovalRequest;
  resolve: (result: ToolApprovalResult) => void;
  reject: (err: Error) => void;
  createdAt: number;
}

const pendingApprovals = new Map<string, PendingApproval>();
const clineInstances = new Map<string, ClineCore>();
const stepCounters = new Map<string, number>();

// ---------------------------------------------------------------------------
// TASK_252 — asynchronous turn state
//
// `cline.start` / `cline.send` resolve only after the WHOLE turn, including a
// tool-approval prompt. Awaiting them inside the HTTP handler meant the request
// hung and the browser never got a session id, so it could never poll for the
// approval it was waiting on. Turns now run in the background and the console
// polls status + transcript.
// ---------------------------------------------------------------------------

interface SessionRunState {
  pending: number;
  queue: Promise<void>;
  lastError?: string;
  lastErrorClass?: string;
  lastFinish?: string;
  lastText?: string;
  unsubscribe?: () => void;
}

const sessionRuns = new Map<string, SessionRunState>();

function getRunState(sessionId: string): SessionRunState {
  let state = sessionRuns.get(sessionId);
  if (!state) {
    state = { pending: 0, queue: Promise.resolve() };
    sessionRuns.set(sessionId, state);
  }
  return state;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Turn a raw provider failure into something the operator can act on. The SDK
 * reports auth rejections as an empty error object with `errorClass:"auth"`, so
 * the class is often the only useful signal.
 */
function friendlyClineFailure(errorClass?: string, message?: string): string {
  const text = (message ?? "").trim();
  if (errorClass === "auth" || /unauthorized|re-authenticate|401|invalid.*token/i.test(text)) {
    return "Cline login was rejected. Open Settings → Cline, reconnect your Cline account, then start a new session (or Resume). The stored token is present but the Cline API did not accept it.";
  }
  if (errorClass === "rate_limit" || /rate.?limit|429|too many requests/i.test(text)) {
    return "Cline rate-limited this turn. Wait a moment, then send your message again. If it persists, switch to another Cline model in Settings → Cline.";
  }
  if (text) return text;
  return "The agent run failed before it could reply. Open the live feed below and try again; if it repeats, reconnect Cline in Settings → Cline.";
}

type SessionUpdateData = {
  status?: string;
  stopReason?: string | null;
  lastActivityAt?: Date;
};

/** Update a session only if it still exists and was not stopped mid-turn. */
async function safeUpdateSession(sessionId: string, data: SessionUpdateData): Promise<void> {
  try {
    const current = await _db().cyberLabAgentSession.findUnique({ where: { id: sessionId } });
    if (!current || current.status === "stopped") return;
    await _db().cyberLabAgentSession.update({ where: { id: sessionId }, data });
  } catch {
    // Session may have been deleted or the process may be shutting down.
  }
}

/**
 * Queue a turn for a session. The HTTP handler returns immediately; completion
 * updates the DB and run state in the background.
 */
function enqueueTurn(sessionId: string, task: () => Promise<void>): void {
  const state = getRunState(sessionId);
  state.pending += 1;

  const execute = async () => {
    try {
      await task();
    } catch (err) {
      const failure = friendlyClineFailure(state.lastErrorClass, errorMessage(err));
      state.lastError = failure;
      state.lastFinish = "error";
      await safeUpdateSession(sessionId, {
        status: "failed",
        stopReason: failure,
        lastActivityAt: new Date(),
      });
    } finally {
      state.pending = Math.max(0, state.pending - 1);
    }
  };

  if (state.pending === 1) {
    // Start immediately when idle: this sets up lastActivity/streams the first
    // events synchronously and avoids a pointless microtask delay.
    state.queue = execute();
  } else {
    // Serialise later messages behind the running turn.
    state.queue = state.queue.then(execute);
  }
}

async function finishTurn(
  sessionId: string,
  finishReason: string | undefined,
  text: string | undefined,
): Promise<void> {
  const state = getRunState(sessionId);
  state.lastFinish = finishReason ?? "completed";
  state.lastText = text ?? "";
  if (state.lastFinish === "error") {
    const failure = friendlyClineFailure(state.lastErrorClass, state.lastError);
    state.lastError = failure;
    await safeUpdateSession(sessionId, {
      status: "failed",
      stopReason: failure,
      lastActivityAt: new Date(),
    });
    return;
  }
  state.lastError = undefined;
  state.lastErrorClass = undefined;
  await safeUpdateSession(sessionId, { status: "active", lastActivityAt: new Date() });
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function maskApiKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  if (key.length <= 8) return "••••••••";
  return "••••••••" + key.slice(-4);
}

function ensureContextDocRoot(): void {
  if (!existsSync(CONTEXT_DOC_ROOT)) mkdirSync(CONTEXT_DOC_ROOT, { recursive: true });
}

function contextDocPathFor(sessionId: string): string {
  return join(CONTEXT_DOC_ROOT, `${sessionId}.md`);
}

function appendContextDoc(sessionId: string, chunk: string): void {
  ensureContextDocRoot();
  const path = contextDocPathFor(sessionId);
  writeFileSync(path, chunk, { flag: "a" });
}

// ---------------------------------------------------------------------------
// Auto context-doc recording via Cline SDK event subscription
// Every significant agent event (tool call, tool result, agent event) is
// appended to the session's context doc with model/key version headers so
// that changing models or API keys never loses history.
// ---------------------------------------------------------------------------

function nextStepNo(sessionId: string): number {
  const n = (stepCounters.get(sessionId) ?? 0) + 1;
  stepCounters.set(sessionId, n);
  return n;
}

async function recordContextDocEvent(
  sessionId: string,
  modelProvider: string,
  modelId: string,
  apiEndpoint: string | undefined,
  eventType: string,
  payload: unknown,
): Promise<void> {
  const stepNo = nextStepNo(sessionId);
  const summary = `${eventType}: ${JSON.stringify(payload).slice(0, 200)}`;
  const content = `## Step ${stepNo} — ${eventType}\n\nModel: ${modelProvider}/${modelId}${apiEndpoint ? ` (${apiEndpoint})` : ""}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`;
  await recordContextDocStep(sessionId, stepNo, summary, content, modelProvider, modelId, apiEndpoint);
}

export function subscribeClineSession(
  sessionId: string,
  cline: ClineCore,
  modelProvider: string,
  modelId: string,
  apiEndpoint: string | undefined,
): (() => void) | undefined {
  try {
    return cline.subscribe((event) => {
      const { type, payload } = event as { type: string; payload: unknown };

      if (type === "hook") {
        const hook = payload as { hookEventName?: string; toolName?: string; iteration?: number };
        if (
          hook.hookEventName === "tool_call" ||
          hook.hookEventName === "tool_result" ||
          hook.hookEventName === "agent_end" ||
          hook.hookEventName === "agent_error"
        ) {
          recordContextDocEvent(
            sessionId,
            modelProvider,
            modelId,
            apiEndpoint,
            `hook:${hook.hookEventName}${hook.toolName ? `/${hook.toolName}` : ""}`,
            hook,
          );
          if (hook.hookEventName === "agent_error") {
            const hookError = hook as {
              errorClass?: string;
              error?: unknown;
              message?: string;
            };
            const state = getRunState(sessionId);
            state.lastErrorClass = hookError.errorClass ?? state.lastErrorClass;
            const msg =
              typeof hookError.message === "string"
                ? hookError.message
                : hookError.error
                  ? errorMessage(hookError.error)
                  : undefined;
            if (msg?.trim()) state.lastError = msg;
          }
        }
      } else if (type === "agent_event") {
        // SDK shape: { sessionId, event: {...}, teamRole }. The old code read
        // `payload.type` (always undefined) and recorded every event as
        // "agent_event:unknown", hiding the actual error event.
        const envelope = payload as {
          event?: { type?: string; errorClass?: string; error?: { message?: string } };
          [key: string]: unknown;
        };
        const agentEvent = envelope.event ?? (payload as { type?: string });
        const eventType = typeof agentEvent.type === "string" ? agentEvent.type : "unknown";
        recordContextDocEvent(
          sessionId,
          modelProvider,
          modelId,
          apiEndpoint,
          `agent_event:${eventType}`,
          envelope,
        );
        if (eventType === "error") {
          const state = getRunState(sessionId);
          const err = (agentEvent as { errorClass?: string; error?: { message?: string } });
          state.lastErrorClass = err.errorClass;
          if (typeof err.error?.message === "string" && err.error.message.trim()) {
            state.lastError = err.error.message;
          }
        }
      } else if (type === "ended") {
        recordContextDocEvent(
          sessionId,
          modelProvider,
          modelId,
          apiEndpoint,
          "session_ended",
          payload,
        );
      } else if (type === "status") {
        recordContextDocEvent(
          sessionId,
          modelProvider,
          modelId,
          apiEndpoint,
          `status:${(payload as { status?: string }).status ?? "unknown"}`,
          payload,
        );
      }
    });
  } catch {
    // subscribe may not be supported in all backend modes — non-fatal
    return undefined;
  }
}

export interface StartSessionInput {
  userId: string;
  prompt: string;
  modelId?: string;
  apiEndpoint?: string;
  apiKey?: string;
  cwd?: string;
  /** Attested targets the agent may operate on (validated pre-flight). */
  targets?: PreflightInput[];
  /** Provider: "cline" (manual API key) | "cline-free" (stored OAuth token) | "external" */
  providerId?: string;
}

export interface StartSessionResult {
  sessionId: string;
  status: "started" | "pending_approval" | "completed" | "failed";
  approvalRequest?: ToolApprovalRequest | null;
  message?: string;
  /** Server-side unsubscribe function for Cline event subscription (not sent to client). */
  unsubscribe?: () => void;
}

export async function startClineLabSession(input: StartSessionInput): Promise<StartSessionResult> {
  const gate = await _gate()(input.userId);
  if (!gate.open) {
    return {
      sessionId: "",
      status: "failed",
      message: `Cyber Lab is not open: enabled=${gate.enabled} entitled=${gate.entitled} consented=${gate.consented}`,
    };
  }

  const killSwitch = await _db().cyberLabKillSwitch.findFirst({
    where: { scope: "global", frozen: true },
  });
  if (killSwitch?.frozen) {
    return { sessionId: "", status: "failed", message: "Cyber Lab agent is frozen globally by admin." };
  }

  const tenantKill = await _db().cyberLabKillSwitch.findFirst({
    where: { scope: "tenant", targetId: input.userId, frozen: true },
  });
  if (tenantKill?.frozen) {
    return { sessionId: "", status: "failed", message: "Your Cyber Lab agent session is frozen by admin." };
  }

  // Pre-flight attested targets (if the caller declared any). Every target must
  // match a FRESH attested LabTarget row for this user — §5.2 hard line.
  if (input.targets && input.targets.length > 0) {
    // Create the LabRange row in pending, then provision → active with TTL.
    const range = await _db().labRange.create({
      data: { userId: input.userId, scenarioId: "cline-agent-session", consentId: null, state: "pending" },
    });

    try {
      const rows = await _db().labTarget.findMany({ where: { userId: input.userId } });
      const { pruned } = preflightTargets(
        rows.map((r) => ({ kind: r.kind, value: r.value, rangeId: r.rangeId, attestedAt: r.attestedAt })),
        input.targets,
        { rangeId: range.id },
      );
      if (pruned.length > 0) {
        await _db().labAbuseReport.create({
          data: {
            userId: input.userId,
            rangeId: range.id,
            reason: "preflight_target_refused",
            severity: "medium",
            evidenceJson: {
              requested: input.targets.map((t) => ({ kind: t.kind, value: t.value })),
              pruned: pruned.map((p) => ({ kind: p.kind, value: p.value, reason: p.reason })),
              at: new Date().toISOString(),
            },
          },
        });
        throw new TargetRefusedError(
          `target pre-flight refused: ${pruned.map((p) => `${p.value} (${p.reason})`).join(", ")}`,
          pruned,
        );
      }
    } catch (err) {
      if (err instanceof TargetRefusedError) {
        await _db().labRange.update({
          where: { id: range.id },
          data: { state: "failed", error: "target_preflight_refused" },
        });
        return {
          sessionId: "",
          status: "failed",
          message: err.message,
        };
      }
      throw err;
    }

    // Provision → active with hard TTL (§8.3).
    await _db().labRange.update({
      where: { id: range.id },
      data: { state: "provisioning" },
    });
    await _db().labRange.update({
      where: { id: range.id },
      data: { state: "active", ttlExpiresAt: new Date(Date.now() + RANGE_TTL_MINUTES * 60_000) },
    });
  }

  const sessionId = randomUUID();
  const cwd = input.cwd ?? join(process.cwd(), `cyberlab-sessions/${sessionId}`);
  mkdirSync(cwd, { recursive: true });

  const settings = await _db().cyberLabAgentSettings.findUnique({
    where: { userId: input.userId },
  });

  const modelId = input.modelId ?? settings?.clineModelId ?? "claude-sonnet-4-6";
  const apiEndpoint = input.apiEndpoint ?? settings?.clineApiEndpoint;

  // Resolve API key: explicit request key > OAuth (decrypted, refreshed) > manual key.
  const resolvedKey = await resolveClineApiKey(input.userId, settings, input.apiKey);
  const apiKey = resolvedKey.apiKey;
  const modelProvider =
    input.providerId ?? (resolvedKey.source === "oauth" ? "cline-free" : "cline");

  await _db().cyberLabAgentSession.create({
    data: {
      id: sessionId,
      userId: input.userId,
      status: "active",
      modelProvider,
      modelId,
      apiEndpoint,
      apiKeyHash: apiKey ? hashApiKey(apiKey) : undefined,
      cwd,
      lastActivityAt: new Date(),
    },
  });

  const capabilities = {
    requestToolApproval: async (request: ToolApprovalRequest): Promise<ToolApprovalResult> => {
      return new Promise<ToolApprovalResult>((resolve, reject) => {
        pendingApprovals.set(sessionId, {
          request,
          resolve,
          reject,
          createdAt: Date.now(),
        });
        setTimeout(() => {
          const pending = pendingApprovals.get(sessionId);
          if (pending) {
            pendingApprovals.delete(sessionId);
            pending.reject(new Error("Tool approval timeout"));
          }
        }, 5 * 60 * 1000);
      });
    },
  };

  let cline: ClineCore;
  try {
    cline = await _clineCore().create({
      clientName: "spaceworker-cyberlab",
      backendMode: "local",
      capabilities,
    });
  } catch (err) {
    const failure = friendlyClineFailure(undefined, errorMessage(err));
    await safeUpdateSession(sessionId, { status: "failed", stopReason: failure });
    return { sessionId, status: "failed", message: failure };
  }

  clineInstances.set(sessionId, cline);

  // Subscribe BEFORE the turn starts: start() emits status/agent events as it
  // runs, and the old code subscribed after awaiting start(), losing them all.
  const unsubscribe = subscribeClineSession(
    sessionId,
    cline,
    modelProvider,
    modelId,
    apiEndpoint ?? undefined,
  );

  getRunState(sessionId).unsubscribe = unsubscribe;
  enqueueTurn(sessionId, async () => {
    const startResult = await cline.start({
      config: {
        sessionId,
        providerId: "cline",
        modelId,
        apiKey: apiKey ?? undefined,
        baseUrl: apiEndpoint ?? undefined,
        systemPrompt: buildCyberLabSystemPrompt(input.userId),
        cwd,
        workspaceRoot: cwd,
        enableTools: true,
        enableSpawnAgent: false,
        enableAgentTeams: false,
      },
      prompt: input.prompt,
      interactive: true,
    });
    await finishTurn(
      sessionId,
      startResult.result?.finishReason,
      startResult.result?.text,
    );
  });

  return {
    sessionId,
    status: "started",
    message:
      "Session started — the agent is working. Live transcript and tool approvals appear in the console.",
    unsubscribe,
  };
}

export async function sendClineMessage(sessionId: string, prompt: string, userId: string): Promise<{
  status: "started" | "pending_approval" | "completed" | "failed";
  approvalRequest?: ToolApprovalRequest | null;
  message?: string;
}> {
  const session = await _db().cyberLabAgentSession.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) {
    return { status: "failed", message: "Session not found" };
  }
  if (session.frozenByAdmin) {
    return { status: "failed", message: "Session is frozen by admin" };
  }

  const cline = clineInstances.get(sessionId);
  if (!cline) {
    return { status: "failed", message: "Session runtime is not active. Use Resume to recreate it." };
  }
  if (sessionRuns.get(sessionId)?.lastFinish === "error") {
    return {
      status: "failed",
      message:
        "The last turn failed. Use Resume to recreate the session with a fresh Cline connection (reconnect in Settings → Cline first if the error was an auth error).",
    };
  }

  await safeUpdateSession(sessionId, { status: "active", lastActivityAt: new Date() });
  enqueueTurn(sessionId, async () => {
    const result = await cline.send({ sessionId, prompt });
    await finishTurn(sessionId, result?.finishReason, result?.text);
  });

  return {
    status: "started",
    message: "Message queued — the agent is working.",
  };
}

/**
 * Resume a Cline session after idle shutdown, kill switch, or server restart.
 * Recreates the Cline instance from stored session config and sends a prompt,
 * continuing from where the session stopped. Context doc recording is
 * re-subscribed so no step is missed across model/API-key changes.
 */
export async function resumeClineSession(
  sessionId: string,
  userId: string,
  prompt: string,
): Promise<{
  status: "started" | "pending_approval" | "completed" | "failed";
  approvalRequest?: ToolApprovalRequest | null;
  message?: string;
  unsubscribe?: () => void;
}> {
  const session = await _db().cyberLabAgentSession.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) {
    return { status: "failed", message: "Session not found" };
  }
  if (session.frozenByAdmin) {
    return { status: "failed", message: "Session is frozen by admin" };
  }

  const killSwitch = await _db().cyberLabKillSwitch.findFirst({
    where: { scope: "global", frozen: true },
  });
  if (killSwitch?.frozen) {
    return { status: "failed", message: "Cyber Lab agent is frozen globally by admin." };
  }

  const tenantKill = await _db().cyberLabKillSwitch.findFirst({
    where: { scope: "tenant", targetId: userId, frozen: true },
  });
  if (tenantKill?.frozen) {
    return { status: "failed", message: "Your Cyber Lab agent session is frozen by admin." };
  }

  const settings = await _db().cyberLabAgentSettings.findUnique({
    where: { userId },
  });
  const modelId = session.modelId ?? settings?.clineModelId ?? "claude-sonnet-4-6";
  const apiEndpoint = session.apiEndpoint ?? settings?.clineApiEndpoint;

  // Same precedence as start: explicit key > OAuth (decrypted, refreshed) > manual.
  // A session that began with OAuth must keep using a live token, not a stored blob.
  const resolvedKey = await resolveClineApiKey(userId, settings);
  const apiKey = resolvedKey.apiKey;

  // Recreate the Cline instance from stored config.
  const cwd = session.cwd ?? join(process.cwd(), `cyberlab-sessions/${sessionId}`);
  mkdirSync(cwd, { recursive: true });

  const capabilities = {
    requestToolApproval: async (request: ToolApprovalRequest): Promise<ToolApprovalResult> => {
      return new Promise<ToolApprovalResult>((resolve, reject) => {
        pendingApprovals.set(sessionId, {
          request,
          resolve,
          reject,
          createdAt: Date.now(),
        });
        setTimeout(() => {
          const pending = pendingApprovals.get(sessionId);
          if (pending) {
            pendingApprovals.delete(sessionId);
            pending.reject(new Error("Tool approval timeout"));
          }
        }, 5 * 60 * 1000);
      });
    },
  };

  let cline: ClineCore;
  try {
    cline = await _clineCore().create({
      clientName: "spaceworker-cyberlab",
      backendMode: "local",
      capabilities,
    });
  } catch (err) {
    const failure = friendlyClineFailure(undefined, errorMessage(err));
    await safeUpdateSession(sessionId, { status: "failed", stopReason: failure });
    return { status: "failed", message: failure };
  }

  clineInstances.set(sessionId, cline);

  const unsubscribe = subscribeClineSession(
    sessionId,
    cline,
    session.modelProvider,
    modelId,
    apiEndpoint ?? undefined,
  );

  getRunState(sessionId).unsubscribe = unsubscribe;
  // Resume must CLEAR "stopped"; safeUpdateSession intentionally refuses to
  // overwrite a stopped session for background turn completions, so use a
  // direct update here.
  await _db().cyberLabAgentSession.update({
    where: { id: sessionId },
    data: { status: "active", stopReason: null, lastActivityAt: new Date() },
  });

  // (Re)start the Cline session with authentication so resume works after
  // idle shutdown, kill switch, or server restart. `start` already runs the
  // prompt; the old code then sent the same prompt a second time.
  getRunState(sessionId);
  enqueueTurn(sessionId, async () => {
    const startResult = await cline.start({
      config: {
        sessionId,
        // SDK provider is always "cline"; `modelProvider` is our own audit label
        // ("cline" | "cline-free" | "external") and is not an SDK provider id.
        providerId: "cline",
        modelId,
        apiKey: apiKey ?? undefined,
        baseUrl: apiEndpoint ?? undefined,
        systemPrompt: buildCyberLabSystemPrompt(userId),
        cwd,
        workspaceRoot: cwd,
        enableTools: true,
        enableSpawnAgent: false,
        enableAgentTeams: false,
      },
      prompt,
      interactive: true,
    });
    await finishTurn(
      sessionId,
      startResult.result?.finishReason,
      startResult.result?.text,
    );
  });

  return {
    status: "started",
    message: "Session resumed — the agent is working.",
    unsubscribe,
  };
}

export function resolveToolApproval(sessionId: string, approved: boolean, reason?: string): boolean {
  const pending = pendingApprovals.get(sessionId);
  if (!pending) return false;
  pendingApprovals.delete(sessionId);
  if (approved) {
    pending.resolve({ approved: true, reason: reason ?? "Approved by operator" });
  } else {
    pending.resolve({ approved: false, reason: reason ?? "Denied by operator" });
  }
  return true;
}

export async function stopClineSession(sessionId: string, userId: string): Promise<{ ok: boolean; message?: string }> {
  const session = await _db().cyberLabAgentSession.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) {
    return { ok: false, message: "Session not found" };
  }

  const cline = clineInstances.get(sessionId);
  if (cline) {
    try {
      await cline.stop(sessionId);
    } catch {
      // ignore stop errors
    }
    clineInstances.delete(sessionId);
  }

  pendingApprovals.delete(sessionId);
  const run = sessionRuns.get(sessionId);
  run?.unsubscribe?.();
  sessionRuns.delete(sessionId);

  await _db().cyberLabAgentSession.update({
    where: { id: sessionId },
    data: { status: "stopped", stopReason: "user_stop", lastActivityAt: new Date() },
  });

  return { ok: true };
}

export async function getClineSessionStatus(sessionId: string, userId: string) {
  const session = await _db().cyberLabAgentSession.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) return null;

  const pending = pendingApprovals.get(sessionId);
  const instance = clineInstances.has(sessionId);
  const run = sessionRuns.get(sessionId);

  return {
    id: session.id,
    userId: session.userId,
    companyId: session.companyId,
    status: session.status,
    modelProvider: session.modelProvider,
    modelId: session.modelId,
    apiEndpoint: session.apiEndpoint,
    apiKeyHash: session.apiKeyHash,
    startedAt: session.startedAt,
    lastActivityAt: session.lastActivityAt,
    idleShutdownAt: session.idleShutdownAt,
    contextDocPath: session.contextDocPath,
    frozenByAdmin: session.frozenByAdmin,
    stopReason: session.stopReason,
    hasPendingApproval: !!pending,
    approvalRequest: pending?.request ?? null,
    runtimeActive: instance,
    busy: (run?.pending ?? 0) > 0,
    lastError: run?.lastError ?? (run?.lastErrorClass ? friendlyClineFailure(run.lastErrorClass) : null),
    lastFinish: run?.lastFinish ?? null,
  };
}

// ---------------------------------------------------------------------------
// TASK_252 — session list + visible transcript
// ---------------------------------------------------------------------------

export async function listClineSessions(userId: string, limit = 20) {
  const rows = await _db().cyberLabAgentSession.findMany({
    where: { userId },
    orderBy: { startedAt: "desc" },
    take: limit,
  });
  return rows.map((s) => ({
    id: s.id,
    status: s.status,
    modelProvider: s.modelProvider,
    modelId: s.modelId,
    startedAt: s.startedAt,
    lastActivityAt: s.lastActivityAt,
    idleShutdownAt: s.idleShutdownAt,
    contextDocPath: s.contextDocPath,
    stopReason: s.stopReason,
    frozenByAdmin: s.frozenByAdmin,
    runtimeActive: clineInstances.has(s.id),
    busy: (sessionRuns.get(s.id)?.pending ?? 0) > 0,
    lastError: sessionRuns.get(s.id)?.lastError ?? null,
  }));
}

export interface ClineTranscriptEntry {
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  thinking: string | null;
  tools: Array<{
    toolName: string;
    input?: unknown;
    output?: unknown;
    isError?: boolean;
  }>;
}

function clipText(value: unknown, max = 16_000): string {
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}…` : value;
  if (value == null) return "";
  try {
    const json = JSON.stringify(value);
    return json.length > max ? `${json.slice(0, max)}…` : json;
  } catch {
    const text = String(value);
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null ? (value as UnknownRecord) : null;
}

function normalizeClineMessage(raw: unknown): ClineTranscriptEntry | null {
  const wrapper = asRecord(raw);
  if (!wrapper) return null;
  const msg = asRecord(wrapper.message) ?? wrapper;

  const role: ClineTranscriptEntry["role"] =
    msg.role === "user" || msg.role === "assistant" || msg.role === "tool"
      ? msg.role
      : "system";

  const texts: string[] = [];
  const thinking: string[] = [];
  const tools: ClineTranscriptEntry["tools"] = [];
  const parts: unknown[] =
    typeof msg.content === "string"
      ? [{ type: "text", text: msg.content }]
      : Array.isArray(msg.content)
        ? msg.content
        : [];

  for (const rawPart of parts) {
    const part = asRecord(rawPart);
    if (!part) continue;
    const type = String(part.type ?? "");
    if (type === "text") {
      if (typeof part.text === "string" && part.text.trim()) texts.push(part.text);
    } else if (type === "thinking" || type === "reasoning") {
      const value = part.thinking ?? part.text;
      if (typeof value === "string" && value.trim()) thinking.push(value);
    } else if (type === "tool-call" || type === "tool_use" || type === "tool-call-delta") {
      tools.push({
        toolName: String(part.toolName ?? part.name ?? "tool"),
        input: part.input ?? part.args ?? part.arguments,
      });
    } else if (type === "tool-result" || type === "tool_result") {
      tools.push({
        toolName: String(part.toolName ?? part.name ?? "tool"),
        output: part.output ?? part.content ?? part.result,
        isError: part.isError === true,
      });
    } else if (typeof part.text === "string" && part.text.trim()) {
      texts.push(part.text);
    }
  }

  // Tool-role messages may carry only an output payload.
  if (role === "tool" && texts.length === 0 && tools.length === 0 && msg.content != null) {
    texts.push(clipText(msg.content));
  }

  if (texts.length === 0 && thinking.length === 0 && tools.length === 0) return null;

  return {
    role,
    text: texts.join("\n\n"),
    thinking: thinking.length > 0 ? thinking.join("\n\n") : null,
    tools,
  };
}

async function readSessionTranscript(
  cline: ClineCore,
  sessionId: string,
): Promise<ClineTranscriptEntry[]> {
  let raw: unknown[] = [];
  try {
    raw = await cline.readDisplayMessages(sessionId);
  } catch {
    try {
      raw = await cline.readMessages(sessionId);
    } catch {
      return [];
    }
  }
  return raw.map(normalizeClineMessage).filter((m): m is ClineTranscriptEntry => m !== null);
}

export async function getClineSessionMessages(sessionId: string, userId: string) {
  const session = await _db().cyberLabAgentSession.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) return null;

  const cline = clineInstances.get(sessionId);
  const run = sessionRuns.get(sessionId);
  let messages: ClineTranscriptEntry[] = [];
  let runtimeError: string | null = null;

  if (cline) {
    try {
      messages = await readSessionTranscript(cline, sessionId);
    } catch (err) {
      runtimeError = errorMessage(err);
    }
  }

  const stepRows = await _db().cyberLabContextDocStep.findMany({
    where: { sessionId },
    orderBy: { stepNo: "desc" },
    take: 80,
  });

  return {
    sessionId,
    status: session.status,
    runtimeActive: !!cline,
    busy: (run?.pending ?? 0) > 0,
    lastError: run?.lastError ?? (run?.lastErrorClass ? friendlyClineFailure(run.lastErrorClass) : null),
    lastFinish: run?.lastFinish ?? null,
    runtimeError,
    messages,
    steps: stepRows
      .slice()
      .reverse()
      .map((s) => ({
        stepNo: s.stepNo,
        summary: s.summary,
        modelProvider: s.modelProvider,
        modelId: s.modelId,
        createdAt: s.createdAt,
      })),
  };
}

export async function recordContextDocStep(
  sessionId: string,
  stepNo: number,
  summary: string,
  content: string,
  modelProvider: string,
  modelId: string,
  apiEndpoint?: string,
): Promise<void> {
  const path = contextDocPathFor(sessionId);
  appendContextDoc(sessionId, content);

  const session = await _db().cyberLabAgentSession.findUnique({ where: { id: sessionId } });
  if (!session) return;

  await _db().cyberLabAgentSession.update({
    where: { id: sessionId },
    data: { contextDocPath: path },
  });

  await _db().cyberLabContextDocStep.create({
    data: {
      sessionId,
      stepNo,
      modelProvider,
      modelId,
      apiEndpoint: apiEndpoint ?? null,
      summary,
      contentRef: path,
    },
  });
}

export async function sweepIdleSessions(): Promise<{ stopped: number }> {
  const cutoff = new Date(Date.now() - IDLE_TIMEOUT_MS);
  const idle = await _db().cyberLabAgentSession.findMany({
    where: {
      status: "active",
      lastActivityAt: { lt: cutoff },
    },
  });

  let stopped = 0;
  for (const session of idle) {
    const cline = clineInstances.get(session.id);
    if (cline) {
      try {
        await cline.stop(session.id);
      } catch {
        // ignore
      }
      clineInstances.delete(session.id);
    }
    pendingApprovals.delete(session.id);
    const run = sessionRuns.get(session.id);
    run?.unsubscribe?.();
    sessionRuns.delete(session.id);

    await _db().cyberLabAgentSession.update({
      where: { id: session.id },
      data: { status: "stopped", stopReason: "idle_timeout", idleShutdownAt: new Date() },
    });
    stopped++;
  }

  return { stopped };
}

export function getPendingApproval(sessionId: string): ToolApprovalRequest | null {
  return pendingApprovals.get(sessionId)?.request ?? null;
}

// ---------------------------------------------------------------------------
// P3 — Remediation fix list generation + signed LabEpisode
// ---------------------------------------------------------------------------

interface RemediationFinding {
  tool: string;
  target: string;
  technique: string;
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  detail: string;
  evidence: string;
  fix: string;
  stepsToReproduce: string;
}

interface RemediationFixListInput {
  sessionId: string;
  generatedAt: string;
  findings: RemediationFinding[];
  totalFindings: number;
}

interface RemediationFixList {
  sessionId: string;
  generatedAt: string;
  findings: RemediationFinding[];
  totalFindings: number;
  fixReportMd: string;
}

/** Build the remediation report markdown from findings. */
function buildFixReportMd(fixList: RemediationFixListInput): string {
  const lines: string[] = [];
  lines.push("# Cyber Lab Remediation Report");
  lines.push("");
  lines.push(`- Session: ${fixList.sessionId}`);
  lines.push(`- Generated: ${fixList.generatedAt}`);
  lines.push(`- Total findings: ${fixList.totalFindings}`);
  lines.push("");
  if (fixList.findings.length === 0) {
    lines.push("## No findings");
    lines.push("");
    lines.push("No vulnerability findings were detected in the agent's context doc. Continue monitoring.");
    return lines.join("\n");
  }
  const bySeverity = fixList.findings.reduce(
    (acc, f) => {
      (acc[f.severity] ??= []).push(f);
      return acc;
    },
    {} as Record<string, RemediationFinding[]>,
  );
  const order: RemediationFinding["severity"][] = ["critical", "high", "medium", "low"];
  for (const sev of order) {
    const items = bySeverity[sev];
    if (!items || items.length === 0) continue;
    lines.push(`## ${sev.toUpperCase()} — ${items.length} finding(s)`);
    lines.push("");
    for (const f of items) {
      lines.push(`### ${f.title}`);
      lines.push("");
      lines.push(`- Tool: ${f.tool}`);
      lines.push(`- Target: ${f.target}`);
      lines.push(`- ATT&CK technique: ${f.technique || "n/a"}`);
      lines.push(`- Severity: ${f.severity}`);
      lines.push("");
      lines.push("**Detail:**");
      lines.push(f.detail);
      lines.push("");
      lines.push("**Evidence:**");
      lines.push("```");
      lines.push(f.evidence);
      lines.push("```");
      lines.push("");
      lines.push("**Remediation (how to fix):**");
      lines.push(f.fix);
      lines.push("");
      lines.push("**Steps to reproduce (verify the fix):**");
      lines.push(f.stepsToReproduce);
      lines.push("");
    }
  }
  lines.push("---");
  lines.push("*Generated by SpaceWorker Cyber Lab agent (Cline Core SDK). All findings are bound to attested targets only.*");
  return lines.join("\n");
}

/** Parse vulnerability findings from the agent's context doc content. */
function parseFindingsFromContextDoc(content: string): RemediationFinding[] {
  const findings: RemediationFinding[] = [];
  const stepBlocks = content.split(/## Step \d+ — /);
  for (const block of stepBlocks) {
    if (!block.trim()) continue;
    const firstLine = block.split("\n")[0];
    const toolMatch = firstLine.match(/hook:(tool_call|tool_result)\/(\S+)/);
    const toolName = toolMatch ? toolMatch[2] : "unknown";
    const lower = block.toLowerCase();
    let technique = "";
    let severity: RemediationFinding["severity"] = "low";
    let title = "";
    let detail = "";
    const evidence = block.slice(0, 500);
    let fix = "";
    let stepsToReproduce = "";
    if (lower.includes("open port") && !title) {
      technique = "T1046";
      title = "Open network port(s) discovered";
      severity = "medium";
      detail = "Network service discovery found open port(s) on an attested target. Unnecessary open ports expand the attack surface.";
      fix = "Close unnecessary ports. Restrict exposed services to internal networks. Apply firewall rules to deny inbound traffic to non-essential ports.";
      stepsToReproduce = "1. Run nmap -sS <target-ip>\n2. Review open ports\n3. Cross-check against required services";
    } else if ((lower.includes("ffuf") || lower.includes("dirb")) && !title) {
      technique = "T1595";
      title = "Web content discovery performed";
      severity = "low";
      detail = "Directory/content brute-forcing was run against an attested web target. Exposed paths may reveal sensitive endpoints.";
      fix = "Remove or protect sensitive directories (.git, .env, config, admin, backup). Use authentication + authorization on all admin endpoints.";
      stepsToReproduce = "1. Run ffuf -u <target-url>/FUZZ -w <wordlist>\n2. Review discovered paths\n3. Remove or secure exposed paths";
    } else if ((lower.includes("nuclei") || /cve-\d{4}-\d+/i.test(lower)) && !title) {
      technique = "T1595";
      const cveMatch = block.match(/CVE-\d{4}-\d+/i);
      title = cveMatch ? `Vulnerability detected: ${cveMatch[0]}` : "Vulnerability scan completed";
      severity = cveMatch ? "high" : "medium";
      detail = cveMatch ? `Nuclei template matched CVE ${cveMatch[0]} on an attested target.` : "Nuclei vulnerability scanning found potential issues on an attested target.";
      fix = "Apply vendor patches or mitigations for the detected CVE. Update affected software to latest stable version.";
      stepsToReproduce = "1. Run nuclei -t <template-path> <target-url>\n2. Review matched templates\n3. Apply patches or mitigations";
    } else if (lower.includes("hydra") && !title) {
      technique = "T1110.001";
      title = "Password spraying / brute force attempted";
      severity = "high";
      detail = "Hydra was used to attempt authentication against an attested service. Weak or default credentials are a critical risk.";
      fix = "Enforce strong password policy. Enable account lockout after failed attempts. Use MFA. Rotate default credentials immediately.";
      stepsToReproduce = "1. Run hydra -L users.txt -P passwords.txt <target> <service>\n2. Review successful authentications\n3. Rotate compromised credentials, enable MFA";
    } else if (lower.includes("burp") && !title) {
      technique = "T1190";
      title = "Web application proxy/testing performed";
      severity = "medium";
      detail = "Burp Suite was used to intercept and modify web traffic against an attested target. Potential injection, XSS, or authorization flaws may exist.";
      fix = "Implement input validation and output encoding. Use parameterized queries. Apply authorization checks on every request.";
      stepsToReproduce = "1. Configure browser to proxy through Burp\n2. Browse the target application\n3. Review intercepted requests for injection points";
    } else if (lower.includes("nessus") && !title) {
      technique = "T1595";
      title = "Vulnerability assessment scan completed";
      severity = "medium";
      detail = "Nessus Essentials scanned an attested target for known vulnerabilities.";
      fix = "Prioritize critical/high findings. Apply patches or configuration changes. Rescan after remediation to verify fixes.";
      stepsToReproduce = "1. Run Nessus scan against target\n2. Review plugin results\n3. Remediate critical and high findings";
    } else if ((lower.includes("dnsrecon") || lower.includes("dnscat2")) && !title) {
      technique = "T1590.002";
      title = "DNS enumeration / tunneling detected";
      severity = "medium";
      detail = "DNS reconnaissance or tunneling was performed against an attested target. Exposes internal hostnames and potential data exfiltration paths.";
      fix = "Restrict DNS recursion to internal clients. Monitor for unusual DNS query volumes. Use DNS filtering and logging.";
      stepsToReproduce = "1. Run dnsrecon -d <domain>\n2. Review enumerated records\n3. Restrict and monitor DNS";
    } else if ((lower.includes("wireshark") || lower.includes("tshark")) && !title) {
      technique = "T1046";
      title = "Network packet capture performed";
      severity = "low";
      detail = "Packet capture was run against network traffic from an attested target. Captured traffic may contain unencrypted credentials or sensitive data.";
      fix = "Encrypt all traffic in transit (TLS/HTTPS/SSH). Never transmit credentials in plaintext. Segment sensitive traffic onto isolated VLANs.";
      stepsToReproduce = "1. Run tshark -i <interface> -f \"host <target>\"\n2. Review captured packets\n3. Enforce encryption on all protocols";
    } else if ((lower.includes("wifi") || lower.includes("wireless") || lower.includes("802.11") || lower.includes("wpa")) && !title) {
      technique = "T1046";
      title = "WiFi reconnaissance performed";
      severity = "high";
      detail = "WiFi network discovery was performed. Company networks on the same WiFi as guest/untrusted devices are at risk of lateral movement.";
      fix = "Use WPA3-Enterprise or WPA2-Enterprise with 802.1X authentication. Separate guest WiFi from corporate network via VLAN. Disable WPS.";
      stepsToReproduce = "1. Scan for WiFi networks (nmcli/iwlist/airmon-ng)\n2. Identify corporate SSIDs\n3. Verify enterprise auth + VLAN separation";
    }
    if (title) {
      findings.push({ tool: toolName, target: "attested_target", technique, severity, title, detail, evidence, fix, stepsToReproduce });
    }
  }
  return findings;
}

/**
 * Generate a remediation fix list from a completed agent session.
 * Parses the context doc for findings, creates LabFinding rows, and returns
 * the structured fix list + markdown report.
 */
export async function generateRemediationFixList(
  sessionId: string,
  userId: string,
): Promise<RemediationFixList> {
  const session = await _db().cyberLabAgentSession.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) {
    throw new Error("Session not found");
  }
  const steps = await _db().cyberLabContextDocStep.findMany({
    where: { sessionId },
    orderBy: { stepNo: "asc" },
  });
  let contextDocContent = "";
  if (session.contextDocPath && existsSync(session.contextDocPath)) {
    contextDocContent = readFileSync(session.contextDocPath, "utf8");
  }
  const stepSummaries = steps.map((s) => `## Step ${s.stepNo} — ${s.summary}\n${s.contentRef}`).join("\n\n");
  const fullContent = contextDocContent + "\n\n---\n\n" + stepSummaries;
  const findings = parseFindingsFromContextDoc(fullContent);
  await _db().labFinding.createMany({
    data: findings.map((f) => ({
      episodeId: "",
      userId,
      severity: f.severity,
      title: f.title,
      detail: f.detail,
    })),
  });
  const fixList: RemediationFixList = {
    sessionId,
    generatedAt: new Date().toISOString(),
    findings,
    totalFindings: findings.length,
    fixReportMd: buildFixReportMd({
      sessionId,
      generatedAt: new Date().toISOString(),
      findings,
      totalFindings: findings.length,
    }),
  };
  return fixList;
}

/**
 * Create a signed LabEpisode for a completed agent session.
 * Builds evidence artefacts (context doc + remediation report), calls
 * createEpisode from lib/lab/episode.ts, and links LabFinding rows to the
 * episode.
 */
export async function createSignedEpisodeForSession(
  sessionId: string,
  userId: string,
): Promise<{ episodeId: string; signedHash: string; findingsCount: number }> {
  const session = await _db().cyberLabAgentSession.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) {
    throw new Error("Session not found");
  }
  const steps = await _db().cyberLabContextDocStep.findMany({
    where: { sessionId },
    orderBy: { stepNo: "asc" },
  });
  const timeline = steps.map((s, i) => ({
    step: s.stepNo,
    type: "agent_step",
    modelProvider: s.modelProvider,
    modelId: s.modelId,
    summary: s.summary,
    contentRef: s.contentRef,
    createdAt: s.createdAt.toISOString(),
  }));
  const artefacts = [];
  if (session.contextDocPath && existsSync(session.contextDocPath)) {
    const docContent = readFileSync(session.contextDocPath, "utf8");
    artefacts.push({ path: "context-doc.md", content: docContent });
  }
  const fixList = await generateRemediationFixList(sessionId, userId);
  artefacts.push({ path: "remediation-report.md", content: fixList.fixReportMd });
  let rangeId: string;
  const existingRange = await _db().labRange.findFirst({
    where: { userId, scenarioId: "cline-agent-session" },
    orderBy: { createdAt: "desc" },
  });
  if (existingRange) {
    rangeId = existingRange.id;
  } else {
    const newRange = await _db().labRange.create({
      data: {
        userId,
        scenarioId: "cline-agent-session",
        consentId: null,
        state: "torn_down",
        ttlExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    rangeId = newRange.id;
  }
  const { createEpisode } = await import("./episode");
  const episode = await createEpisode({
    rangeId,
    userId,
    scenarioSlug: "cline-agent",
    mode: "live",
    techniqueIds: fixList.findings.map((f) => f.technique).filter(Boolean),
    telemetrySignatures: [],
    timeline: timeline as never,
    artefacts,
    victim: null,
    startedAt: session.startedAt,
    endedAt: new Date(),
    outcome: "completed_live",
  });
  const findings = await _db().labFinding.findMany({
    where: { userId, episodeId: "" },
  });
  if (findings.length > 0) {
    await _db().labFinding.updateMany({
      where: { id: { in: findings.map((f) => f.id) } },
      data: { episodeId: episode.id },
    });
  }
  return {
    episodeId: episode.id,
    signedHash: episode.signedHash ?? "",
    findingsCount: fixList.totalFindings,
  };
}

function buildCyberLabSystemPrompt(userId: string): string {
  return `You are the SpaceWorker Cyber Lab agent — a controlled offensive-security assistant AND a patient bug-hunting teacher.

TWO JOBS, ALWAYS:
1. Teach the user how bug hunting works: scope, recon, enumeration, validation, proof of impact, reporting, fixing, retesting.
2. Do the work WITH the user, using your real tools against only the targets they have attested.

TEACHING MODE (default):
- Explain what you are about to do and WHY, in plain language, before each step.
- Give a short plan first. If the user has not named an attested target and goal, ask for them; never guess.
- If the user says "hello" or asks a general question, answer directly, give a 5-step bug-hunting lesson map, and ask what they want to test. Do not demand a target in the greeting.
- After every command, interpret the result: what it means, what you learned, what you will try next.
- Name the technique and the defensive lesson as you go (e.g. "this is service discovery — defenders reduce this by closing unused ports").
- Do not dump a command without explaining the risk and expected output.

HUMAN-IN-THE-LOOP (hard rule):
- EVERY shell command, network probe, file write outside the session workspace, or device action requires explicit human approval.
- You PROPOSE; a human APPROVES or DENIES. Never act autonomously against a real system.
- If an action is denied, explain what you would have learned and offer a safe alternative.

SCOPE (hard limits — never exceed):
1. Only targets the user has attested/authorized in their Cyber Lab inventory.
2. No mass scanning, no third-party targets outside the user's own inventory.
3. No spoofing, no social engineering against real people.
4. Real actions are allowed only against the user's own attested assets.

TOOLS:
- Your full Cline tool set is enabled: shell/command execution, file read/write, search, web fetch, and the rest of your tools.
- Before running a utility, check it exists with \`command -v <tool>\`.
- This host commonly has: curl, wget, dig, whois, nc, jq, python3, node. Scanners such as nmap, ffuf, dirb, hydra, nuclei, sqlmap may NOT be installed. If a tool is missing, say so and use a safe built-in alternative (curl/python3/node/nc/dig) or ask the owner to install it. Never pretend a command ran.
- When available: nmap/masscan (service discovery, T1046), ffuf/dirb (content discovery, T1595), nuclei (vuln templates, T1595), hydra (credential testing, T1110.001), Burp (web proxy, T1190), dnsrecon (DNS, T1590.002), tshark/Wireshark (defensive capture).
- Record evidence for every finding: exact command, relevant output, timestamp.

BUG-HUNTING LOOP:
1. Scope + consent: confirm the attested target and what "success" means.
2. Recon: passive/active discovery, only on attested assets.
3. Enumerate: services, paths, versions, identities.
4. Validate: prove the issue with the smallest safe test; avoid destructive payloads.
5. Prove impact: show what an attacker could reach and what data/action is exposed.
6. Report: what, where, evidence, ATT&CK technique, severity (critical/high/medium/low), exact fix, reproduction steps, retest command.
7. Fix + verify: after the owner patches, rerun the exact proof to confirm.

WORK STEPS:
1. Ask for (or confirm) the attested target and goal.
2. Inspect the environment and check which tools actually exist.
3. Run recon, interpret results, and teach the decision at each step.
4. Propose exploit/validation steps one at a time for approval.
5. Produce a remediation report bound to the signed evidence log.

All steps are recorded in the signed evidence log.

Current user: ${userId}
`;
}

// ---------------------------------------------------------------------------
// Cleanup on process exit
// ---------------------------------------------------------------------------

if (typeof process !== "undefined" && process.on) {
  process.on("exit", () => {
    for (const [sessionId, cline] of clineInstances) {
      try {
        cline.stop(sessionId);
      } catch {
        // ignore
      }
    }
    clineInstances.clear();
    pendingApprovals.clear();
    for (const run of sessionRuns.values()) {
      try {
        run.unsubscribe?.();
      } catch {
        // ignore
      }
    }
    sessionRuns.clear();
  });
}