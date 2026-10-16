"use client";

import { useCallback, useEffect, useState } from "react";

import { copyToClipboard } from "@/lib/clipboard";

// Invite-only / hidden-login (owner, 2026-10-16) — the Referrals tab: every
// user's own invite link, how many clicks / signups each produced, and per-row
// copy + email buttons plus a send-to-everyone bulk action. Admin-only (the
// API enforces the session; this panel is inside the protected admin shell).

type Row = {
  id: string;
  email: string;
  createdAt: string;
  link: { code: string; clicks: number; conversions: number } | null;
  url: string | null;
  referredCount: number;
  referredBy: string | null;
};

export function ReferralsPanel() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/referrals");
    if (!res.ok) {
      setRows([]);
      return;
    }
    const data = await res.json();
    setRows(data.rows ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function sendOne(userId: string, email: string) {
    setBusy(userId);
    setNote(null);
    try {
      const res = await fetch("/api/admin/referrals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send", userId }),
      });
      setNote(
        res.ok
          ? `Invite link emailed to ${email}.`
          : `Failed to send to ${email} (${res.status}).`,
      );
    } finally {
      setBusy(null);
      void load();
    }
  }

  async function sendAll() {
    setBusy("__bulk__");
    setNote(null);
    try {
      const res = await fetch("/api/admin/referrals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "bulk" }),
      });
      const data = res.ok ? await res.json() : null;
      setNote(
        data
          ? `Sent ${data.sent}/${data.total} invite links.${
              data.failures?.length ? ` ${data.failures.length} failed.` : ""
            }`
          : "Bulk send failed.",
      );
    } finally {
      setBusy(null);
      void load();
    }
  }

  if (!rows) {
    return <p className="text-sm text-zinc-500">Loading referral tree…</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Referrals</h2>
          <p className="text-sm text-zinc-500">
            Invite-only access: each user has one personal invite link. This is
            the tree of who came through whose link.
          </p>
        </div>
        <button
          type="button"
          onClick={sendAll}
          disabled={busy !== null}
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
        >
          {busy === "__bulk__" ? "Sending…" : "Email link to everyone"}
        </button>
      </div>

      {note && (
        <p className="rounded-lg bg-zinc-100 px-3 py-2 text-sm dark:bg-zinc-800">
          {note}
        </p>
      )}

      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-zinc-50 text-left text-xs uppercase text-zinc-500 dark:bg-zinc-900/50">
              <th className="px-3 py-2">User</th>
              <th className="px-3 py-2">Joined</th>
              <th className="px-3 py-2">Invite link</th>
              <th className="px-3 py-2">Clicks</th>
              <th className="px-3 py-2">Signed up</th>
              <th className="px-3 py-2">Came via</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-border last:border-0">
                <td className="px-3 py-2 font-medium">{r.email}</td>
                <td className="px-3 py-2 text-zinc-500">
                  {new Date(r.createdAt).toLocaleDateString()}
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  {r.url ?? "—"}
                </td>
                <td className="px-3 py-2">{r.link?.clicks ?? 0}</td>
                <td className="px-3 py-2">{r.referredCount}</td>
                <td className="px-3 py-2 text-xs text-zinc-500">
                  {r.referredBy ?? "—"}
                </td>
                <td className="px-3 py-2">
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        r.url &&
                        void copyToClipboard(r.url).then((ok) =>
                          setNote(ok ? `Copied ${r.email}'s link.` : "Copy failed."),
                        )
                      }
                      disabled={!r.url}
                      className="rounded border border-border px-2 py-1 text-xs disabled:opacity-40"
                    >
                      Copy
                    </button>
                    <button
                      type="button"
                      onClick={() => void sendOne(r.id, r.email)}
                      disabled={busy !== null}
                      className="rounded border border-border px-2 py-1 text-xs disabled:opacity-40"
                    >
                      {busy === r.id ? "Sending…" : "Email"}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
