import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/admin-auth";
import { env } from "@/lib/env";
import { sendEmail } from "@/lib/email";
import { getUserReferralLink, listReferralLinks, createInvite, listInvites } from "@/lib/referral";
import { prisma } from "@/lib/prisma";

// Invite-only / hidden-login (owner, 2026-10-16). Admin API for the Referrals
// tab: GET returns the link tree (every user, their link, how many came
// through it), POST sends a user their own referral link by email — one user
// ({ action: "send", userId }) or everyone ({ action: "bulk" }).

// Hidden-login invite links ALWAYS belong to the main app host
// (spaceworker.top) — `publicLinkBaseUrl` is TASK_122's movable install/vantra
// link host (set to instaweb on the box) and sending a new user there would
// land them on the static joker page instead of /login (owner, 2026-10-16).
function referralUrl(code: string): string {
  return `${env.appBaseUrl}/r/${code}`;
}

function inviteHtml(code: string): string {
  const url = referralUrl(code);
  return `
  <p>You have access to SpaceWorker — sign in through your personal invite link below.</p>
  <p><a href="${url}">${url}</a></p>
  <p>If you were not expecting this email, ignore it — the link stops working for anyone else the moment you sign in with it.</p>`;
}

async function sendInvite(to: string, code: string): Promise<void> {
  await sendEmail({
    to,
    subject: "Your SpaceWorker invite link",
    html: inviteHtml(code),
    eventType: "referral_invite",
  });
}

export async function GET() {
  if (!(await requireAdminSession())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [users, links, invites] = await Promise.all([
    prisma.user.findMany({
      select: {
        id: true,
        email: true,
        createdAt: true,
        referredBy: true,
        referredByLinkId: true,
      },
      orderBy: { createdAt: "desc" },
    }),
    listReferralLinks(),
    listInvites(),
  ]);

  const linkByOwner = new Map(links.map((l) => [l.ownerId, l]));
  // Referred count per link — derived from the user rows themselves (each
  // attributed user names its referredByLinkId), so the tree and the counts
  // can never disagree.
  const referredCountByLink = new Map<string, number>();
  for (const u of users) {
    if (!u.referredByLinkId) continue;
    referredCountByLink.set(
      u.referredByLinkId,
      (referredCountByLink.get(u.referredByLinkId) ?? 0) + 1,
    );
  }

  return NextResponse.json({
    rows: users.map((u) => {
      const link = linkByOwner.get(u.id) ?? null;
      return {
        id: u.id,
        email: u.email,
        createdAt: u.createdAt.toISOString(),
        link,
        url: link ? referralUrl(link.code) : null,
        referredCount: link ? (referredCountByLink.get(link.id) ?? 0) : 0,
        referredBy: u.referredBy,
      };
    }),
    // Model C: personalized invites (admin-generated, email-bound), separate from
    // the user-referral tree above. Each shows invitee email + redemption status.
    invites,
  });
}

export async function POST(req: Request) {
  if (!(await requireAdminSession())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { action?: string; userId?: string; email?: string; send?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Model C — generate a personalized invite bound to one email. Idempotent: the
  // same email returns the existing live invite rather than minting a duplicate.
  if (body.action === "invite") {
    const email = (body.email ?? "").trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
    }
    const invite = await createInvite(email);
    if (body.send) {
      try {
        await sendInvite(invite.inviteeEmail, invite.code);
      } catch (err) {
        return NextResponse.json(
          { ok: true, invite, sendError: (err as Error).message },
          { status: 200 },
        );
      }
    }
    return NextResponse.json({ ok: true, invite });
  }

  if (body.action === "bulk") {
    const users = await prisma.user.findMany({
      select: { id: true, email: true },
    });
    let sent = 0;
    const failures: string[] = [];
    for (const u of users) {
      try {
        const link = await getUserReferralLink(u.id);
        await sendInvite(u.email, link.code);
        sent += 1;
      } catch (err) {
        failures.push(`${u.email}: ${(err as Error).message}`);
      }
    }
    return NextResponse.json({ sent, total: users.length, failures });
  }

  if (body.action === "send" && body.userId) {
    const user = await prisma.user.findUnique({
      where: { id: body.userId },
      select: { email: true },
    });
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    const link = await getUserReferralLink(body.userId);
    await sendInvite(user.email, link.code);
    return NextResponse.json({ ok: true, url: referralUrl(link.code) });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
