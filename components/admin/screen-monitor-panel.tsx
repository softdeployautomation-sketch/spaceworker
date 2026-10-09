"use client";

import { useCallback, useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// TASK_190 S2 — the per-device Screen monitor panel the Actions dropdown opens.
//
// GET on mount (the route is admin-session + deep-404 guarded server-side),
// then two independent one-key PATCHes: Monitoring flips
// `Device.screenshotMonitoringEnabled`, Notify-admin flips
// `Device.adminNotifyEnabled` — never the owner's trigger/digest switches
// (the route's lib helper builds its update from the passed keys only).
//
// Copy rule that matters (DeviceScreenshot model comment + PROMPT_VERIFY §1.4):
// a captured frame with NO summary is NORMAL — "no summary yet" is rendered
// as neutral information, never as an error. An actual summariser error is
// reported as a fact in zinc, not in red alarm styling.
// ---------------------------------------------------------------------------

type MonitorFrame = {
  capturedAt: string | null;
  summary: string | null;
  summaryError: string | null;
  summarisedAt: string | null;
  imagePurgedAt: string | null;
};

type MonitorDto = {
  device: { id: string; name: string; ownerEmail: string };
  enabled: boolean;
  adminNotifyEnabled: boolean;
  tier: string;
  intervalMinutesOverride: number | null;
  wakeDelayMinutes: number | null;
  captureIntervalMinutes: number;
  retentionDays: number;
  latestFrame: MonitorFrame | null;
};

function Toggle({
  on,
  busy,
  onToggle,
  label,
}: {
  on: boolean;
  busy: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={busy}
      onClick={onToggle}
      className={`rounded-lg border px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
        on
          ? "border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700"
          : "border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
      }`}
    >
      {on ? "On" : "Off"}
    </button>
  );
}

function formatWhen(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleString();
}

export function ScreenMonitorPanel({
  deviceId,
  onClose,
}: {
  deviceId: string;
  onClose: () => void;
}) {
  const [monitor, setMonitor] = useState<MonitorDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // setState only ever runs AFTER the await — never synchronously in the
  // effect body (the set-state-in-effect lint rule).
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/admin/devices/${deviceId}/screen-monitor`);
        const data = await res.json().catch(() => ({}));
        if (!live) return;
        if (!res.ok || !data.device) {
          setError(typeof data.error === "string" ? data.error : "Could not load this panel");
        } else {
          setMonitor(data as MonitorDto);
        }
      } catch {
        if (live) setError("Network error");
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [deviceId]);

  const flip = useCallback(
    async (next: { enabled?: boolean; adminNotifyEnabled?: boolean }) => {
      setBusy(true);
      setError("");
      try {
        const res = await fetch(`/api/admin/devices/${deviceId}/screen-monitor`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(next),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Update failed");
        setMonitor((prev) =>
          prev
            ? { ...prev, enabled: data.enabled, adminNotifyEnabled: data.adminNotifyEnabled }
            : prev,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "Network error");
      } finally {
        setBusy(false);
      }
    },
    [deviceId],
  );

  const cadence =
    monitor === null
      ? ""
      : monitor.intervalMinutesOverride !== null
        ? `every ${monitor.intervalMinutesOverride} min (device override; global default ${monitor.captureIntervalMinutes} min)`
        : `every ${monitor.captureIntervalMinutes} min (global)`;

  const frame = monitor?.latestFrame ?? null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
            Screen monitor
          </div>
          <div className="font-medium">{monitor?.device.name ?? deviceId}</div>
          {monitor && (
            <div className="text-zinc-500 text-xs dark:text-zinc-400">
              {monitor.device.ownerEmail} · {monitor.tier}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Close
        </button>
      </div>

      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

      {monitor === null ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {loading ? "Loading screen monitor…" : "This panel could not be loaded."}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-xs sm:grid-cols-4">
            <div>
              <div className="uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                Monitoring
              </div>
              <div className="mt-1 flex items-center gap-2">
                <Toggle
                  on={monitor.enabled}
                  busy={busy}
                  onToggle={() => void flip({ enabled: !monitor.enabled })}
                  label="Toggle screenshot monitoring for this device"
                />
                <span className="text-zinc-500 dark:text-zinc-400">
                  {monitor.enabled ? "capturing" : "off"}
                </span>
              </div>
            </div>
            <div>
              <div className="uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                Cadence
              </div>
              <div className="text-zinc-700 mt-1 dark:text-zinc-300">{cadence}</div>
              {monitor.wakeDelayMinutes !== null && (
                <div className="text-zinc-400 dark:text-zinc-500">
                  wake delay {monitor.wakeDelayMinutes} min
                </div>
              )}
            </div>
            <div>
              <div className="uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                Retention
              </div>
              <div className="text-zinc-700 mt-1 dark:text-zinc-300">
                {monitor.retentionDays} days (global)
              </div>
            </div>
            <div>
              <div className="uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                Notify admin
              </div>
              <div className="mt-1 flex items-center gap-2">
                <Toggle
                  on={monitor.adminNotifyEnabled}
                  busy={busy}
                  onToggle={() => void flip({ adminNotifyEnabled: !monitor.adminNotifyEnabled })}
                  label="Toggle admin notifications for this device"
                />
                <span className="text-zinc-500 dark:text-zinc-400">
                  {monitor.adminNotifyEnabled ? "on" : "off"}
                </span>
              </div>
            </div>
          </div>

          <div className="text-xs">
            <div className="uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
              Latest summary
            </div>
            {frame === null ? (
              <p className="text-zinc-500 mt-1 dark:text-zinc-400">No frames captured yet.</p>
            ) : frame.summary !== null ? (
              <>
                <p className="text-zinc-700 mt-1 dark:text-zinc-300">{frame.summary}</p>
                <p className="text-zinc-400 dark:text-zinc-500">
                  captured {formatWhen(frame.capturedAt)} · summarised{" "}
                  {formatWhen(frame.summarisedAt)}
                  {frame.imagePurgedAt !== null
                    ? ` · image purged ${formatWhen(frame.imagePurgedAt)}`
                    : ""}
                </p>
              </>
            ) : (
              <>
                <p className="text-zinc-500 mt-1 dark:text-zinc-400">
                  No summary yet — normal for a freshly captured frame.
                </p>
                <p className="text-zinc-400 dark:text-zinc-500">
                  captured {formatWhen(frame.capturedAt)}
                  {frame.summaryError !== null
                    ? ` · summariser reported: ${frame.summaryError}`
                    : ""}
                </p>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
