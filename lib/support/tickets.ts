import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { describeCredentialIn } from "./redact";

// ---------------------------------------------------------------------------
// TASK_159 Phase 1 — the support-ticket service.
//
// Scope: PLAN_TASK_159_SUPPORT_TICKETS.md §5. Models + user list/create/reply +
// admin queue/reply/resolve. Attachments, email, SLA timers, assignment and search
// are deliberately absent (plan §5).
//
// THE THREE RULES THIS FILE ENFORCES, because they are the ones that fail silently
// if they are merely "handled in the UI":
//
//   1. OWNERSHIP FROM THE SESSION (§2.2). Every user-scoped function takes the
//      caller's id as its FIRST argument and filters on it. The id is never read
//      from a request body — that is how a crafted POST files a ticket against, or
//      reads the thread of, somebody else.
//
//   2. 404, NOT 403, FOR SOMEONE ELSE'S TICKET (§4). A 403 confirms "this id exists
//      and is not yours", which is a free enumeration oracle over other customers'
//      support threads. Not-yours and does-not-exist must be indistinguishable.
//
//   3. NO CREDENTIAL ANYWHERE (§2.1). Both the subject and every body are scanned
//      before they are stored, using the same detector the composer redacts with.
//
// Everything returns `SupportResult<T>` rather than throwing, matching the
// `HostingResult` convention the hosting routes already use, so each route is a
// single `.ok` branch and no route invents its own error shape.
// ---------------------------------------------------------------------------

export type SupportResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string };

/** Caps chosen so a ticket stays a message and not an upload (§5 defers attachments). */
const MAX_SUBJECT_LEN = 200;
const MAX_BODY_LEN = 10_000;

/**
 * The ONLY value that means "closed".
 *
 * Everything else — including a status this code has never seen — still needs
 * attention. That direction matters: the failure we must never have is a ticket
 * quietly vanishing from the queue because someone added a status string that this
 * reader did not anticipate (see the migration's note on why there is no CHECK).
 */
export const RESOLVED_STATUS = "resolved";

/** Who wrote a message. Pinned to this exact pair by a CHECK in the migration. */
export const AUTHOR_USER = "user";
export const AUTHOR_ADMIN = "admin";

/** A plain-language name for the domain a ticket is about. Never copied from input. */
export interface TicketDomainRef {
  id: string;
  apex: string;
  status: string;
}

/**
 * TASK_187 B4 — an invoice attached to a thread message, as BOTH sides see it.
 *
 * `days` is deliberately ABSENT: it is an admin-only term override and must
 * never reach a user-facing payload (TASK_181). The resolver below does not
 * even select it, so there is no code path that could leak it.
 */
export interface ThreadInvoiceView {
  id: string;
  plan: string;
  tier: number;
  amountUsd: number;
  status: string;
  methods: unknown; // Json — the same {btc, usdt_trc20, usdt_erc20} shape the billing card renders
  createdAt: string;
  paidAt: string | null;
}

export interface SupportMessageView {
  id: string;
  authorRole: string;
  body: string;
  createdAt: string;
  /**
   * TASK_187 — the soft invoice ref stored on the row. Always present on
   * DETAIL reads (null = no invoice attached); plain create-returns may omit.
   */
  invoiceId?: string | null;
  /** TASK_187 — resolved LIVE at read time; null = dangling/not-this-user ref. */
  invoice?: ThreadInvoiceView | null;
}

export interface SupportTicketView {
  id: string;
  subject: string;
  status: string;
  category: string | null;
  priority: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  messageCount: number;
  lastMessageAt: string | null;
  /**
   * TASK_166 — an admin has replied and the owner has not opened the ticket since.
   *
   * A per-ticket BOOLEAN, not a count of unread messages, because the button shows a
   * count of unread THREADS ("3 new") and because the newest-message derivation cannot
   * honestly produce a per-message number (see `isUnread`). A wrong number on a badge is
   * worse than a coarser true one.
   */
  unread: boolean;
}

export interface SupportTicketDetailView extends SupportTicketView {
  messages: SupportMessageView[];
  /** Resolved LIVE at read time, never snapshotted into the ticket (plan §3.3). */
  domain: TicketDomainRef | null;
  /** Admin views only; omitted for the ticket's own owner. */
  userEmail?: string;
  /**
   * TASK_187 B7 — the OWNER's id, admin views only, for the invoice composer
   * (POST /api/admin/users/[id]/invoices needs the target user). Same
   * admin-only rule as userEmail: the owner already knows their own id, and a
   * non-owner must never see it.
   */
  userId?: string;
}

/**
 * The refusal for rule 3. It names the SHAPE it saw ("a Cloudflare API token") and
 * never the match, because this message is shown to the user and may be logged —
 * echoing the value would put the secret into the very text that exists to keep it
 * out. It also tells the user what to do instead, because a refusal with no next
 * step is what makes people paste it a second time.
 */
function credentialRefusal(label: string): SupportResult<never> {
  return {
    ok: false,
    status: 422,
    code: "credential_in_ticket",
    message: `That looks like ${label}, so it was not saved. Tickets are never a safe place for a token — please remove it and describe what you need instead. If we ever need a credential from you, we will ask for it through a separate, audited flow.`,
  };
}

/** Trim, and refuse the two things a subject can never be (empty, or a secret). */
function validateSubject(subject: string): SupportResult<string> {
  const trimmed = subject.trim();
  if (trimmed === "") {
    return { ok: false, status: 422, code: "empty_subject", message: "Give the ticket a subject." };
  }
  if (trimmed.length > MAX_SUBJECT_LEN) {
    return {
      ok: false,
      status: 422,
      code: "subject_too_long",
      message: `Keep the subject under ${MAX_SUBJECT_LEN} characters.`,
    };
  }
  const credential = describeCredentialIn(trimmed);
  if (credential) return credentialRefusal(credential);
  return { ok: true, value: trimmed };
}

/** Trim, and refuse the two things a body can never be (empty, or a secret). */
function validateBody(body: string): SupportResult<string> {
  const trimmed = body.trim();
  if (trimmed === "") {
    return { ok: false, status: 422, code: "empty_body", message: "Write a message." };
  }
  if (trimmed.length > MAX_BODY_LEN) {
    return {
      ok: false,
      status: 422,
      code: "body_too_long",
      message: `Keep the message under ${MAX_BODY_LEN} characters.`,
    };
  }
  const credential = describeCredentialIn(trimmed);
  if (credential) return credentialRefusal(credential);
  return { ok: true, value: trimmed };
}

/**
 * Resolve `domainRefId` to a domain the CALLER owns, or refuse.
 *
 * Two deliberate choices:
 *   * BOTH halves of the ownership boundary are checked together (`ownerKind` AND
 *     `ownerUserId`), never `ownerUserId` alone — the rule `UserDomain` itself
 *     documents, because a platform row has a NULL user id.
 *   * a failure answers 404, not 403: "that domain is not yours" would confirm the
 *     domain exists, which is the same enumeration oracle the ticket routes avoid.
 */
async function resolveOwnedDomain(
  userId: string,
  domainRefId: string
): Promise<SupportResult<TicketDomainRef>> {
  const row = await prisma.userDomain.findUnique({
    where: { id: domainRefId },
    select: { id: true, apex: true, status: true, ownerKind: true, ownerUserId: true },
  });
  if (!row || row.ownerKind !== "user" || row.ownerUserId !== userId) {
    return {
      ok: false,
      status: 404,
      code: "domain_not_found",
      message: "That domain isn't on your account.",
    };
  }
  return { ok: true, value: { id: row.id, apex: row.apex, status: row.status } };
}

/** "" and whitespace become NULL, so an empty filter box does not become a real value. */
function cleanOptional(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** The one shape a "not yours / not there" answer takes — see rule 2 at the top. */
function ticketNotFound(): SupportResult<never> {
  return { ok: false, status: 404, code: "ticket_not_found", message: "Ticket not found." };
}

/**
 * The list projection. Shared by every listing so a new column can never appear in
 * one view and be missing from another.
 *
 * `messages: take 1 / desc` is how the list shows "last activity" without pulling
 * every body in the thread into a queue that only renders a preview line.
 */
const TICKET_LIST_SELECT = {
  id: true,
  subject: true,
  status: true,
  category: true,
  priority: true,
  createdAt: true,
  updatedAt: true,
  resolvedAt: true,
  domainRefId: true,
  lastReadAt: true,
  _count: { select: { messages: true } },
  // TASK_166 — `authorRole` was added to this projection so the unread flag can be
  // derived from ONE row instead of a second query per ticket. See `toTicketView`.
  messages: {
    take: 1,
    orderBy: { createdAt: "desc" as const },
    select: { createdAt: true, authorRole: true },
  },
} satisfies Prisma.SupportTicketSelect;

/** Structural type for a row shaped by `TICKET_LIST_SELECT`. */
interface TicketListRow {
  id: string;
  subject: string;
  status: string;
  category: string | null;
  priority: string | null;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
  domainRefId: string | null;
  lastReadAt: Date | null;
  _count: { messages: number };
  messages: Array<{ createdAt: Date; authorRole?: string }>;
}

/**
 * TASK_166 — "has an admin said something the customer has not looked at?"
 *
 * Derived from the newest message in the projection plus `lastReadAt`. Two deliberate
 * choices, both about being honest about what a single-row projection can see:
 *
 *   * It is the NEWEST message that decides, not "any unread admin message anywhere".
 *     A filtered COUNT per ticket would mean a second query per ticket purely for a
 *     badge, and the list already loads one message per ticket — so this reads that
 *     row. The state it cannot see (an older unread admin reply that the customer has
 *     since replied to) is not one worth preserving: the customer demonstrably read
 *     the thread, because they typed in it.
 *
 *   * `lastReadAt === null` means UNREAD, never "read" (see the migration). Every
 *     ticket that predates the column has null there, and the recoverable direction is
 *     to badge a reply that really is sitting there.
 *
 * A ticket with NO messages cannot be unread, and a ticket whose newest message is the
 * customer's own is not unread either — replying is itself reading.
 */
function isUnread(
  messages: Array<{ createdAt: Date; authorRole?: string }>,
  lastReadAt: Date | null
): boolean {
  if (messages.length === 0) return false;
  const newest = messages.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
  if (newest.authorRole !== AUTHOR_ADMIN) return false;
  return lastReadAt === null || newest.createdAt > lastReadAt;
}

function toTicketView(row: TicketListRow): SupportTicketView {
  return {
    id: row.id,
    subject: row.subject,
    status: row.status,
    category: row.category,
    priority: row.priority,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    messageCount: row._count.messages,
    lastMessageAt: lastMessageAtOf(row.messages),
    // The DETAIL projection passes the whole thread ascending, so this is the max
    // across all of them rather than just `[0]` — the same order-independence
    // `lastMessageAtOf` exists for, and the reason it is a shared helper.
    unread: isUnread(row.messages, row.lastReadAt),
  };
}

/**
 * The ticket's most recent activity — the MAXIMUM across whatever messages the caller
 * happened to select, never `messages[0]`.
 *
 * This must be order-independent, and that is not a style preference: the list
 * projection asks for `take: 1, orderBy: createdAt DESC` (so `[0]` IS the latest) while
 * the detail projection asks for the WHOLE THREAD ASCENDING (so `[0]` is the OLDEST).
 * Reading `[0]` therefore worked perfectly in the queue and silently reported the
 * FIRST message's time as "last activity" on every ticket detail page — a bug that
 * looks correct on a brand-new ticket, where there is only one message to be wrong
 * about. Taking the max is correct for both projections by construction.
 */
function lastMessageAtOf(messages: Array<{ createdAt: Date }>): string | null {
  if (messages.length === 0) return null;
  let latest = messages[0].createdAt;
  for (const message of messages) {
    if (message.createdAt.getTime() > latest.getTime()) latest = message.createdAt;
  }
  return latest.toISOString();
}

/**
 * Read the DOMAIN a ticket is about, LIVE.
 *
 * `null` is a normal, expected answer and is the entire reason the apex is not
 * copied into the ticket: if the domain was removed, the reference goes dangling and
 * this returns null, so the admin sees "no domain" instead of a stale apex that
 * quietly claims the customer still owns something they don't (plan §3.3).
 *
 * Pass `ownerUserId` for a user-facing read: the domain is then additionally
 * re-checked against ownership, because a domain CAN change hands between the ticket
 * being filed and being read, and the read must reflect that.
 */
async function readDomainRef(
  domainRefId: string,
  ownerUserId?: string
): Promise<TicketDomainRef | null> {
  const row = await prisma.userDomain.findUnique({
    where: { id: domainRefId },
    select: { id: true, apex: true, status: true, ownerKind: true, ownerUserId: true },
  });
  if (!row) return null;
  if (ownerUserId !== undefined && !(row.ownerKind === "user" && row.ownerUserId === ownerUserId)) {
    return null;
  }
  return { id: row.id, apex: row.apex, status: row.status };
}

function toMessageView(row: {
  id: string;
  authorRole: string;
  body: string;
  createdAt: Date;
  invoiceId?: string | null;
}): SupportMessageView {
  return {
    id: row.id,
    authorRole: row.authorRole,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    // TASK_187 — selected on DETAIL reads and on admin message creation;
    // create-returns that didn't select it resolve to null (a fresh message
    // never carries an invoice unless the admin just attached one).
    invoiceId: row.invoiceId ?? null,
  };
}

/**
 * TASK_187 B4 — resolve each message's soft `invoiceId` into a card-ready
 * snapshot, LIVE at read time (never denormalized into the message row).
 *
 * - `findUnique` per DISTINCT id, sequentially: a thread carries 0–2 invoices,
 *   and per-id lookups keep the path testable (the test fake matches equality
 *   `where {id}` only — an `in:` batch would silently return nothing).
 * - `ownerUserId` (user side only) resolves any invoice that is NOT the
 *   caller's as absent: a forged or stale ref must never surface another
 *   user's amount/addresses. The admin side omits it — admins see every
 *   ticket, same asymmetry as readDomainRef.
 * - Neither `days` nor `userId` is selected, so neither can escape here.
 */
async function resolveMessageInvoices(
  messages: SupportMessageView[],
  ownerUserId?: string
): Promise<void> {
  const wanted = new Set<string>();
  for (const m of messages) if (m.invoiceId) wanted.add(m.invoiceId);
  if (wanted.size === 0) return;

  const byId = new Map<string, ThreadInvoiceView | null>();
  for (const invoiceId of wanted) {
    const row = await prisma.premiumInvoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        userId: true,
        plan: true,
        tier: true,
        amountUsd: true,
        status: true,
        methods: true,
        createdAt: true,
        paidAt: true,
      },
    });
    if (!row || (ownerUserId !== undefined && row.userId !== ownerUserId)) {
      byId.set(invoiceId, null); // missing, or not this user's → render no card
      continue;
    }
    byId.set(invoiceId, {
      id: row.id,
      plan: row.plan,
      tier: row.tier,
      amountUsd: row.amountUsd,
      status: row.status,
      methods: row.methods,
      createdAt: row.createdAt.toISOString(),
      paidAt: row.paidAt ? row.paidAt.toISOString() : null,
    });
  }

  for (const m of messages) {
    if (m.invoiceId) m.invoice = byId.get(m.invoiceId) ?? null;
  }
}

// ---------------------------------------------------------------------------
// USER SIDE (§4). `userId` is the FIRST argument of every one of these on purpose:
// it comes from the session in the route, and it is used in the WHERE clause, so a
// ticket belonging to somebody else cannot be reached even with the correct id.
// ---------------------------------------------------------------------------

/**
 * Open a ticket, with its first message, in ONE transaction.
 *
 * The two writes are together because a ticket with no message is a row that renders
 * as an empty thread nobody can reply to meaningfully — the subject alone is not the
 * question. Either both land or neither does.
 */
export async function createSupportTicket(input: {
  userId: string;
  subject: string;
  body: string;
  category?: string | null;
  priority?: string | null;
  domainRefId?: string | null;
}): Promise<SupportResult<SupportTicketDetailView>> {
  const subject = validateSubject(input.subject);
  if (!subject.ok) return subject;
  const body = validateBody(input.body);
  if (!body.ok) return body;

  // Resolve the domain BEFORE the insert, so an unknown or someone-else's domain is
  // refused rather than stored as a dangling reference.
  let domainRefId: string | null = null;
  if (input.domainRefId) {
    const domain = await resolveOwnedDomain(input.userId, input.domainRefId);
    if (!domain.ok) return domain;
    domainRefId = domain.value.id;
  }

  const created = await prisma.supportTicket.create({
    data: {
      userId: input.userId,
      subject: subject.value,
      category: cleanOptional(input.category),
      priority: cleanOptional(input.priority),
      domainRefId,
      messages: {
        // authorId is set to the caller: for a user-authored message it is the
        // audit trail, and it matches the column's "nullable" purpose (an ADMIN's
        // id is the one that must survive their account being removed).
        create: { authorRole: AUTHOR_USER, authorId: input.userId, body: body.value },
      },
    },
    select: { id: true },
  });

  // Re-read through the same path the UI uses, so the create response and a later
  // GET can never disagree about what a ticket looks like.
  return getUserTicket(input.userId, created.id);
}

/** The caller's own tickets, newest first. */
export async function listUserTickets(
  userId: string
): Promise<SupportResult<SupportTicketView[]>> {
  const rows = await prisma.supportTicket.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: TICKET_LIST_SELECT,
  });
  return { ok: true, value: rows.map(toTicketView) };
}

/**
 * One ticket, with its whole thread and its domain's LIVE status.
 *
 * `findFirst` with `userId` in the where clause — not `findUnique` then a comparison
 * — because the ownership filter belongs in the QUERY. A post-fetch check is the
 * shape that gets skipped when a later refactor adds a third caller.
 */
export async function getUserTicket(
  userId: string,
  ticketId: string
): Promise<SupportResult<SupportTicketDetailView>> {
  const row = await prisma.supportTicket.findFirst({
    where: { id: ticketId, userId },
    select: {
      ...TICKET_LIST_SELECT,
      messages: {
        orderBy: { createdAt: "asc" as const },
        select: { id: true, authorRole: true, body: true, createdAt: true, invoiceId: true },
      },
    },
  });
  if (!row) return ticketNotFound();

  const domain = row.domainRefId ? await readDomainRef(row.domainRefId, userId) : null;
  const messages = row.messages.map(toMessageView);
  // TASK_187 B4 — owner-scoped: an invoice that isn't THIS user's resolves as
  // absent instead of ever rendering in their thread.
  await resolveMessageInvoices(messages, userId);
  return {
    ok: true,
    value: { ...toTicketView(row), messages, domain },
  };
}

/**
 * Append a user reply. Append-only: there is no edit and no delete anywhere in this
 * file, because support history that can be rewritten is not history (plan §2.3).
 *
 * A reply REOPENS a resolved ticket. That is an interim decision, not the final one
 * — the plan (§7.1) leaves "does a resolved ticket reopen, or is it a new ticket"
 * officially undecided, leaning on a time window. Reopening is the safe direction to
 * be wrong in: the alternative is a customer answering a question and that answer
 * landing in a thread no queue will ever surface again.
 */
export async function addUserMessage(
  userId: string,
  ticketId: string,
  body: string
): Promise<SupportResult<SupportMessageView>> {
  const validated = validateBody(body);
  if (!validated.ok) return validated;

  // Ownership first, so a non-owner cannot even learn whether the body would have
  // been accepted.
  const owned = await prisma.supportTicket.findFirst({
    where: { id: ticketId, userId },
    select: { id: true },
  });
  if (!owned) return ticketNotFound();

  const [message] = await prisma.$transaction([
    prisma.supportMessage.create({
      data: {
        ticketId,
        authorRole: AUTHOR_USER,
        authorId: userId,
        body: validated.value,
      },
      select: { id: true, authorRole: true, body: true, createdAt: true },
    }),
    prisma.supportTicket.update({
      where: { id: ticketId },
      data: { status: "open", resolvedAt: null },
    }),
  ]);

  return { ok: true, value: toMessageView(message) };
}

/**
 * TASK_166 — mark a ticket read for ITS OWNER, clearing the unread badge.
 *
 * Called when the customer opens a thread. Ownership is in the QUERY, not a post-fetch
 * comparison, and the miss is a 404 for exactly the reason §4 requires: a 403 would
 * confirm the id exists and belongs to somebody else.
 *
 * NOT called by the admin side. If reading a ticket in the admin queue cleared the
 * customer's badge, an admin working the queue would silence the customer's alert for
 * them, and the reply would sit unread forever — the bug this feature exists to fix.
 * The admin routes have no access to this function.
 *
 * Idempotent and monotonic: it never moves the cursor BACKWARDS. An out-of-order second
 * call (a slow request landing after a newer one) would otherwise un-read a ticket the
 * customer is currently looking at, and the badge would reappear on its own.
 */
export async function markTicketRead(
  userId: string,
  ticketId: string
): Promise<SupportResult<{ id: string; lastReadAt: string }>> {
  const owned = await prisma.supportTicket.findFirst({
    where: { id: ticketId, userId },
    select: { id: true, lastReadAt: true },
  });
  if (!owned) return ticketNotFound();

  const now = new Date();
  // The cursor never moves BACKWARDS. Compared in JS rather than pushed into the WHERE
  // clause, so the value returned is the cursor that was actually stored and not merely
  // the one we hoped for.
  const next =
    owned.lastReadAt !== null && owned.lastReadAt.getTime() > now.getTime()
      ? owned.lastReadAt
      : now;

  const updated = await prisma.supportTicket.update({
    where: { id: ticketId },
    data: { lastReadAt: next },
    select: { id: true, lastReadAt: true },
  });

  return {
    ok: true,
    value: {
      id: updated.id,
      lastReadAt: (updated.lastReadAt ?? next).toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// ADMIN SIDE (§4). These deliberately do NOT take a userId filter — an admin reads
// every ticket. That is why they live in their own block with their own names rather
// than sharing the functions above behind a boolean: a single function with an
// `asAdmin` flag is how a user-facing route one day passes the flag by accident. The
// hosting admin route made the same choice and hard-codes its flag in the route.
// ---------------------------------------------------------------------------

export interface AdminTicketFilters {
  status?: string | null;
  category?: string | null;
  priority?: string | null;
}

/**
 * The admin queue.
 *
 * Every filter is optional and an empty one is IGNORED rather than becoming
 * `status = ''` — an empty string is not a status, and filtering on it would return
 * nothing and look like "there are no tickets".
 *
 * Ordered by createdAt DESC. Note there is deliberately no "open tickets first"
 * ordering: `status` is an extensible string (see the migration), so any sort that
 * depended on the alphabetical position of the known values would break silently the
 * day a new one is added. Filtering is the correct tool, so the route passes
 * `status=open` for the default queue.
 */
export async function listAdminTickets(
  filters: AdminTicketFilters = {}
): Promise<SupportResult<SupportTicketView[]>> {
  const where: Prisma.SupportTicketWhereInput = {};
  const status = cleanOptional(filters.status);
  if (status) where.status = status;
  const category = cleanOptional(filters.category);
  if (category) where.category = category;
  const priority = cleanOptional(filters.priority);
  if (priority) where.priority = priority;

  const rows = await prisma.supportTicket.findMany({
    where,
    orderBy: { createdAt: "desc" },
    select: TICKET_LIST_SELECT,
  });
  return { ok: true, value: rows.map(toTicketView) };
}

/**
 * One ticket for an admin: whole thread, the OWNER's email, and the LIVE domain.
 *
 * The domain is read WITHOUT an owner filter because an admin is allowed to see any
 * domain — this is the one place the ownership re-check is intentionally absent, and
 * it is safe because the route calling it is behind `requireAdminSession`.
 */
export async function getAdminTicket(
  ticketId: string
): Promise<SupportResult<SupportTicketDetailView>> {
  const row = await prisma.supportTicket.findFirst({
    where: { id: ticketId },
    select: {
      ...TICKET_LIST_SELECT,
      user: { select: { id: true, email: true } },
      messages: {
        orderBy: { createdAt: "asc" as const },
        select: { id: true, authorRole: true, body: true, createdAt: true, invoiceId: true },
      },
    },
  });
  if (!row) return ticketNotFound();

  const domain = row.domainRefId ? await readDomainRef(row.domainRefId) : null;
  const messages = row.messages.map(toMessageView);
  // TASK_187 B4 — no owner scope on purpose: admins see every ticket, so a
  // ref to ANY user's invoice resolves (same asymmetry as readDomainRef).
  await resolveMessageInvoices(messages);
  return {
    ok: true,
    value: {
      ...toTicketView(row),
      messages,
      domain,
      userEmail: row.user.email,
      // TASK_187 B7 — the composer needs the owner's id to POST an invoice
      // at /api/admin/users/<id>/invoices.
      userId: row.user.id,
    },
  };
}

/**
 * Append an admin reply.
 *
 * Unlike a USER reply (see `addUserMessage`), this does NOT reopen a resolved
 * ticket. The asymmetry is deliberate: a customer writing again means the problem is
 * not solved, but an admin often replies last on a ticket that IS solved ("you're
 * welcome"). Reopening on every admin reply would mean the act of closing a ticket
 * correctly re-opened it. Resolution is an explicit action — `updateAdminTicket`.
 *
 * `adminId` is nullable and stored as-is, matching the column: it is an audit hint,
 * not a relationship, so it must not be able to block an admin's account deletion.
 *
 * TASK_187 B5 — `invoiceId` optionally attaches an invoice to this message (the
 * thread's invoice card). It is validated HERE, not in the route: the invoice
 * must exist AND belong to the TICKET'S user, because attaching a stranger's
 * invoice would put their amount and payout addresses into somebody else's
 * thread. A bad ref is a 400 with nothing written.
 */
export async function addAdminMessage(
  ticketId: string,
  body: string,
  adminId: string | null,
  invoiceId?: string | null
): Promise<SupportResult<SupportMessageView>> {
  const validated = validateBody(body);
  if (!validated.ok) return validated;

  // Empty/whitespace ref behaves like no invoice instead of failing validation.
  const attachedInvoiceId = invoiceId && invoiceId.trim() !== "" ? invoiceId.trim() : null;

  const ticket = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    select: { id: true, userId: true },
  });
  if (!ticket) return ticketNotFound();

  if (attachedInvoiceId) {
    const invoice = await prisma.premiumInvoice.findUnique({
      where: { id: attachedInvoiceId },
      select: { id: true, userId: true },
    });
    if (!invoice || invoice.userId !== ticket.userId) {
      return {
        ok: false,
        status: 400,
        code: "invoice_not_found",
        message: "That invoice doesn't exist for this ticket's user.",
      };
    }
  }

  const [message] = await prisma.$transaction([
    prisma.supportMessage.create({
      data: {
        ticketId,
        authorRole: AUTHOR_ADMIN,
        authorId: adminId,
        body: validated.value,
        invoiceId: attachedInvoiceId,
      },
      select: { id: true, authorRole: true, body: true, createdAt: true, invoiceId: true },
    }),
    // Stamp updatedAt explicitly rather than relying on an empty update: the queue
    // shows "last activity", and a reply that did not move that timestamp would make
    // a freshly-answered ticket look untouched.
    prisma.supportTicket.update({ where: { id: ticketId }, data: { updatedAt: new Date() } }),
  ]);

  return { ok: true, value: toMessageView(message) };
}

/**
 * TASK_194 S4 — make an admin-issued invoice VISIBLE on the support button.
 *
 * The support badge is DERIVED, not stored: `unread` is true only when the
 * thread's NEWEST message is an admin's and newer than the customer's lastReadAt
 * (see `isUnread`). The users-panel invoice composer
 * (`/api/admin/users/[id]/invoices`) wrote ONLY a `PremiumInvoice` row — no
 * message — so a user whose newest message was their own (or who had no ticket
 * at all) never lit the badge, even though the invoice existed and its email had
 * been sent. The support-panel composer already got this right by posting a
 * message with `invoiceId`; this closes the same gap for the other entry point.
 *
 * Find-or-create, in that order:
 *  - reuse the user's most recent UNRESOLVED ticket (so the notice lands where
 *    the conversation already is, and the invoice card renders inline);
 *  - otherwise open a fresh ticket for it.
 *
 * Best-effort by contract: callers wrap this in try/catch and never await a
 * failure into the 201 that already created the invoice.
 */
export async function postInvoiceNoticeToUser(
  userId: string,
  invoiceId: string,
  adminId: string | null,
  body: string,
): Promise<SupportResult<SupportMessageView>> {
  // TASK_197 S1 — idempotency belt: if ANY message already binds this invoice
  // (the support composer's own note, a retried notice, or both entry points
  // firing), posting again would render a SECOND card for ONE invoice — the
  // owner's "it sent two invoices". Return the existing binding instead.
  const bound = await prisma.supportMessage.findFirst({
    where: { invoiceId },
    orderBy: { createdAt: "desc" },
  });
  if (bound) return { ok: true, value: toMessageView(bound) };

  const existing = await prisma.supportTicket.findFirst({
    where: { userId, status: { not: RESOLVED_STATUS } },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });

  if (existing) return addAdminMessage(existing.id, body, adminId, invoiceId);

  // No open thread — open one, then post through addAdminMessage so the invoice
  // binding + body validation run exactly once, on one path.
  const created = await prisma.supportTicket.create({
    data: { userId, subject: "Premium invoice" },
    select: { id: true },
  });
  return addAdminMessage(created.id, body, adminId, invoiceId);
}

/**
 * Resolve / reopen / reprioritise.
 *
 * `resolvedAt` is DERIVED from `status` and can never be supplied by the caller — a
 * client able to set it could mark a ticket "resolved" with no timestamp (invisible
 * to any "how long did this take" report) or leave a resolvedAt on an open ticket.
 * Re-resolving an already-resolved ticket also leaves the ORIGINAL resolution time
 * alone rather than moving it forward, so the timestamp keeps meaning "when this was
 * first closed".
 */
export async function updateAdminTicket(
  ticketId: string,
  patch: { status?: string | null; category?: string | null; priority?: string | null }
): Promise<SupportResult<SupportTicketView>> {
  const existing = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    select: { id: true, status: true },
  });
  if (!existing) return ticketNotFound();

  const data: Prisma.SupportTicketUpdateInput = {};

  if (patch.status !== undefined) {
    const status = cleanOptional(patch.status);
    if (status === null) {
      return { ok: false, status: 422, code: "empty_status", message: "A ticket needs a status." };
    }
    data.status = status;
    if (status !== RESOLVED_STATUS) {
      data.resolvedAt = null;
    } else if (existing.status !== RESOLVED_STATUS) {
      data.resolvedAt = new Date();
    }
  }
  if (patch.category !== undefined) data.category = cleanOptional(patch.category);
  if (patch.priority !== undefined) data.priority = cleanOptional(patch.priority);

  if (Object.keys(data).length === 0) {
    return { ok: false, status: 422, code: "nothing_to_update", message: "Nothing to change." };
  }

  const row = await prisma.supportTicket.update({
    where: { id: ticketId },
    data,
    select: TICKET_LIST_SELECT,
  });
  return { ok: true, value: toTicketView(row) };
}

// ---------------------------------------------------------------------------
// ADMIN-COMPOSED TICKETS (TASK_161 D4)
// ---------------------------------------------------------------------------

/**
 * Open a ticket ON BEHALF OF a user, from the admin panel.
 *
 * The need is real: support routinely has to answer "my domain isn't showing up" from
 * a phone call or a Discord message, and forcing the customer to log in and file it
 * themselves means the thread starts in a channel nobody is watching.
 *
 * ── WHY THERE IS NO "target user id" PARAMETER ────────────────────────────────────
 *
 * PLAN_TASK_159 §2.2 requires the ticket's owner to come from the session and NEVER
 * from a request body, because a body-supplied id lets a crafted POST file a ticket
 * against somebody else's account. That rule is stated for the CUSTOMER routes, where
 * the session identifies exactly one person and that person may only ever act on
 * themselves.
 *
 * It does not transfer to the admin side, and pretending it does would be worse than
 * ignoring it. `lib/admin-auth.ts` shows why: the admin panel is a SINGLE SHARED
 * PASSCODE session whose subject is literally the string `"admin"`. It carries no user
 * identity at all — there is no admin whose id could be the owner, and asking for one
 * would be asking for a value that does not exist.
 *
 * So the security intent is preserved by moving the decision to the only place that can
 * actually make it, the SERVER:
 *
 *   1. `requireAdminSession()` runs BEFORE the body is parsed (see the route), so an
 *      unauthenticated caller never reaches this function and never learns whether a
 *      given email has an account.
 *   2. The target is an EMAIL, resolved here against `User.email` — a lookup the
 *      attacker cannot forge into an arbitrary row the way they can forge an id.
 *   3. The customer's own route gains NO new parameter: `POST /api/support/tickets`
 *      still has no way to name a target, so §2.2 is untouched on the side where a
 *      real customer is the caller.
 *   4. The email is normalised to lowercase, because `User.email` is `@unique` and two
 *      spellings of one address that both "resolve" differently would file the ticket
 *      against nobody.
 *
 * An unknown email is a 404 with a generic message. Not to hide accounts from staff —
 * the staff already have the Users tab — but because "we could not find that user" is
 * the actionable half of the failure, and the other half ("that email exists but is
 * not verified") is a detail that belongs in the ticket, not the error.
 *
 * The credential scan applies here exactly as it does on the customer route
 * (`validateSubject` / `validateBody` are the SAME functions), so an admin cannot be
 * the person who finally gets a token into the table by typing it into the wrong box.
 */
export async function createAdminComposedTicket(input: {
  userEmail: string;
  subject: string;
  body: string;
  category?: string | null;
  priority?: string | null;
  authorId?: string | null;
}): Promise<SupportResult<SupportTicketDetailView>> {
  const subject = validateSubject(input.subject);
  if (!subject.ok) return subject;
  const body = validateBody(input.body);
  if (!body.ok) return body;

  const email = (input.userEmail ?? "").trim().toLowerCase();
  if (email === "") {
    return {
      ok: false,
      status: 422,
      code: "missing_email",
      message: "Enter the customer's email address.",
    };
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (!user) {
    return {
      ok: false,
      status: 404,
      code: "user_not_found",
      message: "No account with that email address.",
    };
  }

  // No `domainRefId` parameter, deliberately: an admin-attached domain would bypass
  // `resolveOwnedDomain`'s ownership check, which is the only thing keeping a ticket's
  // domain reference on the customer's own account (§3.3). If this feature ever needs
  // it, the domain must be resolved WITH `ownerUserId = user.id`, not trusted from the
  // form.

  const created = await prisma.supportTicket.create({
    data: {
      // The RESOLVED owner, from the lookup above — never from the form.
      userId: user.id,
      subject: subject.value,
      category: cleanOptional(input.category),
      priority: cleanOptional(input.priority),
      messages: {
        create: {
          authorRole: AUTHOR_ADMIN,
          // The admin session subject ("admin"). Nullable with no FK, so removing an
          // admin's account later can never block or orphan this row (§3.2).
          authorId: cleanOptional(input.authorId),
          body: body.value,
        },
      },
    },
    select: { id: true },
  });

  // Re-read through the admin detail path, so this response carries the same shape the
  // admin queue will produce on its next read and the two can never disagree.
  return getAdminTicket(created.id);
}
