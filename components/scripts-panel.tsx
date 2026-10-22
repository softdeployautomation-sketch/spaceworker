"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarClock,
  CheckCircle2,
  Clock,
  FileCode2,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  XCircle,
  Zap,
} from "lucide-react";

import { useConfirm } from "@/components/confirm-provider";
import { cn } from "@/lib/cn";

// 2026-10-22 — saved device scripts. A script is ONE command body; the server
// dispatches it through Vantra's /action, so the same script runs on a public
// (Everwas) device and a private (TRMM) device without the UI choosing a
// transport. Three ways to fire it: Run now (one or many devices), Schedule
// (date/time), or Auto (N minutes after a public device enrolls).

interface ScriptRow {
  id: string;
  name: string;
  description: string | null;
  shell: string;
  body: string;
  timeoutSeconds: number;
  autoRules: { id: string; enabled: boolean; delayMinutes: number; targetTier: string }[];
}

interface DeviceRow {
  id: string;
  name: string;
  tier: string;
  status: string;
  effectiveStatus: string;
}

interface RunRow {
  id: string;
  deviceId: string;
  trigger: string;
  status: string;
  scheduledFor: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  output: string | null;
  error: string | null;
  createdAt: string;
  device?: { name: string };
}

const EMPTY_FORM = {
  name: "",
  description: "",
  shell: "powershell",
  body: "",
  timeoutSeconds: 90,
};

const RUN_STATUS_STYLE: Record<string, string> = {
  queued: "bg-amber-500/10 text-amber-500",
  running: "bg-sky-500/10 text-sky-500",
  succeeded: "bg-emerald-500/10 text-emerald-500",
  failed: "bg-red-500/10 text-red-500",
  skipped: "bg-bg-subtle text-fg-muted",
  cancelled: "bg-bg-subtle text-fg-muted",
};

function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export function ScriptsPanel() {
  const confirm = useConfirm();
  const [scripts, setScripts] = useState<ScriptRow[]>([]);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [editingId, setEditingId] = useState<string | null>(null);

  const [picked, setPicked] = useState<string[]>([]);
  const [scheduledFor, setScheduledFor] = useState("");
  // The auto inputs start from the saved rule and hold the user's edit until
  // they pick another script. Deliberately NOT an effect: the repo's React
  // rules forbid setState in an effect body, and deriving the value is cheaper.
  const [autoEdit, setAutoEdit] = useState<{ delay: number; tier: string } | null>(null);

  const selected = useMemo(
    () => scripts.find((s) => s.id === selectedId) ?? null,
    [scripts, selectedId],
  );
  const rule = selected?.autoRules?.[0] ?? null;
  const autoDelay = autoEdit?.delay ?? rule?.delayMinutes ?? 10;
  const autoTier = autoEdit?.tier ?? rule?.targetTier ?? "public";

  const selectScript = useCallback(
    (id: string) => {
      setSelectedId(id);
      setPicked([]);
      setScheduledFor("");
      setAutoEdit(null);
    },
    [],
  );

  const loadScripts = useCallback(async () => {
    const res = await fetch("/api/scripts", { cache: "no-store" });
    if (!res.ok) throw new Error("Could not load scripts");
    const data = (await res.json()) as { scripts: ScriptRow[] };
    setScripts(data.scripts);
    setSelectedId((cur) => cur ?? data.scripts[0]?.id ?? null);
  }, []);

  const loadRuns = useCallback(async (scriptId: string) => {
    const res = await fetch(`/api/scripts/${scriptId}/runs?limit=25`, { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { runs: RunRow[] };
    setRuns(data.runs);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [devRes] = await Promise.all([
          fetch("/api/devices", { cache: "no-store" }),
          loadScripts(),
        ]);
        if (devRes.ok) {
          const data = (await devRes.json()) as { devices: DeviceRow[] };
          setDevices(data.devices.filter((d) => d.status !== "removed"));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Load failed");
      } finally {
        setLoading(false);
      }
    })();
  }, [loadScripts]);

  useEffect(() => {
    if (!selectedId) return;
    // Deferred so the fetch's setState lands in a callback, not in the effect
    // body (react-hooks/set-state-in-effect).
    const t = setTimeout(() => {
      loadRuns(selectedId).catch(() => undefined);
    }, 0);
    return () => clearTimeout(t);
  }, [selectedId, loadRuns]);

  // While anything in the history is still moving, refresh it — runs execute
  // server-side, so polling is the honest progress signal.
  useEffect(() => {
    if (!selectedId) return;
    if (!runs.some((r) => r.status === "queued" || r.status === "running")) return;
    const t = setTimeout(() => loadRuns(selectedId).catch(() => undefined), 4000);
    return () => clearTimeout(t);
  }, [runs, selectedId, loadRuns]);

  const startNew = () => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM });
  };

  const startEdit = (s: ScriptRow) => {
    setEditingId(s.id);
    setForm({
      name: s.name,
      description: s.description ?? "",
      shell: s.shell,
      body: s.body,
      timeoutSeconds: s.timeoutSeconds,
    });
  };

  async function saveScript() {
    setBusy("save");
    setError(null);
    try {
      const res = await fetch(editingId ? `/api/scripts/${editingId}` : "/api/scripts", {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = (await res.json()) as { script?: ScriptRow; error?: string };
      if (!res.ok || !data.script) throw new Error(data.error ?? "Save failed");
      await loadScripts();
      selectScript(data.script.id);
      startNew();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(null);
    }
  }

  async function deleteScript(s: ScriptRow) {
    const ok = await confirm({
      title: `Delete “${s.name}”?`,
      description: "The script is archived. Its run history stays visible.",
      confirmLabel: "Delete script",
    });
    if (!ok) return;
    setBusy("delete");
    try {
      const res = await fetch(`/api/scripts/${s.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      if (selectedId === s.id) {
        setSelectedId(null);
        setRuns([]);
      }
      await loadScripts();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setBusy(null);
    }
  }

  async function dispatchRun(s: ScriptRow) {
    if (!picked.length) {
      setError("Pick at least one device.");
      return;
    }
    setBusy("run");
    setError(null);
    try {
      const res = await fetch(`/api/scripts/${s.id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceIds: picked,
          scheduledFor: scheduledFor || null,
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Run failed");
      await loadRuns(s.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Run failed");
    } finally {
      setBusy(null);
    }
  }

  async function saveAuto(s: ScriptRow, enabled: boolean) {
    setBusy("auto");
    setError(null);
    try {
      const res = await fetch(`/api/scripts/${s.id}/auto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, delayMinutes: autoDelay, targetTier: autoTier }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not save the auto-run rule");
      await loadScripts();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the auto-run rule");
    } finally {
      setBusy(null);
    }
  }

  const togglePick = (id: string) =>
    setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-fg-muted">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading scripts…
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-fg">Scripts</h1>
          <p className="mt-1 text-sm text-fg-muted">
            Run a command on one device or many — public (Everwas) and private (TRMM) devices both
            work. Schedule it, or run it automatically after a public device enrolls.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={startNew}
            className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-fg transition-colors hover:bg-bg-subtle"
          >
            <Plus className="h-4 w-4" /> New script
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">
          {error}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
        {/* ------------------------------------------------ script list */}
        <div className="space-y-2">
          {scripts.length === 0 && (
            <div className="rounded-xl border border-border bg-bg-elevated p-4 text-sm text-fg-muted">
              No scripts yet. Create one on the right.
            </div>
          )}
          {scripts.map((s) => (
            <button
              key={s.id}
              onClick={() => selectScript(s.id)}
              className={cn(
                "w-full rounded-xl border px-4 py-3 text-left transition-colors",
                s.id === selectedId
                  ? "border-brand-600/60 bg-brand-600/5"
                  : "border-border bg-bg-elevated hover:bg-bg-subtle",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-fg">
                  <FileCode2 className="h-4 w-4 shrink-0 text-fg-muted" />
                  <span className="truncate">{s.name}</span>
                </span>
                {s.autoRules?.some((r) => r.enabled) && (
                  <span className="flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-500">
                    <Zap className="h-3 w-3" /> Auto
                  </span>
                )}
              </div>
              <div className="mt-1 flex items-center gap-2 text-[11px] text-fg-muted">
                <span className="rounded bg-bg-subtle px-1.5 py-0.5 uppercase">{s.shell}</span>
                <span>{s.timeoutSeconds}s timeout</span>
              </div>
            </button>
          ))}
        </div>

        {/* --------------------------------------- editor / selected detail */}
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-bg-elevated">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <span className="flex items-center gap-2 text-sm font-medium text-fg">
                <FileCode2 className="h-4 w-4" />
                {editingId ? "Edit script" : "New script"}
              </span>
              {editingId && (
                <button
                  onClick={startNew}
                  className="text-xs text-fg-muted transition-colors hover:text-fg"
                >
                  cancel edit
                </button>
              )}
            </div>
            <div className="space-y-3 px-4 py-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-xs font-medium text-fg-muted">
                  Name
                  <input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="Rotate logs"
                    className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg"
                  />
                </label>
                <label className="block text-xs font-medium text-fg-muted">
                  Shell
                  <select
                    value={form.shell}
                    onChange={(e) => setForm({ ...form, shell: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg"
                  >
                    <option value="powershell">PowerShell</option>
                    <option value="cmd">cmd</option>
                  </select>
                </label>
              </div>
              <label className="block text-xs font-medium text-fg-muted">
                Description (optional)
                <input
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg"
                />
              </label>
              <label className="block text-xs font-medium text-fg-muted">
                Command
                <textarea
                  value={form.body}
                  onChange={(e) => setForm({ ...form, body: e.target.value })}
                  rows={8}
                  spellCheck={false}
                  placeholder="Get-Service | Where-Object Status -eq 'Stopped'"
                  className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 font-mono text-xs text-fg"
                />
              </label>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <label className="block text-xs font-medium text-fg-muted">
                  Timeout (seconds, max 90)
                  <input
                    type="number"
                    min={1}
                    max={90}
                    value={form.timeoutSeconds}
                    onChange={(e) =>
                      setForm({ ...form, timeoutSeconds: Number(e.target.value) || 90 })
                    }
                    className="mt-1 w-28 rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg"
                  />
                </label>
                <button
                  onClick={saveScript}
                  disabled={busy === "save" || !form.name.trim() || !form.body.trim()}
                  className="flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700 disabled:opacity-60"
                >
                  {busy === "save" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  {editingId ? "Save changes" : "Create script"}
                </button>
              </div>
            </div>
          </div>

          {selected && (
            <>
              {/* ------------------------------------------------ run */}
              <div className="rounded-xl border border-border bg-bg-elevated">
                <div className="flex items-center justify-between border-b border-border px-4 py-3">
                  <span className="flex items-center gap-2 text-sm font-medium text-fg">
                    <Play className="h-4 w-4" /> Run “{selected.name}”
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => startEdit(selected)}
                      className="text-xs text-fg-muted transition-colors hover:text-fg"
                    >
                      edit
                    </button>
                    <button
                      onClick={() => deleteScript(selected)}
                      disabled={busy === "delete"}
                      className="text-xs text-fg-muted transition-colors hover:text-red-500"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                <div className="space-y-3 px-4 py-4">
                  <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-border bg-bg p-2">
                    {devices.length === 0 && (
                      <p className="px-2 py-1 text-xs text-fg-muted">No devices yet.</p>
                    )}
                    {devices.map((d) => {
                      const online = d.effectiveStatus === "online" || d.status === "online";
                      return (
                        <label
                          key={d.id}
                          className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-bg-subtle"
                        >
                          <input
                            type="checkbox"
                            checked={picked.includes(d.id)}
                            onChange={() => togglePick(d.id)}
                            className="h-4 w-4 accent-brand-600"
                          />
                          <span className="flex-1 truncate text-fg">{d.name}</span>
                          <span
                            className={cn(
                              "rounded-full px-2 py-0.5 text-[10px] font-medium",
                              d.tier === "public"
                                ? "bg-sky-500/10 text-sky-500"
                                : "bg-violet-500/10 text-violet-500",
                            )}
                          >
                            {d.tier}
                          </span>
                          <span
                            className={cn(
                              "text-[10px]",
                              online ? "text-emerald-500" : "text-fg-muted",
                            )}
                          >
                            {online ? "online" : d.status}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="block text-xs font-medium text-fg-muted">
                      Run at (optional)
                      <input
                        type="datetime-local"
                        value={scheduledFor}
                        onChange={(e) => setScheduledFor(e.target.value)}
                        className="mt-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg"
                      />
                    </label>
                    <button
                      onClick={() => dispatchRun(selected)}
                      disabled={busy === "run" || !picked.length}
                      className="flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700 disabled:opacity-60"
                    >
                      {busy === "run" ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : scheduledFor ? (
                        <CalendarClock className="h-4 w-4" />
                      ) : (
                        <Play className="h-4 w-4" />
                      )}
                      {scheduledFor ? "Schedule" : "Run now"}
                    </button>
                    <span className="text-xs text-fg-muted">
                      {picked.length ? `${picked.length} device(s) selected` : "pick devices"}
                    </span>
                  </div>
                </div>
              </div>

              {/* ------------------------------------------------ auto rule */}
              <div className="rounded-xl border border-border bg-bg-elevated">
                <div className="flex items-center justify-between border-b border-border px-4 py-3">
                  <span className="flex items-center gap-2 text-sm font-medium text-fg">
                    <Zap className="h-4 w-4" /> Auto-run after enrollment
                  </span>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[11px] font-medium",
                      rule?.enabled
                        ? "bg-emerald-500/10 text-emerald-500"
                        : "bg-bg-subtle text-fg-muted",
                    )}
                  >
                    {rule?.enabled ? "active" : "off"}
                  </span>
                </div>
                <div className="space-y-3 px-4 py-4">
                  <p className="text-xs text-fg-muted">
                    Runs this script automatically for every device that enrolls AFTER you save
                    this rule. Existing devices are not touched.
                  </p>
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="block text-xs font-medium text-fg-muted">
                      Wait
                      <input
                        type="number"
                        min={0}
                        value={autoDelay}
                        onChange={(e) =>
                          setAutoEdit({
                            delay: Math.max(0, Number(e.target.value) || 0),
                            tier: autoTier,
                          })
                        }
                        className="mt-1 w-24 rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg"
                      />
                    </label>
                    <span className="pb-2 text-xs text-fg-muted">minutes after the device appears</span>
                    <label className="block text-xs font-medium text-fg-muted">
                      Devices
                      <select
                        value={autoTier}
                        onChange={(e) =>
                          setAutoEdit({ delay: autoDelay, tier: e.target.value })
                        }
                        className="mt-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg"
                      >
                        <option value="public">Public only</option>
                        <option value="any">Public and private</option>
                      </select>
                    </label>
                    <button
                      onClick={() => saveAuto(selected, !(rule?.enabled ?? false))}
                      disabled={busy === "auto"}
                      className="flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-fg transition-colors hover:bg-bg-subtle disabled:opacity-60"
                    >
                      {busy === "auto" ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Zap className="h-4 w-4" />
                      )}
                      {rule?.enabled ? "Turn off" : "Turn on"}
                    </button>
                  </div>
                </div>
              </div>

              {/* ------------------------------------------------ history */}
              <div className="rounded-xl border border-border bg-bg-elevated">
                <div className="flex items-center justify-between border-b border-border px-4 py-3">
                  <span className="flex items-center gap-2 text-sm font-medium text-fg">
                    <Clock className="h-4 w-4" /> Run history
                  </span>
                  <button
                    onClick={() => loadRuns(selected.id).catch(() => undefined)}
                    className="text-fg-muted transition-colors hover:text-fg"
                    aria-label="Refresh runs"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="divide-y divide-border">
                  {runs.length === 0 && (
                    <p className="px-4 py-4 text-sm text-fg-muted">No runs yet.</p>
                  )}
                  {runs.map((r) => (
                    <details key={r.id} className="group px-4 py-3">
                      <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
                        <span
                          className={cn(
                            "flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
                            RUN_STATUS_STYLE[r.status] ?? "bg-bg-subtle text-fg-muted",
                          )}
                        >
                          {r.status === "succeeded" ? (
                            <CheckCircle2 className="h-3 w-3" />
                          ) : r.status === "failed" ? (
                            <XCircle className="h-3 w-3" />
                          ) : null}
                          {r.status}
                        </span>
                        <span className="font-medium text-fg">{r.device?.name ?? r.deviceId}</span>
                        <span className="text-xs text-fg-muted">
                          {r.trigger.replace("_", " ")} ·{" "}
                          {r.scheduledFor && r.status === "queued"
                            ? `scheduled ${when(r.scheduledFor)}`
                            : when(r.finishedAt ?? r.startedAt ?? r.createdAt)}
                        </span>
                        {typeof r.exitCode === "number" && (
                          <span className="text-xs text-fg-muted">exit {r.exitCode}</span>
                        )}
                      </summary>
                      <div className="mt-2 space-y-2">
                        {r.error && (
                          <p className="rounded bg-red-500/10 px-2 py-1 text-xs text-red-500">
                            {r.error}
                          </p>
                        )}
                        <pre className="max-h-64 overflow-auto rounded-lg border border-border bg-bg p-2 font-mono text-[11px] text-fg">
                          {r.output?.trim() || "(no output)"}
                        </pre>
                      </div>
                    </details>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
