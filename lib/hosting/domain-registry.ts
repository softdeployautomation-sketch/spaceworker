import { prisma } from "../prisma";
import { normalizeDomainInput, normalizeZoneStatus } from "./domains";
import { assertZoneUserSelectable, reservedZoneMessage } from "./workers";
import type { HostingResult } from "./files";

// ---------------------------------------------------------------------------
// TASK_157 Phase 4 — the domain REGISTRY: the one place that answers "which
// domains may this user see and select?".
//
// THE RULE THIS ENFORCES (owner, 2026-10-03):
//
//   "The platform domains are only selectable by admin, users can only select the
//    domain they own or added."
//
// That is an OWNERSHIP rule, not a styling rule, so it is enforced in the data
// layer rather than by hiding rows in the UI. Every read below filters on the
// owner pair (`ownerKind: "user"` AND `ownerUserId: <the caller>`) and never on
// the apex alone.
//
// WHY A TABLE, when the user's own Cloudflare account can be listed live:
// the user may also buy a domain from an external registrar (planned), and a
// registrant's zone is NOT in the user's Cloudflare account, so live discovery
// cannot see it. Storing the domain is what makes that future path a sync rather
// than a rewrite. `source` + `externalRef` are the seam; both are nullable, so the
// BYO path works with no merchant at all.
//
// FAIL CLOSED. Every function returns a plain-language `HostingResult` and never
// throws a raw prisma error to a route, and no caller may fall back to "show
// everything" when this module cannot answer.
// ---------------------------------------------------------------------------

export interface UserDomainView {
  id: string;
  /** The registrable apex, e.g. "example.com". */
  apex: string;
  /** A user-facing label. Never null in the UI — falls back to the apex. */
  label: string;
  /** "byo" | "registrar" | "manual". */
  source: string;
  /** "pending" | "active" | "error". Only "active" is selectable. */
  status: string;
  /** The Cloudflare zone id, or null when not yet known. */
  zoneId: string | null;
  /** The two nameservers the user must set at their registrar, or null. */
  nameservers: string[] | null;
  /** True only when the domain is ready to publish onto. */
  selectable: boolean;
  /** Plain-language detail for the UI. Never contains a token. */
  note: string | null;
  createdAt: string;
}

type DomainRow = {
  id: string;
  apex: string;
  label: string;
  source: string;
  status: string;
  zoneId?: string | null;
  nameservers?: string | null;
  note?: string | null;
  createdAt: Date;
};

/**
 * TASK_157 Phase 4b — what the ADMIN panel sees. A superset of `UserDomainView`
 * carrying OWNERSHIP, which the user view deliberately omits because a user has
 * exactly one owner (themselves) and showing it would be noise.
 *
 * The admin list spans every owner at once, so without `ownerEmail` the panel
 * would be an undifferentiated pile of domains the owner cannot act on.
 *
 * `ownerUserId` is null for a platform zone; `ownerEmail` is then null too,
 * never the string "platform" — so the UI can branch on the id alone.
 */
export interface AdminDomainView extends UserDomainView {
  /** "user" | "platform". */
  ownerKind: string;
  /** The owning user's id, or null for a platform zone. */
  ownerUserId: string | null;
  /** The owner's email, or null for a platform zone / deleted user. */
  ownerEmail: string | null;
  /**
   * The credential a publish onto this domain would use. TASK_157: carried but
   * NOT yet enforced — see the `credentialId` note in PLAN_TASK_157 §4. Surfaced
   * here so the admin can see whether a domain was ever bound to one.
   */
  credentialId: string | null;
}

/** Map a stored row to the view. `selectable` is derived, never stored. */
function toView(row: DomainRow): UserDomainView {
  let nameservers: string[] | null = null;
  if (row.nameservers) {
    try {
      const parsed = JSON.parse(row.nameservers);
      if (Array.isArray(parsed)) nameservers = parsed.map(String);
    } catch {
      // Corrupt nameserver JSON is not worth failing the whole list over — the
      // domain still exists and is still shown, just without the hint.
      nameservers = null;
    }
  }
  return {
    id: row.id,
    apex: row.apex,
    label: row.label || row.apex,
    source: row.source,
    status: row.status,
    zoneId: row.zoneId ?? null,
    nameservers,
    selectable: row.status === "active",
    note: row.note ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The domains belonging to ONE user, newest first.
 *
 * The ownership filter is the important part and is applied as a single `where` so
 * it cannot be forgotten on one branch: a user's list can never contain a platform
 * zone (`ownerKind: "platform"` has a NULL user id and is excluded), and can never
 * contain another user's domain.
 */
export async function listUserDomains(userId: string): Promise<HostingResult<UserDomainView[]>> {
  try {
    const rows = await prisma.userDomain.findMany({
      where: { ownerKind: "user", ownerUserId: userId },
      orderBy: { createdAt: "desc" },
    });
    // Belt and braces: a reserved or platform-only apex must never reach a user
    // even if a row says otherwise (e.g. it was inserted before a name was added to
    // the denylist). Filtering HERE as well as at write time means a policy change
    // takes effect immediately on data already stored.
    return {
      ok: true,
      value: rows
        .filter((r) => assertZoneUserSelectable(r.apex).ok)
        .map((r) => toView(r as DomainRow)),
    };
  } catch (error) {
    return {
      ok: false,
      status: 500,
      code: "db_error",
      message: error instanceof Error ? error.message : "Could not load your domains.",
    };
  }
}

/**
 * Every domain in the registry, for the ADMIN panel.
 *
 * Admin-only by contract — the caller must have already passed `requireAdminSession`.
 * This is the view the owner uses to see and manage every domain, which is why it
 * is deliberately NOT filtered by the platform-only guard: the owner must be able to
 * SEE the platform's own zones here.
 *
 * OWNERSHIP IS NOT A PRISMA RELATION — `ownerUserId` is a bare `String?` backed by
 * a CHECK constraint, with no `owner` relation and no foreign key. So the emails are
 * fetched in a SECOND query rather than an `include`. Two reasons that is right here
 * rather than merely convenient:
 *   1. Adding the relation would mean a migration, and would silently pick a
 *      delete-semantics policy (cascade vs. SET NULL vs. RESTRICT) that the owner has
 *      not chosen. A domain outliving its user is a legitimate admin-fixable state,
 *      not something to decide as a side effect of drawing a UI.
 *   2. The lookup is a single indexed `findMany` on ids we already hold, so it costs
 *      one round trip and cannot fan out per row.
 * A user id with no matching row yields `ownerEmail: null` — the domain still lists,
 * so the owner can see and clean it up instead of it silently disappearing.
 */
export async function listAllDomains(): Promise<HostingResult<AdminDomainView[]>> {
  try {
    const rows = await prisma.userDomain.findMany({ orderBy: { createdAt: "desc" } });

    const ownerIds = Array.from(
      new Set(rows.map((r) => r.ownerUserId).filter((id): id is string => !!id))
    );
    const owners = ownerIds.length
      ? await prisma.user.findMany({
          where: { id: { in: ownerIds } },
          select: { id: true, email: true },
        })
      : [];
    const emailById = new Map(owners.map((u) => [u.id, u.email]));

    return {
      ok: true,
      value: rows.map((r) => ({
        ...toView(r as DomainRow),
        ownerKind: r.ownerKind,
        ownerUserId: r.ownerUserId,
        ownerEmail: r.ownerUserId ? emailById.get(r.ownerUserId) ?? null : null,
        credentialId: r.credentialId ?? null,
      })),
    };
  } catch (error) {
    return {
      ok: false,
      status: 500,
      code: "db_error",
      message: error instanceof Error ? error.message : "Could not load domains.",
    };
  }
}

/**
 * Add a domain that a USER owns.
 *
 * The checks, in order, and why each is here:
 *   1. normalise + Cloudflare's own acceptance rules (`normalizeDomainInput`)
 *   2. the static selection guard — a reserved or platform-only zone is refused by
 *      NAME, so `instaweb.top` cannot be added to a user even by a crafted request
 *   3. uniqueness across the whole platform — one owner per apex, ever. This is
 *      what stops user B claiming user A's domain, and stops a user claiming a
 *      platform zone that simply isn't on the denylist yet.
 *
 * A user may only ever add to their OWN id — `userId` is passed in by the route
 * from the session, never from the request body.
 */
export async function addUserDomain(
  userId: string,
  input: string,
  opts: { source?: string; credentialId?: string | null; zoneId?: string | null; status?: string } = {}
): Promise<HostingResult<UserDomainView>> {
  const apex = normalizeDomainInput(input);
  if (!apex) {
    return {
      ok: false,
      status: 400,
      code: "invalid_domain",
      message: "That does not look like a domain name. Enter a domain like example.com.",
    };
  }

  const guard = assertZoneUserSelectable(apex);
  if (!guard.ok) {
    return {
      ok: false,
      status: 403,
      code: "domain_forbidden",
      message: guard.zone
        ? reservedZoneMessage(guard.zone)
        : "That domain cannot be used for hosting.",
    };
  }

  // Claim-once. Checked explicitly for a clear message, then still protected by the
  // UNIQUE index below — two users submitting the same apex at the same moment can
  // both pass this check, and only the database can settle it.
  const existing = await prisma.userDomain.findUnique({ where: { apex } });
  if (existing) {
    const mine = existing.ownerKind === "user" && existing.ownerUserId === userId;
    return {
      ok: false,
      status: 409,
      code: "domain_exists",
      message: mine
        ? "You have already added that domain."
        : "That domain has already been claimed by another account.",
    };
  }

  try {
    const row = await prisma.userDomain.create({
      data: {
        apex,
        label: apex,
        ownerKind: "user",
        ownerUserId: userId,
        source: opts.source ?? "byo",
        // Normalised here too: an admin-assigned row arrives with a caller-supplied
        // status, and that must not be able to write a value the CHECK would reject
        // (nor an unknown one that later reads as "ready").
        status: normalizeZoneStatus(opts.status ?? "pending"),
        credentialId: opts.credentialId ?? null,
        zoneId: opts.zoneId ?? null,
      },
    });
    return { ok: true, value: toView(row as DomainRow) };
  } catch (error) {
    // P2002 = the UNIQUE index fired, i.e. the race the check above cannot win.
    if (error instanceof Error && "code" in error && (error as { code?: string }).code === "P2002") {
      return { ok: false, status: 409, code: "domain_exists", message: "That domain has already been claimed by another account." };
    }
    return {
      ok: false,
      status: 500,
      code: "db_error",
      message: error instanceof Error ? error.message : "Could not add that domain.",
    };
  }
}

/**
 * Record the Cloudflare facts about a domain the user already added: the zone id,
 * the two nameservers, and whether it is now `active`.
 *
 * This is the reconciliation step. `status` is deliberately NOT inferred from the
 * presence of a zone id — Cloudflare reports a zone as present while it is still
 * `pending` propagation, and publishing onto it before it is active fails. The
 * caller passes Cloudflare's own `status` field through unchanged.
 */
export async function recordDomainZoneState(
  userId: string,
  apexInput: string,
  state: { zoneId?: string | null; nameservers?: string[] | null; status?: string | null; note?: string | null }
): Promise<HostingResult<UserDomainView>> {
  const apex = normalizeDomainInput(apexInput);
  if (!apex) return { ok: false, status: 400, code: "invalid_domain", message: "That is not a domain name." };

  const row = await prisma.userDomain.findUnique({ where: { apex } });
  // Ownership is checked on the row itself, so this cannot be used to probe for
  // (or mutate) another user's domain.
  if (!row || row.ownerKind !== "user" || row.ownerUserId !== userId) {
    return { ok: false, status: 404, code: "not_found", message: "That domain is not on your account." };
  }

  const updated = await prisma.userDomain.update({
    where: { id: row.id },
    data: {
      zoneId: state.zoneId ?? row.zoneId,
      // Normalised, never Cloudflare's raw string — this is the ONLY writer of
      // `status`, so the schema CHECK is guaranteed to hold. See normalizeZoneStatus
      // for why an unrecognised status must not reach the column.
      status: state.status ? normalizeZoneStatus(state.status) : row.status,
      note: state.note ?? row.note,
      ...(state.nameservers?.length
        ? { nameservers: JSON.stringify(state.nameservers) }
        : {}),
    },
  });
  return { ok: true, value: toView(updated as DomainRow) };
}

/**
 * May `userId` publish onto `hostInput`?
 *
 * This is the SERVER-SIDE half of the ownership rule. The UI already only offers the
 * caller's own domains, but a UI filter is a convenience, not a control: a crafted
 * POST could name any host, and without this the Worker route would be created for a
 * domain the user has no claim to. Every publish path calls this before writing.
 *
 * A host matches when it EQUALS the claimed apex or is a subdomain of it — a user who
 * owns `example.com` legitimately serves `go.example.com` from it.
 *
 * Matching is done against the claim the caller already owns rather than by looking
 * the host up anywhere else, so the check cannot be widened by the host's shape.
 * A null/absent host is ALLOWED: "no custom host" means the platform's own default
 * worker address, which is a different (already gated) decision.
 *
 * Fails closed, and reports the reason in plain language — "still pending" is a
 * supportable state for the user to fix, unlike "not yours", which must not confirm
 * that somebody else's domain exists.
 */
export async function assertUserOwnsHost(
  userId: string,
  hostInput: string | null | undefined
): Promise<HostingResult<{ apex: string }>> {
  const raw = hostInput?.trim().toLowerCase() ?? "";
  if (!raw) return { ok: true, value: { apex: "" } };

  const listed = await listUserDomains(userId);
  if (!listed.ok) return listed;

  for (const domain of listed.value ?? []) {
    if (raw === domain.apex || raw.endsWith(`.${domain.apex}`)) {
      if (!domain.selectable) {
        return {
          ok: false,
          status: 409,
          code: "domain_not_ready",
          message:
            domain.status === "pending"
              ? `${domain.apex} isn’t ready yet — point it at Cloudflare, then check the status again.`
              : `${domain.apex} isn’t ready to publish on. Check its status and try again.`,
        };
      }
      return { ok: true, value: { apex: domain.apex } };
    }
  }

  // Not claimed by this user. Deliberately says nothing about whether the domain
  // exists, so this cannot be used to enumerate other users' domains.
  return {
    ok: false,
    status: 403,
    code: "host_not_owned",
    message: "You can only publish on a domain you’ve added to your account.",
  };
}

/**
 * Remove a domain. A user may remove only their own; an admin may remove any.
 *
 * A non-owner gets 404 rather than 403, so the status code cannot be used to learn
 * that someone else's domain exists.
 */
export async function removeUserDomain(
  userId: string,
  id: string,
  opts: { asAdmin?: boolean } = {}
): Promise<HostingResult<{ id: string }>> {
  const row = await prisma.userDomain.findUnique({ where: { id } });
  if (!row) return { ok: false, status: 404, code: "not_found", message: "That domain was not found." };
  if (!opts.asAdmin && (row.ownerKind !== "user" || row.ownerUserId !== userId)) {
    return { ok: false, status: 404, code: "not_found", message: "That domain was not found." };
  }
  await prisma.userDomain.delete({ where: { id } });
  return { ok: true, value: { id } };
}

/**
 * Re-read ONE owned domain from Cloudflare, making exactly one zone lookup.
 *
 * This is what `POST /api/hosting/domains/<id>/verify` uses. It deliberately does NOT
 * go through `refreshUserDomainsFromCloudflare`: that walks the whole list, so asking
 * "is THIS one ready yet?" cost one Cloudflare request per domain the user happens to
 * own, and grew without bound as they added more. Verifying one row has to be one
 * lookup, or the button on a twenty-domain account becomes twenty API calls per press.
 *
 * Ownership is decided on the row itself and a non-owner gets 404, so this cannot be
 * used to read (or poll) somebody else's domain. Note it takes the APEX from the
 * stored row, not from the caller — the caller's id never reaches the Cloudflare
 * lookup, so there is no way to point the probe at an arbitrary name.
 *
 * A zone Cloudflare cannot see is not an error: the row is kept and annotated, since
 * dropping a domain the user added would be worse than showing it as unverified.
 */
export async function reconcileUserDomain(
  userId: string,
  id: string,
  readZone: (apex: string) => Promise<{ ok: true; zoneId: string; status: string; nameservers: string[] } | { ok: false; message: string }>
): Promise<HostingResult<UserDomainView>> {
  const row = await prisma.userDomain.findUnique({ where: { id } });
  if (!row || row.ownerKind !== "user" || row.ownerUserId !== userId) {
    return { ok: false, status: 404, code: "not_found", message: "That domain was not found." };
  }
  const current = toView(row as DomainRow);

  // Exactly one lookup, for the apex we already stored.
  const seen = await readZone(current.apex);
  if (!seen.ok) {
    // Cloudflare cannot see it (yet). Persist the note so it survives a reload,
    // but keep the row and keep whatever status we had — a transient lookup failure
    // must not demote a domain that is known to be live.
    const recorded = await recordDomainZoneState(userId, current.apex, { note: seen.message });
    return recorded.ok ? recorded : { ok: true, value: { ...current, note: seen.message } };
  }

  return recordDomainZoneState(userId, current.apex, {
    zoneId: seen.zoneId,
    status: seen.status,
    nameservers: seen.nameservers,
    note: null,
  });
}

/**
 * Re-read every domain the user owns from their BYO Cloudflare credential and
 * record each zone's real status, id and nameservers.
 *
 * This is what turns an `add` (which always starts `pending`, because at that moment
 * we have only accepted a NAME) into a domain that is genuinely usable. Called by
 * the user's Domains screen, so the page answers "is my domain live yet?" from
 * Cloudflare rather than from a stale local guess.
 *
 * Deliberately tolerant: one domain failing to reconcile does NOT abort the others,
 * because a single stale zone would otherwise leave the whole screen stale. Domains
 * Cloudflare can no longer see are reported in `note` rather than deleted — losing a
 * row the user added would be worse than showing it as unverified.
 */
export async function refreshUserDomainsFromCloudflare(
  userId: string,
  readZones: (apex: string) => Promise<{ ok: true; zoneId: string; status: string; nameservers: string[] } | { ok: false; message: string }>
): Promise<HostingResult<UserDomainView[]>> {
  const listed = await listUserDomains(userId);
  if (!listed.ok) return listed;

  const reconciled: UserDomainView[] = [];
  for (const domain of listed.value ?? []) {
    const seen = await readZones(domain.apex);
    if (!seen.ok) {
      // Cloudflare cannot see it (yet): keep the row, mark it, and move on.
      reconciled.push({ ...domain, note: seen.message });
      continue;
    }
    const recorded = await recordDomainZoneState(userId, domain.apex, {
      zoneId: seen.zoneId,
      status: seen.status,
      nameservers: seen.nameservers,
      note: null,
    });
    reconciled.push(recorded.ok ? recorded.value : { ...domain, note: recorded.message ?? domain.note });
  }
  return { ok: true, value: reconciled };
}
