"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Globe } from "lucide-react";

type Session = {
  id: string;
  status: string;
  proxyMode: string;
  exitNodeId: string | null;
  byoUser: string | null;
  startedAt: string | null;
  createdAt: string;
  // Carries Neko's ?usr=&pwd= auto-login query params (server-embedded — see
  // lib/browser-session-serialize.ts) so its own login screen never appears.
  connectUrl: string | null;
};

type Profile = {
  id: string;
  name: string;
  status: "idle" | "in_use";
  byoHost: string | null;
  byoPort: number | null;
  byoScheme: string | null;
  byoUser: string | null;
};

type ExitNode = { id: string; city: string; country: string; flag: string };

const STATUS_LABEL: Record<string, string> = {
  starting: "Starting",
  running: "Running",
  stopped: "Stopped",
  failed: "Failed",
};

function statusTone(status: string): string {
  if (status === "running")
    return "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400";
  if (status === "starting")
    return "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400";
  if (status === "failed")
    return "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400";
  return "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
}

export default function BrowserSessionPanel({
  tier,
  exitNodes,
  initialProfiles,
  initialSessions,
}: {
  tier: number;
  exitNodes: ExitNode[];
  initialProfiles: Profile[];
  initialSessions: Session[];
}) {
  const [profiles, setProfiles] = useState<Profile[]>(initialProfiles);
  const [sessions, setSessions] = useState<Session[]>(initialSessions);

  // Default selection is derived once from the initial profiles list (server
  // props, never re-fetched wholesale after mount — only updated in place by
  // saveByo below) — computed directly in the initializer rather than synced
  // via an effect, so there's no "set state during an effect" render cascade.
  const initialPreset = useMemo(
    () =>
      initialProfiles.find((p) => p.status === "idle") ?? initialProfiles[0],
    [initialProfiles]
  );

  const [selectedProfileId, setSelectedProfileId] = useState(
    () => initialPreset?.id ?? ""
  );
  const [proxyMode, setProxyMode] = useState<"free" | "byo">("free");
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState("");

  const [busyId, setBusyId] = useState<string | null>(null);
  const [ipResult, setIpResult] = useState<
    Record<string, { ip?: string; error?: string }>
  >({});
  // Location label is shown by default but can be hidden per-viewer's
  // preference — persisted so it stays hidden across reloads.
  const [showLocation, setShowLocation] = useState(true);
  useEffect(() => {
    try {
      const stored = localStorage.getItem("spaceworker-show-location");
      if (stored !== null) setShowLocation(stored === "true");
    } catch {
      /* localStorage unavailable — default stays visible */
    }
  }, []);
  function toggleShowLocation() {
    setShowLocation((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("spaceworker-show-location", String(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  // First-time users have no profile yet — rather than sending them to a
  // separate Browser Profiles tab before they can do anything, silently
  // create one default profile so the launcher is immediately usable.
  // Initial state is derived from whether the SERVER already saw zero profiles,
  // so the very first paint (before this effect has run) shows "setting up"
  // rather than the unrelated "all profiles busy" message.
  const [creatingDefaultProfile, setCreatingDefaultProfile] = useState(
    () => initialProfiles.length === 0
  );
  const [defaultProfileError, setDefaultProfileError] = useState("");
  const defaultProfileAttemptedRef = useRef(false);
  useEffect(() => {
    if (profiles.length > 0 || defaultProfileAttemptedRef.current) return;
    defaultProfileAttemptedRef.current = true;
    setCreatingDefaultProfile(true);
    fetch("/api/browser-profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "My Browser" }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          setProfiles((prev) => [...prev, data]);
          pickByoProfile(data.id);
          setSelectedProfileId(data.id);
          return;
        }
        // Create can fail on the name-uniqueness constraint if another tab (or
        // React Strict Mode's dev double-invoke) already created it — re-fetch
        // rather than trusting the failure, so the user isn't stuck behind a
        // stale error when a usable profile already exists.
        const list = await fetch("/api/browser-profiles")
          .then((r) => (r.ok ? r.json() : []))
          .catch(() => []);
        if (Array.isArray(list) && list.length > 0) {
          setProfiles(list);
          return;
        }
        setDefaultProfileError(data.error ?? "Couldn't create a browser profile.");
      })
      .catch(() => setDefaultProfileError("Network error while creating a browser profile."))
      .finally(() => setCreatingDefaultProfile(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles.length]);

  const [byoProfileId, setByoProfileId] = useState(
    () => initialPreset?.id ?? ""
  );
  const [byoHost, setByoHost] = useState(() => initialPreset?.byoHost ?? "");
  const [byoPort, setByoPort] = useState(() =>
    initialPreset?.byoPort ? String(initialPreset.byoPort) : ""
  );
  const [byoScheme, setByoScheme] = useState(
    () => initialPreset?.byoScheme ?? "http"
  );
  const [byoUser, setByoUser] = useState(() => initialPreset?.byoUser ?? "");
  const [byoPass, setByoPass] = useState("");
  const [byoSaving, setByoSaving] = useState(false);
  const [byoTesting, setByoTesting] = useState(false);
  const [byoMessage, setByoMessage] = useState("");
  const [byoError, setByoError] = useState("");

  const idleProfiles = useMemo(
    () => profiles.filter((p) => p.status === "idle"),
    [profiles]
  );

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/browser-sessions");
      if (!res.ok) return;
      const data = (await res.json()) as Session[];
      setSessions(data);
    } catch {
      /* transient — ignore, user can refresh */
    }
  }, []);

  const hasActive = sessions.some(
    (s) => s.status === "starting" || s.status === "running"
  );
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [refresh, hasActive]);

  async function start() {
    setStartError("");
    if (!selectedProfileId) {
      setStartError("Choose a profile to launch.");
      return;
    }
    // No exit nodes configured, or none picked — fall through to a direct
    // connection (server's own IP) rather than blocking launch entirely.
    setStarting(true);
    try {
      const res = await fetch("/api/browser-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profileId: selectedProfileId,
          proxyMode,
          exitNodeId: proxyMode === "free" ? selectedNodeId : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStartError(
          typeof data.error === "string" ? data.error : "Failed to start session"
        );
        return;
      }
      await refresh();
      setSelectedProfileId("");
    } catch {
      setStartError("Network error — please try again");
    } finally {
      setStarting(false);
    }
  }

  async function stop(session: Session) {
    setBusyId(session.id);
    try {
      await fetch(`/api/browser-sessions/${session.id}`, { method: "DELETE" });
      await refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function checkIp(sessionId: string) {
    setIpResult((prev) => ({ ...prev, [sessionId]: {} }));
    try {
      const res = await fetch(`/api/browser-sessions/${sessionId}/ip`);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ip) {
        setIpResult((prev) => ({ ...prev, [sessionId]: { ip: data.ip } }));
      } else {
        setIpResult((prev) => ({
          ...prev,
          [sessionId]: {
            error: typeof data.error === "string" ? data.error : "Check failed",
          },
        }));
      }
    } catch {
      setIpResult((prev) => ({ ...prev, [sessionId]: { error: "Network error" } }));
    }
  }

  async function switchLocation(sessionId: string, nodeId: string) {
    setBusyId(sessionId);
    setStartError("");
    try {
      const res = await fetch(`/api/browser-sessions/${sessionId}/switch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exitNodeId: nodeId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStartError(
          typeof data.error === "string"
            ? data.error
            : "Failed to switch location"
        );
        return;
      }
      await Promise.all([refresh(), checkIp(sessionId)]);
    } catch {
      setStartError("Network error — could not switch location");
    } finally {
      setBusyId(null);
    }
  }

  async function testByo() {
    setByoTesting(true);
    setByoError("");
    setByoMessage("");
    try {
      const res = await fetch("/api/browser-sessions/byo-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: byoHost.trim(),
          port: Number(byoPort),
          scheme: byoScheme,
          username: byoUser.trim(),
          password: byoPass,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.ok && data.ip) {
        setByoMessage(`Connected — your IP via this proxy is ${data.ip}.`);
      } else {
        setByoError(
          typeof data.error === "string" ? data.error : "Test-connect failed"
        );
      }
    } catch {
      setByoError("Network error — could not test the proxy");
    } finally {
      setByoTesting(false);
    }
  }

  async function saveByo() {
    setByoSaving(true);
    setByoError("");
    setByoMessage("");
    try {
      const res = await fetch(`/api/browser-profiles/${byoProfileId}/byo-proxy`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: byoHost.trim(),
          port: Number(byoPort),
          scheme: byoScheme,
          username: byoUser.trim(),
          password: byoPass,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setByoError(typeof data.error === "string" ? data.error : "Failed to save");
        return;
      }
      setByoMessage("BYO proxy saved to this profile.");
      setByoPass("");
      setProfiles((prev) =>
        prev.map((p) =>
          p.id === byoProfileId
            ? {
                ...p,
                byoHost: data.byoProxyHost ?? null,
                byoPort: data.byoProxyPort ?? null,
                byoScheme: data.byoProxyScheme ?? null,
                byoUser: data.byoProxyUsername ?? null,
              }
            : p
        )
      );
    } catch {
      setByoError("Network error — could not save");
    } finally {
      setByoSaving(false);
    }
  }

  function pickByoProfile(profileId: string) {
    setByoProfileId(profileId);
    const p = profiles.find((x) => x.id === profileId);
    setByoHost(p?.byoHost ?? "");
    setByoPort(p?.byoPort ? String(p.byoPort) : "");
    setByoScheme(p?.byoScheme ?? "http");
    setByoUser(p?.byoUser ?? "");
    setByoPass("");
    setByoMessage("");
    setByoError("");
  }

  return (
    <div>
      {/* Window chrome (BrowserApp.design.html): title bar + dark frame. */}
      <div className="overflow-hidden rounded-2xl border border-[#29314a] bg-[#0e1320] shadow-[0_40px_90px_-30px_rgba(0,0,0,0.7)]">
        <div className="flex items-center gap-2.5 border-b border-[#1c2333] bg-[#131826] px-4 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-[#3f4759]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#3f4759]" />
          <span className="ml-2 text-[13px] font-semibold text-[#c3c9d6]">
            Browser
          </span>
          <span className="ml-auto hidden text-[11px] text-[#6b7280] sm:inline">
            Saved in the cloud — always on
          </span>
        </div>

        <div className="bg-[radial-gradient(60%_60%_at_50%_22%,rgba(99,102,241,0.09),transparent_60%),#0e1320] p-4 sm:p-6">

      {tier < 1 && (
        <div className="mt-6 max-w-xl rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-300">
          Interactive browser sessions require the Pro plan.
        </div>
      )}

      {tier >= 1 && (
        <>
          {/* --- Session launcher --- */}
          <div className="mx-auto mt-6 max-w-3xl rounded-xl border border-[#252e45] bg-[#0f1420]/80 p-6">
            <div className="text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-[#29314a] bg-[#1c2333]">
                <Globe
                  className="h-7 w-7 text-[#818cf8]"
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
              </div>
              <h2 className="mt-4 text-xl font-bold text-[#f4f5f7]">
                Start your private browser
              </h2>
              <p className="mt-1 text-[13.5px] leading-relaxed text-[#9ca3af]">
                Pick a profile and a location — your Chrome keeps running in
                the cloud even after you close this window.
              </p>
            </div>
            {creatingDefaultProfile ? (
              <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
                Setting up your browser profile…
              </p>
            ) : defaultProfileError ? (
              <p className="mt-3 text-sm text-red-600 dark:text-red-400">
                {defaultProfileError}
              </p>
            ) : idleProfiles.length === 0 ? (
              <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
                All your browser profiles are currently in use by another
                session. Stop one below to free it up, or create another in
                the Browser Profiles tab.
              </p>
            ) : (
              <>
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <label className="flex flex-col gap-1 text-sm font-medium">
                    Profile
                    <select
                      value={selectedProfileId}
                      onChange={(e) => setSelectedProfileId(e.target.value)}
                      className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                    >
                      {idleProfiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                          {p.byoHost ? " (BYO proxy set)" : ""}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="flex flex-col gap-1 text-sm font-medium">
                    Route
                    <select
                      value={proxyMode}
                      onChange={(e) =>
                        setProxyMode(e.target.value === "byo" ? "byo" : "free")
                      }
                      className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                    >
                      <option value="free">Free — SpaceWorker exit node</option>
                      <option value="byo">BYO proxy (this profile)</option>
                    </select>
                  </label>
                </div>

                {proxyMode === "free" && exitNodes.length > 0 && (
                  <label className="mt-4 flex flex-col gap-1 text-sm font-medium">
                    Exit location
                    <select
                      value={selectedNodeId}
                      onChange={(e) => setSelectedNodeId(e.target.value)}
                      className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                    >
                      <option value="">Direct (server IP) — no location filtering</option>
                      {exitNodes.map((n) => (
                        <option key={n.id} value={n.id}>
                          {n.flag} {n.city}, {n.country}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                {proxyMode === "free" && exitNodes.length === 0 && (
                  <p className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">
                    No exit locations configured yet — this session will use a
                    direct connection (the server&apos;s own IP).
                  </p>
                )}

                {proxyMode === "byo" && (
                  <p className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">
                    Uses the BYO proxy saved to the selected profile (below).
                  </p>
                )}

                {startError && (
                  <p className="mt-3 text-sm text-red-600 dark:text-red-400">
                    {startError}
                  </p>
                )}

                <button
                  type="button"
                  onClick={start}
                  disabled={starting}
                  className="mt-5 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
                >
                  {starting ? "Starting…" : "Launch browser"}
                </button>
              </>
            )}
          </div>

          {/* --- Sessions list --- */}
          <div className="mt-8">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Sessions</h2>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={toggleShowLocation}
                  className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                >
                  {showLocation ? "Hide location" : "Show location"}
                </button>
                <button
                  type="button"
                  onClick={refresh}
                  className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                >
                  Refresh
                </button>
              </div>
            </div>

            {sessions.length === 0 ? (
              <div className="mt-4 rounded-xl border border-dashed border-zinc-300 p-10 text-center dark:border-zinc-700">
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  No sessions yet. Launch one above.
                </p>
              </div>
            ) : (
              <div className="mt-4 space-y-4">
                {sessions.map((s) => {
                  const ip = ipResult[s.id];
                  const free =
                    s.proxyMode === "free" &&
                    (s.status === "running" || s.status === "starting");
                  return (
                    <div
                      key={s.id}
                      className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusTone(s.status)}`}
                          >
                            {STATUS_LABEL[s.status] ?? s.status}
                          </span>
                          {showLocation && (
                            <span className="text-sm text-zinc-500 dark:text-zinc-400">
                              {s.proxyMode === "free"
                                ? s.exitNodeId
                                  ? `Free · ${s.exitNodeId.toUpperCase()}`
                                  : "Direct connection"
                                : "BYO proxy"}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {s.status === "running" && (
                            <>
                              <button
                                type="button"
                                onClick={() => checkIp(s.id)}
                                className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                              >
                                Check IP
                              </button>
                              {free && (
                                <select
                                  value={s.exitNodeId ?? ""}
                                  onChange={(e) =>
                                    switchLocation(s.id, e.target.value)
                                  }
                                  disabled={busyId === s.id}
                                  className="rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-xs font-medium outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                                >
                                  <option value="">Switch location…</option>
                                  {exitNodes.map((n) => (
                                    <option key={n.id} value={n.id}>
                                      {n.flag} {n.city}
                                    </option>
                                  ))}
                                </select>
                              )}
                            </>
                          )}
                          {(s.status === "running" || s.status === "starting") && (
                            <button
                              type="button"
                              onClick={() => stop(s)}
                              disabled={busyId === s.id}
                              className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
                            >
                              {busyId === s.id ? "Stopping…" : "Stop"}
                            </button>
                          )}
                          {(s.status === "stopped" || s.status === "failed") && (
                            <button
                              type="button"
                              onClick={() => {
                                if (window.confirm("Remove this session from your history?")) void stop(s);
                              }}
                              disabled={busyId === s.id}
                              className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:bg-black/5 hover:text-red-500 disabled:opacity-50 dark:hover:bg-white/5"
                            >
                              {busyId === s.id ? "Deleting…" : "Delete"}
                            </button>
                          )}
                        </div>
                      </div>

                      {ip?.ip && (
                        <p className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">
                          IP via{" "}
                          {s.proxyMode === "free" ? "exit node" : "BYO proxy"}:{" "}
                          <span className="font-mono">{ip.ip}</span>
                        </p>
                      )}
                      {ip?.error && (
                        <p className="mt-3 text-sm text-red-600 dark:text-red-400">
                          IP check failed: {ip.error}
                        </p>
                      )}

                      {free && (
                        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                          Location: {s.exitNodeId?.toUpperCase() ?? "—"}. Switching
                          drops and restarts the session&apos;s routing.
                        </p>
                      )}

                      {s.status === "running" && s.connectUrl && (
                        <>
                          <div className="mt-3 flex justify-end">
                            <button
                              type="button"
                              onClick={() =>
                                window.open(s.connectUrl!, "_blank", "noopener,noreferrer")
                              }
                              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                            >
                              Open in new tab ↗
                            </button>
                          </div>
                          <div className="mt-2 aspect-video w-full overflow-hidden rounded-lg border border-zinc-200 bg-black dark:border-zinc-800">
                            <iframe
                              src={s.connectUrl}
                              title="Private browser session"
                              allow="clipboard-read; clipboard-write; autoplay; fullscreen"
                              className="h-full w-full border-0"
                            />
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
{/* --- BYO proxy form --- */}
          {profiles.length > 0 && (
            <div className="mt-8 max-w-3xl rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="text-base font-semibold">
                Bring-your-own proxy (optional)
              </h2>
              <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                Route a profile&apos;s sessions through your own proxy/VPN
                credentials. Test-connect before use — a faulty route is caught
                here, not silently trusted in-session.
              </p>

              <label className="mt-4 flex flex-col gap-1 text-sm font-medium">
                Profile
                <select
                  value={byoProfileId}
                  onChange={(e) => pickByoProfile(e.target.value)}
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                >
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>

              <div className="mt-4 grid gap-4 sm:grid-cols-3">
                <label className="flex flex-col gap-1 text-sm font-medium">
                  Host
                  <input
                    type="text"
                    value={byoHost}
                    onChange={(e) => setByoHost(e.target.value)}
                    placeholder="proxy.example.com"
                    className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm font-medium">
                  Port
                  <input
                    type="number"
                    value={byoPort}
                    onChange={(e) => setByoPort(e.target.value)}
                    placeholder="3128"
                    className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm font-medium">
                  Protocol
                  <select
                    value={byoScheme}
                    onChange={(e) => setByoScheme(e.target.value)}
                    className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                  >
                    <option value="http">HTTP</option>
                    <option value="https">HTTPS</option>
                    <option value="socks5">SOCKS5</option>
                    <option value="socks5h">SOCKS5h</option>
                  </select>
                </label>
              </div>

              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-sm font-medium">
                  Username (optional)
                  <input
                    type="text"
                    value={byoUser}
                    onChange={(e) => setByoUser(e.target.value)}
                    autoComplete="off"
                    className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm font-medium">
                  Password
                  <input
                    type="password"
                    value={byoPass}
                    onChange={(e) => setByoPass(e.target.value)}
                    placeholder="Leave blank to keep current"
                    autoComplete="new-password"
                    className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                  />
                </label>
              </div>

              {byoMessage && (
                <p className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">
                  {byoMessage}
                </p>
              )}
              {byoError && (
                <p className="mt-3 text-sm text-red-600 dark:text-red-400">
                  {byoError}
                </p>
              )}

              <div className="mt-5 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={saveByo}
                  disabled={byoSaving || !byoProfileId}
                  className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
                >
                  {byoSaving ? "Saving…" : "Save proxy"}
                </button>
                <button
                  type="button"
                  onClick={testByo}
                  disabled={byoTesting || !byoProfileId}
                  className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                >
                  {byoTesting ? "Testing…" : "Test connect"}
                </button>
              </div>
            </div>
          )}
        </>
      )}
        </div>
      </div>
    </div>
  );
}
