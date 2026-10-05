"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Button, Input, Textarea } from "@/components/ui";

// TASK_161 D3 — the customer support entry point.
//
// TASK_159 Phase 1 shipped the whole ticket BACK END — user list/create/reply, admin
// queue/reply/resolve — and every route was correct, with no UI anywhere pointing at
// one. That is the same failure shape as the Billing page: a complete feature a
// customer cannot reach. This file is the whole of that fix on the customer side.
//
// WHAT THIS WIDGET DELIBERATELY IS NOT (each omission is a decision):
//
//   * NO UPLOAD, NO FILE PICKER. The plan defers attachments (§5). More importantly an
//     attachment is the most natural place to leak a Cloudflare token, and the
//     credential scan in the service can only see TEXT. A file input would build the
//     paste-target §2.1 exists to prevent while every panel claimed the feature was
//     safe. Absent until the scanner can read files.
//
//   * NO USER-SET PRIORITY. Priority is a string the ADMIN triages with (§3.2); a
//     user-set priority is a dispatch promise the queue cannot keep. The composer
//     sends no priority and no control implies one.
//
//   * NO TICKET DELETION, EVER. History that can be erased is not history (§2.3).
//     There is no delete control to disable, because a disabled button still ships.
//
// CREDENTIALS: the service refuses to store a body containing a token and returns a
// 422 explaining why. This panel surfaces that message VERBATIM rather than replacing
// it with a generic "invalid request" — the refusal is the product here, and a user
// who pastes a key needs to be told what to do instead, only that it failed.

interface TicketRow {
  id: string;
  subject: string;
  status: string;
  messageCount: number;
  lastMessageAt: string | null;
  createdAt: string;
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
}

/** A short, locale-independent stamp. Never used to decide anything. */
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

/** The ONLY value that means closed — mirrors RESOLVED_STATUS in lib/support/tickets.ts. */
function isResolved(status: string): boolean {
  return status === "resolved";
}

/**
 * Pull the human-readable message out of the API's error envelope.
 *
 * The routes answer `{error, code}`; a credential refusal puts a full sentence in
 * `error`, and that is the one message worth reading, so it must survive to the screen.
 */
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
 * The one error surface in this panel.
 *
 * Deliberately styled as a warning about the CONTENT rather than a generic toast: the
 * most common error here is a pasted credential, and the service's refusal text is an
 * instruction ("remove it and describe what you need instead"). Rendering it inline next
 * to the box that contains the offending text is what makes that instruction readable
 * before the user hits send again.
 */
function ErrorNote({ children }: { children: string }) {
  return (
    <p className="rounded-lg border border-red-300 bg-red-50 p-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">
      {children}
    </p>
  );
}

export function SupportWidget() {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"list" | "compose" | "thread">("list");
  const [tickets, setTickets] = useState<TicketRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detail, setDetail] = useState<TicketDetail | null>(null);

  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  /**
   * Guards double submits.
   *
   * `submitting` alone is not enough: React batches state, so two clicks in the same
   * tick both read `submitting === false` and both POST. On a support form that means
   * two identical tickets, which is exactly the "why did I get two of these" bug that
   * erodes trust in a help desk. A ref updates synchronously.
   */
  const busyRef = useRef(false);

  const loadList = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/support/tickets", { cache: "no-store" });
      if (!res.ok) throw new Error(await readError(res, "Could not load your tickets."));
      const data = (await res.json()) as { tickets: TicketRow[] };
      setTickets(data.tickets);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load your tickets.");
      setTickets(null);
    }
  }, []);

  // House pattern (cf. components/wallet-balance.tsx): fire-and-forget on mount so the
  // effect body returns void rather than a setState promise. Loaded on OPEN, not on
  // mount, so a customer who never opens support never pays for the request.
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load() awaits fetch before every setState
    void loadList();
  }, [open, loadList]);

  const openThread = useCallback(async (id: string) => {
    setFormError(null);
    setDetail(null);
    setView("thread");
    try {
      const res = await fetch(`/api/support/tickets/${encodeURIComponent(id)}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(await readError(res, "Could not open that ticket."));
      const data = (await res.json()) as { ticket: TicketDetail };
      setDetail(data.ticket);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Could not open that ticket.");
      setView("list");
    }
  }, []);

  const submitTicket = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setSubmitting(true);
    setFormError(null);
    try {
      const res = await fetch("/api/support/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: subject.trim(), body: body.trim() }),
      });
      if (!res.ok) {
        // Verbatim: a credential refusal is an explanation, not a generic failure.
        setFormError(await readError(res, "That ticket could not be sent."));
        return;
      }
      const data = (await res.json()) as { ticket: TicketDetail };
      setSubject("");
      setBody("");
      setDetail(data.ticket);
      setView("thread");
      await loadList();
    } catch {
      setFormError("Network error — your message was not sent.");
    } finally {
      busyRef.current = false;
      setSubmitting(false);
    }
  }, [subject, body, loadList]);


  const sendReply = useCallback(async () => {
    if (busyRef.current || !detail) return;
    busyRef.current = true;
    setSubmitting(true);
    setFormError(null);
    try {
      const res = await fetch(`/api/support/tickets/${encodeURIComponent(detail.id)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: body.trim() }),
      });
      if (!res.ok) {
        setFormError(await readError(res, "That reply could not be sent."));
        return;
      }
      setBody("");
      // Re-read the thread rather than pushing the POST response into state: a reply
      // REOPENS a resolved ticket (§7.1) and only the server knows that.
      const again = await fetch(`/api/support/tickets/${encodeURIComponent(detail.id)}`, {
        cache: "no-store",
      });
      if (again.ok) {
        const data = (await again.json()) as { ticket: TicketDetail };
        setDetail(data.ticket);
      }
      await loadList();
    } catch {
      setFormError("Network error — your reply was not sent.");
    } finally {
      busyRef.current = false;
      setSubmitting(false);
    }
  }, [detail, body, loadList]);

  return (
    <div className="fixed bottom-5 left-5 z-50 flex flex-col items-start gap-3">
      {open && (
        <div className="flex max-h-[70vh] w-[22rem] flex-col overflow-hidden rounded-2xl border border-border bg-bg-elevated shadow-2xl">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <p className="text-sm font-semibold text-fg">Support</p>
            <div className="flex items-center gap-1">
              {view !== "list" && (
                <Button
                  variant="ghost"
                  className="px-2 py-1 text-xs"
                  onClick={() => {
                    setFormError(null);
                    setView("list");
                  }}
                >
                  Back
                </Button>
              )}
              {view === "list" && (
                <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => void loadList()}>
                  Refresh
                </Button>
              )}
              <Button
                variant="ghost"
                className="px-2 py-1 text-xs"
                onClick={() => {
                  setOpen(false);
                  setView("list");
                  setFormError(null);
                }}
              >
                Close
              </Button>
            </div>
          </div>


          {view === "list" && (
            <div className="overflow-y-auto p-3">
              <Button
                className="w-full text-sm"
                onClick={() => {
                  setFormError(null);
                  setView("compose");
                }}
              >
                New ticket
              </Button>

              {loadError ? (
                <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                  {loadError}
                </p>
              ) : tickets === null ? (
                <p className="mt-3 text-xs text-fg-muted">Loading…</p>
              ) : tickets.length === 0 ? (
                <p className="mt-3 text-xs text-fg-muted">
                  No tickets yet. Open one and a human will reply here.
                </p>
              ) : (
                <ul className="mt-3 flex flex-col gap-1">
                  {tickets.map((t) => (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => void openThread(t.id)}
                        className="w-full rounded-lg px-2 py-2 text-left transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                      >
                        <span className="flex items-start justify-between gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm text-fg">{t.subject}</span>
                          <span
                            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                              isResolved(t.status)
                                ? "bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300"
                                : "bg-brand-600/10 text-brand-600 dark:text-brand-400"
                            }`}
                          >
                            {isResolved(t.status) ? "Resolved" : "Open"}
                          </span>
                        </span>
                        <span className="mt-0.5 block text-[11px] text-fg-muted">
                          {t.messageCount} message{t.messageCount === 1 ? "" : "s"} ·{" "}
                          {when(t.lastMessageAt ?? t.createdAt)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}



          {view === "compose" && (
            <div className="flex flex-col gap-2 overflow-y-auto p-3">
              <Input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Subject"
                maxLength={200}
                aria-label="Subject"
              />
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="What happened? What did you expect?"
                rows={6}
                maxLength={10_000}
                aria-label="Message"
              />
              <p className="text-[11px] text-fg-muted">
                Do not paste passwords, tokens or API keys — a ticket containing one is
                rejected and never stored.
              </p>
              {formError && <ErrorNote>{formError}</ErrorNote>}
              <Button
                className="text-sm"
                disabled={submitting || !subject.trim() || !body.trim()}
                onClick={() => void submitTicket()}
              >
                {submitting ? "Sending…" : "Send ticket"}
              </Button>
            </div>
          )}

          {view === "thread" && (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                {!detail ? (
                  <p className="text-xs text-fg-muted">Loading…</p>
                ) : (
                  <>
                    <p className="text-sm font-semibold text-fg">{detail.subject}</p>
                    <p className="mt-0.5 text-[11px] text-fg-muted">
                      {isResolved(detail.status) ? "Resolved" : "Open"} · opened{" "}
                      {when(detail.createdAt)}
                      {/* The domain is rendered with its LIVE status, never a snapshot —
                          §3.3: a copied apex goes stale and then lies. */}
                      {detail.domain && ` · ${detail.domain.apex} (${detail.domain.status})`}
                    </p>

                    <div className="mt-3 flex flex-col gap-2">
                      {detail.messages.map((m) => (
                        <div
                          key={m.id}
                          className={`rounded-xl px-3 py-2 text-sm ${
                            m.authorRole === "admin"
                              ? "bg-black/5 dark:bg-white/5"
                              : "bg-brand-600/10"
                          }`}
                        >
                          <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-fg-muted">
                            {m.authorRole === "admin" ? "Support" : "You"} · {when(m.createdAt)}
                          </p>
                          <p className="whitespace-pre-wrap break-words text-fg">{m.body}</p>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>

              <div className="flex flex-col gap-2 border-t border-border p-3">
                <Textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder={isResolved(detail?.status ?? "") ? "Reply to reopen…" : "Add a reply…"}
                  rows={3}
                  maxLength={10_000}
                  aria-label="Reply"
                />
                {formError && <ErrorNote>{formError}</ErrorNote>}
                <Button
                  className="text-sm"
                  disabled={submitting || !detail || !body.trim()}
                  onClick={() => void sendReply()}
                >
                  {submitting ? "Sending…" : "Send reply"}
                </Button>
                {isResolved(detail?.status ?? "") && (
                  <p className="text-[11px] text-fg-muted">
                    This ticket is resolved. A reply reopens it so your answer is not buried.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-600 text-white shadow-xl transition-transform hover:scale-105 hover:bg-brand-700"
        aria-label={open ? "Close support" : "Open support"}
      >
        {open ? (
          <span className="text-xl">✕</span>
        ) : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2ZM7 9h10v2H7V9Zm0-4h10v2H7V5Zm0 8h7v2H7v-2Z"
              fill="currentColor"
            />
          </svg>
        )}
      </button>
    </div>
  );
}

