"use client";

// Self-contained Extract page for the local Extractor EXE (Task 27 licensing
// slice). Type find/location terms, hit "Search", and watch real leads appear
// live as the local-engine pipeline (query expansion -> DDG search -> PDF/page
// extraction) streams them back over SSE from /api/exe/extract.
//
// Task 27 #2 — layout rewritten to match the WEB app's information architecture
// (app/dashboard/extract/page.tsx) instead of this slice's original two-panel
// (Leads | Activity) improvisation:
//   - LEFT:  session / run history (past runs, loadable, selectable) — the EXE
//            sibling of the web's job sidebar with its Load list.
//   - RIGHT: the selected run's detail — activity log AND leads together, never
//            collapsing away when a run completes (a finished run stays fully
//            inspectable, same as the web's persisted job detail pane).
//
// Deliberately in-memory for THIS slice (results held in component state and
// mirrored to a temp JSONL file by the route). The future SQLite schema fork
// replaces both.

import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { timeAgo } from "@/lib/format-date";
import type { Lead } from "@/local-engine/src/lead";

interface ExtractEvent {
  type: "step" | "lead" | "done";
  message?: string;
  lead?: Lead;
  total?: number;
  leadFile?: string | null;
  stoppedReason?: string | null;
}

// One extraction run kept in the sidebar history. Mirrors a web job's persisted
// shape as closely as the EXE's throwaway JSONL storage allows.
interface RunRecord {
  id: number;
  findTerms: string;
  locationTerms: string;
  pdfOnly: boolean;
  scope: number;
  resultsPerQuery: number;
  minLeads: number;
  maxTotalLeads: number;
  maxDurationMinutes: number;
  emailFilter: string;
  leads: Lead[];
  steps: string[];
  total: number;
  leadFile: string | null;
  status: "running" | "done" | "failed";
  stoppedReason: string | null;
  createdAt: string; // ISO — for timeAgo() captions
}

const MAX_CHOICES: { value: number; label: string }[] = [
  { value: 3, label: "3 queries" },
  { value: 5, label: "5 queries" },
  { value: 10, label: "10 queries" },
];

/** Clamp a numeric input to [lo, hi], falling back to `fallback` for non-finite input. */
function clampNumber(v: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, Math.floor(v)));
}

/** Compact human summary of a run's search (the EXE sibling of the web's summarizeQuery). */
function summarizeRun(run: Pick<RunRecord, "findTerms" | "locationTerms">): string {
  const parts = [run.findTerms.trim(), run.locationTerms.trim()].filter(Boolean);
  return parts.join("  ·  ") || "Lead search";
}

/** Status pill for a run, mirroring the web's STATUS_COLORS job badges. */
function runStatusMeta(run: Pick<RunRecord, "status" | "stoppedReason">): { label: string; cls: string } {
  if (run.status === "running") return { label: "running", cls: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200" };
  if (run.status === "failed") return { label: "failed", cls: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200" };
  switch (run.stoppedReason) {
    case "minLeadsReached": return { label: "done", cls: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200" };
    case "maxTotalLeads": return { label: "cap", cls: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200" };
    case "deadline": return { label: "deadline", cls: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200" };
    case "exhausted": return { label: "exhausted", cls: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300" };
    default: return { label: "done", cls: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200" };
  }
}

export function LocalExtractPage() {
  // Controlled form fields (converted from refs so a past run's search can be
  // "Load"ed back into the form, exactly like the web's Load action).
  const [findTerms, setFindTerms] = useState("");
  const [locationTerms, setLocationTerms] = useState("");
  const [pdfOnly, setPdfOnly] = useState(false);
  const [maxChoice, setMaxChoice] = useState(5); // scope (queries per run)
  const [resultsPerQuery, setResultsPerQuery] = useState(6);
  // Task 27 #1/#2 — "Min leads" is the FLOOR that drives auto-expansion (the web's
  // minResults semantics); "Max leads" stays as the optional hard ceiling; "Max
  // duration" is the wall-clock deadline guard so an unreachable minimum can't loop.
  const [minLeads, setMinLeads] = useState(0);
  const [maxTotalLeads, setMaxTotalLeads] = useState(40);
  const [maxDurationMinutes, setMaxDurationMinutes] = useState(30);
  const [emailFilter, setEmailFilter] = useState("");

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const cancelRef = useRef<boolean>(false);
  const readerRef = useRef<{ cancel(): Promise<unknown> } | null>(null);
  const nextRunId = useRef(1);
  const leadsScrollRef = useRef<HTMLDivElement>(null);

  const selectedRun = useMemo(
    () => runs.find((r) => r.id === selectedRunId) ?? null,
    [runs, selectedRunId],
  );

  // Immutable helpers for the run history. Each run streams in its own leads/steps
  // so multiple runs stay viewable side by side (and after completion).
  const patchRun = (id: number, patch: Partial<RunRecord>) =>
    setRuns((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const appendRun = (id: number, kind: "lead" | "step", value: Lead | string) =>
    setRuns((prev) =>
      prev.map((r) =>
        r.id === id
          ? kind === "lead"
            ? { ...r, leads: [...r.leads, value as Lead] }
            : { ...r, steps: [...r.steps, value as string] }
          : r,
      ),
    );

  async function startSearch() {
    const finds = findTerms.trim();
    if (!finds) {
      setError("Enter at least one find term (e.g. “roofing contractor”).");
      return;
    }

    cancelRef.current = false;
    setError(undefined);

    const runId = nextRunId.current++;
    const run: RunRecord = {
      id: runId,
      findTerms: finds,
      locationTerms: locationTerms.trim(),
      pdfOnly,
      scope: maxChoice,
      resultsPerQuery,
      minLeads,
      maxTotalLeads,
      maxDurationMinutes,
      emailFilter,
      leads: [],
      steps: [],
      total: 0,
      leadFile: null,
      status: "running",
      stoppedReason: null,
      createdAt: new Date().toISOString(),
    };
    // Newest run on top, auto-selected — same feel as the web's fresh job appearing
    // at the top of the sidebar and being opened.
    setRuns((prev) => [run, ...prev]);
    setSelectedRunId(runId);
    setRunning(true);

    try {
      const res = await fetch("/api/exe/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          findTerms: finds,
          locationTerms: locationTerms.trim(),
          pdfOnly,
          maxResults: maxChoice,
          resultsPerQuery,
          maxTotalLeads,
          minLeads,
          maxDurationMinutes,
          emailDomains: emailFilter,
        }),
      });

      if (res.status === 404) {
        patchRun(runId, { status: "failed" });
        setError("Extraction is only available in the local Extractor EXE.");
        return;
      }
      if (!res.ok) {
        patchRun(runId, { status: "failed" });
        setError(await res.text().catch(() => "Search failed."));
        return;
      }
      if (!res.body) {
        patchRun(runId, { status: "failed" });
        setError("No response stream.");
        return;
      }

      const reader = res.body.getReader();
      readerRef.current = reader;
      const decoder = new TextDecoder();
      let buffer = "";
      while (!cancelRef.current) {
        const { done, value } = await reader.read();
        if (cancelRef.current) break;
        if (value && value.length) buffer += decoder.decode(value, { stream: !done });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const data = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!data) continue;
          let ev: ExtractEvent;
          try {
            ev = JSON.parse(data.slice(6)) as ExtractEvent;
          } catch {
            continue;
          }
          if (ev.type === "step" && ev.message) {
            appendRun(runId, "step", ev.message);
          } else if (ev.type === "lead" && ev.lead) {
            appendRun(runId, "lead", ev.lead);
            // Keep the leads region pinned to the newest lead as it lands.
            requestAnimationFrame(() => {
              if (leadsScrollRef.current) leadsScrollRef.current.scrollTop = leadsScrollRef.current.scrollHeight;
            });
          } else if (ev.type === "done") {
            patchRun(runId, {
              status: "done",
              total: ev.total ?? 0,
              leadFile: ev.leadFile ?? null,
              stoppedReason: ev.stoppedReason ?? null,
            });
          }
        }
        if (done) break;
      }
    } catch (err) {
      if (!cancelRef.current) {
        patchRun(runId, { status: "failed" });
        setError(`Search failed: ${String(err)}`);
      }
    } finally {
      setRunning(false);
      readerRef.current = null;
    }
  }

  function stopSearch() {
    cancelRef.current = true;
    void readerRef.current?.cancel();
  }

  // Load a past run's search back into the form (the web's Load action) so it can
  // be edited and resubmitted as a NEW run — the original run stays untouched.
  function loadRunIntoForm(run: RunRecord) {
    setFindTerms(run.findTerms);
    setLocationTerms(run.locationTerms);
    setPdfOnly(run.pdfOnly);
    setMaxChoice(run.scope);
    setResultsPerQuery(run.resultsPerQuery);
    setMinLeads(run.minLeads);
    setMaxTotalLeads(run.maxTotalLeads);
    setMaxDurationMinutes(run.maxDurationMinutes);
    setEmailFilter(run.emailFilter);
    setError(undefined);
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-hidden p-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight text-fg">Extract leads</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Find terms + location, then run the local engine. Results stream in as they&apos;re found.
        </p>
      </div>

      {/* Search bar */}
      <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <div className="flex flex-col flex-wrap gap-3 md:flex-row md:flex-wrap md:items-center">
          <label className="flex min-w-[13rem] flex-1 flex-col gap-1">
            <span className="text-xs text-fg-muted">Find</span>
            <input
              type="text"
              value={findTerms}
              onChange={(e) => setFindTerms(e.target.value)}
              placeholder="e.g. roofing contractor, plumber, dentist"
              className="w-full rounded-lg border border-border bg-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
            />
          </label>
          <label className="flex min-w-[13rem] flex-1 flex-col gap-1">
            <span className="text-xs text-fg-muted">Location</span>
            <input
              type="text"
              value={locationTerms}
              onChange={(e) => setLocationTerms(e.target.value)}
              placeholder="e.g. Austin, TX (optional, comma-separated)"
              className="w-full rounded-lg border border-border bg-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
            />
          </label>
          <label className="flex shrink-0 items-center gap-2 md:mt-6">
            <input type="checkbox" checked={pdfOnly} onChange={(e) => setPdfOnly(e.target.checked)} className="h-4 w-4" />
            <span className="text-xs text-fg-muted">Bias toward PDFs</span>
          </label>
          <label className="flex shrink-0 flex-col gap-1">
            <span className="text-xs text-fg-muted">Scope</span>
            <select value={maxChoice} onChange={(e) => setMaxChoice(Number(e.target.value))} className="rounded-lg border border-border bg-input px-2 py-2 text-sm">
              {MAX_CHOICES.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </label>
          <div className="shrink-0 md:mt-6">
            {running ? (
              <Button variant="primary" type="button" onClick={stopSearch}>Stop</Button>
            ) : (
              <Button variant="primary" type="button" onClick={() => void startSearch()}>Search</Button>
            )}
          </div>
        </div>

        {/* Task 27 #1/#2 — advanced config surfaced from the web version. "Min leads"
            now drives auto-expansion (the web's minResults semantics); "Max leads" is
            the optional hard ceiling; "Max duration" bounds the run's wall-clock time
            so a never-hittable minimum can't run forever. Wrapped so it degrades
            gracefully at the EXE's min window width. */}
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-fg-muted">Results / query</span>
            <input
              type="number"
              min={1}
              max={10}
              value={resultsPerQuery}
              onChange={(e) => setResultsPerQuery(clampNumber(e.target.valueAsNumber, 1, 10, 6))}
              title="How many results to take from each search query (1-10)."
              className="w-32 rounded-lg border border-border bg-input px-2 py-2 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-fg-muted">Min leads</span>
            <input
              type="number"
              min={0}
              max={200}
              value={minLeads}
              onChange={(e) => setMinLeads(clampNumber(e.target.valueAsNumber, 0, 200, 0))}
              title="Keep auto-expanding more search queries until this many leads are found (0 = off), like the web's Minimum results."
              className="w-32 rounded-lg border border-border bg-input px-2 py-2 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-fg-muted">Max leads</span>
            <input
              type="number"
              min={1}
              max={200}
              value={maxTotalLeads}
              onChange={(e) => setMaxTotalLeads(clampNumber(e.target.valueAsNumber, 1, 200, 40))}
              title="Hard ceiling — stop collecting once this many leads are found (1-200). Never lower than Min leads."
              className="w-32 rounded-lg border border-border bg-input px-2 py-2 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-fg-muted">Max duration (min)</span>
            <input
              type="number"
              min={1}
              max={480}
              value={maxDurationMinutes}
              onChange={(e) => setMaxDurationMinutes(clampNumber(e.target.valueAsNumber, 1, 480, 30))}
              title="Wall-clock deadline for the run — stops expanding once reached, so a never-satisfiable minimum can't loop forever."
              className="w-32 rounded-lg border border-border bg-input px-2 py-2 text-sm"
            />
          </label>
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-xs text-fg-muted">Email domain filter</span>
            <input
              type="text"
              value={emailFilter}
              onChange={(e) => setEmailFilter(e.target.value)}
              placeholder="e.g. gmail.com, *.edu (optional)"
              title="Only keep leads whose email matches a listed domain or suffix (comma-separated)."
              className="w-full rounded-lg border border-border bg-input px-3 py-2 text-sm"
            />
          </label>
        </div>
        {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
        <p className="mt-2 text-[11px] text-fg-muted">
          {running
            ? `Running… ${runs[0]?.leads.length ?? 0} lead(s) so far.`
            : "Results are held in this window + a temp local JSONL file for this slice — a SQLite schema replaces that later."}
        </p>
      </div>

      {/* Web-matching information architecture: LEFT = session/run history,
          RIGHT = the selected run's detail (activity + leads together). */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden md:flex-row">
        {/* Session / run history */}
        <div className="max-h-64 w-full flex-shrink-0 overflow-y-auto rounded-xl border border-border bg-card md:h-auto md:max-h-full md:w-72">
          {runs.length === 0 && (
            <p className="p-4 text-sm text-fg-muted">No runs yet. Submit a search above.</p>
          )}
          {runs.map((run) => {
            const meta = runStatusMeta(run);
            const summary = summarizeRun(run);
            return (
              <div
                key={run.id}
                onClick={() => setSelectedRunId(run.id)}
                className={`cursor-pointer border-b border-border p-3 last:border-0 hover:bg-black/5 dark:hover:bg-white/5 ${selectedRunId === run.id ? "bg-brand-50 dark:bg-brand-900/20" : ""}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium" title={summary}>{summary}</span>
                  <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${meta.cls}`}>{meta.label}</span>
                </div>
                <div className="mt-1 flex items-center justify-between text-xs text-fg-muted">
                  <span>{run.leads.length} lead(s) · {timeAgo(run.createdAt)}</span>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); loadRunIntoForm(run); }}
                    className="text-brand-600 hover:underline dark:text-brand-400"
                    title="Load this run's search into the form above"
                  >
                    Load
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Selected run detail — activity + leads, kept expanded after completion */}
        <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border bg-card">
          {!selectedRun ? (
            <p className="p-6 text-sm text-fg-muted">Select or run a search to view leads.</p>
          ) : (
            <div className="flex flex-col gap-4 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="truncate font-semibold" title={summarizeRun(selectedRun)}>{summarizeRun(selectedRun)}</h2>
                  <p className="mt-0.5 text-xs text-fg-muted">
                    {selectedRun.leads.length} lead(s) · {timeAgo(selectedRun.createdAt)}
                    {selectedRun.minLeads > 0 && <span> · min {selectedRun.minLeads}</span>}
                    {selectedRun.maxTotalLeads > 0 && <span> · cap {selectedRun.maxTotalLeads}</span>}
                    <span> · {selectedRun.maxDurationMinutes} min</span>
                  </p>
                </div>
                <span className={`rounded px-2 py-1 text-xs font-medium ${runStatusMeta(selectedRun).cls}`}>
                  {runStatusMeta(selectedRun).label}
                </span>
              </div>

              {/* Min-leads-not-reached banner, mirroring the web's minimum banner (~page.tsx 1153). */}
              {selectedRun.minLeads > 0 &&
                selectedRun.status === "done" &&
                selectedRun.stoppedReason !== "minLeadsReached" &&
                selectedRun.total < selectedRun.minLeads && (
                  <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
                    Found {selectedRun.total} of your {selectedRun.minLeads}-lead minimum. The run kept auto-expanding
                    queries until it hit its {selectedRun.maxDurationMinutes}-minute deadline or ran out of variants —
                    consider broader find/location terms or a higher cap.
                  </div>
                )}

              {/* Live "currently" line while running (the web's live feed under the leads). */}
              {selectedRun.status === "running" && selectedRun.steps.length > 0 && (
                <p className="truncate text-xs text-fg-muted/80">{selectedRun.steps[selectedRun.steps.length - 1]}</p>
              )}

              {/* Leads */}
              <div className="rounded-lg border border-border">
                <h3 className="px-3 pt-3 text-sm font-semibold">Leads ({selectedRun.leads.length})</h3>
                {selectedRun.leads.length === 0 ? (
                  <p className="px-3 py-6 text-sm text-fg-muted">
                    {selectedRun.status === "running" ? "Searching… leads will appear here as they're extracted." : "No leads found this run."}
                  </p>
                ) : (
                  <div ref={leadsScrollRef} className="max-h-[46vh] overflow-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border text-left text-xs text-fg-muted">
                          <th className="px-3 pb-2 pr-3 font-medium">Business</th>
                          <th className="pb-2 pr-3 font-medium">Name</th>
                          <th className="pb-2 pr-3 font-medium">Email</th>
                          <th className="pb-2 pr-3 font-medium">Phone</th>
                          <th className="pb-2 font-medium">Website</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedRun.leads.map((lead, i) => (
                          <tr key={i} className="border-b border-border last:border-0">
                            <td className="py-2 pl-3 pr-3">{lead.businessName ?? "—"}</td>
                            <td className="py-2 pr-3">{lead.contactName ?? "—"}</td>
                            <td className="py-2 pr-3">
                              {lead.email
                                ? <a href={`mailto:${lead.email}`} className="text-brand-600 hover:underline">{lead.email}</a>
                                : "—"}
                            </td>
                            <td className="py-2 pr-3">{lead.phone ?? "—"}</td>
                            <td className="py-2 pr-3">
                              {lead.website
                                ? <a href={lead.website} target="_blank" rel="noopener noreferrer" className="block max-w-[160px] truncate text-brand-600 hover:underline">{lead.website}</a>
                                : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Activity log — kept under the leads, never collapsed after completion. */}
              <div className="rounded-lg border border-border p-3">
                <h3 className="text-sm font-semibold">Activity</h3>
                {selectedRun.steps.length === 0 ? (
                  <p className="py-3 text-xs text-fg-muted">Step log will appear here.</p>
                ) : (
                  <ul className="mt-2 max-h-[30vh] space-y-1 overflow-y-auto text-[11.5px] text-fg-muted">
                    {selectedRun.steps.map((s, i) => (
                      <li key={i} className="leading-snug">· {s}</li>
                    ))}
                  </ul>
                )}
                {selectedRun.leadFile && (
                  <p className="mt-2 border-t border-border pt-2 text-[11px] text-fg-muted">
                    Saved to <code className="text-fg">{selectedRun.leadFile}</code>
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}