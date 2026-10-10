"use client";

import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui";

// TASK_201 S7 — drain settings for the standalone mailer EXE (owner directive
// 2026-10-10: "any drain settings will be added to the settings"). Auto-drain is
// the local server's own tick loop (lib/local-exe-drain.ts) hitting the SAME
// internal drain route the VPS systemd timer uses — this component is only the
// controls. Rendered exclusively in the mailer EXE's Settings page.

interface DrainSettings {
  autoDrain: boolean;
  intervalSeconds: number;
}

const INTERVAL_PRESETS = [
  { seconds: 60, label: "Every minute" },
  { seconds: 120, label: "Every 2 minutes" },
  { seconds: 300, label: "Every 5 minutes" },
  { seconds: 900, label: "Every 15 minutes" },
];

export function LocalDrainSettings() {
  const [settings, setSettings] = useState<DrainSettings | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draining, setDraining] = useState(false);
  const [drainResult, setDrainResult] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/exe/drain-settings")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((s: DrainSettings) => {
        if (!cancelled) setSettings(s);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async (patch: Partial<DrainSettings>) => {
    setSaving(true);
    try {
      const res = await fetch("/api/exe/drain-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSettings((await res.json()) as DrainSettings);
    } catch {
      setLoadError(true);
    } finally {
      setSaving(false);
    }
  }, []);

  const drainNow = useCallback(async () => {
    setDraining(true);
    setDrainResult(null);
    try {
      const res = await fetch("/api/exe/drain-settings", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { status?: number };
      setDrainResult(
        res.ok
          ? "Drain run finished — check your campaign's progress below."
          : `Drain run could not complete (HTTP ${body.status ?? res.status}).`,
      );
    } catch {
      setDrainResult("Drain run could not complete.");
    } finally {
      setDraining(false);
    }
  }, []);

  if (loadError && !settings) {
    return (
      <section className="rounded-xl border border-border bg-bg p-5">
        <h2 className="text-base font-semibold text-fg">Sending</h2>
        <p className="mt-2 text-sm text-fg-muted">Could not load drain settings.</p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-border bg-bg p-5">
      <h2 className="text-base font-semibold text-fg">Sending</h2>
      <p className="mt-1 text-sm text-fg-muted">
        Queued campaign emails are sent from this device through your own mailboxes.
        Auto-drain keeps that running in the background; queued items are never lost
        when it is off — sending just pauses until it is back on.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={settings?.autoDrain ?? false}
          disabled={!settings || saving}
          onClick={() => void save({ autoDrain: !(settings?.autoDrain ?? false) })}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            settings?.autoDrain ? "bg-emerald-500" : "bg-border"
          }`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
              settings?.autoDrain ? "left-[22px]" : "left-0.5"
            }`}
          />
        </button>
        <span className="text-sm text-fg">Auto-drain {settings?.autoDrain ? "on" : "off"}</span>
      </div>

      {settings?.autoDrain ? (
        <div className="mt-4">
          <label htmlFor="drain-interval" className="text-sm text-fg-muted">
            Check for queued emails
          </label>
          <select
            id="drain-interval"
            value={settings.intervalSeconds}
            disabled={saving}
            onChange={(e) => void save({ intervalSeconds: Number(e.target.value) })}
            className="mt-1 ml-2 rounded-lg border border-border bg-bg px-2 py-1 text-sm outline-none focus:border-fg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {INTERVAL_PRESETS.map((p) => (
              <option key={p.seconds} value={p.seconds}>
                {p.label}
              </option>
            ))}
            {!INTERVAL_PRESETS.some((p) => p.seconds === settings.intervalSeconds) ? (
              <option value={settings.intervalSeconds}>
                Every {settings.intervalSeconds} seconds
              </option>
            ) : null}
          </select>
        </div>
      ) : null}

      <div className="mt-4 flex items-center gap-3">
        <Button onClick={() => void drainNow()} disabled={draining || saving}>
          {draining ? "Draining…" : "Drain now"}
        </Button>
        {drainResult ? <span className="text-sm text-fg-muted">{drainResult}</span> : null}
      </div>
    </section>
  );
}
