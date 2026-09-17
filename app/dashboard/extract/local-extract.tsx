"use client";

// Self-contained Extract page for the local Extractor EXE (Task 27 licensing
// slice). Type find/location terms, hit "Search", and watch real leads appear
// live as the local-engine pipeline (query expansion -> DDG search -> PDF/page
// extraction) streams them back over SSE from /api/exe/extract.
//
// Deliberately simple for THIS slice: results are held in memory (and mirrored to
// a temp JSONL file by the route). The future SQLite schema fork replaces both.

import { useState, useRef } from "react";
import { Button } from "@/components/ui";
import type { Lead } from "@/local-engine/src/lead";

interface ExtractEvent {
  type: "step" | "lead" | "done";
  message?: string;
  lead?: Lead;
  total?: number;
  leadFile?: string | null;
}

const MAX_CHOICES: { value: number; label: string }[] = [
  { value: 3, label: "3 queries" },
  { value: 5, label: "5 queries" },
  { value: 10, label: "10 queries" },
];

/** Clamp a numeric input to [lo, hi], falling back to `fallback` for non-finite input. */
function clampNumber(v: number, lo: number, hi: number, fallback: number): number {
  if (Number.isNaN(v) || v < lo) return lo;
  return Math.min(hi, Math.floor(v));
}

export function LocalExtractPage() {
  const findRef = useRef<HTMLInputElement>(null);
  const locRef = useRef<HTMLInputElement>(null);
  const [pdfOnly, setPdfOnly] = useState(false);
  const [maxChoice, setMaxChoice] = useState(5);
  // Task 27 #2 — advanced bounds backed by /api/exe/extract route caps.
  const [resultsPerQuery, setResultsPerQuery] = useState(6); // pages/results per query
  const [maxTotalLeads, setMaxTotalLeads] = useState(40); // stop after N leads
  const [emailFilter, setEmailFilter] = useState(""); // "gmail.com, *.edu" allowlist
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [leadFile, setLeadFile] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const cancelRef = useRef<boolean>(false);
  const readerRef = useRef<{ cancel(): Promise<unknown> } | null>(null);

  async function startSearch() {
    const findTerms = findRef.current?.value ?? "";
    const locationTerms = locRef.current?.value ?? "";
    if (!findTerms.trim()) {
      setError("Enter at least one find term (e.g. “roofing contractor”).");
      return;
    }

    cancelRef.current = false;
    setRunning(true);
    setSteps([]);
    setLeads([]);
    setTotal(0);
    setLeadFile(null);
    setError(undefined);

    try {
      const res = await fetch("/api/exe/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ findTerms, locationTerms, pdfOnly, maxResults: maxChoice, resultsPerQuery, maxTotalLeads, emailDomains: emailFilter }),
      });

      if (res.status === 404) {
        setError("Extraction is only available in the local Extractor EXE.");
        setRunning(false);
        return;
      }
      if (!res.ok) {
        setError(await res.text().catch(() => "Search failed."));
        setRunning(false);
        return;
      }
      if (!res.body) {
        setError("No response stream.");
        setRunning(false);
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
          if (ev.type === "step" && ev.message) setSteps((s) => [...s, ev.message!]);
          else if (ev.type === "lead" && ev.lead) setLeads((s) => [...s, ev.lead!]);
          else if (ev.type === "done") {
            setTotal(ev.total ?? 0);
            setLeadFile(ev.leadFile ?? null);
          }
        }
        if (done) break;
      }
    } catch (err) {
      if (!cancelRef.current) setError(`Search failed: ${String(err)}`);
    } finally {
      setRunning(false);
      readerRef.current = null;
    }
  }

  function stopSearch() {
    cancelRef.current = true;
    void readerRef.current?.cancel();
  }

  return (
    <div className="space-y-5">
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
              ref={findRef}
              type="text"
              defaultValue=""
              placeholder="e.g. roofing contractor, plumber, dentist"
              className="w-full rounded-lg border border-border bg-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
            />
          </label>
          <label className="flex min-w-[13rem] flex-1 flex-col gap-1">
            <span className="text-xs text-fg-muted">Location</span>
            <input
              ref={locRef}
              type="text"
              defaultValue=""
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
{/* Task 27 #2 — advanced config surfaced from the web version, backed by the
            route's bounds (MAX_QUERIES_PER_RUN via Scope above, MAX_RESULTS_PER_QUERY,
            MAX_TOTAL_LEADS, + email-domain allowlist). Wrapped so it degrades gracefully
            at the EXE's min window width. */}
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
            <span className="text-xs text-fg-muted">Max leads</span>
            <input
              type="number"
              min={1}
              max={200}
              value={maxTotalLeads}
              onChange={(e) => setMaxTotalLeads(clampNumber(e.target.valueAsNumber, 1, 200, 40))}
              title="Stop collecting once this many leads are found (1-200)."
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
            ? `Running… ${leads.length} lead(s) so far.`
            : total > 0
              ? `${total} lead(s) found this run.`
              : "Results are held in memory + a temp local JSONL file for this slice — a SQLite schema replaces that later."}
        </p>
      </div>

      {/* Results + step feed */}
      <div className="flex flex-col gap-4 md:flex-row">
        <div className="flex-1 rounded-xl border border-border bg-card p-4 shadow-sm">
          <h2 className="mb-2 text-sm font-semibold text-fg">Leads {running ? `(${leads.length})` : ""}</h2>
          {leads.length === 0 && (
            <p className="py-8 text-center text-sm text-fg-muted">
              {running ? "Searching… leads will appear here as they&apos;re extracted." : "No leads yet. Enter terms and hit Search."}
            </p>
          )}
          <div className="max-h-[42vh] overflow-y-auto">
            <ul className="space-y-3">
              {leads.map((lead, i) => (
                <li key={i} className="rounded-lg border border-border bg-bg p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    {lead.email && <span className="text-[13px] font-medium text-brand-600 dark:text-brand-300">{lead.email}</span>}
                    {lead.contactName && <span className="text-xs text-fg-muted">· {lead.contactName}</span>}
                    {lead.phone && <span className="text-xs text-fg-muted">· {lead.phone}</span>}
                  </div>
                  <div className="text-[13px] font-semibold text-fg">{lead.businessName}</div>
                  <a href={lead.website} target="_blank" rel="noreferrer" className="text-xs text-brand-600 hover:underline dark:text-brand-400">
                    {lead.website}
                  </a>
                  {lead.snippet && <p className="mt-1 text-xs text-fg-muted">{lead.snippet.slice(0, 180)}</p>}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="w-80 shrink-0 rounded-xl border border-border bg-card p-4 shadow-sm">
          <h2 className="mb-2 text-sm font-semibold text-fg">Activity</h2>
          {steps.length === 0 && <p className="py-8 text-center text-xs text-fg-muted">Step log will appear here.</p>}
          <div className="max-h-[42vh] overflow-y-auto">
            <ul className="space-y-1 text-[11.5px] text-fg-muted">
              {steps.map((s, i) => (
                <li key={i} className="leading-snug">· {s}</li>
              ))}
            </ul>
          </div>
          {leadFile && (
            <p className="mt-2 border-t border-border pt-2 text-[11px] text-fg-muted">
              Saved to <code className="text-fg">{leadFile}</code>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}