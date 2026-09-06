"use client";

import Link from "next/link";
import { useState, useEffect, useCallback, useRef } from "react";

type JobStatus = "queued" | "running" | "done" | "failed" | "paused";

interface Job {
  id: string;
  query: string;
  template: string;
  params: Record<string, unknown>;
  status: JobStatus;
  lane: string;
  error?: string | null;
  createdAt: string;
  // Task 14 live activity feed — the worker's current step, refreshed by the
  // 4s poll while a job runs. null for jobs that never reported a step.
  currentStep?: string | null;
  _count?: { leads: number };
}

interface Lead {
  id: string;
  email?: string | null;
  phone?: string | null;
  contactName?: string | null;
  businessName?: string | null;
  website?: string | null;
  sourceUrl?: string | null;
  snippet?: string | null;
  createdAt: string;
}

interface JobDetail extends Job {
  leads: Lead[];
}

type Template = "lead" | "hr" | "plain";

const STATUS_COLORS: Record<JobStatus, string> = {
  queued:  "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-200",
  running: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200",
  done:    "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200",
  failed:  "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  paused:  "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200",
};

const TEMPLATES: { id: Template; label: string; description: string }[] = [
  { id: "lead", label: "Lead Search", description: "Find businesses and their contact info" },
  { id: "hr", label: "HR / Recruiting", description: "Find candidates / job postings" },
  { id: "plain", label: "Plain Search", description: "Open-ended web search" },
];

const EXPERIENCE_LEVELS = ["", "Junior", "Mid", "Senior"];

export default function ExtractPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedJob, setSelectedJob] = useState<JobDetail | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");

  // Current template + per-template field state.
  const [template, setTemplate] = useState<Template>("lead");

  // Lead Search fields
  const [findTerms, setFindTerms] = useState<string[]>(["plumbers"]);
  const [findInput, setFindInput] = useState("");
  const [location, setLocation] = useState<string[]>([]);
  const [locationInput, setLocationInput] = useState("");
  const [emailDomains, setEmailDomains] = useState<string[]>([]);
  const [emailDomainInput, setEmailDomainInput] = useState("");
  const [engine, setEngine] = useState<"ddg" | "google">("ddg");
  const [maxResults, setMaxResults] = useState(50);
  // 0 = disabled (no auto-expansion) — the worker only expands terms when
  // this is a positive number and the first pass falls short of it.
  const [minResults, setMinResults] = useState(0);
  // Real crawler (Task 13): how many Google result pages to crawl per query, and
  // the wall-clock cap (minutes) before the job pauses at a query boundary.
  const [pagesPerQuery, setPagesPerQuery] = useState(5);
  const [maxDurationMinutes, setMaxDurationMinutes] = useState(30);
  // Display-only preference, saved per job — extraction always captures every
  // field regardless (business/contact/phone/website) so nothing is lost; this
  // only controls which columns the results table renders for THIS job. Default
  // matches the "the search we need is mostly emails for sending" ask: name +
  // email, not the full business/phone/website table.
  const [resultMode, setResultMode] = useState<"namesEmails" | "full" | "emailsOnly">("namesEmails");

  // HR / Recruiting fields (scoped; automation coming soon)
  const [jobTitles, setJobTitles] = useState<string[]>(["Software Engineer"]);
  const [jobTitleInput, setJobTitleInput] = useState("");
  const [hrLocation, setHrLocation] = useState("");
  const [experience, setExperience] = useState("");

  // Plain Search field
  const [plainInput, setPlainInput] = useState("");

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const selectedJobRef = useRef<JobDetail | null>(null);

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/jobs");
      if (res.ok) setJobs((await res.json()) as Job[]);
    } catch {}
  }, []);

  const fetchJobDetail = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/jobs/${id}`);
      if (res.ok) setSelectedJob((await res.json()) as JobDetail);
    } catch {}
  }, []);

  useEffect(() => { selectedJobRef.current = selectedJob; }, [selectedJob]);

  useEffect(() => {
    void fetchJobs();
    pollRef.current = setInterval(() => {
      void fetchJobs();
      const cur = selectedJobRef.current;
      if (cur && (cur.status === "queued" || cur.status === "running")) {
        void fetchJobDetail(cur.id);
      }
    }, 4000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchJobs, fetchJobDetail]);

  async function submitJob() {
    setFormError("");

    if (template === "hr" || template === "plain") {
      // No automation backend exists yet for these (PLAN.md Addendum 5) — never
      // run the lead engine against them. Say so plainly instead of a silent no-op.
      setFormError(
        template === "hr"
          ? "HR / Recruiting automation is coming soon. Lead Search is ready end-to-end today."
          : "Plain Search automation is coming soon. Lead Search is ready end-to-end today."
      );
      return;
    }

    const finds = findTerms.map((t) => t.trim()).filter((t) => t.length > 0);
    if (finds.length === 0) {
      setFormError("Add at least one 'Find' term");
      return;
    }
    const locs = location.map((t) => t.trim()).filter((t) => t.length > 0);

    // Cross-multiply Find × Location so "plumbers","carpenters" × "Texas","USA"
    // becomes ["plumbers in Texas","plumbers in USA","carpenters in Texas","carpenters in USA"].
    // With no Location terms, fall back to just the Find terms unchanged (today's behavior).
    // Capped at 20 — an uncapped cross-product (e.g. 10 Finds x 10 Locations = 100
    // queries) fires that many concurrent searches at once (worker/automation.py
    // runs the whole query list via asyncio.gather), which risks tripping
    // DuckDuckGo/Google rate limits and starving other jobs on the same worker.
    const MAX_QUERIES = 20;
    const rawQueries: string[] =
      locs.length === 0
        ? finds
        : finds.flatMap((f) => locs.map((l) => `${f} in ${l}`));
    const queries = rawQueries.slice(0, MAX_QUERIES);
    if (rawQueries.length > MAX_QUERIES) {
      setFormError(
        `That's ${rawQueries.length} searches (Find × Location) — only running the first ${MAX_QUERIES} to avoid rate limits. Try fewer terms per job.`
      );
    }

    // Email domain allowlist: a comma-separated list of exact domains or *.suffix/.suffix
    // patterns (e.g. "gmail.com, *.edu"). Only sent when at least one chip is present.
    const domains = emailDomains.map((t) => t.trim()).filter((t) => t.length > 0);
    const emailDomainParam = domains.length > 0 ? { emailDomains: domains.join(", ") } : {};
    const minResultsParam = minResults > 0 ? { minResults } : {};

    setSubmitting(true);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          queries,
          template: "lead",
          params: { engine, maxResults, ...emailDomainParam, ...minResultsParam, pagesPerQuery, maxDurationMinutes, resultMode },
        }),
      });
      if (res.ok) {
        void fetchJobs();
      } else {
        const d = (await res.json()) as { error?: string };
        setFormError(d.error ?? "Failed to submit");
      }
    } catch {
      setFormError("Network error");
    } finally {
      setSubmitting(false);
    }
  }

  async function stopJob(id: string) {
    await fetch(`/api/jobs/${id}/stop`, { method: "POST" });
    void fetchJobs();
    if (selectedJob?.id === id) void fetchJobDetail(id);
  }

  // Task 13 resume control: PATCH /api/jobs/[id] with {action:"pause"|"resume"}.
  async function controlJob(id: string, action: "pause" | "resume") {
    await fetch(`/api/jobs/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    // Pause: the dispatcher's next poll turns it into a persisted "paused"
    // state. Resume: the job goes back to "queued" immediately and Phase A's
    // next tick dispatches it through the normal lane-concurrency claim
    // (same path a brand-new job takes) — either way, refresh shortly after
    // to pick up the transition rather than waiting on the 15s poll.
    setTimeout(() => void fetchJobDetail(id), 1500);
    void fetchJobs();
    if (selectedJob?.id === id) void fetchJobDetail(id);
  }

  async function deleteJob(id: string) {
    if (!window.confirm("Delete this job run and its leads? This can't be undone.")) return;
    setFormError("");
    try {
      const res = await fetch(`/api/jobs/${id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormError(typeof data.error === "string" ? data.error : "Couldn't delete this job.");
        return;
      }
      if (selectedJob?.id === id) setSelectedJob(null);
      void fetchJobs();
    } catch {
      setFormError("Network error while deleting.");
    }
  }

  function addChip(list: string[], setList: (v: string[]) => void, input: string, setInput: (v: string) => void) {
    const term = input.trim();
    if (!term) return;
    if (!list.some((t) => t.trim().toLowerCase() === term.toLowerCase())) {
      setList([...list, term]);
    }
    setInput("");
  }

  function removeChip(list: string[], setList: (v: string[]) => void, index: number) {
    setList(list.filter((_, i) => i !== index));
  }

  // A labeled multi-chip column, matching the original Find column's visual treatment.
  function chipColumn(opts: {
    label: string;
    placeholder: string;
    help?: string;
    optional?: boolean;
    chips: string[];
    setChips: (v: string[]) => void;
    input: string;
    setInput: (v: string) => void;
  }) {
    return (
      <div className="rounded-lg border border-border p-3 flex flex-col gap-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <span>{opts.label}</span>
          {opts.optional && <span className="text-xs font-normal text-fg-muted">(optional)</span>}
        </div>
        <div className="flex min-h-[28px] flex-wrap gap-2">
          {opts.chips.length === 0 ? (
            <span className="text-xs text-fg-muted/80">{opts.optional ? "None added" : "Nothing yet"}</span>
          ) : (
            opts.chips.map((term, i) => (
              <span key={`${term}-${i}`} className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-3 py-1 text-sm text-brand-700 dark:bg-brand-900/30 dark:text-brand-300">
                {term}
                <button
                  type="button"
                  onClick={() => removeChip(opts.chips, opts.setChips, i)}
                  className="text-brand-700 hover:text-red-600"
                  aria-label={`Remove ${term}`}
                >
                  ×
                </button>
              </span>
            ))
          )}
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={opts.input}
            onChange={(e) => opts.setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addChip(opts.chips, opts.setChips, opts.input, opts.setInput); }}
            placeholder={opts.placeholder}
            className="flex-1 rounded-lg border border-border bg-input px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
          />
          <button
            type="button"
            onClick={() => addChip(opts.chips, opts.setChips, opts.input, opts.setInput)}
            className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-black/5 dark:hover:bg-white/5"
          >
            Add
          </button>
        </div>
        {opts.help && <p className="text-xs leading-snug text-fg-muted">{opts.help}</p>}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Extract Leads</h1>
        <p className="mt-1 text-sm text-fg-muted">Pick a search template and extract structured results.</p>
      </div>

      {/* Template picker */}
      <div className="rounded-xl border border-border bg-card p-4 flex flex-col gap-4">
        <div className="flex gap-2">
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => { setTemplate(t.id); setFormError(""); }}
              className={`flex-1 rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
                template === t.id
                  ? "border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300"
                  : "border-border bg-transparent text-fg-muted hover:bg-black/5 dark:hover:bg-white/5"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* --- Lead Search --- */}
        {template === "lead" && (
          <div className="flex flex-col gap-3">
            <div className="grid gap-3 md:grid-cols-3">
              {chipColumn({
                label: "Find",
                placeholder: 'e.g. "plumber", press Enter',
                help: "What you want to find — add as many as you like.",
                chips: findTerms,
                setChips: setFindTerms,
                input: findInput,
                setInput: setFindInput,
              })}
              {chipColumn({
                label: "Location",
                placeholder: 'e.g. "Texas" or "USA", press Enter',
                help: 'Combines with Find for each search, e.g. "plumber in Texas".',
                optional: true,
                chips: location,
                setChips: setLocation,
                input: locationInput,
                setInput: setLocationInput,
              })}
              {chipColumn({
                label: "Email domain filter",
                placeholder: 'e.g. "gmail.com" or "*.edu", press Enter',
                help: "Only keep leads whose email matches any listed domain or suffix.",
                optional: true,
                chips: emailDomains,
                setChips: setEmailDomains,
                input: emailDomainInput,
                setInput: setEmailDomainInput,
              })}
            </div>
            <div className="flex flex-wrap gap-4 items-center text-sm">
              <label className="flex items-center gap-2">
                <span className="text-fg-muted">Engine:</span>
                <select
                  value={engine}
                  onChange={(e) => setEngine(e.target.value as "ddg" | "google")}
                  className="rounded border border-border bg-input px-2 py-1 text-sm"
                >
                  <option value="ddg">DuckDuckGo (fast)</option>
                  <option value="google">Google (thorough)</option>
                </select>
              </label>
              <label className="flex items-center gap-2">
                <span className="text-fg-muted">Max results:</span>
                <input
                  type="number"
                  min={10}
                  max={200}
                  value={maxResults}
                  onChange={(e) => setMaxResults(Number(e.target.value))}
                  className="w-20 rounded border border-border bg-input px-2 py-1 text-sm"
                />
              </label>
              <label className="flex items-center gap-2">
                <span className="text-fg-muted">Minimum leads:</span>
                <input
                  type="number"
                  min={0}
                  max={500}
                  value={minResults}
                  onChange={(e) => setMinResults(Number(e.target.value))}
                  className="w-20 rounded border border-border bg-input px-2 py-1 text-sm"
                  title="If the search doesn't find this many leads, the worker automatically tries related terms (e.g. 'near me', 'company') until it does, or runs out of budget."
                />
              </label>
              <label className="flex items-center gap-2">
                <span className="text-fg-muted">Pages/query:</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={pagesPerQuery}
                  onChange={(e) => setPagesPerQuery(Number(e.target.value))}
                  className="w-16 rounded border border-border bg-input px-2 py-1 text-sm"
                  title="How many Google result pages to crawl for each search term (1-20)."
                />
              </label>
              <label className="flex items-center gap-2">
                <span className="text-fg-muted">Max (min):</span>
                <input
                  type="number"
                  min={1}
                  max={180}
                  value={maxDurationMinutes}
                  onChange={(e) => setMaxDurationMinutes(Number(e.target.value))}
                  className="w-16 rounded border border-border bg-input px-2 py-1 text-sm"
                  title="Maximum wall-clock run duration in minutes (up to 180 = 3 hours). The job pauses at a query boundary when this is reached and can be resumed later."
                />
              </label>
              <label className="flex items-center gap-2">
                <span className="text-fg-muted">Results table:</span>
                <select
                  value={resultMode}
                  onChange={(e) => setResultMode(e.target.value as typeof resultMode)}
                  className="rounded border border-border bg-input px-2 py-1 text-sm"
                  title="Which columns the results table shows for this search — doesn't affect what's extracted, just what's displayed."
                >
                  <option value="namesEmails">Names + Emails</option>
                  <option value="emailsOnly">Emails only</option>
                  <option value="full">Full details</option>
                </select>
              </label>
            </div>
          </div>
        )}
{/* --- HR / Recruiting --- */}
        {template === "hr" && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              {jobTitles.map((t, i) => (
                <span key={`${t}-${i}`} className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-3 py-1 text-sm text-brand-700 dark:bg-brand-900/30 dark:text-brand-300">
                  {t}
                  <button
                    type="button"
                    onClick={() => removeChip(jobTitles, setJobTitles, i)}
                    className="text-brand-700 hover:text-red-600"
                    aria-label={`Remove ${t}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={jobTitleInput}
                onChange={(e) => setJobTitleInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addChip(jobTitles, setJobTitles, jobTitleInput, setJobTitleInput); }}
                placeholder='Job title, e.g. "Software Engineer"'
                className="flex-1 rounded-lg border border-border bg-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
              />
              <button
                type="button"
                onClick={() => addChip(jobTitles, setJobTitles, jobTitleInput, setJobTitleInput)}
                className="rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-black/5 dark:hover:bg-white/5"
              >
                Add
              </button>
            </div>
            <div className="flex flex-wrap gap-4 items-center text-sm">
              <label className="flex items-center gap-2">
                <span className="text-fg-muted">Location:</span>
                <input
                  type="text"
                  value={hrLocation}
                  onChange={(e) => setHrLocation(e.target.value)}
                  placeholder="e.g. Austin, TX"
                  className="w-56 rounded border border-border bg-input px-2 py-1 text-sm"
                />
              </label>
              <label className="flex items-center gap-2">
                <span className="text-fg-muted">Experience:</span>
                <select
                  value={experience}
                  onChange={(e) => setExperience(e.target.value)}
                  className="rounded border border-border bg-input px-2 py-1 text-sm"
                >
                  {EXPERIENCE_LEVELS.map((lvl, i) => (
                    <option key={i} value={lvl}>{lvl === "" ? "Any" : lvl}</option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        )}

        {/* --- Plain Search --- */}
        {template === "plain" && (
          <div className="flex flex-col gap-3">
            <input
              type="text"
              value={plainInput}
              onChange={(e) => setPlainInput(e.target.value)}
              placeholder='e.g. "top SaaS companies hiring in Austin this quarter"'
              className="rounded-lg border border-border bg-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
        )}

        <div className="flex gap-2 items-center">
          <button
            onClick={() => void submitJob()}
            disabled={submitting}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {submitting ? "Submitting…" : "Search"}
          </button>
          {template !== "lead" && (
            <span className="text-xs text-fg-muted">Automation for this template ships separately — Lead Search is ready now.</span>
          )}
        </div>
        {formError && <p className="text-sm text-red-600 dark:text-red-400">{formError}</p>}
      </div>
{/* Job list + detail — stacked on mobile (capped-height scrollable list above
    a full-width detail pane), side-by-side from md: up (original layout
    unchanged). A fixed w-72 sidebar next to a flex-1 pane with no responsive
    stacking would otherwise squeeze the detail pane to almost nothing on a
    phone-width screen. */}
      <div className="flex flex-1 flex-col gap-4 overflow-hidden md:flex-row">
        {/* Job list */}
        <div className="max-h-64 w-full flex-shrink-0 overflow-y-auto rounded-xl border border-border bg-card md:h-auto md:max-h-none md:w-72">
          {jobs.length === 0 && (
            <p className="p-4 text-sm text-fg-muted">No jobs yet. Submit a search above.</p>
          )}
          {jobs.map((job) => (
            <div
              key={job.id}
              onClick={() => void fetchJobDetail(job.id)}
              className={`cursor-pointer border-b border-border p-3 last:border-0 hover:bg-black/5 dark:hover:bg-white/5 ${
                selectedJob?.id === job.id ? "bg-brand-50 dark:bg-brand-900/20" : ""
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">{job.query}</span>
                <span className={`flex-shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_COLORS[job.status]}`}>
                  {job.status}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between text-xs text-fg-muted">
                <span>{job.template} · {job.lane} · {job._count?.leads ?? 0} leads</span>
                {(job.status === "queued" || job.status === "running") ? (
                  <span className="flex items-center gap-3">
                    {job.status === "running" && (
                      <button
                        onClick={(e) => { e.stopPropagation(); void controlJob(job.id, "pause"); }}
                        className="text-amber-600 hover:underline dark:text-amber-400"
                      >
                        Pause
                      </button>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); void stopJob(job.id); }}
                      className="text-red-500 hover:underline"
                    >
                      Stop
                    </button>
                  </span>
                ) : (
                  <button
                    onClick={(e) => { e.stopPropagation(); void deleteJob(job.id); }}
                    className="text-fg-muted hover:text-red-500 hover:underline"
                  >
                    Delete
                  </button>
                )}
              </div>
              {/* Task 14 live activity feed — compact per-row step line, only while
                  running and only when it has something to show; keeps the list
                  scannable without surfacing stale text on finished jobs. */}
              {job.status === "running" && job.currentStep?.trim() ? (
                <p className="mt-0.5 truncate text-[11px] text-fg-muted/80" title={job.currentStep}>
                  {job.currentStep}
                </p>
              ) : null}
            </div>
          ))}
        </div>
{/* Lead detail */}
        <div className="flex-1 overflow-y-auto rounded-xl border border-border bg-card">
          {!selectedJob ? (
            <p className="p-6 text-sm text-fg-muted">Select a job to view leads.</p>
          ) : (
            <div className="flex flex-col gap-4 p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="font-semibold">{selectedJob.query}</h2>
                  <p className="mt-0.5 text-xs text-fg-muted">
                    {selectedJob.template} template · {selectedJob.lane} lane · {selectedJob.leads.length} leads
                    {Array.isArray(selectedJob.params?.queries) && selectedJob.params.queries.length > 1 &&
                      <span> · {selectedJob.params.queries.length} terms</span>}
                  </p>
                  {/* Task 14 live activity feed — only while a job is running. A
                      brand-new job's first tick may not have reported a step yet, so
                      fall back to "Starting…" when currentStep is null/empty. */}
                  {selectedJob.status === "running" && (
                    <p className="mt-1 truncate text-xs text-fg-muted/80" title={selectedJob.currentStep ?? undefined}>
                      Currently: {selectedJob.currentStep?.trim() ? selectedJob.currentStep : "Starting…"}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className={`rounded px-2 py-1 text-xs font-medium ${STATUS_COLORS[selectedJob.status]}`}>
                    {selectedJob.status}
                  </span>
                  {selectedJob.status === "running" && (
                    <button
                      onClick={() => void controlJob(selectedJob.id, "pause")}
                      className="rounded-lg border border-border px-3 py-1 text-xs font-medium text-amber-600 hover:bg-black/5 dark:text-amber-400 dark:hover:bg-white/5"
                    >
                      Pause
                    </button>
                  )}
                  {selectedJob.status === "paused" && (
                    <button
                      onClick={() => void controlJob(selectedJob.id, "resume")}
                      className="rounded-lg bg-brand-600 px-3 py-1 text-xs font-medium text-white hover:bg-brand-500"
                    >
                      Resume
                    </button>
                  )}
                  {selectedJob.leads.length > 0 && (
                    <>
                      <a
                        href={`/api/jobs/${selectedJob.id}/export.csv`}
                        download
                        className="rounded-lg border border-border px-3 py-1 text-xs font-medium text-fg hover:bg-black/5 dark:hover:bg-white/5"
                      >
                        Export CSV
                      </a>
                      <a
                        href={`/api/jobs/${selectedJob.id}/export.csv?emailsOnly=1`}
                        download
                        className="rounded-lg border border-border px-3 py-1 text-xs font-medium text-fg hover:bg-black/5 dark:hover:bg-white/5"
                      >
                        Emails only
                      </a>
                      <Link
                        href={`/dashboard/campaigns?fromSearchJob=${selectedJob.id}`}
                        className="rounded-lg bg-brand-600 px-3 py-1 text-xs font-medium text-white hover:bg-brand-500"
                      >
                        Create email campaign
                      </Link>
                    </>
                  )}
                </div>
              </div>
              {selectedJob.status === "done" &&
                typeof selectedJob.params?.minResults === "number" &&
                selectedJob.params.minResults > 0 &&
                selectedJob.leads.length < selectedJob.params.minResults && (
                  <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
                    Found {selectedJob.leads.length} of your {selectedJob.params.minResults}-lead minimum. The
                    worker tried a large set of related-term variations across the full time budget and still came
                    up short — try broader Find/Location terms, a longer duration, or a lower minimum, if you need
                    more.
                  </p>
                )}
              {selectedJob.error && (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300">
                  {selectedJob.error}
                </p>
              )}
              {selectedJob.leads.length === 0 ? (
                <p className="text-sm text-fg-muted">
                  {selectedJob.status === "queued" || selectedJob.status === "running"
                    ? "Waiting for results…"
                    : "No leads found."}
                </p>
              ) : (() => {
                // Display-only — extraction always captured every field regardless
                // of what this job's resultMode was set to at creation time.
                // Falls back to "full" (the ORIGINAL, unconditional table shape),
                // not the new "namesEmails" default — a job created before this
                // feature shipped has no resultMode stored at all, and defaulting
                // it to the new narrower view would silently hide columns that
                // job always showed. Every job created through the form AFTER
                // this change always has an explicit resultMode value already
                // (namesEmails is the FORM's own default, a real stored value,
                // not a display-time fallback), so this only ever applies to
                // pre-existing jobs.
                const mode = (selectedJob.params?.resultMode as string | undefined) ?? "full";
                const showBusiness = mode === "full";
                const showPhone = mode === "full";
                const showWebsite = mode === "full";
                const showContact = mode !== "emailsOnly";
                return (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-fg-muted">
                        {showBusiness && <th className="pb-2 pr-3 font-medium">Business</th>}
                        {showContact && <th className="pb-2 pr-3 font-medium">Name</th>}
                        <th className="pb-2 pr-3 font-medium">Email</th>
                        {showPhone && <th className="pb-2 pr-3 font-medium">Phone</th>}
                        {showWebsite && <th className="pb-2 font-medium">Website</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {selectedJob.leads.map((lead) => (
                        <tr key={lead.id} className="border-b border-border last:border-0">
                          {showBusiness && <td className="py-2 pr-3">{lead.businessName ?? "—"}</td>}
                          {showContact && <td className="py-2 pr-3">{lead.contactName ?? "—"}</td>}
                          <td className="py-2 pr-3">
                            {lead.email
                              ? <a href={`mailto:${lead.email}`} className="text-brand-600 hover:underline">{lead.email}</a>
                              : "—"}
                          </td>
                          {showPhone && <td className="py-2 pr-3">{lead.phone ?? "—"}</td>}
                          {showWebsite && (
                            <td className="py-2">
                              {lead.website
                                ? <a href={lead.website} target="_blank" rel="noopener noreferrer"
                                    className="block max-w-[160px] truncate text-brand-600 hover:underline">
                                    {lead.website}
                                  </a>
                                : "—"}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                );
              })()}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}