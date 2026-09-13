"use client";
import { Fragment, useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

type QueueItem = {
  id: string;
  campaignId: string;
  mailboxId: string;
  mailbox?: { id: string; label: string; username: string } | null;
  variantId: string | null;
  variant?: { id: string; subject: string } | null;
  toEmail: string;
  // Task 29, item 3 — provenance. "manual_insert" = a test recipient the user
  // dropped into the queue at a chosen position; "" = extracted/uploaded/picked.
  source: string;
  resolvedSubject: string | null;
  variables: Record<string, string> | null;
  status: string;
  sentAt: string | null;
  error: string | null;
  createdAt: string;
};

type Variant = {
  id: string;
  subject: string;
  bodyHtml: string;
};

type DeliverabilityCheck = {
  id: string;
  status: "pending" | "delivered" | "failed";
  landedIn: string | null;
  error: string | null;
  checkedAt: string | null;
  createdAt: string;
};

type CampaignDetail = {
  id: string;
  name: string;
  status: string;
  searchJobId: string | null;
  createdAt: string;
  // Task 29, item 6 — per-batch deliverability checkpoint + rotation config,
  // surfaced so the paused-decision banner has context.
  batchSize: number;
  rotateEvery: number;
  subjects: string[] | null;
  bodies: string[] | null;
  // Human-assisted deliverability fallback — set, every check targets this
  // plain address instead of the platform seed mailbox (see lib/deliverability.ts).
  testRecipientOverride: string | null;
  variants: Variant[];
  checks: DeliverabilityCheck[];
  items: QueueItem[];
};

const PAGE_SIZE = 50;

// Plain-text-only preview — this is a clamped 2-line snippet, not a rendered
// email, so there's no value in rendering real HTML here (and doing so via
// dangerouslySetInnerHTML would execute any script/markup a campaign's bodyHtml
// happened to contain, a stored-XSS surface this page never had before).
function stripHtml(html: string): string {
  if (typeof document === "undefined") return html.replace(/<[^>]*>/g, " ");
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent ?? "";
}

const STATUS_BADGES: Record<string, string> = {
  pending_test_confirm: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300",
  sending: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400",
  done: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400",
  draft: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  // Task 29, item 6 — batch gate paused pending a deliverability decision.
  paused_deliverability: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  stopped: "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

const ITEM_STATUS_BADGES: Record<string, string> = {
  queued: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  sent: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400",
  failed: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400",
};

export default function CampaignDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const [campaign, setCampaign] = useState<CampaignDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [page, setPage] = useState(0);
  const [openErrorId, setOpenErrorId] = useState<string | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<{ outcome: string; error?: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [debating, setDebating] = useState(false);
  // Human-assisted deliverability fallback — offered after the platform seed
  // mailbox's automated check fails: pick an existing manual_insert recipient
  // already in the queue, or type a new one, to use as this campaign's test
  // target instead of Gmail from then on.
  const [testRecipientInput, setTestRecipientInput] = useState("");
  const [settingTestRecipient, setSettingTestRecipient] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/campaigns/${id}`);
      if (!res.ok) throw new Error("Failed to load campaign");
      setCampaign((await res.json()) as CampaignDetail);
      setTestResult(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load campaign");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function sendTest() {
    setTestBusy(true);
    setTestResult(null);
    try {
      const res = await fetch(`/api/campaigns/${id}/test-send`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { outcome?: string; error?: string };
      if (!res.ok) {
        setTestResult({ outcome: "failed", error: data.error ?? "Test-send failed" });
      } else {
        setTestResult({ outcome: data.outcome ?? "failed", error: data.error });
      }
      void load();
    } catch {
      setTestResult({ outcome: "failed", error: "Network error" });
    } finally {
      setTestBusy(false);
    }
  }

  async function confirm() {
    setConfirming(true);
    try {
      const res = await fetch(`/api/campaigns/${id}/confirm-test`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setTestResult({ outcome: "failed", error: data.error ?? "Couldn't confirm the test send." });
        return;
      }
      void load();
    } catch {
      setTestResult({ outcome: "failed", error: "Network error while confirming." });
    } finally {
      setConfirming(false);
    }
  }

  // Sets this campaign's human-assisted test-recipient override, then immediately
  // re-runs the test-send against it — the whole point of offering this after a
  // failure is to get a working result without a second manual click.
  async function useAsTestRecipient(email: string) {
    setSettingTestRecipient(true);
    try {
      const res = await fetch(`/api/campaigns/${id}/test-recipient`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setTestResult({ outcome: "failed", error: data.error ?? "Couldn't set the test recipient." });
        return;
      }
      setTestRecipientInput("");
      await load();
      await sendTest();
    } catch {
      setTestResult({ outcome: "failed", error: "Network error while setting the test recipient." });
    } finally {
      setSettingTestRecipient(false);
    }
  }

  // Resolves a pending deliverability decision — either a batch-gate pause
  // (status "paused_deliverability") or the initial test-send-confirm gate when
  // the automated check failed/couldn't verify (status "pending_test_confirm").
  // Same three actions, different meaning depending on which state the backend
  // finds the campaign in — see the route's own comment for the full breakdown.
  async function deliverabilityDecision(action: "continue" | "switch_subject" | "stop") {
    setDebating(true);
    try {
      const res = await fetch(`/api/campaigns/${id}/deliverability-decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) setTestResult({ outcome: "failed", error: data.error ?? "Couldn't apply that choice." });
      else void load();
    } catch {
      setTestResult({ outcome: "failed", error: "Network error while applying your choice." });
    } finally {
      setDebating(false);
    }
  }

  // The "it went to spam — try a different subject" path at the INITIAL gate:
  // rotate the subject (deliverabilityDecision leaves status untouched here),
  // then immediately re-run the test-send so the user isn't left staring at a
  // rotated subject with no fresh result.
  async function retryWithNextSubject() {
    await deliverabilityDecision("switch_subject");
    await sendTest();
  }

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
  const latestCheck = campaign.checks?.[0];
  const awaitingConfirm = campaign.status === "pending_test_confirm";

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
          {campaign.status.replace("_", " ")}
        </span>
      </div>

      {/* Test-send-confirm gate */}
      {awaitingConfirm && (
        <div className="mt-4 rounded-xl border border-violet-300 bg-violet-50 p-4 dark:border-violet-800 dark:bg-violet-950/20">
          <h2 className="text-sm font-semibold text-violet-800 dark:text-violet-300">Test-send before the real send</h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
            {campaign.testRecipientOverride ? (
              <>A real send is blocked until you confirm delivery yourself. Every test goes straight to your chosen
                test recipient (<span className="font-medium">{campaign.testRecipientOverride}</span>) — check your
                inbox, then unlock the campaign with an explicit click.</>
            ) : (
              <>A real send is blocked until we prove the connected SMTP actually delivers. Send one test message to
                the SpaceWorker seed mailbox, wait for the IMAP confirmation, then unlock the campaign with an explicit click.</>
            )}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void sendTest()}
              disabled={testBusy}
              className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              {testBusy ? "Sending test… checking for up to 2 minutes" : "Send test message"}
            </button>
            {/* In override mode, "delivered" only ever means the SMTP send
                succeeded — it's never a confirmed-good result the way a seed-
                mailbox "delivered" is, so this plain confirm button is hidden
                there in favor of the 3-way decision box below (which always
                shows for override mode and covers the same "go ahead" action
                alongside the spam/retry alternatives that button can't offer). */}
            {!campaign.testRecipientOverride && (testResult?.outcome === "delivered" || latestCheck?.status === "delivered") && (
              <button
                type="button"
                onClick={() => void confirm()}
                disabled={confirming}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
              >
                {confirming ? "Confirming…" : "Yes, delivered — confirm & start"}
              </button>
            )}
          </div>

          {latestCheck && (
            <p className="mt-2 text-sm">
              Latest check: <span className={`font-medium ${latestCheck.status === "delivered" ? "text-emerald-600" : "text-red-600"}`}>{latestCheck.status}</span>
              {latestCheck.landedIn ? (
                <span className="text-zinc-500">
                  {" — landed in "}
                  <span className={`font-medium ${latestCheck.landedIn === "inbox" ? "text-emerald-600" : "text-amber-600"}`}>{latestCheck.landedIn}</span>
                </span>
              ) : null}
              {latestCheck.error ? <span className="text-zinc-500"> — {latestCheck.error}</span> : null}
              {latestCheck.checkedAt ? <span className="text-zinc-400"> ({new Date(latestCheck.checkedAt).toLocaleString()})</span> : null}
            </p>
          )}

          {/* Ask the human what actually happened, rather than only offering a
              blind retry or a single "confirm" button. Mirrors the batch-gate's
              own continue/switch/stop framing, reworded for "nothing has sent
              yet" (no "stop" here — there's nothing running to halt). Shown
              whenever the automated check failed/couldn't verify (the seed-
              mailbox path), OR whenever a test-recipient override is in play —
              there, "delivered" only ever means the SMTP send succeeded, never
              a confirmed-good result, so the human must always be asked. */}
          {(latestCheck?.status === "failed" || (!!campaign.testRecipientOverride && !!latestCheck)) && (
            <div className="mt-3 rounded-lg border border-zinc-300 bg-white p-3 dark:border-zinc-700 dark:bg-zinc-950">
              <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                What actually happened to the test message?
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void deliverabilityDecision("continue")}
                  disabled={debating || testBusy}
                  className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                >
                  {debating ? "Applying…" : "It's in the inbox — go ahead"}
                </button>
                <button
                  type="button"
                  onClick={() => void retryWithNextSubject()}
                  disabled={debating || testBusy}
                  className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500 disabled:opacity-50"
                >
                  {debating || testBusy ? "Working…" : "It went to spam — try a different subject"}
                </button>
                <button
                  type="button"
                  onClick={() => void sendTest()}
                  disabled={debating || testBusy}
                  className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-black/5 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-white/5"
                >
                  Didn't receive it — try again
                </button>
              </div>
              <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                "It's in the inbox" records your manual confirmation and unlocks sending immediately. "Try a different
                subject" rotates to the next subject (if you have more than one) and re-tests.
              </p>
            </div>
          )}

          {/* Human-assisted fallback, offered after the automated check fails and
              no override is set yet: use a recipient already in the queue, or
              type a new one, as this campaign's test target from now on. */}
          {latestCheck?.status === "failed" && !campaign.testRecipientOverride && (() => {
            const existingTestRecipient = campaign.items.find((i) => i.source === "manual_insert")?.toEmail;
            return (
              <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/20">
                <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                  The automated check failed — want to test against a real inbox instead?
                </p>
                {existingTestRecipient ? (
                  <button
                    type="button"
                    onClick={() => void useAsTestRecipient(existingTestRecipient)}
                    disabled={settingTestRecipient || testBusy}
                    className="mt-2 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500 disabled:opacity-50"
                  >
                    {settingTestRecipient ? "Setting…" : `Use ${existingTestRecipient} as my test recipient`}
                  </button>
                ) : (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <input
                      type="email"
                      value={testRecipientInput}
                      onChange={(e) => setTestRecipientInput(e.target.value)}
                      placeholder="you@example.com"
                      className="w-56 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-amber-500 dark:border-amber-800 dark:bg-zinc-950"
                    />
                    <button
                      type="button"
                      onClick={() => testRecipientInput.trim() && void useAsTestRecipient(testRecipientInput.trim())}
                      disabled={settingTestRecipient || testBusy || !testRecipientInput.trim()}
                      className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500 disabled:opacity-50"
                    >
                      {settingTestRecipient ? "Setting…" : "Use this as my test recipient"}
                    </button>
                  </div>
                )}
                <p className="mt-1.5 text-xs text-amber-700/80 dark:text-amber-400/70">
                  Every test (and later batch check) will go straight there — you'll check your own inbox and confirm
                  delivery yourself, since there's no automated way to verify a plain address.
                </p>
              </div>
            );
          })()}
        </div>
      )}

      {/* Task 29, item 6 — the batch gate (mail-queue drain) paused this campaign
          after a batch because the probe message's placement couldn't be verified as
          a clean inbox landing (it landed in spam, or placement was undetectable).
          Let the owner decide: continue anyway, rotate to the next subject & resume,
          or stop outright. Wired to deliverabilityDecision()/debating state. */}
      {campaign.status === "paused_deliverability" && (
        <div className="mt-4 rounded-xl border border-red-300 bg-red-50 p-4 dark:border-red-900/60 dark:bg-red-900/20">
          <h2 className="text-sm font-semibold text-red-700 dark:text-red-300">Deliverability check needs your input</h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
            This campaign paused after a batch because the probe message could not be confirmed in the inbox
            — it may have landed in spam, or we could not verify its placement automatically. Check your test
            mailbox, then decide how to proceed.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void deliverabilityDecision("continue")}
              disabled={debating}
              className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              {debating ? "Applying…" : "Continue anyway"}
            </button>
            <button
              type="button"
              onClick={() => void deliverabilityDecision("switch_subject")}
              disabled={debating}
              className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-amber-400 disabled:opacity-50"
            >
              {debating ? "Applying…" : "Switch subject & resume"}
            </button>
            <button
              type="button"
              onClick={() => void deliverabilityDecision("stop")}
              disabled={debating}
              className="rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-900/50 dark:text-red-400 dark:hover:bg-red-950/40"
            >
              {debating ? "Applying…" : "Stop"}
            </button>
          </div>
        </div>
      )}
{/* Variants */}
      <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Subject / body variants <span className="text-zinc-400">({campaign.variants.length})</span>
        </h2>
        {/* Task 29, item 6 — rotation + per-batch deliverability checkpoint config,
            shown together so the owner sees how the drain paces this campaign. */}
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Rotate every {campaign.rotateEvery} recipient(s) · Batch size {campaign.batchSize} per deliverability check
        </p>
        {campaign.variants.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-400 dark:text-zinc-500">No variants on this legacy campaign.</p>
        ) : (
          <div className="mt-2 flex flex-col gap-2">
            {campaign.variants.map((v) => (
              <div key={v.id} className="rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800">
                <p className="text-sm font-medium">{v.subject}</p>
                <p className="mt-0.5 line-clamp-2 text-xs text-zinc-500 dark:text-zinc-400">
                  {stripHtml(v.bodyHtml)}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Queue items */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              <th className="px-4 py-3 font-medium">Recipient</th>
              <th className="px-4 py-3 font-medium">Mailbox</th>
              <th className="px-4 py-3 font-medium">Variant subject</th>
              <th className="px-4 py-3 font-medium">Merge vars</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Sent at</th>
              <th className="px-4 py-3 font-medium">Error</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {pageItems.map((item) => (
              <Fragment key={item.id}>
                <tr>
                  <td className="px-4 py-3">
                    {item.source === "manual_insert" ? (
                      <span className="flex items-center gap-1.5">
                        <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-700 dark:bg-violet-900/40 dark:text-violet-300" title="Ad-hoc test recipient">Test</span>
                        <span className="text-violet-700 dark:text-violet-300">{item.toEmail}</span>
                      </span>
                    ) : (
                      item.toEmail
                    )}
                    {item.resolvedSubject ? (
                      <div className="mt-0.5 text-[11px] text-zinc-400 dark:text-zinc-500">Subject: {item.resolvedSubject}</div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">{item.mailbox?.label ?? "—"}</td>
                  <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">{item.variant?.subject ?? "—"}</td>
                  <td className="px-4 py-3 text-zinc-500 max-w-[220px] truncate dark:text-zinc-400">
                    {item.variables && Object.keys(item.variables).length > 0
                      ? Object.entries(item.variables).map(([k, v]) => `${k}=${v}`).join(", ")
                      : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${
                      ITEM_STATUS_BADGES[item.status] ?? "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                    }`}>
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
                    <td colSpan={7} className="px-4 py-3">
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
          <span className="text-zinc-500 dark:text-zinc-400">Page {page + 1} of {totalPages}</span>
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