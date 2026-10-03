"use client";

// TASK_155 P6a (PLAN §19) — OUR Cloudflare accounts: the premium engine's roster.
//
// The owner asked for "option to add more to rotate at the admin". This panel is
// that: an ordered list where row 1 is the primary and the rest are fallbacks.
// A new account APPENDS, so adding a backup can never steal live traffic.
//
// The kill switch is the point of the first card: turning the premium engine off
// makes every premium Cloudflare deploy fail CLOSED with plain language rather
// than silently serving from a possibly-broken account.

import { useCallback, useEffect, useState } from "react";

import { WorkerTokenHelp } from "../hosting-worker-token-help";

export interface PlatformAccountView {
  id: string;
  accountId: string;
  label: string;
  tokenHint: string;
  /** TASK_155 P6c — the optional Workers/DNS token, as a HINT only. */
  workerTokenHint: string;
  hasWorkerToken: boolean;
  workerTokenError: string | null;
  priority: number;
  status: string;
  lastVerifiedAt: string | null;
  verifyError: string | null;
  createdAt: string;
}

interface PlatformAccountsState {
  enabled: boolean;
  accounts: PlatformAccountView[];
  live: { platformSites: number };
}

export default function PlatformAccountsPanel() {
  const [state, setState] = useState<PlatformAccountsState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [label, setLabel] = useState("");
  const [accountId, setAccountId] = useState("");
  const [token, setToken] = useState("");
  // TASK_155 P6c — the Workers/DNS token has its own input so it can be pasted
  // or REPLACED on its own, without touching the Pages token above it.
  const [workerToken, setWorkerToken] = useState("");
  /** Which row's replace-worker-token box is open ("" = none). */
  const [replacingWorkerFor, setReplacingWorkerFor] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/hosting/platform-accounts");
      if (!res.ok) throw new Error("Failed to load the platform accounts");
      setState((await res.json()) as PlatformAccountsState);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the platform accounts");
    }
  }, []);

  // House pattern (cf. components/admin-research-view.tsx): fire-and-forget on
  // mount so the effect body returns void; every setState in load is behind
  // the fetch await, not synchronous.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- every setState in load is behind the fetch await, not synchronous
    void load();
  }, [load]);

  /**
   * One caller for every mutation: the route answers with the WHOLE fresh state,
   * so the panel never re-derives an order locally and can never drift from what
   * rotation will actually do.
   */
  async function call(body: Record<string, unknown>, method: "POST" | "PATCH" | "DELETE" = "PATCH") {
    setBusy(method + ":" + String(body.id ?? "new"));
    setError("");
    try {
      const res = await fetch("/api/admin/hosting/platform-accounts", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Failed to update");
        return;
      }
      setState(data as PlatformAccountsState);
      // Clear BOTH secret inputs on success, so a pasted token is never left
      // sitting in the DOM (or in a screenshot) after the row is saved.
      setToken("");
      setWorkerToken("");
      setReplacingWorkerFor("");
    } catch {
      setError("Network error");
    } finally {
      setBusy("");
    }
  }

  const healthy = (state?.accounts ?? []).filter((a) => a.status === "active" && !a.verifyError).length;

  const inputClass =
    "rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950";
  const ghostClass =
    "rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800";

  return (
    <div className="mb-8">
      <h2 className="text-2xl font-semibold tracking-tight">Platform accounts (premium Cloudflare)</h2>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Our own Cloudflare accounts — what the &ldquo;Premium&rdquo; option serves from, so premium users never paste a token.
        Row 1 is the primary; the rest are automatic fallbacks, tried in order and marked red when a token stops working.
        Tokens are encrypted at rest and never shown again after saving.
      </p>
      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {!state ? (
        <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium text-zinc-900 dark:text-zinc-100">Premium engine</p>
                <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  {healthy} of {state.accounts.length} account(s) usable · {state.live.platformSites} site(s) on this engine
                </p>
              </div>
              <button
                onClick={() => call({ switch: true }, "PATCH")}
                disabled={busy !== ""}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium text-white transition-colors disabled:opacity-50 ${
                  state.enabled ? "bg-emerald-600 hover:bg-emerald-500" : "bg-zinc-400 hover:bg-zinc-500"
                }`}
              >
                {state.enabled ? "Enabled" : "Disabled"}
              </button>
            </div>
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
              Turning this off makes every premium Cloudflare publish fail with a clear message. It never falls back to the
              free server behind your back.
            </p>
          </div>

          {state.accounts.length === 0 && (
            <p className="rounded-xl border border-dashed border-zinc-300 p-4 text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
              No platform account yet — premium users will be told hosting is being set up.
            </p>
          )}

          {state.accounts.map((a, i) => {
            const dead = !!a.verifyError;
            const off = a.status !== "active";
            return (
              <div
                key={a.id}
                className={`rounded-xl border bg-white p-4 shadow-sm dark:bg-zinc-900 ${
                  off || dead ? "border-red-300 dark:border-red-900" : "border-zinc-200 dark:border-zinc-800"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-zinc-900 dark:text-zinc-100">
                      <span className="text-zinc-400">{i === 0 ? "① " : `${i + 1}. `}</span>
                      {a.label}
                      {i === 0 && !off && !dead ? (
                        <span className="ml-2 text-xs font-medium text-emerald-600 dark:text-emerald-400">primary</span>
                      ) : null}
                    </p>
                    <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                      {a.accountId} · token …{a.tokenHint} ·{" "}
                      {a.lastVerifiedAt ? `verified ${new Date(a.lastVerifiedAt).toLocaleString()}` : "never verified"}
                    </p>
                    {dead && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{a.verifyError}</p>}
                    {/* TASK_155 P6c — the Workers/DNS token's own status line. A row
                        without one is fine (links use the local /r/ fallback), so it
                        reads as neutral, not as an error. */}
                    <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                      Links (Worker + DNS):{" "}
                      {a.hasWorkerToken ? (
                        <span className="text-emerald-600 dark:text-emerald-400">
                          token …{a.workerTokenHint} set
                        </span>
                      ) : (
                        <span>not set — links use the plain /r/… address</span>
                      )}
                    </p>
                    {a.workerTokenError && (
                      <p className="mt-1 text-xs text-red-600 dark:text-red-400">{a.workerTokenError}</p>
                    )}
                    {/* The replace box is per-row and collapsed by default: the Pages
                        token and the Workers token rotate independently, so replacing
                        one must never imply replacing the other. */}
                    {replacingWorkerFor === a.id ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <input
                          placeholder="New Workers + DNS token"
                          type="password"
                          autoComplete="off"
                          value={workerToken}
                          onChange={(e) => setWorkerToken(e.target.value)}
                          className={inputClass}
                        />
                        <button
                          onClick={() => call({ id: a.id, workerToken }, "PATCH")}
                          disabled={busy !== "" || workerToken.trim() === ""}
                          className="rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
                        >
                          {busy === "PATCH:" + a.id ? "Saving…" : "Replace token"}
                        </button>
                        <button onClick={() => setReplacingWorkerFor("")} className={ghostClass}>
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => {
                          setReplacingWorkerFor(a.id);
                          setWorkerToken("");
                        }}
                        className="mt-2 text-xs text-zinc-600 hover:underline dark:text-zinc-300"
                      >
                        {a.hasWorkerToken ? "Replace Workers + DNS token" : "Add Workers + DNS token"}
                      </button>
                    )}
                    {off && (
                      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Disabled — never used.</p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => call({ id: a.id, priority: a.priority - 1 })}
                      disabled={i === 0 || busy !== ""}
                      title="Move up"
                      className={ghostClass}
                    >
                      ↑
                    </button>
                    <button
                      onClick={() => call({ id: a.id, priority: a.priority + 1 })}
                      disabled={i === state.accounts.length - 1 || busy !== ""}
                      title="Move down"
                      className={ghostClass}
                    >
                      ↓
                    </button>
                    <button
                      onClick={() => call({ id: a.id, verify: true })}
                      disabled={busy !== ""}
                      className={ghostClass}
                    >
                      {busy === "PATCH:" + a.id ? "Checking…" : "Verify now"}
                    </button>
                    {off ? (
                      <button
                        onClick={() => call({ id: a.id, status: "active" })}
                        disabled={busy !== ""}
                        className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
                      >
                        Enable
                      </button>
                    ) : (
                      <button
                        onClick={() => call({ id: a.id }, "DELETE")}
                        disabled={busy !== ""}
                        className="rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 disabled:opacity-40 dark:border-red-900 dark:text-red-400"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <p className="font-medium text-zinc-900 dark:text-zinc-100">Add an account</p>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              Needs a Cloudflare API token with Account &amp; Pages edit rights. It joins the END of the rotation, so it
              cannot disturb live sites until it is promoted above them.
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              <input
                placeholder="Label (e.g. Primary)"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className={inputClass}
              />
              <input
                placeholder="Cloudflare account id"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className={inputClass}
              />
              <input
                placeholder="Pages API token"
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                className={inputClass}
              />
            </div>
            {/* TASK_155 P6c — the Workers/DNS token is a SEPARATE, optional input.
                The Pages token cannot upload a Worker script, so it cannot be
                reused here; leaving this blank simply keeps links on /r/…. */}
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              <input
                placeholder="Workers + DNS token (optional)"
                type="password"
                autoComplete="off"
                value={workerToken}
                onChange={(e) => setWorkerToken(e.target.value)}
                className={inputClass}
              />
            </div>
            <WorkerTokenHelp audience="admin" className="mt-3" />
            <button
              onClick={() => call({ accountId, label, token, workerToken }, "POST")}
              disabled={busy === "POST:new" || !label.trim() || !accountId.trim() || !token.trim()}
              className="mt-3 rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
            >
              {busy === "POST:new" ? "Adding…" : "Add and verify"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}