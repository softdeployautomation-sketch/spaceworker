"use client";

// TASK_195 S2 — the admin "Health" tab: run the read-only QA battery with one
// click and read the exact same report the CLI prints on the box.
//
// Deliberate design points:
//  * Click-to-run only — no auto-run on mount/visibility. The battery hits
//    the app over HTTP, scans .next chunks and stats the disk; opening the
//    tab should cost nothing.
//  * Response types are declared LOCALLY on purpose: lib/qa/battery.ts pulls
//    node:fs and the prisma singleton and must never enter a client bundle.
//  * Nothing here formats or stores secret values — the battery guarantees
//    probes report booleans/counts only (its header rule 2).

import { useState } from "react";

type QaStatus = "pass" | "warn" | "fail" | "skip";

interface QaProbeView {
  id: string;
  group: string;
  label: string;
  status: QaStatus;
  detail?: string;
  ms?: number;
}

interface QaReportView {
  ranAt: string;
  origin: string;
  durationMs: number;
  probes: QaProbeView[];
  counts: { pass: number; warn: number; fail: number; skip: number };
}

const STATUS_STYLES: Record<QaStatus, string> = {
  pass: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  warn: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  fail: "bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  skip: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
};

const STATUS_LABEL: Record<QaStatus, string> = {
  pass: "PASS",
  warn: "WARN",
  fail: "FAIL",
  skip: "SKIP",
};


export function HealthPanel() {
  const [report, setReport] = useState<QaReportView | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(): Promise<void> {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/health", { cache: "no-store" });
      if (!res.ok) {
        setError(`battery failed: HTTP ${res.status}`);
        return;
      }
      setReport((await res.json()) as QaReportView);
    } catch (e) {
      setError(e instanceof Error ? e.message : "network error");
    } finally {
      setRunning(false);
    }
  }

  const c = report?.counts;
  const banner = !report
    ? null
    : c && c.fail > 0
      ? {
          text: `RESULT: FAIL — ${c.fail} probe(s) failed. Fix before trusting this deploy.`,
          cls: "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200",
        }
      : c && c.warn > 0
        ? {
            text: `RESULT: OK with warnings — ${c.warn} WARN probe(s). Read each below.`,
            cls: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200",
          }
        : {
            text: "RESULT: ALL GREEN.",
            cls: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
          };

  // Group probes by their group, preserving battery order.
  const grouped: Array<{ group: string; probes: QaProbeView[] }> = [];
  for (const p of report?.probes ?? []) {
    const last = grouped[grouped.length - 1];
    if (last && last.group === p.group) last.probes.push(p);
    else grouped.push({ group: p.group, probes: [p] });
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => void run()}
          disabled={running}
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {running ? "Running battery…" : report ? "Run again" : "Run health battery"}
        </button>
        {report && (
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            ran {report.ranAt} · origin {report.origin} · {report.durationMs} ms
          </span>
        )}
      </div>

      {error && (
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200">
          {error}
        </p>
      )}

      {banner && (
        <p className={`rounded-lg border px-3 py-2 text-sm font-medium ${banner.cls}`}>
          {banner.text}
        </p>
      )}

      {report && (
        <div className="space-y-4">
          {grouped.map(({ group, probes }) => (
            <div key={group} className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
              <div className="bg-zinc-50 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
                {group}
              </div>
              <table className="w-full text-sm">
                <tbody>
                  {probes.map((p) => (
                    <tr key={p.id} className="border-t border-zinc-100 dark:border-zinc-800/60">
                      <td className="w-16 px-3 py-1.5">
                        <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${STATUS_STYLES[p.status]}`}>
                          {STATUS_LABEL[p.status]}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-zinc-700 dark:text-zinc-300">{p.label}</td>
                      <td className="px-3 py-1.5 text-right text-xs text-zinc-500 dark:text-zinc-400">
                        {p.detail ?? ""}
                        {p.ms !== undefined ? ` · ${p.ms} ms` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Read-only battery — sweeps are probed for their auth guard only and never executed.
            Manual checks a battery cannot cover: agent install on a Windows VM, wrapper download
            dialog, invoice → support-badge e2e.
          </p>
        </div>
      )}

      {!report && !error && (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Not run yet. Runs every probe group against this live instance (a few seconds).
        </p>
      )}
    </section>
  );
}
