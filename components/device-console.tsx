"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Clock,
  KeyRound,
  ListPlus,
  Monitor,
  ShieldCheck,
  Terminal,
  Wrench,
  X,
} from "lucide-react";

import { cn } from "@/lib/cn";

// Task 95 — the per-device console, ScreenConnect-style session window:
// a bordered pane with dot-triangle window furniture, a live status lamp,
// and tabs (Summary / Remote control / Command / Activity). Every mutating
// tool is the gated proposal flow (create → explicit approve → one-shot).

type DeviceView = {
  id: string;
  name: string;
  deviceKind: string;
  status: string;
  osName: string | null;
  osVersion: string | null;
  lastSeenAt: string | null;
  powerPolicy: { mode: string; until: string | null } | null;
};

type Tabs = "summary" | "control" | "command" | "activity";

type ProposalState = {
  pendingActionId: string;
  kind: string;
  result: string | null;
};

type MeshUrls = {
  hostname: string;
  control: string;
  terminal: string;
  file: string;
};

type QueuedRow = {
  id: string;
  shell: string;
  cmd: string;
  timeoutSeconds: number;
  runAsUser: boolean;
  status: string;
  scheduleKind?: string;
  wakeDelayMinutes?: number;
  createdAt: string;
  sentAt: string | null;
  error: string | null;
};

type PinRow = {
  id: string;
  pinLength: number;
  status: string;
  pin: string | null;
  expiresAt: string;
  createdAt: string;
};

type ActivityRow = {
  id: string;
  actionType: string;
  status: string;
  error: string | null;
  createdAt: string;
};

const TABS: Array<[Tabs, string, typeof Monitor]> = [
  ["summary", "Summary", Monitor],
  ["control", "Remote control", ShieldCheck],
  ["command", "Command", Terminal],
  ["activity", "Activity", Clock],
];

function relTime(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function timeAt(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function osLabel(osName: string | null): string {
  const name = (osName ?? "").toLowerCase();
  if (name.includes("win")) return "Windows";
  if (name.includes("mac") || name.includes("darwin") || name.includes("os x")) return "macOS";
  if (name.includes("linux")) return "Linux";
  return osName || "Unknown";
}

// ScreenConnect-style traffic-light dots for the console title bar.
function WindowDots() {
  return (
    <span className="flex shrink-0 items-center gap-1.5" aria-hidden>
      <span className="inline-block h-2.5 w-2.5 rounded-full bg-red-500/80" />
      <span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-400/80" />
      <span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-500/80" />
    </span>
  );
}

export function DeviceConsole({ deviceId }: { deviceId: string }) {
  const [device, setDevice] = useState<DeviceView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<Tabs>("summary");

  const [proposals, setProposals] = useState<ProposalState[]>([]);
  const [mesh, setMesh] = useState<MeshUrls | null>(null);
  const [meshErr, setMeshErr] = useState("");

  const [queue, setQueue] = useState<QueuedRow[]>([]);
  const [cmd, setCmd] = useState("");
  const [shell, setShell] = useState<"powershell" | "cmd">("powershell");
  const [timeout_, setTimeout_] = useState(30);
  // Command tab schedule: "next_checkin" runs on the next poll; "after_wake"
  // waits `wakeDelay` minutes from the moment the device COMES ON.
  const [scheduleKind, setScheduleKind] = useState<"next_checkin" | "after_wake">("next_checkin");
  const [wakeDelay, setWakeDelay] = useState(20);

  const [pins, setPins] = useState<PinRow[]>([]);
  const [pinLen, setPinLen] = useState(6);

  const [activity, setActivity] = useState<ActivityRow[]>([]);

  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isOnline = device?.status === "online" || device?.status === "asleep";

  const loadDevice = useCallback(async () => {
    try {
      const res = await fetch("/api/devices");
      if (!res.ok) throw new Error("Failed to load device");
      const data = await res.json();
      const row = (data.devices ?? []).find((d: { id: string }) => d.id === deviceId);
      if (!row) throw new Error("Device not found");
      setDevice({
        ...row,
        status: row.effectiveStatus ?? row.status ?? "unknown",
        powerPolicy: row.powerPolicy ?? null,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load device");
    } finally {
      setLoaded(true);
    }
  }, [deviceId]);

  const loadToolData = useCallback(async () => {
    if (!deviceId) return;
    try {
      const [q, p, a] = await Promise.all([
        fetch(`/api/devices/${deviceId}/queued-commands`),
        fetch(`/api/devices/${deviceId}/pin-requests`),
        fetch(`/api/devices/${deviceId}/activity`),
      ]);
      if (q.ok) setQueue((await q.json()).commands ?? []);
      if (p.ok) setPins((await p.json()).requests ?? []);
      if (a.ok) setActivity((await a.json()).actions ?? []);
    } catch {
      // non-fatal — tabs render with what we have
    }
  }, [deviceId]);

  useEffect(() => {
    loadDevice();
    loadToolData();
  }, [loadDevice, loadToolData]);

  // Light polling keeps status/queue/PIN state honest without hammering.
  useEffect(() => {
    pollRef.current = setInterval(() => {
      loadDevice();
      loadToolData();
    }, 15000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [loadDevice, loadToolData]);

  // ---- gated proposal flow -------------------------------------------------
  async function propose(kind: string, extra: Record<string, unknown> = {}) {
    setBusy(kind);
    setError("");
    setNotice("");
    try {
      const res = await fetch(`/api/devices/${deviceId}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, ...extra }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error(typeof data.error === "string" ? data.error : "Proposal failed");
      setProposals((prev) => [
        ...prev,
        { pendingActionId: data.pendingActionId, kind, result: null },
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Proposal failed");
    } finally {
      setBusy("");
    }
  }

  async function decide(p: ProposalState, approve: boolean) {
    setBusy(p.pendingActionId);
    setError("");
    try {
      const res = await fetch(`/api/devices/actions/${p.pendingActionId}`, {
        method: approve ? "POST" : "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = typeof data.error === "string" ? data.error : "Decision failed";
        throw new Error(code === "not_pending" ? "Already handled" : code);
      }
      if (approve && p.kind === "remote-control") {
        const mres = await fetch(
          `/api/devices/${deviceId}/mesh-urls?pendingActionId=${p.pendingActionId}`,
        );
        const mdata = await mres.json().catch(() => ({}));
        if (!mres.ok) {
          setMeshErr(
            typeof mdata.error === "string"
              ? mdata.error.replace("vantra_503: ", "")
              : "Couldn't fetch viewer URLs",
          );
          setMesh(null);
        } else {
          setMesh(mdata.urls);
          setMeshErr("");
          setTab("control");
        }
      }
      if (approve && p.kind === "pin-request") {
        setNotice("PIN prompt sent to the device — it appears below once typed in.");
        await loadToolData();
      }
      setProposals((prev) =>
        prev.map((x) =>
          x.pendingActionId === p.pendingActionId
            ? {
                ...x,
                result: approve
                  ? p.kind === "cmd" || p.kind === "run-script"
                    ? (data.output ?? "(no output)")
                    : "Done"
                  : "Rejected",
              }
            : x,
        ),
      );
      await loadToolData();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Decision failed");
    } finally {
      setBusy("");
    }
  }

  // ---- manual connect / disconnect (2026-10 owner follow-up) --------------
  // The console's own Connect is a NORMAL action: mint the viewer URLs right
  // away — no proposal, no approval rail. The approval flow stays exclusively
  // for AGENT-initiated requests (those pop up when the agent asks).
  async function connect() {
    setBusy("connect");
    setError("");
    setMeshErr("");
    try {
      const res = await fetch(`/api/devices/${deviceId}/mesh-urls`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data.error === "string"
            ? data.error.replace("vantra_503: ", "").replace("vantra_404: ", "")
            : "Couldn't open the viewer",
        );
      }
      setMesh(data.urls);
    } catch (e) {
      setMesh(null);
      setMeshErr(e instanceof Error ? e.message : "Couldn't open the viewer");
    } finally {
      setBusy("");
    }
  }

  function disconnect() {
    setMesh(null);
    setMeshErr("");
  }

  // ---- queued commands (schedule: run now / N min after the device comes on)
  async function queueCommand() {
    if (!cmd.trim()) return;
    setBusy("queue");
    setError("");
    try {
      const res = await fetch(`/api/devices/${deviceId}/queued-commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cmd,
          shell,
          timeout: timeout_,
          runAsUser: false,
          scheduleKind,
          wakeDelayMinutes: wakeDelay,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error(
          typeof data.error === "string"
            ? data.error.replace("vantra_503: ", "").replace("vantra_404: ", "")
            : "Queue failed",
        );
      setCmd("");
      await loadToolData();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Queue failed");
    } finally {
      setBusy("");
    }
  }

  async function cancelQueued(id: string) {
    setBusy(`cancel-${id}`);
    setError("");
    try {
      const res = await fetch(`/api/devices/${deviceId}/queued-commands`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queuedCommandId: id }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(typeof data.error === "string" ? data.error : "Cancel failed");
      }
      await loadToolData();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cancel failed");
    } finally {
      setBusy("");
    }
  }

  // ---- PIN request ----------------------------------------------------------
  async function requestPin() {
    setBusy("pin");
    setError("");
    try {
      await propose("pin-request", { pinLength: pinLen });
      await loadToolData();
    } finally {
      setBusy("");
    }
  }

  const statusWord = (s: string) => (s === "asleep" ? "asleep" : s === "online" ? "online" : "offline");
  const dot =
    device?.status === "online"
      ? "bg-emerald-500"
      : device?.status === "asleep"
        ? "bg-amber-400"
        : "bg-zinc-400";

  return (
    <div className="space-y-4">
      <Link
        href="/dashboard/devices"
        className="inline-flex items-center gap-1.5 text-sm text-fg-muted transition-colors hover:text-fg"
      >
        <ArrowLeft className="h-4 w-4" /> All devices
      </Link>

      {error && <p className="text-sm text-red-500">{error}</p>}

      {/* --------------------- the ScreenConnect-style session window */}
      <div className="overflow-hidden rounded-xl border border-border bg-bg-elevated shadow-lg">
        {/* title bar: dots · session name · live status lamp */}
        <div className="flex items-center justify-between gap-3 border-b border-border bg-black/20 px-4 py-3 dark:bg-black/40">
          <div className="flex min-w-0 items-center gap-3">
            <WindowDots />
            <span className="truncate font-mono text-sm font-medium text-fg">
              {loaded ? (device?.name ?? "Unknown machine") : "…"}
            </span>
            {loaded && device && (
              <span className="flex shrink-0 items-center gap-1.5 text-xs">
                <span className={cn("inline-block h-2 w-2 rounded-full", dot)} />
                <span className={isOnline ? "text-emerald-500" : "text-fg-muted"}>
                  {statusWord(device.status)}
                </span>
              </span>
            )}
          </div>
          <span className="shrink-0 font-mono text-xs text-fg-muted">
            {loaded && device ? osLabel(device.osName) : ""}
          </span>
        </div>

        {/* tab strip */}
        <div className="flex items-center gap-1 overflow-x-auto border-b border-border px-3 py-2">
          {TABS.map(([key, label, Icon]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors",
                tab === key
                  ? "bg-black/10 font-medium text-fg dark:bg-white/10"
                  : "text-fg-muted hover:bg-black/5 hover:text-fg dark:hover:bg-white/5",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>

        {/* tab body */}
        <div className="space-y-4 p-4">
          {tab === "summary" && <SummaryTab device={device} loaded={loaded} />}
          {tab === "control" && (
            <ControlTab
              isOnline={!!isOnline}
              mesh={mesh}
              meshErr={meshErr}
              busy={busy}
              connect={connect}
              disconnect={disconnect}
              propose={propose}
            />
          )}
          {tab === "command" && (
            <CommandTab
              queue={queue}
              cmd={cmd}
              setCmd={setCmd}
              shell={shell}
              setShell={setShell}
              timeout={timeout_}
              setTimeout={setTimeout_}
              scheduleKind={scheduleKind}
              setScheduleKind={setScheduleKind}
              wakeDelay={wakeDelay}
              setWakeDelay={setWakeDelay}
              busy={busy}
              queueCommand={queueCommand}
              cancelQueued={cancelQueued}
            />
          )}
          {tab === "activity" && <ActivityTab activity={activity} />}

          {/* PIN panel — shared across tabs (visible wherever an approval lands) */}
          {(pins.length > 0 || busy === "pin-request" || busy === "pin") && (
            <PinPanel pins={pins} pinLen={pinLen} setPinLen={setPinLen} busy={busy} requestPin={requestPin} />
          )}
        </div>
      </div>

      {/* approval rail + notices live outside the window chrome */}
      {proposals.length > 0 && (
        <div className="space-y-2">
          {proposals.map((p) => (
            <div
              key={p.pendingActionId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2"
            >
              <span className="flex items-center gap-2 text-sm text-fg">
                <ShieldCheck className="h-4 w-4 text-amber-500" />
                {p.kind}
                {p.result ? ` — ${p.result}` : " — needs your approval"}
              </span>
              {!p.result && (
                <span className="flex gap-2">
                  <button
                    onClick={() => decide(p, true)}
                    disabled={busy === p.pendingActionId}
                    className="rounded bg-emerald-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
                  >
                    Approve &amp; run
                  </button>
                  <button
                    onClick={() => decide(p, false)}
                    disabled={busy === p.pendingActionId}
                    className="rounded border border-border px-3 py-1 text-xs text-fg-muted transition-colors hover:text-fg disabled:opacity-50"
                  >
                    Reject
                  </button>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {notice && <p className="text-sm text-amber-500">{notice}</p>}
    </div>
  );
}

// ---- Summary ---------------------------------------------------------------
function SummaryTab({ device, loaded }: { device: DeviceView | null; loaded: boolean }) {
  if (!loaded) return <p className="text-sm text-fg-muted">Loading…</p>;
  if (!device) return <p className="text-sm text-fg-muted">Machine not found.</p>;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Info label="Machine" value={device.name} mono />
      <Info
        label="Operating system"
        value={osLabel(device.osName) + (device.osVersion ? ` · ${device.osVersion}` : "")}
      />
      <Info label="Last seen" value={relTime(device.lastSeenAt)} />
      <Info
        label="Power policy"
        value={
          device.powerPolicy && device.powerPolicy.mode !== "off"
            ? `${device.powerPolicy.mode}${device.powerPolicy.until ? ` · until ${timeAt(device.powerPolicy.until)}` : ""}`
            : "off"
        }
      />
      <p className="rounded-lg border border-border bg-bg px-3 py-2 text-xs text-fg-muted sm:col-span-2">
        Status is derived live from the agent&apos;s heartbeat (online window: 10 minutes).
        Destructive tools send a proposal first — nothing runs until you approve it.
      </p>
    </div>
  );
}

function Info({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-bg px-3 py-2">
      <p className="text-xs text-fg-muted">{label}</p>
      <p className={cn("mt-0.5 truncate text-sm text-fg", mono && "font-mono")}>{value}</p>
    </div>
  );
}

// ---- Remote control --------------------------------------------------------
// 2026-10 owner follow-up: MANUAL connect is a normal action — no approval.
// The approval-gated flow stays for AGENT-initiated requests only (those pop
// up when the agent wants something). The live viewer is ONE screen with a
// toolbox line on top: a ▾ dropdown opens a TRANSPARENT tool panel overlaying
// the screen (you keep seeing the desktop behind it), while the view switches
// (Desktop / Terminal / Files) stay on the same toolbox line.
function ControlTab({
  isOnline,
  mesh,
  meshErr,
  busy,
  connect,
  disconnect,
  propose,
}: {
  isOnline: boolean;
  mesh: MeshUrls | null;
  meshErr: string;
  busy: string;
  connect: () => Promise<void>;
  disconnect: () => void;
  propose: (kind: string, extra?: Record<string, unknown>) => Promise<void>;
}) {
  const [view, setView] = useState<"control" | "terminal" | "file">("control");
  const [toolsOpen, setToolsOpen] = useState(false);

  const viewUrl = mesh
    ? view === "control"
      ? mesh.control
      : view === "terminal"
        ? mesh.terminal
        : mesh.file
    : null;
  const VIEWS: Array<[typeof view, string, typeof Monitor]> = [
    ["control", "Desktop", Monitor],
    ["terminal", "Terminal", Terminal],
    ["file", "Files", Wrench],
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {!mesh ? (
          <button
            onClick={connect}
            disabled={busy === "connect" || !isOnline}
            title={!isOnline ? "The machine is offline" : "Open the live viewer now"}
            className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700 disabled:opacity-60"
          >
            <Monitor className="h-4 w-4" />
            {busy === "connect" ? "Connecting…" : "Connect"}
          </button>
        ) : (
          <button
            onClick={disconnect}
            className="flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 text-sm font-medium text-fg transition-colors hover:bg-black/5 dark:hover:bg-white/5"
          >
            <X className="h-4 w-4" /> Disconnect
          </button>
        )}
        <span className="text-xs text-fg-muted">
          {!isOnline
            ? "The machine is offline — connect retries the moment it checks in."
            : "Manual connect opens the live viewer directly — no approval needed."}
        </span>
      </div>

      {meshErr && (
        <p className="text-sm text-red-500">
          {meshErr.includes("offline")
            ? "This device is currently offline — the viewer opens the moment it checks in."
            : meshErr}
        </p>
      )}

      {mesh && viewUrl ? (
        // ONE screen + toolbox line ON TOP of it. The ▾ dropdown opens a
        // transparent panel OVER the screen (the desktop stays visible behind
        // it); the view switchers live on the same toolbox line.
        <div className="relative overflow-hidden rounded-lg border border-border">
          <div className="relative z-10 flex flex-wrap items-center gap-1.5 border-b border-border bg-black/40 px-2 py-1.5 backdrop-blur-sm">
            <div className="relative">
              <button
                onClick={() => setToolsOpen((v) => !v)}
                title="Session tools"
                className={cn(
                  "flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors",
                  toolsOpen ? "bg-black/30 text-fg" : "text-fg-muted hover:text-fg",
                )}
              >
                <Wrench className="h-3.5 w-3.5" />
                Tools
                <ChevronDown className={cn("h-3 w-3 transition-transform", toolsOpen && "rotate-180")} />
              </button>
              {toolsOpen && (
                <>
                  {/* click-away catcher */}
                  <div className="fixed inset-0 z-10" onClick={() => setToolsOpen(false)} />
                  <div className="absolute left-0 top-full z-20 mt-1 w-56 rounded-lg border border-border bg-bg-elevated/70 p-1.5 shadow-xl backdrop-blur-md">
                    <p className="px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-fg-muted">
                      Session tools
                    </p>
                    <button
                      onClick={() => {
                        setToolsOpen(false);
                        propose("maintenance-start");
                      }}
                      disabled={busy === "maintenance-start"}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-fg transition-colors hover:bg-black/10 disabled:opacity-50 dark:hover:bg-white/10"
                    >
                      <Wrench className="h-3.5 w-3.5" /> Maintenance overlay
                    </button>
                    <button
                      onClick={() => {
                        setToolsOpen(false);
                        propose("maintenance-stop");
                      }}
                      disabled={busy === "maintenance-stop"}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-fg transition-colors hover:bg-black/10 disabled:opacity-50 dark:hover:bg-white/10"
                    >
                      <X className="h-3.5 w-3.5" /> Stop overlay
                    </button>
                    <div className="my-1 border-t border-border" />
                    <button
                      onClick={() => {
                        setToolsOpen(false);
                        disconnect();
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-red-500 transition-colors hover:bg-red-500/10"
                    >
                      <X className="h-3.5 w-3.5" /> Disconnect session
                    </button>
                  </div>
                </>
              )}
            </div>
            <div className="mx-1 h-4 w-px bg-border" />
            {VIEWS.map(([key, label, Icon]) => (
              <button
                key={key}
                onClick={() => setView(key)}
                className={cn(
                  "flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors",
                  view === key ? "bg-black/30 font-medium text-fg" : "text-fg-muted hover:text-fg",
                )}
              >
                <Icon className="h-3.5 w-3.5" /> {label}
              </button>
            ))}
          </div>
          <iframe
            key={view}
            src={viewUrl}
            title={`Remote ${view}`}
            className="h-[480px] w-full bg-black"
            sandbox="allow-scripts allow-same-origin allow-forms"
          />
        </div>
      ) : (
        !meshErr && (
          <p className="rounded-lg border border-border bg-bg px-3 py-3 text-sm text-fg-muted">
            No active session. Press <span className="font-medium text-fg">Connect</span> and the
            MeshCentral viewer opens right here (Desktop / Terminal / Files from the toolbox line).
          </p>
        )
      )}
    </div>
  );
}

// ---- Command (queued commands: run now, or N min after the device comes on)
function CommandTab({
  queue,
  cmd,
  setCmd,
  shell,
  setShell,
  timeout,
  setTimeout,
  scheduleKind,
  setScheduleKind,
  wakeDelay,
  setWakeDelay,
  busy,
  queueCommand,
  cancelQueued,
}: {
  queue: QueuedRow[];
  cmd: string;
  setCmd: (v: string) => void;
  shell: "powershell" | "cmd";
  setShell: (v: "powershell" | "cmd") => void;
  timeout: number;
  setTimeout: (v: number) => void;
  scheduleKind: "next_checkin" | "after_wake";
  setScheduleKind: (v: "next_checkin" | "after_wake") => void;
  wakeDelay: number;
  setWakeDelay: (v: number) => void;
  busy: string;
  queueCommand: () => Promise<void>;
  cancelQueued: (id: string) => Promise<void>;
}) {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-bg p-3">
        <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
          <ListPlus className="h-3.5 w-3.5" /> Queue a command
        </p>
        <p className="mt-1 text-xs text-fg-muted">
          Runs on the device&apos;s next check-in — or on a timer after it comes on.
        </p>
        <textarea
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          rows={3}
          placeholder={shell === "powershell" ? "Get-Service | Select-Object -First 5" : "dir C:\\"}
          className="mt-2 w-full rounded-lg border border-border bg-bg-elevated px-3 py-2 font-mono text-sm text-fg placeholder:text-fg-muted/70 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-lg border border-border">
            {([["next_checkin", "Run on next check-in"], ["after_wake", "Timer after it comes on"]] as const).map(
              ([k, label]) => (
                <button
                  key={k}
                  onClick={() => setScheduleKind(k)}
                  className={cn(
                    "px-3 py-1.5 text-xs transition-colors",
                    scheduleKind === k
                      ? "bg-black/10 font-medium text-fg dark:bg-white/10"
                      : "text-fg-muted hover:text-fg",
                  )}
                >
                  {label}
                </button>
              ),
            )}
          </div>
          {scheduleKind === "after_wake" && (
            <label className="flex items-center gap-1.5 text-xs text-fg-muted">
              run
              <input
                type="number"
                min={1}
                max={10080}
                value={wakeDelay}
                onChange={(e) => setWakeDelay(Math.min(10080, Math.max(1, Number(e.target.value) || 20)))}
                className="w-16 rounded-lg border border-border bg-bg-elevated px-2 py-1.5 text-sm text-fg focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
              />
              min after it comes on
              <span className="flex gap-1">
                {[10, 20, 30, 60].map((m) => (
                  <button
                    key={m}
                    onClick={() => setWakeDelay(m)}
                    className={cn(
                      "rounded border border-border px-1.5 py-0.5 transition-colors",
                      wakeDelay === m ? "bg-black/10 font-medium text-fg dark:bg-white/10" : "text-fg-muted hover:text-fg",
                    )}
                  >
                    {m}m
                  </button>
                ))}
              </span>
            </label>
          )}
          <div className="flex overflow-hidden rounded-lg border border-border">
            {(["powershell", "cmd"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setShell(s)}
                className={cn(
                  "px-3 py-1.5 text-xs transition-colors",
                  shell === s
                    ? "bg-black/10 font-medium text-fg dark:bg-white/10"
                    : "text-fg-muted hover:text-fg",
                )}
              >
                {s === "powershell" ? "PowerShell" : "CMD"}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-xs text-fg-muted">
            timeout
            <input
              type="number"
              min={1}
              max={90}
              value={timeout}
              onChange={(e) => setTimeout(Math.min(90, Math.max(1, Number(e.target.value) || 30)))}
              className="w-16 rounded-lg border border-border bg-bg-elevated px-2 py-1.5 text-sm text-fg focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
            />
            s (max 90)
          </label>
          <button
            onClick={queueCommand}
            disabled={busy === "queue" || !cmd.trim()}
            className="ml-auto flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700 disabled:opacity-60"
          >
            <ListPlus className="h-3.5 w-3.5" />
            {busy === "queue" ? "Queueing…" : "Queue"}
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">Queued</p>
        {queue.length === 0 ? (
          <p className="rounded-lg border border-border bg-bg px-3 py-3 text-sm text-fg-muted">
            Nothing queued.
          </p>
        ) : (
          queue.map((q) => (
            <div key={q.id} className="rounded-lg border border-border bg-bg px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <code className="max-w-full truncate font-mono text-xs text-fg">
                  {q.shell === "powershell" ? "PS> " : "CMD> "}
                  {q.cmd}
                </code>
                <span className="flex items-center gap-2">
                  <span
                    className={cn(
                      "text-xs",
                      q.status === "queued"
                        ? "text-amber-500"
                        : q.status === "sent"
                          ? "text-emerald-500"
                          : "text-fg-muted",
                    )}
                  >
                    {q.status}
                  </span>
                  {q.status === "queued" && (
                    <button
                      onClick={() => cancelQueued(q.id)}
                      disabled={busy === `cancel-${q.id}`}
                      className="text-xs text-fg-muted transition-colors hover:text-fg disabled:opacity-50"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </span>
              </div>
              <p className="mt-1 text-xs text-fg-muted">
                queued {relTime(q.createdAt)}
                {q.sentAt
                  ? ` · sent ${relTime(q.sentAt)}`
                  : q.scheduleKind === "after_wake"
                    ? ` · runs ${q.wakeDelayMinutes ?? 0} min after the device comes on`
                    : " · runs on next check-in"}
                {q.error ? ` · ${q.error}` : ""}
              </p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
// ---- Activity ---------------------------------------------------------------
function ActivityTab({ activity }: { activity: ActivityRow[] }) {
  if (activity.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-bg px-3 py-3 text-sm text-fg-muted">
        No device activity yet — proposals you create (power, scripts, remote control, PIN
        requests) appear here with their outcome.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {activity.map((a) => (
        <div
          key={a.id}
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-bg px-3 py-2"
        >
          <span className="flex items-center gap-2 text-sm text-fg">
            <ChevronRight className="h-3.5 w-3.5 text-fg-muted" />
            <code className="font-mono text-xs">{a.actionType}</code>
            {a.error ? <span className="text-xs text-red-500">{a.error}</span> : null}
          </span>
          <span className="flex items-center gap-2 text-xs text-fg-muted">
            <span
              className={cn(
                a.status === "executed"
                  ? "text-emerald-500"
                  : a.status === "failed"
                    ? "text-red-500"
                    : a.status === "requested" || a.status === "approved"
                      ? "text-amber-500"
                      : "text-fg-muted",
              )}
            >
              {a.status}
            </span>
            · {timeAt(a.createdAt)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---- PIN panel ---------------------------------------------------------------
function PinPanel({
  pins,
  pinLen,
  setPinLen,
  busy,
  requestPin,
}: {
  pins: PinRow[];
  pinLen: number;
  setPinLen: (n: number) => void;
  busy: string;
  requestPin: () => Promise<void>;
}) {
  return (
    <div className="rounded-lg border border-border bg-bg p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
        <KeyRound className="h-3.5 w-3.5" /> PIN request
      </p>
      <p className="mt-1 text-xs text-fg-muted">
        Prompts the logged-in user with a Windows Security-style PIN box. The PIN appears here
        once they type it in.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-lg border border-border">
          {[4, 6, 8].map((n) => (
            <button
              key={n}
              onClick={() => setPinLen(n)}
              className={cn(
                "px-3 py-1.5 text-xs transition-colors",
                pinLen === n
                  ? "bg-black/10 font-medium text-fg dark:bg-white/10"
                  : "text-fg-muted hover:text-fg",
              )}
            >
              {n}-digit
            </button>
          ))}
        </div>
        <button
          onClick={requestPin}
          disabled={busy === "pin-request" || busy === "pin"}
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-fg transition-colors hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
        >
          {busy === "pin-request" || busy === "pin" ? "Requesting…" : "Request PIN"}
        </button>
      </div>
      {pins.length > 0 && (
        <div className="mt-3 space-y-2">
          {pins.slice(0, 5).map((p) => (
            <div
              key={p.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded border border-border px-2.5 py-1.5"
            >
              <span className="text-xs text-fg-muted">
                {p.pinLength}-digit · requested {relTime(p.createdAt)}
              </span>
              {p.status === "submitted" && p.pin ? (
                <code className="rounded bg-emerald-500/10 px-2 py-0.5 font-mono text-sm font-semibold tracking-[0.3em] text-emerald-500">
                  {p.pin}
                </code>
              ) : (
                <span className={cn("text-xs", p.status === "pending" ? "text-amber-500" : "text-fg-muted")}>
                  {p.status}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

