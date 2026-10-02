"use client";

import { useCallback, useEffect, useState } from "react";

// TASK_156 C1 (PLAN_TASK_156 §12.1 + §12.8) — the READ-ONLY Research admin page.
//
// §12.1's rule is that a tool is added because it is CURRENT, not because it is
// famous — this page makes currency a fact that can be SHOWN: the pinned MITRE
// ATT&CK release and pin date, the feeds the cadence refreshes, the refresh/stale
// windows, and every LabToolCatalog row with its last-reviewed date and a hard
// "refresh required" flag once its `staleAfter` has passed.
//
// §12.8 scopes C1 to READ-ONLY: the scheduled pull job is C2+ work, so this page
// fetches state and renders it — no pulls, no attacks.

export type ResearchStatePayload = {
  attackRelease: {
    version: string;
    lineOpenedAt: string;
    releasedAt: string;
    pinnedAt: string;
    source: string;
  };
  feeds: Array<{ id: string; label: string; url: string; refreshes: string }>;
  refreshDays: number;
  nextRefreshDueAt: string;
  toolStaleAfterDays: number;
  catalog: {
    total: number;
    visible: number;
    stale: number;
    disabled: number;
    byClass: Record<string, number>;
  };
  // Prisma Dates arrive over JSON as ISO strings — hence string, not Date.
  catalogRows?: Array<{
    id: string;
    slug: string;
    name: string;
    klass: string;
    kind: string;
    licence: string | null;
    techniqueIds: string[] | null;
    lastReviewedAt: string | null;
    staleAfter: string | null;
    enabled: boolean;
    stale: boolean;
  }>;
};

function useResearchState() {
  const [data, setData] = useState<ResearchStatePayload | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/admin/cyberlab/research");
      if (!res.ok) throw new Error("Failed to load research state");
      setData((await res.json()) as ResearchStatePayload);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load research state");
    } finally {
      setLoading(false);
    }
  }, []);

  // House pattern (cf. components/hosting-panel.tsx): fire-and-forget on mount so
  // the effect body itself returns void, not a setState promise.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- every setState in load is behind the fetch await, not synchronous
    void load();
  }, [load]);

  return { data, error, loading, load };
}

function fmtLabDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : "—";
}

export function ResearchTab() {
  const { data, error, loading, load } = useResearchState();
  const rows = data?.catalogRows ?? [];

  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold tracking-tight">Research &amp; tool currency</h2>
        <button
          onClick={load}
          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
        >
          Refresh
        </button>
      </div>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        TASK_156 §12.1 — a tool is added because it is <em>current</em>, not because it is famous. Read-only: the
        scheduled feed pull is C2+ work; this page shows the pin, the feeds, and every catalog row&apos;s currency.
      </p>

      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {loading && !data ? (
        <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
      ) : data ? (
        <div className="mt-6 space-y-6">
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <div className="text-xs uppercase tracking-wide text-zinc-500">Pinned ATT&amp;CK release</div>
              <div className="mt-1 text-lg font-medium text-zinc-900 dark:text-zinc-100">
                v{data.attackRelease.version}
              </div>
              <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                released {data.attackRelease.releasedAt} · pinned {data.attackRelease.pinnedAt}
              </div>
            </div>
            <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <div className="text-xs uppercase tracking-wide text-zinc-500">Next refresh due</div>
              <div className="mt-1 text-lg font-medium text-zinc-900 dark:text-zinc-100">{data.nextRefreshDueAt}</div>
              <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">every {data.refreshDays} days</div>
            </div>
            <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <div className="text-xs uppercase tracking-wide text-zinc-500">Tool currency window</div>
              <div className="mt-1 text-lg font-medium text-zinc-900 dark:text-zinc-100">
                {data.toolStaleAfterDays} days
              </div>
              <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">then hidden until re-reviewed</div>
            </div>
            <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <div className="text-xs uppercase tracking-wide text-zinc-500">Catalog currency</div>
              <div className="mt-1 text-lg font-medium text-zinc-900 dark:text-zinc-100">
                {data.catalog.visible} / {data.catalog.total} visible
              </div>
              <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                {data.catalog.stale} stale · {data.catalog.disabled} disabled
              </div>
            </div>
          </section>

          <section>
            <h3 className="text-lg font-semibold tracking-tight">Feeds the cadence refreshes</h3>
            <div className="mt-3 flex flex-col gap-2">
              {data.feeds.map((f) => (
                <div
                  key={f.id}
                  className="flex flex-wrap items-baseline justify-between gap-2 rounded-xl border border-zinc-200 bg-white p-3 text-sm shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
                >
                  <div>
                    <span className="font-medium text-zinc-900 dark:text-zinc-100">{f.label}</span>
                    <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">{f.refreshes}</span>
                  </div>
                  <a
                    href={f.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-zinc-500 underline-offset-4 hover:underline dark:text-zinc-400"
                  >
                    {f.url.replace(/^https?:\/\//, "")}
                  </a>
                </div>
              ))}
            </div>
          </section>

          {/*CATALOG*/}
          <section>
            <h3 className="text-lg font-semibold tracking-tight">LabToolCatalog</h3>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              A row whose <code className="rounded bg-zinc-100 px-1 text-xs dark:bg-zinc-800">staleAfter</code> has
              passed is hidden from the customer-facing chooser and flagged as <em>refresh required</em>.
            </p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[52rem] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
                    <th className="px-2 py-2">Tool</th>
                    <th className="px-2 py-2">Class</th>
                    <th className="px-2 py-2">Kind</th>
                    <th className="px-2 py-2">ATT&amp;CK</th>
                    <th className="px-2 py-2">Licence</th>
                    <th className="px-2 py-2">Reviewed</th>
                    <th className="px-2 py-2">Refresh by</th>
                    <th className="px-2 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-zinc-100 dark:border-zinc-800/60">
                      <td className="px-2 py-2">
                        <span className="font-medium text-zinc-900 dark:text-zinc-100">{r.name}</span>
                        <span className="ml-2 text-xs text-zinc-400">{r.slug}</span>
                      </td>
                      <td className="px-2 py-2 text-zinc-600 dark:text-zinc-400">{r.klass}</td>
                      <td className="px-2 py-2 text-zinc-600 dark:text-zinc-400">{r.kind}</td>
                      <td className="px-2 py-2 text-zinc-600 dark:text-zinc-400">
                        {r.techniqueIds && r.techniqueIds.length > 0 ? r.techniqueIds.join(", ") : "—"}
                      </td>
                      <td className="px-2 py-2 text-zinc-600 dark:text-zinc-400">{r.licence ?? "—"}</td>
                      <td className="px-2 py-2 text-zinc-600 dark:text-zinc-400">{fmtLabDate(r.lastReviewedAt)}</td>
                      <td className="px-2 py-2 text-zinc-600 dark:text-zinc-400">{fmtLabDate(r.staleAfter)}</td>
                      <td className="px-2 py-2">
                        {!r.enabled ? (
                          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                            disabled
                          </span>
                        ) : r.stale ? (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
                            refresh required
                          </span>
                        ) : (
                          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
                            current
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-2 py-4 text-center text-sm text-zinc-500 dark:text-zinc-400">
                        No catalog rows yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
