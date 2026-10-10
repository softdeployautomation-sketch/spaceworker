"use client";

import { useCallback, useEffect, useState } from "react";

import { Button, Input, Textarea } from "@/components/ui";
import { SupportInvoiceCard, type ThreadInvoiceCardData } from "@/components/support-invoice-card";
import {
  BROADCAST_TEMPLATES,
  PREMIUM_REQUEST_TEMPLATES,
  isPremiumRequestCategory,
} from "@/lib/support-templates";
// TASK_199 S2 — type-only import: erased at compile time, so the server module's
// prisma import never reaches this client bundle. The VALUES live in the route.
import type { BroadcastAudience } from "@/lib/support/tickets";

// TASK_161 D3/D4 — the admin support queue.
//
// TASK_159 Phase 1 built every route this panel needs — list, detail, reply, resolve —
// and nothing in the admin panel rendered one. A support queue with no screen is a
// support queue that does not exist: tickets accumulate, nobody sees them, and the
// whole feature reads as "broken" rather than "unfinished".
//
// TWO THINGS THIS PANEL DELIBERATELY DOES NOT DO:
//
//   * NO DELETE, and no "close without replying". A ticket that can vanish leaves the
//     customer waiting for a reply that will never come, and support history that can
//     be erased is not history (PLAN_TASK_159 §2.3). The only terminal action is
//     `resolved`, which the customer sees in their own list and which is reversible.
//
//   * NO STATUS FREETEXT BOX. `status` is an extensible string by design (the schema
//     deliberately has no CHECK on it so "waiting_on_customer" can be added without a
//     migration). An editable free-text field means one typo — "resolve", "resolved " —
//     silently creates a status no queue filter will ever match, and the ticket
//     disappears from every view while still being unanswered. So the panel offers the
//     two states it can spell correctly.
//
// PATCH FIELD SEMANTICS, restated from app/api/admin/support/tickets/[id]/route.ts
// because getting this wrong is silent and destructive:
//
//   absent (undefined) -> leave alone      present null -> CLEAR
//   present string     -> set
//
// Sending `{status: "resolved", category: null}` does NOT mean "resolve and keep the
// category" — it means "resolve and CLEAR the category". So this panel builds the PATCH
// body field-by-field and only ever includes what it is changing right now.

interface TicketRow {
  id: string;
  subject: string;
  status: string;
  category: string | null;
  priority: string | null;
  createdAt: string;
  messageCount: number;
  lastMessageAt: string | null;
}

interface Message {
  id: string;
  authorRole: string;
  body: string;
  createdAt: string;
  /** TASK_187 — the soft ref stored on the row (DETAIL reads always carry it). */
  invoiceId?: string | null;
  /** TASK_187 — resolved LIVE at read time; null = dangling/foreign ref → no card. */
  invoice?: ThreadInvoiceCardData | null;
}

interface TicketDetail extends TicketRow {
  messages: Message[];
  domain: { id: string; apex: string; status: string } | null;
  userEmail: string;
  /** TASK_187 B7 — the OWNER's id; the invoice composer POSTs at /api/admin/users/<id>/invoices. */
  userId?: string;
}

/** The ONLY value that means closed — mirrors RESOLVED_STATUS in lib/support/tickets.ts. */
const RESOLVED = "resolved";

function isResolved(status: string): boolean {
  return status === RESOLVED;
}

function when(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    return typeof data.error === "string" && data.error.trim() !== ""
      ? data.error
      : fallback;
  } catch {
    return fallback;
  }
}

/**
 * "Open" is the default, not "All".
 *
 * A queue that boots on every ticket ever filed puts yesterday's resolved mail at the
 * top of the list and buries the one new arrival the admin opened the tab for. All
 * three are one click away, so nothing is lost — the default is just the useful one.
 */
const STATUS_FILTERS = [
  { value: "open", label: "Open" },
  { value: RESOLVED, label: "Resolved" },
  { value: "", label: "All" },
] as const;

/**
 * TASK_184 B2 — the plan filter. `""` (Every plan) is sent as an ABSENT parameter,
 * exactly like STATUS_FILTERS' "All": the two premium values are the categories the
 * widget's templates file, and they reach listAdminTickets' exact-match as-is.
 */
const CATEGORY_FILTERS = [
  { value: "", label: "Every plan" },
  { value: "premium_request_plus", label: "Premium Plus" },
  { value: "premium_request_xdevice", label: "Premium XDevice" },
] as const;

/** TASK_187 C1 — the two plans the invoice composer can send. */
type PlanName = "premium_plus" | "premium_xdevice";

/** Configured defaults from /api/admin/wallets — prefill only, never hardcoded. */
interface PriceDefaults {
  premium_plus: number;
  premium_xdevice: number;
}

/** Labels from the one source of plan names (support-templates), not retyped. */
const PLAN_OPTIONS: { value: PlanName; label: string }[] = [
  { value: "premium_plus", label: PREMIUM_REQUEST_TEMPLATES.premium_request_plus.planName },
  { value: "premium_xdevice", label: PREMIUM_REQUEST_TEMPLATES.premium_request_xdevice.planName },
];

/** The ticket's category picks the starting plan; re-inferred for every ticket. */
function planFromCategory(category: string | null): PlanName {
  return category === "premium_request_xdevice" ? "premium_xdevice" : "premium_plus";
}

export default function SupportQueuePanel() {
  const [filter, setFilter] = useState<string>("open");
  const [category, setCategory] = useState<string>("");
  const [tickets, setTickets] = useState<TicketRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Admin-composed ticket (D4). Deliberately SEPARATE state from the reply box: one
  // shared `body` field would let a half-typed compose overwrite the reply an admin is
  // mid-way through writing in the thread they are reading.
  const [composing, setComposing] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newSubject, setNewSubject] = useState("");
  const [newBody, setNewBody] = useState("");

  // TASK_187 C1 — the money composer, with its own state for the same reason
  // `reply` and the new-ticket form have their own: a half-filled invoice must
  // never clobber a half-written reply (or vice versa). Admin-only surface —
  // the term override and the payout-address overrides exist exactly here.
  const [invoiceing, setInvoiceing] = useState(false);
  const [invPlan, setInvPlan] = useState<PlanName>("premium_plus");
  const [invAmount, setInvAmount] = useState("");
  const [invAmountTouched, setInvAmountTouched] = useState(false);
  const [invDays, setInvDays] = useState(""); // blank = standard term
  const [invBtc, setInvBtc] = useState("");
  const [invTrc, setInvTrc] = useState("");
  const [invErc, setInvErc] = useState("");
  const [invNote, setInvNote] = useState("");
  const [invBusy, setInvBusy] = useState(false);
  const [invError, setInvError] = useState<string | null>(null);
  const [priceDefaults, setPriceDefaults] = useState<PriceDefaults | null>(null);

  // TASK_199 S2 — the broadcast composer. Its own state again (a half-typed
  // announcement must not clobber a reply or an invoice draft). The audience
  // values mirror BROADCAST_AUDIENCES in lib/support/tickets.ts.
  const [bcastOpen, setBcastOpen] = useState(false);
  const [bcastAudience, setBcastAudience] = useState<BroadcastAudience>("everyone");
  const [bcastBody, setBcastBody] = useState("");
  const [bcastBusy, setBcastBusy] = useState(false);
  const [bcastError, setBcastError] = useState<string | null>(null);

  const load = useCallback(async (status: string, planCategory: string) => {
    setListError(null);
    try {
      // An empty filter is sent as an ABSENT parameter, not `status=` — the service
      // ignores an empty filter rather than matching `status = ''`, which would render
      // as "there are no tickets" instead of "show me everything". Same rule for the
      // TASK_184 B2 plan filter: `?category=` reaches listAdminTickets' exact match
      // as-is, and an absent category means "every plan".
      const qs = new URLSearchParams();
      if (status) qs.set("status", status);
      if (planCategory) qs.set("category", planCategory);
      const query = qs.toString();
      const res = await fetch(`/api/admin/support/tickets${query ? `?${query}` : ""}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(await readError(res, "Could not load the queue."));
      const data = (await res.json()) as { tickets: TicketRow[] };
      setTickets(data.tickets);
    } catch (e) {
      setListError(e instanceof Error ? e.message : "Could not load the queue.");
      // A failed read must NOT render as an empty queue: "there are no tickets" and
      // "we could not reach the server" look identical to an admin deciding whether
      // anyone needs help, and only one of them is true.
      setTickets(null);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load() awaits fetch before every setState
    void load(filter, category);
  }, [filter, category, load]);

  // TASK_187 C1 — a different ticket means a different invoice: close the
  // form, clear every field, and RE-INFER the plan from this ticket's category
  // so an XDevice ticket never starts pre-filled as Premium Plus. Keyed to the
  // ticket identity, so the re-read after a reply does NOT wipe a half-typed
  // invoice the admin is still working on (same id → effect does not re-run).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate reset keyed to the ticket identity (same pattern as load())
    setInvoiceing(false);
    setInvError(null);
    setInvPlan(planFromCategory(detail?.category ?? null));
    setInvAmount("");
    setInvAmountTouched(false);
    setInvDays("");
    setInvBtc("");
    setInvTrc("");
    setInvErc("");
    setInvNote("");
  }, [detail?.id, detail?.category]);

  const openTicket = useCallback(async (id: string) => {
    setError(null);
    setNotice(null);
    setSelected(id);
    setDetail(null);
    try {
      const res = await fetch(`/api/admin/support/tickets/${encodeURIComponent(id)}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(await readError(res, "Could not open that ticket."));
      const data = (await res.json()) as { ticket: TicketDetail };
      setDetail(data.ticket);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open that ticket.");
    }
  }, []);

  const sendReply = useCallback(async () => {
    if (!selected || busy || !reply.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/support/tickets/${encodeURIComponent(selected)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: reply.trim() }),
      });
      if (!res.ok) {
        setError(await readError(res, "That reply could not be sent."));
        return;
      }
      setReply("");
      setNotice("Reply sent.");
      // Re-read rather than pushing the POST response into state: an admin reply does
      // NOT reopen a resolved ticket (§7.1), and only the server knows the result.
      const again = await fetch(`/api/admin/support/tickets/${encodeURIComponent(selected)}`, {
        cache: "no-store",
      });
      if (again.ok) {
        const data = (await again.json()) as { ticket: TicketDetail };
        setDetail(data.ticket);
      }
    } catch {
      setError("Network error — the reply was not sent.");
    } finally {
      setBusy(false);
    }
  }, [selected, reply, busy]);

  /**
   * Resolve / reopen.
   *
   * Sends ONLY `status`. `category` and `priority` are omitted rather than sent as
   * null — see the PATCH semantics at the top of this file: a null there would CLEAR
   * them, which is never what an admin clicking "Resolve" intends.
   */
  const setStatus = useCallback(
    async (status: string) => {
      if (!selected || busy) return;
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const res = await fetch(`/api/admin/support/tickets/${encodeURIComponent(selected)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        });
        if (!res.ok) {
          setError(await readError(res, "Could not change the status."));
          return;
        }
        setNotice(status === RESOLVED ? "Ticket resolved." : "Ticket reopened.");
        // Both the thread AND the queue change here (the row leaves an "Open" filter),
        // so both are re-read. Skipping the list re-read is the bug where a resolved
        // ticket sits on screen until a manual refresh.
        const again = await fetch(`/api/admin/support/tickets/${encodeURIComponent(selected)}`, {
          cache: "no-store",
        });
        if (again.ok) {
          const data = (await again.json()) as { ticket: TicketDetail };
          setDetail(data.ticket);
        }
        await load(filter, category);
      } catch {
        setError("Network error — the status was not changed.");
      } finally {
        setBusy(false);
      }
    },
    [selected, busy, filter, category, load]
  );

  const composeTicket = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/support/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userEmail: newEmail.trim(),
          subject: newSubject.trim(),
          body: newBody.trim(),
        }),
      });
      if (!res.ok) {
        // Verbatim: an unknown email and a pasted credential both land here, and both
        // messages say what to do next.
        setError(await readError(res, "That ticket could not be created."));
        return;
      }
      const data = (await res.json()) as { ticket: TicketDetail };
      setComposing(false);
      setNewEmail("");
      setNewSubject("");
      setNewBody("");
      setNotice(`Ticket created for ${data.ticket.userEmail}.`);
      setSelected(data.ticket.id);
      setDetail(data.ticket);
      await load(filter, category);
    } catch {
      setError("Network error — the ticket was not created.");
    } finally {
      setBusy(false);
    }
  }, [busy, newEmail, newSubject, newBody, filter, category, load]);

  /**
   * TASK_187 C1 — open/close the invoice form, lazily loading the configured
   * price defaults the FIRST time it opens (same /api/admin/wallets read the
   * Users-tab cell does). Fail-soft: a failed prices fetch just means an empty
   * amount the admin types — never a blocked composer.
   */
  const toggleInvoice = useCallback(async () => {
    if (invoiceing) {
      setInvoiceing(false);
      return;
    }
    setInvoiceing(true);
    setInvError(null);
    if (priceDefaults) {
      if (!invAmountTouched) setInvAmount(String(priceDefaults[invPlan]));
      return;
    }
    try {
      const res = await fetch("/api/admin/wallets", { cache: "no-store" });
      if (!res.ok) return;
      const prices = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const d: PriceDefaults = {
        premium_plus: Number(prices.webSubscriptionPriceUsd),
        premium_xdevice: Number(prices.xdevicePriceUsd),
      };
      if (Number.isFinite(d.premium_plus) && Number.isFinite(d.premium_xdevice)) {
        setPriceDefaults(d);
        if (!invAmountTouched) setInvAmount(String(d[invPlan]));
      }
    } catch {
      // fail-soft — unprefilled amount, admin types it manually
    }
  }, [invoiceing, priceDefaults, invAmountTouched, invPlan]);

  /**
   * TASK_187 C1 — send the invoice, then attach it to THIS thread.
   *
   * THREE STEPS, each with its own failure story:
   *   1. POST /invoices → 201 {invoice}. A 400 carrying `invoiceId` means the
   *      ONE-OPEN-INVOICE rule fired — that id is EDITED (PATCH) instead of
   *      creating a contradiction the customer would see twice.
   *   2. POST messages {body, invoiceId} — the note (or a default) with the
   *      invoice attached, which is what renders the card in the thread. If
   *      this fails the invoice EXISTS: the error says so, the form stays open
   *      for a retry, and a retry lands on step 1's fallback path — no
   *      duplicate invoice, nothing lost.
   *   3. Re-read the detail (only the server knows the result) + notice.
   *
   * Money rules mirrored from the routes, client-side ONLY as ergonomics —
   * every one of them is re-validated server-side: amount > 0, days a whole
   * number ≥ 1 (blank = standard term, key omitted), and ALL THREE addresses
   * blank ⇒ `methods` omitted ⇒ the server snapshots the configured addrs;
   * ANY typed ⇒ the full object is sent with blanks as null (chain not
   * offered on this invoice).
   */
  const sendInvoice = useCallback(async () => {
    if (!selected || !detail?.userId || invBusy) return;
    const amt = Number(invAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setInvError("The amount must be a number greater than 0.");
      return;
    }
    const dayStr = invDays.trim();
    let days: number | undefined;
    if (dayStr !== "") {
      const n = Number(dayStr);
      if (!Number.isInteger(n) || n < 1) {
        setInvError("Duration must be a whole number of days ≥ 1 — leave it blank for the standard term.");
        return;
      }
      days = n;
    }
    const body: Record<string, unknown> = { plan: invPlan, amountUsd: amt };
    // TASK_197 S1 — this composer posts its OWN invoice-bound note (step 2),
    // so the server-side thread notice must NOT also fire: one invoice, one
    // card. threadNotice defaults true for the users-panel composer, which
    // posts no note of its own.
    body.threadNotice = false;
    if (days !== undefined) body.days = days;
    if (invBtc.trim() || invTrc.trim() || invErc.trim()) {
      body.methods = {
        btc: invBtc.trim() || null,
        usdt_trc20: invTrc.trim() || null,
        usdt_erc20: invErc.trim() || null,
      };
    }

    setInvBusy(true);
    setError(null);
    setNotice(null);
    setInvError(null);
    try {
      const url = `/api/admin/users/${encodeURIComponent(detail.userId)}/invoices`;
      let res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      let invoiceId = "";
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as { invoice?: { id?: string } };
        invoiceId = data.invoice?.id ?? "";
      } else {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          invoiceId?: string;
        };
        if (typeof data.invoiceId === "string" && data.invoiceId !== "") {
          // One open invoice per user — edit that one instead of creating a
          // second contradictory amount for the same plan.
          res = await fetch(`${url}/${encodeURIComponent(data.invoiceId)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          if (!res.ok) {
            const patched = (await res.json().catch(() => ({}))) as { error?: string };
            setInvError(
              typeof patched.error === "string" && patched.error !== ""
                ? patched.error
                : "The existing open invoice could not be updated.",
            );
            return;
          }
          invoiceId = data.invoiceId;
        } else {
          setInvError(
            typeof data.error === "string" && data.error !== ""
              ? data.error
              : "The invoice could not be sent.",
          );
          return;
        }
      }
      if (invoiceId === "") {
        setInvError("The invoice was saved but its id came back empty — check the Users tab.");
        return;
      }

      // The customer-facing note: a default when the admin typed nothing, so
      // a bare card never arrives with an empty message above it.
      const note =
        invNote.trim() ||
        `Your ${invPlan === "premium_xdevice" ? "Premium XDevice" : "Premium Plus"} invoice is ready — the card below has the amount and payment addresses.`;
      const mres = await fetch(
        `/api/admin/support/tickets/${encodeURIComponent(selected)}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: note, invoiceId }),
        },
      );
      if (!mres.ok) {
        setInvError(
          `Invoice saved, but attaching it to this thread failed: ${await readError(mres, "the message was not posted")}`,
        );
        return;
      }

      // Success — close + reset; the ticket-keyed effect re-infers the plan next time.
      setInvoiceing(false);
      setInvNote("");
      setInvDays("");
      setInvBtc("");
      setInvTrc("");
      setInvErc("");
      setInvAmountTouched(false);
      setInvAmount("");
      setNotice("Invoice sent and attached to this thread.");
      const again = await fetch(
        `/api/admin/support/tickets/${encodeURIComponent(selected)}`,
        { cache: "no-store" },
      );
      if (again.ok) {
        const data = (await again.json()) as { ticket: TicketDetail };
        setDetail(data.ticket);
      }
    } catch {
      setInvError("Network error — the invoice was not sent.");
    } finally {
      setInvBusy(false);
    }
  }, [selected, detail, invBusy, invPlan, invAmount, invDays, invBtc, invTrc, invErc, invNote]);

  /**
   * TASK_199 S2 — send the broadcast. The response is COUNTS ONLY (the route
   * never returns who), so the success line reads "sent N of M" and nothing
   * else. "Everyone" emails every account on the platform — one confirm, one
   * click, and the composer closes on success so it cannot be double-sent by
   * accident. The server re-validates audience + body regardless.
   */
  const sendBroadcast = useCallback(async () => {
    if (bcastBusy || !bcastBody.trim()) return;
    if (
      bcastAudience === "everyone" &&
      !window.confirm(
        "Send this message to EVERY user? Each one gets a support message and an email.",
      )
    ) {
      return;
    }
    setBcastBusy(true);
    setBcastError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/support/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audience: bcastAudience, body: bcastBody.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        targeted?: number;
        sent?: number;
        failed?: number;
      };
      if (!res.ok) throw new Error(data.error || "Could not send the broadcast.");
      setNotice(
        `Broadcast sent — ${data.sent ?? 0} of ${data.targeted ?? 0} user(s)` +
          ((data.failed ?? 0) > 0 ? `, ${data.failed} failed.` : "."),
      );
      setBcastBody("");
      setBcastOpen(false);
    } catch (e) {
      setBcastError(e instanceof Error ? e.message : "Could not send the broadcast.");
    } finally {
      setBcastBusy(false);
    }
  }, [bcastBusy, bcastAudience, bcastBody]);

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-semibold tracking-tight">Support</h2>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-lg border border-border">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.value || "all"}
                type="button"
                onClick={() => setFilter(f.value)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  filter === f.value
                    ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                    : "text-fg-muted hover:bg-black/5 dark:hover:bg-white/5"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          {/* TASK_184 B2 — the plan filter: every plan / Premium Plus (tier 5) /
              Premium XDevice (tier 3). Backed by ?category= the route already passes
              through to listAdminTickets' exact match — no backend change. */}
          <div className="flex overflow-hidden rounded-lg border border-border">
            {CATEGORY_FILTERS.map((f) => (
              <button
                key={f.value || "all-plans"}
                type="button"
                onClick={() => setCategory(f.value)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  category === f.value
                    ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                    : "text-fg-muted hover:bg-black/5 dark:hover:bg-white/5"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <Button
            variant="secondary"
            className="px-3 py-1.5 text-xs"
            onClick={() => {
              setComposing((v) => !v);
              setError(null);
            }}
          >
            {composing ? "Cancel" : "New ticket for a customer"}
          </Button>
          {/* TASK_199 S2 — broadcast to everyone or one tier. */}
          <Button
            variant="secondary"
            className="px-3 py-1.5 text-xs"
            onClick={() => {
              setBcastOpen((v) => !v);
              setBcastError(null);
            }}
          >
            {bcastOpen ? "Cancel" : "Broadcast"}
          </Button>
        </div>
      </div>

      {composing && (
        <div className="mt-4 flex flex-col gap-2 rounded-xl border border-border bg-bg-elevated p-4">
          <Input
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            placeholder="Customer's email address"
            aria-label="Customer email"
          />
          <Input
            value={newSubject}
            onChange={(e) => setNewSubject(e.target.value)}
            placeholder="Subject"
            maxLength={200}
            aria-label="Subject"
          />
          <Textarea
            value={newBody}
            onChange={(e) => setNewBody(e.target.value)}
            placeholder="What they told you, in your words."
            rows={4}
            maxLength={10_000}
            aria-label="Message"
          />
          <p className="text-xs text-fg-muted">
            The ticket is filed on their account, so it appears in their own Support list.
            Never paste a credential here — the same refusal the customer gets applies.
          </p>
          <Button
            className="self-start text-xs"
            disabled={busy || !newEmail.trim() || !newSubject.trim() || !newBody.trim()}
            onClick={() => void composeTicket()}
          >
            {busy ? "Creating…" : "Create ticket"}
          </Button>
        </div>
      )}

      {bcastOpen && (
        <div className="mt-4 flex flex-col gap-2 rounded-xl border border-border bg-bg-elevated p-4">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs font-medium text-fg-muted" htmlFor="bcast-audience">
              Send to
            </label>
            {/* Mirrors BROADCAST_AUDIENCES in lib/support/tickets.ts — the server
                rejects any value outside that enum with a 400. */}
            <select
              id="bcast-audience"
              value={bcastAudience}
              onChange={(e) => setBcastAudience(e.target.value as BroadcastAudience)}
              className="rounded-lg border border-border bg-bg-elevated px-3 py-2 text-sm text-fg focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
            >
              <option value="everyone">Everyone</option>
              <option value="free">Free users</option>
              <option value="xdevice">Premium XDevice</option>
              <option value="plus">Premium Plus</option>
            </select>
          </div>
          {/* TASK_199 S2 — one-tap templates (lib/support-templates.ts). Picking
              one REPLACES the textarea deterministically — no append-merge to
              double-fire on accidental clicks; the admin always edits after. */}
          <div className="flex flex-wrap gap-1.5">
            {BROADCAST_TEMPLATES.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                onClick={() => setBcastBody(tpl.body)}
                className="rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-fg-muted transition-colors hover:bg-black/5 dark:hover:bg-white/5"
              >
                {tpl.label}
              </button>
            ))}
          </div>
          <Textarea
            value={bcastBody}
            onChange={(e) => setBcastBody(e.target.value)}
            placeholder="The message every selected user receives in their Support thread (and by email). Pick a template above or write your own."
            rows={5}
            maxLength={5000}
            aria-label="Broadcast message"
          />
          <p className="text-xs text-fg-muted">
            Each user gets it in their own Support thread — their open thread, or a new
            “Announcement” thread if they have none. The same credential refusal the
            customer gets applies here.
          </p>
          {bcastError && (
            <p className="text-xs text-red-600 dark:text-red-400">{bcastError}</p>
          )}
          <Button
            className="self-start text-xs"
            disabled={bcastBusy || !bcastBody.trim()}
            onClick={() => void sendBroadcast()}
          >
            {bcastBusy ? "Sending…" : "Send broadcast"}
          </Button>
        </div>
      )}

      {error && (
        <p className="mt-3 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </p>
      )}
      {notice && !error && (
        <p className="mt-3 rounded-lg border border-green-300 bg-green-50 p-3 text-sm text-green-700 dark:border-green-800 dark:bg-green-950/30 dark:text-green-300">
          {notice}
        </p>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <div className="rounded-xl border border-border">
          {listError ? (
            <p className="p-4 text-sm text-red-600 dark:text-red-400">{listError}</p>
          ) : tickets === null ? (
            <p className="p-4 text-sm text-fg-muted">Loading…</p>
          ) : tickets.length === 0 ? (
            <p className="p-4 text-sm text-fg-muted">Nothing here.</p>
          ) : (
            <ul className="divide-y divide-border">
              {tickets.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => void openTicket(t.id)}
                    className={`w-full px-4 py-3 text-left transition-colors hover:bg-black/5 dark:hover:bg-white/5 ${
                      selected === t.id ? "bg-black/5 dark:bg-white/5" : ""
                    }`}
                  >
                    <span className="flex items-start justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                        {t.subject}
                      </span>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                          isResolved(t.status)
                            ? "bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300"
                            : "bg-brand-600/10 text-brand-600 dark:text-brand-400"
                        }`}
                      >
                        {/* Any UNKNOWN status renders verbatim rather than being forced
                            into "Open" — a future "waiting_on_customer" must not be
                            mislabelled as something the admin did not write. */}
                        {isResolved(t.status) ? "Resolved" : t.status}
                      </span>
                    </span>
                    <span className="mt-1 block text-xs text-fg-muted">
                      {/* TASK_184 B2 — a premium request announces its plan right in
                          the queue row, before anyone opens the thread. */}
                      {isPremiumRequestCategory(t.category) && (
                        <span className="mr-1.5 rounded-full bg-brand-600/10 px-1.5 py-0.5 text-[10px] font-medium text-brand-600 dark:text-brand-400">
                          {PREMIUM_REQUEST_TEMPLATES[t.category].planName}
                        </span>
                      )}
                      {t.messageCount} message{t.messageCount === 1 ? "" : "s"} ·{" "}
                      {when(t.lastMessageAt ?? t.createdAt)}
                      {t.priority && ` · ${t.priority}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>



        <div className="rounded-xl border border-border p-4">
          {!selected ? (
            <p className="text-sm text-fg-muted">Select a ticket to read it.</p>
          ) : !detail ? (
            <p className="text-sm text-fg-muted">Loading…</p>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-lg font-semibold text-fg">{detail.subject}</h3>
                  <p className="mt-0.5 text-xs text-fg-muted">
                    {detail.userEmail} · opened {when(detail.createdAt)}
                    {/* LIVE domain state, never a copied apex — §3.3. */}
                    {detail.domain && ` · ${detail.domain.apex} (${detail.domain.status})`}
                  </p>
                </div>
                <Button
                  variant={isResolved(detail.status) ? "secondary" : "primary"}
                  className="px-3 py-1.5 text-xs"
                  disabled={busy}
                  onClick={() => void setStatus(isResolved(detail.status) ? "open" : RESOLVED)}
                >
                  {isResolved(detail.status) ? "Reopen" : "Resolve"}
                </Button>
              </div>

              <div className="mt-4 flex flex-col gap-3">
                {detail.messages.map((m) => (
                  <div
                    key={m.id}
                    className={`rounded-xl px-3 py-2 ${
                      m.authorRole === "admin"
                        ? "bg-black/5 dark:bg-white/5"
                        : "bg-brand-600/10"
                    }`}
                  >
                    <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-fg-muted">
                      {m.authorRole === "admin" ? "Support" : "Customer"} · {when(m.createdAt)}
                    </p>
                    {/* `break-words` is load-bearing, not cosmetic: a pasted URL or a
                        token-shaped blob with no spaces would otherwise stretch this
                        layout sideways. Ticket bodies are untrusted customer text, and
                        the admin view is the one place they are rendered longest. */}
                    <p className="whitespace-pre-wrap break-words text-sm text-fg">{m.body}</p>
                    {/* TASK_187 C2 — the invoice card, resolved LIVE from the
                        message's soft ref (the admin side sees every ticket's). */}
                    {m.invoice && <SupportInvoiceCard invoice={m.invoice} />}
                  </div>
                ))}
              </div>

              {/* TASK_187 C1 — the money composer, between the thread and the
                  reply box. Admin-only (userId exists only on admin reads):
                  the term override and payout-address overrides live exactly
                  HERE — the customer's side never renders either. */}
              {detail.userId && (
                <div className="mt-4 border-t border-border pt-4">
                  <Button
                    variant="secondary"
                    className="px-3 py-1.5 text-xs"
                    disabled={invBusy}
                    onClick={() => void toggleInvoice()}
                  >
                    {invoiceing ? "Cancel" : "Send invoice"}
                  </Button>
                  {invoiceing && (
                    <div className="mt-3 flex flex-col gap-2 rounded-xl border border-border bg-bg-elevated p-3">
                      <div className="flex flex-wrap gap-2">
                        <select
                          value={invPlan}
                          onChange={(e) => {
                            const p = e.target.value as PlanName;
                            setInvPlan(p);
                            // Re-prefill the amount with the new plan's default
                            // unless the admin has already typed their own —
                            // same rule as the Users-tab cell.
                            if (!invAmountTouched && priceDefaults) {
                              setInvAmount(String(priceDefaults[p]));
                            }
                          }}
                          aria-label="Invoice plan"
                          className="rounded-lg border border-border bg-bg-elevated px-2 py-2 text-sm text-fg focus:border-brand-500 focus:outline-none"
                        >
                          {PLAN_OPTIONS.map((p) => (
                            <option key={p.value} value={p.value}>
                              {p.label}
                            </option>
                          ))}
                        </select>
                        <Input
                          type="number"
                          min={0.01}
                          step={0.01}
                          value={invAmount}
                          onChange={(e) => {
                            setInvAmountTouched(true);
                            setInvAmount(e.target.value);
                          }}
                          placeholder="Amount (USD)"
                          aria-label="Invoice amount (USD)"
                          className="w-36"
                        />
                        <Input
                          type="number"
                          min={1}
                          step={1}
                          value={invDays}
                          onChange={(e) => setInvDays(e.target.value)}
                          placeholder="Duration days (blank = standard)"
                          aria-label="Invoice duration in days (optional)"
                          className="w-52"
                        />
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Input
                          value={invBtc}
                          onChange={(e) => setInvBtc(e.target.value)}
                          placeholder="BTC address (blank = default)"
                          aria-label="BTC payout address"
                        />
                        <Input
                          value={invTrc}
                          onChange={(e) => setInvTrc(e.target.value)}
                          placeholder="USDT TRC-20 (blank = default)"
                          aria-label="USDT TRC-20 payout address"
                        />
                        <Input
                          value={invErc}
                          onChange={(e) => setInvErc(e.target.value)}
                          placeholder="USDT ERC-20 (blank = default)"
                          aria-label="USDT ERC-20 payout address"
                        />
                      </div>
                      <Textarea
                        value={invNote}
                        onChange={(e) => setInvNote(e.target.value)}
                        placeholder="Note to the customer (optional — a default message is used when blank)"
                        rows={2}
                        maxLength={10_000}
                        aria-label="Invoice note"
                      />
                      <p className="text-[11px] text-fg-muted">
                        Leave every address blank to send with the configured defaults. If any
                        address is typed, the invoice goes out with exactly what is shown — a
                        blank line hides that chain.
                      </p>
                      {invError && (
                        <p className="text-xs text-red-600 dark:text-red-400">{invError}</p>
                      )}
                      <Button
                        className="self-start text-xs"
                        disabled={invBusy || !invAmount.trim()}
                        onClick={() => void sendInvoice()}
                      >
                        {invBusy ? "Sending…" : "Send invoice"}
                      </Button>
                    </div>
                  )}
                </div>
              )}

              <div className="mt-4 flex flex-col gap-2 border-t border-border pt-4">
                <Textarea
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  placeholder="Reply to the customer…"
                  rows={3}
                  maxLength={10_000}
                  aria-label="Reply"
                />
                <Button
                  className="self-start text-xs"
                  disabled={busy || !reply.trim()}
                  onClick={() => void sendReply()}
                >
                  {busy ? "Sending…" : "Send reply"}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
