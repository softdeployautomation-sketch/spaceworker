"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Activity,
  AppWindow,
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
  Search,
  ShieldCheck,
  Terminal,
  Trash2,
  Wrench,
  X,
  Zap,
} from "lucide-react";

import { cn } from "@/lib/cn";
import {
  CLONE_BROWSERS,
  cloneBrowserCarryRefusal,
  cloneBrowserLabel,
  isCarriableBrowser,
  type CloneBrowser,
} from "@/lib/clone-browsers";
import { useConfirm } from "@/components/confirm-provider";
import { ScreenTimeline, captureFailureCopy } from "@/components/screen-timeline";
import { ScreenAlertsCard } from "@/components/screen-alerts-card";
import { useSetAgentPageContext } from "@/lib/agent-page-context";
import {
  idleChipLabel,
  idleReadProvenanceFrom,
  relTime,
  type IdleReadProvenance,
} from "@/lib/device-idle";
import { timeAgo } from "@/lib/format-date";
import {
  DEFAULT_AGENT_LABEL,
  buildHideAgentScript,
  buildRevealAgentScript,
  isValidAgentLabel,
} from "@/lib/agent-visibility";
import {
  ONBOARDING_ACCESSIBLE_NOTE,
  formatOnboardingElapsed,
  isOnboardingTerminal,
  onboardingClockText,
  onboardingView,
} from "@/lib/device-onboarding";

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
  // TASK_128 — Public/Private tier + the onboarding row. `hideLabel` prefills
  // the existing Agent-visibility card so the device hidden during quarantine
  // shows the SAME label the stage used (reuse only — no second tool);
  // `lastError` is what the Summary card surfaces when a move never landed
  // (§6 — the row badge stays Public and the console says why).
  tier: string;
  onboarding: {
    status: string;
    timerStartedAt: string;
    hideDoneAt: string | null;
    stayOnDoneAt: string | null;
    releasedAt: string | null;
    hideLabel: string | null;
    destinationOrgId: string | null;
    lastError: string | null;
  } | null;
};

// TASK_123 (B12) — GET /api/devices/:id/power's read model (lib/device-tools.ts
// DevicePowerView). `wake.reason` is only ever shown when `available` is false.
type PowerView = {
  policy: { mode: "off" | "timed" | "indefinite"; until: string | null };
  wake: { available: boolean; reason: "ok" | "no_power_mac" | "no_same_subnet_peer" };
};

type Tabs = "summary" | "control" | "command" | "clone" | "activity" | "monitoring";

// TASK_127 Phase 1 — the device-screen-monitoring read model, mirroring
// GET /api/devices/:id/screenshots. Frame BYTES are not here: each frame is
// fetched from its own route (which re-checks ownership), so the console never
// holds a screen image in memory until the owner actually opens it.
type ScreenMonitorView = {
  device: {
    id: string;
    name: string;
    status: string;
    optIn: boolean;
    intervalMinutesOverride: number | null;
  };
  policy: {
    enabled: boolean;
    intervalMinutes: number;
    retentionDays: number;
    effectiveIntervalMinutes: number;
    // TASK_168 Bug B — the resolved daily FRAMES budget (dial × 3), served by
    // GET so the deferred copy names the limit that actually binds. Optional:
    // older responses (and tests) predate it and fall back to 24.
    summaryFramesPerDay?: number;
  };
  frames: Array<{
    id: string;
    status: string;
    failureReason: string | null;
    /** null on a FAILED frame — nothing was captured, so there is no time it was
     *  captured at. Fall back to createdAt when labelling those. */
    capturedAt: string | null;
    createdAt: string;
    bytes: number | null;
    // TASK_152 M3 — the SUMMARY axis (mirrors lib/device-screenshots FrameView).
    // A captured frame with summary === null is NORMAL, not an error: it may not
    // be summarised yet, or the owner's AI budget for today ran out. The reason
    // lives in summaryError and is rendered as information, never as a failure.
    summary: string | null;
    summaryError: string | null;
    summaryModel: string | null;
    summarisedAt: string | null;
    /** Set when retention deleted the raw image but KEPT the summary row: there
     *  is text to show and no file to fetch, so the UI must not render an <img>. */
    imagePurgedAt: string | null;
    // TASK_157 — the free local extraction, behind the "Full extraction" toggle.
    // null = never read; "" WITH ocrAt set = read, and the screen had no words.
    ocrText: string | null;
    ocrAt: string | null;
    ocrConfidence: number | null;
  }>;
};

// TASK_114 — the /api/devices/:id/clone-setup read model (mirrors
// lib/clone-setup.ts CloneSetupStatus; ids/paths never reach the UI copy).
type CloneSetupStatus = {
  sourceReady: boolean;
  hostedReady: boolean;
  online: boolean;
  relay: { addr: string; status: string; lastCheckAt: string | null } | null;
  capabilities: string[];
  // TASK_119A: this PC really has the extension + native host, so it can hand
  // over the session it is already using. "Carry my session" stays disabled
  // until this is true — a live clone must never fail after Start.
  liveCaptureReady: boolean;
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
  /** TASK_105 — live place in the governor's queue while this clone waits. */
  queuePosition?: number;
  /** TASK_105 — coarse wait estimate in seconds, paired with queuePosition. */
  queueEtaSeconds?: number;
  /**
   * TASK_135 §6.3 — the profile state carry, as the clone record has it.
   * `stateSyncPending` above 0 means files are still to come; the console says so
   * rather than letting a half-arrived replica look finished.
   */
  stateSyncMode: string | null;
  stateSyncReason: string | null;
  stateSyncPending: number | null;
  stateManifestAt: string | null;
  browserPinError: string | null;
  stateRestoreNote: string | null;
};

/**
 * TASK_135 §6.3 — ONE human line for the state carry, or "" when there is nothing
 * worth saying.
 *
 * The rule: never claim more than the fields support. A pending count is stated in
 * files (the user's mental model is "my history came over", not "delta mode"), a
 * named failure is stated as a failure, and a completed transfer is stated plainly
 * — because "did my tabs come over?" is the only question this line exists to
 * answer, and an optimistic line here is worse than none.
 */
function cloneStateLine(row: Pick<CloneRow, "stateSyncMode" | "stateSyncReason" | "stateSyncPending">): string {
  const pending = row.stateSyncPending ?? 0;
  const failed = row.stateSyncReason && row.stateSyncReason !== "first_clone" && row.stateSyncReason !== "sync_on_reconnect" && row.stateSyncReason !== "cache_baseline";
  if (row.stateSyncMode === null && !failed) return "";
  if (pending > 0) return `Your browser data: ${pending} file${pending === 1 ? "" : "s"} still coming`;
  if (failed) return `Your browser data: not copied (${row.stateSyncReason})`;
  if (row.stateSyncReason === "first_clone") return "Your browser data: copied";
  if (row.stateSyncReason === "sync_on_reconnect") return "Your browser data: up to date";
  if (row.stateSyncReason === "cache_baseline") return "Your browser data: brought up to date";
  return "Your browser data: copied";
}

/**
 * TASK_105 — the honest queue line for a clone that is waiting for a slot.
 * Returns "" when the clone is not waiting (or the governor is off, where
 * queuePosition is absent), so nothing changes for the ordinary path.
 */
function cloneQueueLine(row: Pick<CloneRow, "status" | "queuePosition">): string {
  if (row.status !== "requested") return "";
  if (typeof row.queuePosition !== "number" || row.queuePosition <= 0) return "";
  return `Waiting for a free slot — ${row.queuePosition} ahead of you.`;
}

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

function cloneStepLabel(status: string): string {
  return CLONE_STEP_LABELS[status] ?? "Working on it";
}

// `cloneBrowserLabel` deliberately comes from `@/lib/clone-browsers` — the console's
// own copy is what let Brave be pickable-looking in one place and refused in another.

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
  // TASK_152 M2 — screen monitoring is its own tab (owner: "I want the screen
  // monitoring to be in a separate tab not under summary"). It is the "summary
  // section" (frames + timeline) that TASK_152 Phase B builds on top of, so it
  // gets a top-level tab rather than a card buried on Summary.
  ["monitoring", "Screen monitoring", Eye],
];

// TASK_154 N2 — `relTime`, `statusWord` and the idle chip live in the ONE shared
// client-safe helper (`lib/device-idle.ts`); this file no longer keeps its own
// copies, so the console and the Devices list cannot diverge.

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
  // TASK_154 N2 — the bulk idle read's provenance (N1's additive `idle` field +
  // `onlineWindowMs`), so the shared chip bounds a latched reading against the
  // SERVER's offline window instead of inventing a second one on the client.
  const [idleRead, setIdleRead] = useState<IdleReadProvenance | null>(null);

  // 2026-09-27 — the floating widget's real context for THIS specific device
  // console (not just "you're on a device page"). Only this page's own
  // already-fetched state, same pattern as the devices list page.
  useSetAgentPageContext(
    loaded && device
      ? `Device console for "${device.name}" (${osLabel(device.osName)}): ` +
          idleChipLabel(device, {
            onlineWindowMs: idleRead?.onlineWindowMs ?? undefined,
            readState: idleRead?.state,
            readAsOf: idleRead?.asOf,
          })
      : null,
  );
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

  // TASK_103 NEW-3 — the live remote session must survive a tab switch.
  //
  // Why (owner-reported, verified in the code): the MeshCentral viewer URL
  // carries a ONE-TIME `login=` token. The old conditional render destroyed the
  // iframe on the way to Summary and rebuilt it on the way back, replaying an
  // already-spent token — MeshCentral correctly answered "Unable to perform
  // authentication" for a session that had been working seconds earlier.
  //
  // The fix is in the render below (`ControlTab` is now always mounted and only
  // hidden with CSS) rather than a "mounted once" flag: a flag would need
  // setState inside an effect, and `react-hooks/set-state-in-effect` is right to
  // reject that. Always-mounted costs nothing — ControlTab holds only local UI
  // state and has no on-mount fetch.

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
  // TASK_135 §6.3 — the last "Sync profile state" outcome (manual half). Held here
  // rather than in CloneTab so a tab switch does not erase what the device just
  // said, which is the one moment the operator is reading it.
  const [stateSyncResult, setStateSyncResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [cloneBrowser, setCloneBrowser] = useState<CloneBrowser>("chrome");
  const [cloneProfile, setCloneProfile] = useState("");
  const [cloneEgress, setCloneEgress] = useState<"relay" | "direct">("relay");
  // TASK_119A (owner 2026-09-25): the clone flow the owner asked for — one
  // browser on OUR side, its own profile per clone job. `fresh` starts clean;
  // `live` asks this PC's extension to hand over the session it is already
  // using so the clone opens signed in. `fresh` is the default and unchanged.
  const [cloneSessionMode, setCloneSessionMode] = useState<"fresh" | "live">("fresh");
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

  // TASK_123 (B12) — keep-awake + wake-availability read model.
  const [powerView, setPowerView] = useState<PowerView | null>(null);

  // TASK_152 M2 — the screen-monitoring card's loaded view, published up by the
  // single card instance so Summary can show a one-line state + link WITHOUT
  // fetching again or rendering a second card. The card itself is mounted once,
  // in the tab body below.
  const [screenMon, setScreenMon] = useState<ScreenMonitorView | null>(null);

  const isOnline = device?.status === "online" || device?.status === "asleep";

  const loadDevice = useCallback(async () => {
    try {
      const res = await fetch("/api/devices");
      if (!res.ok) throw new Error("Failed to load device");
      const data = await res.json();
      const row = (data.devices ?? []).find((d: { id: string }) => d.id === deviceId);
      if (!row) throw new Error("Device not found");
      setIdleRead(idleReadProvenanceFrom(data));
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
      const [q, p, a, c, e, s, pw] = await Promise.all([
        fetch(`/api/devices/${deviceId}/queued-commands`),
        fetch(`/api/devices/${deviceId}/pin-requests`),
        fetch(`/api/devices/${deviceId}/activity`),
        // Task 111 — clone history rides the same tick (role=any so a
        // pooled hosted PC also sees what it hosted; `deleted` filtered).
        fetch(`/api/devices/${deviceId}/clones?role=any&limit=50`),
        fetch(`/api/entitlements`),
        // TASK_114 — clone-device setup state (relay row + capabilities).
        fetch(`/api/devices/${deviceId}/clone-setup`),
        // TASK_123 (B12) P5 — wake availability + keep-awake policy.
        fetch(`/api/devices/${deviceId}/power`),
      ]);
      if (q.ok) setQueue((await q.json()).commands ?? []);
      if (p.ok) setPins((await p.json()).requests ?? []);
      if (a.ok) setActivity((await a.json()).actions ?? []);
      if (pw.ok) {
        const data = await pw.json().catch(() => ({}));
        if (data && typeof data === "object" && "wake" in data) {
          setPowerView(data as PowerView);
        }
      }
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

  // Both callees are `useCallback(async () => …)` in which every setState
  // follows an await, so nothing sets state synchronously in this effect body.
  // This is the same false positive as the Devices list (that file carries the
  // full explanation and the three-case probe evidence): the rule flags a
  // DIRECT call to any function that transitively contains setState regardless
  // of an await boundary, and does not flag the identical call made from a
  // timer. Scoped to just this effect; the rule stays armed everywhere else.
  /* eslint-disable react-hooks/set-state-in-effect -- callees await before every setState */
  useEffect(() => {
    loadDevice();
    loadToolData();
  }, [loadDevice, loadToolData]);
  /* eslint-enable react-hooks/set-state-in-effect */

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
            : // TASK_123 D6 — never a generic "sent" message: the real packet
              // count the peer reported, every time.
              `Wake sent — ${typeof data.packetsSent === "number" ? data.packetsSent : 0} packet(s) via a same-network peer.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : `${action} failed`);
    } finally {
      setBusy("");
      void loadToolData();
    }
  }

  // TASK_123 (B12) P4 — Stay on (indefinite) / Stay on for… (timed) / Stop.
  async function runKeepAwake(mode: "indefinite" | "timed" | "off", minutes?: number) {
    const key = `keep-awake-${mode}`;
    setBusy(key);
    setError("");
    setNotice("");
    try {
      const res = await fetch(`/api/devices/${deviceId}/power`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "keep_awake", mode, minutes }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(cleanErr(data.error, "keep-awake failed"));
      setNotice(
        mode === "off"
          ? "Keep-awake stopped — the machine can sleep normally again."
          : mode === "indefinite"
            ? "Keep-awake on — the machine stays on until you press Stop."
            : `Keep-awake on for ${minutes ?? 60} minute(s).`,
      );
      if (data.policy) setPowerView((prev) => (prev ? { ...prev, policy: data.policy } : prev));
    } catch (e) {
      setError(e instanceof Error ? e.message : "keep-awake failed");
    } finally {
      setBusy("");
      void loadToolData();
    }
  }
  // TASK_128 — the Agent-visibility card is prefilled from the onboarding row's
  // `hideLabel`, so a device hidden during quarantine shows the label the stage
  // actually used and the owner edits that ONE tool ("individual can change that
  // when it's in private"). `agentLabelEdit === null` means "untouched → use the
  // stored label"; once the user types, their value wins. Derived during render,
  // so there is no setState-in-effect (which the repo's lint rejects).
  const [agentLabelEdit, setAgentLabelEdit] = useState<string | null>(null);
  const agentLabel = agentLabelEdit ?? device?.onboarding?.hideLabel ?? DEFAULT_AGENT_LABEL;
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

  // TASK_135 §6.3 — the MANUAL half of the state pipe: ask this PC to carry its
  // browser profile's state again, without starting a whole clone. The useful
  // case is the one the automatic sync cannot cover: the replica is stale (new
  // bookmarks, a fresh tab session) and nothing else needs doing, OR a transfer
  // stopped part-way and needs finishing.
  //
  // It is a device action, not a job action, because the cache it fills is keyed
  // by device + browser + profile and survives every clone. The route picks the
  // browser and profile from this device's most recent clone, so the operator
  // does not restate them — and a device with no clone history is told so.
  async function syncProfileState() {
    setCloneBusy("state-sync");
    setCloneError("");
    setCloneNotice("");
    setStateSyncResult(null);
    try {
      const res = await fetch(`/api/devices/${deviceId}/clone-state-sync`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: unknown;
        summary?: unknown;
        reason?: unknown;
        error?: unknown;
      };
      // The route's own summary line is the truth about what moved: it is built
      // from the device's counts, and it says how many files are still to come
      // when a transfer had to stop. Never replaced with an optimistic string.
      const summary =
        typeof data.summary === "string" && data.summary
          ? data.summary
          : typeof data.reason === "string" && data.reason
            ? data.reason
            : res.ok
              ? "Profile state checked."
              : cleanErr(data.error, "Could not sync profile state");
      setStateSyncResult({ ok: res.ok && data.ok === true, text: summary });
      // A partial transfer is NOT an error, but it is not finished either — the
      // notice tells the operator to run it again, which is the whole remedy.
      await loadToolData();
    } catch (e) {
      setStateSyncResult({ ok: false, text: e instanceof Error ? e.message : "Could not sync profile state" });
    } finally {
      setCloneBusy("");
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
          // Defensive: if the setup read model has not said this PC can capture
          // (or is stale), send `fresh` rather than asking for a session we
          // know the device cannot provide.
          sessionMode: cloneSetup?.liveCaptureReady === true ? cloneSessionMode : "fresh",
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
        // TASK_105 — when the governor is on and the request holds a place in
        // line, say exactly where: "Waiting for a free slot — 2 ahead of you."
        const position = typeof data.queuePosition === "number" ? data.queuePosition : 0;
        const why =
          position > 0
            ? `Waiting for a free slot — ${position} ahead of you.`
            : typeof data.message === "string" && data.message
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
        {/* title bar: dots · session name · live status lamp.
            TASK_103 NEW-2 — full-screen shows ONLY the toolbox line + the
            screen, so this chrome is hidden there (owner: "just the one line
            for our tools with it. Apart from that, nothing else should show").
            `hidden`, not a conditional: it holds no session state. */}
        <div
          className={cn(
            "flex items-center justify-between gap-3 border-b border-border bg-black/20 px-4 py-3 dark:bg-black/40",
            fullScreen && "hidden",
          )}
        >
          <div className="flex min-w-0 items-center gap-3">
            <WindowDots />
            <span className="truncate font-mono text-sm font-medium text-fg">
              {loaded ? (device?.name ?? "Unknown machine") : "…"}
            </span>
            {loaded && device && (
              <span className="flex shrink-0 items-center gap-1.5 text-xs">
                <span className={cn("inline-block h-2 w-2 rounded-full", dot)} />
                <span className={isOnline ? "text-emerald-500" : "text-fg-muted"}>
                  {/* TASK_154 N2 — the ONE shared chip. It used to fall back to a
                      bare `statusWord(device.status)` ("online") when idleSeconds
                      was null, which is indistinguishable from "active now" and
                      is exactly the owner's flicker. The helper latches, bounds
                      and never prints a bare status. */}
                  {idleChipLabel(device, {
                    onlineWindowMs: idleRead?.onlineWindowMs ?? undefined,
                    readState: idleRead?.state,
                    readAsOf: idleRead?.asOf,
                  })}
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

        {/* tab strip — TASK_103 NEW-2: hidden in full-screen, where there is
            exactly ONE view (the screen), so a strip would only be a way out. */}
        <div
          className={cn(
            "flex items-center gap-1 overflow-x-auto border-b border-border px-3 py-2",
            fullScreen && "hidden",
          )}
        >
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

        {/* tab body — full-screen drops the padding so the screen itself can
            claim the full viewport height (TASK_103 NEW-1). */}
        <div className={cn("space-y-4 p-4", fullScreen && "space-y-0 p-0")}>
          {!fullScreen && tab === "summary" && (
            <SummaryTab
              device={device}
              loaded={loaded}
              idleRead={idleRead}
              liveClone={liveClone ?? null}
              lastClone={lastClone ?? null}
              clonesLoaded={clonesLoaded}
              cloneBusy={cloneBusy}
              openCloneSession={openCloneSession}
              goToCloneTab={() => setTab("clone")}
              powerView={powerView}
              goToCloneSetup={() => setTab("clone")}
              screenMon={screenMon}
              goToMonitoring={() => setTab("monitoring")}
            />
          )}
          {/* TASK_103 NEW-3 — ALWAYS mounted, never behind a
              `tab === "control" && …`, and hidden with CSS when another tab is
              showing. Tearing it down is what spent the MeshCentral login token
              and broke the session on a tab round trip.
              Visible on Control in embedded mode; in full-screen it is the only
              view that renders at all (NEW-2), whatever `tab` says. */}
          <div className={fullScreen || tab === "control" ? undefined : "hidden"}>
            <ControlTab
              deviceId={deviceId}
              fullScreen={fullScreen}
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
              powerView={powerView}
              runKeepAwake={runKeepAwake}
              goToCommand={() => setTab("command")}
              goToClone={() => setTab("clone")}
              lastSeenAt={device?.lastSeenAt ?? null}
            />
          </div>
          {!fullScreen && tab === "command" && (
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
              setAgentLabel={setAgentLabelEdit}
              runAgentVisibility={runAgentVisibility}
            />
          )}
          {!fullScreen && tab === "clone" && (
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
              sessionMode={cloneSessionMode}
              setSessionMode={setCloneSessionMode}
              premium={isPremium}
              premiumLoaded={premiumLoaded}
              setup={cloneSetup}
              setupBusy={setupBusy}
              setupErr={setupErr}
              setupSteps={setupSteps}
              onSetup={runCloneSetup}
              onStart={startClone}
              onStateSync={syncProfileState}
              stateSync={stateSyncResult}
              onRevoke={revokeClone}
              onDelete={deleteClone}
              onOpen={openCloneSession}
            />
          )}
          {!fullScreen && tab === "activity" && <ActivityTab activity={activity} />}

          {/* TASK_152 M2 — screen monitoring is its own tab. It is ALWAYS
              mounted while the tabbed console is shown and only HIDDEN with CSS,
              exactly like ControlTab above: a tab round-trip never unmounts the
              card, so its local state (an open frame, a half-typed interval
              override) survives and it does not refetch. There is exactly ONE
              instance in the tree — Summary renders a pointer, never a second
              card. Unlike MeshCentral's single-use `login=` token (the TASK_103
              NEW-3 bug ControlTab guards against), the frame route holds no
              one-time token — it re-checks ownership per request and is
              `no-store` — so the risk here is a needless refetch, not a spent
              URL. `onState` publishes the loaded view up for Summary's one-line
              pointer. */}
          {!fullScreen && (
            <div className={tab === "monitoring" ? undefined : "hidden"}>
              <ScreenMonitoringCard deviceId={deviceId} onState={setScreenMon} />
              {/* TASK_152 M5 — the alert configuration for this account lives
                  right under the machinery it watches: user-defined keyword
                  triggers + the periodic digest, each with its own off switch
                  (both default OFF). */}
              <div className="mt-4">
                <ScreenAlertsCard deviceId={deviceId} />
              </div>
            </div>
          )}

          {/* PIN panel — Remote-control scoped ONLY. It must never render under
              the Command tab (owner 2026-09-24: "pin request show under
              command tab, i think thats a leak"). The Command tab keeps its
              own "Queue PIN collect" card for offline scheduling; the live
              request/collect panel lives here, on Remote control.
              TASK_103 NEW-2 also excludes it from full-screen: the owner asked
              for "just the one line for our tools … even the PIN request modal
              shouldn't be in the remote, since it's already in the tools" —
              PIN collect lives in the Security toolbox menu there. */}
          {!fullScreen && tab === "control" && (
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
  idleRead,
  liveClone,
  lastClone,
  clonesLoaded,
  cloneBusy,
  openCloneSession,
  goToCloneTab,
  powerView,
  goToCloneSetup,
  screenMon,
  goToMonitoring,
}: {
  device: DeviceView | null;
  loaded: boolean;
  idleRead: IdleReadProvenance | null;
  liveClone: CloneRow | null;
  lastClone: CloneRow | null;
  clonesLoaded: boolean;
  cloneBusy: string;
  openCloneSession: (cloneId: string) => Promise<void>;
  goToCloneTab: () => void;
  powerView: PowerView | null;
  goToCloneSetup: () => void;
  screenMon: ScreenMonitorView | null;
  goToMonitoring: () => void;
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
            ? idleChipLabel(device, {
                onlineWindowMs: idleRead?.onlineWindowMs ?? undefined,
                readState: idleRead?.state,
                readAsOf: idleRead?.asOf,
              })
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
      {/* TASK_123 (B12) — Wake-on-LAN readiness, always visible on Summary
          (not buried in the Power dropdown menu): what state it's in right
          now, and — critically — WHY when it isn't ready, with the actual
          fix spelled out rather than a vague "unavailable". */}
      <div className="rounded-lg border border-border bg-bg px-3 py-2 sm:col-span-2">
        <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
          <Zap className="h-3.5 w-3.5" /> Wake-on-LAN
        </p>
        {!powerView ? (
          <p className="mt-1 text-sm text-fg-muted">checking…</p>
        ) : powerView.wake.available ? (
          <p className="mt-1 text-sm text-fg">
            Ready — a same-network device is online to relay the wake signal.
          </p>
        ) : powerView.wake.reason === "no_power_mac" ? (
          <>
            <p className="mt-1 text-sm text-fg">
              Not set up yet — this device&apos;s network info was never recorded.
            </p>
            <p className="mt-1 text-xs text-fg-muted">
              Run device setup once (Browser Clone tab → Set up this device) — it records
              this machine&apos;s MAC address and network automatically, as one of its steps.
            </p>
            <button
              onClick={goToCloneSetup}
              className="mt-2 rounded-md border border-border px-2 py-1 text-xs text-fg transition-colors hover:bg-black/10 dark:hover:bg-white/10"
            >
              Go to device setup
            </button>
          </>
        ) : (
          <>
            <p className="mt-1 text-sm text-fg">
              No peer available — nothing on this same network is online to relay the wake
              signal.
            </p>
            <p className="mt-1 text-xs text-fg-muted">
              Waking a sleeping machine needs a magic packet sent from ANOTHER device on the
              exact same local network (the sleeping machine itself can&apos;t receive
              anything over the internet, and a broadcast never crosses networks). Fix: add
              a second Windows PC to this same network, plugged into the same router/switch
              or Wi-Fi, keep it powered on, and run device setup on it too (it becomes an
              eligible relay automatically — no extra step). Until then, use{" "}
              <strong>keep-awake</strong> (Power menu) instead, which needs no peer at all.
            </p>
          </>
        )}
      </div>
      {/* TASK_152 M2 — screen monitoring moved to its OWN tab. Summary keeps
          only a one-line state + link (the full card is mounted exactly once,
          on the monitoring tab): the opt-in state, read from the same single
          card instance above, plus a switch to that tab. The switch that turns
          monitoring on/off for this machine now lives on the monitoring tab. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-bg px-3 py-2 sm:col-span-2">
        <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
          <Eye className="h-3.5 w-3.5" /> Screen monitoring
        </span>
        <span className="text-sm text-fg">
          {screenMon
            ? screenMon.device.optIn
              ? "On for this machine"
              : "Off for this machine"
            : "checking…"}
        </span>
        <button
          onClick={goToMonitoring}
          className="ml-auto rounded-lg border border-border px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
        >
          Open screen monitoring →
        </button>
      </div>
      {/* TASK_128 — the onboarding quarantine, worded from the SAME 4 step
          labels as the Devices strip (no new tooling, no second stop: the
          technician's "till it will say stop" stays the existing Keep awake →
          Stop). Renders nothing for a device that released cleanly, and DOES
          render for a `failed` one — a device that never moved must never look
          like it silently succeeded (owner rule). */}
      {device.onboarding &&
        (!isOnboardingTerminal(device.onboarding.status) ||
          device.onboarding.status === "failed") && <OnboardingCard device={device} />}
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

/**
 * TASK_128 — the console's Summary card for an onboarding device.
 *
 * Reuse only: the four step labels come from `onboardingView` (the same source
 * the Devices strip uses), `Public`/`Private` is the row badge, and nothing here
 * acts on the device — the hide/stay-on stages are the sweep's, and the
 * technician's stop stays the existing Keep-awake Stop.
 */
function OnboardingCard({ device }: { device: DeviceView }) {
  const row = device.onboarding;
  // TASK_128 — the countdown needs a clock, and reading one during render is
  // impure (`react-hooks/purity`). Same 1-minute tick as the Devices strip; it
  // re-renders only this card, and always derives from the server's
  // timerStartedAt so a reload never "jumps the clock back".
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  if (!row) return null;
  const view = onboardingView(
    {
      status: row.status,
      tier: device.tier,
      timerStartedAt: row.timerStartedAt,
      hideDoneAt: row.hideDoneAt,
      stayOnDoneAt: row.stayOnDoneAt,
      releasedAt: row.releasedAt,
      destinationOrgId: row.destinationOrgId,
      isOnline: device.status === "online" || device.status === "asleep",
      lastError: row.lastError,
    },
    nowMs,
  );
  return (
    <div
      className={cn(
        "rounded-lg border bg-bg px-3 py-2 sm:col-span-2",
        // Red = a genuine failure; amber = still waiting, not broken (owner
        // decision 2026-09-27). Keeping them distinct is what lets the owner
        // trust the red.
        view.failed
          ? "border-red-500/40"
          : view.stuck
            ? "border-amber-500/40"
            : "border-border",
      )}
    >
      <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
        <ShieldCheck className="h-3.5 w-3.5" /> Onboarding
      </p>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg">
        <span>{view.step} of 4</span>
        <span className="text-fg-muted">·</span>
        <span className={view.failed ? "text-red-500" : undefined}>
          {view.title.toLowerCase()}
        </span>
        <span className="text-fg-muted">·</span>
        <span className="text-fg-muted">{onboardingClockText(view)}</span>
        {/* Owner 2026-09-27 — same rule as the Devices row badge: only PUBLIC
            is ever named. A private device gets no tier text ("not Public"
            already says private), so the separator is dropped with it rather
            than left dangling. */}
        {device.tier !== "private" && (
          <>
            <span className="text-fg-muted">·</span>
            <span className="text-fg-muted">Public</span>
          </>
        )}
      </p>
      <p className="mt-1 text-xs text-fg-muted">{view.detail}</p>
      {/* The owner's promise: quarantine never takes the device away. */}
      <p className="mt-1 text-xs text-fg-muted">{ONBOARDING_ACCESSIBLE_NOTE}</p>
      {/* Owner decision 2026-09-27 — "much longer than usual" is loud but NOT a
          failure: amber, with the elapsed time and the reason. */}
      {view.stuck && view.stuckReason && (
        <p className="mt-1 text-xs text-amber-500">
          Taking much longer than usual — {formatOnboardingElapsed(view.elapsedMs)} so far.{" "}
          {view.stuckReason}
        </p>
      )}
      {/* §6 — a move that never landed leaves the device Public and the reason
          here, so the process never reads as silently successful. Suppressed
          while stuck because the line above already carries the same reason. */}
      {row.lastError && !view.stuck && (
        <p className="mt-1 text-xs text-amber-500">Last error: {row.lastError}</p>
      )}
    </div>
  );
}

/** TASK_127 Phase 1 — the owner's own switch for screen monitoring, plus the
 * frames it has produced.
 *
 * Self-contained (fetches its own state) because it owns a small piece of state
 * that nothing else on this screen needs, and because the opt-in lives on the
 * DEVICE, not the account: this is the consent boundary, so it is shown on the
 * device's own Summary where the owner is already looking.
 *
 * Deliberately explicit about the two-switch design: an owner who switches this
 * on while the operator has monitoring off must not be left thinking their screen
 * is being photographed when it is not (and vice versa) — so the global state is
 * stated in plain words, read-only. */
function ScreenMonitoringCard({
  deviceId,
  onState,
}: {
  deviceId: string;
  /** TASK_152 M2 — publish the loaded view up so Summary can show a one-line
   *  state + link without a second card instance or a second fetch. */
  onState: (view: ScreenMonitorView) => void;
}) {
  const [view, setView] = useState<ScreenMonitorView | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [openFrame, setOpenFrame] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/devices/${deviceId}/screenshots`);
      if (!res.ok) throw new Error("could not load screen monitoring");
      const data = (await res.json()) as ScreenMonitorView;
      setView(data);
      // TASK_152 M2 — same source that Summary's pointer reads. Called AFTER the
      // await, so it is not a synchronous set-state-in-effect.
      onState(data);
      setErr("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not load screen monitoring");
    }
  }, [deviceId, onState]);

  // Same false positive as the loadDevice/loadToolData effect above — `load`
  // awaits the fetch before either setView or setErr runs.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- setView/setErr are behind the fetch await, not synchronous
    load();
  }, [load]);

  /**
   * TASK_157 — delete one frame permanently.
   *
   * Optimistic removal from local state, then ONE re-read of the list from the
   * server. The re-read is the part that matters: it means the card disappears
   * because the row is actually gone, not because we hid it, so a failed delete
   * cannot leave a "deleted" frame sitting in the timeline looking deleted.
   *
   * We do NOT remove it optimistically-then-revert. The window where a delete has
   * failed but the card is gone is confusing; the DELETE is fast and local.
   */
  async function deleteFrame(frameId: string) {
    // Permanent, with no undo and no recycle bin — so ask first.
    if (!confirm("Delete this frame? The picture and its text are removed for good.")) return;
    setBusy(`delete:${frameId}`);
    try {
      const res = await fetch(`/api/devices/${deviceId}/screenshots/${frameId}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(res.status === 401 ? "please sign in again" : "could not delete that frame");
      }
      // A 404 means it is already gone, which is the outcome the user wanted.
      if (openFrame === frameId) setOpenFrame(null);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not delete that frame");
    } finally {
      setBusy("");
    }
  }

  async function setOptIn(enabled: boolean) {
    setBusy("optin");
    try {
      const res = await fetch(`/api/devices/${deviceId}/screenshots`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error("could not change the setting");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not change the setting");
    } finally {
      setBusy("");
    }
  }

  const [intervalDraft, setIntervalDraft] = useState("");
  const [editingInterval, setEditingInterval] = useState(false);

  async function saveIntervalOverride(value: number | null) {
    setBusy("interval");
    try {
      const res = await fetch(`/api/devices/${deviceId}/screenshots`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intervalMinutesOverride: value }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(typeof data.error === "string" ? data.error : "could not change the schedule");
      }
      setEditingInterval(false);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not change the schedule");
    } finally {
      setBusy("");
    }
  }

  const [captureMsg, setCaptureMsg] = useState("");

  async function captureNow() {
    setBusy("capture");
    setCaptureMsg("");
    try {
      const res = await fetch(`/api/devices/${deviceId}/screenshots/capture`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setCaptureMsg("Captured — see it below.");
      } else if (res.status === 409) {
        setCaptureMsg("This machine is offline right now, so there's nothing to capture.");
      } else if (data.reason === "already_capturing") {
        setCaptureMsg("A capture is already in progress for this machine — try again shortly.");
      } else if (data.reason === "monitoring_disabled") {
        setCaptureMsg("Screen monitoring is switched off service-wide right now.");
      } else if (res.status === 202) {
        setCaptureMsg("Queued — the box is under load, this will run shortly.");
      } else {
        setCaptureMsg(`Capture didn't produce a frame (${data.reason ?? "unknown reason"}).`);
      }
      await load();
    } catch {
      setCaptureMsg("Network error — try again.");
    } finally {
      setBusy("");
    }
  }

  async function forgetAll() {
    setBusy("clear");
    try {
      const res = await fetch(`/api/devices/${deviceId}/screenshots`, { method: "DELETE" });
      if (!res.ok) throw new Error("could not delete the stored frames");
      setOpenFrame(null);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not delete the stored frames");
    } finally {
      setBusy("");
    }
  }

  // A failed frame has no capturedAt (nothing was captured) — label those by when
  // the attempt happened, so the list never shows "Invalid Date".
  const frameAt = (frame: ScreenMonitorView["frames"][number]) =>
    new Date(frame.capturedAt ?? frame.createdAt);

  return (
    <div
      data-screen-monitor-card=""
      className="rounded-lg border border-border bg-bg px-3 py-2 sm:col-span-2"
    >
      <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
        <Monitor className="h-3.5 w-3.5" /> Screen monitoring
      </p>
      {err && <p className="mt-1 text-xs text-red-500">{err}</p>}
      {!view ? (
        <p className="mt-1 text-sm text-fg-muted">checking…</p>
      ) : (
        <>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <p className="text-sm text-fg">
              {view.device.optIn ? "On for this machine" : "Off for this machine"}
            </p>
            <button
              onClick={() => setOptIn(!view.device.optIn)}
              disabled={busy === "optin"}
              className="rounded-md border border-border px-2 py-1 text-xs text-fg transition-colors hover:bg-black/10 disabled:opacity-50 dark:hover:bg-white/10"
            >
              {busy === "optin" ? "Saving…" : view.device.optIn ? "Switch off" : "Switch on"}
            </button>
            {view.device.optIn && view.policy.enabled && (
              <button
                onClick={captureNow}
                disabled={busy === "capture" || view.device.status !== "online"}
                title={view.device.status !== "online" ? "This machine is offline" : undefined}
                className="rounded-md border border-border px-2 py-1 text-xs text-fg transition-colors hover:bg-black/10 disabled:opacity-50 dark:hover:bg-white/10"
              >
                {busy === "capture" ? "Capturing…" : "Capture now"}
              </button>
            )}
            {view.frames.length > 0 && (
              <button
                onClick={forgetAll}
                disabled={busy === "clear"}
                className="rounded-md border border-border px-2 py-1 text-xs text-fg-muted transition-colors hover:bg-black/10 hover:text-fg disabled:opacity-50 dark:hover:bg-white/10"
              >
                {busy === "clear" ? "Deleting…" : "Delete stored frames"}
              </button>
            )}
          </div>
          {captureMsg && <p className="mt-1 text-xs text-fg-muted">{captureMsg}</p>}
          <p className="mt-1 text-xs text-fg-muted">
            {view.device.optIn
              ? view.policy.enabled
                ? `This machine is photographed about every ${view.policy.effectiveIntervalMinutes} minute${
                    view.policy.effectiveIntervalMinutes === 1 ? "" : "s"
                  }${
                    view.device.intervalMinutesOverride !== null ? " (custom for this machine)" : ""
                  } while it is online, and pictures are kept for ${view.policy.retentionDays} day${
                    view.policy.retentionDays === 1 ? "" : "s"
                  }.`
                : "Switched on here, but screen monitoring is currently switched OFF service-wide, so nothing is being captured right now."
              : "Nothing is captured from this machine while this is off."}
          </p>
          {view.device.optIn && (
            <div className="mt-1">
              <div className="flex flex-wrap items-center gap-2">
                {editingInterval ? (
                  <>
                    <input
                      type="number"
                      min={view.policy.intervalMinutes}
                      max={1440}
                      value={intervalDraft}
                      onChange={(e) => setIntervalDraft(e.target.value)}
                      placeholder={String(view.policy.effectiveIntervalMinutes)}
                      className="w-20 rounded-md border border-border bg-bg px-2 py-1 text-xs text-fg"
                    />
                    <span className="text-xs text-fg-muted">minutes for this machine</span>
                    <button
                      onClick={() => {
                        const n = Number(intervalDraft);
                        if (Number.isInteger(n) && n >= view.policy.intervalMinutes && n <= 1440) {
                          void saveIntervalOverride(n);
                        } else {
                          setErr(
                            `Enter a whole number of minutes between ${view.policy.intervalMinutes} ` +
                              `(the service cadence) and 1440.`,
                          );
                        }
                      }}
                      disabled={busy === "interval"}
                      className="rounded-md border border-border px-2 py-1 text-xs text-fg transition-colors hover:bg-black/10 disabled:opacity-50 dark:hover:bg-white/10"
                    >
                      {busy === "interval" ? "Saving…" : "Save"}
                    </button>
                    {view.device.intervalMinutesOverride !== null && (
                      <button
                        onClick={() => void saveIntervalOverride(null)}
                        disabled={busy === "interval"}
                        className="rounded-md border border-border px-2 py-1 text-xs text-fg-muted transition-colors hover:bg-black/10 hover:text-fg disabled:opacity-50 dark:hover:bg-white/10"
                      >
                        Use service cadence
                      </button>
                    )}
                    <button
                      onClick={() => setEditingInterval(false)}
                      className="text-xs text-fg-muted hover:text-fg"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => {
                      setIntervalDraft(String(view.policy.effectiveIntervalMinutes));
                      setEditingInterval(true);
                    }}
                    className="text-xs text-fg-muted underline-offset-2 hover:text-fg hover:underline"
                  >
                    Change how often this machine is captured
                  </button>
                )}
              </div>
              {editingInterval && (
                <p className="mt-1 text-xs text-fg-muted">
                  The service captures at most every {view.policy.intervalMinutes} minute
                  {view.policy.intervalMinutes === 1 ? "" : "s"}. You can make this machine slower,
                  not faster.
                </p>
              )}
            </div>
          )}
          {view.frames.length > 0 && (
            <>
              <div className="mt-2 flex flex-wrap gap-2">
                {view.frames.slice(0, 8).map((frame) => (
                  <button
                    key={frame.id}
                    onClick={() => setOpenFrame(openFrame === frame.id ? null : frame.id)}
                    title={`${frame.status} · ${frameAt(frame).toLocaleString()}${
                      frame.status !== "captured"
                        ? ` · ${captureFailureCopy(frame.failureReason)}`
                        : ""
                    }`}
                    className={`rounded-md border px-2 py-1 text-xs transition-colors ${
                      openFrame === frame.id
                        ? "border-brand-600 text-fg"
                        : "border-border text-fg-muted hover:text-fg"
                    }`}
                  >
                    {frameAt(frame).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    {frame.status !== "captured" ? " ✕" : ""}
                  </button>
                ))}
              </div>
              {openFrame && (
                <div className="mt-2">
                  {/* Served by the frame route, which re-checks ownership on every
                      request — the bytes are never inlined into the page. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/devices/${deviceId}/screenshots/${openFrame}`}
                    alt="A stored screenshot of this device's screen"
                    className="w-full rounded-md border border-border"
                  />
                </div>
              )}
              {/* TASK_152 M3 — the SCROLLABLE timeline. Newest first (the API
                  already returns frames newest-first), each summary sitting
                  beside its own frame, so the owner can recollect the day by
                  READING rather than by opening 24 pictures one at a time. The
                  strip above is unchanged: clicking a time still opens that
                  frame in place, and clicking a thumbnail here does the same.
                  A captured frame with no summary renders a neutral "not
                  summarised" line — never an error; only a real capture failure
                  gets red. The markup lives in components/screen-timeline.tsx so
                  it can be server-rendered (and asserted) on its own. */}
              <p className="mt-3 text-xs font-medium uppercase tracking-wide text-fg-muted">
                Timeline
              </p>
              <ScreenTimeline
                deviceId={deviceId}
                frames={view.frames}
                openFrameId={openFrame}
                onToggleFrame={(id) => setOpenFrame(openFrame === id ? null : id)}
                onDeleteFrame={(id) => void deleteFrame(id)}
                framesPerDay={view.policy.summaryFramesPerDay ?? 24}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}

function CloneTab(props: { clones: CloneRow[]; loaded: boolean; err: string; msg: string; busy: string; browser: CloneBrowser; setBrowser: (b: CloneBrowser) => void; profile: string; setProfile: (v: string) => void; egress: "relay" | "direct"; setEgress: (e: "relay" | "direct") => void; sessionMode: "fresh" | "live"; setSessionMode: (m: "fresh" | "live") => void; premium: boolean; premiumLoaded: boolean; setup: CloneSetupStatus | null; setupBusy: string; setupErr: string; setupSteps: CloneSetupStep[]; onSetup: (role: "source" | "hosted") => Promise<void>; onStart: () => Promise<void>; onStateSync: () => Promise<void>; stateSync: { ok: boolean; text: string } | null; onRevoke: (id: string) => Promise<void>; onDelete: (id: string) => Promise<void>; onOpen: (id: string) => Promise<void> }) {
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
      <CloneStartCard browser={props.browser} setBrowser={props.setBrowser} profile={props.profile} setProfile={props.setProfile} egress={props.egress} setEgress={props.setEgress} sessionMode={props.sessionMode} setSessionMode={props.setSessionMode} premium={props.premium} premiumLoaded={props.premiumLoaded} busy={props.busy} onStart={props.onStart} setup={props.setup} />
      <ProfileStateCard
        busy={props.busy}
        result={props.stateSync}
        onSync={props.onStateSync}
        browser={props.browser}
        profile={props.profile}
        latest={props.clones[0] ?? null}
      />
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

/**
 * TASK_135 §6.3 — "Sync profile state": carry this PC's browser data again.
 *
 * WHY THIS IS ITS OWN CARD. Everything else on this tab is about STARTING a
 * clone. This is about the data a clone will show: history, bookmarks, open tabs,
 * extensions, settings. The automatic sync runs when a clone starts, and this is
 * the other door — for a replica that has gone stale since (new bookmarks, a fresh
 * tab session) and for finishing a transfer that had to stop part-way.
 *
 * WHAT IT TELLS THE OPERATOR, and why each line is here:
 *   - it is SILENT on the PC: no windows, no prompts, nothing to click there,
 *     which is the hard rule this feature is built to;
 *   - nothing can be lost by running it: what the replica already holds is the
 *     comparison, so a second run sends only what is missing;
 *   - which browser and profile it will carry, since the route takes them from
 *     this device's most recent clone and guessing is how the wrong profile ends
 *     up in the replica.
 */
function ProfileStateCard(props: {
  busy: string;
  result: { ok: boolean; text: string } | null;
  onSync: () => Promise<void>;
  browser: CloneBrowser;
  profile: string;
  latest: CloneRow | null;
}) {
  const lastLine = props.latest ? cloneStateLine(props.latest) : "";
  const pending = props.latest?.stateSyncPending ?? 0;
  // Same rule as the server's run-command path, read from the ONE list rather than
  // by name: a browser nothing can be carried from gets the device's own reason in
  // the card, BEFORE the click. The button is disabled, not hidden, so the reason
  // stays visible.
  const carryRefusal = cloneBrowserCarryRefusal(props.browser);
  const unsupported = carryRefusal !== null;
  return (
    <div className="rounded-lg border border-border bg-bg p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">Browser data</p>
      <p className="mt-1 text-sm text-fg">
        History, bookmarks, open tabs, extensions and settings — copied from this PC so your clone opens
        exactly where you left off.
      </p>
      <p className="mt-1 text-xs text-fg-muted">
        Runs silently on this PC: no windows and nothing to click there. Your sign-ins come over separately,
        so a clone still works if this cannot run.
      </p>
      <p className="mt-1 text-xs text-fg-muted">
        Nothing is ever removed by running it again — what your clone already has is what the next copy
        compares against, so a second run only sends what is missing.
      </p>
      {lastLine && <p className="mt-2 text-xs text-fg">{lastLine}</p>}
      {pending > 0 && (
        <p className="mt-1 text-xs text-amber-500">
          {pending} file{pending === 1 ? "" : "s"} still to copy — run this again to finish.
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          onClick={props.onSync}
          disabled={props.busy === "state-sync" || unsupported}
          title={
            unsupported
              ? carryRefusal ?? undefined
              : `Copy ${cloneBrowserLabel(props.browser)}${props.profile ? ` · ${props.profile}` : ""} from this PC`
          }
          className="rounded border border-border px-2.5 py-1 text-xs text-fg-muted transition-colors hover:text-fg disabled:pointer-events-none disabled:opacity-50"
        >
          {props.busy === "state-sync"
            ? "Copying…"
            : props.latest === null
              ? "Copy browser data"
              : "Copy browser data again"}
        </button>
        <span className="text-xs text-fg-muted">
          {cloneBrowserLabel(props.browser)}
          {props.latest?.profileName ? ` · ${props.latest.profileName}` : ""}
          {unsupported ? " · not supported" : ""}
        </span>
      </div>
      {props.result && (
        <p className={cn("mt-2 text-xs", props.result.ok ? "text-emerald-500" : "text-red-500")}>
          {props.result.text}
        </p>
      )}
    </div>
  );
}

function CloneHistoryRow(props: { row: CloneRow; busy: string; onOpen: (id: string) => Promise<void>; onRevoke: (id: string) => Promise<void>; onDelete: (id: string) => Promise<void> }) {
  const { row, busy, onOpen, onRevoke, onDelete } = props;
  const live = isCloneLiveStatus(row.status);
  const terminal = isCloneTerminalStatus(row.status) || row.terminal;
  const queueLine = cloneQueueLine(row);
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
          {queueLine ? `${queueLine} · ` : ""}
          {cloneEgressShort(row.egressMode)} · TTL {formatCountdown(row.ttlRemainingMs)}{errText}
        </span>
        {cloneStateLine(row) && (
          <span className="mt-0.5 block text-xs text-fg-muted">{cloneStateLine(row)}</span>
        )}
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
  const queueLine = cloneQueueLine(row);
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
      {queueLine && (
        <p className="mt-1.5 rounded-lg border border-border bg-bg-elevated px-2 py-1.5 text-xs text-fg">
          {queueLine} It starts on its own — nothing to do.
        </p>
      )}
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
        carries your IP); the copied browser itself runs on{" "}
        <span className="text-fg">SpaceWorker’s hosted PC</span>, never on a customer machine.
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
            : "Makes this PC one of SpaceWorker’s hosted PCs that a cloned browser can run on.",
          hostedReady,
          "Set up as clone host",
          // TASK_116 — "ready" alone was the misleading part of the owner's
          // screenshot. TASK_117 corrects the CAUSE of the confusion: the clone
          // host is SpaceWorker's OWN hosted browser PC (Device.deviceKind
          // "hosted"), never a customer's second machine — so the old line here
          // ("You need one more PC set up as clone host") told the user to
          // provision their own hardware for a service we run.
          status?.selfIsHost && status?.hostedAvailable === false
            ? "Ready — but not for a clone of this same PC: a clone's browser runs on SpaceWorker's hosted PC, never on the machine it captures from."
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

function CloneStartCard(props: { browser: CloneBrowser; setBrowser: (b: CloneBrowser) => void; profile: string; setProfile: (v: string) => void; egress: "relay" | "direct"; setEgress: (e: "relay" | "direct") => void; sessionMode: "fresh" | "live"; setSessionMode: (m: "fresh" | "live") => void; premium: boolean; premiumLoaded: boolean; busy: string; onStart: () => Promise<void>; setup: CloneSetupStatus | null }) {
  const { browser, setBrowser, profile, setProfile, egress, setEgress, sessionMode, setSessionMode, premium, premiumLoaded, busy, onStart, setup } = props;
  // Owner 2026-09-24: "no option to start with egress even when i am on
  // premium". Root cause: `premium` starts false and only flips when
  // /api/entitlements answers — before that the direct button renders
  // disabled+locked, which reads as "no option". Fix: while the account
  // state is still loading, keep BOTH options enabled (the server stays the
  // real gate and 403s direct-without-premium if forced). Once loaded, a
  // non-premium account sees the honest Premium lock.
  const directSelectable = premium || !premiumLoaded;
  // TASK_119A: "Carry my session" is offered ONLY when the server has actually
  // seen the extension + native host on this PC (`liveCaptureReady` is a
  // presence check, not a guess). Otherwise it is disabled with the reason —
  // never a button that fails after Start.
  //
  // AND only for a browser whose session can be carried. Carrying means running the
  // work PC's own browser under CDP to lift its cookies, so a browser with no
  // implementation (Firefox) gets a second, different reason — stated before the
  // click rather than as a refusal after it.
  const carryRefusal = cloneBrowserCarryRefusal(browser);
  const carryable = isCarriableBrowser(browser);
  const extensionReady = setup?.liveCaptureReady === true;
  const liveSelectable = extensionReady && carryable;
  return (
    <div className="rounded-lg border border-border bg-bg p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
        <Globe className="h-3.5 w-3.5" /> Start a clone
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <span className="block text-xs text-fg-muted">
          Browser
          <span className="mt-1 flex overflow-hidden rounded-lg border border-border">
            {CLONE_BROWSERS.map((b) => (
              <button
                key={b}
                onClick={() => {
                  setBrowser(b);
                  // A browser that carries nothing cannot be paired with "Carry my
                  // session", so picking one moves the pair back to `fresh` instead of
                  // leaving the form in a combination the server would refuse. The
                  // server still refuses it (lib/clone.ts) — this is courtesy, not the gate.
                  if (!isCarriableBrowser(b) && sessionMode === "live") setSessionMode("fresh");
                }}
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
      {/* TASK_119A (owner 2026-09-25): this is the clone flow the owner asked
          for — a browser on OUR side, its own profile per clone job, traffic
          leaving from your PC. "Carry my session" hands over the session this
          browser is already using, so the clone opens signed in; "Fresh
          browser" starts clean. Fresh is the default and unchanged. */}
      <div className="mt-2">
        <span className="block text-xs text-fg-muted">
          Session
          <span className="mt-1 flex overflow-hidden rounded-lg border border-border">
            <button
              onClick={() => setSessionMode("fresh")}
              title="A clean browser — you sign in inside the clone"
              className={cn(
                "flex-1 px-2 py-1.5 text-xs transition-colors",
                sessionMode === "fresh" ? "bg-black/10 font-medium text-fg dark:bg-white/10" : "text-fg-muted hover:text-fg",
              )}
            >
              Fresh browser
            </button>
            <button
              onClick={() => liveSelectable && setSessionMode("live")}
              disabled={!liveSelectable}
              title={
                !carryable
                  ? carryRefusal ?? undefined
                  : extensionReady
                    ? "Hands this PC's signed-in session to the clone"
                    : "Needs the browser extension on this PC — use “Set up this PC” in Device setup above"
              }
              className={cn(
                "flex-1 px-2 py-1.5 text-xs transition-colors",
                sessionMode === "live" && liveSelectable ? "bg-black/10 font-medium text-fg dark:bg-white/10" : "text-fg-muted hover:text-fg",
                !liveSelectable && "cursor-not-allowed opacity-60",
              )}
            >
              Carry my session{!carryable ? " · not available" : !extensionReady ? " · setup needed" : ""}
            </button>
          </span>
        </span>
        {!liveSelectable ? (
          <p className="mt-1.5 text-xs text-fg-muted">
            {!carryable ? (
              carryRefusal
            ) : (
              <>
                &ldquo;Carry my session&rdquo; needs the browser extension on this PC. Use &ldquo;Set up
                this PC&rdquo; in Device setup above — it installs silently, and this option appears once
                it is detected.
              </>
            )}
          </p>
        ) : sessionMode === "live" ? (
          <p className="mt-1.5 text-xs text-fg-muted">
            Your PC will send its current session to the clone — the clone waits for it, then opens
            already signed in.
          </p>
        ) : null}
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
                  ALREADY set up — the one PC they owned.
                  TASK_117 (owner 2026-09-24: "i dont understand the sc wilk stuff
                  ... we cant just run test [on wilk]") corrects the CAUSE: the clone
                  host is SpaceWorker's OWN hosted browser PC, not a customer's
                  second machine. So none of these three sentences may instruct the
                  user to set up clone-host hardware — that is a SpaceWorker-side
                  provisioning task. Start stays ENABLED on purpose: this flag can be
                  a false negative (a liveness refresh can fail), and the server is
                  the real gate — it refuses with copy that matches the reason. */}
              {setup.hostBlockReason === "self_only" ? (
                <>
                  <span className="font-medium">This PC is the clone host — but it can’t host itself.</span>{" "}
                  A clone’s browser runs on <span className="font-medium">SpaceWorker’s hosted PC</span>, never
                  on the machine it captures from. Nothing is wrong with this PC — cloning needs a hosted PC on
                  our side, and none is set up yet.
                </>
              ) : setup.hostBlockReason === "offline" ? (
                <>
                  <span className="font-medium">
                    SpaceWorker’s hosted browser PC{setup.offlineHostNames.length === 1 ? " is" : "s are"} offline.
                  </span>{" "}
                  {setup.offlineHostNames.length > 0 && (
                    <>
                      (<span className="font-medium">{setup.offlineHostNames.join(", ")}</span>){" "}
                    </>
                  )}
                  The copied browser runs there, so a clone can’t start until it’s back — try again shortly.
                </>
              ) : (
                <>
                  <span className="font-medium">No hosted browser PC is available yet.</span> A clone’s browser
                  runs on <span className="font-medium">SpaceWorker’s hosted PC</span> — never on your own
                  machine — so this blocks every clone regardless of network. Nothing for you to install: this
                  is provisioned on our side.
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
          {/* TASK_170 — on device-width screens the 14rem panel used to clip off
              the right edge (the toolbox line sits inside an `overflow-hidden`
              session window, and the last menus have no room to their right).
              Same panel, same tools — it just opens right-aligned and admits
              the viewport width instead of overflowing it. Desktop unchanged:
              below sm the alignment classes are no-ops at desktop widths. */}
          <div className="absolute left-0 top-full z-20 mt-1 w-56 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-bg-elevated/70 p-1.5 shadow-xl backdrop-blur-md max-sm:left-auto max-sm:right-0">
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
// TASK_104 §1/§2 (PATH A's routes) — the silent app launcher's client side.
// `key` is the only thing ever sent as a launch target: the server re-resolves
// it against its OWN cached catalog for this device, so a value tampered with
// here cannot become an arbitrary launch. `path` is displayed for
// disambiguation only and is never sent.
type LauncherApp = { key: string; name: string; path: string };

// Mirrors lib/device-tools.ts's two literals (LAUNCH_URL_RE / LAUNCH_PATH_RE)
// so "open this as a URL / as a path" is only ever OFFERED when the server
// would accept it. The server still re-validates — this is UX, not the gate.
function classifyOpenTarget(raw: string): { kind: "url" | "path"; value: string } | null {
  if (/^https:\/\/[a-z0-9.-]+(:[0-9]{1,5})?(\/[a-z0-9\-._~:/?#[\]@!$&'()*+,;=%]*)?$/i.test(raw)) {
    return { kind: "url", value: raw };
  }
  if (/^[A-Za-z]:\\[^"'`$;&|<>(){}[\]\r\n]{1,240}$/.test(raw) && !raw.includes("..")) {
    return { kind: "path", value: raw };
  }
  return null;
}

// The launch route's documented failure codes, in the operator's words. Raw
// codes are still shown for anything unmapped (minus any v tantra_<n>: prefix),
// so a new server-side reason is never swallowed.
function launchErrorText(code: string): string {
  switch (code) {
    case "unknown_launch_target":
      return "That app isn't in this device's list — re-scan and try again.";
    case "bad_target":
      return "That isn't an app, an absolute path, or an https:// link.";
    case "device_not_linked":
      return "This device isn't linked to your account.";
    case "device_offline":
      return "The device is offline — nothing was queued.";
    default:
      return code.replace(/^vantra_\d+:\s*/, "") || "Couldn't open that on the device.";
  }
}
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
  deviceId,
  fullScreen,
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
  powerView,
  runKeepAwake,
  goToCommand,
  goToClone,
  lastSeenAt,
}: {
  deviceId: string;
  fullScreen: boolean;
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
  powerView: PowerView | null;
  runKeepAwake: (mode: "indefinite" | "timed" | "off", minutes?: number) => Promise<void>;
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

  // ---- TASK_104 §1-§3 (PATH A's routes) — the silent app launcher ---------
  // Owner (2026-09-25): "we need a way to pop up apps without clicking the
  // start menu or clicking the logos of the app in desktop ... user can search
  // first and then select the app they want, so we need to find a way to make
  // it dynamic, and it should be in the remote session tools."
  // Search-first, over THIS device's own enumeration — never a hardcoded list.
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [apps, setApps] = useState<LauncherApp[]>([]);
  const [appsLoaded, setAppsLoaded] = useState(false);
  const [appsErr, setAppsErr] = useState("");
  const [discoveredAt, setDiscoveredAt] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [launchBusy, setLaunchBusy] = useState("");
  const [launchMsg, setLaunchMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const launcherInputRef = useRef<HTMLInputElement | null>(null);

  // `refresh` = POST, i.e. re-enumerate on the device now (online required, an
  // offline device fails immediately and queues nothing). Otherwise GET, which
  // returns the cached catalog with no device round trip at all.
  async function loadApps(refresh: boolean) {
    setDiscovering(refresh);
    setAppsErr("");
    try {
      const res = await fetch(`/api/devices/${deviceId}/discover-apps`, {
        method: refresh ? "POST" : "GET",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof data.error === "string" ? data.error : "discover_apps_failed");
      }
      setApps(Array.isArray(data.apps) ? (data.apps as LauncherApp[]) : []);
      setDiscoveredAt(typeof data.discoveredAt === "string" ? data.discoveredAt : null);
    } catch (e) {
      const code = e instanceof Error ? e.message : "";
      setAppsErr(
        code === "device_not_linked"
          ? "This device isn't linked to your account."
          : /offline/i.test(code)
            ? "The device is offline — nothing was queued."
            : "Couldn't read this device's app list.",
      );
    } finally {
      setAppsLoaded(true);
      setDiscovering(false);
    }
  }

  // The only legal launch targets are a `key` from the catalog above, or an
  // absolute path / https URL the operator typed. The server re-validates every
  // one of them before it builds a command — nothing here is trusted.
  async function openTarget(target: string, label: string) {
    if (!target) return;
    setLaunchBusy(label);
    setLaunchMsg(null);
    try {
      const res = await fetch(`/api/devices/${deviceId}/launch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        throw new Error(typeof data.error === "string" ? data.error : "launch_failed");
      }
      setLauncherOpen(false);
      setLaunchMsg({ ok: true, text: `Opening ${label} on the device…` });
    } catch (e) {
      setLaunchMsg({
        ok: false,
        text: launchErrorText(e instanceof Error ? e.message : "launch_failed"),
      });
    } finally {
      setLaunchBusy("");
    }
  }

  const launcherQuery = query.trim().toLowerCase();
  const matches = launcherQuery
    ? apps.filter(
        (a) => a.key.includes(launcherQuery) || a.name.toLowerCase().includes(launcherQuery),
      )
    : apps;
  // Only offered when what was typed is already one of the two shapes the
  // server accepts, so nobody is invited to send something that gets refused.
  const openAs = classifyOpenTarget(query.trim());

  function onPaletteKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      setLauncherOpen(false);
      return;
    }
    const total = matches.length + (openAs ? 1 : 0);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => (total ? (c + 1) % total : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => (total ? (c - 1 + total) % total : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (openAs && cursor === matches.length) {
        void openTarget(openAs.value, openAs.kind === "url" ? "that link" : "that path");
        return;
      }
      const app = matches[cursor] ?? matches[0];
      if (app) void openTarget(app.key, app.name);
    }
  }

  // One Esc handler for both overlays (the toolbox panel and the launcher
  // palette) — either can be the only thing open, and either should close.
  useEffect(() => {
    if (!openMenu && !launcherOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpenMenu(null);
        setLauncherOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openMenu, launcherOpen]);

  return (
    <div className="space-y-4">
      {/* Buttons row. Hidden once a session is LIVE in full-screen mode, where
          the owner asked for exactly two things: the screen and the toolbox
          line. Disconnect is not lost — it lives in the Session menu, which is
          part of that line. Before a session exists it must stay visible: the
          Connect button is the only way to start one here. */}
      <div className={cn("flex flex-wrap items-center gap-2", fullScreen && mesh && "hidden")}>
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
        <div
          className={cn(
            "relative overflow-hidden rounded-lg border border-border",
            // TASK_103 NEW-1 — full-screen: the screen claims the viewport
            // instead of a fixed 480px, and resizes with the window. 3rem is the
            // page's own py-6 (app/console/[deviceId]/page.tsx), which this
            // component cannot change; flex-col lets the iframe take what is
            // left after the toolbox line.
            fullScreen && "flex h-[calc(100vh-3rem)] flex-col",
          )}
        >
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
              {/* TASK_104 §3 — the silent app launcher. Opens a search-first
                  palette (command-palette interaction, not a list to scroll):
                  type to filter this device's OWN installed apps, or paste an
                  absolute path / https:// URL to open that on the device. */}
              <ToolboxItem
                onClick={() => {
                  setOpenMenu(null);
                  setQuery("");
                  setCursor(0);
                  setLaunchMsg(null);
                  setLauncherOpen(true);
                  void loadApps(false);
                }}
                title="Open an app, a file or a link on the device — no Start menu needed"
                icon={<AppWindow className="h-3.5 w-3.5" />}
                label="Launch app…"
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
                disabled={busy === "power-wake" || powerView?.wake.available === false}
                title={
                  powerView?.wake.available === false
                    ? powerView.wake.reason === "no_power_mac"
                      ? "No MAC recorded for this device yet — run device setup again"
                      : "No same-network device is online to relay the wake packet"
                    : "Wake the machine (Wake-on-LAN)"
                }
                icon={<Zap className="h-3.5 w-3.5" />}
                label={busy === "power-wake" ? "Waking…" : "Wake"}
              />
              {powerView?.wake.available === false && (
                <p className="px-2 pb-1 text-[10px] leading-snug text-fg-muted">
                  {powerView.wake.reason === "no_power_mac"
                    ? "Wake unavailable: no MAC on file. Run device setup (Browser Clone tab) to record it."
                    : "Wake unavailable: no other device on this network is online to relay the wake packet. Keep a second PC on this network online, or use keep-awake below."}
                </p>
              )}
              <div className="my-1 border-t border-border" />
              <p className="px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-fg-muted">
                Keep awake
              </p>
              <ToolboxItem
                onClick={() => {
                  setOpenMenu(null);
                  runKeepAwake("indefinite");
                }}
                disabled={busy === "keep-awake-indefinite"}
                title="Prevent this machine from sleeping until you press Stop"
                icon={<Zap className="h-3.5 w-3.5" />}
                label={busy === "keep-awake-indefinite" ? "Applying…" : "Stay on (indefinite)"}
              />
              <div className="px-2 pb-1.5">
                <div className="flex gap-1">
                  {[30, 60, 240].map((m) => (
                    <button
                      key={m}
                      onClick={() => {
                        setOpenMenu(null);
                        runKeepAwake("timed", m);
                      }}
                      disabled={busy === "keep-awake-timed"}
                      title={`Stay on for ${m} minutes`}
                      className="flex-1 rounded-md border border-border px-2 py-1 text-center text-xs text-fg transition-colors hover:bg-black/10 disabled:opacity-50 dark:hover:bg-white/10"
                    >
                      {m}m
                    </button>
                  ))}
                </div>
              </div>
              <ToolboxItem
                onClick={() => {
                  setOpenMenu(null);
                  runKeepAwake("off");
                }}
                disabled={
                  busy === "keep-awake-off" ||
                  !powerView?.policy ||
                  powerView.policy.mode === "off"
                }
                title="Stop keep-awake — the machine can sleep normally again"
                icon={<X className="h-3.5 w-3.5" />}
                label={busy === "keep-awake-off" ? "Stopping…" : "Stop"}
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
            {/* TASK_104 — transient launcher feedback. In the toolbar (not the
                buttons row) so it is visible in full-screen mode too, where the
                buttons row is hidden. */}
            {launchMsg && (
              <span
                className={cn(
                  "ml-auto rounded-full border px-2.5 py-1 font-mono text-[11px]",
                  launchMsg.ok
                    ? "border-emerald-500/40 text-emerald-500"
                    : "border-amber-500/40 text-amber-500",
                )}
                title={launchMsg.text}
              >
                {launchMsg.text}
              </span>
            )}
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
            // Embedded stays a fixed 480px panel on desktop (unchanged);
            // full-screen fills what is left below the toolbox line. `min-h-0`
            // is required for a flex child to be allowed to shrink below its
            // content height — without it the iframe wins the layout and
            // overflows the frame.
            // TASK_170 — on device-width screens the 480px panel forced sideways
            // scrolling and the remote input missed the shrunken viewport. The
            // iframe keeps its desktop size above sm; below it the height falls
            // to a viewport-relative 70dvh (address-bar safe, no fixed-pixel
            // overflow) with touch-action intact for remote input. The
            // height cascade is sm: > base, so desktop pixels don't move.
            className={cn(
              "w-full bg-black [touch-action:auto]",
              fullScreen ? "min-h-0 flex-1" : "h-[70dvh] sm:h-[480px]",
            )}
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

      {/* TASK_104 §3 — the search-first launcher palette. An overlay rather than
          something inside the toolbox dropdown: the owner asked for "user can
          search first and then select the app they want", which is a command
          palette — and the dropdown is only 14rem wide and would have to stay
          open while typing. Nothing here is trusted: the two routes validate
          every target shape before a command is ever built. */}
      {launcherOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1.5rem,env(safe-area-inset-top))] sm:pt-24"
          onClick={() => setLauncherOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Launch an app on the device"
            className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-bg-elevated shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <Search className="h-4 w-4 shrink-0 text-fg-muted" />
              <input
                ref={launcherInputRef}
                autoFocus
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setCursor(0);
                }}
                onKeyDown={onPaletteKey}
                placeholder="Search this device's apps — or paste a path or https:// link"
                className="w-full bg-transparent py-1 text-sm text-fg outline-none placeholder:text-fg-muted"
              />
              {launchBusy && <span className="shrink-0 text-xs text-fg-muted">Opening…</span>}
            </div>

            <div className="max-h-72 overflow-y-auto p-1.5">
              {openAs && (
                <button
                  onClick={() =>
                    void openTarget(
                      openAs.value,
                      openAs.kind === "url" ? "that link" : "that path",
                    )
                  }
                  onMouseEnter={() => setCursor(matches.length)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                    cursor === matches.length ? "bg-black/10 dark:bg-white/10" : "",
                  )}
                >
                  <Globe className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">
                    Open {openAs.kind === "url" ? "link" : "path"}:{" "}
                    <span className="font-mono">{openAs.value}</span>
                  </span>
                </button>
              )}
              {matches.map((a, i) => (
                <button
                  key={a.key}
                  onClick={() => void openTarget(a.key, a.name)}
                  onMouseEnter={() => setCursor(i)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                    cursor === i ? "bg-black/10 dark:bg-white/10" : "",
                  )}
                >
                  <AppWindow className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{a.name}</span>
                  <span className="shrink-0 font-mono text-[10px] text-fg-muted">{a.key}</span>
                </button>
              ))}
              {appsErr && <p className="px-2 py-2 text-xs text-amber-500">{appsErr}</p>}
              {!appsErr && appsLoaded && matches.length === 0 && !openAs && (
                <p className="px-2 py-2 text-xs text-fg-muted">
                  {apps.length === 0
                    ? "No apps discovered on this device yet — press Re-scan device."
                    : "Nothing matches that search."}
                </p>
              )}
              {!appsLoaded && (
                <p className="px-2 py-2 text-xs text-fg-muted">Reading this device…</p>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-1.5">
              <span className="text-[11px] text-fg-muted">
                {appsLoaded
                  ? `${apps.length} app${apps.length === 1 ? "" : "s"} found on this device`
                  : "…"}
                {discoveredAt ? ` · last scan ${relTime(discoveredAt)}` : ""}
              </span>
              <button
                onClick={() => void loadApps(true)}
                disabled={discovering || !isOnline}
                title={!isOnline ? "The machine is offline" : "Enumerate this device's apps again"}
                className="rounded-md border border-border px-2 py-1 text-[11px] text-fg transition-colors hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
              >
                {discovering ? "Scanning…" : "Re-scan device"}
              </button>
            </div>
          </div>
        </div>
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

