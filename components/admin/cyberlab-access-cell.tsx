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
};

export function CyberLabAccessCell({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [granted, setGranted] = useState<boolean | null>(null);

  async function load() {
    setError("");
    setMsg("");
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/users/${userId}/entitlements`);
      const data = (await res.json().catch(() => ({}))) as Partial<Effective> & { error?: string };
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Failed to load access");
        return;
      }
      setGranted(Array.isArray(data.keys) && data.keys.includes("cyberlab"));
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
              body: JSON.stringify({ key: "cyberlab" }),
            });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) {
        setGranted(granted !== true);
        setMsg(granted === true ? "✓ access revoked" : "✓ access granted");
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
              <button
                onClick={() => void toggle()}
                disabled={busy}
                className={
                  granted
                    ? "w-full rounded-lg bg-red-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
                    : "w-full rounded-lg bg-emerald-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
                }
              >
                {busy ? "Working…" : granted ? "Revoke Cyber Lab access" : "Grant Cyber Lab access"}
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
