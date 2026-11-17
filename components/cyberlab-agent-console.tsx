"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface AgentSessionStatus {
  id: string;
  userId?: string;
  companyId?: string | null;
  status: string;
  modelProvider: string;
  modelId: string;
  apiEndpoint?: string | null;
  startedAt?: string;
  lastActivityAt?: string;
  idleShutdownAt?: string | null;
  contextDocPath?: string | null;
  frozenByAdmin?: boolean;
  stopReason?: string | null;
  hasPendingApproval?: boolean;
  approvalRequest?: ToolApprovalRequest | null;
  runtimeActive?: boolean;
  busy?: boolean;
  lastError?: string | null;
  lastFinish?: string | null;
}

interface ToolApprovalRequest {
  toolName: string;
  toolDescription?: string;
  arguments?: Record<string, unknown>;
  input?: Record<string, unknown>;
  reason?: string;
}

interface ApprovalState {
  sessionId: string | null;
  request: ToolApprovalRequest | null;
}

interface TranscriptTool {
  toolName: string;
  input?: unknown;
  output?: unknown;
  isError?: boolean;
}

interface TranscriptMessage {
  role: "user" | "assistant" | "tool" | "system" | string;
  text: string;
  thinking: string | null;
  tools: TranscriptTool[];
}

interface FeedStep {
  stepNo: number;
  summary: string;
  modelProvider: string;
  modelId: string;
  createdAt: string;
}

interface TranscriptResponse {
  sessionId: string;
  status: string;
  runtimeActive: boolean;
  busy: boolean;
  lastError: string | null;
  lastFinish: string | null;
  runtimeError: string | null;
  messages: TranscriptMessage[];
  steps: FeedStep[];
}

interface RemediationState {
  fixList?: {
    totalFindings: number;
    findings: Array<{
      tool: string;
      target: string;
      technique: string;
      severity: string;
      title: string;
      detail: string;
      fix: string;
      stepsToReproduce: string;
    }>;
    fixReportMd: string;
  } | null;
  episode?: {
    episodeId: string;
    signedHash: string;
    findingsCount: number;
  } | null;
}

const TEACHING_KICKOFF =
  "Teach me bug hunting. Give me a short 5-step plan, then ask me for the attested target and goal we should work on. Use real commands and explain each step.\n\n---\n\nHow to get an attested target for bug hunting:\n- An attested target is a machine you own and have authorized for testing (your own laptop, a VM you run, a device in your own LAN). Never point the agent at a third party or a host you do not control.\n- In the Cyber Lab, go to the Devices tab / target inventory and add the host you want to test, then attest it (confirm you own/authorize it). The agent can then only run against that attested target.\n- Once attested, give the agent the target (host name or IP) and a goal (e.g. \"find open services on <target>\"). The agent will plan recon, enumeration, and safe validation steps, asking your approval before each real action.\n- Practice targets: if you do not have your own machine yet, use intentionally vulnerable local labs you run yourself (e.g. OWASP Juice Shop, DVWA, Metasploitable in a VM on your own network) — these are yours to attack and make good attested starter targets.";

const NORMAL_KICKOFF =
  "Normal chat — no lesson plan. You are an offensive-security assessment agent. If the user names a website or IP, treat it as their attested target and start the attack loop immediately: recon, enumerate, validate, prove impact, and propose takeover steps — each for approval. You may also chat or help with tasks. Respond helpfully and ask what they want to work on. What's on your mind?";

function timeLabel(value?: string | null): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function ToolCard({ tool }: { tool: TranscriptTool }) {
  return (
    <details className="mb-1 rounded border border-zinc-700 bg-zinc-900/60 px-2 py-1 text-[11px] text-zinc-300">
      <summary className="cursor-pointer select-none">
        <span className="font-mono text-amber-300">{tool.toolName}</span>
        {tool.isError ? <span className="ml-2 text-red-400">error</span> : null}
      </summary>
      {tool.input !== undefined && (
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-zinc-400">
          {typeof tool.input === "string" ? tool.input : JSON.stringify(tool.input, null, 2)}
        </pre>
      )}
      {tool.output !== undefined && (
        <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words text-zinc-200">
          {typeof tool.output === "string" ? tool.output : JSON.stringify(tool.output, null, 2)}
        </pre>
      )}
    </details>
  );
}

function MessageBubble({ message }: { message: TranscriptMessage }) {
  const isUser = message.role === "user";
  return (
    <div
      className={`mb-2 rounded p-2 text-xs ${
        isUser
          ? "bg-blue-50 text-blue-900 dark:bg-blue-950/60 dark:text-blue-100"
          : "bg-emerald-50 text-emerald-950 dark:bg-emerald-950/40 dark:text-emerald-100"
      }`}
    >
      <div className="mb-1 text-[10px] font-bold uppercase tracking-wide opacity-70">
        {isUser ? "You" : message.role === "tool" ? "Tool" : "Agent"}
      </div>
      {message.thinking ? (
        <details className="mb-1 text-[11px] text-zinc-500 dark:text-zinc-400">
          <summary className="cursor-pointer select-none">Model thinking</summary>
          <pre className="mt-1 whitespace-pre-wrap break-words">{message.thinking}</pre>
        </details>
      ) : null}
      {message.tools.map((tool, i) => (
        <ToolCard key={`${tool.toolName}-${i}`} tool={tool} />
      ))}
      {message.text ? <div className="whitespace-pre-wrap break-words">{message.text}</div> : null}
    </div>
  );
}

export function CyberLabAgentConsole() {
  const [sessions, setSessions] = useState<AgentSessionStatus[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const [feedSteps, setFeedSteps] = useState<FeedStep[]>([]);
  const [status, setStatus] = useState<AgentSessionStatus | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"normal" | "teaching">("normal");
  const [approval, setApproval] = useState<ApprovalState>({ sessionId: null, request: null });
  const [error, setError] = useState("");
  const [serverError, setServerError] = useState("");
  const [remediation, setRemediation] = useState<RemediationState | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalOutput, setTerminalOutput] = useState<string[]>([]);
  const [terminalInput, setTerminalInput] = useState("");
  const pollRef = useRef<NodeJS.Timeout | null>(null);
  const activeIdRef = useRef<string | null>(null);

  useEffect(() => {
    activeIdRef.current = activeSessionId;
  }, [activeSessionId]);

  const resetView = useCallback(() => {
    setStatus(null);
    setTranscript([]);
    setFeedSteps([]);
    setApproval({ sessionId: null, request: null });
    setError("");
    setServerError("");
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/cyberlab/agent/session", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const list: AgentSessionStatus[] = data.sessions ?? [];
      setSessions(list);
      if (list.length === 0) resetView();
      setActiveSessionId((current) => {
        if (current && list.some((s) => s.id === current)) return current;
        return list[0]?.id ?? null;
      });
    } catch {
      // polling failure is non-fatal
    }
  }, [resetView]);

  useEffect(() => {
    const kick = setTimeout(() => void loadSessions(), 0);
    pollRef.current = setInterval(() => void loadSessions(), 5000);
    return () => {
      clearTimeout(kick);
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [loadSessions]);

  const refreshSession = useCallback(async (sessionId: string) => {
    try {
      const [statusRes, transcriptRes] = await Promise.all([
        fetch(`/api/cyberlab/agent/session/${sessionId}/status`, { cache: "no-store" }),
        fetch(`/api/cyberlab/agent/session/${sessionId}/messages`, { cache: "no-store" }),
      ]);

      if (statusRes.ok) {
        const data: AgentSessionStatus = await statusRes.json();
        if (activeIdRef.current === sessionId) {
          setStatus(data);
          if (data.hasPendingApproval && data.approvalRequest) {
            setApproval({ sessionId, request: data.approvalRequest });
          } else {
            setApproval({ sessionId: null, request: null });
          }
          setServerError(data.lastError ?? "");
        }
      }

      if (transcriptRes.ok) {
        const data: TranscriptResponse = await transcriptRes.json();
        if (activeIdRef.current === sessionId) {
          if (data.messages.length > 0) setTranscript(data.messages);
          setFeedSteps(data.steps);
          if (data.runtimeError) setServerError(data.runtimeError);
        }
      }
    } catch {
      // transient polling failure — keep the last good view
    }
  }, []);

  useEffect(() => {
    if (!activeSessionId) return;
    const kick = setTimeout(() => void refreshSession(activeSessionId), 0);
    const iv = setInterval(() => void refreshSession(activeSessionId), 2500);
    return () => {
      clearTimeout(kick);
      clearInterval(iv);
    };
  }, [activeSessionId, refreshSession]);

  const startSession = useCallback(async () => {
    setLoading(true);
    setError("");
    setServerError("");
    setRemediation(null);
    try {
      const kickoff = mode === "teaching" ? TEACHING_KICKOFF : NORMAL_KICKOFF;
      const res = await fetch("/api/cyberlab/agent/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: kickoff }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.error || "Failed to start session");
        return;
      }
      const data = await res.json();
      if (data.sessionId) {
        setActiveSessionId(data.sessionId);
        setTranscript([{ role: "user", text: kickoff, thinking: null, tools: [] }]);
        setStatus({ ...(data as AgentSessionStatus), id: data.sessionId });
        void refreshSession(data.sessionId);
      }
      await loadSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "start_failed");
    } finally {
      setLoading(false);
    }
  }, [loadSessions, refreshSession]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!activeSessionId || !text) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/cyberlab/agent/session/${activeSessionId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.error || "Failed to send message");
        return;
      }
      setInput("");
      setTranscript((prev) => [...prev, { role: "user", text, thinking: null, tools: [] }]);
      void refreshSession(activeSessionId);
      await loadSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "send_failed");
    } finally {
      setLoading(false);
    }
  }, [activeSessionId, input, loadSessions, refreshSession]);

  const sendTerminalCommand = useCallback(async () => {
    const cmd = terminalInput.trim();
    if (!activeSessionId || !cmd) return;
    const prefixed = `[TERMINAL] run: ${cmd}`;
    setTerminalOutput((prev) => [...prev, `$ ${cmd}`]);
    setTerminalInput("");
    try {
      const res = await fetch(`/api/cyberlab/agent/session/${activeSessionId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: prefixed }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setTerminalOutput((prev) => [...prev, `! error: ${err.error || "terminal command failed"}`]);
        return;
      }
      void refreshSession(activeSessionId);
      await loadSessions();
    } catch (err) {
      setTerminalOutput((prev) => [...prev, `! error: ${err instanceof Error ? err.message : String(err)}`]);
    }
  }, [activeSessionId, terminalInput, loadSessions, refreshSession]);

  const stopSession = useCallback(async () => {
    if (!activeSessionId) return;
    try {
      await fetch(`/api/cyberlab/agent/session/${activeSessionId}/stop`, { method: "POST" });
      setApproval({ sessionId: null, request: null });
      void refreshSession(activeSessionId);
      await loadSessions();
    } catch {
      // swallow
    }
  }, [activeSessionId, loadSessions, refreshSession]);

  const resumeSession = useCallback(async () => {
    if (!activeSessionId) return;
    setLoading(true);
    setError("");
    try {
      const prompt =
        mode === "teaching"
          ? "Continue the bug-hunting lesson from where the session stopped. Re-check the attested target, then continue with the next concrete step."
          : "Continue the conversation from where the session stopped. Pick up where we left off and ask me what I want to work on next.";
      const res = await fetch(`/api/cyberlab/agent/session/${activeSessionId}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.error || "Failed to resume session");
        return;
      }
      setTranscript((prev) => [...prev, { role: "user", text: prompt, thinking: null, tools: [] }]);
      void refreshSession(activeSessionId);
      await loadSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "resume_failed");
    } finally {
      setLoading(false);
    }
  }, [activeSessionId, loadSessions, refreshSession]);

  const generateRemediation = useCallback(
    async (action: "fixlist" | "episode" | "both") => {
      if (!activeSessionId) return;
      setLoading(true);
      setError("");
      try {
        const res = await fetch(`/api/cyberlab/agent/session/${activeSessionId}/remediate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          setError(err.error || "Failed to generate remediation");
          return;
        }
        setRemediation(await res.json());
      } catch (err) {
        setError(err instanceof Error ? err.message : "remediation_failed");
      } finally {
        setLoading(false);
      }
    },
    [activeSessionId],
  );

  const handleApprove = useCallback(
    async (approved: boolean) => {
      if (!approval.sessionId) return;
      try {
        await fetch(`/api/cyberlab/agent/session/${approval.sessionId}/approve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ approved }),
        });
        setApproval({ sessionId: null, request: null });
        void refreshSession(approval.sessionId);
        await loadSessions();
      } catch {
        // swallow
      }
    },
    [approval.sessionId, loadSessions, refreshSession],
  );

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? status;
  const statusLabel = status?.status ?? activeSession?.status ?? "idle";
  const busy = !!status?.busy;
  const runtimeActive = status?.runtimeActive ?? activeSession?.runtimeActive;
  const canResume =
    !!activeSessionId && (!runtimeActive || status?.lastFinish === "error" || activeSession?.lastError != null);

  return (
    <div className="flex flex-col h-full rounded-lg border border-zinc-200 dark:border-zinc-800">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center gap-2">
          <div
            className={`h-2 w-2 rounded-full ${
              busy ? "animate-pulse bg-amber-500" : runtimeActive ? "bg-emerald-500" : "bg-zinc-400"
            }`}
          />
          <span className="font-semibold text-zinc-900 dark:text-zinc-100">Cyber Lab — Agent Console</span>
        </div>
        <div className="flex items-center gap-3 text-xs text-zinc-500 dark:text-zinc-400">
          <span>{busy ? "agent working…" : statusLabel}</span>
          {activeSession?.frozenByAdmin && <span className="text-red-500">FROZEN BY ADMIN</span>}
          {sessions.length > 0 && (
            <select
              value={activeSessionId ?? ""}
              onChange={(e) => {
                resetView();
                setActiveSessionId(e.target.value || null);
              }}
              className="max-w-[14rem] rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            >
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id.slice(0, 8)} · {s.status} · {s.modelId}
                </option>
              ))}
            </select>
          )}
        </div>
      </header>

      <div className="grid min-h-[520px] flex-1 grid-cols-1 overflow-hidden lg:grid-cols-2">
        <section className="flex min-w-0 flex-col border-b border-zinc-200 dark:border-zinc-800 lg:border-b-0 lg:border-r">
          <div className="border-b border-zinc-200 bg-zinc-100 p-3 dark:border-zinc-800 dark:bg-zinc-800">
            <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">Live Attack Feed</h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Real tool calls, approvals and agent events (newest last).
            </p>
          </div>
          <div className="flex-1 space-y-1 overflow-y-auto bg-zinc-950 p-3">
            {feedSteps.length === 0 && (
              <p className="text-xs italic text-zinc-500">
                No activity yet. Start a session, then approve its tool requests to see the feed.
              </p>
            )}
            {feedSteps.map((step) => (
              <div key={step.stepNo} className="rounded bg-zinc-900/70 p-2 text-[11px] text-zinc-300">
                <div className="flex items-center justify-between gap-2 text-zinc-500">
                  <span className="font-mono">#{step.stepNo}</span>
                  <span>{timeLabel(step.createdAt)}</span>
                </div>
                <div className="mt-0.5 break-words font-mono">{step.summary}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2 border-b border-zinc-200 bg-zinc-100 p-3 dark:border-zinc-800 dark:bg-zinc-800">
            <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">Agent</h2>
            {approval.request && (
              <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-900 dark:text-amber-100">
                PENDING APPROVAL
              </span>
            )}
          </div>

          <div className="flex-1 space-y-1 overflow-y-auto bg-zinc-50 p-3 dark:bg-zinc-900">
            {transcript.length === 0 && (
              <p className="text-xs italic text-zinc-500">
                No transcript yet. Start a session or pick one above.
              </p>
            )}
            {transcript.map((m, i) => (
              <MessageBubble key={i} message={m} />
            ))}
            {busy && (
              <div className="mb-2 rounded bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                Agent is working… approve any tool request below to let it continue.
              </div>
            )}
          </div>

          {(serverError || error) && (
            <div className="border-t border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
              {serverError || error}
            </div>
          )}

          <div className="border-t border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-800">
            <div className="flex gap-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void sendMessage();
                  }
                }}
                placeholder={activeSessionId ? "Say anything — random chat or a task for the agent…" : "Start a session first…"}
                disabled={loading || !activeSessionId}
                className="flex-1 rounded border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              />
              <button
                onClick={() => void sendMessage()}
                disabled={loading || !activeSessionId || !input.trim()}
                className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {loading ? "Sending…" : "Send"}
              </button>
            </div>
          </div>

          {approval.request && (
            <div className="border-t border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-800">
              <h3 className="mb-1 font-semibold text-zinc-900 dark:text-zinc-100">Tool Approval Required</h3>
              <p className="mb-2 text-xs text-zinc-600 dark:text-zinc-300">
                {approval.request.toolDescription || approval.request.reason || "The agent wants to run a tool."}
              </p>
              <div className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">
                <span className="font-bold">Tool:</span> {approval.request.toolName}
                <br />
                <span className="font-bold">Arguments:</span>{" "}
                {JSON.stringify(approval.request.arguments ?? approval.request.input ?? {})}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => void handleApprove(true)}
                  className="flex-1 rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
                >
                  Allow
                </button>
                <button
                  onClick={() => void handleApprove(false)}
                  className="flex-1 rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
                >
                  Deny
                </button>
              </div>
            </div>
          )}

          <div className="border-t border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-800">
            <h3 className="mb-2 font-semibold text-zinc-900 dark:text-zinc-100">Session Controls</h3>
            <div className="space-y-2">
              <div className="rounded border border-zinc-300 bg-zinc-50 p-2 dark:border-zinc-700 dark:bg-zinc-900/50">
                <div className="flex items-center justify-between gap-3 mb-1">
                  <span className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">Mode</span>
                  <div className="flex gap-1">
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="radio"
                        value="normal"
                        checked={mode === "normal"}
                        onChange={(e) => setMode(e.target.value as "normal" | "teaching")}
                        className="rounded border-zinc-400 bg-zinc-900 text-blue-600 focus:ring-0 dark:bg-zinc-800"
                      />
                      <span className="text-xs text-zinc-700 dark:text-zinc-200">Normal chat</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="radio"
                        value="teaching"
                        checked={mode === "teaching"}
                        onChange={(e) => setMode(e.target.value as "normal" | "teaching")}
                        className="rounded border-zinc-400 bg-zinc-900 text-blue-600 focus:ring-0 dark:bg-zinc-800"
                      />
                      <span className="text-xs text-zinc-700 dark:text-zinc-200">Teaching lesson</span>
                    </label>
                  </div>
                </div>
                <p className={`text-[10px] leading-none ${mode === "teaching" ? "text-emerald-500 dark:text-emerald-400" : "text-zinc-500 dark:text-zinc-400"}`}>
                  {mode === "teaching"
                    ? "Starts a 5-step bug-hunting lesson + how to get an attested target."
                    : "Random conversation or give the agent a task — no lesson."}
                </p>
              </div>
              <button
                onClick={() => void startSession()}
                disabled={loading}
                className="w-full rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {loading ? "Starting…" : "Start Session"}
              </button>
              {activeSessionId && (
                <>
                  <button
                    onClick={() => void stopSession()}
                    className="w-full rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
                  >
                    Stop Session
                  </button>
                  {canResume && (
                    <button
                      onClick={() => void resumeSession()}
                      className="w-full rounded bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700"
                    >
                      Resume Session
                    </button>
                  )}
                  <button
                    onClick={() => setTerminalOpen(!terminalOpen)}
                    className="w-full rounded bg-zinc-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-600"
                  >
                    {terminalOpen ? "Hide Terminal" : "Terminal Access"}
                  </button>
                  {(status?.status === "stopped" ||
                    status?.status === "failed" ||
                    status?.status === "idle") && (
                    <>
                      <button
                        onClick={() => void generateRemediation("fixlist")}
                        className="w-full rounded bg-purple-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-purple-700"
                      >
                        Generate Remediation Report
                      </button>
                      <button
                        onClick={() => void generateRemediation("episode")}
                        className="w-full rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
                      >
                        Create Signed Episode
                      </button>
                    </>
                  )}
                </>
              )}
            </div>
          </div>

          {terminalOpen && activeSessionId && (
            <div className="border-t border-zinc-200 bg-zinc-950 p-3 dark:border-zinc-800">
              <h3 className="mb-2 font-semibold text-zinc-100 dark:text-zinc-100 flex items-center gap-2">
                <span className="text-emerald-400">›_</span> Terminal Access
              </h3>
              <p className="mb-2 text-xs text-zinc-400 dark:text-zinc-500">
                Commands run directly on the host via the agent. Use this when the agent
                says no — you take manual control.
              </p>
              <div className="flex-1 min-h-[200px] max-h-[400px] overflow-y-auto bg-zinc-900/50 rounded border border-zinc-800 p-2 mb-2 text-xs font-mono text-zinc-300 space-y-1">
                {terminalOutput.length === 0 && (
                  <p className="text-zinc-500 italic">No commands run yet. Type a command below.</p>
                )}
                {terminalOutput.map((line, i) => (
                  <div key={i} className="break-all">{line}</div>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={terminalInput}
                  onChange={(e) => setTerminalInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void sendTerminalCommand();
                    }
                  }}
                  placeholder="e.g. nmap -sV <target>  or  curl -I https://<target>/admin"
                  disabled={loading || !activeSessionId}
                  className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm disabled:opacity-50 text-zinc-100 focus:ring-2 focus:ring-emerald-500"
                />
                <button
                  onClick={() => void sendTerminalCommand()}
                  disabled={loading || !activeSessionId || !terminalInput.trim()}
                  className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                >
                  Run
                </button>
              </div>
            </div>
          )}

          {remediation && (
            <div className="border-t border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-800">
              <h3 className="mb-2 font-semibold text-zinc-900 dark:text-zinc-100">Remediation Results</h3>
              {remediation.fixList && (
                <div className="mb-2">
                  <p className="mb-1 text-xs text-zinc-600 dark:text-zinc-300">
                    {remediation.fixList.totalFindings} finding(s) —{" "}
                    {remediation.fixList.findings.map((f) => f.severity).join(", ")}
                  </p>
                  <ul className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">
                    {remediation.fixList.findings.map((f, i) => (
                      <li key={i} className="mb-1">
                        <span className="font-bold">{f.title}</span> ({f.tool}) — {f.severity}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {remediation.episode && (
                <div className="text-xs text-zinc-600 dark:text-zinc-300">
                  Signed episode: {remediation.episode.episodeId} — hash:{" "}
                  {remediation.episode.signedHash?.slice(0, 16)}… ({remediation.episode.findingsCount} findings)
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
