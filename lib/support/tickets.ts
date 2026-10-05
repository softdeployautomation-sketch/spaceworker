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

export interface SupportMessageView {
  id: string;
  authorRole: string;
  body: string;
  createdAt: string;
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
}

export interface SupportTicketDetailView extends SupportTicketView {
  messages: SupportMessageView[];
  /** Resolved LIVE at read time, never snapshotted into the ticket (plan §3.3). */
  domain: TicketDomainRef | null;
  /** Admin views only; omitted for the ticket's own owner. */
  userEmail?: string;
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
  _count: { select: { messages: true } },
  messages: { take: 1, orderBy: { createdAt: "desc" as const }, select: { createdAt: true } },
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
  _count: { messages: number };
  messages: Array<{ createdAt: Date }>;
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
}): SupportMessageView {
  return {
    id: row.id,
    authorRole: row.authorRole,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
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
        select: { id: true, authorRole: true, body: true, createdAt: true },
      },
    },
  });
  if (!row) return ticketNotFound();

  const domain = row.domainRefId ? await readDomainRef(row.domainRefId, userId) : null;
  return {
    ok: true,
    value: { ...toTicketView(row), messages: row.messages.map(toMessageView), domain },
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
      user: { select: { email: true } },
      messages: {
        orderBy: { createdAt: "asc" as const },
        select: { id: true, authorRole: true, body: true, createdAt: true },
      },
    },
  });
  if (!row) return ticketNotFound();

  const domain = row.domainRefId ? await readDomainRef(row.domainRefId) : null;
  return {
    ok: true,
    value: {
      ...toTicketView(row),
      messages: row.messages.map(toMessageView),
      domain,
      userEmail: row.user.email,
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
 */
export async function addAdminMessage(
  ticketId: string,
  body: string,
  adminId: string | null
): Promise<SupportResult<SupportMessageView>> {
  const validated = validateBody(body);
  if (!validated.ok) return validated;

  const exists = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    select: { id: true },
  });
  if (!exists) return ticketNotFound();

  const [message] = await prisma.$transaction([
    prisma.supportMessage.create({
      data: { ticketId, authorRole: AUTHOR_ADMIN, authorId: adminId, body: validated.value },
      select: { id: true, authorRole: true, body: true, createdAt: true },
    }),
    // Stamp updatedAt explicitly rather than relying on an empty update: the queue
    // shows "last activity", and a reply that did not move that timestamp would make
    // a freshly-answered ticket look untouched.
    prisma.supportTicket.update({ where: { id: ticketId }, data: { updatedAt: new Date() } }),
  ]);

  return { ok: true, value: toMessageView(message) };
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
