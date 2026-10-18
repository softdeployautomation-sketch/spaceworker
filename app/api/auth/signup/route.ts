import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";

import { hashPassword } from "@/lib/auth";
import { attributeReferral, getInviteByCode, getUserReferralLink, markInviteRedeemed, validateReferral } from "@/lib/referral";
import { db } from "@/lib/db";
import { prisma } from "@/lib/prisma";
import { sendEmail, tier1UpgradeEmailHtml, verificationEmailHtml } from "@/lib/email";
import { env } from "@/lib/env";
import { allowAndRecord, getClientIp } from "@/lib/rate-limit";
import { notifyAdmin } from "@/lib/telegram";
import { issueVerificationCode } from "@/lib/verify-code";

const signupSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128, "Password must be at most 128 characters"),
  acceptedTerms: z.literal(true, {
    errorMap: () => ({ message: "You must agree to the Terms of Service to create an account." }),
  }),
});

/** Minimal HTML escape for the admin alert email (the address goes in a <strong>). */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function POST(request: Request) {
  const ip = await getClientIp();

  // Rate limit signup by IP: 5/hr.
  const allowed = await allowAndRecord(ip, "signup");
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many signup attempts. Please try again later." },
      { status: 429 },
    );
  }

  let parsed;
  try {
    parsed = signupSchema.parse(await request.json());
  } catch (e) {
    const msg =
      e instanceof z.ZodError ? e.errors[0]?.message : "Invalid request body";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const email = parsed.email.trim().toLowerCase();

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    // Don't leak whether an account exists. Generic message.
    return NextResponse.json(
      { error: "We couldn't create an account with that email." },
      { status: 409 },
    );
  }

  const passwordHash = await hashPassword(parsed.password);

  // Resolve the access token that brought this visitor in (stamped on /login or
  // /signup via ?ref=CODE or the /r/:code redirect → sw_ref cookie). It is either
  // a universal referral link, or — Model C — a personalized invite bound to a
  // single email.
  const cookieStore = await cookies();
  const refCookie = cookieStore.get("sw_ref")?.value;
  const referredLink =
    refCookie ? await validateReferral(refCookie) : null;
  // Only look for an invite if this isn't already a universal referral (a code
  // resolves to at most one of the two — separate tables).
  const invite =
    !referredLink && refCookie ? await getInviteByCode(refCookie) : null;

  if (invite) {
    if (!invite.isActive || invite.redeemedAt) {
      // Already consumed / revoked — it must not be usable to create an account.
      return NextResponse.json(
        { error: "This invite has already been used." },
        { status: 403 },
      );
    }
    // The hard Model C gate: only the exact invited email may redeem. Reject
    // BEFORE any account is created.
    if (invite.inviteeEmail !== email) {
      return NextResponse.json(
        { error: "This invite is for a different email address." },
        { status: 403 },
      );
    }
  }

  // F8 (TASK_221) — the invite-only gate at /signup + /login must be enforced by
  // the API too. A signup arrives with an access token on the sw_ref cookie: a
  // valid universal referral link (referredLink) OR a live personalized invite
  // (invite, which has already passed the Model C 403 checks above). When the
  // cookie is absent — or present but resolves to neither — refuse with 403 so
  // hitting this route directly cannot mint an account the pages would bounce.
  // A valid invite that failed the checks above already returned its own 403.
  if (!referredLink && !invite) {
    return NextResponse.json(
      { error: "An invite or referral link is required to create an account." },
      { status: 403 },
    );
  }

  const user = await db.user.create({
    // Tier 1 trial — new signups get the trial tier immediately (email
    // verification is unchanged as the gate to reach the dashboard; it only
    // decides what number a not-yet-verified account carries). Explicit rather
    // than relying solely on the schema default of 1 for clarity.
    data: { email, passwordHash, emailVerified: false, acceptedTermsAt: new Date(), tier: 1 },
  });

  // Referral attribution: record who referred this user (if any) and give the
  // new user their own shareable link so they can invite others in turn.
  if (referredLink) {
    await attributeReferral({
      userId: user.id,
      linkId: referredLink.id,
      referrerCode: referredLink.code,
      referrerEmail: referredLink.ownerEmail,
    });
    await getUserReferralLink(user.id).catch(() => undefined);
  } else if (invite) {
    // Model C: the invite row itself is the record — tracked in the admin
    // "Invites" panel by invitee email + redemption status. Consume it so it can't
    // be reused, and give the new user their own universal link.
    //
    // Came-via (owner, 2026-10-16): if the admin picked a referrer when creating
    // this invite, attribute the signup to that user exactly like a universal
    // referral link — same referredBy / referredByLinkId fields, same
    // conversions increment — so the invitee appears under them in the tree.
    await markInviteRedeemed(invite.id, user.id).catch(() => undefined);
    if (invite.referredById && invite.referredById !== user.id) {
      const refLink = await getUserReferralLink(invite.referredById).catch(() => null);
      if (refLink) {
        await attributeReferral({
          userId: user.id,
          linkId: refLink.id,
          referrerCode: refLink.code,
          referrerEmail: refLink.ownerEmail,
        }).catch(() => undefined);
      }
    }
    await getUserReferralLink(user.id).catch(() => undefined);
  }

  void notifyAdmin(`New SpaceWorker signup: ${email}`);
  // TASK_202 B — the same signup alert by email (Telegram fires above via
  // notifyAdmin; email was missing entirely). Best-effort with the signup
  // flow's own failure posture: an alert failure must never fail the signup —
  // sendEmail writes its own NotificationLog row (eventType below) in its
  // finally, success or not.
  if (env.adminEmail) {
    void sendEmail({
      to: env.adminEmail,
      subject: `New SpaceWorker signup: ${email}`,
      html:
        `<p>New SpaceWorker signup: <strong>${escapeHtml(email)}</strong></p>` +
        `<p>${new Date().toISOString()}</p>`,
      eventType: "admin_signup_alert",
    }).catch(() => undefined);
  }

  // Issue a 6-digit verification code (15-min expiry) and email it.
  // No client/site provisioning step exists here — that was Vantra-specific,
  // TRMM-related. Verification success just flips emailVerified.
  const { code } = await issueVerificationCode(user.id);
  try {
    await sendEmail({
      to: email,
      subject: "Your SpaceWorker verification code",
      html: verificationEmailHtml(code),
    });
  } catch {
    // Email delivery failure shouldn't destroy the account, but the user needs
    // a way to get a new code — they can request a resend from the verify page.
  }

  // Tier 1 trial — the upgrade/welcome notice at registration. A brand-new
  // account is always unverified, so send the verify-first variant. Failing
  // closed here is safe: the account + trial tier already exist; the email is
  // informational only and the verify-code email above remains the real gate.
  try {
    await sendEmail({
      to: email,
      subject: "You're on Tier 1 — try SpaceWorker free",
      html: tier1UpgradeEmailHtml({ verified: false }),
      eventType: "tier1_upgrade",
    });
  } catch {
    // Best-effort — never destroy the account over a marketing email.
  }

  return NextResponse.json(
    { message: "Account created. Check your email for a verification code." },
    { status: 201 },
  );
}