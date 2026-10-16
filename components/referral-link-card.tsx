import { CopyButton } from "@/components/copy-button";
import { Card } from "@/components/ui";
import { env } from "@/lib/env";
import { getUserReferralLink } from "@/lib/referral";

// Invite-only / hidden-login (owner, 2026-10-16): every registered user gets
// one personal invite link. Shown in Settings so they can copy it and bring
// people in — signups through it are attributed to them in the admin tree.
// Server component; the copy affordance is the shared client CopyButton.
export async function ReferralLinkCard({ userId }: { userId: string }) {
  let url: string | null = null;
  try {
    const link = await getUserReferralLink(userId);
    url = `${env.publicLinkBaseUrl}/r/${link.code}`;
  } catch (err) {
    // Never let the referral link break Settings — hide the card instead.
    console.error("[referral] could not load user link:", err);
    return null;
  }

  return (
    <Card className="max-w-2xl p-6">
      <h2 className="text-lg font-semibold text-fg">Your invite link</h2>
      <p className="mt-1 text-sm text-fg-muted">
        SpaceWorker is invite-only. Share this link — people who open it can
        sign in or sign up, and their account is tied to you.
      </p>
      <div className="mt-4 flex items-center gap-3">
        <code className="truncate rounded-lg bg-bg-elevated px-3 py-2 text-sm text-fg">
          {url}
        </code>
        <CopyButton value={url ?? ""} label="Copy link" />
      </div>
    </Card>
  );
}
