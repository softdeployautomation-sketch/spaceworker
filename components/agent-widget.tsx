"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

import { Button, Spinner } from "@/components/ui";
import { useAgentPageContext } from "@/lib/agent-page-context";
import { cn } from "@/lib/cn";

// 2026-09-27 — the floating agent widget: a persistent, page-aware, mutable
// icon distinct from the automations page's own inline "Ask the agent" panel
// (that one stays as-is; this is the FIRST place the agent is reachable from
// every page, not just automations). Mounted once in <Shell>, which Next.js
// keeps mounted across navigations within the dashboard layout — so open/
// closed state and the message list survive page changes for free, no extra
// persistence wiring needed.
//
// Cost-conscious by construction: page context sent with each turn is a
// short, ROUTE-DERIVED label (see pageLabel below), never page HTML/DOM —
// same AI call, same Task 40 daily cap as any other agent turn, just with a
// small extra system-message string (see lib/agent.ts's runAgentTurn).

interface WidgetMessage {
  id: string;
  role: string;
  content: string;
  createdAt: string;
}

interface PendingAction {
  id: string;
  kind: "job" | "campaign" | "device";
  proposal: string | null;
  expiresAt: string;
}

interface WidgetDevice {
  id: string;
  name: string;
  status: string;
  screenshotOptIn: boolean | null; // null while its own row is still loading
}

// Route -> a short, human label for the AI's page context. Deliberately a
// flat prefix-match list (not full page content) — extend this list as more
// pages are worth naming; a page with no entry just falls back to raw path.
const PAGE_LABELS: Array<[string, string]> = [
  ["/dashboard/devices", "Devices"],
  ["/dashboard/campaigns", "Campaigns"],
  ["/dashboard/automations", "Automations"],
  ["/dashboard/settings", "Settings"],
  ["/dashboard/mailboxes", "Mailboxes"],
  ["/dashboard/browser", "Browser"],
  ["/dashboard/browser-profiles", "Browser Profiles"],
  ["/dashboard/licenses", "Licenses"],
  ["/dashboard/billing", "Billing"],
  ["/dashboard/advanced-search", "Advanced Search"],
  ["/dashboard/extract", "Extract"],
  ["/console/", "Device Console"],
  ["/clone/", "Browser Clone"],
];

function pageLabel(pathname: string): string {
  if (pathname === "/dashboard") return "Dashboard overview";
  for (const [prefix, label] of PAGE_LABELS) {
    if (pathname.startsWith(prefix)) return label;
  }
  return pathname;
}

// Honest "working" indicator — a small, rotating set of true, generic
// statements about what's actually happening, not fabricated precise steps
// (the backend is a single request/response call today, not a streamed
// multi-stage one). Cycling through these gives the "alive, thinking" feel
// the widget is meant to have without pretending to know stages it can't see.
const THINKING_PHRASES = ["Thinking…", "Reading your message…", "Preparing a reply…"];

// The richer, page-supplied context (see lib/agent-page-context.tsx) if the
// current page opted in, falling back to the generic route label otherwise.
function currentPageContext(pathname: string, pageCtx: ReturnType<typeof useAgentPageContext>): string {
  const rich = pageCtx?.getContext();
  return rich || `Viewing: ${pageLabel(pathname)}`;
}

export function AgentWidget() {
  const pathname = usePathname();
  const pageCtx = useAgentPageContext();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"chat" | "settings">("chat");
  const [agentActionsEnabled, setAgentActionsEnabled] = useState<boolean | null>(null);
  const [devices, setDevices] = useState<WidgetDevice[]>([]);
  const [devicesLoaded, setDevicesLoaded] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const [messages, setMessages] = useState<WidgetMessage[]>([]);
  const [pending, setPending] = useState<PendingAction[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [thinkingPhrase, setThinkingPhrase] = useState(THINKING_PHRASES[0]);
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Check the mute switch once on mount — cheap, and the widget must not even
  // flash visible before hiding itself for a user who turned it off. Same
  // response also carries agentActionsEnabled so the settings panel below
  // never needs a second round trip just to know its own starting state.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/agent")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setEnabled(data.widgetEnabled !== false);
        setAgentActionsEnabled(data.agentActionsEnabled !== false);
      })
      .catch(() => {
        if (!cancelled) setEnabled(true); // fail open — a failed check shouldn't hide a working feature
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Lazy, on-demand: only fetched once the settings view is actually opened,
  // not on every widget mount — same cost discipline as the chat thread's own
  // lazy load. One /api/devices call, then one /screenshots call per device
  // in parallel (bounded by however many devices this user actually has).
  const loadDevicesPanel = useCallback(async () => {
    try {
      const res = await fetch("/api/devices");
      if (!res.ok) return;
      const data = await res.json();
      const list: Array<{ id: string; name: string; status: string }> = data.devices ?? [];
      setDevices(list.map((d) => ({ id: d.id, name: d.name, status: d.status, screenshotOptIn: null })));
      setDevicesLoaded(true);
      const withOptIn = await Promise.all(
        list.map(async (d) => {
          try {
            const r = await fetch(`/api/devices/${d.id}/screenshots`);
            if (!r.ok) return { ...d, screenshotOptIn: null as boolean | null };
            const j = await r.json();
            return { ...d, screenshotOptIn: j.device?.optIn === true };
          } catch {
            return { ...d, screenshotOptIn: null as boolean | null };
          }
        }),
      );
      setDevices(withOptIn);
    } catch {
      // Best-effort — the panel just shows an empty list until retried.
    }
  }, []);

  useEffect(() => {
    if (view === "settings" && !devicesLoaded) void loadDevicesPanel();
  }, [view, devicesLoaded, loadDevicesPanel]);

  async function toggleAgentActions(next: boolean) {
    setSettingsBusy("agentActions");
    setSettingsError("");
    try {
      const res = await fetch("/api/settings/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentActionsEnabled: next }),
      });
      if (!res.ok) throw new Error("Couldn't change that.");
      setAgentActionsEnabled(next);
    } catch (e) {
      setSettingsError(e instanceof Error ? e.message : "Couldn't change that.");
    } finally {
      setSettingsBusy("");
    }
  }

  async function toggleDeviceScreenshots(deviceId: string, next: boolean) {
    setSettingsBusy(deviceId);
    setSettingsError("");
    try {
      const res = await fetch(`/api/devices/${deviceId}/screenshots`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) throw new Error("Couldn't change that.");
      setDevices((prev) => prev.map((d) => (d.id === deviceId ? { ...d, screenshotOptIn: next } : d)));
    } catch (e) {
      setSettingsError(e instanceof Error ? e.message : "Couldn't change that.");
    } finally {
      setSettingsBusy("");
    }
  }

  const loadThread = useCallback(async () => {
    try {
      const res = await fetch("/api/agent");
      if (!res.ok) return;
      const data = await res.json();
      setMessages(data.messages ?? []);
      setPending(data.pending ?? []);
      setLoaded(true);
    } catch {
      // Best-effort — the panel just shows nothing until the user retries.
    }
  }, []);

  useEffect(() => {
    if (open && !loaded) void loadThread();
  }, [open, loaded, loadThread]);

  useEffect(() => {
    if (!sending) return;
    let i = 0;
    const t = setInterval(() => {
      i = (i + 1) % THINKING_PHRASES.length;
      setThinkingPhrase(THINKING_PHRASES[i]);
    }, 1400);
    return () => clearInterval(t);
  }, [sending]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, sending]);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setError("");
    setSending(true);
    setThinkingPhrase(THINKING_PHRASES[0]);
    // Optimistic bubble so the widget never feels stuck waiting.
    setMessages((prev) => [
      ...prev,
      { id: `local-${Date.now()}`, role: "user", content: text, createdAt: new Date().toISOString() },
    ]);
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, pageContext: currentPageContext(pathname ?? "", pageCtx) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Something went wrong. Try again.");
        return;
      }
      setMessages(data.messages ?? []);
      const fresh = await fetch("/api/agent");
      if (fresh.ok) {
        const freshData = await fresh.json();
        setPending(freshData.pending ?? []);
      }
    } catch {
      setError("Network error. Try again.");
    } finally {
      setSending(false);
    }
  }

  async function decide(action: PendingAction, decision: "approve" | "reject") {
    setError("");
    try {
      const res = await fetch(`/api/agent/actions/${action.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(typeof data.error === "string" ? data.error : "Couldn't process that.");
        return;
      }
      setPending((prev) => prev.filter((p) => p.id !== action.id));
    } catch {
      setError("Network error. Try again.");
    }
  }

  if (enabled === false) return null;

  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col items-end gap-3">
      {open && (
        <div className="flex h-[28rem] w-[22rem] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-2xl border border-border bg-bg-elevated shadow-2xl">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-fg">Agent</p>
              <p className="truncate text-xs text-fg-muted">{pageLabel(pathname ?? "")}</p>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setView((v) => (v === "chat" ? "settings" : "chat"))}
                className={cn(
                  "rounded-lg p-1.5 text-fg-muted hover:bg-black/5 hover:text-fg dark:hover:bg-white/5",
                  view === "settings" && "bg-black/5 text-fg dark:bg-white/5",
                )}
                aria-label={view === "chat" ? "Agent settings" : "Back to chat"}
                title="Agent settings"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
                    stroke="currentColor"
                    strokeWidth="1.6"
                  />
                  <path
                    d="M19.4 13.5c.1-.5.1-1 0-1.5l1.6-1.2-1.5-2.6-1.9.5a7.6 7.6 0 0 0-1.3-.75L16 6h-3l-.3 1.95c-.46.19-.9.44-1.3.75l-1.9-.5-1.5 2.6 1.6 1.2c-.1.5-.1 1 0 1.5l-1.6 1.2 1.5 2.6 1.9-.5c.4.31.84.56 1.3.75L13 21h3l.3-1.95c.46-.19.9-.44 1.3-.75l1.9.5 1.5-2.6-1.6-1.2Z"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg p-1.5 text-fg-muted hover:bg-black/5 hover:text-fg dark:hover:bg-white/5"
                aria-label="Minimize"
              >
                ✕
              </button>
            </div>
          </div>

          {view === "settings" ? (
            <div className="flex-1 overflow-y-auto px-4 py-3">
              <div className="rounded-xl border border-border bg-black/5 p-3 dark:bg-white/5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-fg">Agent actions</p>
                    <p className="text-xs text-fg-muted">
                      Let the agent propose jobs, campaigns and device actions for you to approve.
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={agentActionsEnabled === true}
                    disabled={agentActionsEnabled === null || settingsBusy === "agentActions"}
                    onClick={() => void toggleAgentActions(!agentActionsEnabled)}
                    className={cn(
                      "relative h-5.5 w-9.5 shrink-0 rounded-full transition-colors disabled:opacity-50",
                      agentActionsEnabled ? "bg-brand-600" : "bg-gray-300 dark:bg-white/15",
                    )}
                  >
                    <span
                      className={cn(
                        "absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white transition-all",
                        agentActionsEnabled ? "left-[calc(100%-1.25rem)]" : "left-0.5",
                      )}
                    />
                  </button>
                </div>
              </div>

              <p className="mt-4 text-xs font-medium uppercase tracking-wide text-fg-muted">
                Screen monitoring
              </p>
              {!devicesLoaded ? (
                <div className="mt-2 flex items-center justify-center py-6">
                  <Spinner />
                </div>
              ) : devices.length === 0 ? (
                <p className="mt-1 text-sm text-fg-muted">No devices yet.</p>
              ) : (
                <div className="mt-2 flex flex-col gap-2">
                  {devices.map((d) => (
                    <div
                      key={d.id}
                      className="flex items-center justify-between gap-3 rounded-xl border border-border bg-black/5 p-3 dark:bg-white/5"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-fg">{d.name}</p>
                        <p className="text-xs text-fg-muted">{d.status}</p>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={d.screenshotOptIn === true}
                        disabled={d.screenshotOptIn === null || settingsBusy === d.id}
                        onClick={() => void toggleDeviceScreenshots(d.id, !d.screenshotOptIn)}
                        className={cn(
                          "relative h-5.5 w-9.5 shrink-0 rounded-full transition-colors disabled:opacity-50",
                          d.screenshotOptIn ? "bg-brand-600" : "bg-gray-300 dark:bg-white/15",
                        )}
                      >
                        <span
                          className={cn(
                            "absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white transition-all",
                            d.screenshotOptIn ? "left-[calc(100%-1.25rem)]" : "left-0.5",
                          )}
                        />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <p className="mt-3 text-xs text-fg-muted">
                Editing a device&apos;s own capture schedule (interval, or capturing right now) stays in
                that device&apos;s own console — this is just on/off.
              </p>
              {settingsError && <p className="mt-2 text-xs text-red-500">{settingsError}</p>}
            </div>
          ) : (
          <>
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3">
            {!loaded ? (
              <div className="flex h-full items-center justify-center">
                <Spinner />
              </div>
            ) : messages.length === 0 ? (
              <p className="text-sm text-fg-muted">
                Ask me to find leads, plan a campaign, check a device, or anything else — I&apos;ll
                propose what I can do and wait for your approval before anything real happens.
              </p>
            ) : (
              <div className="flex flex-col gap-2.5">
                {messages.slice(-40).map((m) => (
                  <div
                    key={m.id}
                    className={cn(
                      "max-w-[85%] rounded-xl px-3 py-2 text-sm",
                      m.role === "user"
                        ? "ml-auto bg-brand-600 text-white"
                        : "bg-black/5 text-fg dark:bg-white/5",
                    )}
                  >
                    {m.content}
                  </div>
                ))}
                {sending && (
                  <div className="flex items-center gap-2 rounded-xl bg-black/5 px-3 py-2 text-sm text-fg-muted dark:bg-white/5">
                    <span className="flex gap-1">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-fg-muted" />
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-fg-muted [animation-delay:150ms]" />
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-fg-muted [animation-delay:300ms]" />
                    </span>
                    {thinkingPhrase}
                  </div>
                )}
              </div>
            )}

            {pending.length > 0 && (
              <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
                {pending.map((p) => (
                  <div key={p.id} className="rounded-xl border border-border bg-black/5 p-3 text-sm dark:bg-white/5">
                    <p className="text-fg-muted">{p.proposal ?? `A ${p.kind} is waiting for your approval.`}</p>
                    <div className="mt-2 flex gap-2">
                      <Button variant="primary" className="px-3 py-1.5 text-xs" onClick={() => void decide(p, "approve")}>
                        Approve
                      </Button>
                      <Button variant="secondary" className="px-3 py-1.5 text-xs" onClick={() => void decide(p, "reject")}>
                        Reject
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
            className="flex items-center gap-2 border-t border-border p-3"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask the agent…"
              disabled={sending}
              className="min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-muted/70 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
            />
            <Button type="submit" disabled={sending || !input.trim()} className="px-3 py-2 text-sm">
              Send
            </Button>
          </form>
          </>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-14 w-14 items-center justify-center rounded-full bg-brand-600 text-white shadow-xl transition-transform hover:scale-105 hover:bg-brand-700",
          sending && "animate-pulse",
        )}
        aria-label={open ? "Close agent" : "Open agent"}
      >
        {open ? (
          <span className="text-xl">✕</span>
        ) : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M12 2a1 1 0 0 1 1 1v1.06A8.001 8.001 0 0 1 20 12v1a1 1 0 0 1-1 1h-1.06A8.001 8.001 0 0 1 13 20.94V22a1 1 0 1 1-2 0v-1.06A8.001 8.001 0 0 1 4.06 14H3a1 1 0 1 1 0-2h1.06A8.001 8.001 0 0 1 11 4.06V3a1 1 0 0 1 1-1Zm0 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12Z"
              fill="currentColor"
            />
          </svg>
        )}
      </button>
    </div>
  );
}
