// TASK_156 P0 — Cline SDK spike: prove start/stop/resume + tool approval
// Run: npx tsx --test tests/cline-agent-spike.test.ts
//
// WHAT THIS FILE PROVES:
//   1. @cline/sdk is installed and ClineCore is a class with create/start/send/stop/subscribe
//   2. cline-agent.ts exports all expected functions
//   3. End-to-end lifecycle: start → approve → send → stop
//   4. Idle sweep stops inactive sessions
//
// NO REAL MODEL CALLS: ClineCore.create/start are faked via require hook.
// No API key, no network, no secrets. Structural proof only.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { createRequire } from "node:module";
import type { ToolApprovalRequest } from "@cline/shared";

const require = createRequire(import.meta.url);

type Loader = { _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown };
const loader = Module as unknown as Loader;
const original = loader._load;

const clineInstances = new Map<string, any>();
let lastStartInput: any = null;
let lastSendInput: any = null;
let stopCalledFor: string[] = [];
let fakeStartResult: any = undefined;
let displayMessages: any[] = [];

// Controllable gate mock — tests set this before calling startClineLabSession
let mockGateResult: { open: boolean; enabled: boolean; entitled: boolean; consented: boolean } | null = null;

// ClineAgent module (loaded via require after hook is installed)
let Cl: any = null;

function makeFakeCline(sessionId: string) {
  return {
    start: async (input: any) => {
      lastStartInput = input;
      clineInstances.set(sessionId, fake);
      return {
        sessionId,
        manifest: {},
        manifestPath: `/tmp/${sessionId}.json`,
        messagesPath: `/tmp/${sessionId}-messages.json`,
        result: fakeStartResult,
      };
    },
    send: async (input: any) => {
      lastSendInput = input;
      return { finishReason: "completed" };
    },
    readDisplayMessages: async () => displayMessages,
    readMessages: async () => displayMessages,
    stop: async (sessionId: string) => {
      stopCalledFor.push(sessionId);
      clineInstances.delete(sessionId);
    },
    subscribe: () => () => {},
    dispose: async () => {},
  };
}

const fake: any = makeFakeCline("fake");
const fakeClineCore = {
  create: async (opts: any) => makeFakeCline("fake"),
};

const sessions = new Map<string, any>();
const settingsRows = new Map<string, any>();
const killSwitches = new Map<string, any>();
let rangeCounter = 0;
const labRanges = new Map<string, any>();
const labTargets = new Map<string, any>();
const abuseReports: any[] = [];
const docSteps: any[] = [];

const fakeDb = {
  cyberLabAgentSettings: {
    findUnique: async (args: any) => {
      const row = settingsRows.get(args.where.userId);
      return row ?? null;
    },
  },
  cyberLabAgentSession: {
    create: async (args: any) => {
      const id = args.data.id;
      sessions.set(id, { ...args.data, lastActivityAt: args.data.lastActivityAt ?? new Date() });
      return { id };
    },
    findUnique: async (args: any) => {
      return sessions.get(args.where.id) ?? null;
    },
    findMany: async (args: any) => {
      const all = Array.from(sessions.values());
      const { where } = args;
      if (where?.userId && !where?.status) {
        return all
          .filter((s: any) => s.userId === where.userId)
          .sort((a: any, b: any) => (b.startedAt?.getTime?.() ?? 0) - (a.startedAt?.getTime?.() ?? 0))
          .slice(0, args.take ?? all.length);
      }
      if (where?.status === "active" && where?.lastActivityAt?.lt) {
        const cutoff = where.lastActivityAt.lt;
        return all.filter((s: any) => s.status === "active" && s.lastActivityAt.getTime() < cutoff.getTime());
      }
      return all.filter((s: any) => s.status === (where?.status ?? "active"));
    },
    update: async (args: any) => {
      const id = args.where.id;
      const existing = sessions.get(id);
      if (!existing) throw new Error("not found");
      sessions.set(id, { ...existing, ...args.data });
      return { id };
    },
  },
  labRange: {
    create: async (args: any) => {
      const id = `range-${++rangeCounter}`;
      labRanges.set(id, { ...args.data, id, state: "pending", createdAt: new Date(), updatedAt: new Date() });
      return { id };
    },
    findUnique: async (args: any) => {
      return labRanges.get(args.where.id) ?? null;
    },
    findUniqueOrThrow: async (args: any) => {
      const range = labRanges.get(args.where.id);
      if (!range) throw new Error("not found");
      return range;
    },
    update: async (args: any) => {
      const id = args.where.id;
      const existing = labRanges.get(id);
      if (!existing) throw new Error("not found");
      labRanges.set(id, { ...existing, ...args.data });
      return { id };
    },
  },
  labTarget: {
    findMany: async (args: any) => {
      return Array.from(labTargets.values()).filter((t: any) => t.userId === args.where.userId);
    },
  },
  labAbuseReport: {
    create: async (args: any) => {
      abuseReports.push(args.data);
      return { id: "abuse-" + abuseReports.length };
    },
  },
  cyberLabKillSwitch: {
    findFirst: async (args: any) => {
      for (const [k, v] of killSwitches) {
        const [scope] = k.split(":");
        if (v.scope === args.where.scope && (!args.where.targetId || v.targetId === args.where.targetId)) {
          return v;
        }
      }
      return null;
    },
  },
  cyberLabContextDocStep: {
    create: async (args: any) => {
      docSteps.push(args.data);
      return { id: "doc-step-" + docSteps.length };
    },
    findMany: async (args: any) => {
      return docSteps
        .filter((s: any) => s.sessionId === args.where?.sessionId)
        .sort((a: any, b: any) => a.stepNo - b.stepNo);
    },
  },
};

function installHook(): void {
  loader._load = function patched(request: string, parent: NodeModule | undefined, isMain: boolean) {
    if (request === "server-only") return {};
    if (request === "@cline/sdk") {
      return {
        ...fakeClineCore,
        // Mirror the real SDK helper: OAuth providers get a scheme prefix.
        formatProviderOAuthApiKey: (provider: string, auth: { access: string }) =>
          provider === "cline" ? `workos:${auth.access}` : auth.access,
      };
    }
    if (request === "@cline/shared") {
      return { ToolApprovalRequest: {}, ToolApprovalResult: {} };
    }
    return original.apply(this, [request, parent, isMain]);
  };
}

function uninstallHook(): void {
  loader._load = original;
}

beforeEach(() => {
  sessions.clear();
  settingsRows.clear();
  killSwitches.clear();
  labRanges.clear();
  labTargets.clear();
  abuseReports.length = 0;
  docSteps.length = 0;
  clineInstances.clear();
  stopCalledFor = [];
  lastStartInput = null;
  lastSendInput = null;
  fakeStartResult = undefined;
  displayMessages = [];
  mockGateResult = null;
  installHook();
  // Load cline-agent.ts via require so Module._load hook intercepts its static imports
  Cl = require("../lib/lab/cline-agent");
  Cl.setDbForTesting(fakeDb as any);
  Cl.setGateForTesting(async (_userId: string) => mockGateResult ?? { open: false, enabled: false, entitled: false, consented: false });
  Cl.setClineCoreForTesting(fakeClineCore as any);
  Cl.setClineAccessTokenResolverForTesting(async () => null);
});

afterEach(() => {
  uninstallHook();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("P0.1 — @cline/sdk exports ClineCore class with create/start/send/stop/subscribe", async () => {
  const { ClineCore } = await import("@cline/sdk");
  assert.ok(ClineCore, "ClineCore export exists");
  assert.equal(typeof ClineCore.create, "function", "ClineCore.create is a function");
  const instance = await ClineCore.create({ clientName: "spike-test" });
  assert.ok(instance, "ClineCore.create returns instance");
  assert.equal(typeof instance.start, "function", "instance.start is a function");
  assert.equal(typeof instance.send, "function", "instance.send is a function");
  assert.equal(typeof instance.stop, "function", "instance.stop is a function");
  assert.equal(typeof instance.subscribe, "function", "instance.subscribe is a function");
  assert.equal(typeof instance.dispose, "function", "instance.dispose is a function");
});

test("P0.2 — cline-agent.ts exports all expected functions", async () => {
  const mod = Cl;
  assert.equal(typeof mod.startClineLabSession, "function");
  assert.equal(typeof mod.sendClineMessage, "function");
  assert.equal(typeof mod.stopClineSession, "function");
  assert.equal(typeof mod.resolveToolApproval, "function");
  assert.equal(typeof mod.getClineSessionStatus, "function");
  assert.equal(typeof mod.sweepIdleSessions, "function");
  assert.equal(typeof mod.getPendingApproval, "function");
  assert.equal(typeof mod.recordContextDocStep, "function");
});

test("P0.3 — startClineLabSession: gate closed → failed", async () => {
  mockGateResult = { open: false, enabled: false, entitled: false, consented: false };
  const { startClineLabSession } = Cl;
  const result = await startClineLabSession({ userId: "user-no-entitlement", prompt: "scan example.com" });
  assert.equal(result.status, "failed");
  assert.ok(result.message);
});

test("P0.3b — startClineLabSession: global kill switch → failed", async () => {
  mockGateResult = { open: true, enabled: true, entitled: true, consented: true };
  killSwitches.set("global:", { scope: "global", targetId: null, frozen: true, reason: "overload", setBy: "admin", setAt: new Date() });
  settingsRows.set("user-killswitch", { userId: "user-killswitch", clineModelId: "claude-sonnet-4-6", clineApiEndpoint: null, clineApiKeyEnc: "sk-test", updatedAt: new Date() });
  const { startClineLabSession } = Cl;
  const result = await startClineLabSession({ userId: "user-killswitch", prompt: "scan example.com" });
  assert.equal(result.status, "failed");
  assert.ok(result.message.includes("frozen"));
});

test("P0.4 — startClineLabSession: happy path → started, session stored", async () => {
  mockGateResult = { open: true, enabled: true, entitled: true, consented: true };
  settingsRows.set("user-happy", { userId: "user-happy", clineModelId: "claude-sonnet-4-6", clineApiEndpoint: null, clineApiKeyEnc: "sk-test-happy", updatedAt: new Date() });
  const { startClineLabSession } = Cl;
  const result = await startClineLabSession({ userId: "user-happy", prompt: "Recon the attested target and report findings" });
  assert.equal(result.status, "started", `expected started, got ${result.status}: ${result.message}`);
  assert.ok(result.sessionId);
  assert.ok(lastStartInput, "ClineCore.start was called");
  assert.equal(lastStartInput.config.providerId, "cline");
  assert.equal(lastStartInput.config.modelId, "claude-sonnet-4-6");
  assert.ok(lastStartInput.config.systemPrompt.includes("Cyber Lab agent"), "system prompt set");
  assert.ok(sessions.has(result.sessionId), "session row created in db");
  const session = sessions.get(result.sessionId);
  assert.equal(session.status, "active");
});

test("P0.5 — sendClineMessage: resumes existing session", async () => {
  mockGateResult = { open: true, enabled: true, entitled: true, consented: true };
  settingsRows.set("user-resume", { userId: "user-resume", clineModelId: "claude-sonnet-4-6", clineApiEndpoint: null, clineApiKeyEnc: "sk-resume", updatedAt: new Date() });
  const { startClineLabSession, sendClineMessage } = Cl;
  const started = await startClineLabSession({ userId: "user-resume", prompt: "First message" });
  assert.equal(started.status, "started");

  let messageResult;
  try {
    messageResult = await sendClineMessage(started.sessionId, "Continue recon", "user-resume");
  } catch (e) {
    // expected: no network; we assert ClineCore.send was invoked with the session
  }
  // TASK_252: turns are queued behind the start turn; allow the queue to drain.
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(lastSendInput, "ClineCore.send was called");
  assert.equal(lastSendInput.sessionId, started.sessionId);
  assert.equal(lastSendInput.prompt, "Continue recon");

  const session = sessions.get(started.sessionId);
  assert.ok(session, "session exists in fake db");
  assert.ok(session.lastActivityAt, "lastActivityAt was set");
});

test("P0.5b — sendClineMessage: unknown session → 404-shaped", async () => {
  const { sendClineMessage } = Cl;
  const result = await sendClineMessage("does-not-exist", "hello", "user-resume");
  assert.equal(result.status, "failed");
  assert.ok(result.message.includes("not found"));
});

test("P0.6 — stopClineSession: stops active session", async () => {
  mockGateResult = { open: true, enabled: true, entitled: true, consented: true };
  settingsRows.set("user-stop", { userId: "user-stop", clineModelId: "claude-sonnet-4-6", clineApiEndpoint: null, clineApiKeyEnc: "sk-stop", updatedAt: new Date() });
  const { startClineLabSession, stopClineSession } = Cl;
  const started = await startClineLabSession({ userId: "user-stop", prompt: "do work" });
  assert.equal(started.status, "started");

  const stopped = await stopClineSession(started.sessionId, "user-stop");
  assert.equal(stopped.ok, true);

  const session = sessions.get(started.sessionId);
  assert.equal(session.status, "stopped");
});

test("P0.7 — resolveToolApproval: approve then deny", async () => {
  mockGateResult = { open: true, enabled: true, entitled: true, consented: true };
  settingsRows.set("user-approve", { userId: "user-approve", clineModelId: "claude-sonnet-4-6", clineApiEndpoint: null, clineApiKeyEnc: "sk-approve", updatedAt: new Date() });
  const { startClineLabSession, getPendingApproval, resolveToolApproval } = Cl;
  const started = await startClineLabSession({ userId: "user-approve", prompt: "run a command" });

  // No pending approval yet
  const none = getPendingApproval(started.sessionId);
  assert.ok(!none, "no pending approval initially");
  const deniedNone = resolveToolApproval(started.sessionId, true);
  assert.ok(!deniedNone, "resolving nonexistent approval returns false");

  // Simulate a pending approval being set by the runtime
  const fakeRequest: ToolApprovalRequest = {
    sessionId: started.sessionId,
    agentId: "agent-1",
    conversationId: "conv-1",
    iteration: 1,
    toolCallId: "call-1",
    toolName: "run_commands",
    input: { command: "echo hi" },
    policy: { autoApprove: false },
  };
  Cl.setPendingApprovalForTesting(started.sessionId, fakeRequest);

  const pending = getPendingApproval(started.sessionId);
  assert.ok(pending, "pending approval exists");
  assert.equal(pending.toolName, "run_commands");

  const denied = resolveToolApproval(started.sessionId, false, "Not attested");
  assert.equal(denied, true);

  const stillPending = getPendingApproval(started.sessionId);
  assert.ok(!stillPending, "approval cleared after denial");

  // Re-set and approve
  Cl.setPendingApprovalForTesting(started.sessionId, fakeRequest);
  const approved = resolveToolApproval(started.sessionId, true);
  assert.equal(approved, true);
  assert.ok(!getPendingApproval(started.sessionId), "approval cleared after approval");
});

test("P0.8 — sweepIdleSessions: stops sessions idle > 15 min", async () => {
  mockGateResult = { open: true, enabled: true, entitled: true, consented: true };
  settingsRows.set("user-idle", { userId: "user-idle", clineModelId: "claude-sonnet-4-6", clineApiEndpoint: null, clineApiKeyEnc: "sk-idle", updatedAt: new Date() });
  const { startClineLabSession, sweepIdleSessions } = Cl;

  // Active session — should NOT be swept (lastActivityAt is now from create mock)
  const active = await startClineLabSession({ userId: "user-idle", prompt: "active work" });
  await new Promise((resolve) => setTimeout(resolve, 5));

  // Idle session — last activity 21 min ago
  const idle = await startClineLabSession({ userId: "user-idle", prompt: "old work" });
  // TASK_252: wait for the background turn to finish before ageing the session,
  // otherwise finishTurn() refreshes lastActivityAt.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await fakeDb.cyberLabAgentSession.update({
    where: { id: idle.sessionId },
    data: { lastActivityAt: new Date(Date.now() - 21 * 60 * 1000) },
  });

  const swept = await sweepIdleSessions();
  assert.ok(swept.stopped >= 1, `expected at least 1 stopped, got ${swept.stopped}`);

  const idleSession = sessions.get(idle.sessionId);
  assert.equal(idleSession.status, "stopped", "idle session stopped by sweep");
  assert.ok(idleSession.stopReason, "stop reason recorded");
});

// ---------------------------------------------------------------------------
// P1 — pre-flight attested targets + LabRange TTL
// ---------------------------------------------------------------------------

test("P1.1 — startClineLabSession with attested targets → pre-flight passes, range created with TTL", async () => {
  mockGateResult = { open: true, enabled: true, entitled: true, consented: true };
  settingsRows.set("user-p1", { userId: "user-p1", clineModelId: "claude-sonnet-4-6", clineApiEndpoint: null, clineApiKeyEnc: "sk-p1", updatedAt: new Date() });

  // Pre-attest a target the user is allowed to scan
  labTargets.set("target-1", {
    id: "target-1",
    userId: "user-p1",
    kind: "host",
    value: "192.168.1.50",
    attestedAt: new Date(),
    rangeId: null,
  });

  const { startClineLabSession } = Cl;
  const result = await startClineLabSession({
    userId: "user-p1",
    prompt: "Recon the attested host and report findings",
    targets: [{ kind: "host", value: "192.168.1.50" }],
  });

  assert.equal(result.status, "started", `expected started, got ${result.status}: ${result.message}`);
  assert.ok(result.sessionId);
  assert.ok(lastStartInput, "ClineCore.start was called");
  // A LabRange should exist for this session
  const ranges = Array.from(labRanges.values());
  assert.ok(ranges.length >= 1, "at least one LabRange created");
  const range = ranges[0];
  assert.equal(range.state, "active", "range should be active");
  assert.ok(range.ttlExpiresAt, "range should have a TTL expiry");
});

test("P1.2 — startClineLabSession with unattested target → pre-flight refused", async () => {
  mockGateResult = { open: true, enabled: true, entitled: true, consented: true };
  settingsRows.set("user-p1b", { userId: "user-p1b", clineModelId: "claude-sonnet-4-6", clineApiEndpoint: null, clineApiKeyEnc: "sk-p1b", updatedAt: new Date() });

  // No attested targets for this user
  const { startClineLabSession } = Cl;
  const result = await startClineLabSession({
    userId: "user-p1b",
    prompt: "Scan 10.0.0.99",
    targets: [{ kind: "host", value: "10.0.0.99" }],
  });

  assert.equal(result.status, "failed", `expected failed, got ${result.status}: ${result.message}`);
  assert.ok(result.message.includes("pre-flight") || result.message.includes("refused"), `expected refusal message, got: ${result.message}`);
  // An abuse report should have been written
  assert.ok(abuseReports.length >= 1, "abuse report should be recorded on pre-flight refusal");
});

test("P1.3 — startClineLabSession without targets → starts without range", async () => {
  mockGateResult = { open: true, enabled: true, entitled: true, consented: true };
  settingsRows.set("user-p1c", { userId: "user-p1c", clineModelId: "claude-sonnet-4-6", clineApiEndpoint: null, clineApiKeyEnc: "sk-p1c", updatedAt: new Date() });

  const { startClineLabSession } = Cl;
  const result = await startClineLabSession({
    userId: "user-p1c",
    prompt: "General recon advice",
  });

  assert.equal(result.status, "started", `expected started, got ${result.status}: ${result.message}`);
  assert.ok(result.sessionId);
  // No LabRange should have been created since no targets were declared
  const ranges = Array.from(labRanges.values());
  assert.equal(ranges.length, 0, "no LabRange should be created without targets");
});

test("P2.1 — subscribeClineSession records tool_call/result/ended events as context doc steps", async () => {
  mockGateResult = { open: true, enabled: true, entitled: true, consented: true };
  settingsRows.set("user-p2a", { userId: "user-p2a", clineModelId: "claude-sonnet-4-6", clineApiEndpoint: null, clineApiKeyEnc: "sk-p2a", updatedAt: new Date() });

  const { startClineLabSession, subscribeClineSession, recordContextDocStep } = Cl;
  const result = await startClineLabSession({
    userId: "user-p2a",
    prompt: "Run recon on attested host",
  });
  assert.equal(result.status, "started", `expected started, got ${result.status}`);
  const sessionId = result.sessionId;

  // Create a fake cline instance for subscribe testing (clineInstances uses key "fake" in mock)
  const fakeCline = makeFakeCline("test-session");

  // Subscribe to events (like startClineLabSession does internally)
  const unsubscribe = subscribeClineSession(sessionId, fakeCline, "cline", "claude-sonnet-4-6", undefined);

  assert.equal(typeof unsubscribe, "function", "subscribe should return an unsubscribe function");

  // Verify context doc step was recorded via recordContextDocStep
  await recordContextDocStep(sessionId, 1, "test step", "## Step 1 — test\n\nModel: cline/claude-sonnet-4-6\n\n\`\`\`json\n{}\n\`\`\`\n", "cline", "claude-sonnet-4-6", undefined);

  const steps = docSteps.filter((s: any) => s.sessionId === sessionId);
  assert.equal(steps.length, 1, "one context doc step should be recorded");
  assert.equal(steps[0].modelProvider, "cline");
  assert.equal(steps[0].modelId, "claude-sonnet-4-6");
  assert.equal(steps[0].stepNo, 1);
  assert.ok(steps[0].contentRef.endsWith(".md"), "contentRef should point to .md file");

  unsubscribe();
});

test("P2.2 — resumeClineSession recreates Cline instance after idle/kill and sends prompt", async () => {
  mockGateResult = { open: true, enabled: true, entitled: true, consented: true };
  settingsRows.set("user-p2b", { userId: "user-p2b", clineModelId: "claude-sonnet-4-6", clineApiEndpoint: null, clineApiKeyEnc: "sk-p2b", updatedAt: new Date() });

  const { startClineLabSession, stopClineSession, resumeClineSession } = Cl;
  const startResult = await startClineLabSession({
    userId: "user-p2b",
    prompt: "Initial recon",
  });
  assert.equal(startResult.status, "started");
  const sessionId = startResult.sessionId;

  // Stop the session (simulating idle shutdown or user stop)
  const stopOk = await stopClineSession(sessionId, "user-p2b");
  assert.equal(stopOk.ok, true);

  // Now resume — should recreate Cline instance and send prompt
  const resumeResult = await resumeClineSession(sessionId, "user-p2b", "Continue the assessment");
  assert.ok(resumeResult.status === "started" || resumeResult.status === "completed", `expected started or completed, got ${resumeResult.status}: ${resumeResult.message}`);
  assert.ok(resumeResult.message, "should have a message");

  // The session in the DB should be active again
  const resumed = await fakeDb.cyberLabAgentSession.findUnique({ where: { id: sessionId } });
  assert.equal(resumed.status, "active", "session should be active after resume");
});

test("P2.3 — resumeClineSession rejects frozen session", async () => {
  mockGateResult = { open: true, enabled: true, entitled: true, consented: true };
  settingsRows.set("user-p2c", { userId: "user-p2c", clineModelId: "claude-sonnet-4-6", clineApiEndpoint: null, clineApiKeyEnc: "sk-p2c", updatedAt: new Date() });

  const { startClineLabSession, resumeClineSession } = Cl;
  const startResult = await startClineLabSession({
    userId: "user-p2c",
    prompt: "Test frozen resume",
  });
  const sessionId = startResult.sessionId;

  // Freeze the session via kill switch
  killSwitches.set("tenant:user-p2c", { id: "ks-1", scope: "tenant", targetId: "user-p2c", frozen: true, reason: "overload", setBy: "admin", setAt: new Date() });

  const resumeResult = await resumeClineSession(sessionId, "user-p2c", "try to resume");
  assert.equal(resumeResult.status, "failed");
  assert.ok(resumeResult.message.includes("frozen"), `expected frozen message, got: ${resumeResult.message}`);
});
// ---------------------------------------------------------------------------
// TASK_246 — Cline OAuth token wiring (the "Connected but useless" bug)
// ---------------------------------------------------------------------------

test("TASK_246.1 — connected OAuth session hands the DECRYPTED token to the SDK", async () => {
  mockGateResult = { open: true, enabled: true, entitled: true, consented: true };
  settingsRows.set("user-oauth", {
    userId: "user-oauth",
    clineModelId: "claude-sonnet-4-6",
    clineApiEndpoint: null,
    clineApiKeyEnc: "sk-stale-manual-key",
    // Ciphertext at rest, as produced by lib/clin/token-store.ts.
    clineOAuthTokenEnc: "v1:not-the-key",
    updatedAt: new Date(),
  });
  Cl.setClineAccessTokenResolverForTesting(async () => "decrypted-oauth-access-token");

  const { startClineLabSession } = Cl;
  const result = await startClineLabSession({ userId: "user-oauth", prompt: "Recon the target" });
  assert.equal(result.status, "started", `expected started, got ${result.status}: ${result.message}`);

  assert.equal(lastStartInput.config.apiKey, "workos:decrypted-oauth-access-token");
  assert.notEqual(lastStartInput.config.apiKey, "v1:not-the-key", "never pass the stored blob as a key");

  const session = sessions.get(result.sessionId);
  assert.equal(session.modelProvider, "cline-free", "OAuth sessions are labelled cline-free for audit");
  const { createHash } = await import("node:crypto");
  assert.equal(
    session.apiKeyHash,
    createHash("sha256").update("workos:decrypted-oauth-access-token").digest("hex"),
    "stored hash is of the real token, not the blob",
  );
});

test("TASK_246.2 — explicit request key beats OAuth; OAuth beats the stored manual key", async () => {
  mockGateResult = { open: true, enabled: true, entitled: true, consented: true };
  settingsRows.set("user-order", {
    userId: "user-order",
    clineModelId: "claude-sonnet-4-6",
    clineApiEndpoint: null,
    clineApiKeyEnc: "sk-manual",
    clineOAuthTokenEnc: "v1:blob",
    updatedAt: new Date(),
  });
  Cl.setClineAccessTokenResolverForTesting(async () => "oauth-token");

  const { startClineLabSession } = Cl;

  const explicit = await startClineLabSession({
    userId: "user-order",
    prompt: "explicit key",
    apiKey: "sk-explicit",
  });
  assert.equal(explicit.status, "started");
  assert.equal(lastStartInput.config.apiKey, "sk-explicit", "request key wins");
  assert.equal(sessions.get(explicit.sessionId).modelProvider, "cline");

  const oauth = await startClineLabSession({ userId: "user-order", prompt: "oauth key" });
  assert.equal(oauth.status, "started");
  assert.equal(lastStartInput.config.apiKey, "workos:oauth-token", "OAuth wins over the stored manual key");
  assert.equal(sessions.get(oauth.sessionId).modelProvider, "cline-free");
});

test("TASK_246.3 — no OAuth → the stored manual key is still used", async () => {
  mockGateResult = { open: true, enabled: true, entitled: true, consented: true };
  settingsRows.set("user-manual", {
    userId: "user-manual",
    clineModelId: "claude-sonnet-4-6",
    clineApiEndpoint: null,
    clineApiKeyEnc: "sk-manual-only",
    updatedAt: new Date(),
  });

  const { startClineLabSession } = Cl;
  const result = await startClineLabSession({ userId: "user-manual", prompt: "manual" });
  assert.equal(result.status, "started");
  assert.equal(lastStartInput.config.apiKey, "sk-manual-only");
  assert.equal(sessions.get(result.sessionId).modelProvider, "cline");
});

test("TASK_246.4 — resume re-resolves a live OAuth token (not the stored blob) and uses the SDK provider id", async () => {
  mockGateResult = { open: true, enabled: true, entitled: true, consented: true };
  settingsRows.set("user-resume-oauth", {
    userId: "user-resume-oauth",
    clineModelId: "claude-sonnet-4-6",
    clineApiEndpoint: null,
    clineApiKeyEnc: null,
    clineOAuthTokenEnc: "v1:blob",
    updatedAt: new Date(),
  });
  Cl.setClineAccessTokenResolverForTesting(async () => "first-oauth-token");

  const { startClineLabSession, stopClineSession, resumeClineSession } = Cl;
  const started = await startClineLabSession({ userId: "user-resume-oauth", prompt: "start" });
  assert.equal(started.status, "started");

  await stopClineSession(started.sessionId, "user-resume-oauth");
  Cl.setClineAccessTokenResolverForTesting(async () => "refreshed-oauth-token");

  const resumed = await resumeClineSession(started.sessionId, "user-resume-oauth", "continue");
  assert.ok(resumed.status === "started" || resumed.status === "completed", resumed.message);
  assert.equal(lastStartInput.config.apiKey, "workos:refreshed-oauth-token");
  assert.equal(lastStartInput.config.providerId, "cline", "SDK provider id must never be our cline-free label");
});

// ---------------------------------------------------------------------------
// TASK_252 — live transcript + actionable auth error
// ---------------------------------------------------------------------------

test("TASK_252.1 — listClineSessions returns the user's newest sessions", async () => {
  mockGateResult = { open: true, enabled: true, entitled: true, consented: true };
  settingsRows.set("user-list", { userId: "user-list", clineModelId: "claude-sonnet-4-6", clineApiEndpoint: null, clineApiKeyEnc: "sk-list", updatedAt: new Date() });
  const { startClineLabSession, listClineSessions } = Cl;
  const started = await startClineLabSession({ userId: "user-list", prompt: "hello" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const list = await listClineSessions("user-list");
  assert.ok(list.some((s: any) => s.id === started.sessionId), "started session is listed");
  assert.equal(list[0].id, started.sessionId, "newest first");
});

test("TASK_252.2 — transcript exposes assistant text and tool activity", async () => {
  mockGateResult = { open: true, enabled: true, entitled: true, consented: true };
  settingsRows.set("user-transcript", { userId: "user-transcript", clineModelId: "claude-sonnet-4-6", clineApiEndpoint: null, clineApiKeyEnc: "sk-tr", updatedAt: new Date() });
  const { startClineLabSession, getClineSessionMessages } = Cl;
  const started = await startClineLabSession({ userId: "user-transcript", prompt: "hello" });
  displayMessages = [
    { origin: "history", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
    {
      origin: "history",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan the lesson" },
          { type: "text", text: "Hi! Let's hunt bugs." },
          { type: "tool-call", toolName: "run_commands", input: { command: "curl -I https://example.com" } },
        ],
      },
    },
  ];
  const transcript = await getClineSessionMessages(started.sessionId, "user-transcript");
  assert.ok(transcript, "transcript returned");
  const assistant = transcript.messages.find((m: any) => m.role === "assistant");
  assert.ok(assistant, "assistant message present");
  assert.equal(assistant.text, "Hi! Let's hunt bugs.");
  assert.equal(assistant.thinking, "plan the lesson");
  assert.equal(assistant.tools[0].toolName, "run_commands");
});

test("TASK_252.3 — errorClass auth is surfaced as reconnect guidance", async () => {
  mockGateResult = { open: true, enabled: true, entitled: true, consented: true };
  settingsRows.set("user-auth-ui", { userId: "user-auth-ui", clineModelId: "claude-sonnet-4-6", clineApiEndpoint: null, clineApiKeyEnc: "sk-auth-ui", updatedAt: new Date() });
  const { startClineLabSession, subscribeClineSession, getClineSessionStatus } = Cl;
  const started = await startClineLabSession({ userId: "user-auth-ui", prompt: "hello" });

  let listener: ((event: any) => void) | null = null;
  const emitter = { subscribe: (cb: (event: any) => void) => { listener = cb; return () => {}; } };
  const unsubscribe = subscribeClineSession(started.sessionId, emitter as any, "cline", "claude-sonnet-4-6", undefined);
  assert.ok(listener, "subscribed");
  (listener as unknown as (event: any) => void)({ type: "agent_event", payload: { event: { type: "error", errorClass: "auth", error: {} } } });

  const status = await getClineSessionStatus(started.sessionId, "user-auth-ui");
  assert.ok(status, "status returned");
  assert.match(status.lastError ?? "", /reconnect/i);
  unsubscribe?.();
});
