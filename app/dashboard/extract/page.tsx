"use client";

import { useState, useEffect, useCallback, useRef } from "react";

type JobStatus = "queued" | "running" | "done" | "failed";

interface Job {
  id: string;
  query: string;
  params: Record<string, unknown>;
  status: JobStatus;
  lane: string;
  error?: string | null;
  createdAt: string;
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

const STATUS_COLORS: Record<JobStatus, string> = {
  queued:  "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-200",
  running: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200",
  done:    "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200",
  failed:  "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
};

export default function ExtractPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedJob, setSelectedJob] = useState<JobDetail | null>(null);
  const [query, setQuery] = useState("");
  const [engine, setEngine] = useState<"ddg" | "google">("ddg");
  const [maxResults, setMaxResults] = useState(50);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
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
    if (!query.trim()) { setFormError("Query is required"); return; }
    setFormError("");
    setSubmitting(true);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: query.trim(),
          lane: engine === "google" ? "heavy" : "light",
          params: { engine, maxResults },
        }),
      });
      if (res.ok) {
        setQuery("");
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

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Extract Leads</h1>
        <p className="mt-1 text-sm text-fg-muted">Search the web and extract contact information.</p>
      </div>

      {/* Submit form */}
      <div className="rounded-xl border border-border bg-card p-4 flex flex-col gap-3">
        <div className="flex gap-3">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void submitJob(); }}
            placeholder='e.g. "dentists in Austin TX"'
            className="flex-1 rounded-lg border border-border bg-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
          />
          <button
            onClick={() => void submitJob()}
            disabled={submitting}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {submitting ? "Submitting…" : "Search"}
          </button>
        </div>
        <div className="flex gap-4 items-center text-sm">
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
        </div>
        {formError && <p className="text-sm text-red-600 dark:text-red-400">{formError}</p>}
      </div>

      {/* Job list + detail */}
      <div className="flex flex-1 gap-4 overflow-hidden">
        {/* Job list */}
        <div className="w-72 flex-shrink-0 overflow-y-auto rounded-xl border border-border bg-card">
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
                <span>{job.lane} · {job._count?.leads ?? 0} leads</span>
                {(job.status === "queued" || job.status === "running") && (
                  <button
                    onClick={(e) => { e.stopPropagation(); void stopJob(job.id); }}
                    className="text-red-500 hover:underline"
                  >
                    Stop
                  </button>
                )}
              </div>
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
                    {selectedJob.lane} lane · {selectedJob.leads.length} leads
                  </p>
                </div>
                <span className={`rounded px-2 py-1 text-xs font-medium ${STATUS_COLORS[selectedJob.status]}`}>
                  {selectedJob.status}
                </span>
              </div>
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
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-fg-muted">
                        <th className="pb-2 pr-3 font-medium">Business</th>
                        <th className="pb-2 pr-3 font-medium">Contact</th>
                        <th className="pb-2 pr-3 font-medium">Email</th>
                        <th className="pb-2 pr-3 font-medium">Phone</th>
                        <th className="pb-2 font-medium">Website</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedJob.leads.map((lead) => (
                        <tr key={lead.id} className="border-b border-border last:border-0">
                          <td className="py-2 pr-3">{lead.businessName ?? "—"}</td>
                          <td className="py-2 pr-3">{lead.contactName ?? "—"}</td>
                          <td className="py-2 pr-3">
                            {lead.email
                              ? <a href={`mailto:${lead.email}`} className="text-brand-600 hover:underline">{lead.email}</a>
                              : "—"}
                          </td>
                          <td className="py-2 pr-3">{lead.phone ?? "—"}</td>
                          <td className="py-2">
                            {lead.website
                              ? <a href={lead.website} target="_blank" rel="noopener noreferrer"
                                  className="block max-w-[160px] truncate text-brand-600 hover:underline">
                                  {lead.website}
                                </a>
                              : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
