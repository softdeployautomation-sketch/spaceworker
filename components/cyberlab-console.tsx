"use client";

import { useCallback, useEffect, useState } from "react";

// TASK_156 C2a (PLAN_TASK_156 §7 C2 item 5) — the interactive half of the panel:
// scenario list + attested-target picker + Start (dry-run) + run history +
// signed-episode viewer. Rendered ONLY behind `gate.open` (the parent checks
// enabled && entitled && consented server-authoritatively), so a user who has
// not accepted the AUP never sees a Start button.
//
// Honest by construction:
//   - Everything here is labelled dry-run. The server enforces it too —
//     lib/lab/engine.ts hard-codes mode "dry-run"; the UI never offers a
//     "live" option because there is none until C2b (owner infra).
//   - Attestation is the operator's DECLARATION of ownership/authorisation;
//     the platform can only verify ownership inside its own lab ranges.
//   - The episode signature is VERIFIED ON READ by the server (recomputed from
//     the stored row), so tampering is visible without trusting the client.
//   - Refusals are shown verbatim from the server (403 pre-flight issues,
//     409 gate/caps, 429 episode cap, 500 range transition) — the client
//     never re-implements the rules or softens a refusal.

interface ScenarioView {
  id: string;
  slug: string;
  name: string;
  klass: string;
  techniqueIds: string[];
  blastRadius: string;
  cleanup: string;
  author: string;
  mode: string;
}

interface TargetView {
  id: string;
  kind: string;
  value: string;
  attestedAt: string;
}

interface RunView {
  id: string;
  scenarioId: string;
  state: string;
  ttlExpiresAt: string | null;
  teardownVerifiedAt: string | null;
  error: string | null;
  createdAt: string;
}

interface EpisodeListItem {
  id: string;
  rangeId: string;
  startedAt: string;
  outcome: string;
  techniques: string[];
  signedHash: string | null;
  createdAt: string;
}

interface EpisodeDetail {
  id: string;
  rangeId: string;
  startedAt: string;
  endedAt: string | null;
  outcome: string;
  techniques: string[];
  telemetrySignatures: string[];
  timeline: unknown;
  evidenceManifest: { entries?: Array<{ path: string; sha256: string; bytes: number }> } | null;
  signedHash: string | null;
}

interface RunResult {
  episodeId: string;
  rangeId: string;
  verified: boolean;
  signedHash: string | null;
  techniques: string[];
}

const TARGET_KINDS = ["host", "network", "url", "domain", "email"] as const;

function issueText(reason: string): string {
  switch (reason) {
    case "unattested":
      return "not in your attested inventory";
    case "stale_attestation":
      return "attestation older than the freshness window";
    case "range_mismatch":
      return "attested to a different lab range";
    default:
      return reason;
  }
}

export function CyberLabConsole({ onChanged }: { onChanged?: () => void }) {
  const [scenarios, setScenarios] = useState<ScenarioView[]>([]);
  const [targets, setTargets] = useState<TargetView[]>([]);
  const [runs, setRuns] = useState<RunView[]>([]);
  const [episodes, setEpisodes] = useState<EpisodeListItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [starting, setStarting] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState("");
  const [attestKind, setAttestKind] = useState<(typeof TARGET_KINDS)[number]>("host");
  const [attestValue, setAttestValue] = useState("");
  const [attesting, setAttesting] = useState(false);
  const [openEpisode, setOpenEpisode] = useState<{ detail: EpisodeDetail; signatureValid: boolean } | null>(null);
  const [loadingEpisode, setLoadingEpisode] = useState("");

  const refresh = useCallback(async () => {
    const [sc, tg, rn, ep] = await Promise.all([
      fetch("/api/cyberlab/scenarios").then((r) => (r.ok ? r.json() : { scenarios: [] })),
      fetch("/api/cyberlab/targets").then((r) => (r.ok ? r.json() : { targets: [] })),
      fetch("/api/cyberlab/runs").then((r) => (r.ok ? r.json() : { runs: [] })),
      fetch("/api/cyberlab/episodes").then((r) => (r.ok ? r.json() : { episodes: [] })),
    ]);
    setScenarios(sc.scenarios ?? []);
    setTargets(tg.targets ?? []);
    setRuns(rn.runs ?? []);
    setEpisodes(ep.episodes ?? []);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- every setState in refresh sits behind the fetch awaits in Promise.all, never synchronous (same accepted pattern as components/device-list.tsx)
    void refresh();
  }, [refresh]);

  function toggleTarget(value: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  async function attest() {
    if (!attestValue.trim()) return;
    setAttesting(true);
    setError("");
    try {
      const res = await fetch("/api/cyberlab/targets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: attestKind, value: attestValue.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Couldn’t attest that target.");
        return;
      }
      setAttestValue("");
      await refresh();
    } catch {
      setError("Network error — couldn’t attest that target.");
    } finally {
      setAttesting(false);
    }
  }

  async function start(slug: string) {
    const chosen = targets.filter((t) => selected.has(t.value));
    if (chosen.length === 0) {
      setError("Pick at least one attested target for the run.");
      return;
    }
    setStarting(slug);
    setError("");
    setResult(null);
    try {
      const res = await fetch("/api/cyberlab/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenarioSlug: slug, targets: chosen.map((t) => ({ kind: t.kind, value: t.value })) }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        issues?: Array<{ kind: string; value: string; reason: string }>;
        episodeId?: string;
        rangeId?: string;
        verified?: boolean;
        signedHash?: string | null;
        techniques?: string[];
      };
      if (!res.ok) {
        const issues = Array.isArray(data.issues)
          ? ` — ${data.issues.map((i) => `${i.kind}:${i.value} (${issueText(i.reason)})`).join("; ")}`
          : "";
        setError(`${data.error ?? `run refused (${res.status})`}${issues}`);
        await refresh();
        onChanged?.();
        return;
      }
      setResult({
        episodeId: data.episodeId ?? "",
        rangeId: data.rangeId ?? "",
        verified: Boolean(data.verified),
        signedHash: data.signedHash ?? null,
        techniques: data.techniques ?? [],
      });
      await refresh();
      onChanged?.();
    } catch {
      setError("Network error — the run did not start.");
    } finally {
      setStarting(null);
    }
  }

  async function openEpisodeDetail(id: string) {
    setLoadingEpisode(id);
    setError("");
    try {
      const res = await fetch(`/api/cyberlab/episodes/${id}`);
      const data = (await res.json().catch(() => ({}))) as {
        episode?: EpisodeDetail;
        signatureValid?: boolean;
        error?: string;
      };
      if (!res.ok || !data.episode) {
        setError(typeof data.error === "string" ? data.error : "Couldn’t load that episode.");
        return;
      }
      setOpenEpisode({ detail: data.episode, signatureValid: Boolean(data.signatureValid) });
    } catch {
      setError("Network error — couldn’t load that episode.");
    } finally {
      setLoadingEpisode("");
    }
  }

  const manifestEntries = openEpisode?.detail.evidenceManifest?.entries ?? [];
  const timelineCount = Array.isArray(openEpisode?.detail.timeline) ? openEpisode!.detail.timeline.length : 0;

  return (
    <div className="space-y-6">
      {/* ── Scenarios (the ONE allow-list the engine also reads) ───────────── */}
      <section className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Scenarios</h2>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">dry-run only — synthetic telemetry</span>
        </div>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Each run needs at least one attested target. Attesting is your declaration that you own or are authorised for
          the asset.
        </p>
        <div className="mt-4 space-y-4">
          {scenarios.length === 0 && <p className="text-sm text-zinc-500">No scenarios available yet.</p>}
          {scenarios.map((s) => (
            <div key={s.id} className="rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">{s.name}</span>
                  <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                    {s.klass} · {s.mode}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => start(s.slug)}
                  disabled={starting !== null}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  {starting === s.slug ? "Running…" : "Start (dry-run)"}
                </button>
              </div>
              {s.techniqueIds.length > 0 && (
                <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                  ATT&amp;CK techniques observed: {s.techniqueIds.join(", ")}
                </p>
              )}
              <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
                <span className="font-medium">Worst case:</span> {s.blastRadius}
              </p>
              <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
                <span className="font-medium">Cleanup:</span> {s.cleanup}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Attested targets (the legal spine) ─────────────────────────────── */}
      <section className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Attested targets</h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          A run can only touch values checked here. Tick the ones this run should use.
        </p>
        <div className="mt-3 space-y-1">
          {targets.length === 0 && <p className="text-sm text-zinc-500">No attested targets yet — add one below.</p>}
          {targets.map((t) => (
            <label key={t.id} className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
              <input
                type="checkbox"
                checked={selected.has(t.value)}
                onChange={() => toggleTarget(t.value)}
                className="rounded border-zinc-300"
              />
              <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs uppercase text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                {t.kind}
              </span>
              <span className="font-mono">{t.value}</span>
              <span className="text-xs text-zinc-400">attested {new Date(t.attestedAt).toLocaleDateString()}</span>
            </label>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select
            value={attestKind}
            onChange={(e) => setAttestKind(e.target.value as (typeof TARGET_KINDS)[number])}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          >
            {TARGET_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <input
            value={attestValue}
            onChange={(e) => setAttestValue(e.target.value)}
            placeholder="value (e.g. 192.168.56.10, https://staging.example.com)"
            className="min-w-64 flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          />
          <button
            type="button"
            onClick={attest}
            disabled={attesting || !attestValue.trim()}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {attesting ? "Attesting…" : "Attest"}
          </button>
        </div>
      </section>

      {error && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      {result && (
        <section className="rounded-md border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
          <p className="font-medium">Dry-run complete — evidence episode signed.</p>
          <p className="mt-1 font-mono text-xs">
            episode {result.episodeId} · range {result.rangeId} · signature {result.verified ? "VERIFIED" : "INVALID"}
          </p>
          {result.signedHash && <p className="mt-0.5 break-all font-mono text-xs">{result.signedHash}</p>}
        </section>
      )}



      {/* ── Run history ────────────────────────────────────────────────────── */}
      <section className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Recent runs</h2>
        <div className="mt-3 space-y-1">
          {runs.length === 0 && <p className="text-sm text-zinc-500">No runs yet.</p>}
          {runs.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
              <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs dark:bg-zinc-800">{r.state}</span>
              <span className="font-mono text-xs">{r.id}</span>
              <span className="text-xs text-zinc-400">{new Date(r.createdAt).toLocaleString()}</span>
              {r.teardownVerifiedAt && (
                <span className="text-xs text-emerald-600 dark:text-emerald-400">teardown verified</span>
              )}
              {r.error && <span className="text-xs text-red-600 dark:text-red-400">{r.error}</span>}
            </div>
          ))}
        </div>
      </section>

      {/* ── Evidence episodes (signed, append-only) ─────────────────────────── */}
      <section className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Evidence episodes</h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Signed and append-only — the signature is recomputed from the stored row on every open, so edits after
          signing show up as INVALID.
        </p>
        <div className="mt-3 space-y-1">
          {episodes.length === 0 && <p className="text-sm text-zinc-500">No episodes yet — start a dry-run.</p>}
          {episodes.map((e) => (
            <div key={e.id} className="flex flex-wrap items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
              <button
                type="button"
                onClick={() => openEpisodeDetail(e.id)}
                disabled={loadingEpisode !== ""}
                className="font-mono text-xs text-blue-600 underline underline-offset-2 hover:text-blue-800 disabled:opacity-50 dark:text-blue-400"
              >
                {loadingEpisode === e.id ? "loading…" : e.id}
              </button>
              <span className="text-xs text-zinc-400">{new Date(e.startedAt).toLocaleString()}</span>
              <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs dark:bg-zinc-800">{e.outcome}</span>
              {e.techniques.length > 0 && <span className="text-xs text-zinc-500">{e.techniques.join(", ")}</span>}
            </div>
          ))}
        </div>

        {openEpisode && (
          <div className="mt-4 rounded-md border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-sm text-zinc-900 dark:text-zinc-100">{openEpisode.detail.id}</span>
              <span
                className={
                  openEpisode.signatureValid
                    ? "rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
                    : "rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900 dark:text-red-200"
                }
              >
                signature {openEpisode.signatureValid ? "VERIFIED" : "INVALID"}
              </span>
            </div>
            {openEpisode.detail.signedHash && (
              <p className="mt-1 break-all font-mono text-xs text-zinc-500">{openEpisode.detail.signedHash}</p>
            )}
            <p className="mt-2 text-xs text-zinc-500">
              {manifestEntries.length} artefact{manifestEntries.length === 1 ? "" : "s"} · {timelineCount} timeline
              entr{timelineCount === 1 ? "y" : "ies"} · outcome {openEpisode.detail.outcome}
            </p>
            <ul className="mt-2 space-y-0.5">
              {manifestEntries.map((m) => (
                <li key={m.path} className="font-mono text-xs text-zinc-600 dark:text-zinc-400">
                  {m.path} — sha256 {m.sha256.slice(0, 16)}… ({m.bytes} B)
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => setOpenEpisode(null)}
              className="mt-3 text-xs text-zinc-500 underline underline-offset-2"
            >
              Close
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

