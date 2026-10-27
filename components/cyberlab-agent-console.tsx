"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface AgentSessionStatus {
  id: string;
  userId: string;
  companyId: string | null;
  status: string;
  modelProvider: string;
  modelId: string;
  apiEndpoint: string | null;
  apiKeyHash: string | null;
  startedAt: string;
  lastActivityAt: string;
  idleShutdownAt: string | null;
  contextDocPath: string | null;
  frozenByAdmin: boolean;
  hasPendingApproval: boolean;
  approvalRequest: any;
  runtimeActive: boolean;
}

interface ToolApprovalRequest {
  toolName: string;
  toolDescription: string;
  arguments: Record<string, unknown>;
  reason: string;
}

interface ApprovalState {
  sessionId: string | null;
  request: ToolApprovalRequest | null;
}

export function CyberLabAgentConsole() {
  const [sessions, setSessions] = useState<AgentSessionStatus[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<{ role: string; content: string }[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [approval, setApproval] = useState<ApprovalState>({ sessionId: null, request: null });
  const [error, setError] = useState("");
  const [remediation, setRemediation] = useState<{
    fixList?: { totalFindings: number; findings: Array<{ tool: string; target: string; technique: string; severity: string; title: string; detail: string; fix: string; stepsToReproduce: string }>; fixReportMd: string };
    episode?: { episodeId: string; signedHash: string; findingsCount: number };
  } | null>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    loadSessions();
    pollRef.current = setInterval(loadSessions, 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/cyberlab/agent/session", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setSessions(data.sessions ?? []);
    } catch {
      // swallow — polling failure is non-fatal
    }
  }, []);

  const startSession = useCallback(async (prompt: string) => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/cyberlab/agent/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      if (!res.ok) {
        const err = await res.json();
        setError(err.error || "Failed to start session");
        setLoading(false);
        return;
      }
      const data = await res.json();
      setActiveSessionId(data.sessionId);
      setMessages((prev) => [...prev, { role: "user", content: prompt }]);
      await loadSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "start_failed");
    } finally {
      setLoading(false);
    }
  }, []);

  const sendMessage = useCallback(async (text: string) => {
    if (!activeSessionId) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/cyberlab/agent/session/${activeSessionId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text }),
      });
      if (!res.ok) {
        const err = await res.json();
        setError(err.error || "Failed to send message");
        setLoading(false);
        return;
      }
      const data = await res.json();
      setMessages((prev) => [...prev, { role: "user", content: text }, { role: "assistant", content: data.message ?? "Message sent" }]);
      await loadSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "send_failed");
    } finally {
      setLoading(false);
    }
  }, [activeSessionId]);

  const stopSession = useCallback(async () => {
    if (!activeSessionId) return;
    try {
      await fetch(`/api/cyberlab/agent/session/${activeSessionId}/stop`, { method: "POST" });
      setActiveSessionId(null);
      setMessages([]);
      setApproval({ sessionId: null, request: null });
      await loadSessions();
    } catch {
      // swallow
    }
  }, [activeSessionId]);

  const resumeSession = useCallback(async (prompt: string) => {
    if (!activeSessionId) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/cyberlab/agent/session/${activeSessionId}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      if (!res.ok) {
        const err = await res.json();
        setError(err.error || "Failed to resume session");
        setLoading(false);
        return;
      }
      const data = await res.json();
      setMessages((prev) => [...prev, { role: "user", content: prompt }]);
      await loadSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "resume_failed");
    } finally {
      setLoading(false);
    }
  }, [activeSessionId]);

  const generateRemediation = useCallback(async (action: "fixlist" | "episode" | "both") => {
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
        const err = await res.json();
        setError(err.error || "Failed to generate remediation");
        setLoading(false);
        return;
      }
      const data = await res.json();
      setRemediation(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "remediation_failed");
    } finally {
      setLoading(false);
    }
  }, [activeSessionId]);

  const handleApprove = useCallback(async (approved: boolean) => {
    if (!approval.sessionId) return;
    try {
      await fetch(`/api/cyberlab/agent/session/${approval.sessionId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved }),
      });
      setApproval({ sessionId: null, request: null });
      await loadSessions();
    } catch {
      // swallow
    }
  }, [approval.sessionId]);

  useEffect(() => {
    if (!activeSessionId) return;
    const iv = setInterval(async () => {
      try {
        const res = await fetch(`/api/cyberlab/agent/session/${activeSessionId}/status`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (data.hasPendingApproval && data.approvalRequest) {
          setApproval({ sessionId: activeSessionId, request: data.approvalRequest });
        } else {
          setApproval({ sessionId: null, request: null });
        }
      } catch {
        // swallow
      }
    }, 3000);
    return () => clearInterval(iv);
  }, [activeSessionId]);

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center justify-between border-b border-zinc-200 p-3 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-emerald-500 dark:bg-emerald-400" />
          <span className="font-semibold text-zinc-900 dark:text-zinc-100">Cyber Lab — Agent Console</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
          <span>{activeSession?.status ?? "idle"}</span>
          {activeSession?.frozenByAdmin && <span className="text-red-500">FROZEN BY ADMIN</span>}
        </div>
      </header>
      <div className="flex-1 overflow-hidden">
        <div className="flex h-full border-zinc-200 dark:border-zinc-800">
          <div className="flex-1 flex flex-col border-r border-zinc-200 dark:border-zinc-800 min-w-0">
            <div className="p-3 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-100 dark:bg-zinc-800">
              <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">Live Attack Feed</h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">Real events from Cline agent tool calls and network probes.</p>
            </div>
            <div className="flex-1 overflow-y-auto p-3 bg-zinc-950 dark:bg-zinc-950">
              {messages.length === 0 && (
                <p className="text-xs text-zinc-500 dark:text-zinc-400 italic">No activity yet. Start a session to see the live feed.</p>
              )}
              {messages.map((m, i) => (
                <div key={i} className={`mb-2 p-2 rounded text-xs ${m.role === "user" ? "bg-zinc-800 text-zinc-100" : "bg-zinc-800/50 text-zinc-300"}`}>
                  <span className="font-bold text-xs uppercase mr-1">{m.role === "user" ? "You" : "Agent"}</span>
                  {m.content}
                </div>
              ))}
            </div>
          <div className="w-3/5 flex flex-col border-l border-zinc-200 dark:border-zinc-800 min-w-0">
            <div className="flex-1 flex flex-col min-h-0">
              <div className="p-3 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-100 dark:bg-zinc-800">
                <h2 className="font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                  Agent
                  {approval.request && <span className="ml-2 px-2 py-0.5 rounded text-xs bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100">PENDING APPROVAL</span>}
                </h2>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">Conversation with the Cline agent.</p>
              </div>
              <div className="flex-1 overflow-y-auto p-3 bg-zinc-50 dark:bg-zinc-900">
                {messages.length === 0 && (
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 italic">Start a session to begin the conversation.</p>
                )}
                {messages.map((m, i) => (
                  <div key={i} className={`mb-2 p-2 rounded text-xs ${m.role === "user" ? "bg-blue-50 text-blue-900" : "bg-emerald-50 text-emerald-900 dark:bg-emerald-900/50 dark:text-emerald-100"}`}>
                    <span className="font-bold text-xs uppercase mr-1">{m.role === "user" ? "You" : "Agent"}</span>
                    {m.content}
                  </div>
                ))}
              </div>
              <div className="p-3 border-t border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-800">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && sendMessage(input)}
                    placeholder="Type a message to the agent…"
                    disabled={loading || !activeSessionId}
                    className="flex-1 px-3 py-1.5 text-sm border border-zinc-300 rounded dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 disabled:opacity-50"
                  />
                  <button
                    onClick={() => sendMessage(input)}
                    disabled={loading || !activeSessionId || !input.trim()}
                    className="px-4 py-1.5 text-sm font-medium bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-600 dark:hover:bg-blue-700"
                  >
                    {loading ? "Sending…" : "Send"}
                  </button>
                </div>
                {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
              </div>
            </div>
            {approval.request && (
              <div className="border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800 p-3">
                <h3 className="font-semibold text-zinc-900 dark:text-zinc-100 mb-1">Tool Approval Required</h3>
                <p className="text-xs text-zinc-600 dark:text-zinc-300 mb-2">{approval.request.toolDescription}</p>
                <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-2">
                  <span className="font-bold">Tool:</span> {approval.request.toolName}<br />
                  <span className="font-bold">Arguments:</span> {JSON.stringify(approval.request.arguments)}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleApprove(true)}
                    className="flex-1 px-3 py-1.5 text-sm font-medium bg-emerald-600 text-white rounded hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-700"
                  >
                    Allow
                  </button>
                  <button
                    onClick={() => handleApprove(false)}
                    className="flex-1 px-3 py-1.5 text-sm font-medium bg-red-600 text-white rounded hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-700"
                  >
                    Deny
                  </button>
                </div>
              </div>
            )}
            <div className="border-t border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-800 p-3">
              <h3 className="font-semibold text-zinc-900 dark:text-zinc-100 mb-2">Session Controls</h3>
              <div className="space-y-2">
                <button
                  onClick={() => startSession("Start a new cyber lab agent session")}
                  disabled={loading}
                  className="w-full px-3 py-1.5 text-sm font-medium bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-600 dark:hover:bg-blue-700"
                >
                  {loading ? "Starting…" : "Start New Session"}
                </button>
                {activeSessionId && (
                  <>
                    <button
                      onClick={stopSession}
                      className="w-full px-3 py-1.5 text-sm font-medium bg-red-600 text-white rounded hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-700"
                    >
                      Stop Session
                    </button>
                    {activeSession &&
                      (activeSession.status === "stopped" ||
                        activeSession.status === "failed" || activeSession.status === "idle") && (
                      <>
                      <button
                        onClick={() =>
                          resumeSession(
                            "Continue from where the session stopped. Pick up the last action and continue the offensive security assessment.",
                          )
                        }
                        className="w-full px-3 py-1.5 text-sm font-medium bg-amber-600 text-white rounded hover:bg-amber-700 dark:bg-amber-600 dark:hover:bg-amber-700"
                      >
                        Resume Session
                      </button>
                        {activeSession.status === "stopped" ||
                        activeSession.status === "failed" || activeSession.status === "idle" ? (
                          <>
                            <button
                              onClick={() => generateRemediation("fixlist")}
                              className="w-full px-3 py-1.5 text-sm font-medium bg-purple-600 text-white rounded hover:bg-purple-700 dark:bg-purple-600 dark:hover:bg-purple-700"
                            >
                              Generate Remediation Report
                            </button>
                            <button
                              onClick={() => generateRemediation("episode")}
                              className="w-full px-3 py-1.5 text-sm font-medium bg-indigo-600 text-white rounded hover:bg-indigo-700 dark:bg-indigo-600 dark:hover:bg-indigo-700"
                            >
                              Create Signed Episode
                            </button>
                          </>
                        ) : null}
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
            {remediation && (
              <div className="border-t border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-800 p-3 mt-3">
                <h3 className="font-semibold text-zinc-900 dark:text-zinc-100 mb-2">Remediation Results</h3>
                {remediation.fixList && (
                  <div className="mb-2">
                    <p className="text-xs text-zinc-600 dark:text-zinc-300 mb-1">
                      {remediation.fixList.totalFindings} finding(s) — {remediation.fixList.findings.map((f) => f.severity).join(", ")}
                    </p>
                    <ul className="text-xs text-zinc-500 dark:text-zinc-400 mb-2">
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
                    Signed episode: {remediation.episode.episodeId} — hash: {remediation.episode.signedHash?.slice(0, 16)}… ({remediation.episode.findingsCount} findings)
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}