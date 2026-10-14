"use client";

import { useCallback, useEffect, useState } from "react";

// TASK_156B C2b (PLAN_TASK_156 §13.3, build order item 3) — admin traceability:
// ONE tab listing ALL lab runs across ALL users, with the §5.2 refusals beside
// them (a trail that hid refusals would be dishonest). Each run shows the attack
// view (scenario, techniques, outcome) with the signature VERIFIED recomputed
// server-side; expanding an episode reveals the defence view (telemetry
// signatures + the victim-sensor envelope when one was captured).
//
// READ-ONLY by design: this observes; it never starts, edits or clears
// anything. Episodes are append-only server-side, so there is nothing here
// that could rewrite history.

type LabRunRow = {
  rangeId: string;
  userId: string;
  userEmail: string | null;
  state: string;
  error: string | null;
  ttlExpiresAt: string | null;
  teardownVerifiedAt: string | null;
  createdAt: string;
  scenario: { slug: string; name: string; klass: string } | null;
  episode: {
    id: string;
    startedAt: string | null;
    endedAt: string | null;
    outcome: string | null;
    techniques: unknown;
    telemetrySignatures: unknown;
    signedHash: string | null;
    signatureValid: boolean;
  } | null;
};

type AbuseReportRow = {
  id: string;
  userId: string;
  userEmail: string | null;
  rangeId: string | null;
  reason: string;
  severity: string;
  status: string;
  evidenceJson: unknown;
  createdAt: string;
};

type EpisodeDetail = {
  episode: { id: string; rangeId: string; userEmail: string | null; outcome: string | null; startedAt: string | null; endedAt: string | null };
  scenario: { slug: string; name: string; klass: string } | null;
  rangeState: string | null;
  teardownVerifiedAt: string | null;
  attack: {
    mode: unknown;
    scenarioSlug: unknown;
    timeline: unknown[];
    techniques: unknown;
    evidenceManifest: unknown;
    signedHash: string | null;
    signatureValid: boolean;
  };
  defence: {
    telemetrySignatures: unknown;
    victimSensor: { present: boolean; schema: string | null; envelope: Record<string, unknown> | null };
  };
};

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

/** The two views of one episode: what the run DID, and what the defence SAW. */
function EpisodeViews({ detail }: { detail: EpisodeDetail }) {
  const techniques = Array.isArray(detail.attack.techniques)
    ? detail.attack.techniques.filter((t): t is string => typeof t === "string")
    : [];
  const signatures = Array.isArray(detail.defence.telemetrySignatures)
    ? detail.defence.telemetrySignatures.filter((s): s is string => typeof s === "string")
    : [];
  const timeline = detail.attack.timeline;
  const manifest = (detail.attack.evidenceManifest ?? null) as { entries?: Array<{ path: string; sha256: string }> } | null;
  const vs = detail.defence.victimSensor;

  return (
    <div className="flex flex-col gap-3">
      {/* ---- ATTACK view ---- */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Attack view · mode {String(detail.attack.mode ?? "—")} · {String(detail.attack.scenarioSlug ?? "—")}
        </p>
        <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">
          techniques: {techniques.length > 0 ? techniques.join(", ") : "—"} · outcome {detail.episode.outcome ?? "—"} · range {detail.rangeState ?? "—"}
          {detail.teardownVerifiedAt ? " · teardown verified" : ""}
        </p>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          signed {detail.attack.signedHash ? detail.attack.signedHash.slice(0, 16) + "…" : "—"} ·{" "}
          <span className={detail.attack.signatureValid ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}>
            {detail.attack.signatureValid ? "VERIFIED from stored row" : "INVALID — row does not match signature"}
          </span>
        </p>
        {manifest && Array.isArray(manifest.entries) && (
          <p className="mt-1 font-mono text-xs text-zinc-500 dark:text-zinc-400">
            manifest: {manifest.entries.map((e) => e.path).join(", ")}
          </p>
        )}
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">
            timeline ({timeline.length} entries)
          </summary>
          <pre className="mt-1 max-h-60 overflow-auto rounded bg-zinc-50 p-2 text-xs text-zinc-600 dark:bg-zinc-950 dark:text-zinc-400">
            {JSON.stringify(timeline, null, 2)}
          </pre>
        </details>
      </div>
      {/* ---- DEFENCE view ---- */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Defence view</p>
        <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">
          telemetry signatures: {signatures.length > 0 ? signatures.join(", ") : "—"}
        </p>
        {vs.present ? (
          <div className="mt-1">
            <p className="text-sm text-zinc-700 dark:text-zinc-300">
              victim sensor: <span className="font-mono text-xs">{vs.schema}</span> — the victim device&apos;s own agent rows for the run window
            </p>
            {vs.envelope && (
              <details className="mt-1">
                <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">
                  sensor envelope (counts: {JSON.stringify((vs.envelope as { counts?: unknown }).counts ?? {})})
                </summary>
                <pre className="mt-1 max-h-60 overflow-auto rounded bg-zinc-50 p-2 text-xs text-zinc-600 dark:bg-zinc-950 dark:text-zinc-400">
                  {JSON.stringify(vs.envelope, null, 2)}
                </pre>
              </details>
            )}
          </div>
        ) : (
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">no victim sensor captured (attack-only run)</p>
        )}
      </div>
    </div>
  );
}


export function LabRunsTab() {
  const [runs, setRuns] = useState<LabRunRow[]>([]);
  const [reports, setReports] = useState<AbuseReportRow[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [openEpisodeId, setOpenEpisodeId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EpisodeDetail | null>(null);
  const [detailError, setDetailError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/admin/cyberlab/runs");
      if (!res.ok) throw new Error(`Failed to load lab runs (${res.status})`);
      const data = (await res.json()) as { runs: LabRunRow[]; abuseReports: AbuseReportRow[] };
      setRuns(data.runs);
      setReports(data.abuseReports);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load lab runs");
    } finally {
      setLoading(false);
    }
  }, []);

  // House pattern (cf. components/hosting-panel.tsx): fire-and-forget on mount
  // so the effect body itself returns void, not a setState promise.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- every setState in load is behind the fetch await, not synchronous
    void load();
  }, [load]);

  const openDetail = useCallback(
    async (episodeId: string) => {
      if (openEpisodeId === episodeId) {
        setOpenEpisodeId(null);
        setDetail(null);
        return;
      }
      setOpenEpisodeId(episodeId);
      setDetail(null);
      setDetailError("");
      try {
        const res = await fetch(`/api/admin/cyberlab/episodes/${episodeId}`);
        if (!res.ok) throw new Error(`Failed to load episode (${res.status})`);
        setDetail((await res.json()) as EpisodeDetail);
      } catch (e) {
        setDetailError(e instanceof Error ? e.message : "Failed to load episode");
      }
    },
    [openEpisodeId],
  );

  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold tracking-tight">Lab runs &amp; defence trace</h2>
        <button
          onClick={load}
          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
        >
          Refresh
        </button>
      </div>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        TASK_156B §13.3 — every run across every user, signatures recomputed from the stored rows.
        Refusals (§5.2 LabAbuseReport) are listed beside the runs they refused.
      </p>
      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {loading ? (
        <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
      ) : runs.length === 0 ? (
        <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">No lab runs yet.</p>
      ) : (
        <div className="mt-4 flex flex-col gap-2">
          {runs.map((r) => (
            <div key={r.rangeId} className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium text-zinc-900 dark:text-zinc-100">
                    {r.scenario ? r.scenario.name : r.rangeId.slice(0, 12)}
                    <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">{r.state}</span>
                  </p>
                  <p className="mt-0.5 truncate text-sm text-zinc-500 dark:text-zinc-400">
                    {r.userEmail ?? r.userId} · {fmt(r.createdAt)}
                    {r.scenario ? ` · ${r.scenario.slug} (${r.scenario.klass})` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  {r.teardownVerifiedAt && (
                    <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">teardown verified</span>
                  )}
                  {r.episode && (
                    <button
                      onClick={() => void openDetail(r.episode!.id)}
                      className={`rounded px-2 py-0.5 font-medium transition-colors ${
                        r.episode.signatureValid
                          ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-950 dark:text-emerald-400"
                          : "bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-950 dark:text-red-400"
                      }`}
                      title="Open attack/defence views"
                    >
                      {r.episode.signatureValid ? "signature VERIFIED" : "signature INVALID"}
                    </button>
                  )}
                  {!r.episode && <span className="text-zinc-400">no episode</span>}
                </div>
              </div>
              {r.error && <p className="mt-2 break-all text-xs text-red-600 dark:text-red-400">error: {r.error}</p>}
              {r.episode && openEpisodeId === r.episode.id && (
                <div className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
                  {detailError && <p className="text-sm text-red-600 dark:text-red-400">{detailError}</p>}
                  {!detail && !detailError && <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading episode…</p>}
                  {detail && <EpisodeViews detail={detail} />}
                </div>
              )}
            </div>
          ))}
        </div>
      )}


      <h3 className="mt-8 text-lg font-semibold tracking-tight">Refusals &amp; abuse reports</h3>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        §5.2 — every refusal is recorded. Silence here would mean the trail is broken, not that nothing happened.
      </p>
      {reports.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">No reports.</p>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          {reports.map((rp) => (
            <div key={rp.id} className="rounded-xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="font-medium text-zinc-900 dark:text-zinc-100">
                  {rp.reason}
                  <span
                    className={`ml-2 rounded px-1.5 py-0.5 text-xs ${
                      rp.severity === "high"
                        ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400"
                        : rp.severity === "medium"
                          ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400"
                          : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                    }`}
                  >
                    {rp.severity}
                  </span>
                  <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">{rp.status}</span>
                </span>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  {rp.userEmail ?? rp.userId} · {fmt(rp.createdAt)}
                </span>
              </div>
              {rp.evidenceJson != null && (
                <pre className="mt-2 max-h-40 overflow-auto rounded bg-zinc-50 p-2 text-xs text-zinc-600 dark:bg-zinc-950 dark:text-zinc-400">
                  {JSON.stringify(rp.evidenceJson, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

