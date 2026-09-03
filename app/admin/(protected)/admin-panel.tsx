"use client";

import { useEffect, useState } from "react";

type AdminUser = {
  id: string;
  email: string;
  tier: number;
  emailVerified: boolean;
  createdAt: string;
};

type ReviewPayment = {
  id: string;
  kind: string;
  amountUsd: number;
  status: string;
  txHash: string;
  createdAt: string;
  user: { email: string };
  attempts: Array<{ success: boolean; note: string | null; checkedAt: string }>;
};

type Tab = "users" | "payments" | "wallets" | "notifications";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "users", label: "Users" },
  { id: "payments", label: "Payments" },
  { id: "wallets", label: "Wallets" },
  { id: "notifications", label: "Notifications" },
];

function StatusBadge({ status }: { status: string }) {
  const styles =
    status === "approved"
      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
      : status === "rejected"
        ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400"
        : status === "flagged"
          ? "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400"
          : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400";
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles}`}>{status}</span>
  );
}

export default function AdminPanel({ initialUsers }: { initialUsers: AdminUser[] }) {
  const [tab, setTab] = useState<Tab>("users");

  return (
    <div className="min-h-screen bg-zinc-100 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-6xl items-center px-6 py-4">
          <h1 className="text-lg font-semibold tracking-tight">SpaceWorker Admin</h1>
          <nav className="ml-8 flex gap-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  tab === t.id
                    ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                    : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <a
            href="/"
            className="ml-auto text-sm text-zinc-500 underline-offset-4 hover:underline dark:text-zinc-400"
          >
            Back to home
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-6xl p-6">
        {tab === "users" && <UsersTab initialUsers={initialUsers} />}
        {tab === "payments" && <PaymentsTab />}
        {tab === "wallets" && <WalletsTab />}
        {tab === "notifications" && <NotificationsTab />}
      </main>
    </div>
  );
}

function UsersTab({ initialUsers }: { initialUsers: AdminUser[] }) {
  const [users, setUsers] = useState<AdminUser[]>(initialUsers);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function saveTier(userId: string) {
    const raw = drafts[userId];
    if (raw === undefined) return;
    const tier = Number(raw);
    if (!Number.isInteger(tier) || tier < 0) {
      setError("Tier must be a non-negative integer");
      return;
    }
    setSavingId(userId);
    setError("");
    try {
      const res = await fetch(`/api/admin/users/${userId}/tier`, {
        method: "PATCH",
        body: JSON.stringify({ tier }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setUsers((prev) => prev.map((u) => (u.id === data.id ? { ...u, tier: data.tier } : u)));
        setDrafts((prev) => {
          const next = { ...prev };
          delete next[userId];
          return next;
        });
        setError("");
      } else {
        setError(typeof data.error === "string" ? data.error : "Failed to update tier");
      }
    } catch {
      setError("Network error");
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div>
      <h2 className="text-2xl font-semibold tracking-tight">Users</h2>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        {users.length} user{users.length === 1 ? "" : "s"} registered
      </p>

      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="mt-6 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              <th className="px-4 py-3 font-medium">Email</th>
              <th className="px-4 py-3 font-medium">Tier</th>
              <th className="px-4 py-3 font-medium">Verified</th>
              <th className="px-4 py-3 font-medium">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {users.map((user) => (
              <tr key={user.id}>
                <td className="px-4 py-3">{user.email}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={drafts[user.id] ?? String(user.tier)}
                      onChange={(e) =>
                        setDrafts((prev) => ({ ...prev, [user.id]: e.target.value }))
                      }
                      className="w-20 rounded-lg border border-zinc-300 bg-white px-2 py-1 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                    />
                    <button
                      onClick={() => saveTier(user.id)}
                      disabled={savingId === user.id}
                      className="rounded-lg bg-zinc-900 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
                    >
                      {savingId === user.id ? "Saving…" : "Save"}
                    </button>
                  </div>
                </td>
                <td className="px-4 py-3">
                  {user.emailVerified ? (
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
                      Yes
                    </span>
                  ) : (
                    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                      No
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                  {new Date(user.createdAt).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PaymentsTab() {
  const [payments, setPayments] = useState<ReviewPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/payments");
      const data = await res.json().catch(() => ({}));
      if (res.ok) setPayments(Array.isArray(data) ? data : []);
      else setError(typeof data.error === "string" ? data.error : "Failed to load payments");
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  async function act(id: string, action: "approve" | "reject") {
    setError("");
    try {
      const res = await fetch(`/api/admin/payments/${id}/${action}`, { method: "POST" });
      if (res.ok) {
        setPayments((prev) => prev.filter((p) => p.id !== id));
      } else {
        const data = await res.json().catch(() => ({}));
        setError(typeof data.error === "string" ? data.error : "Action failed");
      }
    } catch {
      setError("Network error");
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold tracking-tight">Payments</h2>
        <button
          onClick={load}
          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
        >
          Refresh
        </button>
      </div>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Flagged and pending payments awaiting review.
      </p>

      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {loading ? (
        <p className="mt-6 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
      ) : payments.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-zinc-300 bg-white p-10 text-center dark:border-zinc-700 dark:bg-zinc-900">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No payments pending review</p>
        </div>
      ) : (
        <div className="mt-6 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <th className="px-4 py-3 font-medium">User</th>
                <th className="px-4 py-3 font-medium">Kind</th>
                <th className="px-4 py-3 font-medium">Amount</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Submitted</th>
                <th className="px-4 py-3 font-medium">Last check</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {payments.map((p) => (
                <tr key={p.id}>
                  <td className="px-4 py-3">{p.user.email}</td>
                  <td className="px-4 py-3 uppercase">{p.kind === "btc" ? "BTC" : "USDT"}</td>
                  <td className="px-4 py-3">${p.amountUsd.toFixed(2)}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={p.status} />
                  </td>
                  <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                    {new Date(p.createdAt).toLocaleString()}
                  </td>
                  <td className="max-w-[220px] px-4 py-3 text-xs text-zinc-500 dark:text-zinc-400">
                    {p.attempts[0]?.note ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      <button
                        onClick={() => act(p.id, "approve")}
                        className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-emerald-500"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => act(p.id, "reject")}
                        className="rounded-lg bg-red-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-red-500"
                      >
                        Reject
                      </button>
                    </div>
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

function WalletsTab() {
  const [loaded, setLoaded] = useState(false);
  const [btc, setBtc] = useState("");
  const [usdt, setUsdt] = useState("");
  const [price, setPrice] = useState("9.99");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/admin/wallets");
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setBtc(data.btcWallet ?? "");
        setUsdt(data.usdtWallet ?? "");
        setPrice(String(data.planPriceUsd));
      } else {
        setMessage({
          ok: false,
          text: typeof data.error === "string" ? data.error : "Failed to load wallet settings",
        });
      }
      setLoaded(true);
    })();
  }, []);

  async function save() {
    setMessage(null);
    const priceNum = Number(price);
    if (!Number.isFinite(priceNum) || priceNum <= 0) {
      setMessage({ ok: false, text: "Plan price must be greater than 0" });
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/admin/wallets", {
        method: "PUT",
        body: JSON.stringify({ btcWallet: btc.trim(), usdtWallet: usdt.trim(), planPriceUsd: priceNum }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setMessage({ ok: true, text: "Settings saved" });
      else setMessage({ ok: false, text: typeof data.error === "string" ? data.error : "Failed to save settings" });
    } catch {
      setMessage({ ok: false, text: "Network error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <h2 className="text-2xl font-semibold tracking-tight">Wallets</h2>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Wallet addresses customers pay to. Stored in the database — no env vars needed.
      </p>

      {!loaded ? (
        <p className="mt-6 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
      ) : (
        <div className="mt-6 max-w-xl rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
            BTC wallet address
          </label>
          <input
            type="text"
            value={btc}
            onChange={(e) => setBtc(e.target.value)}
            placeholder="bc1q…"
            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-mono outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
          />

          <label className="mt-4 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
            USDT-TRC20 wallet address
          </label>
          <input
            type="text"
            value={usdt}
            onChange={(e) => setUsdt(e.target.value)}
            placeholder="T…"
            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-mono outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
          />

          <label className="mt-4 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Plan price (USD / month)
          </label>
          <input
            type="number"
            min={0}
            step={0.01}
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
          />

          {message && (
            <p
              className={`mt-4 text-sm ${
                message.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
              }`}
            >
              {message.text}
            </p>
          )}

          <button
            onClick={save}
            disabled={saving}
            className="mt-5 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      )}
    </div>
  );
}

function NotificationOutcomeBadge({ outcome }: { outcome: string }) {
  const failed = outcome === "failed";
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
        failed
          ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400"
          : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
      }`}
    >
      {outcome}
    </span>
  );
}

type NotificationLogEntry = {
  id: string;
  eventType: string;
  channel: string;
  recipient: string;
  outcome: string;
  errorMessage: string | null;
  createdAt: string;
};

const NOTIFICATION_FILTERS = [
  { id: "all", label: "All" },
  { id: "sent", label: "Sent" },
  { id: "failed", label: "Failed" },
] as const;

function NotificationsTab() {
  const [logs, setLogs] = useState<NotificationLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [filter, setFilter] = useState<
    (typeof NOTIFICATION_FILTERS)[number]["id"]
  >("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError("");
      try {
        const params = new URLSearchParams({ page: String(page) });
        if (filter !== "all") params.set("outcome", filter);
        const res = await fetch(`/api/admin/notifications?${params.toString()}`);
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          setLogs(Array.isArray(data.logs) ? data.logs : []);
          setTotal(typeof data.total === "number" ? data.total : 0);
          setPage(typeof data.page === "number" ? data.page : 1);
        } else {
          setError(
            typeof data.error === "string" ? data.error : "Failed to load notifications",
          );
        }
      } catch {
        setError("Network error");
      } finally {
        setLoading(false);
      }
    })();
  }, [page, filter]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold tracking-tight">Notifications</h2>
        <div className="flex gap-1">
          {NOTIFICATION_FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => {
                setPage(1);
                setFilter(f.id);
              }}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                filter === f.id
                  ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                  : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        {total} notification{total === 1 ? "" : "s"} — every attempted send, most recent
        first.
      </p>

      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {loading ? (
        <p className="mt-6 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
      ) : logs.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-zinc-300 bg-white p-10 text-center dark:border-zinc-700 dark:bg-zinc-900">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No notifications logged</p>
        </div>
      ) : (
        <div className="mt-6 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <th className="px-4 py-3 font-medium">Event type</th>
                <th className="px-4 py-3 font-medium">Recipient</th>
                <th className="px-4 py-3 font-medium">Channel</th>
                <th className="px-4 py-3 font-medium">Outcome</th>
                <th className="px-4 py-3 font-medium">Timestamp</th>
                <th className="px-4 py-3 font-medium">Error</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {logs.map((l) => (
                <tr key={l.id}>
                  <td className="px-4 py-3 font-mono text-xs">{l.eventType}</td>
                  <td className="px-4 py-3">{l.recipient}</td>
                  <td className="px-4 py-3 uppercase">{l.channel}</td>
                  <td className="px-4 py-3">
                    <NotificationOutcomeBadge outcome={l.outcome} />
                  </td>
                  <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                    {new Date(l.createdAt).toLocaleString()}
                  </td>
                  <td className="max-w-[260px] px-4 py-3 text-xs text-zinc-500 dark:text-zinc-400">
                    {l.errorMessage ?? (l.outcome === "failed" ? "Unknown error" : "—")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 flex items-center justify-between">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Page {page} of {totalPages}
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1 || loading}
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            Previous
          </button>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages || loading}
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}