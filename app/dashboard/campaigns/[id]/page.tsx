"use client";
import { Fragment, useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

import { Modal } from "@/components/modal";
// Task 30, item 1 — renderMerge is pure (no server-only deps), so previewing a
// queued item's EXACT resolvedSubject/resolvedBodyHtml with its own variables is
// safe to do right here client-side.
import { renderMerge } from "@/lib/render-merge";

type QueueItem = {
  id: string;
  campaignId: string;
  mailboxId: string;
  mailbox?: { id: string; label: string; username: string } | null;
  variantId: string | null;
  variant?: { id: string; subject: string; bodyHtml: string } | null;
  toEmail: string;
  // Task 29, item 3 — provenance. "manual_insert" = a test recipient the user
  // dropped into the queue at a chosen position; "" = extracted/uploaded/picked.
  source: string;
  resolvedSubject: string | null;
  resolvedBodyHtml: string | null;
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

// Task 33 — a single isolation-diagnostic probe: which element (subject, body,
// or From) a given probe changed, the EXACT content it was tested as (variant +
// from), whether it was even runnable, and — once run — where it landed.
type ProbeResult = {
  key: string;
  label: string;
  description: string;
  variant: { subject: string; bodyHtml: string };
  from: string | null;
  available: boolean;
  unavailableReason?: string;
  outcome: string | null;
  landedIn: string | null;
  error?: string;
};

// Task 35 — the lightweight live-sending payload. A single recent-sends poll
// serves the ticker (items only) AND the activity modal (items + aggregates).
type RecentSend = { id: string; toEmail: string; status: string; sentAt: string | null; error?: string | null };
type LiveStats = {
  counts: { recipients: number; sent: number; queued: number; failed: number };
  byMailbox: Record<string, { sent: number; failed: number }>;
};

// TASK_150 T4 — what GET /api/campaigns/[id]/mailboxes?remove=<id> returns: how
// many still-queued items the removal would move, and onto which remaining
// mailboxes. Deliberately DB-authoritative (not derived from the loaded page's
// items) so the confirmation the user sees is exactly what the transaction does.
type MailboxRemovalPreview = {
  campaignId: string;
  removeMailboxId: string;
  removeLabel: string;
  queuedCount: number;
  targets: { mailboxId: string; label: string; username: string; count: number }[];
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
  // Task 35 — configurable send pacing bounds (seconds) between sends.
  minSendDelaySeconds: number;
  maxSendDelaySeconds: number;
  subjects: string[] | null;
  bodies: string[] | null;
  // Human-assisted deliverability fallback — set, every check targets this
  // plain address instead of the platform seed mailbox (see lib/deliverability.ts).
  testRecipientOverride: string | null;
  // 2026-09-28 — the test-flow settings: the shortlist of addresses the user is
  // willing to test against (so switching the test target mid-flow is one click),
  // and the From address every TEST send uses (the "is the From what's causing
  // spam?" lever). Neither is ever read by a real send.
  testRecipientPool: string[];
  testFromOverride: string | null;
  // Task 144 — "html" (default) sends the body as HTML plus a derived plaintext
  // alternative; "text" sends a plain-text-ONLY message (no HTML part at all).
  // A CAMPAIGN-level field, not a test-only one: a test that sends a different
  // shape from the real send cannot predict the real send.
  bodyFormat: string | null;
  // Task 33 — a temporary pinned-override window active on this campaign:
  // { subject, bodyHtml, fromAddress, remaining }. While set, the drain sends
  // every recipient this exact content instead of rotating, and decrements
  // `remaining` per send. null = not pinned.
  pinnedOverride: { subject: string; bodyHtml: string; fromAddress: string; remaining: number } | null;
  variants: Variant[];
  checks: DeliverabilityCheck[];
  items: QueueItem[];
  // Task 32 — the campaign's configured sending mailboxes + their Task 30 item 4
  // From addresses, for pre-filling the "manually edit and test" From select.
  mailboxes: { id: string; label: string; username: string; fromAddresses: string[] }[];
};

const PAGE_SIZE = 50;

// Plain-text-only preview — this is a clamped 2-line snippet, not a rendered
// email, so there's no value in rendering real HTML here (and doing so via
// dangerouslySetInnerHTML would execute any script/markup a campaign's bodyHtml
// happened to contain, a stored-XSS surface this page never had before).
// First ~80 chars of the plain-text body, for a quick "what's actually being
// sent" glance in the queue table — replaces the old raw "merge vars" column,
// which showed internal field names/values that weren't meaningful to a user
// (especially once leads come from an upload, not extraction) instead of
// anything about the message itself.
function bodyPreview(html: string): string {
  const text = stripHtml(html).replace(/\s+/g, " ").trim();
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function stripHtml(html: string): string {
  if (typeof document === "undefined") return html.replace(/<[^>]*>/g, " ");
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent ?? "";
}

// Task 30, item 1 — render a real email body inside a SANDBOXED iframe via srcDoc
// (never dangerouslySetInnerHTML directly), so a body's scripts/markup can never
// execute — the same XSS-avoidance stance as stripHtml above. The user sees the
// body exactly as a mail client would render it, not raw markup.
function emailSrcDoc(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>` +
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937;line-height:1.5;background:#fff;padding:20px;max-width:640px">${html}</div>` +
    `</body></html>`;
}

// Task 30, item 1 — resolve the content a given queue item actually carries:
// decoupled items carry resolvedSubject/resolvedBodyHtml snapshots; legacy items
// fall back to their CampaignVariant row.
function itemSubject(item: QueueItem): string {
  return item.resolvedSubject ?? item.variant?.subject ?? "";
}
function itemBody(item: QueueItem): string {
  return item.resolvedBodyHtml ?? item.variant?.bodyHtml ?? "";
}

const STATUS_BADGES: Record<string, string> = {
  pending_test_confirm: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300",
  sending: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400",
  done: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400",
  draft: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  // Task 29, item 6 — batch gate paused pending a deliverability decision.
  paused_deliverability: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  // A plain manual pause (the owner clicked "Pause") — distinct from the
  // automated deliverability gate above, and resumable (unlike "stopped").
  paused_manual: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
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
  // Task 30, item 1 — a specific queue item opened in the preview modal, rendered
  // with that item's REAL variables (the exact message that recipient receives).
  const [previewItem, setPreviewItem] = useState<QueueItem | null>(null);
  // Task 30, item 2 — compact "what's been sent so far" overview modal (no
  // scrolling thousands of queue rows).
  const [activityOpen, setActivityOpen] = useState(false);
  // Task 35 — live sending UI. While status === "sending" a single lightweight
  // poll (GET /api/campaigns/[id]/recent-sends) feeds BOTH the always-visible
  // ticker and the open activity modal (never two fetches). liveFeed holds the
  // newest send attempts (newest-first), liveStats the aggregate counts +
  // per-mailbox breakdown; both stay null for the "no poll yet" baseline, when
  // the modal falls back to its loaded campaign.items snapshot.
  const [liveFeed, setLiveFeed] = useState<RecentSend[]>([]);
  const [liveStats, setLiveStats] = useState<LiveStats | null>(null);
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
  // 2026-09-28 — the test-setup panel, open for the whole testing phase rather
  // than only appearing reactively after a failure. It owns the two things a
  // person actually changes while triaging: WHICH inbox the test lands in
  // (testTarget, switched between sends) and WHAT From it goes out as
  // (testFromInput, the spam-trigger lever). Both are test-only and can never
  // affect the real send — see the test-recipient route.
  const [testSetupOpen, setTestSetupOpen] = useState(false);
  const [testTargetBusy, setTestTargetBusy] = useState(false);
  const [newTestTarget, setNewTestTarget] = useState("");
  const [testFromInput, setTestFromInput] = useState("");
  const [bodyFormatBusy, setBodyFormatBusy] = useState(false);
  const [bodyFormatError, setBodyFormatError] = useState("");
  // Task 32 — "Manually edit and test": a 4th, clearly-secondary path in the
  // decision box. The user drafts a subject/body (and optional From) tweak,
  // live-tests it via the extended test-send route WITHOUT touching stored
  // content, then promotes it onto the front of the rotation only if — and after —
  // they judge a real test result good by eye.
  const [editOpen, setEditOpen] = useState(false);
  const [editSubject, setEditSubject] = useState("");
  const [editBody, setEditBody] = useState("");
  const [editFrom, setEditFrom] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  // True once a live draft test-send comes back — the promote option is only
  // offered after that result, so promotion is always a judged outcome.
  const [draftTested, setDraftTested] = useState(false);
  // Task 33 — "Run diagnostics": the 4-probe isolation ladder. Probe definitions
  // arrive from the run-diagnostics route (GET); each probe's own Run button
  // posts just that key and stores its landedIn outcome for a checklist badge.
  // A green (inbox) probe opens the "Pin this combination for the next N sends"
  // action — a temporary window that suspends rotation, distinct from promote.
  const [diagOpen, setDiagOpen] = useState(false);
  const [diagProbes, setDiagProbes] = useState<ProbeResult[] | null>(null);
  const [diagResults, setDiagResults] = useState<Record<string, ProbeResult>>({});
  const [diagBusyKey, setDiagBusyKey] = useState<string | null>(null);
  const [pinCount, setPinCount] = useState(50);
  const [pinning, setPinning] = useState(false);
  // TASK_150 T4 — "Sending mailboxes": take a mailbox out of a campaign that is
  // actively sending. Queue items are pinned to a mailbox at creation time, so a
  // removal has to reassign the removed mailbox's queued items onto the rest —
  // the preview below is what shows the user the blast radius before it happens.
  const [mailboxesOpen, setMailboxesOpen] = useState(false);
  const [mailboxRemoval, setMailboxRemoval] = useState<MailboxRemovalPreview | null>(null);
  const [mailboxPreviewBusyId, setMailboxPreviewBusyId] = useState<string | null>(null);
  const [mailboxApplyBusy, setMailboxApplyBusy] = useState(false);
  const [mailboxError, setMailboxError] = useState("");

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

  // Task 34 — merge a small, targeted update into the already-loaded campaign
  // state instead of re-fetching the whole campaign (which re-pulls every queued
  // item and re-renders the whole page). Only the fields that actually changed
  // are touched; `items`/pagination are left completely alone — no test-time
  // action ever changes the queue. Declared here (above the live-sending poll
  // below) since that effect now depends on it.
  const patchCampaign = useCallback((partial: Partial<CampaignDetail>) => {
    setCampaign((prev) => (prev ? { ...prev, ...partial } : prev));
  }, []);

  // Task 144 — re-pull ONLY the queue rows (and leave `loading`/`testResult`
  // untouched, both of which `load()` resets — clearing them here would yank a
  // test result out from under a user who is still reading it).
  //
  // Why this is needed at all: `patchCampaign` above documents that it never
  // touches `items` — true for the TEST-TIME actions it was written for, none of
  // which change the queue. But the live-sending poll below also uses it, and
  // sending is exactly the thing that DOES change every item's status. So the
  // queue table used to keep showing "queued" for rows the drain had already
  // sent, until the user manually reloaded the page. Confirmed live 2026-09-29:
  // campaign "blasting2" sat showing three "Queued" rows while the database had
  // all three at status "sent" with real sentAt timestamps.
  const reloadItems = useCallback(async () => {
    if (!id) return;
    try {
      const res = await fetch(`/api/campaigns/${id}`);
      if (!res.ok) return;
      const fresh = (await res.json()) as CampaignDetail;
      // Replace the whole array rather than merging: the server is the source of
      // truth for order + pagination, and this runs once, after sending ends.
      setCampaign((prev) => (prev ? { ...prev, items: fresh.items } : prev));
    } catch {
      // Transient network error — the row states are no worse than before.
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Task 35 — shared live-sending poll. While the campaign is actually sending,
  // re-pull the lightweight recent-sends payload every few seconds; this single
  // poll drives BOTH the always-visible ticker and the open activity modal.
  // Stops (and cancels the pending fetch) the moment status leaves "sending" —
  // done/paused/stopped — via the cleanup that runs when campaign.status changes.
  useEffect(() => {
    if (!id || campaign?.status !== "sending") return;
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch(`/api/campaigns/${id}/recent-sends?limit=5`);
        if (!res.ok) return;
        const data = (await res.json().catch(() => ({}))) as {
          items?: RecentSend[];
          counts?: LiveStats["counts"];
          byMailbox?: LiveStats["byMailbox"];
          status?: string;
        };
        if (cancelled) return;
        if (Array.isArray(data.items)) {
          setLiveFeed(data.items);
          // Task 144 — fold these per-item statuses into the queue table. The
          // poll's payload is {id, toEmail, status, sentAt, error}, which is
          // exactly what each row renders, so no extra fetch is needed; the
          // 4s cadence outpaces the drain's 5-45s send jitter, so a row can't
          // realistically be sent and missed. Merging by id also leaves the
          // array's order (and therefore pagination) untouched.
          const updates = data.items;
          setCampaign((prev) => {
            if (!prev) return prev;
            const byId = new Map(updates.map((u) => [u.id, u]));
            let changed = false;
            const items = prev.items.map((it) => {
              const u = byId.get(it.id);
              if (!u) return it;
              const status = u.status || it.status;
              const sentAt = u.sentAt ?? it.sentAt;
              const error = u.error ?? it.error;
              if (status === it.status && sentAt === it.sentAt && error === it.error) return it;
              changed = true;
              return { ...it, status, sentAt, error };
            });
            return changed ? { ...prev, items } : prev;
          });
        }
        if (data.counts) setLiveStats({ counts: data.counts, byMailbox: data.byMailbox ?? {} });
        // The poll only ever ran because status WAS "sending" a moment ago
        // (the effect's own guard below) — if the backend has since moved it
        // to "done"/paused/stopped, reflect that immediately instead of
        // leaving the page showing "sending" until the user manually
        // reloads. This also naturally stops the interval: the effect
        // re-runs on the next render (campaign?.status is a dependency) and
        // its own `!== "sending"` guard returns early.
        if (data.status && data.status !== campaign?.status) {
          patchCampaign({ status: data.status });
          // Task 144 — this is the LAST tick this poll ever runs, and its
          // 5-item window cannot cover every row that just changed (a 500-item
          // batch finishes in one go from this component's point of view).
          // Without this refresh, any row the window missed would keep its
          // stale "queued" badge permanently, since nothing re-fetches items
          // after sending ends.
          void reloadItems();
        }
      } catch {
        // Transient network error — keep the last-good feed rather than clearing it.
      }
    }
    void poll();
    const timer = setInterval(poll, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // patchCampaign is declared later in this component but has a stable
    // identity (empty deps array of its own) — safe to depend on here even
    // though it's a forward reference; it never changes, so it can never
    // cause this effect to needlessly re-run/restart the interval.
    // `reloadItems` is likewise stable ([id] only) and is what settles the
    // queue rows when sending finishes — see its note above.
  }, [id, campaign?.status, patchCampaign, reloadItems]);

  // Prepend a freshly-created DeliverabilityCheck (test-send / draft test-send)
  // so the top test-send box's "latest check" line redraws without a refetch.
  const prependCheck = useCallback((check: DeliverabilityCheck) => {
    setCampaign((prev) => (prev ? { ...prev, checks: [check, ...prev.checks] } : prev));
  }, []);

  // 2026-09-28 — `overrides` lets the test-setup panel send ONE test to a
  // specific address/From without a second round-trip and without changing any
  // stored setting: `to` switches which inbox this single test lands in (so the
  // user can fire the same content at their Gmail, then their Outlook, then their
  // work address and compare), and `from` pins the From for this one send (the
  // quickest way to answer "is it the From address triggering spam?"). Both are
  // passed straight through to the test-send route, which applies them for this
  // request only. Omitting them reproduces the previous behaviour exactly.
  async function sendTest(overrides?: { to?: string; from?: string }) {
    setTestBusy(true);
    setTestResult(null);
    try {
      const res = await fetch(`/api/campaigns/${id}/test-send`, {
        method: "POST",
        ...(overrides && (overrides.to || overrides.from)
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...(overrides.to ? { to: overrides.to } : {}), ...(overrides.from ? { from: overrides.from } : {}) }),
            }
          : {}),
      });
      const data = (await res.json().catch(() => ({}))) as { outcome?: string; error?: string; check?: DeliverabilityCheck };
      if (!res.ok) {
        setTestResult({ outcome: "failed", error: data.error ?? "Test-send failed" });
      } else {
        setTestResult({ outcome: data.outcome ?? "failed", error: data.error });
        // Task 34 — merge just the new check into state; no full campaign re-fetch.
        if (data.check) prependCheck(data.check);
      }
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
      const data = (await res.json().catch(() => ({}))) as { error?: string; status?: string };
      if (!res.ok) {
        setTestResult({ outcome: "failed", error: data.error ?? "Couldn't confirm the test send." });
        return;
      }
      // Task 34 — only status changes (pending_test_confirm → sending); merge it.
      patchCampaign({ status: data.status ?? "sending" });
    } catch {
      setTestResult({ outcome: "failed", error: "Network error while confirming." });
    } finally {
      setConfirming(false);
    }
  }

  // Task 144 — flip this campaign between HTML and plain-text-only.
  //
  // Deliberately the ONLY place the format is set on an existing campaign: the
  // value decides the shape of every future real send, so it is a saved campaign
  // property (the toast below says which), not a throwaway test switch. The
  // server rejects anything but "html"/"text" rather than defaulting silently,
  // so an error here means nothing was written — never a half-applied change.
  async function saveBodyFormat(next: "html" | "text") {
    if (!id || bodyFormatBusy) return;
    setBodyFormatBusy(true);
    setBodyFormatError("");
    try {
      const res = await fetch(`/api/campaigns/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bodyFormat: next }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; bodyFormat?: string };
      if (!res.ok) {
        setBodyFormatError(data.error ?? "Couldn't change the body format.");
        return;
      }
      patchCampaign({ bodyFormat: data.bodyFormat ?? next });
    } catch {
      setBodyFormatError("Network error while changing the body format.");
    } finally {
      setBodyFormatBusy(false);
    }
  }

  // Sets this campaign's human-assisted test-recipient override, then immediately
  // re-runs the test-send against it — the whole point of offering this after a
  // failure is to get a working result without a second manual click.
  // 2026-09-28 — the route now also returns the (auto-extended) pool and the
  // test-only From, so both are merged here too; anything it didn't return is
  // left exactly as it was rather than being clobbered with undefined.
  async function applyTestRecipient(email: string) {
    setSettingTestRecipient(true);
    try {
      const res = await fetch(`/api/campaigns/${id}/test-recipient`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        testRecipientOverride?: string | null;
        testRecipientPool?: string[];
        testFromOverride?: string | null;
      };
      if (!res.ok) {
        setTestResult({ outcome: "failed", error: data.error ?? "Couldn't set the test recipient." });
        return;
      }
      setTestRecipientInput("");
      // Task 34 — merge just the override field locally; sendTest() merges its check.
      patchCampaign({
        testRecipientOverride: data.testRecipientOverride ?? null,
        ...(data.testRecipientPool ? { testRecipientPool: data.testRecipientPool } : {}),
      });
      await sendTest();
    } catch {
      setTestResult({ outcome: "failed", error: "Network error while setting the test recipient." });
    } finally {
      setSettingTestRecipient(false);
    }
  }

  // 2026-09-28 — one POST that owns all three test-flow settings, then ONE test
  // against the resulting target. Used by the test-setup panel for every action
  // it offers: switching which saved address is active, adding a new address,
  // removing one, switching back to the automated seed mailbox, and pinning or
  // clearing the test-only From.
  //
  // `patch` mirrors the route's body. `sendTo`/`sendFrom` are optional one-shot
  // values for the test fired afterwards (so "test as this new From, right now"
  // needs a single call, and the chosen From is also persisted for next time via
  // `patch.from` when the caller wants that). Anything the route returns is
  // merged into local state — never a full campaign re-fetch.
  async function saveTestSetup(patch: {
    email?: string | null;
    pool?: string[];
    from?: string | null;
    sendTo?: string;
    sendFrom?: string;
    thenTest?: boolean;
  }) {
    setTestTargetBusy(true);
    setTestResult(null);
    try {
      const body: Record<string, unknown> = {};
      if ("email" in patch) body.email = patch.email;
      if ("pool" in patch) body.pool = patch.pool;
      if ("from" in patch) body.from = patch.from;
      if (Object.keys(body).length > 0) {
        const res = await fetch(`/api/campaigns/${id}/test-recipient`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          testRecipientOverride?: string | null;
          testRecipientPool?: string[];
          testFromOverride?: string | null;
        };
        if (!res.ok) {
          setTestResult({ outcome: "failed", error: data.error ?? "Couldn't save the test setup." });
          return;
        }
        patchCampaign({
          ...("testRecipientOverride" in data ? { testRecipientOverride: data.testRecipientOverride ?? null } : {}),
          ...(data.testRecipientPool ? { testRecipientPool: data.testRecipientPool } : {}),
          ...("testFromOverride" in data ? { testFromOverride: data.testFromOverride ?? null } : {}),
        });
      }
      setNewTestTarget("");
      if (patch.thenTest) {
        await sendTest({
          ...(patch.sendTo ? { to: patch.sendTo } : {}),
          ...(patch.sendFrom ? { from: patch.sendFrom } : {}),
        });
      }
    } catch {
      setTestResult({ outcome: "failed", error: "Network error while saving the test setup." });
    } finally {
      setTestTargetBusy(false);
    }
  }

  // Task 34 — the inverse of applyTestRecipient: switch back from a personal
  // test recipient to the platform's automated seed-mailbox path. POSTs the
  // SAME test-recipient route with { email: null }, which clears
  // testRecipientOverride back to null and makes resolveSeedMailbox() fall back
  // to the platform default automatically (the backend already supported this —
  // this just surfaces it as a one-click action instead of requiring the user to
  // know to clear it). Merges the returned override null locally; no re-fetch.
  async function revertTestRecipient() {
    setSettingTestRecipient(true);
    setTestResult(null);
    try {
      const res = await fetch(`/api/campaigns/${id}/test-recipient`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: null }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        testRecipientOverride?: string | null;
        testRecipientPool?: string[];
      };
      if (!res.ok) {
        setTestResult({ outcome: "failed", error: data.error ?? "Couldn't switch back to automated testing." });
        return;
      }
      patchCampaign({
        testRecipientOverride: data.testRecipientOverride ?? null,
        ...(data.testRecipientPool ? { testRecipientPool: data.testRecipientPool } : {}),
      });
    } catch {
      setTestResult({ outcome: "failed", error: "Network error while switching back to automated testing." });
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
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        status?: string;
        subjects?: string[];
        bodies?: string[];
        pinnedOverride?: CampaignDetail["pinnedOverride"];
      };
      if (!res.ok) {
        setTestResult({ outcome: "failed", error: data.error ?? "Couldn't apply that choice." });
      } else {
        // Task 34 — merge only the fields this decision actually changed, locally.
        const partial: Partial<CampaignDetail> = {};
        if (data.status) partial.status = data.status;
        if (data.subjects) partial.subjects = data.subjects;
        if (data.bodies) partial.bodies = data.bodies;
        if (data.pinnedOverride) partial.pinnedOverride = data.pinnedOverride;
        patchCampaign(partial);
      }
    } catch {
      setTestResult({ outcome: "failed", error: "Network error while applying your choice." });
    } finally {
      setDebating(false);
    }
  }

  // Plain manual pause/resume — distinct from the deliverability gate above.
  // Pausing while "sending" always succeeds (halting is always safe, same as
  // "stop"); resuming re-enters the same trial-tier daily-allowance gate every
  // other "sending" entry point uses, so a 429 here is a real, expected outcome
  // (not a bug) when the daily mailer cap is already used up.
  const [pauseResumeBusy, setPauseResumeBusy] = useState(false);
  async function pauseCampaign() {
    setPauseResumeBusy(true);
    try {
      const res = await fetch(`/api/campaigns/${id}/pause`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string; status?: string };
      if (!res.ok) {
        setTestResult({ outcome: "failed", error: data.error ?? "Couldn't pause the campaign." });
      } else if (data.status) {
        patchCampaign({ status: data.status });
      }
    } catch {
      setTestResult({ outcome: "failed", error: "Network error while pausing." });
    } finally {
      setPauseResumeBusy(false);
    }
  }
  async function resumeCampaign() {
    setPauseResumeBusy(true);
    try {
      const res = await fetch(`/api/campaigns/${id}/resume`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string; status?: string };
      if (!res.ok) {
        setTestResult({ outcome: "failed", error: data.error ?? "Couldn't resume the campaign." });
      } else if (data.status) {
        patchCampaign({ status: data.status });
      }
    } catch {
      setTestResult({ outcome: "failed", error: "Network error while resuming." });
    } finally {
      setPauseResumeBusy(false);
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

  // Task 32 — open the "manually edit and test" surface, pre-filling the draft from
  // whatever the LAST test-send actually used: subjects[0]/bodies[0] for a decoupled
  // campaign, or variants[0] for a legacy pair campaign (index 0 is always what
  // test-send and the batch probe use today). Pre-fill From with the first offered
  // address (see fromOptions below).
  function openEdit() {
    setEditSubject(campaign?.subjects?.[0] ?? campaign?.variants?.[0]?.subject ?? "");
    setEditBody(campaign?.bodies?.[0] ?? campaign?.variants?.[0]?.bodyHtml ?? "");
    setEditFrom(fromOptions[0] ?? "");
    setDraftTested(false);
    setEditOpen(true);
  }

  // Task 32 — fire a REAL test with the draft content without persisting anything:
  // the extended test-send route builds the probe from { subject, bodyHtml, from }
  // instead of the stored campaign content. The campaign's stored subjects/bodies
  // stay untouched until the user explicitly promotes (see promoteEdit).
  async function sendDraftTest() {
    setEditBusy(true);
    setTestResult(null);
    try {
      const res = await fetch(`/api/campaigns/${id}/test-send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: editSubject,
          bodyHtml: editBody,
          ...(editFrom ? { from: editFrom } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { outcome?: string; error?: string; check?: DeliverabilityCheck };
      if (!res.ok) {
        setTestResult({ outcome: "failed", error: data.error ?? "Draft test-send failed" });
      } else {
        setTestResult({ outcome: data.outcome ?? "failed", error: data.error });
        setDraftTested(true);
        // Task 34 — merge just the new check; no full campaign re-fetch.
        if (data.check) prependCheck(data.check);
      }
    } catch {
      setTestResult({ outcome: "failed", error: "Network error while sending the edited test." });
    } finally {
      setEditBusy(false);
    }
  }

  // Task 32 — the human judged the draft test good by eye; promote it onto the
  // FRONT of the campaign's subject/body rotation via the deliverability-decision
  // route's new "add_edit_and_continue" action (which also resumes/ unlocks sending,
  // exactly like "continue"). Only offered after a live draft test came back.
  async function promoteEdit() {
    setDebating(true);
    try {
      const res = await fetch(`/api/campaigns/${id}/deliverability-decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add_edit_and_continue",
          subject: editSubject,
          bodyHtml: editBody,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        status?: string;
        subjects?: string[];
        bodies?: string[];
      };
      if (!res.ok) {
        setTestResult({ outcome: "failed", error: data.error ?? "Couldn't promote the edited version." });
      } else {
        setEditOpen(false);
        setDraftTested(false);
        // Task 34 — merge the newly-promoted rotation + status locally.
        const partial: Partial<CampaignDetail> = {};
        if (data.status) partial.status = data.status;
        if (data.subjects) partial.subjects = data.subjects;
        if (data.bodies) partial.bodies = data.bodies;
        patchCampaign(partial);
      }
    } catch {
      setTestResult({ outcome: "failed", error: "Network error while promoting the edit." });
    } finally {
      setDebating(false);
    }
  }

  // Task 33 — open the diagnostics panel, pulling the 4 probe definitions from
  // the run-diagnostics route's GET (the probe builder lives server-side in
  // lib/deliverability.ts, which is server-only, so the client asks the API for
  // the same definitions the POST will run rather than re-deriving them).
  async function openDiagnostics() {
    if (diagProbes) {
      setDiagOpen(true);
      return;
    }
    try {
      const res = await fetch(`/api/campaigns/${id}/run-diagnostics`);
      const data = (await res.json().catch(() => ({}))) as { probes?: ProbeResult[]; error?: string };
      if (!res.ok || !data.probes) {
        setTestResult({ outcome: "failed", error: data.error ?? "Couldn't load the diagnostics probes." });
        return;
      }
      setDiagProbes(data.probes);
      setPinCount(campaign?.batchSize ?? 50);
      setDiagOpen(true);
    } catch {
      setTestResult({ outcome: "failed", error: "Network error while loading diagnostics." });
    }
  }

  // Task 33 — run ONE isolation probe through the run-diagnostics route (which
  // itself runs it through the SAME runTestSend primitive as test-send, writing
  // its own DeliverabilityCheck audit row). Stores the landedIn outcome so the
  // panel reads as a checklist. Nothing here touches the campaign's stored content.
  async function runProbe(key: string) {
    setDiagBusyKey(key);
    setTestResult(null);
    try {
      const res = await fetch(`/api/campaigns/${id}/run-diagnostics`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys: [key] }),
      });
      const data = (await res.json().catch(() => ({}))) as { results?: ProbeResult[]; error?: string };
      if (!res.ok || !data.results || data.results.length === 0) {
        setTestResult({ outcome: "failed", error: data.error ?? "Probe failed to run." });
      } else {
        for (const r of data.results) {
          const next = { ...diagResults, [r.key]: r };
          setDiagResults(next);
          if (r.outcome === "delivered") {
            setTestResult(null);
          } else {
            setTestResult({ outcome: r.outcome ?? "failed", error: r.error });
          }
        }
      }
      // Task 34 — the diagnostics panel already re-rendered from diagResults /
      // testResult above; the probe writes no campaign field the page re-reads
      // from the loaded campaign, so there's nothing to merge and no re-fetch.
    } catch {
      setTestResult({ outcome: "failed", error: "Network error while running the probe." });
    } finally {
      setDiagBusyKey(null);
    }
  }

  // Task 33 — the human judged a diagnostic probe good (it landed in the inbox)
  // and wants to LOCK the campaign onto that exact proven combination for the
  // next `pinCount` sends — a temporary window that suspends normal rotation,
  // distinct from the permanent promote action. Requires this explicit human
  // click (never auto-applied); the agent, when it drives this surface, still
  // has to stop here for approval.
  async function pinProbe(result: ProbeResult) {
    setPinning(true);
    setTestResult(null);
    try {
      const res = await fetch(`/api/campaigns/${id}/deliverability-decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "pin_and_continue",
          subject: result.variant.subject,
          bodyHtml: result.variant.bodyHtml,
          ...(result.from ? { from: result.from } : {}),
          pinCount: Math.max(1, Math.min(1000, Math.floor(Number(pinCount)))),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        status?: string;
        pinnedOverride?: CampaignDetail["pinnedOverride"];
      };
      if (!res.ok) {
        setTestResult({ outcome: "failed", error: data.error ?? "Couldn't pin this combination." });
      } else {
        setDiagOpen(false);
        // Task 34 — merge status + the new pinned-override window locally.
        patchCampaign({
          status: data.status ?? "sending",
          ...(data.pinnedOverride ? { pinnedOverride: data.pinnedOverride } : {}),
        });
      }
    } catch {
      setTestResult({ outcome: "failed", error: "Network error while pinning." });
    } finally {
      setPinning(false);
    }
  }

  // TASK_150 T4 — step 1 of a mailbox removal: ask the server exactly what would
  // move (count + destination mailboxes). Nothing is written here; the confirm
  // modal renders whatever this returned, so the user approves the real blast
  // radius and not a client-side guess.
  async function previewRemoveMailbox(mailboxId: string) {
    setMailboxError("");
    setMailboxPreviewBusyId(mailboxId);
    try {
      const res = await fetch(`/api/campaigns/${id}/mailboxes?remove=${encodeURIComponent(mailboxId)}`);
      const data = (await res.json().catch(() => ({}))) as MailboxRemovalPreview & { error?: string };
      if (!res.ok) {
        setMailboxError(data.error ?? "Couldn't work out what this removal would move.");
        return;
      }
      setMailboxRemoval(data);
    } catch {
      setMailboxError("Network error while previewing the removal.");
    } finally {
      setMailboxPreviewBusyId(null);
    }
  }

  // TASK_150 T4 — step 2: apply the confirmed removal. POSTs the remaining
  // mailbox list; the server reassigns the removed mailbox's queued items in ONE
  // transaction. We then merge the fresh items + mailbox list back in (without
  // the full-page `loading` flash) so the moved rows show their new mailbox.
  async function applyMailboxRemoval() {
    if (!mailboxRemoval || !campaign) return;
    const remaining = campaign.mailboxes
      .map((m) => m.id)
      .filter((mid) => mid !== mailboxRemoval.removeMailboxId);
    setMailboxApplyBusy(true);
    setMailboxError("");
    try {
      const res = await fetch(`/api/campaigns/${id}/mailboxes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mailboxIds: remaining }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setMailboxError(data.error ?? "Couldn't remove that mailbox.");
        return;
      }
      setMailboxRemoval(null);
      const freshRes = await fetch(`/api/campaigns/${id}`);
      if (freshRes.ok) {
        const fresh = (await freshRes.json()) as CampaignDetail;
        setCampaign((prev) => (prev ? { ...prev, items: fresh.items, mailboxes: fresh.mailboxes } : prev));
      }
    } catch {
      setMailboxError("Network error while removing the mailbox.");
    } finally {
      setMailboxApplyBusy(false);
    }
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

  // Task 36 — "switch subject" is only offered when the campaign actually has an
  // independent subject to rotate to (decoupled subjects.length > 1). A legacy
  // campaign, or a decoupled one with a single subject, has nothing to switch to
  // — the button is hidden and the user is steered to "Manually edit and test",
  // so clicking can never silently do nothing (the server also rejects it).
  const canSwitchSubject = (campaign.subjects?.length ?? 0) > 1;

  // TASK_150 T3 — a campaign paused at a batch boundary means two different
  // things depending on which test mode it is in, and the owner must never be
  // shown the failure framing for a boundary that is really their turn:
  //
  //   - manual test mode (testRecipientOverride set): the probe has no IMAP
  //     access to that inbox, so placement is never auto-verifiable — the drain
  //     now reports this as "human_confirm", never as a failed check. Confirmed
  //     live 2026-09-30: the user was told, every batch, that the check "could not
  //     be verified" after the test send had in fact succeeded.
  //   - automated (seed-mailbox) mode: spam / unverifiable really IS a failed
  //     check, and that copy stays exactly as it was.
  //
  // The stored status string is untouched ("paused_deliverability") so
  // /api/campaigns/[id]/deliverability-decision and the initial
  // pending_test_confirm gate keep working unchanged — only the label and tone
  // the owner reads change.
  const manualBoundary = campaign.status === "paused_deliverability" && !!campaign.testRecipientOverride;

  // 2026-09-28 — the test-setup panel's shortlist, normalised once. The column
  // is a non-null String[] with a [] default, but a campaign row that predates
  // the 20261017000000 migration (or a response from an older cached client)
  // would carry undefined here, and every use below indexes straight into it.
  const testRecipientPool = campaign.testRecipientPool ?? [];

  // Task 32 — the From addresses the draft probe can be sent as: every Task 30
  // item 4 configured from address across the campaign's mailboxes, deduped, plus
  // each mailbox's SMTP username as a fallback (an empty list on a mailbox means
  // "send as the SMTP username"). Empty list => hide the select for v1.
  // 2026-09-28 — a pinned test-only From is added too, otherwise the manual-edit
  // form could not select the very address the user just chose to test with.
  const fromOptions = Array.from(
    new Set([
      ...campaign.mailboxes.flatMap((m) =>
        m.fromAddresses && m.fromAddresses.length > 0 ? m.fromAddresses : [m.username]
      ),
      ...(campaign.testFromOverride ? [campaign.testFromOverride] : []),
    ])
  );

  // 2026-09-28 — the test-setup panel. Everything in it is about TESTING ONLY;
  // the panel says so explicitly, because the two levers it exposes (which inbox
  // the test lands in, and what From it goes out as) are exactly the things a
  // person changes repeatedly while triaging, and it would be alarming to think
  // each click was rewriting the live campaign. It is not: these values are read
  // exclusively by the test-send and diagnostics routes.
  //
  // Deliberately rendered in BOTH decision-boxes (the initial gate and the
  // batch-pause banner) alongside the existing manual-edit and diagnostics
  // sections, so wherever the user is stuck they can see and change the setup.
  const testSetupSection = (
    <div className="mt-3 rounded-lg border border-zinc-300 bg-white p-3 dark:border-zinc-700 dark:bg-zinc-950">
      {!testSetupOpen ? (
        <button
          type="button"
          onClick={() => {
            setTestSetupOpen(true);
            setTestFromInput(campaign.testFromOverride ?? "");
          }}
          className="text-sm font-medium text-zinc-500 underline underline-offset-4 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          Change where tests go / what they&apos;re sent as →
        </button>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            These affect <span className="font-medium">test sends only</span> — nothing here is used when the campaign
            actually goes out. Switch the address between tests to check more than one inbox, and change the From to
            find out whether that&apos;s what&apos;s triggering spam.
          </p>

          {/* --- where the test lands ------------------------------------- */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Test goes to
            </p>
            <p className="mt-1 text-sm">
              {campaign.testRecipientOverride ? (
                <>
                  <span className="font-medium">{campaign.testRecipientOverride}</span>{" "}
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    (your own inbox — we can&apos;t check it automatically, so you confirm delivery by eye)
                  </span>
                </>
              ) : (
                <>
                  <span className="font-medium">The automated test mailbox</span>{" "}
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    (we send and then check the inbox ourselves via IMAP)
                  </span>
                </>
              )}
            </p>
            {campaign.testRecipientOverride && (
              <button
                type="button"
                onClick={() => void saveTestSetup({ email: null })}
                disabled={testTargetBusy || testBusy}
                className="mt-1 text-xs font-medium text-zinc-500 underline underline-offset-4 hover:text-zinc-700 disabled:opacity-50 dark:text-zinc-400 dark:hover:text-zinc-200"
              >
                Use the automated test mailbox instead
              </button>
            )}

            {/* The shortlist: one click switches which of the saved addresses is
                active AND re-tests immediately, which is the whole point — the
                question being asked is always "did THIS inbox get it?". */}
            {testRecipientPool.length > 0 && (
              <ul className="mt-2 space-y-1">
                {testRecipientPool.map((addr) => {
                  const isActive = addr === campaign.testRecipientOverride;
                  return (
                    <li key={addr} className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void saveTestSetup({ email: addr, thenTest: true, sendTo: addr })}
                        disabled={testTargetBusy || testBusy}
                        className={`rounded-lg border px-2 py-1 text-xs font-medium disabled:opacity-50 ${
                          isActive
                            ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300"
                            : "border-zinc-300 text-zinc-600 hover:bg-black/5 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-white/5"
                        }`}
                      >
                        {isActive ? `✓ ${addr} — test again` : `Test ${addr}`}
                      </button>
                      <button
                        type="button"
                        onClick={() => void saveTestSetup({ pool: testRecipientPool.filter((a) => a !== addr) })}
                        disabled={testTargetBusy || testBusy}
                        className="text-xs text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
                        aria-label={`Remove ${addr}`}
                      >
                        Remove
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                type="email"
                value={newTestTarget}
                onChange={(e) => setNewTestTarget(e.target.value)}
                placeholder="add another address to test with"
                className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-violet-500 dark:border-zinc-700 dark:bg-zinc-950"
              />
              <button
                type="button"
                onClick={() =>
                  void saveTestSetup({ email: newTestTarget.trim(), thenTest: true, sendTo: newTestTarget.trim() })
                }
                disabled={testTargetBusy || testBusy || !newTestTarget.trim()}
                className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
              >
                {testTargetBusy ? "Working…" : "Save & test there"}
              </button>
            </div>
          </div>

          {/* --- what the test is sent AS --------------------------------- */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Test From address
            </p>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              {campaign.testFromOverride ? (
                <>
                  Every test is sent as <span className="font-medium">{campaign.testFromOverride}</span>. This does not
                  change what the campaign sends as.
                </>
              ) : (
                <>Every test is sent as the mailbox&apos;s normal From address (its first configured one).</>
              )}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                type="email"
                value={testFromInput}
                onChange={(e) => setTestFromInput(e.target.value)}
                placeholder={fromOptions[0] ?? "test@yourdomain.com"}
                className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-violet-500 dark:border-zinc-700 dark:bg-zinc-950"
              />
              <button
                type="button"
                onClick={() =>
                  void saveTestSetup({
                    from: testFromInput.trim(),
                    thenTest: true,
                    sendFrom: testFromInput.trim(),
                  })
                }
                disabled={testTargetBusy || testBusy || !testFromInput.trim()}
                className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
              >
                {testTargetBusy ? "Working…" : "Test as this From"}
              </button>
              {campaign.testFromOverride && (
                <button
                  type="button"
                  onClick={() => {
                    setTestFromInput("");
                    void saveTestSetup({ from: null });
                  }}
                  disabled={testTargetBusy || testBusy}
                  className="text-xs font-medium text-zinc-500 underline underline-offset-4 hover:text-zinc-700 disabled:opacity-50 dark:text-zinc-400 dark:hover:text-zinc-200"
                >
                  Use the normal From again
                </button>
              )}
            </div>
            {/* Only senders the mailbox could plausibly send AS are offered (the
                SMTP session is always authenticated as the mailbox's own user,
                so a From the provider won't accept would simply bounce). Free
                text is still allowed for what this list can't know about — e.g.
                a verified alias at a relay provider. */}
            {fromOptions.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {fromOptions.map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setTestFromInput(f)}
                    className="rounded border border-zinc-300 px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-black/5 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-white/5"
                  >
                    {f}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Task 144 — HTML vs plain-text-only. Rendered in the test-setup panel
              because that is where triage happens, but it is explicitly labelled
              as a SAVED campaign setting: it changes every future real send, which
              is the point (a test that sends a different shape than the real send
              predicts nothing). */}
          <div className="border-t border-zinc-200 pt-3 dark:border-zinc-800">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Message format
            </p>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              An HTML-only message is itself a spam signal. Plain text removes all markup — the strongest
              lever here short of fixing domain authentication. This is saved on the campaign, so test
              sends and the real send always match.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {(["html", "text"] as const).map((fmt) => {
                const active = (campaign.bodyFormat ?? "html") === fmt;
                return (
                  <button
                    key={fmt}
                    type="button"
                    onClick={() => void saveBodyFormat(fmt)}
                    disabled={bodyFormatBusy || testBusy}
                    className={
                      active
                        ? "rounded-lg border border-violet-500 bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-700 disabled:opacity-50 dark:bg-violet-950 dark:text-violet-300"
                        : "rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-black/5 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-white/5"
                    }
                  >
                    {bodyFormatBusy ? "Working…" : fmt === "html" ? "HTML" : "Plain text only"}
                  </button>
                );
              })}
              {bodyFormatError && (
                <span className="text-xs text-red-600 dark:text-red-400">{bodyFormatError}</span>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={() => setTestSetupOpen(false)}
            className="text-xs font-medium text-zinc-500 underline underline-offset-4 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            Done
          </button>
        </div>
      )}
    </div>
  );

  // Task 32 — the 4th, clearly-secondary path through the decision box, rendered in
  // BOTH the initial test-send-confirm gate and the batch-pause banner. A small
  // toggle expands into a subject / From / body edit form pre-filled from whatever
  // the last test-send used, a "Send test with this edit" live probe (stored
  // content untouched), and — once a check comes back — a single "Use this edited
  // version" promote action alongside the normal options (which, if chosen instead,
  // just discard the draft and fall back to the automated flow).
  const manualEditSection = (
    <div className="mt-3 rounded-lg border border-zinc-300 bg-white p-3 dark:border-zinc-700 dark:bg-zinc-950">
      {!editOpen ? (
        <button
          type="button"
          onClick={openEdit}
          className="text-sm font-medium text-zinc-500 underline underline-offset-4 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          Manually edit and test instead →
        </button>
      ) : (
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Subject
            </label>
            <input
              type="text"
              value={editSubject}
              onChange={(e) => setEditSubject(e.target.value)}
              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-violet-500 dark:border-zinc-700 dark:bg-zinc-950"
            />
          </div>
          {fromOptions.length > 0 && (
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                From address
              </label>
              <select
                value={editFrom}
                onChange={(e) => setEditFrom(e.target.value)}
                className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-violet-500 dark:border-zinc-700 dark:bg-zinc-950"
              >
                {fromOptions.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Body HTML
            </label>
            <textarea
              value={editBody}
              onChange={(e) => setEditBody(e.target.value)}
              rows={5}
              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-violet-500 dark:border-zinc-700 dark:bg-zinc-950"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void sendDraftTest()}
              disabled={editBusy || debating}
              className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              {editBusy ? "Sending test… checking" : "Send test with this edit"}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditOpen(false);
                setDraftTested(false);
              }}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-black/5 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-white/5"
            >
              Discard draft
            </button>
          </div>
          {draftTested && (
            <div className="rounded-lg border border-violet-200 bg-violet-50 p-2 text-xs text-violet-700 dark:border-violet-900/50 dark:bg-violet-950/20 dark:text-violet-300">
              <p className="font-medium">
                A live test with this edit came back — if it looks good, promote it:
              </p>
              <button
                type="button"
                onClick={() => void promoteEdit()}
                disabled={debating || editBusy}
                className="mt-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-50"
              >
                {debating ? "Promoting…" : "Use this edited version — add to rotation and go ahead"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );

  // Task 33 — the isolation-diagnostic panel (alongside Task 32's manual-edit
  // box, both optional). Lists the 4 probes as a checklist — subject-only /
  // body-only / empty-body / from-only — each with its own Run button and a
  // landedIn badge once tested. A probe that lands in the inbox is \"green\": the
  // owner can PIN that exact combination for the next `pinCount` sends (a
  // temporary window that keeps rotation off until it's over), which posts to
  // deliverability-decision with action pin_and_continue (explicit human click).
  const diagnosticsSection = (
    <div className="mt-3 rounded-lg border border-zinc-300 bg-white p-3 dark:border-zinc-700 dark:bg-zinc-950">
      {!diagOpen ? (
        <button
          type="button"
          onClick={() => void openDiagnostics()}
          className="text-sm font-medium text-zinc-500 underline underline-offset-4 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          Run diagnostics to isolate the spam trigger →
        </button>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Isolate WHICH element (subject / body / From) is triggering spam. Each probe changes
            exactly one variable and holds the other two constant, and each is a real test against
            your test mailbox (every probe writes its own audit row). A probe that lands in the
            inbox lets you pin that proven combination for the next few sends — a temporary window
            that keeps rotation off until it&apos;s over.
          </p>
          {!diagProbes ? (
            <p className="text-xs text-zinc-400 dark:text-zinc-500">Loading probes…</p>
          ) : (
            diagProbes.map((p) => {
              const result = diagResults[p.key];
              const out = result?.outcome;
              const landed = result?.landedIn;
              return (
                <div key={p.key} className="rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{p.label}</p>
                      <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{p.description}</p>
                      {!p.available && p.unavailableReason ? (
                        <p className="mt-0.5 text-xs text-zinc-400 dark:text-zinc-500">{p.unavailableReason}</p>
                      ) : null}
                    </div>
                    {p.available ? (
                      <button
                        type="button"
                        onClick={() => void runProbe(p.key)}
                        disabled={diagBusyKey !== null}
                        className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
                      >
                        {diagBusyKey === p.key ? "Testing…" : "Run"}
                      </button>
                    ) : (
                      <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                        n/a
                      </span>
                    )}
                  </div>
                  {out && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
                      <span className={`font-medium ${
                        landed === "inbox" ? "text-emerald-600" : landed === "spam" ? "text-red-600" : "text-amber-600"
                      }`}>
                        landed: {landed ?? "n/a"} · {out}
                      </span>
                      {result?.error ? <span className="text-zinc-500 dark:text-zinc-400">{result.error}</span> : null}
                      {landed === "inbox" && (
                        <>
                          <span className="text-zinc-400 dark:text-zinc-500">Pin for</span>
                          <input
                            type="number"
                            min={1}
                            max={1000}
                            value={pinCount}
                            onChange={(e) => setPinCount(Number(e.target.value))}
                            className="w-20 rounded-lg border border-zinc-300 bg-white px-2 py-1 text-xs outline-none focus:border-violet-500 dark:border-zinc-700 dark:bg-zinc-950"
                          />
                          <span className="text-zinc-400 dark:text-zinc-500">sends</span>
                          <button
                            type="button"
                            onClick={() => void pinProbe(result)}
                            disabled={pinning}
                            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                          >
                            {pinning ? "Pinning…" : "Pin this combination"}
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
          <button
            type="button"
            onClick={() => setDiagOpen(false)}
            className="text-xs font-medium text-zinc-500 underline underline-offset-4 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            Close diagnostics
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div>
      <Link href="/dashboard/campaigns" className="text-sm font-medium text-zinc-500 underline-offset-4 hover:underline dark:text-zinc-400">
        ← Back to campaigns
      </Link>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{campaign.name}</h1>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            manualBoundary
              ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400"
              : `capitalize ${STATUS_BADGES[campaign.status] ?? "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"}`
          }`}
        >
          {manualBoundary ? "your turn — test confirm" : campaign.status.replace("_", " ")}
        </span>
        {campaign.status === "sending" && (
          <button
            type="button"
            onClick={() => void pauseCampaign()}
            disabled={pauseResumeBusy}
            className="rounded-lg border border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-amber-800 dark:text-amber-400 dark:hover:bg-amber-950/40"
          >
            {pauseResumeBusy ? "…" : "Pause"}
          </button>
        )}
        {campaign.status === "paused_manual" && (
          <button
            type="button"
            onClick={() => void resumeCampaign()}
            disabled={pauseResumeBusy}
            className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {pauseResumeBusy ? "…" : "Resume"}
          </button>
        )}
        {/* Task 30, item 2 — compact "what's been sent so far" overview instead of
            scrolling the whole (potentially thousands-row) queue table. */}
        {campaign.items.length > 0 && (
          <button
            type="button"
            onClick={() => setActivityOpen(true)}
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            View activity
          </button>
        )}
      </div>

      {/* TASK_150 T4 — Sending mailboxes. Queue items are pinned to a mailbox at
          creation time, so removing one from a live campaign has to move its
          not-yet-sent recipients onto the others; this panel is the only place
          that can do that while `sending` (the all-fields PATCH still 409s by
          design). The count shown per mailbox is the removal's real blast
          radius, confirmed via a server-side preview before anything is written. */}
      {campaign.mailboxes.length > 0 && (
        <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Sending mailboxes <span className="text-zinc-400">({campaign.mailboxes.length})</span>
            </h2>
            <button
              type="button"
              onClick={() => {
                setMailboxesOpen((o) => !o);
                setMailboxError("");
              }}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              {mailboxesOpen ? "Done" : "Remove a mailbox…"}
            </button>
          </div>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            {campaign.status === "sending" || campaign.status === "paused_deliverability"
              ? "This campaign is sending. Removing a mailbox moves its not-yet-sent recipients onto the remaining mailboxes — anything already sent is never touched."
              : "Each recipient is pinned to a mailbox when the campaign is created. Removing one moves its still-queued recipients onto the rest."}
          </p>
          {mailboxError && !mailboxRemoval && (
            <p className="mt-2 text-xs text-red-600 dark:text-red-400">{mailboxError}</p>
          )}
          <ul className="mt-3 space-y-2">
            {campaign.mailboxes.map((m) => {
              const queuedForMailbox = campaign.items.filter(
                (i) => i.mailboxId === m.id && i.status === "queued",
              ).length;
              const isLast = campaign.mailboxes.length <= 1;
              return (
                <li
                  key={m.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{m.label || m.username}</p>
                    <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                      {m.username} · {queuedForMailbox} queued
                    </p>
                  </div>
                  {mailboxesOpen &&
                    (isLast ? (
                      <span className="text-xs text-amber-700 dark:text-amber-400">
                        Last mailbox — a campaign needs at least one.
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void previewRemoveMailbox(m.id)}
                        disabled={mailboxPreviewBusyId !== null}
                        className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-900/50 dark:text-red-400 dark:hover:bg-red-950/40"
                      >
                        {mailboxPreviewBusyId === m.id ? "Checking…" : "Remove"}
                      </button>
                    ))}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* TASK_150 T4 — the confirmation step. Rendered from the server's preview so
          the user approves the exact number of items that will move and where. */}
      <Modal
        open={mailboxRemoval !== null}
        onClose={() => {
          if (!mailboxApplyBusy) setMailboxRemoval(null);
        }}
        title="Remove this sending mailbox?"
      >
        {mailboxRemoval && (
          <div className="text-sm text-zinc-600 dark:text-zinc-300">
            <p>
              <span className="font-medium">{mailboxRemoval.removeLabel}</span> will be removed from{" "}
              <span className="font-medium">{campaign.name}</span>.
            </p>
            {mailboxRemoval.queuedCount === 0 ? (
              <p className="mt-2">It has no queued recipients — nothing needs to move.</p>
            ) : (
              <>
                <p className="mt-2">
                  <span className="font-medium">{mailboxRemoval.queuedCount}</span> queued recipient
                  {mailboxRemoval.queuedCount === 1 ? "" : "s"} will move to:
                </p>
                <ul className="mt-2 space-y-1">
                  {mailboxRemoval.targets.map((t) => (
                    <li key={t.mailboxId} className="flex items-center justify-between gap-3">
                      <span className="truncate">{t.label}</span>
                      <span className="shrink-0 font-medium">{t.count}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
              Already-sent recipients are never changed. The move is applied in one transaction.
            </p>
            {mailboxError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{mailboxError}</p>}
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setMailboxRemoval(null)}
                disabled={mailboxApplyBusy}
                className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void applyMailboxRemoval()}
                disabled={mailboxApplyBusy}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {mailboxApplyBusy ? "Removing…" : "Remove mailbox"}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Task 35 — live, always-visible sending ticker. Only while status is
          "sending": a glanceable pulse of the 5 most recent send attempts fed by
          the shared poll above. Newest at the bottom so the batch reads
          oldest→newest top-to-bottom: a new line slides in (existing lines shift
          up) and the oldest is trimmed once past the 5th slot. This is explicitly
          NOT the activity modal — no counts here, that's what the modal is for. */}
      {campaign.status === "sending" && liveFeed.length > 0 && (
        <div
          className="mt-4 rounded-xl border border-zinc-200 bg-white/70 p-3 dark:border-zinc-800 dark:bg-zinc-900/50"
          aria-live="polite"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Live sending
            </h3>
            <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
              sending
            </span>
          </div>
          <ul className="mt-2 flex flex-col">
            {/* liveFeed is newest-first; reverse so the newest sits at the bottom
                and prior lines shift up as each new one slides in. */}
            {liveFeed
              .slice()
              .reverse()
              .map((s) => (
                <li
                  key={s.id}
                  className="flex items-center gap-2 py-1 text-sm animate-[fadeInUp_0.3s_ease-out]"
                >
                  {s.status === "sent" ? (
                    <span className="text-emerald-600 dark:text-emerald-400" aria-label="sent">✓</span>
                  ) : (
                    <span className="text-red-600 dark:text-red-400" aria-label="failed">✗</span>
                  )}
                  <span className="truncate text-zinc-700 dark:text-zinc-200">{s.toEmail}</span>
                </li>
              ))}
          </ul>
        </div>
      )}

      {/* Task 33 — an active pinned override window (only ever set by an explicit
          human pin_and_continue decision): rotation is suspended for `remaining`
          more sends while the drain sends this exact proven combination. */}
      {campaign.pinnedOverride && (
        <div className="mt-4 rounded-lg border border-emerald-300 bg-emerald-50 p-3 dark:border-emerald-800 dark:bg-emerald-950/20">
          <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">
            Pinned override active — rotation suspended for{" "}
            {campaign.pinnedOverride.remaining} more send{campaign.pinnedOverride.remaining === 1 ? "" : "s"}
          </p>
          <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
            Every recipient will get this exact combination instead of the normal rotation:
            <span className="font-medium">&quot;{campaign.pinnedOverride.subject}&quot;</span>
            {campaign.pinnedOverride.fromAddress ? (
              <>{" "}from <span className="font-medium">{campaign.pinnedOverride.fromAddress}</span></>
            ) : null}
            . The window ends and normal rotation resumes after the count above.
          </p>
        </div>
      )}

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

          {/* Task 34 — a personal test-recipient override is in play (Task 29/32
              set it); offer a one-click way back to the platform's automated
              IMAP-verified seed-mailbox path. Undoes exactly what "use this as my
              test recipient"/"edit and promote" did — POSTs the same route with
              { email: null } and merges the cleared override locally. */}
          {campaign.testRecipientOverride && (
            <button
              type="button"
              onClick={() => void revertTestRecipient()}
              disabled={settingTestRecipient}
              className="mt-2 text-xs font-medium text-violet-700 underline underline-offset-4 hover:text-violet-600 disabled:opacity-50 dark:text-violet-300"
            >
              {settingTestRecipient ? "Switching back…" : "Switch back to automated testing (SpaceWorker seed mailbox)"}
            </button>
          )}

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
              Latest check:{" "}
              {/* Task 144 — a test sent to a specific inbox (testRecipientOverride)
                  is never auto-verified: we have no IMAP access to that address, so
                  the stored status is only ever "the SMTP send succeeded". Printing
                  the raw status there said "delivered" in green, which reads as a
                  confirmed-good result and contradicts the "landed in unknown" note
                  printed right next to it. Confirmed live 2026-09-29 — a user read
                  that green "delivered" as "the test passed" while nothing had
                  actually arrived. Say what it really is instead. */}
              <span
                className={`font-medium ${
                  latestCheck.status === "failed"
                    ? "text-red-600"
                    : campaign.testRecipientOverride
                      ? "text-amber-600"
                      : "text-emerald-600"
                }`}
              >
                {campaign.testRecipientOverride && latestCheck.status !== "failed"
                  ? "sent — not auto-verified"
                  : latestCheck.status}
              </span>
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
                {canSwitchSubject && (
                  <button
                    type="button"
                    onClick={() => void retryWithNextSubject()}
                    disabled={debating || testBusy}
                    className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500 disabled:opacity-50"
                  >
                    {debating || testBusy ? "Working…" : "It went to spam — try a different subject"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void sendTest()}
                  disabled={debating || testBusy}
                  className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-black/5 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-white/5"
                >
                  Didn&apos;t receive it — try again
                </button>
              </div>
              <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                &quot;It&apos;s in the inbox&quot; records your manual confirmation and unlocks sending immediately.
                {canSwitchSubject
                  ? " \"Try a different subject\" rotates to the next subject and re-tests it before anything resumes."
                  : " This campaign only has one subject, so rotating isn&apos;t available — use \"Manually edit and test\" below to try fresh content instead."}
              </p>
            </div>
          )}

          {/* 2026-09-28 — where the test goes and what it's sent as. First,
              because it's the setting a person changes most while triaging. */}
          {testSetupSection}
          {/* Task 32 — the 4th, clearly-secondary path through the initial gate:
              manually edit and test a draft without touching stored content. */}
          {manualEditSection}
          {/* Task 33 — the isolation-diagnostic panel (opt-in, alongside edit). */}
          {diagnosticsSection}

          {/* Human-assisted fallback: use a recipient already in the queue, or
              type a new one, as this campaign's test target from now on.
              Bug fix (2026-09-28): this used to only appear AFTER the automated
              seed-mailbox check had already failed once, forcing every user
              through one mandatory ~2-minute automated attempt (which may itself
              be broken — see lib/seed-mailbox.ts's single, owner-shared row —
              before ever offering the manual path. Reported live: "it should
              just send to the test number I added... instead of trying to check
              the gmail set for automated test [first]". Now offered up front,
              any time no override is set yet, so a user who already knows they
              want manual confirmation never has to wait out a doomed automated
              check first. */}
          {!campaign.testRecipientOverride && (() => {
            const existingTestRecipient = campaign.items.find((i) => i.source === "manual_insert")?.toEmail;
            return (
              <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/20">
                <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                  {latestCheck?.status === "failed"
                    ? "The automated check failed — want to test against a real inbox instead?"
                    : "Prefer to test against your own inbox instead of the automated seed-mailbox check?"}
                </p>
                {existingTestRecipient ? (
                  <button
                    type="button"
                    onClick={() => void applyTestRecipient(existingTestRecipient)}
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
                      onClick={() => testRecipientInput.trim() && void applyTestRecipient(testRecipientInput.trim())}
                      disabled={settingTestRecipient || testBusy || !testRecipientInput.trim()}
                      className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500 disabled:opacity-50"
                    >
                      {settingTestRecipient ? "Setting…" : "Use this as my test recipient"}
                    </button>
                  </div>
                )}
                <p className="mt-1.5 text-xs text-amber-700/80 dark:text-amber-400/70">
                  Every test (and later batch check) will go straight there — you&apos;ll check your own inbox and confirm
                  delivery yourself, since there&apos;s no automated way to verify a plain address.
                </p>
              </div>
            );
          })()}
        </div>
      )}

      {/* Task 29, item 6 — the batch gate (mail-queue drain) paused this campaign
          after a batch. The TWO cases are genuinely different and the copy says
          which one this is (TASK_150 T3):
            - manual test mode: the boundary is the owner's TURN. The test message
              was sent (sent — not auto-verified, matching the earlier check line),
              nothing failed, and continuing is an explicit human call. Never
              auto-continued, and never silently re-routed to the seed mailbox.
            - automated mode: the probe's placement couldn't be verified as a clean
              inbox landing (spam, or undetectable) — the original copy, unchanged.
          Either way the owner decides: continue, rotate subject & resume, or stop.
          Wired to deliverabilityDecision()/debating state. */}
      {campaign.status === "paused_deliverability" && (
        <div
          className={`mt-4 rounded-xl border p-4 ${
            manualBoundary
              ? "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/20"
              : "border-red-300 bg-red-50 dark:border-red-900/60 dark:bg-red-900/20"
          }`}
        >
          <h2
            className={`text-sm font-semibold ${
              manualBoundary ? "text-amber-800 dark:text-amber-300" : "text-red-700 dark:text-red-300"
            }`}
          >
            {manualBoundary ? "Your turn: confirm the test message" : "Deliverability check needs your input"}
          </h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
            {manualBoundary ? (
              <>
                This campaign reached its next batch boundary and is waiting for you. A test message was sent to
                your test recipient (<span className="font-medium">{campaign.testRecipientOverride}</span>) —
                sent, not auto-verified, since there&apos;s no automated way to check that inbox. Check it, then
                continue the next batch. The next batch gate will use this same mode — manual confirmation, never
                the seed mailbox.
              </>
            ) : (
              <>
                This campaign paused after a batch because the probe message could not be confirmed in the inbox
                — it may have landed in spam, or we could not verify its placement automatically. Check your test
                mailbox, then decide how to proceed.
              </>
            )}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void deliverabilityDecision("continue")}
              disabled={debating}
              className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              {debating
                ? "Applying…"
                : manualBoundary
                  ? "It's in the inbox — continue the next batch"
                  : "Continue anyway"}
            </button>

            {canSwitchSubject ? (
              <button
                type="button"
                onClick={() => void retryWithNextSubject()}
                disabled={debating || testBusy}
                className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-amber-400 disabled:opacity-50"
              >
                {debating || testBusy ? "Applying…" : "Switch subject & re-test"}
              </button>
            ) : (
              // Task 36 — a legacy / single-subject campaign has nothing to
              // rotate to; switching silently wouldn't change anything being
              // sent, so instead of offering a dead button we surface that and
              // steer to Task 32's "Manually edit and test" below.
              <p className="text-xs text-amber-700 dark:text-amber-300">
                This campaign only has one subject — use &quot;Manually edit and test&quot; below to try fresh content.
              </p>
            )}
            <button
              type="button"
              onClick={() => void deliverabilityDecision("stop")}
              disabled={debating}
              className="rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-900/50 dark:text-red-400 dark:hover:bg-red-950/40"
            >
              {debating ? "Applying…" : "Stop"}
            </button>
          </div>
          {/* Task 32 — same 4th, secondary "manually edit and test" path, available
              from a batch pause too (test-send remains callable while paused). */}
          {testSetupSection}
          {manualEditSection}
          {/* Task 33 — the isolation-diagnostic panel (opt-in, alongside edit). */}
          {diagnosticsSection}
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
          · {campaign.minSendDelaySeconds}–{campaign.maxSendDelaySeconds}s delay between sends
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
              <th className="px-4 py-3 font-medium">Message preview</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Sent at</th>
              <th className="px-4 py-3 font-medium">Actions</th>
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
                  <td className="px-4 py-3 text-zinc-500 max-w-[280px] truncate dark:text-zinc-400" title={stripHtml(item.resolvedBodyHtml ?? item.variant?.bodyHtml ?? "")}>
                    {bodyPreview(item.resolvedBodyHtml ?? item.variant?.bodyHtml ?? "") || "—"}
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
                  <td className="px-4 py-3 whitespace-nowrap">
                  {/* Task 30, item 1 — preview this exact item's resolved content,
                      rendered with its OWN variables, before/after it sends. */}
                  <button
                    type="button"
                    onClick={() => setPreviewItem(item)}
                    className="text-xs font-medium underline-offset-2 hover:underline"
                  >
                    Preview
                  </button>
                  {item.status === "failed" ? (
                    <span className="text-zinc-300 dark:text-zinc-600"> · </span>
                  ) : null}
                  {item.status === "failed" ? (
                    <button
                      type="button"
                      onClick={() => setOpenErrorId(openErrorId === item.id ? null : item.id)}
                      className="text-xs font-medium text-red-600 underline-offset-2 hover:underline dark:text-red-400"
                    >
                      {openErrorId === item.id ? "Hide error" : "Error"}
                    </button>
                  ) : null}
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

      {/* Task 30, item 1 — per-recipient preview: this EXACT item's resolved
          subject/body rendered with ITS OWN variables, in a sandboxed iframe. */}
      {previewItem && (
        <Modal open onClose={() => setPreviewItem(null)} title={`Preview for ${previewItem.toEmail}`} wide>
          <div className="text-sm">
            <span className="text-xs font-medium text-zinc-500">Subject:</span>{" "}
            <span className="text-zinc-900 dark:text-zinc-100">
              {renderMerge(itemSubject(previewItem), previewItem.variables ?? {}) || "—"}
            </span>
          </div>
          <div className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">
            Status: <span className="capitalize">{previewItem.status}</span>
            {previewItem.sentAt ? ` · sent ${new Date(previewItem.sentAt).toLocaleString()}` : ""}
            {previewItem.variables && Object.keys(previewItem.variables).length > 0
              ? ` · merge values: ${Object.entries(previewItem.variables).map(([k, v]) => `${k}=${v}`).join(", ")}`
              : " · no merge values on this recipient"}
          </div>
          <iframe
            sandbox=""
            title="Email preview"
            className="mt-3 h-80 w-full overflow-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-700"
            srcDoc={emailSrcDoc(renderMerge(itemBody(previewItem), previewItem.variables ?? {}))}
          />
        </Modal>
      )}

      {/* Task 30, item 2 — compact sending-activity overview: what's been sent so
          far, per-mailbox breakdown, recent sends, and failures — instead of having
          to scroll the whole (potentially thousands-row) queue table. */}
      {activityOpen && (() => {
        const items = campaign.items;
        // Task 35 — the modal goes LIVE while sending by preferring the shared
        // poll's real-time aggregates over the (increasingly stale) loaded
        // campaign.items snapshot. liveStats is null until the first poll, at
        // which point we fall back to the snapshot — e.g. for campaigns that
        // never entered "sending" this session, or the very first frames.
        const live = liveStats !== null;
        const recipients = live ? liveStats.counts.recipients : items.length;
        const sentCount = live
          ? liveStats.counts.sent
          : items.filter((i) => i.status === "sent").length;
        const queuedCount = live
          ? liveStats.counts.queued
          : items.filter((i) => i.status === "queued" || i.status === "pending").length;
        const failedCount = live
          ? liveStats.counts.failed
          : items.filter((i) => i.status === "failed").length;
        const byMailbox: Record<string, { sent: number; failed: number }> = live
          ? liveStats.byMailbox
          : (() => {
              const m: Record<string, { sent: number; failed: number }> = {};
              for (const i of items) {
                const label = i.mailbox?.label ?? i.mailboxId;
                const slot = m[label] ?? { sent: 0, failed: 0 };
                if (i.status === "sent") slot.sent += 1;
                else if (i.status === "failed") slot.failed += 1;
                m[label] = slot;
              }
              return m;
            })();
        const recent: RecentSend[] = live
          ? liveFeed.slice()
          : items
              .filter((i) => i.status === "sent" || i.status === "failed")
              .map((i) => ({ id: i.id, toEmail: i.toEmail, status: i.status, sentAt: i.sentAt, error: i.error, createdAt: i.createdAt }))
              // Effective timestamp: sentAt for a success, createdAt for a
              // failure (sentAt is always null there) — matches the recent-sends
              // API's own ordering so the fallback path never sorts differently.
              .sort((a, b) => (b.sentAt ?? b.createdAt).localeCompare(a.sentAt ?? a.createdAt))
              .slice(0, 15);
        const kpi = (label: string, value: number, cls: string) => (
          <div className="flex flex-col rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-700">
            <span className={`text-xl font-semibold ${cls}`}>{value}</span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">{label}</span>
          </div>
        );
        return (
          <Modal open onClose={() => setActivityOpen(false)} title="Sending activity" wide>
            {/* One scroll region for the whole body — a campaign with many
                mailboxes or a long recent-sends list (now taller per row since
                a failed send's error message renders inline) could otherwise
                push the modal, and its close button, off-screen. */}
            <div className="max-h-[70vh] overflow-y-auto pr-1">
            <div className="flex flex-wrap gap-3">
              {kpi("Recipients", recipients, "text-zinc-900 dark:text-zinc-100")}
              {kpi("Sent", sentCount, "text-emerald-600 dark:text-emerald-400")}
              {kpi("Queued", queuedCount, "text-amber-600 dark:text-amber-400")}
              {kpi("Failed", failedCount, failedCount > 0 ? "text-red-600 dark:text-red-400" : "text-zinc-400 dark:text-zinc-500")}
            </div>

            <div className="mt-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Sent by mailbox</h3>
              {Object.keys(byMailbox).length === 0 ? (
                <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">Nothing sent yet.</p>
              ) : (
                <table className="mt-1 w-full text-sm">
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {Object.entries(byMailbox).map(([label, t]) => (
                      <tr key={label}>
                        <td className="px-3 py-1.5">{label}</td>
                        <td className="px-3 py-1.5 text-right text-emerald-600 dark:text-emerald-400">{t.sent} sent</td>
                        <td className="px-3 py-1.5 text-right">{t.failed > 0 ? <span className="text-red-600 dark:text-red-400">{t.failed} failed</span> : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="mt-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Most recent sends</h3>
              {recent.length === 0 ? (
                <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">No sends yet.</p>
              ) : (
                <ul className="mt-1 divide-y divide-zinc-100 dark:divide-zinc-800">
                  {recent.map((i) => (
                    <li key={i.id} className="px-3 py-1.5 text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <span className="flex min-w-0 items-center gap-2">
                          {i.status === "sent" ? (
                            <span className="shrink-0 text-emerald-600 dark:text-emerald-400" aria-label="sent">✓</span>
                          ) : (
                            <span className="shrink-0 text-red-600 dark:text-red-400" aria-label="failed">✗</span>
                          )}
                          <span className="truncate">{i.toEmail}</span>
                        </span>
                        <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
                          {i.sentAt ? new Date(i.sentAt).toLocaleString() : ""}
                        </span>
                      </div>
                      {i.status === "failed" && i.error && (
                        <p className="mt-0.5 pl-6 text-xs text-red-600 dark:text-red-400">{i.error}</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {failedCount > 0 && (
              <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900/50 dark:bg-red-950/20">
                <p className="text-xs font-semibold uppercase tracking-wide text-red-700 dark:text-red-400">
                  {failedCount} failed — see each row&apos;s error message above
                </p>
              </div>
            )}
            </div>
          </Modal>
        );
      })()}
    </div>
  );
}