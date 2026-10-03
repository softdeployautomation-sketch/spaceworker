"use client";

import { useCallback, useEffect, useState } from "react";

import { WorkerTokenHelp } from "./hosting-worker-token-help";

// Owner ask (2026-10-02): "the cloudflare account token should be in settings,
// and as soon as user adds it, it becomes an option during all hosting."
//
// This card is the TASK_155 P3 §16.4 credential manager MOVED here from the
// Hosting panel's "Connection" section. Behaviour is unchanged — list / add /
// re-verify / set-default / remove; the token is encrypted at rest and never
// returned (only a 4-char hint) — and the Hosting page reads these accounts via
// /api/hosting/status, so a token saved here shows up in the site engine picker
// immediately (including the "no account yet" hint flipping off).

interface HostingCredential {
  id: string;
  provider: string;
  accountId: string;
  label: string;
  tokenHint: string;
  // --- TASK_155 P6c — the optional Workers/DNS token, as a HINT only.
  workerTokenHint: string;
  hasWorkerToken: boolean;
  workerTokenError: string | null;
  isDefault: boolean;
  status: string;
  lastVerifiedAt: string | null;
  verifyError: string | null;
  projectCount?: number;
  createdAt: string;
}

export function HostingCredentialsSettings() {
  const [credentials, setCredentials] = useState<HostingCredential[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [form, setForm] = useState({ label: "", accountId: "", token: "", workerToken: "" });
  // TASK_155 P6c — the per-row "add / replace my Workers token" flow, keyed by
  // credential id ("" = closed). Kept separate from the add form because it edits
  // an EXISTING credential and must never touch the Pages token.
  const [workerEditFor, setWorkerEditFor] = useState("");
  const [workerEditToken, setWorkerEditToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/hosting/credentials");
      // First setState is behind the await — nothing here runs synchronously
      // in an effect body (the rule's actual concern).
      setLoadError("");
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setLoadError(data.error ?? "Couldn’t load your accounts.");
        return;
      }
      const data = (await res.json()) as { credentials: HostingCredential[] };
      setCredentials(data.credentials);
    } catch {
      setLoadError("Couldn’t load your accounts — check your connection and try again.");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- every setState in load sits behind the fetch await, not synchronous (same accepted pattern as components/admin-research-view.tsx)
    void load();
  }, [load]);

  const onAdd = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setBusy(true);
      setError("");
      setNotice("");
      try {
        const res = await fetch("/api/hosting/credentials", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form),
        });
        const data = (await res.json()) as { error?: string };
        if (!res.ok) {
          setError(data.error ?? "Couldn’t save that account.");
          return;
        }
        setForm({ label: "", accountId: "", token: "", workerToken: "" });
        setNotice("Account saved — it’s now an option everywhere you host.");
        await load();
      } catch {
        setError("Couldn’t save that account — try again.");
      } finally {
        setBusy(false);
      }
    },
    [form, load]
  );

  // One shared caller for verify / set-default / remove (all three follow the
  // same { ok } or { error } response contract).
  const onAction = useCallback(
    async (id: string, path: string, method: "POST" | "DELETE", failure: string, success?: string) => {
      setError("");
      setNotice("");
      try {
        const res = await fetch(`/api/hosting/credentials/${id}${path}`, { method });
        const data = (await res.json()) as { error?: string };
        if (!res.ok) {
          setError(data.error ?? failure);
          return;
        }
        if (success) setNotice(success);
        await load();
      } catch {
        setError(failure);
      }
    },
    [load]
  );

  /**
   * TASK_155 P6c — save a Workers/DNS token on an EXISTING credential. Sends only
   * `{ workerToken }`, so the PATCH leaves the stored Pages token and label
   * untouched (same rule as editing any other field).
   */
  const onSaveWorkerToken = useCallback(
    async (id: string) => {
      setError("");
      setNotice("");
      try {
        const res = await fetch(`/api/hosting/credentials/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workerToken: workerEditToken }),
        });
        const data = (await res.json()) as { error?: string };
        if (!res.ok) {
          setError(data.error ?? "Couldn’t save that token.");
          return;
        }
        // Clear the input the moment it is stored, so the secret isn't left in the DOM.
        setWorkerEditToken("");
        setWorkerEditFor("");
        setNotice("Saved — your links can now use your own domain.");
        await load();
      } catch {
        setError("Couldn’t save that token — try again.");
      }
    },
    [load, workerEditToken]
  );

  return (
    <div className="space-y-4">
      {notice && (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
          {notice}
        </div>
      )}
      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
          {error}
        </div>
      )}
      {loadError && <p className="text-sm text-red-600">{loadError}</p>}

      {loaded && credentials.length === 0 && !error && !loadError && (
        <p className="text-sm text-fg-muted">
          No Cloudflare account yet. Add one below and premium hosting options appear across the app.
        </p>
      )}

      {credentials.map((c) => (
        <div
          key={c.id}
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium text-fg">{c.label}</span>
              {c.isDefault && (
                <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                  default
                </span>
              )}
              {c.verifyError ? (
                <span
                  className="rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-800 dark:bg-red-950 dark:text-red-200"
                  title={c.verifyError}
                >
                  not working
                </span>
              ) : c.lastVerifiedAt ? (
                <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                  verified {new Date(c.lastVerifiedAt).toLocaleDateString()}
                </span>
              ) : (
                <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                  never verified
                </span>
              )}
            </div>
            <div className="mt-0.5 truncate text-xs text-fg-muted">
              {c.accountId} · token …{c.tokenHint} · {c.projectCount ?? 0} site
              {(c.projectCount ?? 0) === 1 ? "" : "s"}
            </div>
            {c.verifyError && <div className="mt-0.5 text-xs text-red-600 dark:text-red-300">{c.verifyError}</div>}
          {/* TASK_155 P6c — the Workers/DNS token's own line. "Not set" is NOT an
              error: links keep working through the plain /r/… address without it. */}
          <div className="mt-0.5 text-xs text-fg-muted">
            Links (Worker + DNS):{" "}
            {c.hasWorkerToken ? (
              <span className="text-emerald-600 dark:text-emerald-400">token …{c.workerTokenHint} set</span>
            ) : (
              <span>not set — links use the plain /r/… address</span>
            )}
          </div>
          {c.workerTokenError && (
            <div className="mt-0.5 text-xs text-red-600 dark:text-red-300">{c.workerTokenError}</div>
          )}
          {workerEditFor === c.id ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                type="password"
                autoComplete="off"
                value={workerEditToken}
                onChange={(e) => setWorkerEditToken(e.target.value)}
                placeholder="Workers + DNS token"
                className="w-64 rounded border border-zinc-300 px-2 py-1 text-sm text-fg dark:border-zinc-700 dark:bg-zinc-900"
              />
              <button
                type="button"
                onClick={() => void onSaveWorkerToken(c.id)}
                disabled={workerEditToken.trim() === ""}
                className="rounded bg-zinc-900 px-3 py-1 text-sm text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
              >
                Save token
              </button>
              <button
                type="button"
                onClick={() => {
                  setWorkerEditFor("");
                  setWorkerEditToken("");
                }}
                className="text-xs text-fg-muted hover:underline"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setWorkerEditFor(c.id);
                setWorkerEditToken("");
              }}
              className="mt-1 text-xs text-zinc-600 hover:underline dark:text-zinc-300"
            >
              {c.hasWorkerToken ? "Replace Workers + DNS token" : "Add Workers + DNS token"}
            </button>
          )}
        </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void onAction(c.id, "/verify", "POST", "Couldn’t verify that account.")}
              className="text-xs text-zinc-600 hover:underline dark:text-zinc-300"
            >
              Re-verify
            </button>
            {!c.isDefault && (
              <button
                type="button"
                onClick={() =>
                  void onAction(c.id, "/default", "POST", "Couldn’t switch accounts.", "That account will be used for new premium deploys.")
                }
                className="text-xs text-emerald-600 hover:underline"
              >
                Use for new deploys
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                if (window.confirm(`Remove “${c.label}”? Sites already built on it keep working.`)) {
                  void onAction(c.id, "", "DELETE", "Couldn’t remove that account.", "Account removed.");
                }
              }}
              className="text-xs text-red-600 hover:underline"
            >
              Remove
            </button>
          </div>
        </div>
      ))}

      <form onSubmit={onAdd} className="flex flex-wrap items-end gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Label
          <input
            value={form.label}
            onChange={(e) => setForm((s) => ({ ...s, label: e.target.value }))}
            placeholder="Work"
            required
            className="w-32 rounded border border-zinc-300 px-2 py-1 text-sm text-fg dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Account id
          <input
            value={form.accountId}
            onChange={(e) => setForm((s) => ({ ...s, accountId: e.target.value }))}
            placeholder="cloudflare account id"
            required
            className="w-64 rounded border border-zinc-300 px-2 py-1 text-sm text-fg dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Pages API token
          <input
            type="password"
            value={form.token}
            onChange={(e) => setForm((s) => ({ ...s, token: e.target.value }))}
            placeholder="…"
            required
            autoComplete="off"
            className="w-64 rounded border border-zinc-300 px-2 py-1 text-sm text-fg dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        {/* TASK_155 P6c — optional second token. NOT required, because a user
            without it still gets Pages hosting and working /r/… links; only custom
            domains on their own Cloudflare need this. */}
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Workers + DNS token <span className="opacity-70">(optional)</span>
          <input
            type="password"
            value={form.workerToken}
            onChange={(e) => setForm((s) => ({ ...s, workerToken: e.target.value }))}
            placeholder="…"
            autoComplete="off"
            className="w-64 rounded border border-zinc-300 px-2 py-1 text-sm text-fg dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {busy ? "Saving…" : "Add account"}
        </button>
        <WorkerTokenHelp audience="user" className="w-full" />
      </form>
    </div>
  );
}