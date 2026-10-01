"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, BellRing, Plus, Trash2 } from "lucide-react";

import {
  screenAlertsStateCopy,
  digestCadenceLabel,
  cooldownLabel,
} from "@/lib/screen-alert-copy";

// Re-exported so existing importers of the card keep working; the definitions
// live in the dependency-free lib/screen-alert-copy.ts so a node test can load
// them without dragging React + lucide-react into the test process.
export { screenAlertsStateCopy, digestCadenceLabel, cooldownLabel };

// ---------------------------------------------------------------------------
// TASK_152 M5 — the Screen monitoring ALERTS card: user-defined keyword
// triggers + the periodic digest, with an OBVIOUS OFF SWITCH.
//
// The owner's ask has two halves, both here:
//   * "tell me when the screen shows a balance" — a keyword TRIGGER matched
//     (case-insensitively) against each frame's summary. TRIGGERS ARE TEXT ONLY
//     in this version; the copy says so rather than implying visual matching.
//   * "every 2 hours, a summary of every monitored device for that period" — the
//     periodic DIGEST.
//
// Both master switches default OFF on the server, and this card SHOWS that: it
// never turns anything on as a side effect of rendering, and it states plainly
// when alerts are off. Alerts go out through the account's normal notification
// channels (email / Telegram / agent thread per the user's own preferences).
//
// Self-fetching, like ScreenMonitoringCard: it owns a small piece of account
// state nothing else on this screen needs, and reads it from the settings route.
// The pure copy helper is exported so the "off means off" wording can be asserted
// on its own without a DOM.
// ---------------------------------------------------------------------------

export interface ScreenAlertsTrigger {
  id: string;
  keyword: string;
  label: string | null;
  enabled: boolean;
  cooldownMinutes: number;
  deviceId: string | null;
  lastFiredAt: string | null;
}

export interface ScreenAlertsView {
  prefs: { triggersEnabled: boolean; digestEnabled: boolean; digestIntervalMinutes: number };
  bounds: {
    minCooldownMinutes: number;
    maxCooldownMinutes: number;
    defaultCooldownMinutes: number;
    maxKeywordLength: number;
    minDigestIntervalMinutes: number;
    maxDigestIntervalMinutes: number;
    defaultDigestIntervalMinutes: number;
  };
  devices: Array<{ id: string; name: string }>;
  triggers: ScreenAlertsTrigger[];
}

const COOLDOWN_CHOICES = [15, 30, 60, 120, 360, 720, 1440];
const DIGEST_CHOICES = [30, 60, 120, 240, 360, 720, 1440];

export function ScreenAlertsCard({ deviceId }: { deviceId: string }) {
  const [view, setView] = useState<ScreenAlertsView | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [keyword, setKeyword] = useState("");
  const [label, setLabel] = useState("");
  const [scope, setScope] = useState<string>(deviceId); // "all" or a device id
  const [cooldown, setCooldown] = useState(120);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/screen-notifications");
      if (!res.ok) throw new Error("could not load screen alerts");
      const data = (await res.json()) as ScreenAlertsView;
      setView(data);
      setErr("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not load screen alerts");
    }
  }, []);

  // Same false-positive shape as the other cards: setState is behind the await.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- setView/setErr are behind the fetch await
    load();
  }, [load]);

  async function patchPrefs(body: Record<string, unknown>, tag: string) {
    setBusy(tag);
    try {
      const res = await fetch("/api/settings/screen-notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("could not save the setting");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not save the setting");
    } finally {
      setBusy("");
    }
  }

  async function addTrigger() {
    if (keyword.trim().length === 0) return;
    setBusy("add");
    try {
      const res = await fetch("/api/settings/screen-notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keyword: keyword.trim(),
          label: label.trim() || undefined,
          deviceId: scope === "all" ? null : scope,
          cooldownMinutes: cooldown,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(typeof data.error === "string" ? data.error : "could not add the trigger");
      }
      setKeyword("");
      setLabel("");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not add the trigger");
    } finally {
      setBusy("");
    }
  }

  async function toggleTrigger(t: ScreenAlertsTrigger) {
    setBusy(t.id);
    try {
      const res = await fetch(`/api/settings/screen-notifications/${t.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !t.enabled }),
      });
      if (!res.ok) throw new Error("could not change the trigger");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not change the trigger");
    } finally {
      setBusy("");
    }
  }

  async function deleteTrigger(t: ScreenAlertsTrigger) {
    setBusy(t.id);
    try {
      const res = await fetch(`/api/settings/screen-notifications/${t.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("could not remove the trigger");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not remove the trigger");
    } finally {
      setBusy("");
    }
  }

  if (!view) {
    return (
      <div data-screen-alerts-card="" className="rounded-lg border border-border bg-bg px-3 py-2">
        <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
          <Bell className="h-3.5 w-3.5" /> Screen alerts
        </p>
        {err ? (
          <p className="mt-1 text-xs text-red-500">{err}</p>
        ) : (
          <p className="mt-1 text-sm text-fg-muted">checking…</p>
        )}
      </div>
    );
  }

  const anyOn = view.prefs.triggersEnabled || view.prefs.digestEnabled;
  const deviceName = (id: string | null) =>
    id === null
      ? "All monitored machines"
      : (view.devices.find((d) => d.id === id)?.name ?? "a device");

  return (
    <div data-screen-alerts-card="" className="rounded-lg border border-border bg-bg px-3 py-2">
      <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
        <Bell className="h-3.5 w-3.5" /> Screen alerts
      </p>
      {err && <p className="mt-1 text-xs text-red-500">{err}</p>}

      {/* The state of the whole feature, and the OBVIOUS OFF SWITCH. */}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <p className="text-sm text-fg">{screenAlertsStateCopy(view.prefs)}</p>
        {anyOn && (
          <button
            onClick={() => patchPrefs({ triggersEnabled: false, digestEnabled: false }, "off")}
            disabled={busy === "off"}
            className="rounded-md border border-border px-2 py-1 text-xs text-fg transition-colors hover:bg-black/10 disabled:opacity-50 dark:hover:bg-white/10"
          >
            {busy === "off" ? "Turning off…" : "Turn all screen alerts off"}
          </button>
        )}
      </div>

      {/* Trigger master switch (default OFF). */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-sm text-fg">Alert me when a screen shows text I&apos;m watching for</span>
        <button
          onClick={() => patchPrefs({ triggersEnabled: !view.prefs.triggersEnabled }, "trig")}
          disabled={busy === "trig"}
          className={`rounded-md border px-2 py-1 text-xs transition-colors disabled:opacity-50 ${
            view.prefs.triggersEnabled
              ? "border-brand-600 text-fg"
              : "border-border text-fg-muted hover:text-fg"
          }`}
        >
          {busy === "trig" ? "Saving…" : view.prefs.triggersEnabled ? "On" : "Off"}
        </button>
      </div>
      <p className="mt-0.5 text-xs text-fg-muted">
        A trigger looks for a word or phrase inside the written summary of each captured screen.
        Alerts use your normal notification channels — email, Telegram and the agent thread, exactly
        as you have them set in Settings.
      </p>
      {/* Existing triggers */}
      {view.triggers.length > 0 && (
        <ul className="mt-2 space-y-1">
          {view.triggers.map((t) => (
            <li
              key={t.id}
              className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1 text-xs"
            >
              <BellRing className="h-3.5 w-3.5 text-fg-muted" />
              <span className="text-fg">{t.label ?? t.keyword}</span>
              {t.label && <span className="text-fg-muted">(“{t.keyword}”)</span>}
              <span className="text-fg-muted">· {deviceName(t.deviceId)}</span>
              <span className="text-fg-muted">· at most once per {cooldownLabel(t.cooldownMinutes)}</span>
              <span className="text-fg-muted">
                · {t.lastFiredAt ? `last sent ${new Date(t.lastFiredAt).toLocaleString()}` : "not sent yet"}
              </span>
              <button
                onClick={() => toggleTrigger(t)}
                disabled={busy === t.id}
                className="rounded-md border border-border px-2 py-0.5 transition-colors hover:bg-black/10 disabled:opacity-50 dark:hover:bg-white/10"
              >
                {t.enabled ? "On" : "Off"}
              </button>
              <button
                onClick={() => deleteTrigger(t)}
                disabled={busy === t.id}
                className="text-fg-muted transition-colors hover:text-red-500 disabled:opacity-50"
                title="Remove this trigger"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Add a trigger */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          maxLength={view.bounds.maxKeywordLength}
          placeholder="text to look for, e.g. balance"
          className="w-56 rounded-md border border-border bg-bg px-2 py-1 text-xs text-fg"
        />
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={80}
          placeholder="name (optional)"
          className="w-40 rounded-md border border-border bg-bg px-2 py-1 text-xs text-fg"
        />
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          className="rounded-md border border-border bg-bg px-2 py-1 text-xs text-fg"
        >
          <option value="all">All monitored machines</option>
          {view.devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-xs text-fg-muted">
          at most once per
          <select
            value={cooldown}
            onChange={(e) => setCooldown(Number(e.target.value))}
            className="rounded-md border border-border bg-bg px-2 py-1 text-xs text-fg"
          >
            {COOLDOWN_CHOICES.filter(
              (c) => c >= view.bounds.minCooldownMinutes && c <= view.bounds.maxCooldownMinutes,
            ).map((c) => (
              <option key={c} value={c}>
                {cooldownLabel(c)}
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={addTrigger}
          disabled={busy === "add" || keyword.trim().length === 0}
          className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-fg transition-colors hover:bg-black/10 disabled:opacity-50 dark:hover:bg-white/10"
        >
          <Plus className="h-3.5 w-3.5" /> {busy === "add" ? "Adding…" : "Add trigger"}
        </button>
      </div>

      {/* Digest (default OFF) */}
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <span className="text-sm text-fg">Send me a periodic round-up of all my monitored screens</span>
        <button
          onClick={() => patchPrefs({ digestEnabled: !view.prefs.digestEnabled }, "dig")}
          disabled={busy === "dig"}
          className={`rounded-md border px-2 py-1 text-xs transition-colors disabled:opacity-50 ${
            view.prefs.digestEnabled
              ? "border-brand-600 text-fg"
              : "border-border text-fg-muted hover:text-fg"
          }`}
        >
          {busy === "dig" ? "Saving…" : view.prefs.digestEnabled ? "On" : "Off"}
        </button>
        <label className="flex items-center gap-1 text-xs text-fg-muted">
          cadence:
          <select
            value={view.prefs.digestIntervalMinutes}
            onChange={(e) => patchPrefs({ digestIntervalMinutes: Number(e.target.value) }, "cad")}
            disabled={busy === "cad"}
            className="rounded-md border border-border bg-bg px-2 py-1 text-xs text-fg disabled:opacity-50"
          >
            {DIGEST_CHOICES.filter(
              (c) =>
                c >= view.bounds.minDigestIntervalMinutes &&
                c <= view.bounds.maxDigestIntervalMinutes,
            ).map((c) => (
              <option key={c} value={c}>
                {digestCadenceLabel(c)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="mt-0.5 text-xs text-fg-muted">
        When on, you get one message {digestCadenceLabel(view.prefs.digestIntervalMinutes)} covering
        every monitored machine for that period. Both alerts and the round-up are OFF unless you
        switch them on here.
      </p>
    </div>
  );
}

