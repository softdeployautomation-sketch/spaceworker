"use client";

import { useState } from "react";

// TASK_156B V2 (owner 2026-10-14) — the "Cyber Lab access" cell on the admin
// UsersTab row. CyberLab is its own product, OFF Premium Plus (see
// lib/entitlements.ts PREMIUM_EXCLUDED_KEYS): access comes only from an explicit
// per-user grant. This is the owner's one-button allow/restrict surface.
//
// It talks to the EXISTING admin entitlement route
// (app/api/admin/users/[id]/entitlements/route.ts — GET lists effective keys,
// POST grants key:cyberlab, DELETE ?key=cyberlab revokes), so no new backend and
// every toggle is audited there. A grant with no term = never expires (the
// owner's standing grant); the toggle never shows an end-user-facing term.

type Effective = {
  user: { id: string; email: string };
  keys: string[];
  premium: boolean;
  grants?: { key: string; expiresAt: string | null; revokedAt: string | null }[];
};

export function CyberLabAccessCell({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [granted, setGranted] = useState<boolean | null>(null);
  // Part 2 (owner: "grant user the cyberlab for a certain duration like
  // others") — mirrors the Users-tab grant select (admin-panel 641-654):
  // default 30d, plus a "Never" option (0) that omits expiresInDays so the
  // grant never expires (the owner's standing grant).
  const [days, setDays] = useState(30);
  const [expiry, setExpiry] = useState<string | null>(null);

  async function sync() {
    setError("");
    const res = await fetch(`/api/admin/users/${userId}/entitlements`);
    const data = (await res.json().catch(() => ({}))) as Partial<Effective> & { error?: string };
    if (!res.ok) {
      setError(typeof data.error === "string" ? data.error : "Failed to load access");
      return;
    }
    setGranted(Array.isArray(data.keys) && data.keys.includes("cyberlab"));
    const grant = Array.isArray(data.grants)
      ? data.grants.find((g) => g.key === "cyberlab" && !g.revokedAt)
      : undefined;
    setExpiry(grant?.expiresAt ?? null);
  }

  async function load() {
    setMsg("");
    setLoading(true);
    try {
      await sync();
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  async function toggle() {
    setError("");
    setMsg("");
    setBusy(true);
    try {
      const res =
        granted === true
          ? await fetch(`/api/admin/users/${userId}/entitlements?key=cyberlab`, { method: "DELETE" })
          : await fetch(`/api/admin/users/${userId}/entitlements`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(days > 0 ? { key: "cyberlab", expiresInDays: days } : { key: "cyberlab" }),
            });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) {
        setGranted(granted !== true);
        setMsg(granted === true ? "✓ access revoked" : `✓ access granted${days > 0 ? ` for ${days}d` : " (never expires)"}`);
        await sync(); // refresh granted + expiry from the source of truth
      } else {
        setError(typeof data.error === "string" ? data.error : "Failed to update access");
      }
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-w-[150px]">
      <button
        onClick={() => {
          if (open) setOpen(false);
          else {
            setOpen(true);
            void load();
          }
        }}
        className="rounded-lg border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        {open ? "Close" : granted === null ? "Cyber Lab access…" : granted ? "Cyber Lab: ON" : "Cyber Lab access…"}
      </button>

      {open && (
        <div className="mt-2 space-y-2 rounded-lg border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-700 dark:bg-zinc-900/50">
          {loading ? (
            <p className="text-xs text-zinc-500">Loading…</p>
          ) : (
            <>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {granted
                  ? "This user can open Cyber Lab. Revoke to lock them out."
                  : "No access. Grant to let this user open Cyber Lab (its own product — not part of Premium Plus)."}
              </p>
              {granted ? (
                // Part 2 — show the current term (owner: "for a certain duration").
                // expiry null = standing grant, never expires.
                <p className="text-xs text-zinc-600 dark:text-zinc-300">
                  {expiry ? `Expires ${new Date(expiry).toLocaleDateString()}` : "Never expires"}
                </p>
              ) : (
                <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300">
                  Duration
                  <select
                    value={days}
                    onChange={(e) => setDays(Number(e.target.value))}
                    aria-label="Grant duration (days)"
                    className="rounded-lg border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-700 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200"
                  >
                    {[1, 3, 7, 14, 30, 60, 90, 180, 365].map((d) => (
                      <option key={d} value={d}>
                        {d}d
                      </option>
                    ))}
                    <option value={0}>Never</option>
                  </select>
                </label>
              )}
              <button
                onClick={() => void toggle()}
                disabled={busy}
                className={
                  granted
                    ? "w-full rounded-lg bg-red-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
                    : "w-full rounded-lg bg-emerald-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
                }
              >
                {busy
                  ? "Working…"
                  : granted
                    ? "Revoke Cyber Lab access"
                    : `Grant ${days > 0 ? `${days}d` : "(never)"}`}
              </button>
              {msg && <p className="text-xs text-emerald-600 dark:text-emerald-400">{msg}</p>}
              {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
