"use client";
import { useState } from "react";
import { useConfirm } from "@/components/confirm-provider";

type Profile = {
  id: string;
  name: string;
  status: "idle" | "in_use";
  lastUsedAt: string | null;
  createdAt: string;
};

function timeAgo(iso: string): string {
  const seconds = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function BrowserProfilesPanel({
  tier,
  initialProfiles,
}: {
  tier: number;
  initialProfiles: Profile[];
}) {
  const confirm = useConfirm();
  const [profiles, setProfiles] = useState<Profile[]>(initialProfiles);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [formError, setFormError] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function createProfile() {
    const name = newName.trim();
    if (!name) {
      setFormError("Name is required");
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      const res = await fetch("/api/browser-profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormError(typeof data.error === "string" ? data.error : "Failed to create profile");
        return;
      }
      setProfiles((prev) => [...prev, data as Profile]);
      setNewName("");
      setCreating(false);
    } catch {
      setFormError("Network error — please try again");
    } finally {
      setSaving(false);
    }
  }

  async function deleteProfile(p: Profile) {
    if (p.status === "in_use") return;
    if (!(await confirm({
      title: `Delete profile "${p.name}"?`,
      description: "This cannot be undone.",
      confirmLabel: "Delete",
    }))) return;
    setDeletingId(p.id);
    try {
      const res = await fetch(`/api/browser-profiles/${p.id}`, { method: "DELETE" });
      if (res.ok) {
        setProfiles((prev) => prev.filter((x) => x.id !== p.id));
      }
    } catch {
      // ignore transient delete errors
    } finally {
      setDeletingId(null);
    }
  }
  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Browser Profiles</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Persistent Chrome sessions for your automation jobs.
          </p>
        </div>
        {tier >= 1 && !creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            New Profile
          </button>
        )}
      </div>

      {creating && (
        <div className="mt-4 max-w-xl rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <label className="flex flex-col gap-1 text-sm font-medium">
            Name
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. LinkedIn account 1"
              autoFocus
              className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
            />
          </label>
          {formError && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{formError}</p>}
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={createProfile}
              disabled={saving}
              className="flex-1 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              {saving ? "Creating…" : "Create"}
            </button>
            <button
              type="button"
              onClick={() => {
                setCreating(false);
                setFormError("");
                setNewName("");
              }}
              className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {tier === 0 && (
        <div className="mt-6 max-w-xl rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-300">
          Browser profiles require a Pro plan. Upgrade in the Billing tab to create profiles.
        </div>
      )}
{tier >= 1 && profiles.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-zinc-300 p-10 text-center dark:border-zinc-700">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            No browser profiles yet. Create one to get started.
          </p>
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              <tr>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Last used</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((p) => (
                <tr
                  key={p.id}
                  className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60"
                >
                  <td className="px-4 py-3 font-medium">{p.name}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        p.status === "idle"
                          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
                          : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400"
                      }`}
                    >
                      {p.status === "idle" ? "Ready" : "In Use"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                    {p.lastUsedAt ? timeAgo(p.lastUsedAt) : "Never"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => deleteProfile(p)}
                      disabled={p.status === "in_use" || deletingId === p.id}
                      title={
                        p.status === "in_use" ? "Profile is currently in use" : "Delete profile"
                      }
                      className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-600 transition-colors enabled:hover:bg-red-50 enabled:hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-400 dark:enabled:hover:bg-red-900/20 dark:enabled:hover:text-red-400"
                    >
                      {deletingId === p.id ? "Deleting…" : "Delete"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}