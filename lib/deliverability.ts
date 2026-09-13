import "server-only";
import { prisma } from "@/lib/prisma";
import { transporterForMailbox, type TransporterMailbox } from "./mailer-send";
import { decryptSecret } from "./mailbox-crypto";
import { pollSeedMailbox } from "./imap";
import { resolveSeedMailbox } from "./seed-mailbox";
import { renderMerge } from "./render-merge";
import { randomBytes } from "crypto";

export type DeliverabilityOutcome = "delivered" | "failed";

export interface SeedMailboxRow extends TransporterMailbox {
  id: string;
  secure: boolean;
}

// A single 20s-then-check was confirmed live (2026-09-13) to be too short:
// Gmail's spam classification can take well longer than that to actually file a
// message into [Gmail]/Spam — a real test was directly confirmed sitting in
// Spam by the user ~9 minutes after send, while our one-shot poll at 20s found
// nothing in either INBOX or Spam and reported landedIn:"unknown". Retrying
// across a longer window catches the common case (classification finishing
// within ~2 minutes) without hanging the request indefinitely; nginx's proxy
// for this app has a 3600s read timeout, so there's ample headroom to wait
// longer than 20s synchronously. A case that's still unresolved after this
// window falls through to the same landedIn:"unknown" human-check path as
// before — this raises the odds of an automated answer, it doesn't remove the
// fallback.
const POLL_INTERVAL_MS = 20_000;
const POLL_ATTEMPTS = 6; // 6 * 20s = 120s total

/**
 * Send one test message (a campaign's own template/variant) from a customer
 * mailbox to a platform-owned seed mailbox, then poll the seed mailbox via IMAP
 * to confirm the message actually landed. Records a `DeliverabilityCheck` (the
 * audit-trail mirror of this codebase's `PaymentVerificationAttempt` pattern) and
 * returns the outcome. Only a "delivered" check can unlock a real send.
 */
export async function runTestSend(opts: {
  campaignId: string;
  mailbox: TransporterMailbox;
  variant: { subject: string; bodyHtml: string };
  // Exactly one of these is provided. `seed` = a registered, IMAP-pollable
  // SeedMailbox (platform default or a user's own) — placement is verified
  // automatically. `overrideRecipient` = a plain ad-hoc address with no IMAP
  // access — the human-assisted fallback: "delivered" means the SMTP send
  // succeeded, nothing more; the human checks their own inbox before clicking
  // Confirm, and landedIn always stays "unknown" (never auto-verified "inbox"),
  // which is what keeps the batch gate pausing on every batch for this mode.
  seed?: SeedMailboxRow | null;
  overrideRecipient?: string | null;
  // Task 32 — optional explicit From address for this probe (overrides the
  // mailbox's normal fromAddresses[0] rotation). Used when a user (or an agent)
  // is live-testing an edited draft and wants to see it send as a specific From.
  from?: string;
}): Promise<{ outcome: DeliverabilityOutcome; checkId: string; landedIn: "inbox" | "spam" | "unknown"; error?: string }> {
  const since = new Date(Date.now() - 120_000); // generous window for clock skew
  const isOverride = !!opts.overrideRecipient;
  const toAddress = opts.overrideRecipient || opts.seed?.username;
  if (!toAddress) {
    return { outcome: "failed", checkId: "", landedIn: "unknown", error: "No test destination configured" };
  }
  // Unique per-test-send marker so the IMAP poll can tie a found message back to
  // exactly this send — needed because the seed mailbox is a single row shared
  // across all users, so "anything arrived" isn't proof THIS campaign delivered.
  // Override mode has no poll at all (no IMAP account to search), so the token
  // serves no purpose there and is left out of the subject entirely — the whole
  // point of testing against a human's own inbox is to see the REAL subject a
  // recipient would get, not one visibly tagged as a test.
  const token = `swtest-${randomBytes(12).toString("hex")}`;
  let sendError: string | undefined;

  try {
    const transport = transporterForMailbox(opts.mailbox);
    await transport.sendMail({
      // Task 30, item 4 — a test send is a one-shot per mailbox (no per-recipient
      // rotation has run here), so use the mailbox's first configured From
      // address (empty list => send as the SMTP username). Task 32 — an explicit
      // probe `from` override (live draft test) wins when provided.
      from: opts.from ?? (opts.mailbox.fromAddresses?.[0] || opts.mailbox.username),
      to: toAddress,
      subject: isOverride
        ? renderMerge(opts.variant.subject, {})
        : `${renderMerge(opts.variant.subject, {})} [SW test ${token}]`,
      html: renderMerge(opts.variant.bodyHtml, {}),
      headers: isOverride ? {} : { "X-SpaceWorker-Test": token },
    });
  } catch (e) {
    sendError = e instanceof Error ? e.message : "Test send failed at SMTP";
  }

  let messages: string[] = [];
  let pollError: string | undefined;
  // Task 29, item 6 — where the test message actually landed (inbox / spam /
  // unknown), passed straight through from the spam-aware IMAP poll. Stays
  // "unknown" for the whole override-recipient path — there's no mailbox to poll.
  let landedIn: "inbox" | "spam" | "unknown" = "unknown";

  if (!sendError && !isOverride && opts.seed) {
    const seedPassword = decryptSecret(
      opts.seed.encryptedPassword,
      opts.seed.passwordIv,
      opts.seed.passwordTag
    );
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const poll = await pollSeedMailbox(
        {
          host: opts.seed.host,
          port: opts.seed.port,
          secure: opts.seed.secure,
          username: opts.seed.username,
          password: seedPassword,
        },
        since,
        token
      );
      messages = poll.messages;
      pollError = poll.error;
      landedIn = poll.landedIn;
      // Stop as soon as the message shows up anywhere (inbox or spam) — no need
      // to keep polling once we have a real answer. Keep retrying on "unknown"
      // (not found yet, or a transient IMAP error) until the window runs out.
      if (landedIn !== "unknown") break;
    }
  }

  // Task 29, item 6 — landing in the Spam/Junk folder must NOT count as a passed
  // gate. `found` alone is true for either INBOX or Spam (pollSeedMailbox's
  // definition), so gating on `found` would let a spam-filtered test message
  // unlock a real send. Only an INBOX landing is "delivered"; spam and unknown are
  // both "failed", exactly like "not found anywhere" was treated before this
  // feature existed — this is what keeps confirm-test's existing
  // `status !== "delivered"` check (and the campaign detail page's Confirm-button
  // gate, which reads the same field) correctly blocking on a spam result without
  // needing to change either of them.
  //
  // The one deliberate exception: override-recipient mode has no IMAP account to
  // verify placement with at all, so it trusts the human instead — a successful
  // SMTP send is "delivered" there, full stop. This still isn't a free pass on
  // sends in general: the batch gate below reads landedIn (always "unknown" in
  // this mode), not outcome, so a real send still pauses for human review on
  // every batch — only the ONE-TIME initial test-send-confirm gate treats
  // override "delivered" as enough to unlock, matching "the human already
  // looked at it and clicked Confirm."
  const outcome: DeliverabilityOutcome = isOverride
    ? (sendError ? "failed" : "delivered")
    : (!sendError && landedIn === "inbox" ? "delivered" : "failed");
  const error =
    sendError ??
    (isOverride
      ? undefined
      : landedIn === "inbox"
        ? undefined
        : landedIn === "spam"
          ? "Test message was delivered to the Spam/Junk folder, not the inbox — sending is blocked until this is resolved."
          : (pollError ?? "Message not observed in the seed mailbox within the test window"));

  const check = await prisma.deliverabilityCheck.create({
    data: {
      campaignId: opts.campaignId,
      seedMailboxId: opts.seed?.id ?? null,
      overrideRecipient: opts.overrideRecipient ?? null,
      status: outcome,
      landedIn,
      messageId: messages[0] ?? null,
      error,
      checkedAt: new Date(),
    },
  });

  return { outcome, checkId: check.id, landedIn, error };
}

/**
 * Task 29, item 6 — the batch-gate probe. After each batch a campaign drains, the
 * mail-queue drain calls this to re-verify deliverability on the campaign's test
 * mailbox (the user's own registered one, else the platform default). It sends one
 * real test message and returns where it landed ("inbox" => safe to continue the
 * next batch; "spam"/"unknown" => the drain should pause for a human). Uses the
 * campaign's first active mailbox as the sender, mirroring the manual test-send.
 */
export async function probeCampaignPlacement(opts: {
  campaignId: string;
  userId: string;
  mailboxes: TransporterMailbox[];
  subjects: string[];
  bodies: string[];
  variants?: { subject: string; bodyHtml: string }[];
  // Human-assisted fallback (see runTestSend) — when set, every batch probe
  // targets this address instead of a registered seed mailbox, and always
  // reports landedIn:"unknown", so the batch gate pauses for a human decision
  // after every batch rather than auto-continuing.
  overrideRecipient?: string | null;
  // Task 33 — explicit From for the probe. Passed straight through to
  // runTestSend. Used during a pinned-override window so the batch probe judges
  // the SAME From address the pinned sends actually use, not mailbox[0]'s.
  from?: string | null;
}): Promise<{ outcome: DeliverabilityOutcome; landedIn: "inbox" | "spam" | "unknown"; checkId: string; error?: string }> {
  const mailbox = opts.mailboxes[0];
  if (!mailbox) return { outcome: "failed", landedIn: "unknown", checkId: "", error: "No sending mailbox available" };

  let variant: { subject: string; bodyHtml: string };
  if (opts.subjects.length > 0) {
    variant = { subject: opts.subjects[0], bodyHtml: opts.bodies.length > 0 ? opts.bodies[0] : "" };
  } else if (opts.variants && opts.variants.length > 0) {
    variant = opts.variants[0];
  } else {
    return { outcome: "failed", landedIn: "unknown", checkId: "", error: "Campaign has no content to test-send" };
  }

  if (opts.overrideRecipient) {
    const r = await runTestSend({
      campaignId: opts.campaignId,
      mailbox,
      variant,
      overrideRecipient: opts.overrideRecipient,
      ...(opts.from ? { from: opts.from } : {}),
    });
    return { outcome: r.outcome, landedIn: r.landedIn, checkId: r.checkId, error: r.error };
  }

  const seed = await resolveSeedMailbox(opts.userId);
  if (!seed) {
    return { outcome: "failed", landedIn: "unknown", checkId: "", error: "No test mailbox configured" };
  }

  const r = await runTestSend({
    campaignId: opts.campaignId,
    mailbox,
    variant,
    seed,
    ...(opts.from ? { from: opts.from } : {}),
  });
  return { outcome: r.outcome, landedIn: r.landedIn, checkId: r.checkId, error: r.error };
}

/**
 * Task 33 — the isolation ladder. Given a campaign's CURRENT active
 * subject/body/from (index 0 of each rotation, or the first legacy variant),
 * this builds four diagnostic probes, each changing EXACTLY ONE variable and
 * holding the other two constant, so a spacing-filtering diagnosis can isolate
 * WHICH element (subject, body, or From address) is actually triggering spam:
 *
 *   1. subject    — next subject in the rotation, same body, same From.
 *   2. body       — next body in the rotation, same subject, same From.
 *   3. emptyBody  — same subject/From, body replaced with "" (a genuine
 *                   diagnostic: if THIS still hits spam, subject/From reputation
 *                   is implicated — a body-content trigger can't explain a
 *                   message with no body).
 *   4. from       — next From in the mailbox's fromAddresses rotation, same
 *                   subject/body.
 *
 * Each probe is just content — the caller routes it through the SAME
 * runTestSend primitive the test-send route uses (each write its own
 * DeliverabilityCheck audit row). `available` is false with an explanation when
 * a dimension has no alternative to isolate (single-subject campaigns, a
 * mailbox with a single From address, etc.) — those probes are genuinely not
 * testable, not just unoffered.
 */
export interface IsolationProbe {
  key: "subject" | "body" | "emptyBody" | "from";
  label: string;
  description: string;
  variant: { subject: string; bodyHtml: string };
  // The From address this probe TEST AS (null = send as the mailbox's normal
  // first From, i.e. the campaign's current From — the "same From" arm).
  from: string | null;
  available: boolean;
  unavailableReason?: string;
}

export function buildIsolationProbes(opts: {
  subjects: string[];
  bodies: string[];
  variants?: { subject: string; bodyHtml: string }[];
  // The campaign's PRIMARY sending mailbox's configured From rotation
  // (Task 30, item 4). Used for both the "current From" arm and the from-probe.
  fromAddresses: string[];
}): IsolationProbe[] {
  const subject = opts.subjects?.[0] ?? opts.variants?.[0]?.subject ?? "";
  const bodyHtml = opts.bodies?.[0] ?? opts.variants?.[0]?.bodyHtml ?? "";
  // "next" in the rotation — i % len, so index 1 is what follows index 0. If a
  // dimension has only one entry there IS no alternative; the probe is flagged
  // unavailable rather than silently testing the identical content twice.
  const nextSubject = opts.subjects && opts.subjects.length > 1 ? opts.subjects[1] : subject;
  const nextBody = opts.bodies && opts.bodies.length > 1 ? opts.bodies[1] : bodyHtml;
  const nextFrom = opts.fromAddresses && opts.fromAddresses.length > 1 ? opts.fromAddresses[1] : null;

  return [
    {
      key: "subject",
      label: "Subject only",
      description: "Next subject in the rotation; same body and From.",
      variant: { subject: nextSubject, bodyHtml },
      from: null,
      available: opts.subjects && opts.subjects.length > 1,
      unavailableReason: opts.subjects && opts.subjects.length > 1 ? undefined : "Only one subject on this campaign — no alternative to test.",
    },
    {
      key: "body",
      label: "Body only",
      description: "Next body in the rotation; same subject and From.",
      variant: { subject, bodyHtml: nextBody },
      from: null,
      available: opts.bodies && opts.bodies.length > 1,
      unavailableReason: opts.bodies && opts.bodies.length > 1 ? undefined : "Only one body on this campaign — no alternative to test.",
    },
    {
      key: "emptyBody",
      label: "Empty-body diagnostic",
      description: "Same subject and From, body removed. If this still hits spam, body content isn't the trigger.",
      variant: { subject, bodyHtml: "" },
      from: null,
      available: true,
    },
    {
      key: "from",
      label: "From address only",
      description: "Next From address in the mailbox rotation; same subject and body.",
      variant: { subject, bodyHtml },
      from: nextFrom,
      available: opts.fromAddresses && opts.fromAddresses.length > 1,
      unavailableReason: opts.fromAddresses && opts.fromAddresses.length > 1 ? undefined : "Only one From address on the sending mailbox — no alternative to test.",
    },
  ];
}

// ---------------------------------------------------------------------------
// Task 38 — the SHARED decision/mutation core. These are the exact branches the
// deliverability-decision route used to inline; extracted so BOTH humans (the REST
// route) and the AI agent (lib/agent-executor.ts) call ONE identical implementation.
// No behavior change to the human flow — this is a pure refactor.
// ---------------------------------------------------------------------------

// Typed failure with an HTTP status so both the route (NextResponse) and the agent
// executor (AgentActionError) can map it to the same client-visible 4xx.
export class DeliverabilityError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "DeliverabilityError";
    this.status = status;
  }
}

// A single delivered probe outcome, as returned to BOTH the run-diagnostics route
// and the agent's diagnostics_result widget (same shape — one visual language).
export interface DiagnosticsProbeOutcome {
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
}

// Guard helper: only a campaign actually awaiting a deliverability decision can
// accept a pin/switch decision (mirrors the route's pre-call guard exactly).
export async function assertAwaitingDecision(campaign: {
  id: string;
  status: string;
}): Promise<void> {
  const fromInitial = campaign.status === "pending_test_confirm";
  const fromBatch = campaign.status === "paused_deliverability";
  if (!fromInitial && !fromBatch) {
    throw new DeliverabilityError(
      `Campaign is not awaiting a deliverability decision (status: ${campaign.status})`,
      409
    );
  }
}

/** Task 33 — a TEMPORARY pinned-override window. Locks the campaign onto one
 * proven-good { subject, bodyHtml, fromAddress } for exactly `pinCount` sends.
 * Both states resolve to "sending" (continue semantics). The stored rotation is
 * left untouched — the drain consults pinnedOverride while it's set.
 */
export async function applyPinAndContinue(
  campaignId: string,
  opts: {
    userId: string;
    subject: string;
    bodyHtml?: string;
    fromAddress?: string;
    pinCount?: number;
  }
): Promise<{
  ok: true;
  status: "sending";
  pinCount: number;
  pinnedOverride: { subject: string; bodyHtml: string; fromAddress: string; remaining: number };
}> {
  const campaign = await prisma.emailCampaign.findFirst({
    where: { id: campaignId, userId: opts.userId },
    include: { variants: { orderBy: { createdAt: "asc" } } },
  });
  if (!campaign) throw new DeliverabilityError("Campaign not found", 404);
  await assertAwaitingDecision(campaign);

  const subject = opts.subject.trim();
  // bodyHtml may legitimately be "" (a pinned empty-body diagnostic that came
  // back clean) — only the subject is required to pin.
  const bodyHtml = opts.bodyHtml ?? "";
  if (!subject) throw new DeliverabilityError("Provide a subject to pin", 400);
  const fromAddress = opts.fromAddress?.trim() ?? "";
  const rawPinCount = Number(opts.pinCount ?? campaign.batchSize ?? 50);
  const pinCount = Math.max(1, Math.min(1000, Math.floor(rawPinCount)));

  // Audit trail, mirroring the other explicit-decision branches.
  await prisma.deliverabilityCheck.create({
    data: {
      campaignId: campaign.id,
      seedMailboxId: null,
      status: "delivered",
      landedIn: "inbox",
      error: `Pinned override approved by the user for ${pinCount} send(s): "${subject}"${
        fromAddress ? ` from ${fromAddress}` : ""
      }.`,
      checkedAt: new Date(),
    },
  });
  const pinnedOverride = { subject, bodyHtml, fromAddress, remaining: pinCount };
  await prisma.emailCampaign.update({
    where: { id: campaign.id },
    data: { pinnedOverride, status: "sending" },
  });
  // Task 34 — return the full pinnedOverride shape so callers can show the
  // pinned-override banner locally.
  return { ok: true, status: "sending", pinCount, pinnedOverride };
}

/** Task 36 — rotate to the next independent subject (decoupled campaigns).
 * From a batch pause: rotates AND moves into pending_test_confirm (fresh
 * verification required). From the initial gate: rotates only, status stays.
 * Throws a 400 (DeliverabilityError) when there is nothing to switch to — same
 * error the route returned before this extraction. */
export async function applySwitchSubject(
  campaignId: string,
  opts: { userId: string; fromInitialGate?: boolean }
): Promise<{ ok: true; status: string; subjects: string[] }> {
  const campaign = await prisma.emailCampaign.findFirst({
    where: { id: campaignId, userId: opts.userId },
    include: { variants: { orderBy: { createdAt: "asc" } } },
  });
  if (!campaign) throw new DeliverabilityError("Campaign not found", 404);
  await assertAwaitingDecision(campaign);

  const fromInitialGate = opts.fromInitialGate ?? campaign.status === "pending_test_confirm";
  const rotatedSubjects =
    Array.isArray(campaign.subjects) && campaign.subjects.length > 1
      ? [...campaign.subjects.slice(1), campaign.subjects[0]]
      : undefined;
  if (!rotatedSubjects) {
    throw new DeliverabilityError(
      'This campaign only has one subject — there\'s nothing to switch to. Use "Manually edit and test" to try a fresh subject/body instead.',
      400
    );
  }

  if (fromInitialGate) {
    await prisma.emailCampaign.update({
      where: { id: campaign.id },
      data: { subjects: rotatedSubjects },
    });
    return { ok: true, status: campaign.status, subjects: rotatedSubjects };
  }
  await prisma.emailCampaign.update({
    where: { id: campaign.id },
    data: { subjects: rotatedSubjects, status: "pending_test_confirm" },
  });
  return { ok: true, status: "pending_test_confirm", subjects: rotatedSubjects };
}

/**
 * Task 38 — the isolation ladder, refactored out of the run-diagnostics route so
 * the AI agent (seed-mailbox autonomous read) and the human UI call the SAME code.
 *
 * Loads the campaign/primary mailbox/probes, resolves the seed (or override), runs
 * each probe via the SAME runTestSend primitive, and returns each probe's outcome.
 * overrideRecipient mode paces sends 3-6s apart (a human eyeballs their own inbox);
 * seed mode runs them in parallel (auto-verified via IMAP).
 */
export async function runCampaignDiagnostics(opts: {
  campaignId: string;
  userId: string;
  keys?: string[];
}): Promise<{ results: DiagnosticsProbeOutcome[]; overrideRecipient: string | null }> {
  const campaign = await prisma.emailCampaign.findFirst({
    where: { id: opts.campaignId, userId: opts.userId },
    include: { variants: { orderBy: { createdAt: "asc" }, select: { subject: true, bodyHtml: true } } },
  });
  if (!campaign) throw new DeliverabilityError("Campaign not found", 404);

  const mailboxes = await prisma.mailbox.findMany({
    where: { id: { in: campaign.mailboxIds }, userId: opts.userId, active: true },
    orderBy: { createdAt: "asc" },
  });
  // Isolation demands a single sender held constant across probes.
  const primary = mailboxes[0];
  if (!primary) throw new DeliverabilityError("No active sending mailbox on this campaign", 400);

  const probes = buildIsolationProbes({
    subjects: campaign.subjects ?? [],
    bodies: campaign.bodies ?? [],
    variants: campaign.variants.map((v) => ({ subject: v.subject, bodyHtml: v.bodyHtml })),
    fromAddresses: primary.fromAddresses,
  });

  const selected =
    opts.keys && opts.keys.length > 0 ? probes.filter((p) => opts.keys!.includes(p.key)) : probes;
  if (selected.length === 0) throw new DeliverabilityError("No matching probes", 400);

  const overrideRecipient = campaign.testRecipientOverride?.trim() || null;
  const seed = overrideRecipient ? null : await resolveSeedMailbox(opts.userId);
  if (!overrideRecipient && !seed) {
    throw new DeliverabilityError(
      "No seed/test mailbox is configured — a real one is required to run diagnostics",
      400
    );
  }

  const runProbe = (probe: IsolationProbe): Promise<DiagnosticsProbeOutcome> => {
    if (!probe.available) {
      return Promise.resolve({ ...probe, outcome: null, landedIn: null, error: probe.unavailableReason });
    }
    return runTestSend({
      campaignId: campaign.id,
      mailbox: primary,
      variant: probe.variant,
      ...(overrideRecipient ? { overrideRecipient } : { seed: seed! }),
      ...(probe.from ? { from: probe.from } : {}),
    })
      .then((r) => ({ ...probe, outcome: r.outcome, landedIn: r.landedIn, error: r.error }))
      .catch((e) => ({
        ...probe,
        outcome: "failed",
        landedIn: "unknown",
        error: e instanceof Error ? e.message : "Probe failed at SMTP",
      }));
  };

  let results: DiagnosticsProbeOutcome[];
  if (overrideRecipient) {
    results = [];
    for (const probe of selected) {
      if (results.length > 0) await new Promise((r) => setTimeout(r, 3_000 + Math.random() * 4_000));
      results.push(await runProbe(probe));
    }
  } else {
    results = await Promise.all(selected.map(runProbe));
  }

  return { results, overrideRecipient };
}