"use client";
import { useEffect, useState } from "react";

// TASK_134 (premium) — a deliberately MINIMAL settings control: just the
// region toggles (per mailbox, and one for lead extraction), nothing else.
// The full mailbox management UI (add/edit/test/password/daily-limit/
// security-mode/test-mailbox) already lives at the Campaigns page's
// "Mailboxes" tab (components/mailboxes-panel.tsx) — this does NOT duplicate
// that. It exists only so the region pickers themselves are reachable from
// Settings without dragging the whole mailbox CRUD UI along with them.

type Mailbox = {
  id: string;
  label: string;
  username: string;
  sendRegion: string | null;
};

const SEND_REGIONS: { value: string; label: string }[] = [
  { value: "us", label: "🇺🇸 United States (New York)" },
  { value: "ca", label: "🇨🇦 Canada (Toronto)" },
  { value: "uk", label: "🇬🇧 United Kingdom (London)" },
];

function RegionSelect({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className="rounded-lg border border-border bg-bg px-2 py-1 text-sm outline-none focus:border-fg-muted disabled:cursor-not-allowed disabled:opacity-50"
    >
      <option value="">Direct (this server)</option>
      {SEND_REGIONS.map((r) => (
        <option key={r.value} value={r.value}>{r.label}</option>
      ))}
    </select>
  );
}

export function SendRegionSettings() {
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [mailboxesLoading, setMailboxesLoading] = useState(true);
  const [extractRegion, setExtractRegion] = useState("");
  const [extractLoading, setExtractLoading] = useState(true);
  const [error, setError] = useState("");
  const [isPremium, setIsPremium] = useState(false);
  const [premiumLoaded, setPremiumLoaded] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/mailboxes")
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => setMailboxes(data as Mailbox[]))
      .catch(() => setError("Couldn't load your mailboxes."))
      .finally(() => setMailboxesLoading(false));
  }, []);

  useEffect(() => {
    fetch("/api/settings/extract-region")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { extractProxyRegion?: string | null } | null) => setExtractRegion(data?.extractProxyRegion ?? ""))
      .catch(() => {})
      .finally(() => setExtractLoading(false));
  }, []);

  useEffect(() => {
    fetch("/api/entitlements")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { premium?: boolean } | null) => setIsPremium(data?.premium === true))
      .catch(() => setIsPremium(false))
      .finally(() => setPremiumLoaded(true));
  }, []);

  async function setMailboxRegion(mailboxId: string, region: string) {
    setSavingId(mailboxId);
    setError("");
    try {
      const res = await fetch(`/api/mailboxes/${mailboxId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sendRegion: region || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Failed to save");
      setMailboxes((prev) => prev.map((m) => (m.id === mailboxId ? { ...m, sendRegion: region || null } : m)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSavingId(null);
    }
  }

  async function saveExtractRegion(region: string) {
    setSavingId("__extract__");
    setError("");
    const prev = extractRegion;
    setExtractRegion(region);
    try {
      const res = await fetch("/api/settings/extract-region", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region: region || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Failed to save");
    } catch (e) {
      setExtractRegion(prev);
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSavingId(null);
    }
  }

  const disabled = !premiumLoaded || !isPremium;

  return (
    <div className="flex flex-col gap-4">
      {premiumLoaded && !isPremium && (
        <p className="text-xs text-fg-muted">
          Premium — route your sends and lead extraction through a regional exit instead of this server&apos;s own IP.{" "}
          <a href="/dashboard/billing" className="underline underline-offset-2 hover:text-fg">Upgrade</a>
        </p>
      )}
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">Lead extraction</h3>
        {extractLoading ? (
          <p className="mt-2 text-sm text-fg-muted">Loading…</p>
        ) : (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
            <span className="text-sm font-medium text-fg">Search &amp; extraction requests</span>
            <RegionSelect
              value={extractRegion}
              onChange={(v) => void saveExtractRegion(v)}
              disabled={disabled || savingId === "__extract__"}
            />
          </div>
        )}
        <p className="mt-1.5 text-xs text-fg-muted">
          Used as the default route from the start (not just a fallback when this
          server&apos;s IP gets blocked) — falls back automatically if the chosen
          region is unavailable.
        </p>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">Sending mailboxes</h3>
        {mailboxesLoading ? (
          <p className="mt-2 text-sm text-fg-muted">Loading…</p>
        ) : mailboxes.length === 0 ? (
          <p className="mt-2 text-sm text-fg-muted">Add a sending mailbox first (Campaigns → Mailboxes) to set its region.</p>
        ) : (
          <div className="mt-2 flex flex-col gap-2">
            {mailboxes.map((m) => (
              <div key={m.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                <span className="min-w-0 truncate text-sm font-medium text-fg">{m.label || m.username}</span>
                <RegionSelect
                  value={m.sendRegion ?? ""}
                  onChange={(v) => void setMailboxRegion(m.id, v)}
                  disabled={disabled || savingId === m.id}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="text-xs text-fg-muted">
        Doesn&apos;t fix SPF/DKIM for domains you don&apos;t own — it only changes the connecting IP a recipient&apos;s server sees.
      </p>
    </div>
  );
}
