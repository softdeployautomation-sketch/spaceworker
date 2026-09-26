"use client";

import { useCallback, useEffect, useState } from "react";
import type { ServiceState } from "@/lib/services-control";
import { useConfirm } from "@/components/confirm-provider";
import { ALL_PRODUCTS, EXE_PRODUCTS } from "@/lib/products";
import { copyToClipboard } from "@/lib/clipboard";

type AdminUser = {
  id: string;
  email: string;
  tier: number;
  premiumExpiresAt: string | null;
  emailVerified: boolean;
  createdAt: string;
  // Tier 1 trial — today's usage per tool in seconds, keyed by tool name
  // ("extractor" | "mailer"). Empty for Premium users (never logged) and for
  // trial users who haven't run anything today.
  usageToday: Record<string, number>;
};

// Tier 1 trial — must match TRIAL_DAILY_SECONDS_PER_TOOL in lib/trial.ts
// (a server-only module this client component can't import directly).
const TRIAL_DAILY_SECONDS_PER_TOOL = 900;

function UsageBadge({ seconds }: { seconds: number }) {
  const overCap = seconds >= TRIAL_DAILY_SECONDS_PER_TOOL;
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
        overCap
          ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400"
          : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
      }`}
    >
      {Math.round(seconds)}s / {TRIAL_DAILY_SECONDS_PER_TOOL}s
    </span>
  );
}

type ReviewPayment = {
  id: string;
  kind: string;
  amountUsd: number;
  status: string;
  product: string;
  // Task 44 — nullable: a buyer can submit without a hash for manual review.
  txHash: string | null;
  createdAt: string;
  user: { email: string };
  attempts: Array<{ success: boolean; note: string | null; checkedAt: string }>;
};

type Tab = "overview" | "users" | "payments" | "wallets" | "notifications" | "sessions" | "queue" | "infrastructure" | "services" | "templates" | "ai" | "licenses" | "mailboxes" | "campaigns" | "automations";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "users", label: "Users" },
  { id: "payments", label: "Payments" },
  { id: "wallets", label: "Wallets" },
  { id: "notifications", label: "Notifications" },
  { id: "sessions", label: "Browser Sessions" },
  { id: "queue", label: "Search Queue" },
  // TASK_126 — split out of "Search Queue", which used to hold five unrelated
  // system panels (Admission control, Worker control, Governor, Clone limits,
  // Vantra links) under a label that had nothing to do with any of them —
  // literally why the resource governor toggle was hard to find (2026-09-26).
  { id: "infrastructure", label: "Infrastructure" },
  { id: "services", label: "Services" },
  { id: "templates", label: "Campaign Templates" },
  { id: "ai", label: "AI" },
  { id: "licenses", label: "Licenses" },
  { id: "mailboxes", label: "Mailboxes" },
  { id: "campaigns", label: "Campaigns" },
  { id: "automations", label: "Automations" },
];

// Task 42 — human labels for Payment.product in the admin review table.
// TASK_99 (2026-09-26) — both of these used to be a hand-maintained list that
// had to be kept in sync with lib/products.ts by hand (and wasn't — it still
// only listed 5 of what are now 9 products until this pass). Derived from
// ALL_PRODUCTS instead, so a new product/module only ever needs adding there.
const PRODUCT_LABELS: Record<string, string> = Object.fromEntries(
  ALL_PRODUCTS.map((p) => [p.id, p.name]),
);

// Every product sold on the store, in admin "Wallets & Prices" tab edit order.
const WALLET_PRICE_ROWS: Array<{ id: string; field: string; label: string; hint: string }> =
  ALL_PRODUCTS.map((p) => ({
    id: p.id,
    field: p.priceField,
    label: `${p.name} (USD${p.kind === "web" || p.kind === "module" ? " / month" : ""})`,
    hint:
      p.kind === "web"
        ? "Full web app — the /month price shown on the store."
        : p.kind === "module"
          ? "Pick-your-capability web subscription — the /month price shown on the store."
          : "One-time, 6-month license (1-month and 1-year terms scale off this price).",
  }));

// Import type only (server-only), not the runtime module — keeps this
// client component's shape identical to the API's own type instead of a
// hand-maintained duplicate that could silently drift from it.
type AdminServiceState = ServiceState;

type AdminQueueJob = {
  id: string;
  query: string;
  template: string;
  lane: string;
  jobStatus: string;
  queueStatus: string | null;
  priorityTier: number | null;
  workerJobId: string | null;
  error: string | null;
  leadCount: number;
  userEmail: string;
  createdAt: string;
};

function StatusBadge({ status }: { status: string }) {
  const styles =
    status === "approved"
      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
      : status === "rejected"
        ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400"
        : status === "flagged" || status === "approved_no_license"
          ? "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400"
          : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400";
  const label = status === "approved_no_license" ? "approved — no license" : status;
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles}`}>{label}</span>
  );
}

export default function AdminPanel({ initialUsers }: { initialUsers: AdminUser[] }) {
  const [tab, setTab] = useState<Tab>("overview");

  return (
    <div className="min-h-screen bg-zinc-100 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        {/* flex-wrap + order lets the 7-tab nav drop to its own full-width,
            horizontally-scrollable row on mobile (where it would otherwise
            overflow) while staying inline with the header from md: up. The nav
            stays overflow-x-auto at EVERY width (not just below md:) — it
            previously switched to overflow-visible at md:, which assumed a wide
            viewport always has room for the whole tab list. That broke inside
            the Ops Console's Split view (a real, narrower iframe panel, not the
            full browser width), where the tabs just got clipped by the panel's
            edge instead of scrolling. min-w-0 lets the nav actually shrink
            within the flex row instead of forcing an overflow. */}
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-4 sm:px-6">
          <h1 className="text-lg font-semibold tracking-tight">SpaceWorker Admin</h1>
          <nav className="order-3 flex w-full min-w-0 gap-1 overflow-x-auto md:order-none md:w-auto md:ml-8">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
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
        {tab === "overview" && <OverviewTab onNavigate={setTab} />}
        {tab === "users" && <UsersTab initialUsers={initialUsers} />}
        {tab === "payments" && <PaymentsTab />}
        {tab === "wallets" && <WalletsTab />}
        {tab === "notifications" && <NotificationsTab />}
        {tab === "sessions" && <SessionsTab />}
        {tab === "queue" && <QueueTab />}
        {tab === "infrastructure" && <InfrastructureTab />}
        {tab === "services" && <ServicesTab />}
        {tab === "templates" && <CampaignTemplatesTab />}
        {tab === "ai" && <AiTab />}
        {tab === "licenses" && <ExeLicensesTab />}
        {tab === "mailboxes" && <MailboxesTab />}
        {tab === "campaigns" && <CampaignsTab />}
        {tab === "automations" && <AutomationsTab />}
      </main>
    </div>
  );
}

// TASK_126 — the admin's default landing view: at-a-glance system health
// plus real links into whichever tab actually controls each thing, so nothing
// ever has to be rediscovered the way the governor toggle did (it lived under
// a tab called "Search Queue"). Deliberately reuses the SAME endpoints the
// deeper tabs already call (no new backend surface) so this can never drift
// out of sync with what those tabs show.
type OverviewGovernor = {
  settings: { enabled: boolean; ramWarnPct: number; ramHardPct: number };
  pressure: {
    level: "normal" | "warn" | "hard";
    measured: boolean;
    ramUsedPct: number;
    ramTotalMb: number;
    ramAvailableMb: number;
    swapUsedMb: number;
    swapTotalMb: number;
    load1: number;
    cpuCount: number;
  };
  queuedTotal: number;
};

function OverviewTab({ onNavigate }: { onNavigate: (tab: Tab) => void }) {
  const [governor, setGovernor] = useState<OverviewGovernor | null>(null);
  const [jobs, setJobs] = useState<AdminQueueJob[]>([]);
  const [sessions, setSessions] = useState<AdminSession[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const [govRes, queueRes, sessionsRes] = await Promise.all([
          fetch("/api/admin/governor"),
          fetch("/api/admin/queue"),
          fetch("/api/admin/browser-sessions"),
        ]);
        if (govRes.ok) setGovernor((await govRes.json()) as OverviewGovernor);
        if (queueRes.ok) setJobs((await queueRes.json()) as AdminQueueJob[]);
        if (sessionsRes.ok) setSessions((await sessionsRes.json()) as AdminSession[]);
      } catch {
        setError("Some live figures below didn't load — the tabs they link to still work.");
      }
    })();
  }, []);

  const runningJobs = jobs.filter((j) => j.jobStatus === "running").length;
  const queuedJobs = jobs.filter((j) => j.jobStatus === "queued").length;
  const liveSessions = sessions.filter((s) => s.status === "running").length;

  const levelDot =
    governor?.pressure.level === "hard"
      ? "bg-red-500"
      : governor?.pressure.level === "warn"
        ? "bg-amber-500"
        : "bg-emerald-500";
  const levelLabel = governor
    ? governor.settings.enabled
      ? governor.pressure.level
      : "off"
    : "—";

  return (
    <div>
      <h2 className="text-2xl font-semibold tracking-tight">Overview</h2>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        At-a-glance system health. Every card below is a real number from the tab it
        links to — click through for the full control.
      </p>
      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <button
          onClick={() => onNavigate("infrastructure")}
          className="rounded-xl border border-zinc-200 bg-white p-4 text-left shadow-sm transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
        >
          <div className="flex items-center justify-between text-xs font-medium text-zinc-500 dark:text-zinc-400">
            Resource governor
            <span className={`h-2 w-2 rounded-full ${levelDot}`} />
          </div>
          <div className="mt-2 text-2xl font-semibold capitalize">{levelLabel}</div>
          <div className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
            {governor?.pressure.measured
              ? `RAM ${governor.pressure.ramUsedPct}% · load ${governor.pressure.load1.toFixed(2)}`
              : "Loading…"}
          </div>
        </button>

        <button
          onClick={() => onNavigate("infrastructure")}
          className="rounded-xl border border-zinc-200 bg-white p-4 text-left shadow-sm transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
        >
          <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Queued requests</div>
          <div className="mt-2 text-2xl font-semibold">{governor?.queuedTotal ?? "—"}</div>
          <div className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">Held by the governor right now</div>
        </button>

        <button
          onClick={() => onNavigate("queue")}
          className="rounded-xl border border-zinc-200 bg-white p-4 text-left shadow-sm transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
        >
          <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Search jobs</div>
          <div className="mt-2 text-2xl font-semibold">
            {runningJobs} <span className="text-base font-normal text-zinc-400">running</span>
          </div>
          <div className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">{queuedJobs} queued</div>
        </button>

        <button
          onClick={() => onNavigate("sessions")}
          className="rounded-xl border border-zinc-200 bg-white p-4 text-left shadow-sm transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
        >
          <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Browser sessions</div>
          <div className="mt-2 text-2xl font-semibold">{liveSessions}</div>
          <div className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">live right now</div>
        </button>
      </div>

      <h3 className="mt-8 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Jump to
      </h3>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {(
          [
            { tab: "infrastructure" as Tab, label: "Infrastructure", hint: "Governor, admission, clone limits, worker, Vantra links" },
            { tab: "wallets" as Tab, label: "Wallets & Prices", hint: "Admin-editable pricing for every product" },
            { tab: "notifications" as Tab, label: "Notifications", hint: "Every attempted send, most recent first" },
            { tab: "users" as Tab, label: "Users", hint: "Tiers, trial usage, premium grants" },
          ]
        ).map((l) => (
          <button
            key={l.tab}
            onClick={() => onNavigate(l.tab)}
            className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-left text-sm transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
          >
            <span>
              <span className="font-medium">{l.label}</span>
              <span className="ml-2 text-xs text-zinc-400 dark:text-zinc-500">{l.hint}</span>
            </span>
            <span className="text-zinc-400">→</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function UsersTab({ initialUsers }: { initialUsers: AdminUser[] }) {
  const [users, setUsers] = useState<AdminUser[]>(initialUsers);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [grantingId, setGrantingId] = useState<string | null>(null);
  const [grantMsg, setGrantMsg] = useState<Record<string, string>>({});
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

  async function grantPremium(userId: string) {
    setError("");
    setGrantingId(userId);
    try {
      const res = await fetch(`/api/admin/users/${userId}/grant-premium`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setUsers((prev) =>
          prev.map((u) => (u.id === data.id ? { ...u, tier: data.tier, premiumExpiresAt: data.premiumExpiresAt } : u)),
        );
        setGrantMsg((prev) => ({
          ...prev,
          [userId]: `✓ expired ${new Date(data.premiumExpiresAt).toLocaleDateString()}`,
        }));
      } else {
        setError(typeof data.error === "string" ? data.error : "Failed to grant premium");
      }
    } catch {
      setError("Network error");
    } finally {
      setGrantingId(null);
    }
  }

  return (
    <div>
      <h2 className="text-2xl font-semibold tracking-tight">Users</h2>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        {users.length} user{users.length === 1 ? "" : "s"} registered
      </p>

      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="mt-6 overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              <th className="px-4 py-3 font-medium">Email</th>
              <th className="px-4 py-3 font-medium">Tier</th>
              <th className="px-4 py-3 font-medium">Premium / Usage</th>
              <th className="px-4 py-3 font-medium">Grant</th>
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
                  {user.tier >= 5 ? (
                    <div className="space-y-0.5">
                      <span className="text-xs text-zinc-400 dark:text-zinc-500">Premium</span>
                      <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                        {user.premiumExpiresAt === null
                          ? "— never expires (grandfathered)"
                          : `expires ${new Date(user.premiumExpiresAt).toLocaleDateString()}`}
                      </span>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      <UsageBadge seconds={user.usageToday.extractor ?? 0} />
                      <UsageBadge seconds={user.usageToday.mailer ?? 0} />
                    </div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <button
                    onClick={() => grantPremium(user.id)}
                    disabled={grantingId === user.id}
                    className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
                  >
                    {grantingId === user.id ? "Granting…" : user.tier >= 5 ? "+30 days" : "Grant 30d"}
                  </button>
                  {grantMsg[user.id] && (
                    <span className="ml-2 text-xs text-emerald-600 dark:text-emerald-400">{grantMsg[user.id]}</span>
                  )}
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

  async function act(id: string, action: "approve" | "reject" | "retry-license") {
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
        Flagged and pending payments awaiting review, plus any payment marked
        approved that never got a license (2026-09-19 reconciliation).
      </p>

      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {loading ? (
        <p className="mt-6 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
      ) : payments.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-zinc-300 bg-white p-10 text-center dark:border-zinc-700 dark:bg-zinc-900">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No payments pending review</p>
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <th className="px-4 py-3 font-medium">User</th>
                <th className="px-4 py-3 font-medium">Product</th>
                <th className="px-4 py-3 font-medium">Kind</th>
                <th className="px-4 py-3 font-medium">Amount</th>
                <th className="px-4 py-3 font-medium">Hash</th>
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
                  <td className="px-4 py-3">{PRODUCT_LABELS[p.product] ?? p.product}</td>
                  <td className="px-4 py-3 uppercase">
                    {p.kind === "btc" ? "BTC" : p.kind === "usdt_erc20" ? "USDT (ERC20)" : "USDT (TRC20)"}
                  </td>
                  <td className="px-4 py-3">${p.amountUsd.toFixed(2)}</td>
                  <td className="max-w-[160px] px-4 py-3 font-mono text-xs">
                    {p.txHash ? (
                      <span className="truncate" title={p.txHash}>{p.txHash}</span>
                    ) : (
                      <span className="text-amber-600 dark:text-amber-400">no hash — verify manually</span>
                    )}
                  </td>
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
                      {p.status === "approved_no_license" ? (
                        <button
                          onClick={() => act(p.id, "retry-license")}
                          className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-emerald-500"
                        >
                          Retry license
                        </button>
                      ) : (
                        <>
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
                        </>
                      )}
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
  const [usdtErc20, setUsdtErc20] = useState("");
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/admin/wallets");
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setBtc(data.btcWallet ?? "");
        setUsdt(data.usdtWallet ?? "");
        setUsdtErc20(data.usdtErc20Wallet ?? "");
        const next: Record<string, string> = {};
        for (const row of WALLET_PRICE_ROWS) next[row.field] = String(data[row.field] ?? "");
        setPrices(next);
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
    const payload: Record<string, unknown> = {
      btcWallet: btc.trim(),
      usdtWallet: usdt.trim(),
      usdtErc20Wallet: usdtErc20.trim(),
    };
    for (const row of WALLET_PRICE_ROWS) {
      const num = Number(prices[row.field]);
      if (!Number.isFinite(num) || num <= 0) {
        setMessage({ ok: false, text: `${row.label} must be greater than 0` });
        return;
      }
      payload[row.field] = num;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/admin/wallets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
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
      <h2 className="text-2xl font-semibold tracking-tight">Wallets &amp; Prices</h2>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Wallet addresses customers pay to, and the price for each product sold on the store.
        Stored in the database — no env vars needed.
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
            USDT-TRC20 wallet address (Tron)
          </label>
          <input
            type="text"
            value={usdt}
            onChange={(e) => setUsdt(e.target.value)}
            placeholder="T…"
            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-mono outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
          />

          <label className="mt-4 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
            USDT-ERC20 wallet address (Ethereum)
          </label>
          <input
            type="text"
            value={usdtErc20}
            onChange={(e) => setUsdtErc20(e.target.value)}
            placeholder="0x…"
            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-mono outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
          />
          <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
            No automated on-chain verification yet for this chain — ERC20 payments always go to manual review.
            Set this before buyers try to pay with it — checkout doesn&apos;t hide the option when it&apos;s
            blank, it just fails at submit with &quot;Wallet not configured.&quot;
          </p>

          <div className="mt-5 border-t border-zinc-200 pt-4 dark:border-zinc-700">
            {WALLET_PRICE_ROWS.map((row) => (
              <div key={row.id} className="mb-3">
                <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  {row.label}
                </label>
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={prices[row.field] ?? ""}
                  onChange={(e) => setPrices((prev) => ({ ...prev, [row.field]: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                />
                <p className="mt-0.5 text-xs text-zinc-400 dark:text-zinc-500">{row.hint}</p>
              </div>
            ))}
          </div>

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
        <div className="mt-6 overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
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

type AdminSession = {
  id: string;
  status: string;
  proxyMode: string;
  exitNodeId: string | null;
  exitIpSnapshot: string | null;
  containerId: string | null;
  userEmail: string;
  profileName: string;
  startedAt: string | null;
  createdAt: string;
};

function SessionStatusBadge({ status }: { status: string }) {
  const styles =
    status === "running"
      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
      : status === "starting"
        ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400"
        : status === "failed"
          ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400"
          : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles}`}>{status}</span>
  );
}

function QueueJobStatusBadge({ status }: { status: string }) {
  const styles =
    status === "done"
      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
      : status === "running"
        ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400"
        : status === "failed"
          ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400"
          : status === "stopped"
            ? "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300"
            : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400";
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles}`}>{status}</span>
  );
}

// Task 46 — the two mechanisms that actually spend real RAM on this shared,
// resource-constrained VPS (dispatch lanes each run a real Playwright+Chromium
// process; browser sessions are full Neko streaming containers). Deliberately
// separate from the "Search Queue" job list below — this is the fast, direct
// admission-control layer the owner asked for on top of the coarser systemd
// start/stop controls (the Services tab), for saving RAM / raising throughput
// without needing to touch a whole service.
type AdmissionMechanism = {
  enabled: boolean;
  maxConcurrent: number;
  active: number;
  /** TASK_105 — requests the resource governor is holding for this feature. */
  queued: number;
  /** False when the feature has no on/off column (the hosted pool's size IS its
   *  cap), so the panel hides a Pause toggle that would write nothing. */
  toggleable: boolean;
};
type AdmissionControlState = Record<
  | "dispatchLight"
  | "dispatchHeavy"
  | "browserSessions"
  | "vantraLinks"
  | "deviceActions"
  | "cloneSessions"
  | "hostedPool",
  AdmissionMechanism
>;

const ADMISSION_ROWS: Array<{ key: keyof AdmissionControlState; label: string; hint: string }> = [
  { key: "dispatchLight", label: "Lead extraction searches — light lane", hint: "How many searches using DuckDuckGo/Bing can run at once. Each running search is a real Playwright + Chromium process." },
  { key: "dispatchHeavy", label: "Lead extraction searches — heavy lane", hint: "How many Google-engine searches can run at once (kept separate — Google is the slower, more resource-hungry engine). Same real per-job Chromium cost as the light lane." },
  { key: "browserSessions", label: "Interactive browser sessions", hint: "How many live browser sessions can be open at once. Each is a full Neko browser-streaming container." },
  // Task 93 (CROSS-TRACK RULE 7) — Vantra plugin per-feature dials.
  { key: "vantraLinks", label: "Vantra links (assistant device provisioning)", hint: "How many users can hold an active Vantra link (org + device sync). 'Active' counts non-revoked links. Pause stops NEW provisioning only." },
  { key: "deviceActions", label: "Device actions (wake / reboot / scripts)", hint: "How many open device-action proposals one user may have at once (requested/approved/executing). Each approved action is one live Vantra/TRMM call." },
  // TASK_105 — the clone pair is a RAM consumer like the rest, so its cap, live
  // count and QUEUED count belong on the same card (the fuller clone dials —
  // TTLs, per-user cap, egress policy — stay in Browser clone limits below).
  { key: "cloneSessions", label: "Cloned browser sessions", hint: "How many cloned browsers may be live at once. Each is a real Chromium process on the pooled hosted PC; over the cap they wait in the governor's queue." },
  { key: "hostedPool", label: "Hosted clone PCs (pooled)", hint: "How many pooled hosted clone PCs may hold a live session. Its size IS its limit (no pause switch). Enforced only while the governor is on — before TASK_105 nothing enforced it." },
];

function AdmissionControlPanel() {
  const [state, setState] = useState<AdmissionControlState | null>(null);
  const [error, setError] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await fetch("/api/admin/admission-control");
      if (!res.ok) throw new Error("Failed to load admission control");
      setState((await res.json()) as AdmissionControlState);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load admission control");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function patch(mechanism: keyof AdmissionControlState, body: { enabled?: boolean; maxConcurrent?: number }) {
    setSaving(mechanism);
    setError("");
    try {
      const res = await fetch("/api/admin/admission-control", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mechanism, ...body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Failed to update");
        return;
      }
      setState((prev) =>
        prev
          ? {
              ...prev,
              [mechanism]: {
                enabled: data.enabled,
                maxConcurrent: data.maxConcurrent,
                active: data.active,
                queued: data.queued,
                toggleable: data.toggleable,
              },
            }
          : prev
      );
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[mechanism];
        return next;
      });
    } catch {
      setError("Network error");
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="mb-8">
      <h2 className="text-2xl font-semibold tracking-tight">Admission control</h2>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Fast, direct dials for the mechanisms that actually spend real RAM — pause new admissions or raise/lower
        concurrency without touching a whole service (see the Services tab for that). Existing running work is never
        interrupted; a pause or lower limit only blocks NEW starts.
      </p>
      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {!state ? (
        <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          {ADMISSION_ROWS.map((row) => {
            const m = state[row.key];
            const draft = drafts[row.key];
            return (
              <div
                key={row.key}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
              >
                <div className="min-w-0">
                  <p className="font-medium text-zinc-900 dark:text-zinc-100">{row.label}</p>
                  <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{row.hint}</p>
                  <p className="mt-1 text-xs font-medium text-zinc-600 dark:text-zinc-300">
                    {m.active} of {m.maxConcurrent} active right now
                    {m.queued > 0 ? ` · ${m.queued} queued` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 text-sm">
                    <span className="text-zinc-500 dark:text-zinc-400">Max concurrent</span>
                    <input
                      type="number"
                      min={1}
                      value={draft ?? String(m.maxConcurrent)}
                      onChange={(e) => setDrafts((prev) => ({ ...prev, [row.key]: e.target.value }))}
                      className="w-20 rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                    />
                  </label>
                  <button
                    onClick={() => {
                      const n = Number(draft ?? m.maxConcurrent);
                      if (!Number.isFinite(n) || n < 1) {
                        setError("Max concurrent must be a positive integer");
                        return;
                      }
                      patch(row.key, { maxConcurrent: Math.floor(n) });
                    }}
                    disabled={saving === row.key || draft === undefined}
                    className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                  >
                    Set
                  </button>
                  {m.toggleable && (
                    <button
                      onClick={() => patch(row.key, { enabled: !m.enabled })}
                      disabled={saving === row.key}
                      className={`rounded-lg px-3 py-1.5 text-sm font-medium text-white transition-colors disabled:opacity-50 ${
                        m.enabled ? "bg-emerald-600 hover:bg-emerald-500" : "bg-zinc-400 hover:bg-zinc-500"
                      }`}
                    >
                      {m.enabled ? "Enabled" : "Paused"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// TASK_105 — the resource governor's PRESSURE MODEL. The card above shows each
// RAM consumer's cap / live / queued counts; this block is the machine-level
// policy the governor reacts to, plus what it currently measures. The six values
// are AdminSetting keys, so the owner tunes them live — with the switch OFF
// (default) every feature keeps today's behaviour exactly.
type GovernorSettingsState = {
  enabled: boolean;
  ramWarnPct: number;
  ramHardPct: number;
  swapHardMb: number;
  queueTimeoutSec: number;
  starvationPromoteMin: number;
};

type GovernorPressure = {
  level: "normal" | "warn" | "hard";
  measured: boolean;
  ramUsedPct: number;
  ramTotalMb: number;
  ramAvailableMb: number;
  swapUsedMb: number;
  swapTotalMb: number;
  load1: number;
  cpuCount: number;
  reason: string;
};

type GovernorViewState = {
  settings: GovernorSettingsState;
  pressure: GovernorPressure;
  queuedTotal: number;
};

const GOVERNOR_NUMBER_ROWS: Array<{
  field: Exclude<keyof GovernorSettingsState, "enabled">;
  label: string;
  hint: string;
  min: number;
  max?: number;
}> = [
  { field: "ramWarnPct", label: "RAM warn %", hint: "At or above this RAM use the box is 'warned': premium stops bypassing a full feature.", min: 1, max: 100 },
  { field: "ramHardPct", label: "RAM hard %", hint: "At or above this RAM use EVERYONE queues, premium included — the limit is the machine, not the plan.", min: 1, max: 100 },
  { field: "swapHardMb", label: "Swap hard (MB)", hint: "Swap in use that counts as full even when RAM% looks fine. 0 disables the swap signal.", min: 0 },
  { field: "queueTimeoutSec", label: "Queue timeout (seconds)", hint: "How long a queued request may wait before the sweep releases it (never wedged forever).", min: 60 },
  { field: "starvationPromoteMin", label: "Starvation promotion (minutes)", hint: "A free/trial request that has waited this long is promoted into the premium class, so free users are never starved.", min: 1 },
];


function GovernorPanel() {
  const [state, setState] = useState<GovernorViewState | null>(null);
  const [error, setError] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await fetch("/api/admin/governor");
      if (!res.ok) throw new Error("Failed to load the resource governor");
      setState((await res.json()) as GovernorViewState);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the resource governor");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function patch(field: string, body: Record<string, boolean | number>) {
    setSaving(field);
    setError("");
    try {
      const res = await fetch("/api/admin/governor", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Failed to update");
        return;
      }
      setState(data as GovernorViewState);
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[field];
        return next;
      });
    } catch {
      setError("Network error");
    } finally {
      setSaving(null);
    }
  }

  const levelStyles =
    state?.pressure.level === "hard"
      ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400"
      : state?.pressure.level === "warn"
        ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400"
        : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400";

  return (
    <div className="mb-8">
      <h2 className="text-2xl font-semibold tracking-tight">Resource governor</h2>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        One server-side governor for every high-RAM feature above. Turned off it changes nothing; turned on, a full
        feature queues instead of failing, premium skips the queue while the box is healthy, and EVERYONE (premium
        included) waits once the box is genuinely full. Queued requests are stored, so they survive a restart.
      </p>
      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {!state ? (
        <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium text-zinc-900 dark:text-zinc-100">Automatic queueing</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                  <span className={`rounded-full px-2 py-0.5 font-medium ${levelStyles}`}>
                    {state.pressure.level}
                  </span>
                  <span>
                    RAM {state.pressure.ramUsedPct}% used ({state.pressure.ramAvailableMb}MB free of{" "}
                    {state.pressure.ramTotalMb}MB) · swap {state.pressure.swapUsedMb}MB · load {state.pressure.load1} on{" "}
                    {state.pressure.cpuCount} core(s) · {state.queuedTotal} queued
                  </span>
                </p>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  {state.pressure.measured
                    ? state.pressure.reason || "Box is healthy — premium bypasses the soft queue."
                    : "This host has no readable pressure source (not Linux), so it is treated as healthy."}
                </p>
              </div>
              <button
                onClick={() => patch("enabled", { enabled: !state.settings.enabled })}
                disabled={saving === "enabled"}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium text-white transition-colors disabled:opacity-50 ${
                  state.settings.enabled ? "bg-emerald-600 hover:bg-emerald-500" : "bg-zinc-400 hover:bg-zinc-500"
                }`}
              >
                {state.settings.enabled ? "Governor on" : "Governor off"}
              </button>
            </div>
          </div>

          {GOVERNOR_NUMBER_ROWS.map((row) => {
            const current = state.settings[row.field];
            const draft = drafts[row.field];
            return (
              <div
                key={row.field}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
              >
                <div className="min-w-0">
                  <p className="font-medium text-zinc-900 dark:text-zinc-100">{row.label}</p>
                  <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{row.hint}</p>
                </div>
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    min={row.min}
                    max={row.max}
                    value={draft ?? String(current)}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [row.field]: e.target.value }))}
                    className="w-24 rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                  />
                  <button
                    onClick={() => {
                      const n = Number(draft ?? current);
                      if (
                        !Number.isFinite(n) ||
                        !Number.isInteger(n) ||
                        n < row.min ||
                        (row.max !== undefined && n > row.max)
                      ) {
                        setError(
                          `${row.label} must be a whole number${
                            row.max !== undefined ? ` between ${row.min} and ${row.max}` : ` >= ${row.min}`
                          }`
                        );
                        return;
                      }
                      patch(row.field, { [row.field]: n });
                    }}
                    disabled={saving === row.field || draft === undefined}
                    className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                  >
                    Set
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}




// TASK_107 (B1) — Browser Clone limits. Same shape as admission control above
// (enabled + a limit + a LIVE count per row) because a cloned browser is a live
// Chromium process on the pooled hosted PC, i.e. another real RAM consumer. Every
// value is an AdminSetting (CROSS-TRACK RULE 7); this block is how the owner sees
// and changes them without a deploy. The two policy switches are labelled
// explicitly because they change what a clone is ALLOWED to do, not just how much.
type CloneLimits = {
  maxConcurrent: number;
  perUserCap: number;
  hostedPoolSize: number;
  idleTtlMinutes: number;
  hardTtlMinutes: number;
  purgeAfterDays: number;
};

type CloneLimitsState = {
  enabled: boolean;
  limits: CloneLimits;
  policy: { directEgressPremiumOnly: boolean; relayRequired: boolean };
  live: {
    activeSessions: number;
    activeJobs: number;
    pooledHosts: number;
    sessionHosts: number;
    relaysUp: number;
    relaysDown: number;
    relaysUnknown: number;
  };
};

type CloneLimitField = keyof CloneLimits;

const CLONE_LIMIT_ROWS: Array<{
  field: CloneLimitField;
  label: string;
  hint: string;
  live?: (s: CloneLimitsState) => string;
}> = [
  {
    field: "maxConcurrent",
    label: "Concurrent clone sessions (engine-wide)",
    hint: "How many cloned browsers may be live at once. Each one is a real Chromium process on the pooled hosted PC.",
    live: (s) => `${s.live.activeSessions} of ${s.limits.maxConcurrent} live right now`,
  },
  {
    field: "perUserCap",
    label: "Clones per user",
    hint: "How many of those live sessions a single user may hold at once.",
  },
  {
    field: "hostedPoolSize",
    label: "Hosted PC pool size",
    hint: "How many hosted clone PCs are provisioned to serve sessions. Clones beyond this wait in the resource governor's queue.",
    live: (s) => `${s.live.sessionHosts} of ${s.live.pooledHosts} pooled host(s) in use`,
  },
  {
    field: "idleTtlMinutes",
    label: "Idle TTL (minutes)",
    hint: "Close a clone after this long with no activity. Stamped per clone at creation, so changing it never kills a running session.",
  },
  {
    field: "hardTtlMinutes",
    label: "Hard TTL (minutes)",
    hint: "Absolute ceiling even while the clone is in use (480 minutes = 8 hours). Stamped per clone.",
    live: (s) => `${s.live.activeJobs} clone job(s) in flight`,
  },
  {
    field: "purgeAfterDays",
    label: "Purge inactive records after (days)",
    hint: "Terminal clone records older than this are deleted by the sweep. Active sessions are never purged.",
  },
];

type ClonePolicyField = keyof CloneLimitsState["policy"];

const CLONE_POLICY_ROWS: Array<{ field: ClonePolicyField; label: string; hint: string }> = [
  {
    field: "directEgressPremiumOnly",
    label: "Direct egress is premium-only",
    hint: "Launching with the hosted PC's own IP instead of the work PC's (the engine's --proxy-optional path) stays premium-only. Turning it off lets standard users pick it — their carried sessions may re-authenticate or trip fraud checks.",
  },
  {
    field: "relayRequired",
    label: "Relay required (fail closed)",
    hint: "On: a clone refuses to launch while the relay is down instead of silently switching to the hosted PC's IP.",
  },
];

function CloneLimitsPanel() {
  const [state, setState] = useState<CloneLimitsState | null>(null);
  const [error, setError] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await fetch("/api/admin/clone-limits");
      if (!res.ok) throw new Error("Failed to load clone limits");
      setState((await res.json()) as CloneLimitsState);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load clone limits");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // The route returns the whole state back, so one PATCH refreshes everything
  // (limits AND live counts) without a second round-trip.
  async function patch(field: string, body: Record<string, boolean | number>) {
    setSaving(field);
    setError("");
    try {
      const res = await fetch("/api/admin/clone-limits", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Failed to update");
        return;
      }
      setState(data as CloneLimitsState);
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[field];
        return next;
      });
    } catch {
      setError("Network error");
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="mb-8">
      <h2 className="text-2xl font-semibold tracking-tight">Browser clone limits</h2>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Dials for the cloned-browser feature. A live clone is a real Chromium process on the pooled hosted PC, so these
        are RAM dials like admission control above — a pause or a lower limit blocks NEW clones only and never interrupts
        a running session.
      </p>
      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {!state ? (
        <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium text-zinc-900 dark:text-zinc-100">Browser clone</p>
                <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  {state.live.activeSessions} live session(s) · {state.live.activeJobs} job(s) in flight · relays{" "}
                  {state.live.relaysUp} up / {state.live.relaysDown} down
                  {state.live.relaysUnknown > 0 ? ` / ${state.live.relaysUnknown} unknown` : ""}
                </p>
              </div>
              <button
                onClick={() => patch("enabled", { enabled: !state.enabled })}
                disabled={saving === "enabled"}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium text-white transition-colors disabled:opacity-50 ${
                  state.enabled ? "bg-emerald-600 hover:bg-emerald-500" : "bg-zinc-400 hover:bg-zinc-500"
                }`}
              >
                {state.enabled ? "Enabled" : "Paused"}
              </button>
            </div>
          </div>

          {CLONE_LIMIT_ROWS.map((row) => {
            const current = state.limits[row.field];
            const draft = drafts[row.field];
            return (
              <div
                key={row.field}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
              >
                <div className="min-w-0">
                  <p className="font-medium text-zinc-900 dark:text-zinc-100">{row.label}</p>
                  <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{row.hint}</p>
                  {row.live && (
                    <p className="mt-1 text-xs font-medium text-zinc-600 dark:text-zinc-300">{row.live(state)}</p>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    min={1}
                    value={draft ?? String(current)}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [row.field]: e.target.value }))}
                    className="w-24 rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                  />
                  <button
                    onClick={() => {
                      const n = Number(draft ?? current);
                      if (!Number.isFinite(n) || n < 1) {
                        setError(`${row.label} must be a positive integer`);
                        return;
                      }
                      patch(row.field, { [row.field]: Math.floor(n) });
                    }}
                    disabled={saving === row.field || draft === undefined}
                    className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                  >
                    Set
                  </button>
                </div>
              </div>
            );
          })}

          {CLONE_POLICY_ROWS.map((row) => (
            <div
              key={row.field}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
            >
              <div className="min-w-0">
                <p className="font-medium text-zinc-900 dark:text-zinc-100">{row.label}</p>
                <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{row.hint}</p>
              </div>
              <button
                onClick={() => patch(row.field, { [row.field]: !state.policy[row.field] })}
                disabled={saving === row.field}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium text-white transition-colors disabled:opacity-50 ${
                  state.policy[row.field] ? "bg-emerald-600 hover:bg-emerald-500" : "bg-zinc-400 hover:bg-zinc-500"
                }`}
              >
                {state.policy[row.field] ? "On" : "Off"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}



// Task 93 — admin visibility + revoke for Vantra links (owner's per-user
// device-provisioning surface). Read-only table of every link + a revoke
// button (audited through AgentActionAudit on the backend).

type VantraLinkRow = {
  id: string;
  email: string;
  orgId: string;
  orgName: string;
  status: string;
  deviceCount: number;
  lastSyncedAt: string | null;
  lastError: string | null;
  createdAt: string;
};

function VantraLinksPanel() {
  const [links, setLinks] = useState<VantraLinkRow[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await fetch("/api/admin/vantra-links");
      if (!res.ok) throw new Error("Failed to load Vantra links");
      const data = await res.json();
      setLinks(data.links as VantraLinkRow[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load Vantra links");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function revoke(linkId: string) {
    setBusy(linkId);
    setError("");
    try {
      const res = await fetch("/api/admin/vantra-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ linkId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(typeof data.error === "string" ? data.error : "Revoke failed");
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Revoke failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mb-8">
      <h2 className="text-2xl font-semibold tracking-tight">Vantra links</h2>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Every user's assistant device link (hidden sw-* org in Vantra). Revoking tears the
        install surface down and is audited.
      </p>
      {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
      {links === null ? (
        <p className="mt-3 text-sm text-zinc-500">Loading…</p>
      ) : links.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">No Vantra links yet.</p>
      ) : (
        <div className="mt-3 space-y-2">
          {links.map((l) => (
            <div
              key={l.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
            >
              <div className="min-w-0">
                <p className="font-medium text-zinc-900 dark:text-zinc-100">{l.email}</p>
                <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  {l.orgName} · {l.status} · {l.deviceCount} device{l.deviceCount === 1 ? "" : "s"}
                  {l.lastSyncedAt ? ` · synced ${new Date(l.lastSyncedAt).toLocaleString()}` : ""}
                </p>
                {l.lastError && (
                  <p className="mt-0.5 text-xs text-red-500">Last error: {l.lastError}</p>
                )}
              </div>
              {l.status !== "revoked" && (
                <button
                  onClick={() => revoke(l.id)}
                  disabled={busy === l.id}
                  className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
                >
                  {busy === l.id ? "Revoking…" : "Revoke"}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Task 48 — admin "Stop worker & pause all runs" / "Resume". Distinct from the
// coarse per-service Start/Stop on the Services tab (which only toggles systemd
// and leaves the dispatch toggles + running jobs untouched). This is the
// coordinated hard-stop the owner asked for after the earlier incident where
// the only "stop" was restarting the whole spaceworker.service and taking every
// customer's site down: dispatch lanes off + running jobs marked "stopped"
// atomically in the backend, then the worker process killed.
type WorkerControlState = { activeState: string; subState: string; memoryMb: number | null };

// Confirmed live (2026-09-21) — this panel used to show ONLY the systemd
// process's own liveness (activeState/subState "active"/"running"). That
// reads as "work is happening right now" but actually just means "the
// service is up and idle" — a real user report: "I see a running worker
// showing active but there is no runs at all". `runningCount`/`queuedCount`
// come from the SAME job list the Search Queue table below already loads
// (no new endpoint needed) so the two views can never disagree.
function WorkerControlPanel({
  onChanged,
  runningCount,
  queuedCount,
}: {
  onChanged?: () => void;
  runningCount: number;
  queuedCount: number;
}) {
  const confirm = useConfirm();
  const [state, setState] = useState<WorkerControlState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await fetch("/api/admin/queue/worker-control");
      if (!res.ok) throw new Error("Failed to load worker state");
      const data = (await res.json()) as { state: WorkerControlState };
      setState(data.state);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load worker state");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function run(action: "stop" | "resume") {
    if (
      action === "stop" &&
      !(await confirm({
        title: "Stop worker & pause all runs?",
        description:
          "Disables both dispatch lanes and hard-stops every search job that is currently running. Leads already found are already persisted on each ~10s poll tick, but each stopped job's remaining queries are lost and will NOT auto-resume. Start it again with Resume when you're ready.",
        confirmLabel: "Stop worker",
        confirmVariant: "danger",
      }))
    ) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/admin/queue/worker-control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Action failed");
        return;
      }
      if (data.state) setState(data.state as WorkerControlState);
      onChanged?.();
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  const active = state?.activeState === "active";

  return (
    <div className="mb-8">
      <h2 className="text-2xl font-semibold tracking-tight">Extraction worker</h2>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        A coordinated hard-stop: disables both dispatch lanes and marks currently-running
        jobs "stopped" before killing the worker — so you never have to restart the whole
        app again (last time that was the only option, it took every customer down). Leads
        already found are kept; a hard-stopped job's remaining queries are lost.
      </p>
      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {loading ? (
        <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
      ) : (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <ServiceStateBadge activeState={state?.activeState ?? "unknown"} />
              {state?.subState && (
                <span className="text-xs text-zinc-500 dark:text-zinc-400">{state.subState}</span>
              )}
              <span
                className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                  runningCount > 0
                    ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
                    : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                }`}
                title="Actual job activity — distinct from the process status to the left, which is just 'is the worker process alive', not 'is it doing anything right now'"
              >
                {runningCount} running · {queuedCount} queued
              </span>
            </div>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              {state?.memoryMb != null
                ? `${state.memoryMb} MB RSS`
                : "memory unavailable"}{" "}·{" "}{active ? "process alive, accepting jobs" : "dispatch paused"}
            </p>
          </div>
          <button
            onClick={() => run(active ? "stop" : "resume")}
            disabled={busy}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium text-white transition-colors disabled:opacity-50 ${
              active ? "bg-red-600 hover:bg-red-500" : "bg-blue-600 hover:bg-blue-500"
            }`}
          >
            {busy ? "Working…" : active ? "Stop worker & pause all runs" : "Resume"}
          </button>
        </div>
      )}
    </div>
  );
}
function QueueTab() {
  const confirm = useConfirm();
  const [jobs, setJobs] = useState<AdminQueueJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dispatching, setDispatching] = useState(false);
  const [dispatchResult, setDispatchResult] = useState<string>("");
  const [stoppingId, setStoppingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/admin/queue");
      if (!res.ok) throw new Error("Failed to load the queue");
      setJobs((await res.json()) as AdminQueueJob[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the queue");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function triggerDispatch() {
    setDispatching(true);
    setDispatchResult("");
    try {
      const res = await fetch("/api/admin/queue/dispatch", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDispatchResult(`Failed: ${data.error ?? res.status}`);
      } else {
        setDispatchResult(JSON.stringify(data));
        await load();
      }
    } catch {
      setDispatchResult("Network error");
    } finally {
      setDispatching(false);
    }
  }

  // Task 48 — per-job admin stop, backed by the same shared cancellation the
  // customer-facing Stop uses, gated on the admin session.
  async function stopJob(id: string) {
    if (
      !(await confirm({
        title: "Stop this job?",
        description:
          "Marks the job as stopped and cancels its queued entry. Leads already found are kept; any remaining queries are lost. This affects only this one job, not the worker.",
        confirmLabel: "Stop job",
        confirmVariant: "danger",
      }))
    ) {
      return;
    }
    setStoppingId(id);
    setError("");
    try {
      const res = await fetch(`/api/admin/queue/${id}/stop`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Stop failed");
        return;
      }
      await load();
    } catch {
      setError("Network error");
    } finally {
      setStoppingId(null);
    }
  }

  // A job "stuck" in the queue: still queued/dispatched but not making
  // progress. Flags anything queued for more than 2 minutes so a stall like
  // "the dispatcher/worker isn't running" is visually obvious, not just a
  // long list to eyeball.
  const STALL_MS = 2 * 60 * 1000;
  const isStalled = (j: AdminQueueJob) =>
    (j.jobStatus === "queued" || j.jobStatus === "running") &&
    !j.error &&
    Date.now() - new Date(j.createdAt).getTime() > STALL_MS &&
    j.leadCount === 0;

  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold tracking-tight">Search Queue</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={triggerDispatch}
            disabled={dispatching}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
          >
            {dispatching ? "Dispatching…" : "Trigger dispatch now"}
          </button>
          <button
            onClick={load}
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            Refresh
          </button>
        </div>
      </div>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Every search job with its queue-claim state and lead count. A job stuck
        "queued"/"running" for over 2 minutes with 0 leads and no error is
        flagged — that shape usually means the dispatcher timer or the
        extraction worker isn't actually running, not that the search itself
        is slow.
      </p>

      {dispatchResult && (
        <p className="mt-3 rounded-lg bg-zinc-100 p-2 font-mono text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
          {dispatchResult}
        </p>
      )}
      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {loading ? (
        <p className="mt-6 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
      ) : jobs.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-zinc-300 bg-white p-10 text-center dark:border-zinc-700 dark:bg-zinc-900">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No search jobs yet</p>
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <th className="px-4 py-3 font-medium">User</th>
                <th className="px-4 py-3 font-medium">Query</th>
                <th className="px-4 py-3 font-medium">Lane</th>
                <th className="px-4 py-3 font-medium">Job status</th>
                <th className="px-4 py-3 font-medium">Queue claim</th>
                <th className="px-4 py-3 font-medium">Leads</th>
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {jobs.map((j) => (
                <tr key={j.id} className={isStalled(j) ? "bg-red-50 dark:bg-red-950/30" : ""}>
                  <td className="px-4 py-3">{j.userEmail}</td>
                  <td className="px-4 py-3 max-w-xs truncate" title={j.query}>
                    {j.query}
                    {isStalled(j) && (
                      <span className="ml-2 rounded-full bg-red-600 px-2 py-0.5 text-xs font-medium text-white">
                        stalled
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">{j.lane}</td>
                  <td className="px-4 py-3">
                    <QueueJobStatusBadge status={j.jobStatus} />
                    {j.error && (
                      <p className="mt-1 max-w-xs truncate text-xs text-red-600 dark:text-red-400" title={j.error}>
                        {j.error}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                    {j.queueStatus ?? "—"}
                  </td>
                  <td className="px-4 py-3">{j.leadCount}</td>
                  <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                    {new Date(j.createdAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    {(j.jobStatus === "queued" || j.jobStatus === "running") && (
                      <button
                        onClick={() => stopJob(j.id)}
                        disabled={stoppingId === j.id}
                        className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
                      >
                        {stoppingId === j.id ? "Stopping…" : "Stop"}
                      </button>
                    )}
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

// TASK_126 — the system-level panels that used to live inside "Search Queue"
// under a label that had nothing to do with them. `runningCount`/`queuedCount`
// still come from the job list (WorkerControlPanel's own comment explains
// why), so this tab does its own lightweight fetch of the same endpoint
// rather than sharing QueueTab's state across an unrelated tab boundary.
function InfrastructureTab() {
  const [jobs, setJobs] = useState<AdminQueueJob[]>([]);

  const loadJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/queue");
      if (res.ok) setJobs((await res.json()) as AdminQueueJob[]);
    } catch {
      // Best-effort — WorkerControlPanel just shows 0/0 if this fails, it
      // isn't the source of truth for worker health.
    }
  }, []);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  return (
    <div>
      <h2 className="text-2xl font-semibold tracking-tight">Infrastructure</h2>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Every system-level control that isn&apos;t about one product feature: admission,
        the extraction worker, the resource governor, browser-clone limits, and linked
        Vantra devices.
      </p>

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-2">
        <AdmissionControlPanel />
        <WorkerControlPanel
          onChanged={loadJobs}
          runningCount={jobs.filter((j) => j.jobStatus === "running").length}
          queuedCount={jobs.filter((j) => j.jobStatus === "queued").length}
        />
      </div>

      <GovernorPanel />
      <CloneLimitsPanel />
      <VantraLinksPanel />
    </div>
  );
}

function SessionsTab() {
  const confirm = useConfirm();
  const [sessions, setSessions] = useState<AdminSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [killingId, setKillingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/admin/browser-sessions");
      if (!res.ok) throw new Error("Failed to load sessions");
      setSessions((await res.json()) as AdminSession[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load sessions");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function kill(id: string) {
    if (!(await confirm({
      title: "Kill this session?",
      description: "Its browser process will be terminated.",
      confirmLabel: "Kill",
    }))) return;
    setKillingId(id);
    try {
      const res = await fetch(`/api/admin/browser-sessions/${id}/kill`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Failed to kill session");
        return;
      }
      await load();
    } catch {
      setError("Network error");
    } finally {
      setKillingId(null);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold tracking-tight">Browser Sessions</h2>
        <button
          onClick={load}
          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
        >
          Refresh
        </button>
      </div>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        All interactive browser sessions. Kill stops one process without touching others.
      </p>

      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {loading ? (
        <p className="mt-6 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
      ) : sessions.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-zinc-300 bg-white p-10 text-center dark:border-zinc-700 dark:bg-zinc-900">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No browser sessions</p>
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <th className="px-4 py-3 font-medium">User</th>
                <th className="px-4 py-3 font-medium">Profile</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Route</th>
                <th className="px-4 py-3 font-medium">Exit IP</th>
                <th className="px-4 py-3 font-medium">Started</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td className="px-4 py-3">{s.userEmail}</td>
                  <td className="px-4 py-3">{s.profileName}</td>
                  <td className="px-4 py-3">
                    <SessionStatusBadge status={s.status} />
                  </td>
                  <td className="px-4 py-3">
                    {s.proxyMode === "free"
                      ? `Free · ${s.exitNodeId?.toUpperCase() ?? "—"}`
                      : "BYO"}
                  </td>
                  <td
                    className="px-4 py-3 font-mono text-xs text-zinc-500 dark:text-zinc-400"
                    title="Real public IP observed for this session at start time — for abuse/legal lookups, not re-derived from the current exit-node config"
                  >
                    {s.exitIpSnapshot ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                    {s.startedAt
                      ? new Date(s.startedAt).toLocaleString()
                      : new Date(s.createdAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => kill(s.id)}
                      disabled={killingId === s.id || (s.status !== "running" && s.status !== "starting")}
                      title={
                        s.status !== "running" && s.status !== "starting"
                          ? "Session is not running"
                          : "Kill this session's process"
                      }
                      className="rounded-lg bg-red-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
                    >
                      {killingId === s.id ? "Killing…" : "Kill"}
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

function ServiceStateBadge({ activeState }: { activeState: string }) {
  const styles =
    activeState === "active"
      ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
      : activeState === "failed"
        ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
        : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles}`}>{activeState}</span>
  );
}

const SERVICE_LABELS: Record<string, string> = {
  "spaceworker-browser.service": "Browser subsystem (Neko/Chrome)",
  "extraction-worker.service": "Extraction worker",
};

type AITestUsage = {
  mode?: string;
  cost_hundredths_cent?: number;
  used_today_hundredths_cent?: number;
  cap_hundredths_cent?: number;
};

type AITestResult = {
  ok: boolean;
  content?: string;
  usage?: AITestUsage;
  error?: string;
  code?: string;
};

// Task 40 — admin per-user AI usage + cap adjustment (GET/PATCH /api/admin/ai-usage).
type AiUsageUser = {
  userId: string;
  email: string;
  usedTodayHundredthsCent: number;
  aiDailyCapHundredthsCent: number;
};

type AiUsageData = {
  users: AiUsageUser[];
  totalUsedTodayHundredthsCent: number;
  poolCapHundredthsCent: number;
  pooled:
    | { usedTodayHundredthsCent: number | null; capHundredthsCent: number | null; error?: string }
    | null;
};

function AiTab() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<AITestResult | null>(null);
  const [error, setError] = useState("");
  const [usage, setUsage] = useState<AiUsageData | null>(null);
  const [capDrafts, setCapDrafts] = useState<Record<string, string>>({});
  const [savingCapId, setSavingCapId] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [confRes, usageRes] = await Promise.all([
          fetch("/api/admin/ai"),
          fetch("/api/admin/ai-usage"),
        ]);
        if (confRes.ok) {
          const data = await confRes.json();
          setConfigured(Boolean(data.configured));
        }
        if (usageRes.ok) {
          const data = (await usageRes.json()) as AiUsageData;
          setUsage(data);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load AI usage");
      }
    })();
  }, []);

  async function saveCap(userId: string, explicit?: number) {
    const raw = explicit !== undefined ? String(explicit) : capDrafts[userId];
    if (raw === undefined) return;
    const cap = Number(raw);
    if (!Number.isFinite(cap) || cap < 0) {
      setError("Cap must be a non-negative number (hundredths of a cent)");
      return;
    }
    setSavingCapId(userId);
    setError("");
    try {
      const res = await fetch("/api/admin/ai-usage", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, aiDailyCapHundredthsCent: cap }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setUsage((prev) =>
          prev
            ? {
                ...prev,
                users: prev.users.map((u) =>
                  u.userId === data.userId
                    ? { ...u, aiDailyCapHundredthsCent: data.aiDailyCapHundredthsCent }
                    : u
                ),
              }
            : prev
        );
        setCapDrafts((prev) => {
          const next = { ...prev };
          delete next[userId];
          return next;
        });
      } else {
        setError(typeof data.error === "string" ? data.error : "Failed to update cap");
      }
    } catch {
      setError("Network error");
    } finally {
      setSavingCapId(null);
    }
  }

  async function quickSetCap(userId: string, delta: number, unlimited: boolean) {
    const user = usage?.users.find((u) => u.userId === userId);
    if (!user) return;
    const next = unlimited ? 500000 : user.aiDailyCapHundredthsCent + delta;
    await saveCap(userId, next);
  }

  async function testConnection() {
    setTesting(true);
    setError("");
    setResult(null);
    try {
      const res = await fetch("/api/admin/ai", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as AITestResult;
      if (res.ok) {
        setResult(data);
      } else {
        setResult({ ok: false, error: data.error ?? "Test failed", code: data.code });
      }
    } catch {
      setResult({ ok: false, error: "Network error" });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold tracking-tight">AI (Channelry relay)</h2>
        <button
          onClick={() => void testConnection()}
          disabled={testing || configured === false}
          className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
        >
          {testing ? "Testing…" : "Test connection"}
        </button>
      </div>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        SpaceWorker's client on the Channelry external-AI relay (client id{" "}
        <code className="text-zinc-600">spaceworker</code>, a pooling $50/day cap). The key is read from
        the <code className="text-zinc-600">CHANNELRY_AI_API_KEY</code> environment variable and is never
        shown here or exposed to the browser.
      </p>

      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="mt-6 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Key configured</span>
          {configured === null ? (
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
              Loading…
            </span>
          ) : configured ? (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
              Yes — ready to test
            </span>
          ) : (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
              No — set CHANNELRY_AI_API_KEY to enable
            </span>
          )}
        </div>
      </div>

      {configured === false && (
        <p className="mt-6 text-sm text-zinc-500 dark:text-zinc-400">
          Add <code className="text-zinc-600">CHANNELRY_AI_API_KEY</code> to the server environment and
          restart, then reload this page. The connection test is disabled until then (fail closed).
        </p>
      )}

      {result && (
        <div className="mt-6 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">Test result</h3>
            {result.ok ? (
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
                Connected
              </span>
            ) : (
              <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/40 dark:text-red-400">
                Failed{result.code ? ` — ${result.code}` : ""}
              </span>
            )}
          </div>
          {result.content && (
            <p className="mt-3 text-sm text-zinc-700 dark:text-zinc-300">
              <span className="font-medium">Reply:</span> “{result.content}”
            </p>
          )}
          {result.error && (
            <p className="mt-3 text-sm text-red-600 dark:text-red-400">{result.error}</p>
          )}
          {result.usage && (
            <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
              <div>
                <p className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Cost</p>
                <p className="font-medium">{result.usage.cost_hundredths_cent ?? 0} hundredths ¢</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Used today</p>
                <p className="font-medium">
                  {result.usage.used_today_hundredths_cent === undefined
                    ? "—"
                    : `${result.usage.used_today_hundredths_cent}`}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Daily cap</p>
                <p className="font-medium">{result.usage.cap_hundredths_cent ?? "—"}</p>
              </div>
            </div>
          )}
        </div>
      )}

      {usage && (
        <div className="mt-8">
          <h3 className="text-xl font-semibold tracking-tight">Per-user daily limits</h3>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Each agent turn is charged against the user's cap. Exceed it and the next turn is blocked
            in-line with zero Channelry spend until midnight UTC — or until you raise the cap here
            (takes effect on their very next turn, no deploy).
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-6 rounded-xl border border-zinc-200 bg-white p-4 text-sm shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <div>
              <p className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Users, today (this app)
              </p>
              <p className="font-medium">
                {usage.totalUsedTodayHundredthsCent} / {usage.poolCapHundredthsCent} hundredths ¢
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Channelry pool, today
              </p>
              <p className="font-medium">
                {usage.pooled?.error ? (
                  <span className="text-amber-600 dark:text-amber-400">
                    unreachable — {usage.pooled.error}
                  </span>
                ) : usage.pooled?.usedTodayHundredthsCent === null ? (
                  "—"
                ) : (
                  <>
                    {usage.pooled?.usedTodayHundredthsCent} /{" "}
                    {usage.pooled?.capHundredthsCent ?? "—"} hundredths ¢
                  </>
                )}
              </p>
            </div>
          </div>

          <div className="mt-4 overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                  <th className="px-4 py-3 font-medium">Email</th>
                  <th className="px-4 py-3 font-medium">Used today</th>
                  <th className="px-4 py-3 font-medium">Daily cap</th>
                  <th className="px-4 py-3 font-medium">Adjust</th>
                </tr>
              </thead>
              <tbody>
                {usage.users.length === 0 ? (
                  <tr>
                    <td className="px-4 py-6 text-zinc-500" colSpan={4}>No users yet.</td>
                  </tr>
                ) : (
                  usage.users.map((u) => {
                    const overCap = u.usedTodayHundredthsCent >= u.aiDailyCapHundredthsCent;
                    const draft = capDrafts[u.userId];
                    const qbtn =
                      "rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50";
                    return (
                      <tr
                        key={u.userId}
                        className="border-b border-zinc-100 last:border-0 dark:border-zinc-800"
                      >
                        <td className="px-4 py-3">
                          {u.email}
                          {overCap && (
                            <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/40 dark:text-red-400">
                              capped
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">{u.usedTodayHundredthsCent}</td>
                        <td className="px-4 py-3">
                          <input
                            type="number"
                            min={0}
                            value={draft ?? String(u.aiDailyCapHundredthsCent)}
                            onChange={(e) =>
                              setCapDrafts((prev) => ({ ...prev, [u.userId]: e.target.value }))
                            }
                            className="w-28 rounded-md border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-800"
                          />
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <button
                              onClick={() => void saveCap(u.userId)}
                              disabled={savingCapId === u.userId || draft === undefined}
                              className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
                            >
                              {savingCapId === u.userId ? "Saving…" : "Set"}
                            </button>
                            <button
                              onClick={() => void quickSetCap(u.userId, 100, false)}
                              disabled={savingCapId === u.userId}
                              className={`${qbtn} bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700`}
                            >
                              +$0.01
                            </button>
                            <button
                              onClick={() => void quickSetCap(u.userId, 500, false)}
                              disabled={savingCapId === u.userId}
                              className={`${qbtn} bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700`}
                            >
                              +$0.05
                            </button>
                            <button
                              onClick={() => void quickSetCap(u.userId, 0, true)}
                              disabled={savingCapId === u.userId}
                              className={`${qbtn} bg-indigo-50 text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-900/40 dark:text-indigo-300 dark:hover:bg-indigo-900/60`}
                              title="Raise to the whole $50 pool cap"
                            >
                              Max today
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// Task 56 — admin-toggleable maintenance windows. Independent toggles for the
// web page (served by proxy.ts for everything but /admin/** + static) and the
// EXE-API traffic (/api/exe* + /api/exe-license*). Lives in ServicesTab because
// it's the same "operator flips a switch before/after risky work" category as the
// worker start/stop controls.
function MaintenanceControls() {
  const [flags, setFlags] = useState<{ web: boolean; exeApi: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyField, setBusyField] = useState<"web" | "exeApi" | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/admin/maintenance");
      if (!res.ok) throw new Error("Failed to load maintenance mode");
      setFlags((await res.json()) as { web: boolean; exeApi: boolean });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load maintenance mode");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggle(field: "web" | "exeApi") {
    if (!flags) return;
    setBusyField(field);
    setError("");
    try {
      const res = await fetch("/api/admin/maintenance", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ field, value: !flags[field] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Failed to update maintenance mode");
      } else {
        setFlags(data as { web: boolean; exeApi: boolean });
      }
    } catch {
      setError("Network error");
    } finally {
      setBusyField(null);
    }
  }

  const rows = [
    {
      key: "web" as const,
      label: "Web maintenance mode",
      hint: "Shows the \"We're updating\" page for the whole site except /admin/** and static assets. Flip on before a deploy or DNS change.",
    },
    {
      key: "exeApi" as const,
      label: "EXE API maintenance mode",
      hint: "Makes /api/exe* + /api/exe-license* return 503 { maintenance: true }; the desktop EXE retries with a friendly state until cleared.",
    },
  ];

  return (
    <div className="mt-6 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
          Maintenance mode
        </h3>
        <button
          onClick={load}
          disabled={loading}
          className="rounded-lg border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
        >
          Refresh
        </button>
      </div>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        Both flags are off by default and separate (web vs EXE-API) so they stay
        correct once EXE-API moves to its own hostname. Flipping a flag takes
        effect within a few seconds — proxy reads are cached, and admin writes
        invalidate the cache immediately. Never locks out /admin/** itself.
      </p>

      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {loading && !flags ? (
        <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
      ) : (
        <div className="mt-4 space-y-4">
          {rows.map(({ key, label, hint }) => (
            <div
              key={key}
              className="flex items-start justify-between gap-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
            >
              <div>
                <p className="text-sm font-medium text-zinc-800 dark:text-zinc-100">{label}</p>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{hint}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={Boolean(flags?.[key])}
                disabled={busyField === key || !flags}
                onClick={() => toggle(key)}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
                  flags?.[key] ? "bg-brand-600" : "bg-zinc-300 dark:bg-zinc-700"
                }`}
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                    flags?.[key] ? "translate-x-5" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ServicesTab() {
  const confirm = useConfirm();
  const [services, setServices] = useState<AdminServiceState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Per-unit, not a single scalar — a scalar would let one row's finally{}
  // clear another row's busy flag mid-request if a second controllable unit
  // is ever added and two actions overlap in flight.
  const [pendingUnits, setPendingUnits] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/admin/services");
      if (!res.ok) throw new Error("Failed to load service state");
      setServices((await res.json()) as AdminServiceState[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load service state");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function act(unit: string, action: "start" | "stop" | "restart") {
    // Restart tears down every live container exactly like Stop does
    // (systemd sends the same SIGTERM either way) — same warning for both.
    if (
      (action === "stop" || action === "restart") &&
      !(await confirm({
        title: `${action === "stop" ? "Stop" : "Restart"} the browser subsystem?`,
        description: `Any interactive browser sessions currently open will be cut off. ${
          action === "stop"
            ? "It comes back on a VPS reboot but not automatically otherwise — you'll need to Start it again from here."
            : "It will come back up on its own once the restart finishes."
        }`,
        confirmLabel: action === "stop" ? "Stop" : "Restart",
      }))
    ) {
      return;
    }
    setPendingUnits((prev) => new Set(prev).add(unit));
    setError("");
    try {
      const res = await fetch("/api/admin/services", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unit, action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Action failed");
      } else {
        await load();
      }
    } catch {
      setError("Network error");
    } finally {
      setPendingUnits((prev) => {
        const next = new Set(prev);
        next.delete(unit);
        return next;
      });
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold tracking-tight">Services</h2>
        <button
          onClick={load}
          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
        >
          Refresh
        </button>
      </div>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Raw start/stop/restart for the standalone heavyweight subsystems — the
        browser subsystem (interactive Chrome/Neko sessions) and the extraction
        worker. This only toggles systemd; it does NOT pause dispatch or change
        job state (the Search Queue tab's "Stop worker & pause all runs" is the
        coordinated hard-stop for the worker). Stopping the browser frees the
        memory those Docker containers/processes use; existing browser sessions
        are cut off immediately.
      </p>

      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {loading ? (
        <p className="mt-6 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <th className="px-4 py-3 font-medium">Service</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Memory</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {services.map((s) => {
                const busy = pendingUnits.has(s.unit);
                const isActive = s.activeState === "active";
                return (
                  <tr key={s.unit}>
                    <td className="px-4 py-3">{SERVICE_LABELS[s.unit] ?? s.unit}</td>
                    <td className="px-4 py-3">
                      <ServiceStateBadge activeState={s.activeState} />
                      <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">{s.subState}</span>
                    </td>
                    <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                      {s.memoryMb !== null ? `${s.memoryMb} MB` : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        {isActive ? (
                          <button
                            onClick={() => act(s.unit, "stop")}
                            disabled={busy}
                            className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
                          >
                            {busy ? "Working…" : "Stop"}
                          </button>
                        ) : (
                          <button
                            onClick={() => act(s.unit, "start")}
                            disabled={busy}
                            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
                          >
                            {busy ? "Working…" : "Start"}
                          </button>
                        )}
                        <button
                          onClick={() => act(s.unit, "restart")}
                          disabled={busy}
                          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                        >
                          Restart
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
        Stopping does not survive a VPS reboot as "stopped" — a reboot brings it back.
      </p>

      <MaintenanceControls />
    </div>
  );
}
type AdminTemplate = {
  id: string;
  name: string;
  createdAt: string;
  variants: { id: string; subject: string; bodyHtml: string }[];
};

// Task 28, item 5 — admin authoring of "ready-made" campaign templates (the
// "Ready-made templates" group in the Automations builder). Templates are just
// EmailCampaign rows owned by the SYSTEM_TEMPLATES_USER_EMAIL account, with
// subject/body in CampaignVariant rows; the builder clones them per run.
function CampaignTemplatesTab() {
  const confirm = useConfirm();
  const [templates, setTemplates] = useState<AdminTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [variantRows, setVariantRows] = useState<{ subject: string; bodyHtml: string }[]>([
    { subject: "", bodyHtml: "" },
  ]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/admin/campaign-templates");
      if (!res.ok) throw new Error("Failed to load campaign templates");
      setTemplates((await res.json()) as AdminTemplate[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load campaign templates");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);
async function createTemplate() {
    const trimmed = name.trim();
    const variants = variantRows
      .map((v) => ({ subject: v.subject.trim(), bodyHtml: v.bodyHtml.trim() }))
      .filter((v) => v.subject.length > 0 && v.bodyHtml.length > 0);
    if (!trimmed) return setError("Name is required");
    if (variants.length === 0) return setError("At least one subject/body variant is required");

    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/admin/campaign-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed, variants }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Create failed");
      } else {
        setName("");
        setVariantRows([{ subject: "", bodyHtml: "" }]);
        await load();
      }
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  }

  async function deleteTemplate(id: string) {
    if (!(await confirm({
      title: "Delete this ready-made template?",
      description:
        "Existing automations that reference it become dangling (their next run fails gracefully). This cannot be undone.",
      confirmLabel: "Delete",
    }))) {
      return;
    }
    setDeletingId(id);
    setError("");
    try {
      const res = await fetch(`/api/admin/campaign-templates/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(typeof data.error === "string" ? data.error : "Delete failed");
      } else {
        await load();
      }
    } catch {
      setError("Network error");
    } finally {
      setDeletingId(null);
    }
  }
return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold tracking-tight">Ready-made campaign templates</h2>
      </div>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Author the "Ready-made templates" group shown in the Automations builder. A template is
        a system-owned EmailCampaign with subject/body variants; every automation run clones it
        into its own campaign. Requires&nbsp;<code className="rounded bg-zinc-100 px-1 py-0.5 text-xs dark:bg-zinc-800">SYSTEM_TEMPLATES_USER_EMAIL</code>&nbsp;to be set.
      </p>

      {/* Create form */}
      <div className="mt-5 rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="px-4 py-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">New template</div>
        <div className="px-4 py-4">
          <div className="space-y-3">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Template name"
              className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-800"
            />
            {variantRows.map((row, i) => (
              <div key={i} className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
                <input
                  value={row.subject}
                  onChange={(e) => setVariantRows((prev) => {
                    const next = [...prev];
                    next[i] = { ...next[i], subject: e.target.value };
                    return next;
                  })}
                  placeholder={`Subject line ${i + 1}`}
                  className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-800"
                />
                <textarea
                  value={row.bodyHtml}
                  onChange={(e) => setVariantRows((prev) => {
                    const next = [...prev];
                    next[i] = { ...next[i], bodyHtml: e.target.value };
                    return next;
                  })}
                  placeholder="Body (HTML)"
                  rows={4}
                  className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-800"
                />
                <div className="flex justify-end">
                  <button
                    onClick={() => setVariantRows((prev) => (prev.length <= 1 ? prev : prev.filter((_, idx) => idx !== i)))}
                    disabled={variantRows.length <= 1}
                    className="rounded-lg border border-zinc-300 px-3 py-1 text-xs text-zinc-500 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => setVariantRows((prev) => [...prev, { subject: "", bodyHtml: "" }])}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              + Add subject/body variant
            </button>
            <button
              onClick={createTemplate}
              disabled={saving}
              className="rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
            >
              {saving ? "Creating…" : "Create template"}
            </button>
          </div>
        </div>
      </div>

      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
{loading ? (
        <p className="mt-6 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Variants</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {templates.map((t) => (
                <tr key={t.id}>
                  <td className="px-4 py-3 font-medium text-zinc-800 dark:text-zinc-200">{t.name}</td>
                  <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                    {t.variants.length === 0 ? "—" : t.variants.map((v) => `"${v.subject}"`).join(", ")}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => deleteTemplate(t.id)}
                      disabled={deletingId === t.id}
                      className="rounded-lg bg-red-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
                    >
                      {deletingId === t.id ? "Deleting…" : "Delete"}
                    </button>
                  </td>
                </tr>
              ))}
              {templates.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-6 text-zinc-500 dark:text-zinc-400">
                    No ready-made templates yet. Create one above.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
type IssuedLicenseResult = {
  licenseKey: string;
  product: string;
  productName: string;
  licensee: string;
  expiresAt: string;
  exeLicenseId: string;
  reused?: boolean;
};

function ExeLicensesTab() {
  const [email, setEmail] = useState("");
  const [productId, setProductId] = useState<string>(EXE_PRODUCTS[0].id);
  const [durationDays, setDurationDays] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<IssuedLicenseResult | null>(null);
  const [copied, setCopied] = useState(false);

  async function generate() {
    setBusy(true);
    setError("");
    setResult(null);
    setCopied(false);
    try {
      const res = await fetch("/api/admin/exe-licenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          product: productId,
          durationDays: durationDays === "" ? undefined : Number(durationDays),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<IssuedLicenseResult> & {
        error?: string;
      };
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Issue failed");
        return;
      }
      if (!data.licenseKey) {
        setError("The license was created but no key was returned.");
        return;
      }
      setResult(data as IssuedLicenseResult);
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  async function copyKey() {
    if (!result) return;
    const ok = await copyToClipboard(result.licenseKey);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      setError("Copy failed — select the key below manually.");
    }
  }

  return (
    <div>
      <h2 className="text-2xl font-semibold tracking-tight">EXE license generator</h2>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Manually issue a desktop-app license outside the checkout flow — a comp, an off-platform
        payment, or a support replacement. The key is signed for exactly one SpaceWorker tool
        (the same as a real purchase), so it can only be activated in that tool&apos;s EXE. If no
        account exists for the email yet, one is created automatically and sent a welcome email
        with the license + a link to set up account access — same as a real signup.
      </p>

      <div className="mt-5 rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="px-4 py-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">
          New license
        </div>
        <div className="space-y-3 px-4 py-4">
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Buyer email (any email — creates an account if needed)"
            className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-800"
          />
          <div className="flex flex-col gap-3 sm:flex-row">
            <select
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 sm:w-1/2"
            >
              {EXE_PRODUCTS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <input
              value={durationDays}
              onChange={(e) => setDurationDays(e.target.value)}
              type="number"
              min={1}
              placeholder="Duration (days) — blank = default (180)"
              className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 sm:w-1/2"
            />
          </div>
          <button
            onClick={generate}
            disabled={busy}
            className="rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
          >
            {busy ? "Issuing…" : "Generate license"}
          </button>
        </div>
      </div>

      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {result && (
        <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-300">
              {result.reused
                ? `Reused this buyer's existing license for ${result.productName}`
                : `License issued for ${result.productName}`}
            </p>
            <button
              onClick={copyKey}
              className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-emerald-500"
            >
              {copied ? "Copied!" : "Copy key"}
            </button>
          </div>
          <p className="mt-3 break-all rounded-lg bg-white p-3 font-mono text-xs text-zinc-800 shadow-sm dark:bg-zinc-900 dark:text-zinc-200">
            {result.licenseKey}
          </p>
          <p className="mt-3 text-xs text-emerald-700 dark:text-emerald-400">
            Buyer: {result.licensee} · Expires: {new Date(result.expiresAt).toLocaleString()} · Tracked
            as ExeLicense #{result.exeLicenseId}.
          </p>
        </div>
      )}

      <RecentLicensesTable />

      <ActiveTrialsSection />

      <ExeLicenseClaimSection />
    </div>
  );
}

interface AdminTrialRow {
  id: string;
  machineId: string;
  machineLabel: string | null;
  email: string | null;
  product: string;
  productName: string;
  startedAt: string;
  lastSeenAt: string;
  endsAt: string;
  hoursLeft: number;
}

// Owner-requested 2026-09-20: "a subtab showing every free users device
// active for that 24hrs, and can leave after they get binded." Server-side
// visibility into the EXE's otherwise entirely-local 24h trial (pinged by
// /api/exe-license/status whenever a device reports inTrial:true). Rows
// disappear on their own once the 24h window lapses (the GET route filters
// server-side) or once that machine claims a real license (also filtered
// server-side) — nothing to manually clear here.
function ActiveTrialsSection() {
  const [rows, setRows] = useState<AdminTrialRow[] | null>(null);
  const [error, setError] = useState("");

  async function load() {
    setError("");
    try {
      const res = await fetch("/api/admin/exe-trials");
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.trials)) {
        setRows(data.trials);
      } else {
        setError(typeof data.error === "string" ? data.error : "Failed to load active trials.");
      }
    } catch {
      setError("Network error loading active trials.");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="mt-8 rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between px-4 py-3">
        <div>
          <h3 className="text-lg font-semibold tracking-tight">Active trials (last 24h)</h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Unlicensed devices currently inside their free 24h trial window. Leaves this list once bound
            to a license, or once the trial lapses.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Refresh
        </button>
      </div>
      {error && <p className="px-4 pb-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {rows === null && !error && (
        <p className="px-4 pb-4 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
      )}
      {rows && rows.length === 0 && (
        <p className="px-4 pb-4 text-sm text-zinc-500 dark:text-zinc-400">No active trials right now.</p>
      )}
      {rows && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-t border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              <tr>
                <th className="px-4 py-2">Device</th>
                <th className="px-4 py-2">Email</th>
                <th className="px-4 py-2">Product</th>
                <th className="px-4 py-2">Started</th>
                <th className="px-4 py-2">Time left</th>
                <th className="px-4 py-2">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="px-4 py-2 font-mono text-xs" title={r.machineId}>
                    {r.machineLabel ?? r.machineId.slice(0, 16) + "…"}
                  </td>
                  <td className="px-4 py-2">
                    {r.email ? (
                      <span className="font-medium" title={r.email}>{r.email}</span>
                    ) : (
                      <span className="text-xs text-zinc-400 dark:text-zinc-500">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2">{r.productName}</td>
                  <td className="px-4 py-2">{new Date(r.startedAt).toLocaleString()}</td>
                  <td className="px-4 py-2">{r.hoursLeft.toFixed(1)}h</td>
                  <td className="px-4 py-2 text-zinc-500 dark:text-zinc-400">
                    {new Date(r.lastSeenAt).toLocaleString()}
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
// ============================================================================
// Task 50 — read-only admin visibility into the customer-facing outbound email
// surface (Mailboxes / Campaigns / Automations). Previously the admin API never
// queried any of these tables, so connected SMTP accounts and mass-campaign
// sends were invisible to the owner. These three tabs are deliberately READ-
// ONLY accountability surfaces — no pause/delete/edit lives here.
// ============================================================================

type AdminMailboxRow = {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  fromAddresses: string[];
  secure: boolean;
  active: boolean;
  dailyLimit: number;
  sentToday: number;
  sentTodayDate: string | null;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  queuedItems: number;
  userEmail: string;
  createdAt: string;
};

type AdminCampaignRow = {
  id: string;
  name: string;
  status: string;
  recipientCount: number;
  sentCount: number;
  searchJobId: string | null;
  batchSize: number;
  minSendDelaySeconds: number;
  maxSendDelaySeconds: number;
  sendingStartedAt: string | null;
  userEmail: string;
  createdAt: string;
};

type AdminAutomationRow = {
  id: string;
  name: string;
  leadSource: string;
  triggerMode: string;
  scheduleHour: number | null;
  scheduleEnabled: boolean;
  runCount: number;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunStartedAt: string | null;
  lastRunCompletedAt: string | null;
  userEmail: string;
  createdAt: string;
};

function MailboxesTab() {
  const [rows, setRows] = useState<AdminMailboxRow[] | null>(null);
  const [error, setError] = useState("");

  async function load() {
    setError("");
    try {
      const res = await fetch("/api/admin/mailboxes");
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.mailboxes)) setRows(data.mailboxes);
      else setError(typeof data.error === "string" ? data.error : "Failed to load mailboxes.");
    } catch {
      setError("Network error loading mailboxes.");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="mt-8 rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between px-4 py-3">
        <div>
          <h3 className="text-lg font-semibold tracking-tight">Mailboxes</h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Every connected SMTP mailbox across all users. Read-only — the credentials and the content are never shown.
          </p>
        </div>
        <button type="button" onClick={() => void load()} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">
          Refresh
        </button>
      </div>
      {error && <p className="px-4 pb-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {rows === null && !error && <p className="px-4 pb-4 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>}
      {rows && rows.length === 0 && <p className="px-4 pb-4 text-sm text-zinc-500 dark:text-zinc-400">No mailboxes connected.</p>}
      {rows && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-t border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              <tr>
                <th className="px-4 py-2">Label</th>
                <th className="px-4 py-2">SMTP host</th>
                <th className="px-4 py-2">User</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Sent today</th>
                <th className="px-4 py-2">Queue</th>
                <th className="px-4 py-2">Last test</th>
                <th className="px-4 py-2">Owner</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="px-4 py-2 font-medium" title={`${r.username}@${r.host}`}>{r.label}</td>
                  <td className="px-4 py-2 font-mono text-xs">{r.host}:{r.port}</td>
                  <td className="px-4 py-2 font-mono text-xs">{r.username}</td>
                  <td className="px-4 py-2"><StatusBadge status={r.active ? "approved" : "rejected"} /></td>
                  <td className="px-4 py-2">
                    <span className={r.sentToday >= r.dailyLimit ? "font-semibold text-red-600 dark:text-red-400" : ""}>
                      {r.sentToday} / {r.dailyLimit}
                    </span>
                  </td>
                  <td className="px-4 py-2">{r.queuedItems}</td>
                  <td className="px-4 py-2 text-zinc-500 dark:text-zinc-400">
                    {(r.lastTestOk === null ? "never" : r.lastTestOk ? "ok" : "failed") +
                      (r.lastTestedAt ? ` · ${new Date(r.lastTestedAt).toLocaleString()}` : "")}
                  </td>
                  <td className="px-4 py-2 text-zinc-500 dark:text-zinc-400">{r.userEmail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CampaignsTab() {
  const [rows, setRows] = useState<AdminCampaignRow[] | null>(null);
  const [error, setError] = useState("");

  async function load() {
    setError("");
    try {
      const res = await fetch("/api/admin/campaigns");
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.campaigns)) setRows(data.campaigns);
      else setError(typeof data.error === "string" ? data.error : "Failed to load campaigns.");
    } catch {
      setError("Network error loading campaigns.");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="mt-8 rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between px-4 py-3">
        <div>
          <h3 className="text-lg font-semibold tracking-tight">Campaigns</h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Every EmailCampaign across all users with send progress. Read-only.
          </p>
        </div>
        <button type="button" onClick={() => void load()} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">
          Refresh
        </button>
      </div>
      {error && <p className="px-4 pb-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {rows === null && !error && <p className="px-4 pb-4 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>}
      {rows && rows.length === 0 && <p className="px-4 pb-4 text-sm text-zinc-500 dark:text-zinc-400">No campaigns yet.</p>}
      {rows && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-t border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Recipients</th>
                <th className="px-4 py-2">Sent</th>
                <th className="px-4 py-2">Batch</th>
                <th className="px-4 py-2">Pace (s)</th>
                <th className="px-4 py-2">Sending since</th>
                <th className="px-4 py-2">Owner</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="px-4 py-2 font-medium" title={r.id}>{r.name}</td>
                  <td className="px-4 py-2"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${r.status === "paused_deliverability" ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400" : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"}`}>{r.status}</span></td>
                  <td className="px-4 py-2">{r.recipientCount}</td>
                  <td className="px-4 py-2">{r.sentCount}</td>
                  <td className="px-4 py-2">{r.batchSize}</td>
                  <td className="px-4 py-2">{r.minSendDelaySeconds}–{r.maxSendDelaySeconds}</td>
                  <td className="px-4 py-2 text-zinc-500 dark:text-zinc-400">{r.sendingStartedAt ? new Date(r.sendingStartedAt).toLocaleString() : "—"}</td>
                  <td className="px-4 py-2 text-zinc-500 dark:text-zinc-400">{r.userEmail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AutomationsTab() {
  const [rows, setRows] = useState<AdminAutomationRow[] | null>(null);
  const [error, setError] = useState("");

  async function load() {
    setError("");
    try {
      const res = await fetch("/api/admin/automations");
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.automations)) setRows(data.automations);
      else setError(typeof data.error === "string" ? data.error : "Failed to load automations.");
    } catch {
      setError("Network error loading automations.");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="mt-8 rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between px-4 py-3">
        <div>
          <h3 className="text-lg font-semibold tracking-tight">Automations</h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Every recurring/scheduled CampaignAutomation across all users with last-run outcome. Read-only.
          </p>
        </div>
        <button type="button" onClick={() => void load()} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">
          Refresh
        </button>
      </div>
      {error && <p className="px-4 pb-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {rows === null && !error && <p className="px-4 pb-4 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>}
      {rows && rows.length === 0 && <p className="px-4 pb-4 text-sm text-zinc-500 dark:text-zinc-400">No automations yet.</p>}
      {rows && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-t border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Source</th>
                <th className="px-4 py-2">Trigger</th>
                <th className="px-4 py-2">Schedule</th>
                <th className="px-4 py-2">Runs</th>
                <th className="px-4 py-2">Last run</th>
                <th className="px-4 py-2">Last status</th>
                <th className="px-4 py-2">Owner</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="px-4 py-2 font-medium">{r.name}</td>
                  <td className="px-4 py-2">{r.leadSource}</td>
                  <td className="px-4 py-2">{r.triggerMode}</td>
                  <td className="px-4 py-2">
                    {r.triggerMode === "daily" && r.scheduleHour !== null ? `daily ${r.scheduleHour}:00 UTC` : r.scheduleEnabled ? "on" : "paused"}
                  </td>
                  <td className="px-4 py-2">{r.runCount}</td>
                  <td className="px-4 py-2 text-zinc-500 dark:text-zinc-400">{r.lastRunAt ? new Date(r.lastRunAt).toLocaleString() : "never"}</td>
                  <td className="px-4 py-2"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${r.lastRunStatus === "failed" ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400" : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"}`}>{r.lastRunStatus ?? "—"}</span></td>
                  <td className="px-4 py-2 text-zinc-500 dark:text-zinc-400">{r.userEmail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
// Confirmed live (2026-09-19) — before this, the only way to see a license at
// all was to already know the buyer's email and search for it; a freshly
// issued or self-service-bound license had no visibility anywhere in admin
// unless someone thought to look for that specific person. Loads on mount,
// no email needed — the 100 most recent licenses across every buyer, same
// live table every issue/bind/transfer/unbind action already writes to.
/** Groups by buyer + product — one license per (email, product) is the norm;
 * more than one is either a stale duplicate or a genuine multi-device case. */
function licenseGroupKey(r: AdminLicenseRow): string {
  return `${(r.email ?? "").toLowerCase()}::${r.product}`;
}

function RecentLicensesTable() {
  const confirm = useConfirm();
  const [rows, setRows] = useState<AdminLicenseRow[] | null>(null);
  const [error, setError] = useState("");
  const [openHistoryGroup, setOpenHistoryGroup] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await fetch("/api/admin/exe-licenses");
      const data = (await res.json().catch(() => ({}))) as { licenses?: AdminLicenseRow[]; error?: string };
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Couldn't load recent licenses.");
        setRows([]);
        return;
      }
      setRows(data.licenses ?? []);
    } catch {
      setError("Network error loading recent licenses.");
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function deleteRow(r: AdminLicenseRow) {
    if (
      !(await confirm({
        title: "Delete this license row?",
        description: r.boundMachineId
          ? "It's currently bound to a device — the buyer's activation stops working immediately. Only do this for a confirmed stale duplicate, never their real one."
          : "This can't be undone.",
        confirmLabel: "Delete",
        confirmVariant: "danger",
      }))
    ) {
      return;
    }
    setDeletingId(r.id);
    try {
      const res = await fetch("/api/admin/exe-licenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", email: r.email, exeLicenseId: r.id }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Couldn't delete the license.");
        return;
      }
      await load();
    } catch {
      setError("Network error deleting the license.");
    } finally {
      setDeletingId(null);
    }
  }

  // Owner-requested 2026-09-21 — a direct "Revoke" button right on the
  // current/bound row, instead of only via the separate "Unbind a license"
  // form further down the page (which requires re-typing the email and
  // re-selecting the license). Reuses the SAME existing action:"unbind" call
  // deleteRow's sibling already makes.
  //
  // IMPORTANT LIMITATION (checked live in app/api/exe-license/status/route.ts,
  // 2026-09-21): this clears the SERVER-side binding, but an already-activated
  // device validates ITS stored key purely LOCALLY (signature + machine-id,
  // offline) — it never calls back to the server to re-check the binding is
  // still current. So Revoke does NOT immediately cut off a device that's
  // already running and activated; it takes effect the next time that
  // device's local state is lost/reset or it goes through activate/claim
  // again. Unlike Vantra, there is currently no live re-validation ping for
  // an already-activated device — true instant cutoff would need one (a
  // periodic check mirroring Vantra's stillValidLive), which doesn't exist
  // yet. Said plainly in the confirm dialog below rather than overclaiming.
  // The license row itself survives, unclaimed and ready for a fresh bind, exactly like a
  // never-claimed issue.
  async function revokeRow(r: AdminLicenseRow) {
    if (
      !(await confirm({
        title: "Revoke this license?",
        description: `Clears ${r.boundMachineLabel || "this device"}'s binding server-side and frees the license for a new bind. Note: an already-running activated app validates locally and won't be cut off immediately — this takes effect once that device re-activates or its local state resets.`,
        confirmLabel: "Revoke",
        confirmVariant: "danger",
      }))
    ) {
      return;
    }
    setRevokingId(r.id);
    try {
      const res = await fetch("/api/admin/exe-licenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "unbind", email: r.email, exeLicenseId: r.id }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Couldn't revoke the license.");
        return;
      }
      await load();
    } catch {
      setError("Network error revoking the license.");
    } finally {
      setRevokingId(null);
    }
  }

  // Consolidated view (2026-09-19) — group by (buyer, product) so a buyer with
  // leftover duplicate rows (minted before the reuse-on-issue fix) shows up
  // once, not once per row. Zero or one bound row per group is the expected
  // case (that row is "current"); more than one is surfaced in full instead
  // of silently picking one to show.
  const groups: AdminLicenseRow[][] = [];
  if (rows) {
    const map = new Map<string, AdminLicenseRow[]>();
    for (const r of rows) {
      const k = licenseGroupKey(r);
      const arr = map.get(k);
      if (arr) arr.push(r);
      else map.set(k, [r]);
    }
    groups.push(...map.values());
  }

  return (
    <div className="mt-8">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold tracking-tight">Recent licenses (every buyer)</h3>
        <button
          onClick={() => void load()}
          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
        >
          Refresh
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {rows === null ? (
        <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">No licenses issued yet.</p>
      ) : (
        <div className="mt-3 space-y-3">
          {groups.map((group) => {
            const bound = group.filter((r) => r.boundMachineId);
            const current = bound.length === 1 ? bound[0] : bound.length === 0 ? group[0] : null;
            const reviewRows = current ? [] : bound;
            const history = current
              ? group.filter((r) => r.id !== current.id)
              : group.filter((r) => !r.boundMachineId);
            const first = group[0];
            const gKey = licenseGroupKey(first);

            const statusBadge = (r: AdminLicenseRow) =>
              r.boundMachineId ? (
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
                  Bound{r.boundMachineLabel ? ` — ${r.boundMachineLabel}` : ""}
                </span>
              ) : (
                <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                  Unclaimed
                </span>
              );

            return (
              <div
                key={gKey}
                className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                    {first.email ?? "—"}
                  </span>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">{first.productName}</span>
                  {reviewRows.length > 0 && (
                    <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/40 dark:text-red-400">
                      {reviewRows.length} bound licenses — review before touching either
                    </span>
                  )}
                </div>

                {(reviewRows.length > 0 ? reviewRows : current ? [current] : []).map((r) => (
                  <div key={r.id} className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-zinc-500 dark:text-zinc-400">
                      Issued {new Date(r.issuedAt).toLocaleString()}
                    </span>
                    {statusBadge(r)}
                    {r.boundMachineId ? (
                      <button
                        onClick={() => void revokeRow(r)}
                        disabled={revokingId === r.id}
                        className="rounded-lg border border-red-300 px-2 py-1 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
                      >
                        {revokingId === r.id ? "Revoking…" : "Revoke"}
                      </button>
                    ) : (
                      // Owner-requested 2026-09-21 — an unclaimed license had no
                      // action here at all; "revoke" for a never-bound license
                      // means deleting the row outright (no binding to clear).
                      // Same deleteRow() the history list already uses.
                      <button
                        onClick={() => void deleteRow(r)}
                        disabled={deletingId === r.id}
                        className="rounded-lg border border-red-300 px-2 py-1 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
                      >
                        {deletingId === r.id ? "Revoking…" : "Revoke"}
                      </button>
                    )}
                  </div>
                ))}

                {history.length > 0 && (
                  <div className="mt-3 border-t border-zinc-100 pt-2 dark:border-zinc-800">
                    <button
                      onClick={() => setOpenHistoryGroup(openHistoryGroup === gKey ? null : gKey)}
                      className="text-xs font-medium text-zinc-600 hover:underline dark:text-zinc-400"
                    >
                      {openHistoryGroup === gKey ? "Hide" : "Show"} history ({history.length})
                    </button>
                    {openHistoryGroup === gKey && (
                      <ul className="mt-2 space-y-2">
                        {history.map((r) => (
                          <li
                            key={r.id}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-zinc-50 p-2 text-xs text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-400"
                          >
                            <span>
                              Issued {new Date(r.issuedAt).toLocaleString()} · {statusBadge(r)}
                            </span>
                            <button
                              onClick={() => void deleteRow(r)}
                              disabled={deletingId === r.id}
                              className="rounded-lg border border-red-300 px-2 py-1 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
                            >
                              {deletingId === r.id ? "Deleting…" : "Delete"}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Task 47 — CLAIM an existing (unbound) license to a machine. The admin manual
// tool that actually locks a real customer's license to one device. Uses the
// SAME existing generator route (/api/admin/exe-licenses), extended with an
// action:"bind" + a GET list — not a second, separate generator.

type AdminLicenseRow = {
  id: string;
  email?: string;
  product: string;
  productName: string;
  issuedAt: string;
  boundMachineId: string | null;
  boundMachineLabel: string | null;
  boundLicenseKey: string | null;
  boundAt: string | null;
};

type AdminBindResult = {
  licenseKey: string;
  boundMachineId: string;
  boundMachineLabel: string | null;
  productName: string;
  expiresAt: string;
};

type AdminTransferResult = {
  licenseKey: string;
  boundMachineId: string;
  boundMachineLabel: string | null;
  movedFromMachineId: string | null;
  productName: string;
  expiresAt: string;
};

function ExeLicenseClaimSection() {
  const confirm = useConfirm();
  const [email, setEmail] = useState("");
  const [licenses, setLicenses] = useState<AdminLicenseRow[] | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [machineId, setMachineId] = useState("");
  const [machineLabel, setMachineLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<AdminBindResult | null>(null);

  // Task 47 addition — device-transfer state (move an already-bound license).
  const [transferSelectedId, setTransferSelectedId] = useState("");
  const [transferMachineId, setTransferMachineId] = useState("");
  const [transferMachineLabel, setTransferMachineLabel] = useState("");
  const [transferNote, setTransferNote] = useState("");
  const [transferResult, setTransferResult] = useState<AdminTransferResult | null>(null);
  const [transferError, setTransferError] = useState("");

  // Unbind — clear a binding back to "unclaimed" (support/testing reset).
  const [unbindSelectedId, setUnbindSelectedId] = useState("");
  const [unbindResult, setUnbindResult] = useState<string | null>(null);
  const [unbindError, setUnbindError] = useState("");

  async function loadLicenses() {
    if (!email.includes("@")) {
      setError("Enter the buyer's email first.");
      return;
    }
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const res = await fetch(`/api/admin/exe-licenses?email=${encodeURIComponent(email)}`);
      const data = (await res.json().catch(() => ({}))) as {
        licenses?: AdminLicenseRow[];
        error?: string;
      };
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Couldn't load licenses.");
        setLicenses([]);
        return;
      }
      const rows = data.licenses ?? [];
      setLicenses(rows);
      const firstUnbound = rows.find((r) => !r.boundMachineId);
      setSelectedId(firstUnbound ? firstUnbound.id : "");
      const firstBound = rows.find((r) => r.boundMachineId);
      setTransferSelectedId(firstBound ? firstBound.id : "");
      setTransferResult(null);
      setTransferError("");
      setUnbindSelectedId(firstBound ? firstBound.id : "");
      setUnbindResult(null);
      setUnbindError("");
    } catch {
      setError("Network error loading licenses.");
      setLicenses([]);
    } finally {
      setBusy(false);
    }
  }

  async function bind() {
    if (!selectedId || !machineId.trim() || busy) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const res = await fetch("/api/admin/exe-licenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "bind",
          email,
          exeLicenseId: selectedId,
          machineId: machineId.trim(),
          machineLabel: machineLabel.trim() ? machineLabel.trim() : undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<AdminBindResult> & {
        error?: string;
      };
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Claim failed.");
        return;
      }
      if (!data.licenseKey) {
        setError("The license was claimed but no key was returned.");
        return;
      }
      setResult(data as AdminBindResult);
      await loadLicenses();
    } catch {
      setError("Network error claiming the license.");
    } finally {
      setBusy(false);
    }
  }

  async function transfer() {
    if (!transferSelectedId || !transferMachineId.trim() || busy) return;
    setBusy(true);
    setTransferError("");
    setTransferResult(null);
    try {
      const res = await fetch("/api/admin/exe-licenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "transfer",
          email,
          exeLicenseId: transferSelectedId,
          newMachineId: transferMachineId.trim(),
          newMachineLabel: transferMachineLabel.trim() ? transferMachineLabel.trim() : undefined,
          note: transferNote.trim() ? transferNote.trim() : undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<AdminTransferResult> & {
        error?: string;
      };
      if (!res.ok) {
        setTransferError(typeof data.error === "string" ? data.error : "Transfer failed.");
        return;
      }
      if (!data.licenseKey) {
        setTransferError("The license was transferred but no key was returned.");
        return;
      }
      setTransferResult(data as AdminTransferResult);
      await loadLicenses();
    } catch {
      setTransferError("Network error transferring the license.");
    } finally {
      setBusy(false);
    }
  }

  async function unbind() {
    if (!unbindSelectedId || busy) return;
    if (
      !(await confirm({
        title: "Clear this license's device binding?",
        description:
          "The current machine's key stops working immediately, and the license goes back to unclaimed — ready for a fresh bind.",
        confirmLabel: "Unbind",
        confirmVariant: "danger",
      }))
    ) {
      return;
    }
    setBusy(true);
    setUnbindError("");
    setUnbindResult(null);
    try {
      const res = await fetch("/api/admin/exe-licenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "unbind", email, exeLicenseId: unbindSelectedId }),
      });
      const data = (await res.json().catch(() => ({}))) as { unbound?: boolean; error?: string };
      if (!res.ok) {
        setUnbindError(typeof data.error === "string" ? data.error : "Unbind failed.");
        return;
      }
      setUnbindResult("License unbound — it's unclaimed again and ready for a fresh bind.");
      await loadLicenses();
    } catch {
      setUnbindError("Network error unbinding the license.");
    } finally {
      setBusy(false);
    }
  }

  const unbound = (licenses ?? []).filter((r) => !r.boundMachineId);
  const bound = (licenses ?? []).filter((r) => r.boundMachineId);
return (
    <div className="mt-8">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold tracking-tight">Claim an existing license</h3>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          Lock an issued key to one customer device (one-machine guarantee)
        </span>
      </div>

      <div className="mt-3 space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setLicenses(null);
              setResult(null);
            }}
            placeholder="Buyer email (must match an existing account)"
            className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 sm:w-1/2"
          />
          <button
            onClick={loadLicenses}
            disabled={busy}
            className="rounded-lg bg-zinc-200 px-4 py-2 text-sm font-medium text-zinc-800 transition-colors hover:bg-zinc-300 disabled:opacity-50 dark:bg-zinc-700 dark:text-zinc-200"
          >
            {busy ? "Loading…" : "Load buyer's licenses"}
          </button>
        </div>

        {licenses && licenses.length === 0 && (
          <p className="text-sm text-zinc-500">No licenses found for this buyer.</p>
        )}

        {licenses && licenses.length > 0 && (
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-800"
          >
            {licenses.map((r) => (
              <option key={r.id} value={r.id} disabled={!!r.boundMachineId}>
                {r.productName} (#{r.id.slice(0, 8)})
                {r.boundMachineId ? ` — already bound to ${r.boundMachineId}` : " — unclaimed"}
              </option>
            ))}
          </select>
        )}

        {unbound.length === 0 && licenses && licenses.length > 0 && (
          <p className="text-sm text-amber-700 dark:text-amber-400">
            All of this buyer&rsquo;s licenses are already bound to a device.
          </p>
        )}

        {unbound.length > 0 && (
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={machineId}
              onChange={(e) => setMachineId(e.target.value)}
              placeholder="Device ID (from the customer's app)"
              className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 sm:w-1/2"
            />
            <input
              value={machineLabel}
              onChange={(e) => setMachineLabel(e.target.value)}
              placeholder="Device label (optional)"
              className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 sm:w-1/2"
            />
            <button
              onClick={bind}
              disabled={busy || !selectedId || !machineId.trim()}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
            >
              {busy ? "Claiming…" : "Claim to device"}
            </button>
          </div>
        )}

        {error && <p className="mt-1 text-sm text-red-600 dark:text-red-400">{error}</p>}

        {result && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950">
            <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-300">
              License claimed — activation key for {result.productName}
            </p>
            <p className="mt-3 break-all rounded-lg bg-white p-3 font-mono text-xs text-zinc-800 shadow-sm dark:bg-zinc-900 dark:text-zinc-200">
              {result.licenseKey}
            </p>
            <p className="mt-3 text-xs text-emerald-700 dark:text-emerald-400">
              Bound to device {result.boundMachineId}
              {result.boundMachineLabel ? ` (${result.boundMachineLabel})` : ""} · Expires:{" "}
              {new Date(result.expiresAt).toLocaleString()} — send this activation key to the buyer.
            </p>
          </div>
        )}

        <hr className="my-5 border-zinc-200 dark:border-zinc-800" />
        <div className="pt-2">
          <div className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
            Transfer a bound license to a new device{" "}
            <span className="font-normal text-zinc-500">
              (admin/support action — deliberately overwrites the current device binding)
            </span>
          </div>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            For a legitimate hardware replacement: moves an already-claimed license to a new
            Device ID. Preserves the original expiry, invalidates the old machine&rsquo;s key, and
            records the move in the license&rsquo;s audit log.
          </p>

          {licenses && bound.length === 0 && (
            <p className="mt-2 text-sm text-zinc-500">No bound licenses to transfer — claim one above first.</p>
          )}

          {bound.length > 0 && (
            <div className="mt-3 space-y-2">
              <select
                value={transferSelectedId}
                onChange={(e) => setTransferSelectedId(e.target.value)}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-800"
              >
                {bound.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.productName} (#{r.id.slice(0, 8)}) — bound to {r.boundMachineId}
                    {r.boundMachineLabel ? ` (${r.boundMachineLabel})` : ""}
                  </option>
                ))}
              </select>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  value={transferMachineId}
                  onChange={(e) => setTransferMachineId(e.target.value)}
                  placeholder="New Device ID (from the customer's new app)"
                  className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 sm:w-1/3"
                />
                <input
                  value={transferMachineLabel}
                  onChange={(e) => setTransferMachineLabel(e.target.value)}
                  placeholder="New device label (optional)"
                  className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 sm:w-1/3"
                />
                <input
                  value={transferNote}
                  onChange={(e) => setTransferNote(e.target.value)}
                  placeholder="Support note (optional, e.g. 'replaced laptop')"
                  className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 sm:w-1/3"
                />
                <button
                  onClick={transfer}
                  disabled={busy || !transferSelectedId || !transferMachineId.trim()}
                  className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-rose-500 disabled:opacity-50"
                >
                  {busy ? "Transferring…" : "Transfer device"}
                </button>
              </div>
            </div>
          )}

          {transferError && <p className="mt-1 text-sm text-red-600 dark:text-red-400">{transferError}</p>}

          {transferResult && (
            <div className="mt-2 rounded-xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950">
              <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-300">
                License transferred — {transferResult.productName} moved from{" "}
                {transferResult.movedFromMachineId ?? "(unknown)"} to {transferResult.boundMachineId}
              </p>
              <p className="mt-3 break-all rounded-lg bg-white p-3 font-mono text-xs text-zinc-800 shadow-sm dark:bg-zinc-900 dark:text-zinc-200">
                {transferResult.licenseKey}
              </p>
              <p className="mt-3 text-xs text-emerald-700 dark:text-emerald-400">
                New bound device {transferResult.boundMachineId}
                {transferResult.boundMachineLabel ? ` (${transferResult.boundMachineLabel})` : ""} · Expires:{" "}
                {new Date(transferResult.expiresAt).toLocaleString()} — send this activation key to the buyer.
                The old machine&rsquo;s key no longer validates.
              </p>
            </div>
          )}

          <hr className="my-5 border-zinc-200 dark:border-zinc-800" />
          <div className="pt-2">
            <div className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
              Unbind a license{" "}
              <span className="font-normal text-zinc-500">
                (support/testing reset — clears the binding entirely, no replacement device)
              </span>
            </div>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              Resets a bound license back to unclaimed, same as a license that&rsquo;s never been
              claimed — the next bind (self-service or here) issues a fresh activation key. Use this
              to reset a test account, or when a buyer needs a clean re-claim instead of a straight
              device-to-device move.
            </p>

            {bound.length > 0 && (
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <select
                  value={unbindSelectedId}
                  onChange={(e) => setUnbindSelectedId(e.target.value)}
                  className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 sm:w-2/3"
                >
                  {bound.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.productName} (#{r.id.slice(0, 8)}) — bound to {r.boundMachineId}
                      {r.boundMachineLabel ? ` (${r.boundMachineLabel})` : ""}
                    </option>
                  ))}
                </select>
                <button
                  onClick={unbind}
                  disabled={busy || !unbindSelectedId}
                  className="rounded-lg bg-zinc-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-600 disabled:opacity-50"
                >
                  {busy ? "Unbinding…" : "Unbind"}
                </button>
              </div>
            )}

            {unbindError && <p className="mt-1 text-sm text-red-600 dark:text-red-400">{unbindError}</p>}
            {unbindResult && (
              <p className="mt-2 text-sm text-emerald-700 dark:text-emerald-400">{unbindResult}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
