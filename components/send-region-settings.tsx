"use client";
import { useEffect, useState } from "react";

// TASK_134 (premium) — a deliberately MINIMAL settings control: just the
// region toggle per mailbox, nothing else. The full mailbox management UI
// (add/edit/test/password/daily-limit/security-mode/test-mailbox) already
// lives at the Campaigns page's "Mailboxes" tab (components/mailboxes-panel.tsx)
// — this does NOT duplicate that. It exists only so the region picker itself
// is reachable from Settings without dragging the whole mailbox CRUD UI along
// with it.

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

export function SendRegionSettings() {
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [isPremium, setIsPremium] = useState(false);
  const [premiumLoaded, setPremiumLoaded] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/mailboxes")
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => setMailboxes(data as Mailbox[]))
      .catch(() => setError("Couldn't load your mailboxes."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetch("/api/entitlements")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { premium?: boolean } | null) => setIsPremium(data?.premium === true))
      .catch(() => setIsPremium(false))
      .finally(() => setPremiumLoaded(true));
  }, []);

  async function setRegion(mailboxId: string, region: string) {
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

  if (loading) {
    return <p className="text-sm text-fg-muted">Loading…</p>;
  }
  if (mailboxes.length === 0) {
    return <p className="text-sm text-fg-muted">Add a sending mailbox first (Campaigns → Mailboxes) to set its region.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {premiumLoaded && !isPremium && (
        <p className="text-xs text-fg-muted">
          Premium — route a mailbox&apos;s sends through a regional exit instead of this server&apos;s own IP.{" "}
          <a href="/dashboard/billing" className="underline underline-offset-2 hover:text-fg">Upgrade</a>
        </p>
      )}
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex flex-col gap-2">
        {mailboxes.map((m) => (
          <div key={m.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
            <span className="min-w-0 truncate text-sm font-medium text-fg">{m.label || m.username}</span>
            <select
              value={m.sendRegion ?? ""}
              onChange={(e) => void setRegion(m.id, e.target.value)}
              disabled={!premiumLoaded || !isPremium || savingId === m.id}
              className="rounded-lg border border-border bg-bg px-2 py-1 text-sm outline-none focus:border-fg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="">Direct (this server)</option>
              {SEND_REGIONS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>
        ))}
      </div>
      <p className="text-xs text-fg-muted">
        Doesn&apos;t fix SPF/DKIM for domains you don&apos;t own — it only changes the connecting IP a recipient&apos;s server sees.
      </p>
    </div>
  );
}
