"use client";

import { useState } from "react";

// Task 45, item 4's on-ramp: an EXE-only buyer holds a license_only session with
// an inline account that has an unknowable random password. They can't change it
// through the (blocked-for-them) settings page, and they never had one to "forget".
// This form posts to the allow-listed /api/settings/change-password, which — for a
// license_only session — sets a real password WITHOUT requiring the current one
// (the license_only session already proved email ownership via the claim link).
// Once set, the user logs out, and their next normal login computes scope from
// tier (license_only->full once they've paid for the web subscription).
export function LicenseUpgradeForm() {
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    if (newPassword.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/settings/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((body as { error?: string })?.error ?? "Couldn't set your password.");
        return;
      }
      setMessage("Password set. Sign out and sign back in to get full access.");
      setNewPassword("");
      setConfirm("");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <label className="block">
        <span className="text-sm font-medium text-fg">New password</span>
        <input
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          autoComplete="new-password"
          minLength={8}
          required
          className="mt-1 w-full rounded-lg border border-border bg-bg-elevated px-3 py-2 text-sm text-fg outline-none focus:border-brand-500"
        />
      </label>
      <label className="block">
        <span className="text-sm font-medium text-fg">Confirm password</span>
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          minLength={8}
          required
          className="mt-1 w-full rounded-lg border border-border bg-bg-elevated px-3 py-2 text-sm text-fg outline-none focus:border-brand-500"
        />
      </label>
      {error && <p className="text-sm text-red-500">{error}</p>}
      {message && <p className="text-sm text-emerald-500">{message}</p>}
      <button
        type="submit"
        disabled={busy}
        className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
      >
        {busy ? "Saving…" : "Set password"}
      </button>
    </form>
  );
}