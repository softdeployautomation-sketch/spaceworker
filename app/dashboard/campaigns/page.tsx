"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

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
    setModalOpen(true);
    fetch("/api/mailboxes")
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => setMailboxes((data as Mailbox[]).map((m) => ({ id: m.id, label: m.label, host: m.host, username: m.username }))))
      .catch(() => setMailboxes([]));
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
    if (!fromSearchJobId && !csvContent.trim()) { setFormError("Upload a recipient CSV"); return; }
    if (fromSearchJobId && (leadEmailCount === null || leadEmailCount === 0)) {
      setFormError(leadEmailCount === 0 ? "That job has no leads with an email address." : "Still loading that job's leads — try again in a moment.");
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
          ...(fromSearchJobId ? { searchJobId: fromSearchJobId } : { csv: csvContent }),
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

      {modalOpen && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/40 p-4 dark:bg-black/70">
          <div className="mx-auto my-8 w-full max-w-2xl rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-700 dark:bg-zinc-950">
            <h2 className="text-lg font-semibold">New campaign</h2>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              Senders and subject lines rotate evenly in-run; recipients come from a CSV. You'll confirm a
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
                        {m.label} — {m.username}
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
                Body <span className="text-xs text-zinc-400">{'— use {{firstName}}, {{company}} etc. from your CSV columns'}</span>
                <textarea
                  value={sharedBody}
                  onChange={(e) => setSharedBody(e.target.value)}
                  rows={5}
                  placeholder='Hi {{firstName}} — thanks for the time with {{company}}.'
                  className="resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                />
              </label>

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
        </div>
      )}
    </div>
  );
}