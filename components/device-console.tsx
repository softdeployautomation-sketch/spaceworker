"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Clock,
  Eye,
  EyeOff,
  Globe,
  KeyRound,
  ListPlus,
  Maximize2,
  Monitor,
  Power,
  RotateCcw,
  ShieldCheck,
  Terminal,
  Trash2,
  Wrench,
  X,
  Zap,
} from "lucide-react";

import { cn } from "@/lib/cn";
import { useConfirm } from "@/components/confirm-provider";
import { formatIdle } from "@/lib/device-idle";
import { timeAgo } from "@/lib/format-date";
import {
  DEFAULT_AGENT_LABEL,
  buildHideAgentScript,
  buildRevealAgentScript,
  isValidAgentLabel,
} from "@/lib/agent-visibility";

// Task 95 — the per-device console, ScreenConnect-style session window:
// a bordered pane with dot-triangle window furniture, a live status lamp,
// and tabs (Summary / Remote control / Command / Activity).
//
// 2026-10 gating model: every MANUAL tool (Connect, Run now, PIN collect,
// maintenance overlay, queued commands) executes immediately. The approval
// rail in this component exists for AGENT-initiated requests only — manual
// users never approve their own action.

type DeviceView = {
  id: string;
  name: string;
  deviceKind: string;
  status: string;
  osName: string | null;
  osVersion: string | null;
  lastSeenAt: string | null;
  powerPolicy: { mode: string; until: string | null } | null;
  // Task 106 (bit C1) — MeshCentral `idletime` in seconds (null when unknown).
  idleSeconds: number | null;
};

type Tabs = "summary" | "control" | "command" | "clone" | "activity";

// TASK_114 — the /api/devices/:id/clone-setup read model (mirrors
// lib/clone-setup.ts CloneSetupStatus; ids/paths never reach the UI copy).
type CloneSetupStatus = {
  sourceReady: boolean;
  hostedReady: boolean;
  online: boolean;
  relay: { addr: string; status: string; lastCheckAt: string | null } | null;
  capabilities: string[];
  // Fleet-level: any ONLINE device of this account carries `clone-host`. Not a
  // property of THIS device — the clone's browser always runs on a hosted PC —
  // but it is the first-order blocker, so the picker names it before Start
  // rather than letting the user hit a 409 that only mentions egress.
  hostedAvailable: boolean;
  // TASK_116: WHY there is no host. `self_only` is the loop the owner hit on
  // 2026-09-24 — the one PC set up as clone host is the PC being cloned FROM,
  // so a clone can never use it. Without this the copy told them to press a
  // button they had already pressed.
  hostBlockReason: "ok" | "no_host" | "self_only" | "offline";
  selfIsHost: boolean;
  offlineHostNames: string[];
};

type CloneSetupStep = { step: string; ok: boolean; detail: string | null };

// Task 111 (bit B5) — the console's Browser Clone model. Mirrors the shape
// lib/clone.ts `CloneView` hands the routes (evidence fields only — ids are
// route keys, never rendered copy). Human copy comes from CLONE_STEP_LABELS
// below, never from these raw status strings.
type CloneRow = {
  id: string;
  createdAt: string;
  updatedAt: string;
  launchedAt: string | null;
  revokedAt: string | null;
  status: string;
  terminal: boolean;
  launchState: string;
  browser: string;
  profileName: string | null;
  egressMode: string;
  source: { id: string; name: string; deviceStatus: string; online: boolean } | null;
  destination: { id: string; name: string; deviceStatus: string; online: boolean } | null;
  relay: {
    addr: string;
    status: string;
    lastCheckAt: string | null;
    lastSeenAt: string | null;
    consecutiveFailures: number;
  } | null;
  session: {
    id: string;
    status: string;
    egressMode: string | null;
    startedAt: string;
    lastUsedAt: string | null;
    stoppedAt: string | null;
    expiresAt: string | null;
  } | null;
  expiresAt: string | null;
  idleExpiresAt: string | null;
  ttlRemainingMs: number | null;
  idleRemainingMs: number | null;
  lastUsedAt: string | null;
  error: string | null;
};

// Human words for every lifecycle step — the owner quality bar is explicit:
// `Waiting for your PC` / human progress, never `awaiting_source` or an id.
const CLONE_STEP_LABELS: Record<string, string> = {
  requested: "Requested",
  awaiting_source: "Waiting for your PC",
  capturing: "Reading your browser",
  captured: "Browser data captured",
  transferring: "Copying your browser",
  received: "Copy received",
  injecting: "Preparing your session",
  ready: "Almost ready",
  launching: "Starting your browser",
  active: "Ready",
  expired_idle: "Session expired",
  expired_hard: "Session expired",
  revoked: "Revoked",
  failed: "Could not start",
  deleted: "Deleted",
};

const CLONE_BROWSER_LABELS: Record<string, string> = {
  chrome: "Chrome",
  edge: "Edge",
  firefox: "Firefox",
};

function cloneStepLabel(status: string): string {
  return CLONE_STEP_LABELS[status] ?? "Working on it";
}

function cloneBrowserLabel(browser: string): string {
  return CLONE_BROWSER_LABELS[browser] ?? "Browser";
}

function cloneEgressLabel(egressMode: string): string {
  return egressMode === "direct"
    ? "SpaceWorker's IP — sites may ask you to sign in again"
    : "Same IP as your PC";
}

function cloneEgressShort(egressMode: string): string {
  return egressMode === "direct" ? "SpaceWorker's IP" : "Same IP as your PC";
}

const CLONE_ACTIVE_STATES = new Set(["requested", "awaiting_source", "capturing"]);

function isCloneLiveStatus(status: string): boolean {
  return (
    status === "active" ||
    status === "ready" ||
    status === "launching" ||
    status === "injecting" ||
    status === "received" ||
    status === "transferring" ||
    status === "captured" ||
    CLONE_ACTIVE_STATES.has(status)
  );
}

function isCloneTerminalStatus(status: string): boolean {
  return (
    status === "expired_idle" ||
    status === "expired_hard" ||
    status === "revoked" ||
    status === "failed" ||
    status === "deleted"
  );
}

function formatCountdown(ms: number | null): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms <= 0) return "expired";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s left`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min left`;
  const h = Math.floor(m / 60);
  if (h < 24) {
    const rest = m % 60;
    return rest > 0 ? `${h} hr ${rest} min left` : `${h} hr left`;
  }
  const d = Math.floor(h / 24);
  return `${d} d left`;
}

function formatMonthDay(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

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
  ["clone", "Browser clone", Globe],
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

// Vantra's error strings arrive prefixed (`vantra_503: This device is currently
// offline.`). The console only ever shows the human half of the message.
// Codes this API returns are machine-readable on purpose (they are matched in
// routes and audits), but they were reaching the owner verbatim — a bare
// "Device setup failed" for a setup that was refused for a fixable reason, or
// "setup_already_running" with nothing to do about it. Render the ones the
// Device setup card can actually produce as a sentence; anything unknown still
// falls through unchanged rather than being swallowed.
const ERR_COPY: Record<string, string> = {
  device_offline: "This PC is offline — bring it online, then run setup again.",
  device_not_owned: "That device is not on your account.",
  device_not_linked: "That PC is not linked to the agent yet.",
  setup_already_running:
    "A setup is already running for this PC — wait for it to finish (it takes about a minute), then try again.",
  clone_engine_dist_missing: "The clone engine bundle is not on the server — deploy is incomplete.",
  clone_engine_dist_invalid: "The clone engine bundle on the server is unreadable.",
  clone_engine_dist_incomplete: "The clone engine bundle is missing files — deploy is incomplete.",
  vantra_not_configured: "The agent link is not configured on the server.",
};

function cleanErr(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value) return fallback;
  if (ERR_COPY[value]) return ERR_COPY[value];
  const text = value
    .replace("vantra_503: ", "")
    .replace("vantra_404: ", "")
    .replace("vantra_deploy_outdated: ", "Vantra deploy outdated — ")
    .trim();
  return text || fallback;
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

export function DeviceConsole({
  deviceId,
  fullScreen = false,
  initialTab = "summary",
}: {
  deviceId: string;
  fullScreen?: boolean;
  initialTab?: Tabs;
}) {
  const [device, setDevice] = useState<DeviceView | null>(null);
  const [loaded, setLoaded] = useState(false);
  // TASK_103 BUG-A — the tab is URL state (`?tab=`): a new window lands on
  // the same view and refresh preserves it. `history.replaceState` keeps it
  // shallow with no scroll jump (no next/navigation dependency).
  const [tab, setTabState] = useState<Tabs>(initialTab);
  const setTab = useCallback((next: Tabs) => {
    setTabState(next);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", next === "control" ? "remote" : next);
      window.history.replaceState(null, "", url.toString());
    } catch {
      // non-fatal — tab still switches, just not persisted
    }
  }, []);

  const [proposals, setProposals] = useState<ProposalState[]>([]);
  const [mesh, setMesh] = useState<MeshUrls | null>(null);
  const [meshErr, setMeshErr] = useState("");

  const [queue, setQueue] = useState<QueuedRow[]>([]);
  const [cmd, setCmd] = useState("");
  const [shell, setShell] = useState<"powershell" | "cmd">("powershell");
  const [timeout_, setTimeout_] = useState(30);
  // "Run now" instant-command result (2026-10): shown as a panel under the form.
  const [runOut, setRunOut] = useState<{ text: string; ok: boolean } | null>(null);
  // Command tab schedule: "next_checkin" runs on the next poll; "after_wake"
  // waits `wakeDelay` minutes from the moment the device COMES ON.
  const [scheduleKind, setScheduleKind] = useState<"next_checkin" | "after_wake">("next_checkin");
  const [wakeDelay, setWakeDelay] = useState(20);

  const [pins, setPins] = useState<PinRow[]>([]);
  const [pinLen, setPinLen] = useState(6);

  const [activity, setActivity] = useState<ActivityRow[]>([]);

  // Task 111 (bit B5) — Browser Clone state. Rides the console's existing
  // 15 s interval (no second timer); paused while the document is hidden.
  const [clones, setClones] = useState<CloneRow[]>([]);
  const [clonesLoaded, setClonesLoaded] = useState(false);
  const [cloneError, setCloneError] = useState("");
  const [cloneBusy, setCloneBusy] = useState("");
  const [cloneNotice, setCloneNotice] = useState("");
  const [cloneBrowser, setCloneBrowser] = useState<"chrome" | "edge" | "firefox">("chrome");
  const [cloneProfile, setCloneProfile] = useState("");
  const [cloneEgress, setCloneEgress] = useState<"relay" | "direct">("relay");
  const [isPremium, setIsPremium] = useState(false);
  // True once /api/entitlements has answered (ok or not) — the egress picker
  // must not render a "Premium" lock before we know the account state.
  const [premiumLoaded, setPremiumLoaded] = useState(false);

  // TASK_114 — one-click clone-device setup (relay + engine on this PC, or the
  // hosted receiver). Status rides the console's existing poll tick.
  const [cloneSetup, setCloneSetup] = useState<CloneSetupStatus | null>(null);
  const [setupBusy, setSetupBusy] = useState<"" | "source" | "hosted">("");
  const [setupErr, setSetupErr] = useState("");
  const [setupSteps, setSetupSteps] = useState<CloneSetupStep[]>([]);

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
        // Task 106 (bit C1) — idle rides the existing 15 s poll of
        // `/api/devices` (no extra request; console poll cadence unchanged).
        idleSeconds:
          typeof row.idleSeconds === "number" &&
          Number.isFinite(row.idleSeconds) &&
          row.idleSeconds >= 0
            ? row.idleSeconds
            : null,
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
      const [q, p, a, c, e, s] = await Promise.all([
        fetch(`/api/devices/${deviceId}/queued-commands`),
        fetch(`/api/devices/${deviceId}/pin-requests`),
        fetch(`/api/devices/${deviceId}/activity`),
        // Task 111 — clone history rides the same tick (role=any so a
        // pooled hosted PC also sees what it hosted; `deleted` filtered).
        fetch(`/api/devices/${deviceId}/clones?role=any&limit=50`),
        fetch(`/api/entitlements`),
        // TASK_114 — clone-device setup state (relay row + capabilities).
        fetch(`/api/devices/${deviceId}/clone-setup`),
      ]);
      if (q.ok) setQueue((await q.json()).commands ?? []);
      if (p.ok) setPins((await p.json()).requests ?? []);
      if (a.ok) setActivity((await a.json()).actions ?? []);
      if (c.ok) {
        const data = await c.json().catch(() => ({}));
        const rows = Array.isArray(data.clones) ? data.clones : [];
        setClones(rows.filter((r: CloneRow) => r && r.status !== "deleted"));
        setClonesLoaded(true);
      }
      if (e.ok) {
        const data = await e.json().catch(() => ({}));
        setIsPremium(data.premium === true);
      }
      if (s.ok) {
        const data = await s.json().catch(() => ({}));
        if (data && typeof data === "object" && "sourceReady" in data) {
          setCloneSetup(data as CloneSetupStatus);
        }
      }
      setPremiumLoaded(true);
    } catch {
      // non-fatal — tabs render with what we have
    }
  }, [deviceId]);

  // Task 111 — single-clone poll used while a clone is mid-flight so each
  // lifecycle step appears without a manual refresh.
  const pollClone = useCallback(async (cloneId: string) => {
    try {
      const res = await fetch(`/api/clones/${cloneId}`);
      if (!res.ok) return null;
      const data = await res.json().catch(() => ({}));
      const row = (data.clone ?? null) as CloneRow | null;
      if (row) {
        setClones((prev) => {
          const rest = prev.filter((r) => r.id !== row.id);
          return [row, ...rest].sort((x, y) => y.createdAt.localeCompare(x.createdAt));
        });
      }
      return row;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    loadDevice();
    loadToolData();
  }, [loadDevice, loadToolData]);

  // Light polling keeps status/queue/PIN/clone state honest without
  // hammering. Paused while the document is hidden.
  useEffect(() => {
    pollRef.current = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      loadDevice();
      loadToolData();
    }, 15000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [loadDevice, loadToolData]);

  // ---- AGENT approval rail ------------------------------------------------
  // 2026-10 owner rule: approvals exist for AGENT-initiated requests ONLY.
  // Every MANUAL console tool (Connect, Run now, PIN collect, maintenance
  // overlay, queued commands) executes directly — there is deliberately no
  // "propose your own action, then approve yourself" path in this component
  // any more. `decide()` stays because agent-initiated requests still land
  // here for an explicit yes/no.
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
        setNotice(
          "PIN request approved — immediate prompts show on the device now, queued ones fire when it comes on. The PIN appears below once typed in.",
        );
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

  // ---- maintenance overlay (2026-10) ---------------------------------------
  // MANUAL start/stop is a NORMAL action: it runs immediately — no proposal,
  // no approval rail (approvals are for AGENT-initiated requests only). The
  // overlay itself is device-side: the person at the machine sees the
  // maintenance screen while the technician keeps full control of the desktop.
  // Owner decision 2026-09-24 — the overlay has two BUILT-IN styles plus the
  // upload extra. `opts.style` picks the built-in ("update" = our own
  // PowerShell fake-Windows-Update screen, "exe" = the owner-supplied binary
  // with the smoother spinner); a custom image wins over `style` (server-side).
  async function runMaintenance(
    action: "start" | "stop",
    opts?: { style?: "update" | "exe"; customImageBase64?: string; customImageExt?: string },
  ) {
    const key = `maintenance-${action}`;
    setBusy(key);
    setError("");
    setNotice("");
    try {
      const res = await fetch(`/api/devices/${deviceId}/maintenance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...(opts ?? {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(cleanErr(data.error, "Maintenance action failed"));
      }
      setNotice(
        action === "start"
          ? "Maintenance screen is on — the machine shows it, you keep full control of the desktop."
          : "Maintenance screen stopped — the machine is back to its normal desktop.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Maintenance action failed");
    } finally {
      setBusy("");
    }
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

  // ---- instant command ("Run now", 2026-10) --------------------------------
  // ONLINE device: execute synchronously through Vantra — no approval rail,
  // same owner call as manual Connect / maintenance. Output shows in-tab.
  async function runNow() {
    if (!cmd.trim()) return;
    setBusy("runnow");
    setError("");
    setRunOut(null);
    try {
      const res = await fetch(`/api/devices/${deviceId}/run-command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cmd, shell, timeout: timeout_, runAsUser: false }),
      });
      const data = (await res.json().catch(() => ({}))) as { output?: unknown; error?: unknown };
      if (!res.ok) {
        const msg =
          typeof data.error === "string"
            ? data.error
                .replace("vantra_503: ", "")
                .replace("vantra_404: ", "")
                .replace("vantra_deploy_outdated: ", "Vantra deploy outdated — ")
            : "Run failed";
        throw new Error(msg);
      }
      setRunOut({
        text: typeof data.output === "string" && data.output ? data.output : "(no output)",
        ok: true,
      });
      setCmd("");
    } catch (e) {
      setRunOut({ text: e instanceof Error ? e.message : "Run failed", ok: false });
    } finally {
      setBusy("");
    }
  }

  // ---- PIN request ----------------------------------------------------------
  // MANUAL pin collect is a NORMAL action (2026-10 owner rule: the approval
  // gate is exclusively for AGENT-initiated requests) — executes immediately,
  // like Connect / Run now. len overrides the PinPanel selector (toolbox 4/6/8).
  async function postPin(body: Record<string, unknown>, notice: string) {
    setBusy("pin");
    setError("");
    try {
      const res = await fetch(`/api/devices/${deviceId}/pin-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error(
          typeof data.error === "string"
            ? data.error.replace("vantra_503: ", "").replace("vantra_deploy_outdated: ", "")
            : "PIN request failed",
        );
      setNotice(notice);
      await loadToolData();
    } catch (e) {
      setError(e instanceof Error ? e.message : "PIN request failed");
    } finally {
      setBusy("");
    }
  }

  function requestPin(len?: number) {
    return postPin(
      { pinLength: len ?? pinLen },
      "PIN prompt sent to the device — the PIN appears below once typed in.",
    );
  }

  // Queued PIN collect — for OFFLINE devices: minted now; the Windows prompt
  // fires when the device next checks in (or wakeDelay minutes after it comes
  // on), via Vantra's QueuedAgentCommand sweep.
  function queuePin(pinLength: number) {
    return postPin(
      {
        pinLength,
        scheduleKind,
        wakeDelayMinutes: scheduleKind === "after_wake" ? wakeDelay : 0,
      },
      "PIN request queued — the prompt fires when the device comes on.",
    );
  }

  // ---- TASK_103: Ping / Power / Hide-Reveal (manual, immediate) ------------
  // Manual own-device actions execute immediately — no approval (approvals
  // are for agent-initiated actions only). Ping never queues; power posts to
  // the direct power route; hide/reveal reuse run-command with the label.
  const confirm = useConfirm();
  const [ping, setPing] = useState<{ ok: boolean; text: string } | null>(null);
  async function pingAgent() {
    setBusy("ping");
    setError("");
    try {
      const res = await fetch(`/api/devices/${deviceId}/ping`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const age = device?.lastSeenAt ? ` · last check-in ${relTime(device.lastSeenAt)}` : "";
        setPing({ ok: false, text: `Agent not reachable${age}` });
        return;
      }
      const ms = typeof data.latencyMs === "number" ? Math.round(data.latencyMs) : null;
      setPing({ ok: true, text: ms !== null ? `Ping · ${ms} ms` : "Ping · ok" });
      await loadDevice();
    } catch (e) {
      setPing({ ok: false, text: e instanceof Error ? e.message : "Agent not reachable" });
    } finally {
      setBusy("");
    }
  }
  // TASK_103 MISSING-2 — direct power (manual, immediate). Shutdown and
  // Reboot both confirm FIRST (a misclick must never reboot a machine);
  // Wake is instant. Result is the transient chip (`power-reboot sent` /
  // `Agent not reachable`) + the command strip explaining itself.
  async function runPower(action: "reboot" | "shutdown" | "wake") {
    if (action === "reboot") {
      const ok = await confirm({
        title: "Reboot this machine?",
        description:
          "The machine restarts now. Unsaved work on the device may be lost. Only continue if that is acceptable.",
        confirmLabel: "Reboot now",
        confirmVariant: "primary",
      });
      if (!ok) return;
    }
    if (action === "shutdown") {
      const ok = await confirm({
        title: "Shut down this machine?",
        description:
          "The machine powers off now. Only continue if it can be woken (Wake-on-LAN) or someone is there to power it on.",
        confirmLabel: "Shut down",
        confirmVariant: "danger",
      });
      if (!ok) return;
    }
    const key = `power-${action}`;
    setBusy(key);
    setError("");
    setNotice("");
    try {
      const res = await fetch(`/api/devices/${deviceId}/power`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(cleanErr(data.error, `${action} failed`));
      setNotice(
        action === "reboot"
          ? "Reboot sent — the machine restarts now."
          : action === "shutdown"
            ? "Shutdown sent — the machine powers off now."
            : "Wake sent — the machine wakes if Wake-on-LAN is set up.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : `${action} failed`);
    } finally {
      setBusy("");
    }
  }
  const [agentLabel, setAgentLabel] = useState(DEFAULT_AGENT_LABEL);
  async function runAgentVisibility(mode: "hide" | "reveal") {
    const label = agentLabel.trim() || DEFAULT_AGENT_LABEL;
    if (mode === "hide" && !isValidAgentLabel(label)) {
      setRunOut({
        text: "Label must be 1–80 characters: letters, digits, spaces, hyphens only.",
        ok: false,
      });
      return;
    }
    const ok = await confirm({
      title: mode === "hide" ? `Hide the agent as "${label}"?` : "Reveal the agent again?",
      description:
        mode === "hide"
          ? `Services show "${label}" and the Apps-list entry disappears. Cosmetic only — a local admin can still stop, reveal, or uninstall it.`
          : "Restores the Tactical Agent service name and the Apps-list entry.",
      confirmLabel: mode === "hide" ? "Hide agent" : "Reveal agent",
      confirmVariant: mode === "hide" ? "primary" : "danger",
    });
    if (!ok) return;
    setBusy(`agent-${mode}`);
    setError("");
    setRunOut(null);
    try {
      const script = mode === "hide" ? buildHideAgentScript(label) : buildRevealAgentScript();
      const res = await fetch(`/api/devices/${deviceId}/run-command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cmd: script,
          shell: "powershell",
          timeout: 90,
          runAsUser: false,
          agentLabel: mode === "hide" ? label : undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { output?: unknown; error?: unknown };
      if (!res.ok) {
        throw new Error(
          typeof data.error === "string"
            ? cleanErr(data.error, "Agent visibility change failed")
            : "Agent visibility change failed",
        );
      }
      setRunOut({
        text: typeof data.output === "string" && data.output ? data.output : "(no output)",
        ok: true,
      });
    } catch (e) {
      setRunOut({ text: e instanceof Error ? e.message : "Agent visibility change failed", ok: false });
    } finally {
      setBusy("");
    }
  }

  // ONE delete for both halves of the PIN lifecycle (2026-10):
  //  • a still-waiting request → cancels it (its one-time token goes with it,
  //    so a late prompt can't block or confuse a new collect);
  //  • a collected PIN         → deletes it to free the UI once it's been used.
  // The row is dropped from local state immediately, so the list reacts at
  // once instead of waiting for the next poll.
  async function removePin(id: string) {
    setBusy(`pin-${id}`);
    setError("");
    try {
      const res = await fetch(`/api/devices/${deviceId}/pin-requests`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinRequestId: id }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(cleanErr(data.error, "Couldn't delete the PIN"));
      }
      setPins((prev) => prev.filter((p) => p.id !== id));
      await loadToolData();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't delete the PIN");
      await loadToolData();
    } finally {
      setBusy("");
    }
  }

  // ---- Browser Clone (Task 111 / bit B5) -----------------------------------
  // Consumes TASK_110's routes only — no lifecycle logic lives here. Start
  // returns 201 (created) or 202 (governor queued); every error renders
  // through cleanErr so no raw enum, id or upstream body reaches the UI.
  async function driveCloneLifecycle(cloneId: string) {
    // The sweep (TASK_112) does not exist yet, so the tab drives the first
    // run itself: advance → poll → advance until terminal or queued. Safe to
    // call repeatedly — advance is idempotent, terminal is a no-op.
    for (let i = 0; i < 12; i++) {
      let advanced = false;
      try {
        const res = await fetch(`/api/clones/${cloneId}/advance`, { method: "POST" });
        const data = await res.json().catch(() => ({}));
        if (res.status === 202) return; // governor queued — the sweep owns it now
        if (!res.ok) return; // terminal/transient — the regular poll shows it
        advanced = data.advanced === true;
      } catch {
        return;
      }
      const row = await pollClone(cloneId);
      if (!row || isCloneTerminalStatus(row.status)) return;
      if (!advanced) return;
    }
  }

  // TASK_114 — one click installs the clone engine on THIS device over the
  // agent (signed download → hash verify → quarantine → install → register →
  // probe). Nothing is downloaded or installed by hand; the step list shows
  // exactly where a refusal happened.
  async function runCloneSetup(role: "source" | "hosted") {
    setSetupBusy(role);
    setSetupErr("");
    setSetupSteps([]);
    setCloneError("");
    setCloneNotice("");
    try {
      const res = await fetch(`/api/devices/${deviceId}/clone-setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: unknown;
        steps?: unknown;
        error?: unknown;
      };
      const steps = Array.isArray(data.steps) ? (data.steps as CloneSetupStep[]) : [];
      setSetupSteps(steps);
      if (!res.ok) throw new Error(cleanErr(data.error, "Device setup failed"));
      if (data.ok !== true) {
        const failed = steps.find((st) => !st.ok);
        throw new Error(
          failed
            ? `Setup stopped at ${failed.step}${failed.detail ? `: ${failed.detail}` : ""}`
            : "Setup did not complete — see the steps.",
        );
      }
      setCloneNotice(
        role === "source"
          ? "This PC is set up for cloning — same-IP egress is live."
          : "This PC is now a hosted clone PC.",
      );
    } catch (e) {
      setSetupErr(e instanceof Error ? e.message : "Device setup failed");
    } finally {
      setSetupBusy("");
      await loadToolData();
    }
  }

  async function startClone() {
    setCloneBusy("start");
    setCloneError("");
    setCloneNotice("");
    try {
      const res = await fetch(`/api/devices/${deviceId}/clones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          egress: cloneEgress,
          browser: cloneBrowser,
          ...(cloneProfile.trim() ? { profile: cloneProfile.trim() } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const reason =
          typeof data.reason === "string" && data.reason
            ? data.reason
            : typeof data.error === "string"
              ? data.error
              : "Could not start the clone";
        throw new Error(reason);
      }
      const cloneId = typeof data.cloneId === "string" ? data.cloneId : null;
      if (data.queued === true) {
        const why =
          typeof data.message === "string" && data.message
            ? data.message
            : "The clone is queued — it starts when capacity frees up.";
        setCloneNotice(why);
      } else {
        setCloneNotice("Clone requested — it starts as soon as your PC and its relay are ready.");
      }
      await loadToolData();
      if (cloneId) void driveCloneLifecycle(cloneId);
    } catch (e) {
      setCloneError(cleanErr(e instanceof Error ? e.message : "Could not start the clone", "Could not start the clone"));
    } finally {
      setCloneBusy("");
    }
  }

  async function revokeClone(cloneId: string) {
    setCloneBusy(`revoke-${cloneId}`);
    setCloneError("");
    try {
      const res = await fetch(`/api/clones/${cloneId}/revoke`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          typeof data.reason === "string" && data.reason
            ? data.reason
            : "Could not revoke the clone",
        );
      }
      setCloneNotice("Clone revoked — the hosted browser is closed.");
      await pollClone(cloneId);
      await loadToolData();
    } catch (e) {
      setCloneError(cleanErr(e instanceof Error ? e.message : "Could not revoke the clone", "Could not revoke the clone"));
    } finally {
      setCloneBusy("");
    }
  }

  async function deleteClone(cloneId: string) {
    setCloneBusy(`delete-${cloneId}`);
    setCloneError("");
    try {
      const res = await fetch(`/api/clones/${cloneId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          typeof data.reason === "string" && data.reason
            ? data.reason
            : "Could not delete the clone",
        );
      }
      setClones((prev) => prev.filter((r) => r.id !== cloneId));
      await loadToolData();
    } catch (e) {
      setCloneError(cleanErr(e instanceof Error ? e.message : "Could not delete the clone", "Could not delete the clone"));
    } finally {
      setCloneBusy("");
    }
  }

  async function openCloneSession(cloneId: string) {
    setCloneBusy(`open-${cloneId}`);
    setCloneError("");
    try {
      const res = await fetch(`/api/clones/${cloneId}/session`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error("The session is not ready yet — try again in a moment.");
      const url = typeof data.openUrl === "string" && data.openUrl ? data.openUrl : `/clone/${cloneId}`;
      window.open(url, "_blank", "noopener");
    } catch (e) {
      setCloneError(cleanErr(e instanceof Error ? e.message : "The session is not ready yet", "The session is not ready yet"));
    } finally {
      setCloneBusy("");
    }
  }

  const statusWord = (s: string) => (s === "asleep" ? "asleep" : s === "online" ? "online" : "offline");
  const dot =
    device?.status === "online"
      ? "bg-emerald-500"
      : device?.status === "asleep"
        ? "bg-amber-400"
        : "bg-zinc-400";

  // Task 111 — Summary card inputs: the live session (if any) owns the Open
  // button; the newest row owns the "last clone" line. `active` wins over
  // mid-flight rows so a progressing clone never reads as the session.
  const liveClone =
    clones.find((r) => r.status === "active") ?? clones.find((r) => isCloneLiveStatus(r.status)) ?? null;
  const lastClone = clones.length > 0 ? clones[0] : null;

  return (
    <div className="space-y-4">
      {!fullScreen && (
        <Link
          href="/dashboard/devices"
          className="inline-flex items-center gap-1.5 text-sm text-fg-muted transition-colors hover:text-fg"
        >
          <ArrowLeft className="h-4 w-4" /> All devices
        </Link>
      )}

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
                  {!isOnline
                    ? `offline · last seen ${relTime(device.lastSeenAt)}`
                    : device.idleSeconds === null
                      ? statusWord(device.status)
                      : `${statusWord(device.status)} · ${formatIdle(device.idleSeconds)}`}
                </span>
              </span>
            )}
          </div>
          <span className="flex shrink-0 items-center gap-2">
            <span className="font-mono text-xs text-fg-muted">
              {loaded && device ? osLabel(device.osName) : ""}
            </span>
            {!fullScreen && (
              <button
                onClick={() =>
                  window.open(
                    `/console/${deviceId}?tab=${tab === "control" ? "remote" : tab}`,
                    "_blank",
                    "noopener",
                  )
                }
                title="Open the console alone in a bigger window"
                className="rounded-md border border-border p-1 text-fg-muted transition-colors hover:text-fg"
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </button>
            )}
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
          {tab === "summary" && (
            <SummaryTab
              device={device}
              loaded={loaded}
              liveClone={liveClone ?? null}
              lastClone={lastClone ?? null}
              clonesLoaded={clonesLoaded}
              cloneBusy={cloneBusy}
              openCloneSession={openCloneSession}
              goToCloneTab={() => setTab("clone")}
            />
          )}
          {tab === "control" && (
            <ControlTab
              isOnline={!!isOnline}
              mesh={mesh}
              meshErr={meshErr}
              busy={busy}
              connect={connect}
              disconnect={disconnect}
              runMaintenance={runMaintenance}
              requestPin={requestPin}
              pingAgent={pingAgent}
              ping={ping}
              runPower={runPower}
              goToCommand={() => setTab("command")}
              goToClone={() => setTab("clone")}
              lastSeenAt={device?.lastSeenAt ?? null}
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
              isOnline={!!isOnline}
              runNow={runNow}
              runOut={runOut}
              queuePin={queuePin}
              agentLabel={agentLabel}
              setAgentLabel={setAgentLabel}
              runAgentVisibility={runAgentVisibility}
            />
          )}
          {tab === "clone" && (
            <CloneTab
              clones={clones}
              loaded={clonesLoaded}
              err={cloneError}
              msg={cloneNotice}
              busy={cloneBusy}
              browser={cloneBrowser}
              setBrowser={setCloneBrowser}
              profile={cloneProfile}
              setProfile={setCloneProfile}
              egress={cloneEgress}
              setEgress={setCloneEgress}
              premium={isPremium}
              premiumLoaded={premiumLoaded}
              setup={cloneSetup}
              setupBusy={setupBusy}
              setupErr={setupErr}
              setupSteps={setupSteps}
              onSetup={runCloneSetup}
              onStart={startClone}
              onRevoke={revokeClone}
              onDelete={deleteClone}
              onOpen={openCloneSession}
            />
          )}
          {tab === "activity" && <ActivityTab activity={activity} />}

          {/* PIN panel — Remote-control scoped ONLY. It must never render under
              the Command tab (owner 2026-09-24: "pin request show under
              command tab, i think thats a leak"). The Command tab keeps its
              own "Queue PIN collect" card for offline scheduling; the live
              request/collect panel lives here, on Remote control. */}
          {tab === "control" && (
          <PinPanel
            pins={pins}
            pinLen={pinLen}
            setPinLen={setPinLen}
            busy={busy}
            requestPin={requestPin}
            removePin={removePin}
          />
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
function SummaryTab({
  device,
  loaded,
  liveClone,
  lastClone,
  clonesLoaded,
  cloneBusy,
  openCloneSession,
  goToCloneTab,
}: {
  device: DeviceView | null;
  loaded: boolean;
  liveClone: CloneRow | null;
  lastClone: CloneRow | null;
  clonesLoaded: boolean;
  cloneBusy: string;
  openCloneSession: (cloneId: string) => Promise<void>;
  goToCloneTab: () => void;
}) {
  if (!loaded) return <p className="text-sm text-fg-muted">Loading…</p>;
  if (!device) return <p className="text-sm text-fg-muted">Machine not found.</p>;
  const cloneLine = !clonesLoaded
    ? "checking clone status…"
    : liveClone
      ? `${cloneStepLabel(liveClone.status)} · ${cloneBrowserLabel(liveClone.browser)}`
      : lastClone
        ? `inactive · last clone ${formatMonthDay(lastClone.createdAt)}, ${cloneStepLabel(lastClone.status).toLowerCase()}`
        : "inactive · no clones yet";
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Info label="Machine" value={device.name} mono />
      <Info
        label="Operating system"
        value={osLabel(device.osName) + (device.osVersion ? ` · ${device.osVersion}` : "")}
      />
      {/* Owner 2026-09-23 — one last-seen display per screen. The console header
          chip already renders "offline · last seen …" / "online · idle …", and
          this row printed the SAME timestamp a second time right below it. The
          chip wins (always visible, even when Summary is scrolled), so the
          duplicate row is gone and "User activity" only reports idle — which
          exists only for a connected device (idletime goes stale offline). */}
      <Info
        label="User activity"
        value={
          device.status === "online" || device.status === "asleep"
            ? formatIdle(device.idleSeconds)
            : "—"
        }
      />
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
        Your own tools run immediately — the approval prompt only appears for actions the
        agent asks for on your behalf.
      </p>
      {/* Task 111 — compact clone card (always visible on Summary). The Open
          button is live-session-only; Manage switches to the Browser clone tab. */}
      <div className="rounded-lg border border-border bg-bg px-3 py-2 sm:col-span-2">
        <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
          <Globe className="h-3.5 w-3.5" /> Cloned browser
        </p>
        <p className="mt-1 text-sm text-fg">{cloneLine}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            onClick={() => liveClone && openCloneSession(liveClone.id)}
            disabled={!liveClone || cloneBusy === (liveClone ? `open-${liveClone.id}` : "open")}
            title={liveClone ? "Open the cloned browser in a new tab" : "No live session — start a clone below"}
            className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-brand-700 disabled:pointer-events-none disabled:opacity-50"
          >
            {liveClone && cloneBusy === `open-${liveClone.id}` ? "Opening…" : "Open cloned browser"}
          </button>
          <button
            onClick={goToCloneTab}
            className="rounded-lg border border-border px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
          >
            Manage clones →
          </button>
        </div>
      </div>
    </div>
  );
}

function CloneTab(props: { clones: CloneRow[]; loaded: boolean; err: string; msg: string; busy: string; browser: "chrome" | "edge" | "firefox"; setBrowser: (b: "chrome" | "edge" | "firefox") => void; profile: string; setProfile: (v: string) => void; egress: "relay" | "direct"; setEgress: (e: "relay" | "direct") => void; premium: boolean; premiumLoaded: boolean; setup: CloneSetupStatus | null; setupBusy: string; setupErr: string; setupSteps: CloneSetupStep[]; onSetup: (role: "source" | "hosted") => Promise<void>; onStart: () => Promise<void>; onRevoke: (id: string) => Promise<void>; onDelete: (id: string) => Promise<void>; onOpen: (id: string) => Promise<void> }) {
  const live = props.clones.find((r) => r.status === "active") ?? props.clones.find((r) => isCloneLiveStatus(r.status)) ?? null;
  return (
    <div className="space-y-4">
      {props.err && <p className="text-sm text-red-500">{props.err}</p>}
      {props.msg && <p className="text-sm text-emerald-500">{props.msg}</p>}
      <CloneSetupCard
        status={props.setup}
        busy={props.setupBusy}
        err={props.setupErr}
        steps={props.setupSteps}
        onSetup={props.onSetup}
      />
      <CloneStartCard browser={props.browser} setBrowser={props.setBrowser} profile={props.profile} setProfile={props.setProfile} egress={props.egress} setEgress={props.setEgress} premium={props.premium} premiumLoaded={props.premiumLoaded} busy={props.busy} onStart={props.onStart} setup={props.setup} />
      {live ? (
        <CloneLiveCard row={live} busy={props.busy} premium={props.premium} onOpen={props.onOpen} onRevoke={props.onRevoke} />
      ) : (
        props.loaded && (
          <p className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg-muted">No live clone right now — start one above and follow each step here.</p>
        )
      )}
      <div className="rounded-lg border border-border bg-bg p-3">
        <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">History</p>
        {!props.loaded ? (
          <p className="mt-1 text-sm text-fg-muted">Loading clone history…</p>
        ) : props.clones.length === 0 ? (
          <div className="mt-1">
            <p className="text-sm text-fg">No clones yet.</p>
            <p className="mt-0.5 text-xs text-fg-muted">Start your first clone above — every clone is dated and kept here, newest first.</p>
          </div>
        ) : (
          <ul className="mt-2 space-y-2">
            {props.clones.map((row) => (
              <CloneHistoryRow key={row.id} row={row} busy={props.busy} onOpen={props.onOpen} onRevoke={props.onRevoke} onDelete={props.onDelete} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function CloneHistoryRow(props: { row: CloneRow; busy: string; onOpen: (id: string) => Promise<void>; onRevoke: (id: string) => Promise<void>; onDelete: (id: string) => Promise<void> }) {
  const { row, busy, onOpen, onRevoke, onDelete } = props;
  const live = isCloneLiveStatus(row.status);
  const terminal = isCloneTerminalStatus(row.status) || row.terminal;
  const errText = row.error ? ` · ${row.error}` : row.status === "failed" ? " · could not start — try again" : "";
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-bg-elevated px-3 py-2">
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-fg">
          <span className="font-medium">{formatMonthDay(row.createdAt)}</span>
          <span className="text-fg-muted">·</span>
          <span>{cloneBrowserLabel(row.browser)}{row.profileName ? ` · ${row.profileName}` : ""}</span>
          <span className="text-fg-muted">·</span>
          <span className={cn(live ? "text-emerald-500" : row.status === "failed" ? "text-red-500" : "text-fg-muted")}>
            {cloneStepLabel(row.status)}
          </span>
        </span>
        <span className="mt-0.5 block text-xs text-fg-muted">
          {cloneEgressShort(row.egressMode)} · TTL {formatCountdown(row.ttlRemainingMs)}{errText}
        </span>
      </span>
      <span className="flex shrink-0 gap-2">
        {live && (
          <>
            <button
              onClick={() => onOpen(row.id)}
              disabled={row.status !== "active" || busy === `open-${row.id}`}
              className="rounded border border-border px-2 py-1 text-xs text-fg-muted transition-colors hover:text-fg disabled:pointer-events-none disabled:opacity-50"
            >
              Open
            </button>
            <button
              onClick={() => onRevoke(row.id)}
              disabled={busy === `revoke-${row.id}`}
              className="rounded border border-red-500/50 px-2 py-1 text-xs text-red-500 transition-colors hover:bg-red-500/10 disabled:opacity-50"
            >
              Revoke
            </button>
          </>
        )}
        {terminal && (
          <button
            onClick={() => onDelete(row.id)}
            disabled={busy === `delete-${row.id}`}
            title="Delete this record"
            className="rounded border border-border px-2 py-1 text-xs text-fg-muted transition-colors hover:text-fg disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </span>
    </li>
  );
}

function CloneLiveCard(props: { row: CloneRow; busy: string; premium: boolean; onOpen: (id: string) => Promise<void>; onRevoke: (id: string) => Promise<void> }) {
  const { row, busy, premium, onOpen, onRevoke } = props;
  const relayDown = row.egressMode === "relay" && row.relay !== null && row.relay.status !== "up";
  const idleShorter = row.idleRemainingMs !== null && row.idleRemainingMs < (row.ttlRemainingMs ?? Number.MAX_SAFE_INTEGER);
  return (
    <div className="rounded-lg border border-border bg-bg p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
        <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" /> Live now
      </p>
      <p className="mt-1 text-sm font-medium text-fg">
        {cloneStepLabel(row.status)} · {cloneBrowserLabel(row.browser)}
        {row.profileName ? ` · ${row.profileName}` : ""}
      </p>
      <p className="mt-0.5 text-xs text-fg-muted">
        started {relTime(row.launchedAt ?? row.createdAt)} · TTL {formatCountdown(row.ttlRemainingMs)}
        {idleShorter ? ` · idle ${formatCountdown(row.idleRemainingMs)}` : ""}
      </p>
      <p className="mt-0.5 text-xs text-fg-muted">{cloneEgressLabel(row.egressMode)}</p>
      {row.egressMode === "relay" && row.relay && (
        <p className="mt-0.5 text-xs text-fg-muted">
          Relay {row.relay.status === "up" ? "healthy" : "down — the clone stops rather than leak your IP"}
          {row.relay.lastCheckAt ? ` · checked ${relTime(row.relay.lastCheckAt)}` : ""}
        </p>
      )}
      {relayDown && (
        <p className="mt-1.5 rounded-lg border border-amber-500/40 bg-amber-500/5 px-2 py-1.5 text-xs text-fg">
          The relay on your PC is down, so this clone cannot proceed safely.
          {premium ? " You can also start again with SpaceWorker's IP." : ""}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          onClick={() => onOpen(row.id)}
          disabled={row.status !== "active" || busy === `open-${row.id}`}
          title={row.status === "active" ? "Open the cloned browser in a new tab" : "The session opens once the browser is ready"}
          className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-brand-700 disabled:pointer-events-none disabled:opacity-50"
        >
          {busy === `open-${row.id}` ? "Opening…" : "Open session"}
        </button>
        <button
          onClick={() => onRevoke(row.id)}
          disabled={busy === `revoke-${row.id}`}
          className="rounded-lg border border-red-500/50 px-3 py-1.5 text-xs font-medium text-red-500 transition-colors hover:bg-red-500/10 disabled:opacity-50"
        >
          {busy === `revoke-${row.id}` ? "Revoking…" : "Revoke"}
        </button>
      </div>
    </div>
  );
}

// TASK_114 — the one-click device setup card. Two roles, one button each:
//   "This PC"    → clone engine + egress relay + capture capability here.
//   "Clone host" → the hosted receiver (where the cloned browser actually runs).
// Nothing here is a download link the user has to open: the card POSTs and the
// agent installs, then the step list reports what the device said.
function CloneSetupCard(props: {
  status: CloneSetupStatus | null;
  busy: string;
  err: string;
  steps: CloneSetupStep[];
  onSetup: (role: "source" | "hosted") => Promise<void>;
}) {
  const { status, busy, err, steps, onSetup } = props;
  const sourceReady = status?.sourceReady === true;
  const hostedReady = status?.hostedReady === true;
  const online = status?.online === true;
  const relay = status?.relay ?? null;
  const row = (
    key: "source" | "hosted",
    title: string,
    hint: string,
    ready: boolean,
    cta: string,
    note?: string,
  ) => (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-bg-elevated px-3 py-2">
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-sm text-fg">
          {title}
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[11px]",
              ready ? "bg-emerald-500/15 text-emerald-500" : "bg-black/5 text-fg-muted dark:bg-white/10",
            )}
          >
            {ready ? "ready" : "not set up"}
          </span>
        </span>
        <span className="mt-0.5 block text-xs text-fg-muted">{hint}</span>
        {note && <span className="mt-0.5 block text-xs text-amber-500">{note}</span>}
      </span>
      <button
        onClick={() => onSetup(key)}
        disabled={busy !== "" || !online}
        title={online ? cta : "The device must be online to install"}
        className="rounded-lg border border-border px-3 py-1.5 text-xs text-fg transition-colors hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
      >
        {busy === key ? "Setting up…" : ready ? "Re-run setup" : cta}
      </button>
    </div>
  );
  return (
    <div className="rounded-lg border border-border bg-bg p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
        <Wrench className="h-3.5 w-3.5" /> Device setup
      </p>
      <p className="mt-1 text-xs text-fg-muted">
        One click installs the clone engine on this PC through the agent — nothing to download or
        install by hand. Same-IP cloning needs <span className="text-fg">this PC</span> set up (it
        carries your IP); every clone also needs a <span className="text-fg">clone host</span> to
        run the copied browser.
      </p>
      <div className="mt-2 grid gap-2">
        {row(
          "source",
          "This PC",
          relay
            ? `Relay ${relay.addr} · ${relay.status === "up" ? "up" : relay.status}${relay.lastCheckAt ? ` · checked ${timeAgo(relay.lastCheckAt)}` : ""}`
            : "Installs the egress relay so the clone keeps your IP and your signed-in sessions.",
          sourceReady,
          "Set up this PC",
        )}
        {row(
          "hosted",
          "Clone host",
          hostedReady
            ? "This PC runs the copied browser for clones."
            : "Makes this PC one of the machines a cloned browser can run on.",
          hostedReady,
          "Set up as clone host",
          // TASK_116 — "ready" alone was the misleading part of the owner's
          // screenshot: this PC is a valid host, just not for clones that
          // capture FROM this same PC. Say so where the badge is read.
          status?.selfIsHost && status?.hostedAvailable === false
            ? "Ready — but a clone can't use it while cloning FROM this PC. You need one more PC set up as clone host."
            : undefined,
        )}
      </div>
      {err && <p className="mt-2 text-xs text-red-500">{err}</p>}
      {steps.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {steps.map((st, i) => (
            <li
              key={`${st.step}-${i}`}
              className={cn("font-mono text-[11px]", st.ok ? "text-fg-muted" : "text-red-500")}
            >
              {st.ok ? "✓" : "✗"} {st.step}
              {st.detail ? ` — ${st.detail}` : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}


function CloneStartCard(props: { browser: "chrome" | "edge" | "firefox"; setBrowser: (b: "chrome" | "edge" | "firefox") => void; profile: string; setProfile: (v: string) => void; egress: "relay" | "direct"; setEgress: (e: "relay" | "direct") => void; premium: boolean; premiumLoaded: boolean; busy: string; onStart: () => Promise<void>; setup: CloneSetupStatus | null }) {
  const { browser, setBrowser, profile, setProfile, egress, setEgress, premium, premiumLoaded, busy, onStart, setup } = props;
  // Owner 2026-09-24: "no option to start with egress even when i am on
  // premium". Root cause: `premium` starts false and only flips when
  // /api/entitlements answers — before that the direct button renders
  // disabled+locked, which reads as "no option". Fix: while the account
  // state is still loading, keep BOTH options enabled (the server stays the
  // real gate and 403s direct-without-premium if forced). Once loaded, a
  // non-premium account sees the honest Premium lock.
  const directSelectable = premium || !premiumLoaded;
  return (
    <div className="rounded-lg border border-border bg-bg p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
        <Globe className="h-3.5 w-3.5" /> Start a clone
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <span className="block text-xs text-fg-muted">
          Browser
          <span className="mt-1 flex overflow-hidden rounded-lg border border-border">
            {(["chrome", "edge", "firefox"] as const).map((b) => (
              <button
                key={b}
                onClick={() => setBrowser(b)}
                className={cn(
                  "flex-1 px-2 py-1.5 text-xs transition-colors",
                  browser === b ? "bg-black/10 font-medium text-fg dark:bg-white/10" : "text-fg-muted hover:text-fg",
                )}
              >
                {cloneBrowserLabel(b)}
              </button>
            ))}
          </span>
        </span>
        <label className="block text-xs text-fg-muted">
          Profile (optional)
          <input
            value={profile}
            onChange={(e) => setProfile(e.target.value)}
            placeholder="Default"
            maxLength={64}
            className="mt-1 w-full rounded-lg border border-border bg-bg-elevated px-2 py-1.5 text-sm text-fg placeholder:text-fg-muted/70 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
          />
        </label>
        <span className="block text-xs text-fg-muted">
          Network
          {!premiumLoaded ? (
            <span className="mt-1 block text-xs text-fg-muted">Checking your plan…</span>
          ) : (
          <span className="mt-1 flex overflow-hidden rounded-lg border border-border">
            <button
              onClick={() => setEgress("relay")}
              title="Same IP as your PC — sites keep you signed in"
              className={cn(
                "flex-1 px-2 py-1.5 text-xs transition-colors",
                egress === "relay" ? "bg-black/10 font-medium text-fg dark:bg-white/10" : "text-fg-muted hover:text-fg",
              )}
            >
              Same IP as your PC
            </button>
            <button
              onClick={() => directSelectable && setEgress("direct")}
              disabled={!directSelectable}
              title={directSelectable ? "SpaceWorker's IP — sites may ask you to sign in again" : "Premium only — upgrade to unlock SpaceWorker's IP"}
              className={cn(
                "flex-1 px-2 py-1.5 text-xs transition-colors",
                egress === "direct" ? "bg-black/10 font-medium text-fg dark:bg-white/10" : "text-fg-muted hover:text-fg",
                !directSelectable && "cursor-not-allowed opacity-60",
              )}
            >
              SpaceWorker&apos;s IP{!directSelectable ? " · Premium" : ""}
            </button>
          </span>
          )}
        </span>
      </div>
      {!directSelectable && (
        <p className="mt-1.5 text-xs text-fg-muted">SpaceWorker&apos;s IP is a Premium feature — Same IP as your PC works on every plan.</p>
      )}
      {/* Owner 2026-09-24 ("egress still got a bug"): the egress choice is NOT
          the first blocker. The clone's browser always runs on a clone host, and
          "Same IP as your PC" additionally needs the relay on THIS PC. Both were
          reported only AFTER clicking Start, as a 409 whose copy talked about
          egress. Name the real blocker here, and point at the exact button in the
          Device setup card above — nothing is installed by hand. */}
      {setup !== null && (!setup.hostedAvailable || !setup.online || (egress === "relay" && !setup.sourceReady)) && (
        <ul className="mt-2 space-y-1 rounded-lg border border-amber-500/40 bg-amber-500/5 px-2.5 py-2 text-xs text-fg">
          {!setup.hostedAvailable && (
            <li>
              {/* TASK_116 (owner 2026-09-24: "clone host is ready, and i clicked
                  start clone, and its still say no host"): the generic line below
                  told the owner to press "Set up as clone host" on a PC they had
                  ALREADY set up — the one PC they owned. The reason now decides
                  the sentence. Start stays ENABLED on purpose: this flag can be a
                  false negative (a liveness refresh can fail), and the server is
                  the real gate — it refuses with copy that matches the reason. */}
              {setup.hostBlockReason === "self_only" ? (
                <>
                  <span className="font-medium">This PC is the clone host — and it can’t be.</span> A clone
                  can never run on the same machine it captures from, so one PC is not enough. Run{" "}
                  <span className="font-medium">“Set up as clone host”</span> above{" "}
                  <span className="font-medium">on a second PC</span> and keep that one online — then cloning
                  from here works.
                </>
              ) : setup.hostBlockReason === "offline" ? (
                <>
                  <span className="font-medium">
                    Your clone host{setup.offlineHostNames.length === 1 ? " is" : "s are"} offline.
                  </span>{" "}
                  {setup.offlineHostNames.length > 0 && (
                    <>
                      Clone hosts: <span className="font-medium">{setup.offlineHostNames.join(", ")}</span>.{" "}
                    </>
                  )}
                  Bring one online — the copied browser runs there, so a clone keeps running while your own PC is
                  used.
                </>
              ) : (
                <>
                  <span className="font-medium">No clone host yet.</span> A clone&apos;s browser runs on a clone
                  host, so this blocks every clone regardless of network. Clone hosts are counted{" "}
                  <span className="font-medium">apart from this PC</span> — a clone cannot run on the same
                  machine it captures from. Run <span className="font-medium">“Set up as clone host”</span>{" "}
                  above on a second PC and keep that one online.
                </>
              )}
            </li>
          )}
          {!setup.online && (
            <li>
              <span className="font-medium">This PC is offline.</span> Bring it online — its profile is
              captured live each time.
            </li>
          )}
          {egress === "relay" && !setup.sourceReady && (
            <li>
              <span className="font-medium">No relay set up on this PC for “Same IP as your PC”.</span> Run{" "}
              <span className="font-medium">“Set up this PC”</span> above (one click), or switch to
              SpaceWorker&apos;s IP.
            </li>
          )}
        </ul>
      )}
      <button
        onClick={onStart}
        disabled={busy === "start"}
        className="mt-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700 disabled:opacity-60"
      >
        {busy === "start" ? "Starting…" : "Start clone"}
      </button>
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

// TASK_103 BUG-B — shared toolbox menu shell: one button + one transparent
// overlay panel; only one panel open at a time (parent owns `open`).
function ToolboxMenu({
  label,
  icon,
  open,
  onToggle,
  onClose,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="relative">
      <button
        onClick={onToggle}
        title={`${label} tools`}
        className={cn(
          "flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors",
          open ? "bg-black/30 text-fg" : "text-fg-muted hover:text-fg",
        )}
      >
        {icon}
        {label}
        <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={onClose} />
          <div className="absolute left-0 top-full z-20 mt-1 w-56 rounded-lg border border-border bg-bg-elevated/70 p-1.5 shadow-xl backdrop-blur-md">
            {children}
          </div>
        </>
      )}
    </div>
  );
}

function ToolboxItem({
  onClick,
  disabled,
  title,
  icon,
  label,
}: {
  onClick: () => void;
  disabled?: boolean;
  title: string;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-fg transition-colors hover:bg-black/10 disabled:opacity-50 dark:hover:bg-white/10"
    >
      {icon}
      {label}
    </button>
  );
}

// ---- Remote control --------------------------------------------------------
// 2026-10 owner follow-up: MANUAL connect is a normal action — no approval.
// The approval-gated flow stays for AGENT-initiated requests only (those pop
// up when the agent wants something). The live viewer is ONE screen (Desktop
// only — the Terminal/Files switchers are removed) with a toolbox line on
// top: a ▾ dropdown opens a TRANSPARENT tool panel overlaying the screen
// (you keep seeing the desktop behind it) with maintenance, PIN collect and
// disconnect.
//
// Maintenance start/stop is ALSO manual and executes directly (2026-10): the
// device shows the maintenance screen, the technician keeps full control.
function ControlTab({
  isOnline,
  mesh,
  meshErr,
  busy,
  connect,
  disconnect,
  runMaintenance,
  requestPin,
  pingAgent,
  ping,
  runPower,
  goToCommand,
  goToClone,
  lastSeenAt,
}: {
  isOnline: boolean;
  mesh: MeshUrls | null;
  meshErr: string;
  busy: string;
  connect: () => Promise<void>;
  disconnect: () => void;
  runMaintenance: (
    action: "start" | "stop",
    opts?: { style?: "update" | "exe"; customImageBase64?: string; customImageExt?: string },
  ) => Promise<void>;
  requestPin: (len?: number) => Promise<void>;
  pingAgent: () => Promise<void>;
  ping: { ok: boolean; text: string } | null;
  runPower: (action: "reboot" | "shutdown" | "wake") => Promise<void>;
  goToCommand: () => void;
  goToClone: () => void;
  lastSeenAt: string | null;
}) {
  const [openMenu, setOpenMenu] = useState<"session" | "power" | "security" | "diagnostics" | null>(null);

  // Overlay style chooser (owner decision 2026-09-24) — two built-in styles plus
  // "use my own image". The image is read client-side into base64 and is never
  // stored anywhere; the route re-validates type, magic bytes and size.
  const overlayFileRef = useRef<HTMLInputElement | null>(null);
  const [overlayImageErr, setOverlayImageErr] = useState("");
  const [overlayImageName, setOverlayImageName] = useState("");
  const OVERLAY_IMAGE_EXTS = ["png", "gif", "jpg", "jpeg"];
  const OVERLAY_MAX_BYTES = 2 * 1024 * 1024;

  function pickOverlayImage(file: File) {
    setOverlayImageErr("");
    const ext = (file.name.split(".").pop() ?? "").toLowerCase();
    if (!OVERLAY_IMAGE_EXTS.includes(ext)) {
      setOverlayImageErr("Use a PNG, GIF, or JPEG.");
      return;
    }
    if (file.size > OVERLAY_MAX_BYTES) {
      setOverlayImageErr("That image is larger than 2MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : "";
      const comma = url.indexOf(",");
      if (comma < 0) {
        setOverlayImageErr("Couldn't read that file.");
        return;
      }
      setOverlayImageName(file.name);
      void runMaintenance("start", {
        customImageBase64: url.slice(comma + 1),
        customImageExt: ext,
      });
    };
    reader.onerror = () => setOverlayImageErr("Couldn't read that file.");
    reader.readAsDataURL(file);
  }

  useEffect(() => {
    if (!openMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openMenu]);

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
        <button
          onClick={pingAgent}
          disabled={busy === "ping"}
          title="Check the agent connection now (no queue row)"
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-fg transition-colors hover:bg-black/5 disabled:opacity-60 dark:hover:bg-white/5"
        >
          <Activity className="h-4 w-4" />
          {busy === "ping" ? "Pinging…" : "Ping"}
        </button>
        {ping && (
          <span
            className={cn(
              "rounded-full border px-2.5 py-1 font-mono text-[11px]",
              ping.ok
                ? "border-emerald-500/40 text-emerald-500"
                : "border-amber-500/40 text-amber-500",
            )}
            title={lastSeenAt ? `Last check-in ${relTime(lastSeenAt)}` : undefined}
          >
            {ping.text}
          </span>
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

      {/* Hidden picker behind "Maintenance with my image…". Kept off-screen
          rather than rendered inside the toolbox dropdown, because closing the
          dropdown must not cancel the OS file dialog. */}
      <input
        ref={overlayFileRef}
        type="file"
        accept="image/png,image/gif,image/jpeg"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          // Reset so picking the SAME file twice still fires onChange.
          e.target.value = "";
          if (f) pickOverlayImage(f);
        }}
      />
      {overlayImageErr && <p className="text-sm text-red-500">{overlayImageErr}</p>}
      {overlayImageName && !overlayImageErr && (
        <p className="text-xs text-fg-muted">Showing your image: {overlayImageName}</p>
      )}

      {mesh ? (
        // ONE screen + toolbox line ON TOP of it. Four grouped ▾ menus open
        // transparent panels OVER the screen (the desktop stays visible
        // behind them); only one panel opens at a time.
        <div className="relative overflow-hidden rounded-lg border border-border">
          <div className="relative z-10 flex flex-wrap items-center gap-1.5 border-b border-border bg-black/40 px-2 py-1.5 backdrop-blur-sm">
            <ToolboxMenu
              label="Session"
              icon={<Monitor className="h-3.5 w-3.5" />}
              open={openMenu === "session"}
              onToggle={() => setOpenMenu((p) => (p === "session" ? null : "session"))}
              onClose={() => setOpenMenu(null)}
            >
              <p className="px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-fg-muted">
                Session
              </p>
              {/* Maintenance screen — manual, immediate, no approval.
                  Device-side only: the machine shows it, control stays.

                  Owner decision 2026-09-24 — TWO built-in styles plus "use my
                  own image", so the technician picks per session:
                    • "Maintenance screen" = our own PowerShell fake-Windows-
                      Update look (the long-standing default, unchanged).
                    • "…(spinner)"        = the owner-supplied binary, which
                      renders a smoother spinner.
                    • "…with my image…"   = upload a PNG/GIF/JPEG; it wins over
                      the style (enforced server-side). */}
              <ToolboxItem
                onClick={() => {
                  setOpenMenu(null);
                  runMaintenance("start", { style: "update" });
                }}
                disabled={busy === "maintenance-start"}
                title="Show the maintenance screen on the device (you keep full control)"
                icon={<Wrench className="h-3.5 w-3.5" />}
                label={busy === "maintenance-start" ? "Starting…" : "Maintenance screen"}
              />
              <ToolboxItem
                onClick={() => {
                  setOpenMenu(null);
                  runMaintenance("start", { style: "exe" });
                }}
                disabled={busy === "maintenance-start"}
                title="Same maintenance screen with a smoother spinner (owner-supplied binary)"
                icon={<Wrench className="h-3.5 w-3.5" />}
                label={busy === "maintenance-start" ? "Starting…" : "Maintenance screen (spinner)"}
              />
              <ToolboxItem
                onClick={() => {
                  setOpenMenu(null);
                  setOverlayImageErr("");
                  overlayFileRef.current?.click();
                }}
                disabled={busy === "maintenance-start"}
                title="Show your own PNG/GIF/JPEG full-screen on the device"
                icon={<Maximize2 className="h-3.5 w-3.5" />}
                label="Maintenance with my image…"
              />
              <ToolboxItem
                onClick={() => {
                  setOpenMenu(null);
                  runMaintenance("stop");
                }}
                disabled={busy === "maintenance-stop"}
                title="Take the maintenance screen off the device"
                icon={<X className="h-3.5 w-3.5" />}
                label={busy === "maintenance-stop" ? "Stopping…" : "Stop overlay"}
              />
              <ToolboxItem
                onClick={() => {
                  setOpenMenu(null);
                  goToClone();
                }}
                title="Open the Browser clone tab"
                icon={<Globe className="h-3.5 w-3.5" />}
                label="Browser Clone"
              />
              <div className="my-1 border-t border-border" />
              <button
                onClick={() => {
                  setOpenMenu(null);
                  disconnect();
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-red-500 transition-colors hover:bg-red-500/10"
              >
                <X className="h-3.5 w-3.5" /> Disconnect session
              </button>
            </ToolboxMenu>
            <ToolboxMenu
              label="Power"
              icon={<Power className="h-3.5 w-3.5" />}
              open={openMenu === "power"}
              onToggle={() => setOpenMenu((p) => (p === "power" ? null : "power"))}
              onClose={() => setOpenMenu(null)}
            >
              <p className="px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-fg-muted">
                Power
              </p>
              <ToolboxItem
                onClick={() => {
                  setOpenMenu(null);
                  runPower("reboot");
                }}
                disabled={busy === "power-reboot"}
                title="Restart the machine now (manual, no approval)"
                icon={<RotateCcw className="h-3.5 w-3.5" />}
                label={busy === "power-reboot" ? "Rebooting…" : "Reboot"}
              />
              <ToolboxItem
                onClick={() => {
                  setOpenMenu(null);
                  runPower("shutdown");
                }}
                disabled={busy === "power-shutdown"}
                title="Power the machine off — confirm first"
                icon={<Power className="h-3.5 w-3.5" />}
                label={busy === "power-shutdown" ? "Shutting down…" : "Shutdown"}
              />
              <ToolboxItem
                onClick={() => {
                  setOpenMenu(null);
                  runPower("wake");
                }}
                disabled={busy === "power-wake"}
                title="Wake the machine (Wake-on-LAN)"
                icon={<Zap className="h-3.5 w-3.5" />}
                label={busy === "power-wake" ? "Waking…" : "Wake"}
              />
            </ToolboxMenu>
            <ToolboxMenu
              label="Security"
              icon={<KeyRound className="h-3.5 w-3.5" />}
              open={openMenu === "security"}
              onToggle={() => setOpenMenu((p) => (p === "security" ? null : "security"))}
              onClose={() => setOpenMenu(null)}
            >
              <p className="px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-fg-muted">
                Security
              </p>
              <div className="px-2 pb-1.5">
                <p className="flex items-center gap-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-fg-muted">
                  <KeyRound className="h-3 w-3" /> Collect PIN
                </p>
                <div className="flex gap-1">
                  {[4, 6, 8].map((n) => (
                    <button
                      key={n}
                      onClick={() => {
                        setOpenMenu(null);
                        requestPin(n);
                      }}
                      disabled={busy === "pin"}
                      title={`Prompt the logged-in user for a ${n}-digit PIN`}
                      className="flex-1 rounded-md border border-border px-2 py-1 text-center text-xs text-fg transition-colors hover:bg-black/10 disabled:opacity-50 dark:hover:bg-white/10"
                    >
                      {n}-digit
                    </button>
                  ))}
                </div>
              </div>
              <ToolboxItem
                onClick={() => {
                  setOpenMenu(null);
                  goToCommand();
                }}
                title="Queue a PIN prompt for when the device comes on"
                icon={<ListPlus className="h-3.5 w-3.5" />}
                label="Queue PIN collect"
              />
            </ToolboxMenu>
            <ToolboxMenu
              label="Diagnostics"
              icon={<Activity className="h-3.5 w-3.5" />}
              open={openMenu === "diagnostics"}
              onToggle={() => setOpenMenu((p) => (p === "diagnostics" ? null : "diagnostics"))}
              onClose={() => setOpenMenu(null)}
            >
              <p className="px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-fg-muted">
                Diagnostics
              </p>
              <ToolboxItem
                onClick={() => {
                  setOpenMenu(null);
                  pingAgent();
                }}
                disabled={busy === "ping"}
                title="Check the agent connection now (no queue row)"
                icon={<Activity className="h-3.5 w-3.5" />}
                label={busy === "ping" ? "Pinging…" : "Ping agent"}
              />
              <ToolboxItem
                onClick={() => {
                  setOpenMenu(null);
                  goToCommand();
                }}
                title="Run a command immediately (online) or queue it"
                icon={<Terminal className="h-3.5 w-3.5" />}
                label="Run command"
              />
            </ToolboxMenu>
            {ping && (
              <span
                className={cn(
                  "ml-auto rounded-full border px-2.5 py-1 font-mono text-[11px]",
                  ping.ok
                    ? "border-emerald-500/40 text-emerald-500"
                    : "border-amber-500/40 text-amber-500",
                )}
                title={lastSeenAt ? `Last check-in ${relTime(lastSeenAt)}` : undefined}
              >
                {ping.text}
              </span>
            )}
          </div>
          <iframe
            src={mesh.control}
            title="Remote desktop"
            className="h-[480px] w-full bg-black"
            sandbox="allow-scripts allow-same-origin allow-forms"
          />
        </div>
      ) : (
        !meshErr && (
          <p className="rounded-lg border border-border bg-bg px-3 py-3 text-sm text-fg-muted">
            No active session. Press <span className="font-medium text-fg">Connect</span> and the
            MeshCentral desktop viewer opens right here, with the session tools (maintenance
            overlay, PIN collect, disconnect) on the toolbar above it.
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
  isOnline,
  runNow,
  runOut,
  queuePin,
  agentLabel,
  setAgentLabel,
  runAgentVisibility,
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
  isOnline: boolean;
  runNow: () => Promise<void>;
  runOut: { text: string; ok: boolean } | null;
  queuePin: (pinLength: number) => Promise<void>;
  agentLabel: string;
  setAgentLabel: (v: string) => void;
  runAgentVisibility: (mode: "hide" | "reveal") => Promise<void>;
}) {
  // Queued-PIN digit length (4/6/8). The schedule itself is the SAME picker
  // as the command queue above — one schedule selection per tab.
  const [pinQLen, setPinQLen] = useState<4 | 6 | 8>(6);
  // 2026-10 owner rule: a cancelled command LEAVES the console — the row is
  // only ever shown while it can still fire (queued) or as the record of one
  // that already fired (sent/error). The server filters these too; this keeps
  // the tab exact even between polls.
  const visibleQueue = queue.filter((q) => q.status !== "cancelled");
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-bg p-3">
        <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
          <ListPlus className="h-3.5 w-3.5" /> Queue a command
        </p>
        <p className="mt-1 text-xs text-fg-muted">
          Device online? <span className="text-fg">Run now</span> executes immediately. Offline or
          on a schedule: it queues for the next check-in — or N minutes after the device comes on.
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
          <button
            onClick={runNow}
            disabled={busy === "runnow" || !cmd.trim()}
            title={
              isOnline
                ? "Run immediately on the device"
                : "Device is offline — Run now needs an online device (use Queue instead)"
            }
            className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-500 disabled:opacity-60"
          >
            <Zap className="h-3.5 w-3.5" />
            {busy === "runnow" ? "Running…" : "Run now"}
          </button>
        </div>
      </div>

      {runOut && (
        <div
          className={cn(
            "rounded-lg border px-3 py-2",
            runOut.ok ? "border-border bg-bg" : "border-red-500/40 bg-red-500/5",
          )}
        >
          <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">
            {runOut.ok ? "Output" : "Run failed"}
          </p>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-fg">
            {runOut.text}
          </pre>
        </div>
      )}

      {/* Queued PIN collect (2026-10) — offline-friendly: the request is
          minted now; the Windows prompt fires when the device next checks in
          (or wakeDelayMinutes after it comes on). Same schedule picker as the
          command queue above. */}
      <div className="rounded-lg border border-border bg-bg p-3">
        <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
          <KeyRound className="h-3.5 w-3.5" /> Queue PIN collect
        </p>
        <p className="mt-1 text-xs text-fg-muted">
          Device offline? Queue it — the PIN box pops up when the machine comes
          on, using the schedule selected above.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-lg border border-border">
            {([4, 6, 8] as const).map((n) => (
              <button
                key={n}
                onClick={() => setPinQLen(n)}
                className={cn(
                  "px-3 py-1.5 text-xs transition-colors",
                  pinQLen === n
                    ? "bg-black/10 font-medium text-fg dark:bg-white/10"
                    : "text-fg-muted hover:text-fg",
                )}
              >
                {n}-digit
              </button>
            ))}
          </div>
          <button
            onClick={() => queuePin(pinQLen)}
            disabled={busy === "pin"}
            title="Queue the PIN prompt for the device's next check-in"
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-fg transition-colors hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
          >
            <ListPlus className="h-3.5 w-3.5" />
            {busy === "pin" ? "Queueing…" : "Queue PIN"}
          </button>
        </div>
      </div>

      {/* TASK_103 MISSING-3 — Hide/Reveal agent. One-click, manual own-device,
          no approval; audited as `web-direct` via run-command. Reuses the
          Command-tab result pane above for output. Cosmetic only — reversible. */}
      <div className="rounded-lg border border-border bg-bg p-3">
        <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
          <EyeOff className="h-3.5 w-3.5" /> Agent visibility
        </p>
        <p className="mt-1 text-xs text-fg-muted">
          Hide renames the service display name and removes the Apps-list entry. Cosmetic only —
          a local admin can still stop, reveal, or uninstall it. Reveal restores everything.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-fg-muted">
            label
            <input
              value={agentLabel}
              onChange={(e) => setAgentLabel(e.target.value)}
              maxLength={80}
              placeholder={DEFAULT_AGENT_LABEL}
              className="min-w-0 flex-1 rounded-lg border border-border bg-bg-elevated px-2 py-1.5 text-sm text-fg placeholder:text-fg-muted/70 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
            />
          </label>
          <button
            onClick={() => runAgentVisibility("hide")}
            disabled={busy === "agent-hide"}
            title="Hide the agent under this label (cosmetic, reversible)"
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-fg transition-colors hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
          >
            <EyeOff className="h-3.5 w-3.5" />
            {busy === "agent-hide" ? "Hiding…" : "Hide agent"}
          </button>
          <button
            onClick={() => runAgentVisibility("reveal")}
            disabled={busy === "agent-reveal"}
            title="Restore the Tactical Agent name and Apps-list entry"
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-fg transition-colors hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
          >
            <Eye className="h-3.5 w-3.5" />
            {busy === "agent-reveal" ? "Revealing…" : "Reveal agent"}
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">Queued</p>
        {visibleQueue.length === 0 ? (
          <p className="rounded-lg border border-border bg-bg px-3 py-3 text-sm text-fg-muted">
            Nothing queued.
          </p>
        ) : (
          visibleQueue.map((q) => (
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
// 2026-10 owner rules:
//  • The PIN is NEVER on screen by default — it renders masked and only a
//    deliberate Show (eye) reveals it, per row, and it re-masks on Hide.
//  • The list only ever holds requests that came back with a PIN, plus the
//    live request still waiting on the person at the machine. Anything
//    cancelled/expired is pruned server-side, so it simply leaves the UI.
//  • Every row can be deleted (waiting = cancel it; collected = free the UI).
function PinPanel({
  pins,
  pinLen,
  setPinLen,
  busy,
  requestPin,
  removePin,
}: {
  pins: PinRow[];
  pinLen: number;
  setPinLen: (n: number) => void;
  busy: string;
  requestPin: (len?: number) => Promise<void>;
  removePin: (id: string) => Promise<void>;
}) {
  // Which collected PINs the owner has explicitly revealed in this session.
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const collected = pins.filter((p) => p.status === "submitted" && p.pin).slice(0, 5);
  // Newest live request only — the panel answers "is a prompt still out there?"
  const waiting = pins.find((p) => p.status === "pending") ?? null;

  return (
    <div className="rounded-lg border border-border bg-bg p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
        <KeyRound className="h-3.5 w-3.5" /> PIN request
      </p>
      <p className="mt-1 text-xs text-fg-muted">
        Prompts the logged-in user with a Windows Security-style PIN box. The PIN appears here
        once they type it in — hidden until you reveal it.
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
          onClick={() => requestPin()}
          disabled={busy === "pin"}
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-fg transition-colors hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
        >
          {busy === "pin" ? "Requesting…" : "Request PIN now"}
        </button>
      </div>

      {waiting && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded border border-amber-500/40 px-2.5 py-1.5">
          <span className="text-xs text-amber-500">
            {waiting.pinLength}-digit requested {relTime(waiting.createdAt)} — waiting for the person
            at the machine to type it in…
          </span>
          <button
            onClick={() => removePin(waiting.id)}
            disabled={busy === `pin-${waiting.id}`}
            title="Cancel this request — it won't block a new one"
            className="rounded border border-border px-1.5 py-0.5 text-[11px] text-fg-muted transition-colors hover:text-red-500 disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      )}

      {collected.length > 0 && (
        <div className="mt-3 space-y-2">
          {collected.map((p) => {
            const shown = !!revealed[p.id];
            return (
              <div
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded border border-border px-2.5 py-1.5"
              >
                <span className="text-xs text-fg-muted">
                  {p.pinLength}-digit · collected {relTime(p.createdAt)}
                </span>
                <span className="flex items-center gap-2">
                  <code className="rounded bg-emerald-500/10 px-2 py-0.5 font-mono text-sm font-semibold tracking-[0.3em] text-emerald-500">
                    {shown ? p.pin : "•".repeat(p.pinLength)}
                  </code>
                  <button
                    onClick={() => setRevealed((prev) => ({ ...prev, [p.id]: !shown }))}
                    title={shown ? "Hide the PIN again" : "Reveal the PIN"}
                    className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-fg-muted transition-colors hover:text-fg"
                  >
                    {shown ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                    {shown ? "Hide" : "Show"}
                  </button>
                  <button
                    onClick={() => removePin(p.id)}
                    disabled={busy === `pin-${p.id}`}
                    title="Delete this PIN — clears it from the console"
                    className="rounded border border-border p-1 text-fg-muted transition-colors hover:text-red-500 disabled:opacity-50"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

