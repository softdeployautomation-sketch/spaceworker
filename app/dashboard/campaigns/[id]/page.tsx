"use client";
import { Fragment, useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

type QueueItem = {
  id: string;
  campaignId: string;
  mailboxId: string;
  toEmail: string;
  status: string;
  sentAt: string | null;
  error: string | null;
  createdAt: string;
};

type Mailbox = {
  id: string;
  label: string;
  username: string;
};

type CampaignDetail = {
  id: string;
  name: string;
  subject: string;
  bodyHtml: string;
  searchJobId: string | null;
  status: string;
  createdAt: string;
  items: QueueItem[];
};

const PAGE_SIZE = 50;

const STATUS_BADGES: Record<string, string> = {
  queued: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  sent: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400",
  failed: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400",
};

export default function CampaignDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const [campaign, setCampaign] = useState<CampaignDetail | null>(null);
  const [mailboxes, setMailboxes] = useState<Record<string, Mailbox>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [page, setPage] = useState(0);
  const [openErrorId, setOpenErrorId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError("");
    try {
      const [campaignRes, mailboxesRes] = await Promise.all([
        fetch(`/api/campaigns/${id}`),
        fetch("/api/mailboxes"),
      ]);
      if (!campaignRes.ok) throw new Error("Failed to load campaign");
      const data = (await campaignRes.json()) as CampaignDetail;
      setCampaign(data);
      if (mailboxesRes.ok) {
        const mb = (await mailboxesRes.json()) as Mailbox[];
        setMailboxes(Object.fromEntries(mb.map((m) => [m.id, m])));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load campaign");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>;
  }

  if (error || !campaign) {
    return (
      <div>
        <p className="text-sm text-red-600 dark:text-red-400">{error ?? "Campaign not found"}</p>
        <Link href="/dashboard/campaigns" className="mt-4 inline-block text-sm font-medium underline-offset-4 hover:underline">
          ← Back to campaigns
        </Link>
      </div>
    );
  }

  const totalPages = Math.max(1, Math.ceil(campaign.items.length / PAGE_SIZE));
  const pageItems = campaign.items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div>
      <Link href="/dashboard/campaigns" className="text-sm font-medium text-zinc-500 underline-offset-4 hover:underline dark:text-zinc-400">
        ← Back to campaigns
      </Link>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{campaign.name}</h1>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${
            STATUS_BADGES[campaign.status] ?? "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
          }`}
        >
          {campaign.status}
        </span>
      </div>

      <div className="mt-3 max-w-2xl rounded-xl border border-zinc-200 bg-white p-5 text-sm shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <p><span className="font-medium">Subject:</span> {campaign.subject}</p>
        <p className="mt-1">
          <span className="font-medium">Mailbox:</span>{" "}
          {mailboxes[campaign.items[0]?.mailboxId ?? ""]
            ? `${mailboxes[campaign.items[0].mailboxId].label} (${mailboxes[campaign.items[0].mailboxId].username})`
            : "—"}
        </p>
        <p className="mt-1">
          <span className="font-medium">Recipients:</span> {campaign.items.length}
        </p>
      </div>

  <div className="mt-6 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              <th className="px-4 py-3 font-medium">Recipient</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Sent at</th>
              <th className="px-4 py-3 font-medium">Error</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {pageItems.map((item) => (
              <Fragment key={item.id}>
                <tr>
                  <td className="px-4 py-3">{item.toEmail}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${
                        STATUS_BADGES[item.status] ?? "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                      }`}
                    >
                      {item.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                    {item.sentAt ? new Date(item.sentAt).toLocaleString() : "—"}
                  </td>
                  <td className="px-4 py-3">
                    {item.status === "failed" ? (
                      <button
                        type="button"
                        onClick={() => setOpenErrorId(openErrorId === item.id ? null : item.id)}
                        className="text-xs font-medium text-red-600 underline-offset-2 hover:underline dark:text-red-400"
                      >
                        {openErrorId === item.id ? "Hide" : "View"}
                      </button>
                    ) : (
                      <span className="text-zinc-300 dark:text-zinc-700">—</span>
                    )}
                  </td>
                </tr>
                {openErrorId === item.id && item.error && (
                  <tr key={`${item.id}-error`} className="bg-red-50/50 dark:bg-red-950/20">
                    <td colSpan={4} className="px-4 py-3">
                      <pre className="whitespace-pre-wrap break-words font-mono text-xs text-red-700 dark:text-red-400">
                        {item.error}
                      </pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
  {campaign.items.length > PAGE_SIZE && (
        <div className="mt-4 flex items-center justify-center gap-3 text-sm">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className="rounded-lg border border-zinc-300 px-3 py-1.5 font-medium transition-colors hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Previous
          </button>
          <span className="text-zinc-500 dark:text-zinc-400">
            Page {page + 1} of {totalPages}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            className="rounded-lg border border-zinc-300 px-3 py-1.5 font-medium transition-colors hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}