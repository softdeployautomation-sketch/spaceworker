"use client";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter, useSearchParams } from "next/navigation";
import MailboxesPanel from "@/components/mailboxes-panel";

type Campaign = {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  _count?: { items: number };
  variants?: { id: string; subject: string }[];
};

type Mailbox = {
  id: string;
  label: string;
  host: string;
  username: string;
  fromAddress: string | null;
};

// Task 26, Piece 4 — "Pick from my leads" recipient picker data (GET /api/leads/selectable).
type PickerJob = {
  id: string;
  query: string;
  template: string;
  params: Record<string, unknown> | null;
  totalCount: number;
  validCount: number;
};
type PickerLead = {
  id: string;
  email: string | null;
  businessName: string | null;
  contactName: string | null;
  searchJobId: string;
};
type PickerData = {
  jobs: PickerJob[];
  leads: PickerLead[];
};

const STATUS_BADGES: Record<string, string> = {
  draft: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  pending_test_confirm: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300",
  sending: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400",
  done: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400",
};

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState("");
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [selectedMailboxIds, setSelectedMailboxIds] = useState<string[]>([]);
  const [subjects, setSubjects] = useState<string[]>([""]);
  const [sharedBody, setSharedBody] = useState("");
  // Task 26, Piece 5b — how many consecutive recipients share a mailbox/subject
  // before the rotation advances (clamped server-side to [1, 1000]; default 1).
  const [rotateEvery, setRotateEvery] = useState("1");
  const [csvName, setCsvName] = useState("");
  const [csvContent, setCsvContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const router = useRouter();
  const searchParams = useSearchParams();
  // Arrived via "Create campaign from these leads" on the Lead Extractor page
  // (?fromSearchJob=<id>) — recipients come from that job's own leads
  // instead of a CSV upload, so the sender's list is exactly what this app
  // already extracted, no manual export/re-upload round trip.
  const fromSearchJobId = searchParams.get("fromSearchJob");
  const [leadEmailCount, setLeadEmailCount] = useState<number | null>(null);
  const [leadCountError, setLeadCountError] = useState("");

  // Task 26, Piece 6 — the Mailboxes management UI now lives here as a second
  // tab (it used to be its own /dashboard/mailboxes route). The active tab is
  // driven by the URL (?tab=mailboxes) so that legacy route — which now just
  // redirects here — and any deep link land on the right sub-view; the tab
  // buttons themselves just navigate so the address bar stays meaningful.
  const tab: "campaigns" | "mailboxes" =
    searchParams.get("tab") === "mailboxes" ? "mailboxes" : "campaigns";
  function switchTab(next: "campaigns" | "mailboxes") {
    if (next === tab) return;
    router.push(
      next === "mailboxes" ? "/dashboard/campaigns?tab=mailboxes" : "/dashboard/campaigns",
    );
  }

  // Task 26, Piece 4 — "Pick from my leads" recipient source state.
  const [recipientSource, setRecipientSource] = useState<"csv" | "leads">("csv");
  const [pickerData, setPickerData] = useState<PickerData | null>(null);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerError, setPickerError] = useState("");
  const [pickerJobId, setPickerJobId] = useState("");
  const [pickerSearch, setPickerSearch] = useState("");
  const [selectedLeadIds, setSelectedLeadIds] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/campaigns");
      if (!res.ok) throw new Error("Failed to load campaigns");
      setCampaigns((await res.json()) as Campaign[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load campaigns");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Arrived via "Create campaign from these leads" — open straight into the
  // create modal and preview how many of that job's leads actually have an
  // email (the only field this app sends), so the count doesn't come as a
  // surprise on submit.
  useEffect(() => {
    if (!fromSearchJobId) return;
    openNew();
    setLeadCountError("");
    setLeadEmailCount(null); // clear any previous job's count immediately, not just on this fetch's resolution
    fetch(`/api/jobs/${fromSearchJobId}`)
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((job: { leads?: Array<{ email?: string | null }> }) => {
        const emails = new Set(
          (job.leads ?? [])
            .map((l) => (l.email ?? "").trim().toLowerCase())
            .filter((e) => e.length > 0),
        );
        setLeadEmailCount(emails.size);
      })
      .catch(() => setLeadCountError("Couldn't load that job's leads."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromSearchJobId]);

  function openNew() {
    setName("");
    setSubjects([""]);
    setSharedBody("");
    setSelectedMailboxIds([]);
    setCsvName("");
    setCsvContent("");
    setFormError("");
    // Task 26, Piece 4 — reset the picker's transient state on each open (the
    // fetched /api/leads/selectable payload is cached so revisits don't re-fetch).
    setRecipientSource("csv");
    setPickerJobId("");
    setPickerSearch("");
    setSelectedLeadIds([]);
    setPickerError("");
    setModalOpen(true);
    fetch("/api/mailboxes")
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => setMailboxes((data as Mailbox[]).map((m) => ({ id: m.id, label: m.label, host: m.host, username: m.username, fromAddress: m.fromAddress }))))
      .catch(() => setMailboxes([]));
  }

  // Task 26, Piece 4 — load the picker's data (jobs + all of this user's valid
  // leads) on first use, then keep the payload cached for the rest of the session.
  async function loadPicker() {
    if (pickerLoading) return;
    setPickerLoading(true);
    setPickerError("");
    try {
      const res = await fetch("/api/leads/selectable");
      if (!res.ok) throw new Error("Failed to load your leads");
      setPickerData((await res.json()) as PickerData);
    } catch (e) {
      setPickerError(e instanceof Error ? e.message : "Failed to load your leads");
    } finally {
      setPickerLoading(false);
    }
  }

  function chooseSource(src: "csv" | "leads") {
    setRecipientSource(src);
    setFormError("");
    if (src === "leads" && !pickerData && !pickerLoading) void loadPicker();
  }

  function toggleLead(id: string) {
    setSelectedLeadIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  // The leads currently visible in the picker (job filter × free-text search).
  const visibleLeads: PickerLead[] = (pickerData?.leads ?? []).filter((l) => {
    if (pickerJobId && l.searchJobId !== pickerJobId) return false;
    const q = pickerSearch.trim().toLowerCase();
    if (!q) return true;
    return (
      (l.email ?? "").toLowerCase().includes(q) ||
      (l.businessName ?? "").toLowerCase().includes(q) ||
      (l.contactName ?? "").toLowerCase().includes(q)
    );
  });

  // Bug fix (2026-09-12): `pickerData.leads` only ever contains VALID leads
  // (see GET /api/leads/selectable), so choosing a job that hasn't been
  // validated yet correctly shows 0 here — but the generic "No leads match
  // this filter" message read as a stuck/broken total when a job with
  // thousands of raw leads showed nothing. Surface the real cause instead.
  const selectedJobMeta = pickerJobId ? pickerData?.jobs.find((j) => j.id === pickerJobId) ?? null : null;

  function selectAllVisible() {
    const ids = new Set(selectedLeadIds);
    visibleLeads.forEach((l) => ids.add(l.id));
    setSelectedLeadIds([...ids]);
  }

  function selectNoneVisible() {
    const visibleIds = new Set(visibleLeads.map((l) => l.id));
    setSelectedLeadIds((prev) => prev.filter((x) => !visibleIds.has(x)));
  }

  function selectAllValid() {
    const all = new Set(selectedLeadIds);
    (pickerData?.leads ?? []).forEach((l) => all.add(l.id));
    setSelectedLeadIds([...all]);
  }

  function toggleMailbox(id: string) {
    setSelectedMailboxIds((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]
    );
  }

  function setSubjectAt(index: number, value: string) {
    setSubjects(subjects.map((s, i) => (i === index ? value : s)));
  }

  function addSubject() {
    setSubjects([...subjects, ""]);
  }

  function removeSubject(index: number) {
    setSubjects(subjects.filter((_, i) => i !== index));
  }

  async function readCsv(file: File) {
    setCsvName(file.name);
    setFormError("");
    try {
      setCsvContent(await file.text());
    } catch {
      setCsvContent("");
      setFormError("Could not read that file");
    }
  }

  function validVariants(): { subject: string; bodyHtml: string }[] {
    const body = sharedBody.trim();
    return subjects
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && body.length > 0)
      .map((s) => ({ subject: s, bodyHtml: sharedBody }));
  }

  async function submit() {
    setFormError("");
    const variants = validVariants();
    if (!name.trim()) { setFormError("Name is required"); return; }
    if (selectedMailboxIds.length === 0) { setFormError("Select at least one sending mailbox"); return; }
    if (variants.length === 0) { setFormError("Add at least one subject line and a body"); return; }
    // Task 26, Piece 4 — the source-dependent validity checks. The locked
    // ?fromSearchJob mode keeps its old "loaded job, has emails" check.
    if (fromSearchJobId) {
      if (leadEmailCount === null || leadEmailCount === 0) {
        setFormError(leadEmailCount === 0 ? "That job has no leads with an email address." : "Still loading that job's leads — try again in a moment.");
        return;
      }
    } else if (recipientSource === "leads") {
      if (selectedLeadIds.length === 0) { setFormError("Select at least one lead to send to"); return; }
    } else if (!csvContent.trim()) {
      setFormError("Upload a recipient CSV");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          mailboxIds: selectedMailboxIds,
          variants,
          rotateEvery: Number(rotateEvery) || 1,
          ...(fromSearchJobId
            ? { searchJobId: fromSearchJobId }
            : recipientSource === "leads"
              ? { leadIds: selectedLeadIds }
              : { csv: csvContent }),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setModalOpen(false);
        const created = data.campaign as { id?: string } | undefined;
        if (created?.id) {
          router.push(`/dashboard/campaigns/${created.id}`);
        }
        void load();
      } else {
        setFormError(data.error ?? "Failed to create campaign");
      }
    } catch {
      setFormError("Network error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Task 26, Piece 6 — page-level segment switcher. The Mailboxes management
          UI was relocated here from its own /dashboard/mailboxes route and is
          rendered intact via <MailboxesPanel /> when that tab is active. */}
      <div className="mt-1 inline-flex rounded-lg bg-zinc-100 p-1 dark:bg-zinc-900">
        {([
          { value: "campaigns", label: "Campaigns" },
          { value: "mailboxes", label: "Mailboxes" },
        ] as const).map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => switchTab(t.value)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              tab === t.value
                ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                : "text-zinc-600 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-800"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "mailboxes" ? (
        <MailboxesPanel />
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Campaigns</h1>
          <p className="mt-1 text-sm text-fg-muted">
            New campaigns must pass a test-send-confirm before any real send.
          </p>
        </div>
        <button
          type="button"
          onClick={openNew}
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          New campaign
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
      ) : error ? (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      ) : campaigns.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-300 p-10 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
          No campaigns yet. Create one to rotate senders and subjects across a CSV recipient list.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Recipients</th>
                <th className="px-4 py-3 font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {campaigns.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => router.push(`/dashboard/campaigns/${c.id}`)}
                  className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900"
                >
                  <td className="px-4 py-3 font-medium">
                    {c.name}
                    {c.variants && c.variants.length > 0 && (
                      <span className="ml-2 text-xs text-zinc-400 dark:text-zinc-500">
                        {c.variants.length} subject variant{c.variants.length === 1 ? "" : "s"}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${
                      STATUS_BADGES[c.status] ?? "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                    }`}>
                      {c.status.replace("_", " ")}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">{c._count?.items ?? 0}</td>
                  <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                    {new Date(c.createdAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modalOpen && typeof document !== "undefined" && createPortal(
        // Portal to document.body — see the same fix + full rationale on
        // components/modal.tsx and the mailboxes page: this page's content
        // sits inside Shell's z-10 wrapper, a sibling (not an ancestor) of
        // the app's z-30 Dock, so a nested z-50 here never actually competed
        // against the Dock in the real stacking order.
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/40 p-4 dark:bg-black/70">
          <div className="mx-auto my-8 w-full max-w-2xl rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-700 dark:bg-zinc-950">
            <h2 className="text-lg font-semibold">New campaign</h2>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              Senders and subject lines rotate evenly in-run; recipients come from a CSV or your validated leads. You'll confirm a
              one-message test-send before the real send is allowed.
            </p>
<div className="mt-4 flex flex-col gap-4">
              <label className="flex flex-col gap-1 text-sm font-medium">
                Campaign name
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. H1 outreach"
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                />
              </label>

              <div className="flex flex-col gap-1 text-sm font-medium">
                Sending mailboxes <span className="text-xs text-zinc-400">— select 2+ to rotate senders</span>
                {mailboxes.length === 0 && <span className="text-xs text-zinc-500 dark:text-zinc-400">No mailboxes yet — add them under Mailboxes first.</span>}
                <div className="mt-1 flex flex-wrap gap-2">
                  {mailboxes.map((m) => {
                    const checked = selectedMailboxIds.includes(m.id);
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => toggleMailbox(m.id)}
                        className={`rounded-lg border px-3 py-1.5 text-sm font-normal transition-colors ${
                          checked
                            ? "border-zinc-500 bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                            : "border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-400"
                        }`}
                      >
                        {m.label} — {(m.fromAddress || m.username)}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex flex-col gap-1 text-sm font-medium">
                Subject lines <span className="text-xs text-zinc-400">— rotate evenly across recipients (shared body)</span>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  {subjects.map((s, i) => (
                    <div key={i} className="inline-flex items-center gap-1.5">
                      <input
                        type="text"
                        value={s}
                        onChange={(e) => setSubjectAt(i, e.target.value)}
                        placeholder={`Subject line ${i + 1}`}
                        className="w-64 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                      />
                      {subjects.length > 1 && (
                        <button type="button" onClick={() => removeSubject(i)} className="text-sm text-red-600 hover:underline">×</button>
                      )}
                    </div>
                  ))}
                  {subjects.length < 5 && (
                    <button type="button" onClick={addSubject} className="rounded-lg border border-dashed border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400">
                      + Add subject
                    </button>
                  )}
                </div>
              </div>

              <label className="flex flex-col gap-1 text-sm font-medium">
                Rotate every N emails
                <span className="text-xs text-zinc-400">— send N recipients from one mailbox/subject before moving to the next (1 = every recipient)</span>
                <input
                  type="number"
                  min={1}
                  max={1000}
                  value={rotateEvery}
                  onChange={(e) => setRotateEvery(e.target.value)}
                  className="w-32 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                />
              </label>

              <label className="flex flex-col gap-1 text-sm font-medium">
                Body <span className="text-xs text-zinc-400">{'— use {{firstName}}, {{company}} etc. from your CSV columns'}</span>
                <textarea
                  value={sharedBody}
                  onChange={(e) => setSharedBody(e.target.value)}
                  rows={5}
                  placeholder='Hi {{firstName}} — thanks for the time with {{company}}.'
                  className="resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                />
              </label>

              {!fromSearchJobId && (
                <div className="flex flex-col gap-1 text-sm font-medium">
                  Recipient source <span className="text-xs text-zinc-400">— a CSV, or leads you have already extracted and validated</span>
                  <div className="mt-1 inline-flex rounded-lg bg-zinc-100 p-1 dark:bg-zinc-900">
                    {(["csv", "leads"] as const).map((src) => (
                      <button
                        key={src}
                        type="button"
                        onClick={() => chooseSource(src)}
                        className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                          recipientSource === src
                            ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                            : "text-zinc-600 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-800"
                        }`}
                      >
                        {src === "leads" ? "Pick from my leads" : "Upload a CSV"}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {fromSearchJobId ? (
                <div className="flex flex-col gap-1 text-sm font-medium">
                  Recipients
                  {leadCountError ? (
                    <p className="text-xs text-red-600 dark:text-red-400">{leadCountError}</p>
                  ) : leadEmailCount === null ? (
                    <p className="rounded-lg bg-zinc-100 px-3 py-2 text-xs font-normal text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                      Loading…
                    </p>
                  ) : leadEmailCount === 0 ? (
                    <p className="rounded-lg bg-red-50 px-3 py-2 text-xs font-normal text-red-700 dark:bg-red-900/20 dark:text-red-300">
                      That job has no leads with an email address — nothing to send to.
                    </p>
                  ) : (
                    <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-normal text-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-300">
                      Using {leadEmailCount} email{leadEmailCount === 1 ? "" : "s"} from this Lead Extractor job — no CSV needed.
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() => { router.replace("/dashboard/campaigns"); setLeadEmailCount(null); setLeadCountError(""); }}
                    className="mt-1 self-start text-xs text-zinc-500 underline-offset-2 hover:underline dark:text-zinc-400"
                  >
                    Use a CSV upload instead
                  </button>
                </div>
              ) : recipientSource === "leads" ? (
                <div className="flex flex-col gap-2 text-sm font-medium">
                  Pick from my leads <span className="text-xs text-zinc-400">— only <em>valid</em> leads are selectable</span>
                  {pickerLoading ? (
                    <p className="rounded-lg bg-zinc-100 px-3 py-2 text-xs font-normal text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                      Loading your leads…
                    </p>
                  ) : pickerError ? (
                    <p className="text-xs text-red-600 dark:text-red-400">{pickerError}</p>
                  ) : !pickerData || pickerData.leads.length === 0 ? (
                    <p className="rounded-lg bg-zinc-100 px-3 py-2 text-xs font-normal text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                      No validated leads yet — open a job on the Extract page and run “Validate all,” then return here.
                    </p>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-end gap-3">
                        <label className="flex flex-col gap-1 text-xs font-medium">
                          Source job
                          <select
                            value={pickerJobId}
                            onChange={(e) => setPickerJobId(e.target.value)}
                            className="w-56 rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                          >
                            <option value="">All jobs</option>
                            {pickerData.jobs.map((j) => (
                              <option key={j.id} value={j.id}>
                                {j.query}{j.template === "upload" ? " (upload)" : ""} — {j.validCount} valid{j.validCount === 0 ? " · none" : ""}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="flex flex-col gap-1 text-xs font-medium">
                          Search email / business
                          <input
                            type="text"
                            value={pickerSearch}
                            onChange={(e) => setPickerSearch(e.target.value)}
                            placeholder="Filter…"
                            className="w-48 rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                          />
                        </label>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-2">
                        <button type="button" onClick={selectAllVisible} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400">
                          Select all visible ({visibleLeads.length})
                        </button>
                        <button type="button" onClick={selectNoneVisible} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400">
                          Clear visible
                        </button>
                        <button type="button" onClick={selectAllValid} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400">
                          Select all valid across everything ({pickerData.leads.length})
                        </button>
                      </div>
                      <p className="text-sm font-semibold">
                        {selectedLeadIds.length} recipient{selectedLeadIds.length === 1 ? "" : "s"} selected
                      </p>
                      <div className="max-h-[220px] overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
                        {visibleLeads.length === 0 ? (
                          selectedJobMeta && selectedJobMeta.validCount === 0 ? (
                            // Bug fix (2026-09-12): this job showing 0 selectable leads
                            // is correct — /api/leads/selectable only ever returns
                            // validationStatus:"valid" leads, and this job hasn't been
                            // validated yet — but the generic message below read as a
                            // stuck/broken total when a job with thousands of raw leads
                            // showed nothing. Say why, with a way to go fix it.
                            <p className="px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400">
                              {selectedJobMeta.totalCount} lead{selectedJobMeta.totalCount === 1 ? "" : "s"} in this job, but
                              none validated yet. Open it on the{" "}
                              <a href={`/dashboard/extract?job=${selectedJobMeta.id}`} className="underline">
                                Extract page
                              </a>{" "}
                              and run &ldquo;Validate all,&rdquo; then come back here.
                            </p>
                          ) : (
                            <p className="px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400">No leads match this filter.</p>
                          )
                        ) : (
                          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                            {visibleLeads.map((l) => (
                              <li key={l.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                                <input
                                  type="checkbox"
                                  checked={selectedLeadIds.includes(l.id)}
                                  onChange={() => toggleLead(l.id)}
                                  className="h-4 w-4 accent-zinc-900"
                                />
                                <span className="font-medium">{l.email ?? "—"}</span>
                                <span className="text-xs text-zinc-500 dark:text-zinc-400">{l.businessName ?? ""}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-1 text-sm font-medium">
                  Recipient CSV <span className="text-xs text-zinc-400">— first row headers, one required <code>email</code> column</span>
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) void readCsv(f); }}
                    className="text-sm"
                  />
                  {csvName && <span className="text-xs text-zinc-500">Selected: {csvName}</span>}
                </div>
              )}

              {formError && <p className="text-sm text-red-600 dark:text-red-400">{formError}</p>}

              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={saving}
                  className="flex-1 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
                >
                  {saving ? "Creating…" : "Create campaign"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setModalOpen(false);
                    // Clear ?fromSearchJob so a later "New campaign" click
                    // (with no navigation in between) doesn't reopen this
                    // same locked "recipients from search job" mode.
                    if (fromSearchJobId) router.replace("/dashboard/campaigns");
                  }}
                  className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
        </>
      )}
    </div>
  );
}