"use client";

import { useCallback, useEffect, useState } from "react";

import { Button, Input, Textarea } from "@/components/ui";

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
}

interface TicketDetail extends TicketRow {
  messages: Message[];
  domain: { id: string; apex: string; status: string } | null;
  userEmail: string;
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

export default function SupportQueuePanel() {
  const [filter, setFilter] = useState<string>("open");
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

  const load = useCallback(async (status: string) => {
    setListError(null);
    try {
      // An empty filter is sent as an ABSENT parameter, not `status=` — the service
      // ignores an empty filter rather than matching `status = ''`, which would render
      // as "there are no tickets" instead of "show me everything".
      const qs = status ? `?status=${encodeURIComponent(status)}` : "";
      const res = await fetch(`/api/admin/support/tickets${qs}`, { cache: "no-store" });
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
    void load(filter);
  }, [filter, load]);

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
        await load(filter);
      } catch {
        setError("Network error — the status was not changed.");
      } finally {
        setBusy(false);
      }
    },
    [selected, busy, filter, load]
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
      await load(filter);
    } catch {
      setError("Network error — the ticket was not created.");
    } finally {
      setBusy(false);
    }
  }, [busy, newEmail, newSubject, newBody, filter, load]);

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
                  </div>
                ))}
              </div>

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
