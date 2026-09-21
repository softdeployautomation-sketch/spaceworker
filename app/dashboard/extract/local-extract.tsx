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

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Badge, Button } from "@/components/ui";
import { Dropdown } from "@/components/dropdown";
import { useConfirm } from "@/components/confirm-provider";
import { timeAgo } from "@/lib/format-date";
import { encodeCsvRow } from "@/lib/csv";
import type { Lead } from "@/local-engine/src/lead";

interface ExtractEvent {
  type: "step" | "lead" | "done";
  message?: string;
  lead?: Lead;
  total?: number;
  leadFile?: string | null;
  stoppedReason?: string | null;
}

// Results-column modes, mirroring the web's resultMode selector (and the same
// "display-only, defaults to names+emails" semantics — nothing is dropped at
// extraction time).
type ResultMode = "namesEmails" | "full" | "emailsOnly";

type ValidationStatus = "unchecked" | "valid" | "invalid";

// The EXE's in-memory lead extends the local-engine Lead with per-lead email
// validation state — the web sibling of the SearchJob Lead row's
// validationStatus/validationError/validatedAt. Search-engine leads carry no
// status until "Validate all" (or an import, which starts unchecked).
interface ExeLead extends Lead {
  validationStatus?: ValidationStatus;
  validationError?: string | null;
  validatedAt?: string | null; // ISO
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
  // Webmail platform targeting — mirrors the web dashboard's Extract page
  // (worker/filters/webmail_platforms.py is the shared source of truth).
  webmailPlatforms: string[];
  verifyWebmail: boolean;
  leads: ExeLead[];
  steps: string[];
  total: number;
  leadFile: string | null;
  status: "running" | "done" | "failed";
  stoppedReason: string | null;
  createdAt: string; // ISO — for timeAgo() captions
  // Per-run display preference for the leads table (web stores this on the job's
  // params); set from the form at run creation, editable from the detail pane.
  resultMode: ResultMode;
  // How this run came to be — search / import / merge — for labels and clarity.
  source?: "search" | "import" | "merge" | "advanced-search";
  // Advanced Search-only fields (source === "advanced-search") — kept
  // separate from the Lead Search fields above rather than repurposing
  // them, since the concepts genuinely differ (a query LIST here, not one
  // cross-multiplied Find/Location pair).
  advQueries?: string;
  advDomains?: string;
  advPlatforms?: string[];
  advRequireEmail?: boolean;
}

// Self-hosted webmail platforms this app can target — mirrors the web
// dashboard's Extract page; worker/filters/webmail_platforms.py (server) and
// local-engine/src/filters/webmail-platforms.ts (this EXE) are the shared
// source of truth for the codes and their actual detection fingerprints.
// Advanced Search's fuller platform list (self-hosted + hosted providers +
// "other-hosted") — matches app/dashboard/extract/page.tsx's
// ADVANCED_SEARCH_PLATFORM_OPTIONS exactly, same codes worker/filters/
// webmail_platforms.py and local-engine/src/filters/webmail-platforms.ts
// (this EXE's copy) already detect.
const ADVANCED_SEARCH_PLATFORM_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "google-workspace", label: "Google Workspace" },
  { value: "microsoft-365", label: "Microsoft 365" },
  { value: "zoho-mail", label: "Zoho Mail" },
  { value: "icloud-mail", label: "Apple iCloud Mail" },
  { value: "proton-mail", label: "Proton Mail" },
  { value: "other-hosted", label: "Other (show unrecognized providers)" },
  { value: "roundcube", label: "RoundCube" },
  { value: "squirrelmail", label: "SquirrelMail" },
  { value: "rainloop", label: "RainLoop" },
  { value: "zimbra", label: "Zimbra" },
  { value: "open-xchange", label: "Open-Xchange" },
  { value: "cpanel", label: "cPanel Webmail" },
];

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
function summarizeRun(run: Pick<RunRecord, "findTerms" | "locationTerms" | "source" | "advQueries" | "advDomains">): string {
  if (run.source === "advanced-search") {
    const q = run.advQueries?.trim();
    const d = run.advDomains?.trim();
    if (q) return q;
    if (d) return `Domain filter: ${d.split(/[,\n;|]+/).filter(Boolean).length} domain(s)`;
    return "Advanced Search";
  }
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
    case "stopped": return { label: "stopped", cls: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300" };
    default: return { label: "done", cls: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200" };
  }
}

/** A lead still awaiting validation: no status at all (fresh from extraction or
 *  import) or explicitly marked "unchecked". Leads with no email can never be
 *  validated, so they're never "pending" — see isUncheckedAndEmailable. */
function isUnchecked(l: ExeLead): boolean {
  return !l.validationStatus || l.validationStatus === "unchecked";
}

/** A lead that actually CAN be validated — has an email and isn't checked yet.
 *  Mirrors the web's own split of "pending validation" vs "no email (can't be
 *  validated)" in its live validation summary. */
function isPendingValidation(l: ExeLead): boolean {
  return !!l.email && l.email.trim().length > 0 && isUnchecked(l);
}

// Task 54 — EXE sibling of the web export route's leadDomain(): normalizes a
// lead's email or website into a comparable domain for the export filter.
function leadDomainExe(email?: string | null, website?: string | null): string {
  const emailDomain = (email ?? "").trim().split("@").pop()?.trim() ?? "";
  if (emailDomain) return emailDomain.replace(/^www\./, "").trim().toLowerCase();
  if (!website) return "";
  try {
    return new URL(website).hostname.replace(/^www\./, "").trim().toLowerCase();
  } catch {
    return "";
  }
}

// Task 54 — compact chip multi-select of the distinct domains in a run's leads.
// Pure presentational: selection lives in the page's filterExportDomains state,
// which exportRun() reads to narrow the generated CSV (never mutates leads).
function DomainsFilterChipsExe({
  leads,
  selected,
  onChange,
}: {
  leads: ExeLead[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const domains = useMemo(() => {
    const set = new Set<string>();
    for (const l of leads) {
      const d = leadDomainExe(l.email, l.website);
      if (d) set.add(d);
    }
    return [...set].sort();
  }, [leads]);

  if (!domains.length) return null;

  const toggle = (d: string) => {
    onChange(
      selected.includes(d) ? selected.filter((x) => x !== d) : [...selected, d],
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 py-0.5">
      <span className="text-[10px] uppercase tracking-wide text-fg-muted">Filter:</span>
      {selected.length > 0 && (
        <button
          type="button"
          onClick={() => onChange([])}
          className="rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-fg-muted hover:text-fg"
        >
          Clear
        </button>
      )}
      {domains.map((d) => {
        const on = selected.includes(d);
        return (
          <button
            key={d}
            type="button"
            onClick={() => toggle(d)}
            className={`rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors ${
              on
                ? "border-brand-500 bg-brand-500 text-white"
                : "border-border text-fg-muted hover:text-fg"
            }`}
          >
            {d}
          </button>
        );
      })}
    </div>
  );
}

/** True when running inside the Tauri EXE shell (WebView2), detected the standard
 *  way (the runtime bridge object that the plugins speak through). Absent in a
 *  normal browser tab, so the hosted web product always takes the browser path. */
function isTauri(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

/** Browser (web product) download path — Blob → object URL → synthetic click. */
function browserDownload(filename: string, contents: string): void {
  if (typeof document === "undefined") return;
  const blob = new Blob([contents], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Save a client-generated CSV of a run's leads (no server round-trip — the leads
 *  are already in memory; mirrors /api/jobs/[id]/export.csv). Inside the Tauri EXE
 *  the browser `<a download>` pattern silently no-ops in WebView2 (Task 57 Bug 2),
 *  so branch to the native Save-As dialog + fs write there; the browser path is
 *  kept for the hosted web product. The dialog/full plugin modules are imported
 *  lazily so they're only ever evaluated inside the EXE, never in the web bundle. */
async function downloadCsv(filename: string, rows: string[]): Promise<void> {
  const contents = rows.join("");
  if (isTauri()) {
    try {
      const [{ save }, { writeTextFile }] = await Promise.all([
        import("@tauri-apps/plugin-dialog"),
        import("@tauri-apps/plugin-fs"),
      ]);
      const path = await save({
        defaultPath: filename,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (path) await writeTextFile(path, contents);
    } catch {
      // Native save failed for any reason — fall back to the browser download so
      // collected leads are never trapped by a broken native path.
      browserDownload(filename, contents);
    }
    return;
  }
  browserDownload(filename, contents);
}

/** Owner-requested 2026-09-21: a one-click export that writes straight to the
 *  user's Documents folder — no Save-As dialog, no dependency on the Actions
 *  dropdown menu (whose native WebView2 rendering is separately under
 *  investigation for a blank-menu bug found live the same day). Tauri-only;
 *  falls back to the same dialog-based downloadCsv() everywhere else (the
 *  hosted web product, or if BaseDirectory.Document somehow isn't writable —
 *  same fail-safe reasoning downloadCsv() already uses for its own fallback).
 *  Requires capabilities/default.json to scope fs:allow-write-text-file to
 *  $DOCUMENT/* — a bare grant has no accessible directory by default in
 *  Tauri v2's capability model. */
async function quickExportToDocuments(filename: string, rows: string[]): Promise<"saved" | "fallback"> {
  const contents = rows.join("");
  if (!isTauri()) {
    browserDownload(filename, contents);
    return "fallback";
  }
  try {
    const { writeTextFile, BaseDirectory } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(filename, contents, { baseDir: BaseDirectory.Document });
    return "saved";
  } catch {
    // Couldn't write straight to Documents (permission/capability issue on this
    // machine) — fall back to the dialog path so leads are never trapped.
    await downloadCsv(filename, rows);
    return "fallback";
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
  // Webmail platform targeting — mirrors the web dashboard's Extract page.
  const [webmailPlatforms, setWebmailPlatforms] = useState<string[]>([]);
  const [verifyWebmail, setVerifyWebmail] = useState(false);

  // Owner-requested 2026-09-20: "we need all in the exe, build an
  // equivalent in the exe that would run locally, no difference since
  // they still can make http calls." Advanced Search as a second mode,
  // same real local-engine crawl (DDG search, MX lookup, page crawl) the
  // web's background job uses, streamed over SSE from
  // /api/exe/advanced-search/run exactly like Lead Search already streams
  // from /api/exe/extract — same runs list, same live activity, just a
  // different engine underneath.
  const [mode, setMode] = useState<"lead" | "advanced-search">("lead");
  const [advQueries, setAdvQueries] = useState("");
  const [advDomains, setAdvDomains] = useState("");
  const [advPlatforms, setAdvPlatforms] = useState<string[]>(
    ADVANCED_SEARCH_PLATFORM_OPTIONS.map((p) => p.value),
  );
  const [advMinLeads, setAdvMinLeads] = useState(0);
  const [advMaxDurationMinutes, setAdvMaxDurationMinutes] = useState(30);
  const [advResultMode, setAdvResultMode] = useState<ResultMode>("namesEmails");
  // Bug fix (2026-09-20, same as web): default true — "we dont want empty
  // spaces. if its empty then it should be deleted."
  const [advRequireEmail, setAdvRequireEmail] = useState(true);

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const cancelRef = useRef<boolean>(false);
  const readerRef = useRef<{ cancel(): Promise<unknown> } | null>(null);
  // Track WHICH run is currently streaming (only one streams at a time, so a
  // single id ref is correct). stopSearch() reads this to know which run's
  // status to flip to "stopped" — without it the manual-stop path could never
  // patch the right run (Task 57: Stop left the run pill stuck on "running").
  const activeRunIdRef = useRef<number | null>(null);
  const nextRunId = useRef(1);
  const leadsScrollRef = useRef<HTMLDivElement>(null);

  // Task 27 feature-parity state — result-mode, validation, import, merge, and
  // per-lead selection. All local to this component's in-memory model (no Postgres).
  const [resultFormMode, setResultFormMode] = useState<ResultMode>("namesEmails");
  const [validateBusy, setValidateBusy] = useState(false);
  const [validateError, setValidateError] = useState<string | null>(null);
  const [selectedLeadIndexes, setSelectedLeadIndexes] = useState<Set<number>>(new Set());
  // Task 54 — export-time-only domain filter for the EXE's own CSV export
  // (the local sibling of the web's /api/jobs/[id]/export.csv?domains=). Only
  // narrows the downloaded file; the run's leads are never mutated.
  const [filterExportDomains, setFilterExportDomains] = useState<string[]>([]);
  // Import modal state (mirrors the web's upload dialog).
  const [importOpen, setImportOpen] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState("");
  const [importDone, setImportDone] = useState<{ imported: number; fileName: string } | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const dragDepthRef = useRef(0);
  // Session/run merge — run ids checked in the sidebar history for merging.
  const [mergeSelectedIds, setMergeSelectedIds] = useState<Set<number>>(new Set());
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeError, setMergeError] = useState("");

  const confirm = useConfirm();

  // Per-lead selection is scoped to the currently-selected run; every place that
// switches the selected run clears it (see the row onClick and the run creators) so
// stale indexes can never point at another run's rows.

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

  const selectedLeads = useMemo(() => {
    if (!selectedRun) return [] as ExeLead[];
    return selectedRun.leads.filter((_, i) => selectedLeadIndexes.has(i));
  }, [selectedRun, selectedLeadIndexes]);

  // Live validation summary derived from THIS run's own leads — never stale across
  // run switches (the web's Piece 7a). Splits untested into "pending (has an email,
  // can be validated)" vs "no email (can't)" so the wording is honest.
  const validationSummary = useMemo(() => {
    if (!selectedRun) return null;
    const valid = selectedRun.leads.filter((l) => l.validationStatus === "valid").length;
    const invalid = selectedRun.leads.filter((l) => l.validationStatus === "invalid").length;
    const untested = selectedRun.leads.filter((l) => isUnchecked(l));
    const noEmail = untested.filter((l) => !l.email || l.email.trim().length === 0).length;
    const pending = untested.length - noEmail;
    return { valid, invalid, noEmail, pending };
  }, [selectedRun]);

  // Indexes (into selectedRun.leads) of rows that are actually shown under the
  // current result-mode (emailsOnly hides leads without an email, matching the
  // column filter — same "visible leads" concept the web applies). Select-all
  // operates only on these, never on hidden rows.
  const visibleIndexes = useMemo(() => {
    if (!selectedRun) return [] as number[];
    const mode = selectedRun.resultMode;
    return selectedRun.leads
      .map((l, i) => ((mode === "emailsOnly" && !l.email) ? -1 : i))
      .filter((i) => i >= 0);
  }, [selectedRun]);

  const allVisibleSelected = visibleIndexes.length > 0 && visibleIndexes.every((i) => selectedLeadIndexes.has(i));
  const someVisibleSelected = visibleIndexes.some((i) => selectedLeadIndexes.has(i));

  function toggleSelectAllVisible() {
    const next = new Set(selectedLeadIndexes);
    if (allVisibleSelected) visibleIndexes.forEach((i) => next.delete(i));
    else visibleIndexes.forEach((i) => next.add(i));
    setSelectedLeadIndexes(next);
  }

  function toggleLeadSelected(index: number) {
    const next = new Set(selectedLeadIndexes);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    setSelectedLeadIndexes(next);
  }

  function setRunResultMode(id: number, mode: ResultMode) {
    patchRun(id, { resultMode: mode });
  }

  // Keep the select-all checkbox's indeterminate state in sync with "some but not
  // all" — a ref callback alone only fires on mount, so a bare callback would never
  // update once the selection changes.
  const selectAllInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (selectAllInputRef.current) {
      selectAllInputRef.current.indeterminate = someVisibleSelected && !allVisibleSelected;
    }
  }, [someVisibleSelected, allVisibleSelected]);

  // ── Real local persistence (2026-09-21) ─────────────────────────────────
  // Replaces the old "deliberately in-memory, lost on restart" design — see
  // lib/extract-runs-state.ts. `hydrated` gates the persist effect below so
  // the empty initial `runs=[]` can never race ahead of the GET and wipe out
  // a real saved history before it's loaded.
  const hydratedRef = useRef(false);
  useEffect(() => {
    let active = true;
    fetch("/api/exe/extract/runs")
      .then((r) => r.json())
      .then((data) => {
        if (!active) return;
        const loaded = Array.isArray(data.runs) ? (data.runs as RunRecord[]) : [];
        if (loaded.length > 0) {
          setRuns(loaded);
          setSelectedRunId(loaded[loaded.length - 1].id);
        }
        if (typeof data.nextRunId === "number" && data.nextRunId > nextRunId.current) {
          nextRunId.current = data.nextRunId;
        }
      })
      .catch(() => {
        // No persisted history (first run, or read failure) — start empty, as before.
      })
      .finally(() => {
        if (active) hydratedRef.current = true;
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!hydratedRef.current) return; // don't persist until the initial load has resolved
    const t = setTimeout(() => {
      void fetch("/api/exe/extract/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runs, nextRunId: nextRunId.current }),
      }).catch(() => {
        // Best-effort — a save failure must never surface as an error to the user.
      });
    }, 1500); // debounced: an active run streams many leads/steps in quick succession
    return () => clearTimeout(t);
  }, [runs]);

  // ── Export (client-side sibling of the web's /api/jobs/[id]/export.csv) ────────
  // The run's leads are already in memory, so no round-trip is needed — we build an
  // RFC-4180 CSV with the same encoder lib/csv.ts the web route uses. The columns
  // follow the run's results-column mode (#1) so "what you see is what you get".
  // Task 54's domain filter + the resultMode column selection, shared by both
  // downloadCsv() (Actions dropdown, Save-As dialog) and quickExportToDocuments()
  // (the standalone button, straight to Documents) — one source of truth for
  // what a run's CSV actually contains.
  function buildCsvRows(run: RunRecord, forceEmailsOnly: boolean): string[] {
    const leads = filterExportDomains.length
      ? run.leads.filter((l) => {
          const domain = leadDomainExe(l.email, l.website);
          return (
            !!domain &&
            filterExportDomains.some((d) => domain === d || domain.endsWith(`.${d}`))
          );
        })
      : run.leads;
    const rows: string[] = [];
    if (forceEmailsOnly || run.resultMode === "emailsOnly") {
      rows.push(encodeCsvRow(["email"]));
      const seen = new Set<string>();
      for (const l of leads) {
        const email = (l.email ?? "").trim();
        if (!email || seen.has(email.toLowerCase())) continue;
        seen.add(email.toLowerCase());
        rows.push(encodeCsvRow([email]));
      }
    } else if (run.resultMode === "namesEmails") {
      rows.push(encodeCsvRow(["contactName", "email"]));
      for (const l of leads) rows.push(encodeCsvRow([l.contactName, l.email]));
    } else {
      rows.push(encodeCsvRow(["businessName", "contactName", "email", "phone", "website", "sourceUrl", "snippet"]));
      for (const l of leads) {
        rows.push(
          encodeCsvRow([l.businessName, l.contactName, l.email, l.phone, l.website, l.sourceUrl, l.snippet]),
        );
      }
    }
    return rows;
  }

  function csvFilename(run: RunRecord, forceEmailsOnly: boolean): string {
    return `spaceworker-leads-${run.id}${forceEmailsOnly || run.resultMode === "emailsOnly" ? "-emails" : ""}.csv`;
  }

  function exportRun(run: RunRecord, forceEmailsOnly: boolean) {
    void downloadCsv(csvFilename(run, forceEmailsOnly), buildCsvRows(run, forceEmailsOnly));
  }

  const [quickExportState, setQuickExportState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  async function quickExportRun(run: RunRecord) {
    setQuickExportState("saving");
    try {
      const outcome = await quickExportToDocuments(csvFilename(run, false), buildCsvRows(run, false));
      setQuickExportState(outcome === "saved" ? "saved" : "idle");
    } catch {
      setQuickExportState("error");
    } finally {
      setTimeout(() => setQuickExportState("idle"), 2500);
    }
  }

  // ── Local validation (web POST /api/jobs/[id]/validate → /api/exe/extract/validate) ──
  // Same validator (lib/email-validator.ts) the web route calls; only the write step
  // differs — instead of persisting, we fold the results into the in-memory leads.
  async function runValidation(targetRun: RunRecord) {
    const testLeads = targetRun.leads.filter((l) => isPendingValidation(l));
    if (testLeads.length === 0) return;
    setValidateBusy(true);
    setValidateError(null);
    try {
      const res = await fetch("/api/exe/extract/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emails: testLeads.map((l) => l.email as string) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setValidateError(typeof data.error === "string" ? `Validation failed: ${data.error}` : "Validation failed.");
        return;
      }
      const byEmail = new Map<string, { email: string; isValid: boolean; reason?: string }>();
      for (const r of data.results ?? []) byEmail.set(String(r.email).toLowerCase(), r);
      const now = new Date().toISOString();
      patchRun(targetRun.id, {
        leads: targetRun.leads.map((l) => {
          if (!isPendingValidation(l) || !l.email) return l;
          const r = byEmail.get(l.email.toLowerCase());
          if (!r) return l;
          return {
            ...l,
            validationStatus: r.isValid ? "valid" : "invalid",
            validationError: r.isValid ? null : (typeof r.reason === "string" ? r.reason : "no_mx_records"),
            validatedAt: now,
          };
        }),
      });
      setSelectedLeadIndexes(new Set());
    } catch {
      setValidateError("Network error while validating.");
    } finally {
      setValidateBusy(false);
    }
  }

  async function validateSelectedRun() {
    if (selectedRun) await runValidation(selectedRun);
  }

  // ── Per-lead actions: remove a single bad lead, a selected batch, or all invalid ──
  function removeLeadsAt(run: RunRecord, indexes: number[]) {
    if (indexes.length === 0) return;
    const remove = new Set(indexes);
    patchRun(run.id, { leads: run.leads.filter((_, i) => !remove.has(i)) });
    setSelectedLeadIndexes(new Set());
  }

  async function removeSingleLead(run: RunRecord, index: number) {
    const lead = run.leads[index];
    if (!lead) return;
    const label = lead.email || lead.businessName || lead.contactName || "This lead";
    if (!(await confirm({ title: "Remove this lead?", description: `${label} will be removed from this run's list.`, confirmLabel: "Remove" }))) return;
    removeLeadsAt(run, [index]);
  }

  async function removeSelectedLeads() {
    if (!selectedRun || selectedLeads.length === 0) return;
    if (!(await confirm({
      title: `Remove ${selectedLeads.length} lead${selectedLeads.length === 1 ? "" : "s"}?`,
      description: "They'll be removed from this run's list. This can't be undone.",
      confirmLabel: "Remove",
    }))) return;
    const indexes = selectedRun.leads.map((_, i) => i).filter((i) => selectedLeadIndexes.has(i));
    removeLeadsAt(selectedRun, indexes);
  }

  async function deleteInvalidLeads() {
    if (!selectedRun) return;
    const invalidIndexes = selectedRun.leads
      .map((l, i) => (l.validationStatus === "invalid" ? i : -1))
      .filter((i) => i >= 0);
    if (invalidIndexes.length === 0) return;
    if (!(await confirm({
      title: `Delete ${invalidIndexes.length} invalid lead${invalidIndexes.length === 1 ? "" : "s"}?`,
      description: "Valid and unchecked leads in this run are kept.",
      confirmLabel: "Delete",
    }))) return;
    removeLeadsAt(selectedRun, invalidIndexes);
  }

  // ── Session merge (web POST /api/jobs/merge, client-side sibling) ──────────────
  // Multi-select runs in the sidebar history; this combines their leads (deduped by
  // email, preferring an already-validated copy — the web route's exact ranking)
  // into ONE new run entry. Unlike the web (which deletes the sources inside a
  // transaction), the EXE keeps the source runs: they're cheap in-memory records and
  // there's no DB safety net on the customer's machine to make deletion recoverable.
  function toggleRunSelected(id: number) {
    const next = new Set(mergeSelectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setMergeSelectedIds(next);
  }

  const mergeRank = (s: ValidationStatus | undefined): number => (s === "valid" ? 2 : s === "invalid" ? 0 : 1);

  async function confirmMergeRuns() {
    const ids = [...mergeSelectedIds];
    const targets = runs.filter((r) => ids.includes(r.id) && r.status !== "running");
    if (targets.length < 2) return;
    setMergeBusy(true);
    setMergeError("");
    try {
      const byEmail = new Map<string, ExeLead>();
      const noEmail: ExeLead[] = [];
      for (const r of targets) {
        for (const l of r.leads) {
          const email = l.email?.trim();
          if (!email) {
            noEmail.push(l);
            continue;
          }
          const key = email.toLowerCase();
          const existing = byEmail.get(key);
          if (!existing || mergeRank(l.validationStatus) > mergeRank(existing.validationStatus)) byEmail.set(key, l);
        }
      }
      const deduped = [...byEmail.values(), ...noEmail];
      const steps = [
        `Merged ${targets.length} sessions into one run (${deduped.length} leads after email dedup).`,
      ];
      const mergedId = nextRunId.current++;
      const mergedRun: RunRecord = {
        id: mergedId,
        findTerms: targets.map((r) => r.findTerms).filter(Boolean).join(", "),
        locationTerms: targets.map((r) => r.locationTerms).filter(Boolean).join(", "),
        pdfOnly: false, scope: 0, resultsPerQuery: 0, minLeads: 0, maxTotalLeads: 0,
        maxDurationMinutes: 0, emailFilter: "", webmailPlatforms: [], verifyWebmail: false,
        leads: deduped,
        steps,
        total: deduped.length,
        leadFile: null,
        status: "done", stoppedReason: null,
        createdAt: new Date().toISOString(),
        resultMode: targets[0]?.resultMode ?? resultFormMode,
        source: "merge",
      };
      setRuns((prev) => [mergedRun, ...prev]);
      setSelectedRunId(mergedId);
      setMergeSelectedIds(new Set());
      setSelectedLeadIndexes(new Set());
    } catch {
      setMergeError("Error while merging sessions.");
    } finally {
      setMergeBusy(false);
    }
  }

  // ── Lead import (web POST /api/leads/upload → /api/exe/extract/import) ────────
  // Parses the file on the local server (lead-file-parser.ts takes a Node Buffer for
  // .xlsx) and drops the parsed leads into a NEW local run — ready for "Validate all"
  // rather than needing a real extraction pass.
  async function performImport(file: File | null) {
    if (!file || importBusy) return;
    if (file.size > 20 * 1024 * 1024) {
      setImportError("File is larger than the 20MB limit.");
      return;
    }
    setImportError("");
    setImportDone(null);
    setImportBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/exe/extract/import", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setImportError(typeof data.error === "string" ? data.error : "Import failed.");
        return;
      }
      const leads: ExeLead[] = (data.leads ?? []).map(
        (p: { email: string; businessName?: string; contactName?: string; phone?: string; website?: string }) => ({
          email: p.email,
          businessName: p.businessName ?? "",
          contactName: p.contactName ?? null,
          phone: p.phone ?? null,
          website: p.website ?? "",
          sourceUrl: "",
          snippet: "",
        }),
      );
      const runId = nextRunId.current++;
      const run: RunRecord = {
        id: runId,
        findTerms: `Import: ${file.name}`, locationTerms: "",
        pdfOnly: false, scope: 0, resultsPerQuery: 0, minLeads: 0, maxTotalLeads: 0,
        maxDurationMinutes: 0, emailFilter: "", webmailPlatforms: [], verifyWebmail: false,
        leads,
        steps: data.messages ?? [],
        total: leads.length, leadFile: null,
        status: "done", stoppedReason: null,
        createdAt: new Date().toISOString(),
        resultMode: resultFormMode,
        source: "import",
      };
      setRuns((prev) => [run, ...prev]);
      setSelectedRunId(runId);
      setSelectedLeadIndexes(new Set());
      setImportDone({ imported: leads.length, fileName: file.name });
    } catch {
      setImportError("Network error while importing.");
    } finally {
      setImportBusy(false);
    }
  }

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
      webmailPlatforms,
      verifyWebmail,
      leads: [],
      steps: [],
      total: 0,
      leadFile: null,
      status: "running",
      stoppedReason: null,
      createdAt: new Date().toISOString(),
      resultMode: resultFormMode,
      source: "search",
    };
    // Newest run on top, auto-selected — same feel as the web's fresh job appearing
    // at the top of the sidebar and being opened.
    setRuns((prev) => [run, ...prev]);
    setSelectedRunId(runId);
    setSelectedLeadIndexes(new Set());
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
          webmailPlatforms,
          verifyWebmail,
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
      activeRunIdRef.current = runId;
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
      activeRunIdRef.current = null;
    }
  }

  function stopSearch() {
    cancelRef.current = true;
    void readerRef.current?.cancel();
    // The stream loop exits the while() with a silent break on a manual stop
    // (deliberately NOT surfaced as "failed"), so flip the run to "stopped"
    // here or it stays stuck on "running" — Task 57. patchRun is a plain merge,
    // so the already-collected leads are preserved and remain exportable.
    if (activeRunIdRef.current !== null) {
      patchRun(activeRunIdRef.current, { status: "done", stoppedReason: "stopped" });
    }
  }

  // Owner-requested 2026-09-20: the EXE-local equivalent of the web's
  // background-job Advanced Search — same real crawl (DDG search, MX
  // lookup, page crawl via /api/exe/advanced-search/run), streamed the
  // exact same way startSearch() above streams from /api/exe/extract, so
  // it shows up in the SAME runs list with the SAME live activity.
  async function startAdvancedSearch() {
    const queries = advQueries.trim();
    const domains = advDomains.trim();
    if (!queries && !domains) {
      setError("Enter at least one search query or domain");
      return;
    }

    cancelRef.current = false;
    setError(undefined);

    const runId = nextRunId.current++;
    const run: RunRecord = {
      id: runId,
      findTerms: "",
      locationTerms: "",
      pdfOnly: false,
      scope: 0,
      resultsPerQuery: 0,
      minLeads: advMinLeads,
      maxTotalLeads: 0,
      maxDurationMinutes: advMaxDurationMinutes,
      emailFilter: "",
      webmailPlatforms: [],
      verifyWebmail: false,
      leads: [],
      steps: [],
      total: 0,
      leadFile: null,
      status: "running",
      stoppedReason: null,
      createdAt: new Date().toISOString(),
      resultMode: advResultMode,
      source: "advanced-search",
      advQueries: queries,
      advDomains: domains,
      advPlatforms: advPlatforms,
      advRequireEmail: advRequireEmail,
    };
    setRuns((prev) => [run, ...prev]);
    setSelectedRunId(runId);
    setSelectedLeadIndexes(new Set());
    setRunning(true);

    try {
      const res = await fetch("/api/exe/advanced-search/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          queries,
          targetDomains: domains,
          platformCodes: advPlatforms,
          minLeads: advMinLeads,
          maxDurationMinutes: advMaxDurationMinutes,
          requireEmail: advRequireEmail,
        }),
      });

      if (res.status === 404) {
        patchRun(runId, { status: "failed" });
        setError("Advanced Search is only available in the local Extractor EXE.");
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
      activeRunIdRef.current = runId;
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
      activeRunIdRef.current = null;
    }
  }

  // Load a past run's search back into the form (the web's Load action) so it can
  // be edited and resubmitted as a NEW run — the original run stays untouched.
  function loadRunIntoForm(run: RunRecord) {
    if (run.source === "advanced-search") {
      setMode("advanced-search");
      setAdvQueries(run.advQueries ?? "");
      setAdvDomains(run.advDomains ?? "");
      setAdvPlatforms(run.advPlatforms ?? ADVANCED_SEARCH_PLATFORM_OPTIONS.map((p) => p.value));
      setAdvMinLeads(run.minLeads);
      setAdvMaxDurationMinutes(run.maxDurationMinutes);
      setAdvResultMode(run.resultMode);
      setAdvRequireEmail(run.advRequireEmail ?? true);
      setError(undefined);
      return;
    }
    setMode("lead");
    setFindTerms(run.findTerms);
    setLocationTerms(run.locationTerms);
    setPdfOnly(run.pdfOnly);
    setMaxChoice(run.scope);
    setResultsPerQuery(run.resultsPerQuery);
    setMinLeads(run.minLeads);
    setMaxTotalLeads(run.maxTotalLeads);
    setMaxDurationMinutes(run.maxDurationMinutes);
    setEmailFilter(run.emailFilter);
    setWebmailPlatforms(run.webmailPlatforms ?? []);
    setVerifyWebmail(run.verifyWebmail ?? false);
    setError(undefined);
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-hidden p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-fg">Extract leads</h1>
          <p className="mt-1 text-sm text-fg-muted">
            Find terms + location, then run the local engine. Results stream in as they&apos;re found.
          </p>
        </div>
        {/* The standalone "Advanced Search" link (added 2026-09-20) was
            removed the same day — reachable via the dock, same as every
            other page; no separate shortcut needed here either. */}
      </div>

      {/* Template picker — owner-requested 2026-09-20: "the advance shoud be
          as a sub tab", matching web's exact picker (app/dashboard/extract/
          page.tsx's TEMPLATES.map row) instead of a separate floating
          two-button toggle. One bordered card wraps the tab row AND the
          active mode's fields, same as web. */}
      <div className="rounded-xl border border-border bg-card p-4 flex flex-col gap-4">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setMode("lead")}
            className={`flex-1 rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
              mode === "lead"
                ? "border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300"
                : "border-border bg-transparent text-fg-muted hover:bg-black/5 dark:hover:bg-white/5"
            }`}
          >
            Lead Search
          </button>
          <button
            type="button"
            onClick={() => setMode("advanced-search")}
            className={`flex-1 rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
              mode === "advanced-search"
                ? "border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300"
                : "border-border bg-transparent text-fg-muted hover:bg-black/5 dark:hover:bg-white/5"
            }`}
          >
            Advanced Search
          </button>
        </div>

        {/* Search bar */}
        {mode === "lead" && (
        <>
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
              max={100000}
              value={minLeads}
              onChange={(e) => setMinLeads(clampNumber(e.target.valueAsNumber, 0, 100000, 0))}
              title="Keep auto-expanding more search queries until this many leads are found (0 = off), like the web's Minimum results."
              className="w-32 rounded-lg border border-border bg-input px-2 py-2 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-fg-muted">Max leads</span>
            <input
              type="number"
              min={1}
              max={1000000}
              value={maxTotalLeads}
              onChange={(e) => setMaxTotalLeads(clampNumber(e.target.valueAsNumber, 1, 1000000, 40))}
              title="Hard ceiling — stop collecting once this many leads are found. Never lower than Min leads."
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
          <label className="flex flex-col gap-1">
            <span className="text-xs text-fg-muted">Results table</span>
            <select
              value={resultFormMode}
              onChange={(e) => setResultFormMode(e.target.value as ResultMode)}
              className="w-40 rounded-lg border border-border bg-input px-2 py-2 text-sm"
              title="Which columns the results table shows for this search — doesn't affect what's extracted, just what's displayed. Saved with this run."
            >
              <option value="namesEmails">Names + Emails</option>
              <option value="emailsOnly">Emails only</option>
              <option value="full">Full details</option>
            </select>
          </label>
        </div>

        {/* The self-hosted-webmail checkbox section that used to live here
            was removed 2026-09-20 — Advanced Search (its own mode, below,
            with all 12 platforms including hosted providers) is the real,
            working home for this now. webmailPlatforms/verifyWebmail state
            stays harmlessly unused rather than ripping out the params
            plumbing that still reads them correctly if ever needed again. */}

        {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
        <p className="mt-2 text-[11px] text-fg-muted">
          {running
            ? `Running… ${runs[0]?.leads.length ?? 0} lead(s) so far.`
            : "Results are held in this window + a temp local JSONL file for this slice — a SQLite schema replaces that later."}
        </p>
        </>
      )}

      {/* Advanced Search bar — owner-requested 2026-09-20: real local
          equivalent of the web's background-job Advanced Search, streamed
          from /api/exe/advanced-search/run (see startAdvancedSearch). */}
      {mode === "advanced-search" && (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-fg-muted">
              Search queries (comma/newline-separated — runs each one after another in the same run)
            </span>
            <textarea
              value={advQueries}
              onChange={(e) => setAdvQueries(e.target.value)}
              placeholder={'e.g. "law firms in usa"\n"accounting firms in texas"'}
              rows={2}
              className="w-full rounded-lg border border-border bg-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-fg-muted">Domain filter (optional, comma-separated) — skips search, probes exactly these</span>
            <input
              type="text"
              value={advDomains}
              onChange={(e) => setAdvDomains(e.target.value)}
              placeholder="e.g. acmelaw.com, otherfirm.com"
              className="w-full rounded-lg border border-border bg-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
            />
          </label>
          <div>
            <p className="mb-1.5 text-xs text-fg-muted">Mail platforms to confirm</p>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {ADVANCED_SEARCH_PLATFORM_OPTIONS.map((opt) => (
                <label key={opt.value} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={advPlatforms.includes(opt.value)}
                    onChange={(e) =>
                      setAdvPlatforms((prev) =>
                        e.target.checked ? [...prev, opt.value] : prev.filter((v) => v !== opt.value),
                      )
                    }
                    className="h-4 w-4 cursor-pointer"
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-2">
              <span className="text-fg-muted">Keep going until (leads):</span>
              <input
                type="number"
                min={0}
                value={advMinLeads}
                onChange={(e) => setAdvMinLeads(Number(e.target.value) || 0)}
                className="w-24 rounded border border-border bg-input px-2 py-1 text-sm"
              />
            </label>
            <label className="flex items-center gap-2">
              <span className="text-fg-muted">Max duration (min):</span>
              <input
                type="number"
                min={1}
                max={180}
                value={advMaxDurationMinutes}
                onChange={(e) => setAdvMaxDurationMinutes(Number(e.target.value) || 30)}
                className="w-20 rounded border border-border bg-input px-2 py-1 text-sm"
              />
            </label>
            <label className="flex items-center gap-2">
              <span className="text-fg-muted">Results table:</span>
              <select
                value={advResultMode}
                onChange={(e) => setAdvResultMode(e.target.value as ResultMode)}
                className="rounded-lg border border-border bg-input px-2 py-2 text-sm"
              >
                <option value="namesEmails">Names + Emails</option>
                <option value="emailsOnly">Emails only</option>
                <option value="full">Full details</option>
              </select>
            </label>
            <div className="shrink-0">
              {running ? (
                <Button variant="primary" type="button" onClick={stopSearch}>Stop</Button>
              ) : (
                <Button variant="primary" type="button" onClick={() => void startAdvancedSearch()}>Search</Button>
              )}
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={advRequireEmail}
              onChange={(e) => setAdvRequireEmail(e.target.checked)}
              className="h-4 w-4 cursor-pointer"
            />
            Only keep leads with a real email
            <span className="text-xs text-fg-muted">(skips saving a confirmed domain with no crawlable contact email)</span>
          </label>
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          <p className="text-[11px] text-fg-muted">
            {running
              ? `Running… ${runs[0]?.leads.length ?? 0} lead(s) so far.`
              : "Runs entirely on this machine — real DDG search, MX lookups, and page crawls, no VPS involved."}
          </p>
        </div>
      )}
      </div>

      {/* Web-matching information architecture: LEFT = session/run history,
          RIGHT = the selected run's detail (activity + leads together). */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden md:flex-row">
        {/* Session / run history */}
        <div className="max-h-64 w-full flex-shrink-0 overflow-y-auto rounded-xl border border-border bg-card md:h-auto md:max-h-full md:w-72">
          {/* Task 27 merge — multi-select finished runs and combine them into one new
              run (the web's checkboxes + "Merge N sessions", operating on the EXE's
              in-memory runs). */}
          {mergeSelectedIds.size >= 2 && (
            <div className="border-b border-border px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-fg-muted">{mergeSelectedIds.size} sessions selected</span>
                <button
                  type="button"
                  onClick={() => void confirmMergeRuns()}
                  disabled={mergeBusy}
                  className="rounded-lg bg-brand-600 px-3 py-1 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
                >
                  {mergeBusy ? "Merging…" : `Merge ${mergeSelectedIds.size} sessions`}
                </button>
              </div>
              {mergeError && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{mergeError}</p>}
            </div>
          )}
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            className="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-sm font-medium text-brand-600 hover:bg-black/5 dark:text-brand-400 dark:hover:bg-white/5"
          >
            ↑ Import leads
            <span className="text-[11px] font-normal text-fg-muted">(.csv .tsv .txt .json .xlsx)</span>
          </button>
          {runs.length === 0 && (
            <p className="p-4 text-sm text-fg-muted">No runs yet. Submit a search above.</p>
          )}
          {runs.map((run) => {
            const meta = runStatusMeta(run);
            const summary = summarizeRun(run);
            const mergeable = run.status !== "running";
            return (
              <div
                key={run.id}
                onClick={() => { setSelectedRunId(run.id); setSelectedLeadIndexes(new Set()); }}
                className={`cursor-pointer border-b border-border p-3 last:border-0 hover:bg-black/5 dark:hover:bg-white/5 ${selectedRunId === run.id ? "bg-brand-50 dark:bg-brand-900/20" : ""}`}
              >
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={mergeSelectedIds.has(run.id)}
                    disabled={!mergeable}
                    aria-label={`Select session ${summary} to merge`}
                    title={mergeable ? "Select to merge with other sessions" : "Running sessions can't be merged"}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleRunSelected(run.id)}
                    className="h-3.5 w-3.5 shrink-0 accent-brand-600 disabled:cursor-not-allowed disabled:opacity-40"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium" title={summary}>{summary}</span>
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

              {/* Task 27 — per-run actions for the selected session: columns selector
                  (#1), the Actions menu (export + validate, the web's dropdown), and
                  import. All operate on this run's in-memory leads. */}
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 text-xs text-fg-muted">
                  Results:
                  <select
                    value={selectedRun.resultMode}
                    onChange={(e) => setRunResultMode(selectedRun.id, e.target.value as ResultMode)}
                    className="rounded border border-border bg-input px-2 py-1 text-xs"
                  >
                    <option value="namesEmails">Names + Emails</option>
                    <option value="emailsOnly">Emails only</option>
                    <option value="full">Full details</option>
                  </select>
                </label>
                {/* Task 54 — export-time domain filter (EXE sibling of the web's
                    export route ?domains=). Distinct domains in this run, as
                    toggleable chips; selecting some narrows the CSV only, never
                    the run's in-memory leads. */}
                <DomainsFilterChipsExe
                  leads={selectedRun.leads}
                  selected={filterExportDomains}
                  onChange={setFilterExportDomains}
                />
                {/* Owner-requested 2026-09-21 — a direct, one-click export
                    (straight to the Documents folder, no Save-As dialog),
                    ahead of the Actions dropdown rather than only inside it.
                    Not a replacement for the dropdown's Export CSV/Emails
                    only/Validate all — an additional fast path. */}
                <Button
                  variant="secondary"
                  type="button"
                  className="text-xs"
                  disabled={quickExportState === "saving" || selectedRun.leads.length === 0}
                  onClick={() => void quickExportRun(selectedRun)}
                  title="Save this run's leads straight to your Documents folder"
                >
                  {quickExportState === "saving"
                    ? "Saving…"
                    : quickExportState === "saved"
                      ? "Saved to Documents ✓"
                      : quickExportState === "error"
                        ? "Save failed"
                        : "Export CSV"}
                </Button>
                {/* Owner-requested 2026-09-21 — same reasoning as the Export CSV
                    button above: "Validate all" lives inside the Actions dropdown,
                    which has a known WebView2 blank-menu rendering bug (still
                    under separate investigation). Applies to ANY run's leads
                    regardless of source — search, import, or merge — so pulling
                    it out here fixes "can't validate imported leads" too, since
                    that was the same dropdown bug, not a separate validator
                    limitation (runValidation() already treats every run the
                    same way). Not a replacement for the dropdown's copy. */}
                <Button
                  variant="secondary"
                  type="button"
                  className="text-xs"
                  disabled={validateBusy || !selectedRun.leads.some((l) => isPendingValidation(l))}
                  onClick={() => void validateSelectedRun()}
                  title="Check every unvalidated lead's email in this run"
                >
                  {validateBusy ? "Validating…" : "Validate all"}
                </Button>
                <Dropdown
                  label="Actions"
                  className="text-xs"
                  items={[
                    { label: "Export CSV", onSelect: () => exportRun(selectedRun, false) },
                    { label: "Emails only", onSelect: () => exportRun(selectedRun, true) },
                    {
                      label: validateBusy ? "Validating…" : "Validate all",
                      busy: validateBusy,
                      onSelect: () => void validateSelectedRun(),
                      disabled:
                        validateBusy ||
                        !selectedRun.leads.some((l) => isPendingValidation(l)),
                    },
                  ]}
                />
                <Button
                  variant="secondary"
                  onClick={() => setImportOpen(true)}
                  className="px-3 py-1 text-xs"
                >
                  Import leads
                </Button>
                {validateError && <span className="text-xs text-red-600 dark:text-red-400">{validateError}</span>}
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
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pt-3">
                  <h3 className="text-sm font-semibold">Leads ({selectedRun.leads.length})</h3>
                  {/* Live validation summary — the web's tally, derived from this run. */}
                  {validationSummary && (validationSummary.valid + validationSummary.invalid + validationSummary.pending) > 0 && (
                    <span className="ml-auto flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
                      <Badge tone="success">{validationSummary.valid} valid</Badge>
                      <Badge tone="danger">{validationSummary.invalid} invalid</Badge>
                      {validationSummary.pending > 0 && <Badge tone="neutral">{validationSummary.pending} to check</Badge>}
                      {validationSummary.noEmail > 0 && <span>({validationSummary.noEmail} no email)</span>}
                    </span>
                  )}
                  {validationSummary && validationSummary.invalid > 0 && (
                    <Button
                      variant="ghost"
                      onClick={() => void deleteInvalidLeads()}
                      className="px-2 py-1 text-xs text-red-500 hover:text-red-600"
                    >
                      Delete {validationSummary.invalid} invalid
                    </Button>
                  )}
                </div>
                {selectedLeads.length > 0 && (
                  <div className="px-3 py-1">
                    <Button
                      variant="ghost"
                      onClick={() => void removeSelectedLeads()}
                      className="px-2 py-1 text-xs text-red-500 hover:text-red-600"
                    >
                      Remove {selectedLeads.length} selected
                    </Button>
                  </div>
                )}
                {selectedRun.leads.length === 0 ? (
                  <p className="px-3 py-6 text-sm text-fg-muted">
                    {selectedRun.status === "running" ? "Searching… leads will appear here as they're extracted." : "No leads found this run."}
                  </p>
                ) : (
                  <div ref={leadsScrollRef} className="max-h-[46vh] overflow-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border text-left text-xs text-fg-muted">
                          <th className="w-8 px-3 pb-2 pr-1 font-normal">
                            <input
                              type="checkbox"
                              checked={allVisibleSelected}
                              ref={selectAllInputRef}
                              aria-label="Select all leads"
                              title="Select all shown leads"
                              className="h-3.5 w-3.5 accent-brand-600"
                              onChange={toggleSelectAllVisible}
                            />
                          </th>
                          {selectedRun.resultMode !== "emailsOnly" && <th className="pb-2 pr-3 font-medium">Name</th>}
                          {selectedRun.resultMode === "full" && <th className="pb-2 pr-3 font-medium">Business</th>}
                          <th className="pb-2 pr-3 font-medium">Email</th>
                          {selectedRun.resultMode === "full" && (
                            <>
                              <th className="pb-2 pr-3 font-medium">Phone</th>
                              <th className="pb-2 pr-3 font-medium">Website</th>
                            </>
                          )}
                          <th className="pb-2 pr-3 font-medium">Status</th>
                          <th className="w-8 pb-2 pr-1" />
                        </tr>
                      </thead>
                      <tbody>
                        {selectedRun.leads.map((lead, i) => {
                          // emailsOnly keeps lead emails visible, but hides leads that
                          // have no email at all (nothing to show in that mode).
                          if (selectedRun.resultMode === "emailsOnly" && !lead.email) return null;
                          return (
                            <tr key={i} className={`border-b border-border last:border-0 hover:bg-black/5 dark:hover:bg-white/5 ${selectedLeadIndexes.has(i) ? "bg-brand-50 dark:bg-brand-900/20" : ""}`}>
                              <td className="py-2 pl-3 pr-1">
                                <input
                                  type="checkbox"
                                  checked={selectedLeadIndexes.has(i)}
                                  aria-label={`Select ${lead.email || lead.businessName || "lead"}`}
                                  onChange={() => toggleLeadSelected(i)}
                                  className="h-3.5 w-3.5 accent-brand-600"
                                />
                              </td>
                              {/* Fixed 2026-09-21: a lead can be phone/business-only (buildLeads()
                                  in local-engine's lead.ts returns a lead with no email/contactName
                                  when only a phone or business name was found on the page) — outside
                                  "Full details" mode, Business/Phone have no column, so that real
                                  lead rendered as a totally blank —/—/— row, indistinguishable from
                                  an empty result. Fall back to businessName/phone here so the row
                                  always shows the best identifying info it actually has. */}
                              {selectedRun.resultMode !== "emailsOnly" && (
                                <td className="py-2 pr-3">{lead.contactName || lead.businessName || "—"}</td>
                              )}
                              {selectedRun.resultMode === "full" && <td className="py-2 pr-3">{lead.businessName || "—"}</td>}
                              <td className="py-2 pr-3">
                                {lead.email ? (
                                  <a href={`mailto:${lead.email}`} className="text-brand-600 hover:underline">{lead.email}</a>
                                ) : lead.phone ? (
                                  <span className="text-fg-muted" title="No email found — showing the extracted phone number instead">
                                    {lead.phone} <span className="text-[0.65rem]">(phone)</span>
                                  </span>
                                ) : (
                                  "—"
                                )}
                              </td>
                              {selectedRun.resultMode === "full" && (
                                <>
                                  <td className="py-2 pr-3">{lead.phone ?? "—"}</td>
                                  <td className="py-2 pr-3">
                                    {lead.website
                                      ? <a href={lead.website} target="_blank" rel="noopener noreferrer" className="block max-w-[150px] truncate text-brand-600 hover:underline">{lead.website}</a>
                                      : "—"}
                                  </td>
                                </>
                              )}
                              <td className="py-2 pr-3">
                                {lead.validationStatus === "valid" ? (
                                  <Badge tone="success" title="Valid email (syntax + MX)">Valid</Badge>
                                ) : lead.validationStatus === "invalid" ? (
                                  <Badge tone="danger" title={lead.validationError === "invalid_format" ? "Malformed email address" : lead.validationError === "no_mx_records" ? "Domain has no mail records" : "Invalid"}>Invalid</Badge>
                                ) : (
                                  <span className="text-xs text-fg-muted">—</span>
                                )}
                              </td>
                              <td className="py-2 pr-1 text-right">
                                <button
                                  type="button"
                                  title="Remove this lead"
                                  aria-label={`Remove ${lead.email || lead.businessName || "this lead"}`}
                                  onClick={() => void removeSingleLead(selectedRun, i)}
                                  className="rounded px-1 text-fg-muted transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/30"
                                >
                                  ✕
                                </button>
                              </td>
                            </tr>
                          );
                        })}
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
      {importOpen &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
            onClick={() => { if (!importBusy) setImportOpen(false); }}
          >
            <div className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold">Import leads</h2>
                <button
                  type="button"
                  onClick={() => setImportOpen(false)}
                  disabled={importBusy}
                  className="rounded px-2 text-fg-muted hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>
              <p className="mt-1 text-sm text-fg-muted">
                Add your own lead list as a new local run — CSV, TSV, TXT (one email per line),
                JSON, or XLSX. Then use <span className="font-medium">Actions → Validate all</span> to check the emails.
              </p>
              <div
                role="button"
                tabIndex={0}
                onClick={() => { if (!importBusy) importInputRef.current?.click(); }}
                onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && !importBusy) importInputRef.current?.click(); }}
                onDragEnter={(e) => { e.preventDefault(); dragDepthRef.current += 1; setDragActive(true); }}
                onDragLeave={(e) => { e.preventDefault(); dragDepthRef.current -= 1; if (dragDepthRef.current <= 0) setDragActive(false); }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  dragDepthRef.current = 0;
                  setDragActive(false);
                  const f = e.dataTransfer.files?.[0] ?? null;
                  if (f) void performImport(f);
                }}
                className={`mt-4 flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 py-8 text-sm ${dragActive ? "border-brand-500 bg-brand-50 text-brand-600 dark:bg-brand-900/20" : "border-border text-fg-muted"}`}
              >
                <span className="font-medium">
                  {importBusy ? "Importing…" : dragActive ? "Drop it here" : importDone ? "Import another file" : "Click to choose a file"}
                </span>
                <span className="text-xs">or drag &amp; drop one here</span>
              </div>
              <input
                ref={importInputRef}
                type="file"
                accept=".csv,.tsv,.txt,.json,.xlsx,.xls"
                className="hidden"
                disabled={importBusy}
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  if (f) void performImport(f);
                  e.currentTarget.value = "";
                }}
              />
              {importBusy && <p className="mt-3 flex items-center gap-2 text-sm text-fg-muted">Parsing file…</p>}
              {importDone && (
                <div className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-300">
                  Imported {importDone.imported} lead{importDone.imported === 1 ? "" : "s"} from{" "}
                  {importDone.fileName}. The imported list is now a new run in the sidebar.
                </div>
              )}
              {importError && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{importError}</p>}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}