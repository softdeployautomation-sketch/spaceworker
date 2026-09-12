"use client";

// Task 27, Part B — the run-summary / drill-down page (Task 09). Reads
// GET /api/automations/[id]/runs/[runId] (automation + run + searchJob +
// campaign + mailboxSends) and renders duration by phase, leads extracted,
// emails sent with the per-mailbox breakdown, the source indicator, and links
// through to the underlying SearchJob/EmailCampaign. A "needs_confirmation"
// daily run (Part B's always-test-send-confirm gate) gets an explicit
// Confirm & send action here rather than sending unattended.

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Badge, Button, Card } from "@/components/ui";
import { useToast } from "@/components/toast";

type RunStatus = "running" | "needs_confirmation" | "done" | "failed" | "stopped";

interface RunDetail {
  automation: { id: string; name: string; triggerMode: string; leadSource: string; mailboxIds: string[] };
  run: {
    id: string;
    status: RunStatus;
    leadSource: string;
    startedAt: string;
    extractionCompletedAt: string | null;
    completedAt: string | null;
    leadsExtracted: number | null;
    emailsSent: number | null;
    emailsSentByMailbox: Record<string, number> | null;
    searchJobId: string | null;
    campaignId: string | null;
    errorMessage: string | null;
  };
  searchJob: { id: string; query: string; status: string; currentStep: string | null; error: string | null; createdAt: string; _count: { leads: number } } | null;
  campaign: { id: string; name: string; status: string; mailboxIds: string[] } | null;
  mailboxSends: { mailboxId: string; count: number }[];
}

const STATUS_TONE: Record<RunStatus, "success" | "danger" | "warning" | "neutral"> = {
  running: "neutral",
  needs_confirmation: "warning",
  done: "success",
  failed: "danger",
  stopped: "neutral",
};

function fmtDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default function AutomationRunDetailPage() {
  const params = useParams<{ id: string; runId: string }>();
  const { id, runId } = params;
  const { push } = useToast();
  const [data, setData] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);

  async function load() {
    const res = await fetch(`/api/automations/${id}/runs/${runId}`);
    if (res.ok) setData(await res.json());
    setLoading(false);
  }

  useEffect(() => {
    void load();
    const stillLive = data?.run.status === "running" || data?.run.status === undefined;
    const interval = stillLive ? setInterval(() => void load(), 4000) : null;
    return () => { if (interval) clearInterval(interval); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, runId, data?.run.status]);

  async function confirmSend() {
    setConfirming(true);
    try {
      const res = await fetch(`/api/automations/${id}/runs/${runId}/confirm`, { method: "POST" });
      const d = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(d.error ?? "Failed to confirm send");
      push("Send confirmed — queuing recipients now", "success");
      await load();
    } catch (e) {
      push(e instanceof Error ? e.message : "Failed to confirm send", "error");
    } finally {
      setConfirming(false);
    }
  }

  if (loading) return <div className="p-6 text-sm text-fg-muted">Loading…</div>;
  if (!data) return <div className="p-6 text-sm text-fg-muted">Run not found.</div>;

  const { automation, run, searchJob, campaign, mailboxSends } = data;
  const started = new Date(run.startedAt);
  const extractionDone = run.extractionCompletedAt ? new Date(run.extractionCompletedAt) : null;
  const completed = run.completedAt ? new Date(run.completedAt) : null;
  const extractionMs = extractionDone ? extractionDone.getTime() - started.getTime() : null;
  const sendMs = extractionDone && completed ? completed.getTime() - extractionDone.getTime() : null;
  const totalMs = completed ? completed.getTime() - started.getTime() : Date.now() - started.getTime();

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{automation.name}</h1>
          <p className="mt-1 text-sm text-fg-muted">
            Run started {started.toLocaleString()} ·{" "}
            {run.leadSource === "personal_list" ? "Personal list" : "Fresh extraction"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={STATUS_TONE[run.status] ?? "neutral"}>{run.status.replace("_", " ")}</Badge>
          <Link href={`/dashboard/automations/${id}`} className="text-sm font-medium text-brand-600 hover:underline dark:text-brand-300">
            ← Run history
          </Link>
        </div>
      </div>

      {run.errorMessage && (
        <Card className="border-red-300 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-900/20 dark:text-red-300">
          {run.errorMessage}
        </Card>
      )}

      {run.status === "needs_confirmation" && (
        <Card className="flex flex-wrap items-center justify-between gap-3 border-amber-300 bg-amber-50 p-4 dark:border-amber-900/60 dark:bg-amber-900/20">
          <p className="text-sm text-amber-800 dark:text-amber-300">
            Extraction finished with {run.leadsExtracted ?? 0} validated leads. This daily automation always pauses
            here for your confirmation before sending.
          </p>
          <Button onClick={() => void confirmSend()} disabled={confirming}>
            {confirming ? "Confirming…" : "Confirm & send"}
          </Button>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-fg-muted">Extraction time</p>
          <p className="mt-1 text-xl font-semibold">{extractionMs !== null ? fmtDuration(extractionMs) : "—"}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-fg-muted">Send time</p>
          <p className="mt-1 text-xl font-semibold">{sendMs !== null ? fmtDuration(sendMs) : "—"}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-fg-muted">Total</p>
          <p className="mt-1 text-xl font-semibold">{fmtDuration(totalMs)}</p>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-fg-muted">Leads extracted</p>
          <p className="mt-1 text-xl font-semibold">{run.leadsExtracted ?? "—"}</p>
          {searchJob && (
            <Link
              href={`/dashboard/extract?job=${searchJob.id}`}
              className="mt-2 inline-block text-sm text-brand-600 hover:underline dark:text-brand-300"
            >
              View source job ({searchJob._count.leads} total leads) →
            </Link>
          )}
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-fg-muted">Emails sent</p>
          <p className="mt-1 text-xl font-semibold">{run.emailsSent ?? "—"}</p>
          {campaign && (
            <Link
              href={`/dashboard/campaigns/${campaign.id}`}
              className="mt-2 inline-block text-sm text-brand-600 hover:underline dark:text-brand-300"
            >
              View campaign →
            </Link>
          )}
        </Card>
      </div>

      {mailboxSends.length > 0 && (
        <Card className="p-4">
          <p className="mb-3 text-sm font-medium">Sent by mailbox</p>
          <div className="flex flex-col gap-2">
            {mailboxSends.map((m) => (
              <div key={m.mailboxId} className="flex items-center justify-between text-sm">
                <span className="text-fg-muted">{m.mailboxId}</span>
                <span className="font-medium">{m.count}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
