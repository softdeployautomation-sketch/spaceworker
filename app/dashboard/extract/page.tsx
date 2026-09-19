"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { Badge, Spinner } from "@/components/ui";
import { Dropdown } from "@/components/dropdown";
import { timeAgo } from "@/lib/format-date";
import { useConfirm } from "@/components/confirm-provider";
import { LocalExtractPage } from "./local-extract";

type JobStatus = "queued" | "running" | "done" | "failed" | "paused" | "stopped";

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
  // Task 15 stall detection — when currentStep's value last actually
  // changed (not just when the dispatcher last polled).
  currentStepAt?: string | null;
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
  // Task 26, Piece 3 — email deliverability validation.
  validationStatus?: string | null; // "unchecked" | "valid" | "invalid"
  validationError?: string | null;
  validatedAt?: string | null;
}

interface JobDetail extends Job {
  leads: Lead[];
}

type Template = "lead" | "hr" | "plain";

// Self-hosted webmail platforms this app can target (worker/filters/
// webmail_platforms.py is the single source of truth for the codes and their
// actual detection fingerprints — this list is just the UI's checkbox
// labels, kept in the same order/codes).
const WEBMAIL_PLATFORM_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "roundcube", label: "RoundCube" },
  { value: "squirrelmail", label: "SquirrelMail" },
  { value: "rainloop", label: "RainLoop" },
  { value: "zimbra", label: "Zimbra" },
  { value: "open-xchange", label: "Open-Xchange" },
];

const STATUS_COLORS: Record<JobStatus, string> = {
  queued:  "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-200",
  running: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200",
  done:    "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200",
  failed:  "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  paused:  "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200",
  // Distinct from "failed" — a user-initiated stop is not an error.
  stopped: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
};

// Task 15 stall detection. 5 minutes is deliberately generous — long enough
// that a slow PDF download, a CAPTCHA backoff (worker/automation.py's
// CAPTCHA_BACKOFF_SECONDS=20), or the human-pacing delay between page loads
// (1.5-3.5s each, but compounding across a slow query) never look like a
// stall, while still catching an actually-stuck worker within a reasonable
// wait.
const STALL_THRESHOLD_MS = 5 * 60 * 1000;

function isStalled(job: Pick<Job, "status" | "currentStepAt">): boolean {
  if (job.status !== "running" || !job.currentStepAt) return false;
  return Date.now() - new Date(job.currentStepAt).getTime() > STALL_THRESHOLD_MS;
}

// Task 26, Piece 1 — compact leads UI. A job's raw `query` is the cross-multiplied,
// "|"-joined list (e.g. "foo in usa | foo in usa 2025_2026 | …"), which runs hundreds
// of characters for a real multi-term run. Every job's params stores exactly what the
// user typed (findTerms/locationTerms), so reconstruct the compact human summary from
// those and fall back to the query's first pipe-segment only for jobs created before
// that field existed. The FULL query is still surfaced as a title tooltip at each call
// site — we stop it consuming layout width, we don't destroy the information.
function summarizeQuery(job: Pick<Job, "query" | "params">): string {
  const findTerms = Array.isArray(job.params?.findTerms) ? (job.params.findTerms as string[]) : null;
  const locationTerms = Array.isArray(job.params?.locationTerms) ? (job.params.locationTerms as string[]) : null;
  if (findTerms && findTerms.length > 0) {
    const findLabel = findTerms.length === 1 ? findTerms[0] : `${findTerms[0]} +${findTerms.length - 1}`;
    if (locationTerms && locationTerms.length > 0) {
      const locLabel = locationTerms.length === 1 ? locationTerms[0] : `${locationTerms.length} locations`;
      return `${findLabel} in ${locLabel}`;
    }
    return findLabel;
  }
  return job.query.split(" | ")[0];
}

const TEMPLATES: { id: Template; label: string; description: string }[] = [
  { id: "lead", label: "Lead Search", description: "Find businesses and their contact info" },
  { id: "hr", label: "HR / Recruiting", description: "Find candidates / job postings" },
  { id: "plain", label: "Plain Search", description: "Open-ended web search" },
];

const EXPERIENCE_LEVELS = ["", "Junior", "Mid", "Senior"];

export function WebExtractPage() {
  const confirm = useConfirm();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedJob, setSelectedJob] = useState<JobDetail | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");

  // Session merge — selectedJobIds is the Set of job ids checked in the job
  // list sidebar; when 2+ are selected a bar appears to combine those SESSIONS
  // (possibly from different queries) into one. This replaces an earlier
  // per-lead merge feature that combined near-duplicate rows WITHIN a single
  // session — that was the wrong unit: merging leads inside one already-single
  // session solved nothing real, while merging whole sessions (e.g. several
  // fragmented runs of the same or related queries) is what's actually useful.
  const [selectedJobIds, setSelectedJobIds] = useState<Set<string>>(new Set<string>());
  const [sessionMergeBusy, setSessionMergeBusy] = useState(false);
  const [sessionMergeError, setSessionMergeError] = useState("");

  // Task 26, Piece 3 — lead upload (import .csv/.txt/.json/.xlsx into a new job)
  // and per-job batch email validation. Both are additive UI on the existing job
  // list + leads table: an upload just creates a "done" job, validation writes
  // validationStatus on the Lead rows.
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [uploadDone, setUploadDone] = useState<{ jobId: string; imported: number; fileName: string } | null>(null);
  const dragDepthRef = useRef(0);
  const [dragging, setDragging] = useState(false);

  const [validateBusy, setValidateBusy] = useState(false);
  // Task 26, Piece 7a — the old `validateMessage` (a one-shot POST-response string)
  // was replaced by a LIVE derived summary computed from the selected job's own leads
  // on every render (see the actions row). This state now carries ONLY validation
  // ERROR text; the success summary no longer needs persisting at all.
  const [validateError, setValidateError] = useState<string | null>(null);

  // Current template + per-template field state.
  const [template, setTemplate] = useState<Template>("lead");

  // Lead Search fields
  const [findTerms, setFindTerms] = useState<string[]>(["plumbers"]);
  const [findInput, setFindInput] = useState("");
  const [location, setLocation] = useState<string[]>([]);
  const [locationInput, setLocationInput] = useState("");
  const [emailDomains, setEmailDomains] = useState<string[]>([]);
  const [emailDomainInput, setEmailDomainInput] = useState("");
  // Webmail platform targeting (worker/filters/webmail_platforms.py) — two
  // independent, mutually-exclusive modes; see the checkbox group's own
  // helper text for what each actually does.
  const [webmailPlatforms, setWebmailPlatforms] = useState<string[]>([]);
  const [verifyWebmail, setVerifyWebmail] = useState(false);
  const [engine, setEngine] = useState<"ddg" | "google">("ddg");
  const [maxResults, setMaxResults] = useState(50000);
  // 0 = disabled (no auto-expansion) — the worker only expands terms when
  // this is a positive number and the first pass falls short of it.
  const [minResults, setMinResults] = useState(500);
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

  // Task 26, Piece 1 — auto-scroll to the newest lead while a job runs. The leads
  // table's scroll container is `leadsScrollRef`. prevLeadCountRef tracks how many
  // leads we've already revealed so we only scroll on GROWTH (not every 4s poll
  // tick); prevJobIdRef resets that baseline when a different job is selected so
  // simply opening a finished job doesn't yank the view; userScrolledUpRef lets a
  // user reviewing history opt out (cleared once they return near the bottom).
  const leadsScrollRef = useRef<HTMLDivElement | null>(null);
  const prevLeadCountRef = useRef(0);
  const prevJobIdRef = useRef<string | null>(null);
  const userScrolledUpRef = useRef(false);

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

  // Deep link support (2026-09-12) — added so the Campaigns picker's "open this
  // job on the Extract page" link (shown when a job hasn't been validated yet)
  // actually lands on that job, instead of just the page.
  const searchParams = useSearchParams();
  const deepLinkJobId = searchParams.get("job");
  useEffect(() => {
    if (deepLinkJobId) void fetchJobDetail(deepLinkJobId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkJobId]);

  // Task 26, Piece 1 — auto-scroll the leads table to the newest lead. Only fires
  // when the count INCREASES and the user hasn't scrolled up to read history, so
  // a manual review isn't yanked back down by an unrelated re-render.
  useEffect(() => {
    const id = selectedJob?.id ?? null;
    const count = selectedJob?.leads.length ?? 0;
    if (id !== prevJobIdRef.current) {
      prevJobIdRef.current = id;
      prevLeadCountRef.current = count;
      userScrolledUpRef.current = false;
      return;
    }
    if (count > prevLeadCountRef.current && !userScrolledUpRef.current && leadsScrollRef.current) {
      leadsScrollRef.current.scrollTo({ top: leadsScrollRef.current.scrollHeight, behavior: "smooth" });
    }
    prevLeadCountRef.current = count;
  }, [selectedJob?.id, selectedJob?.leads.length]);

  // Track whether the user has scrolled up to read earlier leads. "At the bottom"
  // is judged with a 40px tolerance so landing on the final row counts as being
  // at the newest lead even if it isn't the very last pixel.
  function handleLeadsScroll() {
    const el = leadsScrollRef.current;
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
    userScrolledUpRef.current = !atBottom;
  }

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
    // Capped at 300, matching worker/automation.py's own MAX_TOTAL_QUERIES ceiling on
    // the total query budget it will ever process for one job — raising this past
    // 300 would just mean the extra terms get silently dropped deeper in the
    // pipeline with no warning surfaced here, so this is the real usable ceiling,
    // not an arbitrary UI restriction. (Previously capped at 20 based on a stale
    // assumption that queries fire concurrently via asyncio.gather; confirmed by
    // reading the current worker code that run_automation's main loop processes
    // exactly one query at a time, sequentially, with its own pause/resume and
    // wall-clock deadline — there's no concurrent-firing rate-limit risk from a
    // longer query list, it just makes one job take longer.)
    const MAX_QUERIES = 300;
    const rawQueries: string[] =
      locs.length === 0
        ? finds
        : finds.flatMap((f) => locs.map((l) => `${f} in ${l}`));
    const queries = rawQueries.slice(0, MAX_QUERIES);
    if (rawQueries.length > MAX_QUERIES) {
      setFormError(
        `That's ${rawQueries.length} searches (Find × Location) — only running the first ${MAX_QUERIES} per job. Split the rest into another job.`
      );
    }

    // Email domain allowlist: a comma-separated list of exact domains or *.suffix/.suffix
    // patterns (e.g. "gmail.com, *.edu"). Only sent when at least one chip is present.
    const domains = emailDomains.map((t) => t.trim()).filter((t) => t.length > 0);
    const emailDomainParam = domains.length > 0 ? { emailDomains: domains.join(", ") } : {};
    const minResultsParam = minResults > 0 ? { minResults } : {};
    // Webmail platform targeting — see the checkbox group below for the two
    // modes. Search mode (webmailPlatforms) and verify mode (verifyWebmail)
    // are mutually exclusive; the worker prioritizes search mode if somehow
    // both are set (see _search_and_extract's verify_webmail computation).
    const webmailParam = webmailPlatforms.length > 0 ? { webmailPlatforms } : {};
    const verifyWebmailParam = verifyWebmail && webmailPlatforms.length === 0 ? { verifyWebmail: true } : {};

    setSubmitting(true);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          queries,
          template: "lead",
          // findTerms/locationTerms are stored purely so a later "Load" can
          // reconstruct the original Find/Location split exactly, rather than
          // the flattened `queries` cross-product (e.g. 2 Finds x 5 Locations
          // reloading as 10 separate Find chips instead of 2 + 5) — the worker
          // itself never reads either field, only `queries`.
          params: {
            engine,
            maxResults,
            ...emailDomainParam,
            ...minResultsParam,
            ...webmailParam,
            ...verifyWebmailParam,
            pagesPerQuery,
            maxDurationMinutes,
            resultMode,
            findTerms: finds,
            locationTerms: locs,
          },
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
    if (!(await confirm({
      title: "Delete this job run?",
      description: "This deletes the job and its leads. This can't be undone.",
      confirmLabel: "Delete",
    }))) return;
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

  // Session-merge helpers. toggleJobSelected flips one job's checkbox in the
  // sidebar list (writer, not mutator, so we always hand React a new Set).
  function toggleJobSelected(id: string) {
    const next = new Set(selectedJobIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedJobIds(next);
  }

  // Combines the selected sessions into one via POST /api/jobs/merge, then
  // refreshes the job list and opens the new merged session.
  async function confirmMergeSessions() {
    if (selectedJobIds.size < 2) return;
    setSessionMergeBusy(true);
    setSessionMergeError("");
    try {
      const res = await fetch("/api/jobs/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobIds: [...selectedJobIds] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSessionMergeError(typeof data.error === "string" ? data.error : "Merge failed.");
        return;
      }
      setSelectedJobIds(new Set());
      await fetchJobs();
      if (typeof data.jobId === "string") void fetchJobDetail(data.jobId);
    } catch {
      setSessionMergeError("Network error while merging.");
    } finally {
      setSessionMergeBusy(false);
    }
  }

  // Task 26, Piece 3 — lead import (uploads become a new "done" job in the same
  // list) and batch validation. Both are deliberately thin: they call the new
  // routes, then re-fetch whatever changed to drive the existing UI.
  function openUploadModal() {
    setUploadBusy(false);
    setUploadError("");
    setUploadDone(null);
    setUploadOpen(true);
  }

  async function performUpload(file?: File | null) {
    if (!file || uploadBusy) return;
    // Client-side guard mirrors the server's 20MB cap so a huge file fails fast
    // without a round-trip.
    if (file.size > 20 * 1024 * 1024) {
      setUploadError("File is larger than the 20MB limit.");
      return;
    }
    setUploadError("");
    setUploadBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/leads/upload", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setUploadError(typeof data.error === "string" ? data.error : "Upload failed.");
        return;
      }
      setUploadDone({
        jobId: typeof data.jobId === "string" ? data.jobId : "",
        imported: typeof data.imported === "number" ? data.imported : 0,
        fileName: file.name,
      });
      // Refresh the job list and jump straight to the freshly-uploaded job so the
      // imported leads (and their new "Validate all" button) are visible at once.
      void fetchJobs();
      if (typeof data.jobId === "string" && data.jobId) void fetchJobDetail(data.jobId);
    } catch {
      setUploadError("Network error while uploading.");
    } finally {
      setUploadBusy(false);
    }
  }

  // Validates every currently-unchecked lead in the selected job (syntax + MX),
  // then re-fetches so the status pills in the table update in place. The result
  // summary is NOT set here anymore — Task 26, Piece 7a made it a live derived count
  // from the re-fetched leads, so the success line and stale-state bug both vanish.
  async function validateAll() {
    if (!selectedJob || validateBusy) return;
    setValidateBusy(true);
    setValidateError(null);
    try {
      const res = await fetch(`/api/jobs/${selectedJob.id}/validate`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setValidateError(
          typeof data.error === "string" ? `Validation failed: ${data.error}` : "Validation failed.",
        );
        return;
      }
      void fetchJobDetail(selectedJob.id);
    } catch {
      setValidateError("Network error while validating.");
    } finally {
      setValidateBusy(false);
    }
  }

  // Task 26, Piece 7c — discard just the invalid leads in the selected job (after
  // "Validate all" flags them). On success refetch the job detail so the table
  // drops the deleted rows immediately, plus the job list so its lead counts
  // stay right.
  async function deleteInvalidLeads() {
    if (!selectedJob) return;
    const invalidCount = selectedJob.leads.filter((l) => l.validationStatus === "invalid").length;
    if (invalidCount === 0) return;
    if (!(await confirm({
      title: `Delete ${invalidCount} invalid lead${invalidCount === 1 ? "" : "s"}?`,
      description: "Valid and unchecked leads in this job are kept.",
      confirmLabel: "Delete",
    }))) return;
    try {
      const res = await fetch(`/api/jobs/${selectedJob.id}/leads/delete-invalid`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setValidateError(typeof data.error === "string" ? data.error : "Couldn't delete invalid leads.");
        return;
      }
      void fetchJobDetail(selectedJob.id);
      void fetchJobs();
    } catch {
      setValidateError("Network error while deleting invalid leads.");
    }
  }

  // Attempts to un-cross-multiply a job's flat `queries` list back into its
  // original Find x Location split, for jobs saved before findTerms/
  // locationTerms were persisted directly (see the submit handler below).
  // `queries` was built as finds.flatMap(f => locs.map(l => `${f} in ${l}`)),
  // so a clean split exists iff every entry contains " in " and the
  // recovered prefix/suffix sets form an EXACT cross product (their sizes
  // multiply to the total count, and every combination is actually present)
  // — anything short of that (a freeform term that happens to contain " in ",
  // a partial/irregular list) bails out to null rather than guessing wrong.
  function tryFactorQueries(queries: string[]): { finds: string[]; locations: string[] } | null {
    const SEP = " in ";
    if (queries.length < 2) return null;
    const finds: string[] = [];
    const locations: string[] = [];
    const findsSeen = new Set<string>();
    const locationsSeen = new Set<string>();
    for (const q of queries) {
      const idx = q.indexOf(SEP);
      if (idx === -1) return null;
      const find = q.slice(0, idx);
      const loc = q.slice(idx + SEP.length);
      if (!findsSeen.has(find)) { findsSeen.add(find); finds.push(find); }
      if (!locationsSeen.has(loc)) { locationsSeen.add(loc); locations.push(loc); }
    }
    if (finds.length * locations.length !== queries.length) return null;
    const querySet = new Set(queries);
    for (const f of finds) {
      for (const l of locations) {
        if (!querySet.has(`${f}${SEP}${l}`)) return null;
      }
    }
    return { finds, locations };
  }

  // Loads a past run's search back into the form so it can be edited (add/
  // remove terms, change settings) and resubmitted as a brand-new job — the
  // original job itself is untouched.
  function loadJobIntoForm(job: Job) {
    const p = job.params ?? {};
    const queries = Array.isArray(p.queries)
      ? p.queries.filter((q): q is string => typeof q === "string" && q.trim().length > 0)
      : [];
    const savedFinds = Array.isArray(p.findTerms)
      ? p.findTerms.filter((q): q is string => typeof q === "string" && q.trim().length > 0)
      : [];
    const savedLocations = Array.isArray(p.locationTerms)
      ? p.locationTerms.filter((q): q is string => typeof q === "string" && q.trim().length > 0)
      : [];
    // Prefer the exact split this job actually saved; fall back to
    // reconstructing it from `queries` for jobs created before that existed.
    const factored = savedFinds.length > 0
      ? { finds: savedFinds, locations: savedLocations }
      : tryFactorQueries(queries);

    setTemplate((job.template === "hr" || job.template === "plain" ? job.template : "lead") as Template);
    setFindTerms(factored ? factored.finds : queries.length > 0 ? queries : [job.query]);
    setFindInput("");
    setLocation(factored ? factored.locations : []);
    setLocationInput("");
    const domainsRaw = typeof p.emailDomains === "string" ? p.emailDomains : "";
    setEmailDomains(
      domainsRaw
        .split(",")
        .map((d) => d.trim())
        .filter((d) => d.length > 0),
    );
    setEmailDomainInput("");
    setWebmailPlatforms(
      Array.isArray(p.webmailPlatforms)
        ? p.webmailPlatforms.filter((v): v is string => typeof v === "string")
        : [],
    );
    setVerifyWebmail(p.verifyWebmail === true);
    setEngine(p.engine === "google" ? "google" : "ddg");
    if (typeof p.maxResults === "number") setMaxResults(p.maxResults);
    setMinResults(typeof p.minResults === "number" ? p.minResults : 0);
    if (typeof p.pagesPerQuery === "number") setPagesPerQuery(p.pagesPerQuery);
    if (typeof p.maxDurationMinutes === "number") setMaxDurationMinutes(p.maxDurationMinutes);
    if (p.resultMode === "namesEmails" || p.resultMode === "full" || p.resultMode === "emailsOnly") {
      setResultMode(p.resultMode);
    }
    setFormError("");
    window.scrollTo({ top: 0, behavior: "smooth" });
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
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Extract Leads</h1>
          <p className="mt-1 text-sm text-fg-muted">Pick a search template and extract structured results.</p>
        </div>
        {/* Task 26, Piece 3 — bulk import entry point. Uploads land as a new "done"
            job in the SAME list below, so the imported leads reuse the existing
            table (and its new validate/merge actions). */}
        <button
          type="button"
          onClick={openUploadModal}
          className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-fg hover:bg-black/5 dark:hover:bg-white/5"
        >
          Import leads
        </button>
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

            {/* Webmail platform targeting — two independent modes. Picking any
                platform below switches to SEARCH mode (finds webmail login
                pages directly, fast); the Verify toggle is a separate mode
                that only applies when no platform is checked. */}
            <div className="rounded-lg border border-border bg-bg-elevated/50 p-3">
              <p className="text-sm font-medium text-fg">Self-hosted webmail (RoundCube, SquirrelMail, etc.)</p>
              <p className="mt-1 text-xs text-fg-muted">
                Target businesses running their own webmail instead of Gmail/Outlook/Google Workspace —
                the classic &quot;still on old self-hosted email&quot; signal migration/IT-services outreach looks for.
              </p>
              <div className="mt-2 flex flex-wrap gap-3 text-sm">
                {WEBMAIL_PLATFORM_OPTIONS.map((opt) => (
                  <label key={opt.value} className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={webmailPlatforms.includes(opt.value)}
                      onChange={(e) => {
                        setWebmailPlatforms((prev) =>
                          e.target.checked ? [...prev, opt.value] : prev.filter((v) => v !== opt.value),
                        );
                      }}
                      className="h-4 w-4 cursor-pointer"
                    />
                    {opt.label}
                  </label>
                ))}
              </div>
              {webmailPlatforms.length > 0 ? (
                <p className="mt-2 text-xs text-brand-700 dark:text-brand-400">
                  Search mode: finds indexed webmail login pages directly (fast — no extra requests per
                  lead). Each match becomes a lead with no email (the login page has none) — just the
                  business&apos;s domain and which platform it&apos;s running.
                </p>
              ) : (
                <label className="mt-2 flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={verifyWebmail}
                    onChange={(e) => setVerifyWebmail(e.target.checked)}
                    className="h-4 w-4 cursor-pointer"
                  />
                  Verify each lead&apos;s mail platform
                  <span className="text-xs text-fg-muted">
                    (slower — probes every found lead&apos;s domain for a webmail signature and drops
                    leads that don&apos;t match; use with a normal Find search instead of the checkboxes above)
                  </span>
                </label>
              )}
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
                  max={50000}
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
                  max={50000}
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
        {/* Task 15: max-h-none on desktop here used to remove any real height
            bound, and the Shell layout this page sits in doesn't establish a
            fixed viewport-height context either -- so this list (and the
            leads pane below) just grew the whole page instead of scrolling
            internally. A viewport-relative max-h works regardless of what
            the ancestor chain does, without touching Shell (which every
            other page also uses, some of which want normal page growth). */}
        <div className="max-h-64 w-full flex-shrink-0 overflow-y-auto rounded-xl border border-border bg-card md:h-auto md:max-h-[70vh] md:w-72">
          {jobs.length === 0 && (
            <p className="p-4 text-sm text-fg-muted">No jobs yet. Submit a search above.</p>
          )}
          {jobs.map((job) => {
            // Only a finished session can be merged — one still queued/running
            // still has leads landing on it, so it can't be safely folded into
            // another session and deleted mid-run.
            const mergeable = job.status !== "queued" && job.status !== "running";
            return (
            <div
              key={job.id}
              onClick={() => void fetchJobDetail(job.id)}
              className={`cursor-pointer border-b border-border p-3 last:border-0 hover:bg-black/5 dark:hover:bg-white/5 ${
                selectedJob?.id === job.id ? "bg-brand-50 dark:bg-brand-900/20" : ""
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2">
                  {mergeable && (
                    <input
                      type="checkbox"
                      checked={selectedJobIds.has(job.id)}
                      onChange={(e) => { e.stopPropagation(); toggleJobSelected(job.id); }}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Select session ${summarizeQuery(job)} to merge`}
                      title="Select to merge with other sessions"
                      className="h-4 w-4 flex-shrink-0 cursor-pointer"
                    />
                  )}
                  <span className="truncate text-sm font-medium" title={job.query}>{summarizeQuery(job)}</span>
                </span>
                <span className="flex flex-shrink-0 items-center gap-1">
                  {isStalled(job) && (
                    <span
                      className="h-1.5 w-1.5 rounded-full bg-amber-500"
                      title="May be stalled — no progress in over 5 minutes"
                    />
                  )}
                  <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_COLORS[job.status]}`}>
                    {job.status}
                  </span>
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between text-xs text-fg-muted">
                <span>{job.template} · {job.lane} · {job._count?.leads ?? 0} leads · {timeAgo(job.createdAt)}</span>
                {(job.status === "queued" || job.status === "running") ? (
                  <span className="flex items-center gap-3">
                    <button
                      onClick={(e) => { e.stopPropagation(); loadJobIntoForm(job); }}
                      className="text-brand-600 hover:underline dark:text-brand-400"
                      title="Load this run's search into the form above"
                    >
                      Load
                    </button>
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
                  <span className="flex items-center gap-3">
                    <button
                      onClick={(e) => { e.stopPropagation(); loadJobIntoForm(job); }}
                      className="text-brand-600 hover:underline dark:text-brand-400"
                      title="Load this run's search into the form above"
                    >
                      Load
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); void deleteJob(job.id); }}
                      className="text-fg-muted hover:text-red-500 hover:underline"
                    >
                      Delete
                    </button>
                  </span>
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
            );
          })}
          {selectedJobIds.size >= 2 && (
            <div className="sticky bottom-0 z-10 border-t border-brand-500 bg-brand-50 p-2 dark:bg-brand-900/40">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-brand-700 dark:text-brand-300">
                  {selectedJobIds.size} sessions selected
                </span>
                <button
                  onClick={() => void confirmMergeSessions()}
                  disabled={sessionMergeBusy}
                  className="ml-auto rounded-lg bg-brand-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
                >
                  {sessionMergeBusy ? "Merging…" : `Merge ${selectedJobIds.size} sessions`}
                </button>
              </div>
              {sessionMergeError && (
                <p className="mt-1 text-xs text-red-600 dark:text-red-400">{sessionMergeError}</p>
              )}
            </div>
          )}
        </div>
{/* Lead detail */}
        <div className="max-h-[70vh] flex-1 overflow-y-auto rounded-xl border border-border bg-card">
          {!selectedJob ? (
            <p className="p-6 text-sm text-fg-muted">Select a job to view leads.</p>
          ) : (
            <div className="flex flex-col gap-4 p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="font-semibold" title={selectedJob.query}>{summarizeQuery(selectedJob)}</h2>
                  <p className="mt-0.5 text-xs text-fg-muted">
                    {selectedJob.template} template · {selectedJob.lane} lane · {selectedJob.leads.length} leads · {timeAgo(selectedJob.createdAt)}
                    {Array.isArray(selectedJob.params?.queries) && selectedJob.params.queries.length > 1 &&
                      <span> · {selectedJob.params.queries.length} terms</span>}
                  </p>
                  {/* Task 26, Piece 1 — the live activity feed + stalled warning moved
                      BELOW the leads table (next to the auto-scroll) so the newest
                      lead and the step that just found it are visible together without
                      scrolling. See the block rendered after the table/empty-state. */}
                </div>
                <div className="flex flex-wrap items-center gap-2">
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
                  {/* Task 26, Piece 7e — job control (Pause/Resume) and the primary
                      next action (Create email campaign) stay as their own visible
                      buttons; the export variants + Validate all collapse into one
                      Actions dropdown instead of five same-styled flat controls. */}
                  {selectedJob.leads.length > 0 && (
                    <Link
                      href={`/dashboard/campaigns?fromSearchJob=${selectedJob.id}`}
                      className="rounded-lg bg-brand-600 px-3 py-1 text-xs font-medium text-white hover:bg-brand-500"
                    >
                      Create email campaign
                    </Link>
                  )}
                  {selectedJob.leads.length > 0 && (
                    <Dropdown
                      label="Actions"
                      align="right"
                      className="h-7 border-brand-500 text-brand-600 hover:bg-brand-50 dark:text-brand-400 dark:hover:bg-brand-900/40"
                      items={[
                        { label: "Export CSV", href: `/api/jobs/${selectedJob.id}/export.csv`, download: true },
                        { label: "Emails only", href: `/api/jobs/${selectedJob.id}/export.csv?emailsOnly=1`, download: true },
                        {
                          label: validateBusy ? "Validating…" : "Validate all",
                          busy: validateBusy,
                          onSelect: () => void validateAll(),
                          disabled: validateBusy || !selectedJob.leads.some((l) => !l.validationStatus || l.validationStatus === "unchecked"),
                        },
                      ]}
                    />
                  )}
                  {/* Task 26, Piece 7a — LIVE validation summary derived from THIS
                      job's own leads (never stale across job switches), with a
                      running unchecked count. key-ing on the numbers remounts the
                      line only when they change, replaying the fadeInUp crossfade
                      (7g) instead of snapping. Rendered only once something has been
                      validated, so a fresh job isn't cluttered with zeros. */}
                  {(() => {
                    const vValid = selectedJob.leads.filter((l) => l.validationStatus === "valid").length;
                    const vInvalid = selectedJob.leads.filter((l) => l.validationStatus === "invalid").length;
                    const untested = selectedJob.leads.filter((l) => !l.validationStatus || l.validationStatus === "unchecked");
                    // Bug fix (2026-09-12): "unchecked" was one bucket for two very
                    // different things — a lead with an email genuinely still
                    // awaiting validation, vs. a lead with NO email at all, which
                    // /api/jobs/[id]/validate deliberately skips forever (nothing to
                    // check). Lumping them together read as "Validate all left most
                    // of my leads unchecked" when really most of them just have no
                    // email address to validate. Split the label so that's clear.
                    const vNoEmail = untested.filter((l) => !l.email || l.email.trim().length === 0).length;
                    const vPending = untested.length - vNoEmail;
                    if (vValid + vInvalid === 0) return null;
                    return (
                      <>
                        <span
                          key={`${vValid}-${vInvalid}-${vPending}-${vNoEmail}`}
                          className="animate-[fadeInUp_0.15s_ease-out] text-xs text-fg-muted"
                        >
                          {vValid} valid · {vInvalid} invalid
                          {vPending > 0 ? ` · ${vPending} pending validation` : ""}
                          {vNoEmail > 0 ? ` · ${vNoEmail} no email (can't be validated)` : ""}
                        </span>
                        {/* Task 26, Piece 7c — "Delete N invalid", only while there
                            are invalid leads to remove. */}
                        {vInvalid > 0 && (
                          <button
                            type="button"
                            onClick={() => void deleteInvalidLeads()}
                            className="rounded-lg border border-red-500 px-3 py-1 text-xs font-medium text-red-500 hover:bg-red-50"
                          >
                            Delete {vInvalid} invalid
                          </button>
                        )}
                      </>
                    );
                  })()}
                  {validateError && (
                    <span className="mt-2 text-xs text-red-600 dark:text-red-400">{validateError}</span>
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
              ) : (
                <>
                {(() => {
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
                // "Emails only" is a promise about the RESULT SET, not just which
                // columns are visible — a lead with no email is useless in this
                // mode (every other field is already hidden) and previously still
                // rendered as a row of bare "—" placeholders. Filter it out of
                // what's actually displayed/scrolled/merge-selectable rather than
                // just hiding its columns.
                const visibleLeads = mode === "emailsOnly"
                  ? selectedJob.leads.filter((lead) => lead.email)
                  : selectedJob.leads;
                // Task 26, Piece 7b — select-all header checkbox. "All" means all the
                // leads currently RENDERED (respecting Piece 1's visibleLeads filter,
                // so Emails-only mode only selects the emails actually shown, never
                // leads hidden by the filter). Indeterminate when only some visible
                // ones are checked.
                return (
                <div
                  ref={leadsScrollRef}
                  onScroll={handleLeadsScroll}
                  className="max-h-[50vh] overflow-x-auto overflow-y-auto"
                >
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-fg-muted">
                        {showBusiness && <th className="pb-2 pr-3 font-medium">Business</th>}
                        {showContact && <th className="pb-2 pr-3 font-medium">Name</th>}
                        <th className="pb-2 pr-3 font-medium">Email</th>
                        {showPhone && <th className="pb-2 pr-3 font-medium">Phone</th>}
                        {showWebsite && <th className="pb-2 font-medium">Website</th>}
                        {/* Task 26, Piece 3 — validation status pill. */}
                        <th className="pb-2 pl-2 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleLeads.map((lead) => (
                        <tr
                          key={lead.id}
                          className="animate-[fadeInUp_0.15s_ease-out] border-b border-border last:border-0"
                        >
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
                          {/* Task 26, Piece 3 — validation status pill (green Valid /
                              red Invalid / grey — for unchecked). */}
                          <td className="py-2 pl-2">
                            {lead.validationStatus === "valid" ? (
                              <Badge tone="success">Valid</Badge>
                            ) : lead.validationStatus === "invalid" ? (
                              <Badge tone="danger" title={lead.validationError || undefined}>Invalid</Badge>
                            ) : (
                              <span className="text-fg-muted">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                );
              })()}
                </>
              )}
              {/* Task 26, Piece 1 — live activity feed, relocated UNDER the leads
                  table (it used to sit in the detail-pane header above). key-ing on
                  currentStep remounts the line only when the text actually changes,
                  which replays the fadeInUp crossfade instead of snapping. */}
              {selectedJob.status === "running" && (
                <>
                  <p
                    key={selectedJob.currentStep ?? "starting"}
                    className="animate-[fadeInUp_0.15s_ease-out] mt-1 truncate text-xs text-fg-muted/80"
                    title={selectedJob.currentStep ?? undefined}
                  >
                    Currently: {selectedJob.currentStep?.trim() ? selectedJob.currentStep : "Starting…"}
                  </p>
                  {isStalled(selectedJob) && (
                    <p className="animate-[fadeInUp_0.15s_ease-out] mt-1 text-xs font-medium text-amber-600 dark:text-amber-400">
                      This may be stalled — no progress in over 5 minutes.
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Task 26, Piece 3 — import-leads dialog. A dropzone (click or drag & drop)
          that posts the file to /api/leads/upload and then jumps to the new job. */}
      {uploadOpen && typeof document !== "undefined" && createPortal(
        (() => {
          const accent = dragging
            ? "border-brand-500 bg-brand-50 dark:bg-brand-900/30"
            : "border-border hover:bg-black/5 dark:hover:bg-white/5";
          return (
            <div
              className="fixed inset-0 z-50 overflow-y-auto bg-black/40 p-4 dark:bg-black/70"
              onClick={() => setUploadOpen(false)}
              role="dialog"
              aria-modal="true"
              aria-label="Import leads"
            >
              {/* Task 26, Piece 7g — entrance transition (CSS-only fadeInUp), same as the merge
                  dialog, so the upload dialog doesn't snap in either. */}
              <div
                className="animate-[fadeInUp_0.15s_ease-out] mx-auto my-8 w-full max-w-lg rounded-xl border border-border bg-card p-6 dark:bg-zinc-950"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-start justify-between">
                  <h2 className="text-lg font-semibold">Import leads</h2>
                  <button
                    type="button"
                    onClick={() => setUploadOpen(false)}
                    aria-label="Close"
                    className="rounded p-1 text-fg-muted hover:bg-black/5 hover:text-fg-muted dark:hover:bg-white/5"
                  >
                    ×
                  </button>
                </div>
                <p className="mt-1 text-xs text-fg-muted">
                  Upload a .csv, .tsv, .txt, .json or .xls/.xlsx file. Rows with no
                  recognizable email are dropped; everything else is imported as-is
                  (run “Validate all” afterwards to check deliverability).
                </p>

                <label
                  onDragOver={(e) => e.preventDefault()}
                  onDragEnter={(e) => { e.preventDefault(); dragDepthRef.current += 1; setDragging(true); }}
                  onDragLeave={() => {
                    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
                    if (dragDepthRef.current === 0) setDragging(false);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    dragDepthRef.current = 0;
                    setDragging(false);
                    const f = e.dataTransfer.files?.[0];
                    if (f) void performUpload(f);
                  }}
                  className={`mt-4 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-center text-sm transition-colors ${accent}`}
                >
                  <input
                    type="file"
                    className="hidden"
                    accept=".txt,.csv,.tsv,.json,.xls,.xlsx"
                    disabled={uploadBusy}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void performUpload(f);
                      // Allow picking the same file again for a second attempt.
                      e.target.value = "";
                    }}
                  />
                  <span className="font-medium">
                    {uploadBusy ? "Uploading…" : "Click to choose a file, or drag & drop here"}
                  </span>
                  <span className="text-xs text-fg-muted">Max 20MB · .csv .tsv .txt .json .xls .xlsx</span>
                </label>

                {uploadDone && (
                  <div className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-300">
                    Imported {uploadDone.imported} lead{uploadDone.imported === 1 ? "" : "s"} from{" "}
                    <span className="font-medium">{uploadDone.fileName}</span>. It shows up as a new
                    “done” job in the list — open it to validate.
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setUploadOpen(false);
                          if (uploadDone.jobId) void fetchJobDetail(uploadDone.jobId);
                        }}
                        className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
                      >
                        View imported leads
                      </button>
                      <button
                        type="button"
                        onClick={() => setUploadDone(null)}
                        className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-fg hover:bg-black/5 dark:hover:bg-white/5"
                      >
                        Import another
                      </button>
                    </div>
                  </div>
                )}

                {uploadError && (
                  <p className="mt-3 text-sm text-red-600 dark:text-red-400">{uploadError}</p>
                )}

                <div className="mt-4 flex justify-end">
                  <button
                    type="button"
                    onClick={() => setUploadOpen(false)}
                    className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-fg hover:bg-black/5 dark:hover:bg-white/5"
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          );
        })(),
        document.body,
      )}
    </div>
  );
}

// Dispatcher: the hosted web app shows the Postgres/worker job UI above
// (WebExtractPage); the local Extractor EXE shows the self-contained
// local-engine UI (LocalExtractPage). Which mode we're in is decided by pinging
// /api/exe/extract — it 200s only inside the local runtime (gated by
// isLocalExeRuntime), 404s on the hosted web app.
export default function ExtractPage() {
  const [mode, setMode] = useState<"loading" | "web" | "local">("loading");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/exe/extract", { method: "GET" })
      .then((r) => {
        if (!cancelled) setMode(r.ok ? "local" : "web");
      })
      .catch(() => {
        if (!cancelled) setMode("web");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (mode === "local") return <LocalExtractPage />;
  if (mode === "web") return <WebExtractPage />;
  return (
    <div className="flex min-h-[40vh] items-center justify-center py-16">
      <Spinner className="text-brand-600" />
    </div>
  );
}