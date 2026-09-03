"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Campaign = {
  id: string;
  name: string;
  subject: string;
  bodyHtml: string;
  searchJobId: string | null;
  status: string;
  createdAt: string;
  _count?: { items: number };
};

type Mailbox = {
  id: string;
  label: string;
  host: string;
  username: string;
};

const STATUS_BADGES: Record<string, string> = {
  draft: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  sending: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400",
  done: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400",
};

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [mailboxId, setMailboxId] = useState("");
  const [recipients, setRecipients] = useState("");
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [startingId, setStartingId] = useState<string | null>(null);
  const router = useRouter();

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

  function openNew() {
    setStep(1);
    setName("");
    setSubject("");
    setBodyHtml("");
    setMailboxId("");
    setRecipients("");
    setFormError("");
    setModalOpen(true);
    // Preload mailboxes for the mailbox select
    fetch("/api/mailboxes")
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => setMailboxes((data as Mailbox[]).map((m) => ({ id: m.id, label: m.label, host: m.host, username: m.username }))))
      .catch(() => setMailboxes([]));
  }

  function recipientsList(): string[] {
    return [...new Set(
      recipients
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    )];
  }

  function goToStep2() {
    setFormError("");
    if (!name.trim() || !subject.trim() || !bodyHtml.trim() || !mailboxId) {
      setFormError("Name, subject, HTML body and a mailbox are required");
      return;
    }
    setStep(2);
  }

  async function submit() {
    const toEmails = recipientsList();
    if (toEmails.length === 0) {
      setFormError("Paste at least one recipient email (one per line)");
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      const res = await fetch("/api/campaigns", {
        method: "POST",
        body: JSON.stringify({ name, subject, bodyHtml, mailboxId, toEmails }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof data.error === "string" ? data.error : "Failed to create campaign");
      }
      setModalOpen(false);
      load();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Failed to create campaign");
    } finally {
      setSaving(false);
    }
  }

  async function startSending(c: Campaign) {
    setStartingId(c.id);
    try {
      const res = await fetch(`/api/campaigns/${c.id}/send`, { method: "POST" });
      if (res.ok) {
        setCampaigns((prev) => prev.map((x) => (x.id === c.id ? { ...x, status: "sending" } : x)));
      }
    } finally {
      setStartingId(null);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Campaigns</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Queue outreach emails and send them safely through your own mailboxes.
          </p>
        </div>
        <button
          type="button"
          onClick={openNew}
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          New Campaign
        </button>
      </div>

      {error && <p className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {loading ? (
        <p className="mt-8 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
      ) : campaigns.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-zinc-300 p-10 text-center dark:border-zinc-700">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            No campaigns yet. Create your first campaign to get started.
          </p>
        </div>
      ) : (
        <div className="mt-8 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
  {campaigns.map((c) => (
              <div
                key={c.id}
                onClick={() => router.push(`/dashboard/campaigns/${c.id}`)}
                className="flex cursor-pointer flex-col gap-3 px-5 py-4 transition-colors hover:bg-zinc-50 sm:flex-row sm:items-center dark:hover:bg-zinc-800/50"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{c.name}</p>
                  <p className="mt-0.5 truncate text-sm text-zinc-500 dark:text-zinc-400">
                    {c.subject}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-4">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${
                      STATUS_BADGES[c.status] ?? "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                    }`}
                  >
                    {c.status}
                  </span>
                  <span className="text-sm text-zinc-500 dark:text-zinc-400">
                    {c._count?.items ?? 0} recipients
                  </span>
                  <span className="hidden text-sm text-zinc-400 sm:block dark:text-zinc-500">
                    {new Date(c.createdAt).toLocaleDateString()}
                  </span>
                  {c.status === "draft" && (
                    <button
                      type="button"
                      disabled={startingId === c.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        startSending(c);
                      }}
                      className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
                    >
                      {startingId === c.id ? "Starting…" : "Start Sending"}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
  {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg overflow-y-auto rounded-xl bg-white p-6 shadow-xl dark:bg-zinc-900">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">New campaign</h2>
              <div className="flex gap-2 text-xs font-medium text-zinc-400 dark:text-zinc-500">
                <span className={step === 1 ? "text-zinc-900 dark:text-zinc-100" : ""}>1. Details</span>
                <span>→</span>
                <span className={step === 2 ? "text-zinc-900 dark:text-zinc-100" : ""}>2. Recipients</span>
              </div>
            </div>

            {step === 1 ? (
              <div className="mt-5 flex flex-col gap-4">
                <label className="flex flex-col gap-1 text-sm font-medium">
                  Campaign name
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Q3 outreach"
                    className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                  />
                </label>

                <label className="flex flex-col gap-1 text-sm font-medium">
                  Subject
                  <input
                    type="text"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    placeholder="Subject line"
                    className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                  />
                </label>

                <label className="flex flex-col gap-1 text-sm font-medium">
                  HTML body
                  <textarea
                    value={bodyHtml}
                    onChange={(e) => setBodyHtml(e.target.value)}
                    placeholder={"<p>Hi,</p><p>Your message here.</p>"}
                    rows={6}
                    className="resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-xs font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                  />
                </label>

                <label className="flex flex-col gap-1 text-sm font-medium">
                  Sending mailbox
                  <select
                    value={mailboxId}
                    onChange={(e) => setMailboxId(e.target.value)}
                    className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                  >
                    <option value="">Select a mailbox…</option>
                    {mailboxes.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label} — {m.username} ({m.host})
                      </option>
                    ))}
                  </select>
                </label>

                {formError && <p className="text-sm text-red-600 dark:text-red-400">{formError}</p>}

                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={goToStep2}
                    className="flex-1 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
                  >
                    Continue
                  </button>
                  <button
                    type="button"
                    onClick={() => setModalOpen(false)}
                    className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  >
                    Cancel
                  </button>
                </div>
              </div>
  ) : (
              <div className="mt-5 flex flex-col gap-4">
                <label className="flex flex-col gap-1 text-sm font-medium">
                  Recipients — one email per line
                  <textarea
                    value={recipients}
                    onChange={(e) => setRecipients(e.target.value)}
                    placeholder={"lead1@example.com\nlead2@example.com\nlead3@example.com"}
                    rows={8}
                    className="resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                  />
                </label>

                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  {recipientsList().length} valid recipient{recipientsList().length === 1 ? "" : "s"}
                </p>

                {formError && <p className="text-sm text-red-600 dark:text-red-400">{formError}</p>}

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setStep(1)}
                    className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={submit}
                    disabled={saving}
                    className="flex-1 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
                  >
                    {saving ? "Creating…" : "Create campaign"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}