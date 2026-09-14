import type { Metadata } from "next";
import Link from "next/link";

import { Badge, Card } from "@/components/ui";
import { ChangePasswordForm } from "@/components/change-password-form";
import { NotificationsSettings } from "@/components/notifications-settings";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { getCurrentUser } from "@/lib/session-user";
import { generateTelegramLinkToken, parseTelegramLinkToken } from "@/lib/telegram";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const plan = user.tier >= 1 ? "Pro" : "Free";

  // Task 39 — Telegram connect link. When a bot username is configured and the
  // user isn't linked yet, ensure a short-lived link token exists (reusing a
  // still-valid one so the shown link doesn't churn on every page load) and build
  // the deep link. Unlinked + no username => null (the UI shows a note).
  let connectUrl: string | null = null;
  if (env.telegramBotUsername && !user.telegramChatId) {
    let token = user.telegramLinkToken;
    if (!token || !parseTelegramLinkToken(token)) {
      token = generateTelegramLinkToken();
      // Persist lazily so we don't mint a fresh token on every render.
      await db.user.update({
        where: { id: user.id },
        data: { telegramLinkToken: token },
      });
    }
    connectUrl = `https://t.me/${env.telegramBotUsername}?start=${token}`;
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-fg">Settings</h1>
        <p className="mt-1 text-sm text-fg-muted">Your account and preferences.</p>
      </div>

      <Card className="max-w-2xl p-6">
        <h2 className="text-lg font-semibold text-fg">Account</h2>
        <dl className="mt-4 space-y-3 text-sm">
          <div className="flex items-center justify-between gap-4">
            <dt className="text-fg-muted">Email</dt>
            <dd className="text-fg">{user.email}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-fg-muted">Plan</dt>
            <dd>
              <Badge tone={plan === "Pro" ? "success" : "neutral"}>{plan}</Badge>
            </dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-fg-muted">Status</dt>
            <dd>
              <Badge tone={user.emailVerified ? "success" : "warning"}>
                {user.emailVerified ? "Verified" : "Unverified"}
              </Badge>
            </dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-fg-muted">Member since</dt>
            <dd className="tabular-nums text-fg">
              {user.createdAt.toLocaleDateString(undefined, {
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
            </dd>
          </div>
        </dl>
      </Card>

      <Card className="max-w-2xl p-6">
        <h2 className="text-lg font-semibold text-fg">Security</h2>
        <p className="mt-1 text-sm text-fg-muted">Change your password.</p>
        <ChangePasswordForm />
      </Card>

      <Card className="max-w-2xl p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-fg">Notifications</h2>
            <p className="mt-1 text-sm text-fg-muted">
              Choose which channels SpaceWorker uses to notify you about stuck
              campaigns and automations that need your attention.
            </p>
          </div>
        </div>
        <div className="mt-4">
          <NotificationsSettings
            prefs={{
              notifyEmail: user.notifyEmail,
              notifyTelegram: user.notifyTelegram,
              notifyAgent: user.notifyAgent,
              linked: user.telegramChatId !== null,
              connectUrl,
            }}
          />
        </div>
      </Card>

      <Card className="max-w-2xl p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-fg">API keys</h2>
            <p className="mt-1 text-sm text-fg-muted">
              Generate a key to trigger extraction jobs and campaigns programmatically.
            </p>
          </div>
          <Badge tone="neutral">Coming soon</Badge>
        </div>
      </Card>

      <Card className="max-w-2xl p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-fg">Danger zone</h2>
            <p className="mt-1 text-sm text-fg-muted">
              Permanently delete your account, mailboxes, campaigns, and browser profiles.
            </p>
          </div>
          <Badge tone="neutral">Coming soon</Badge>
        </div>
      </Card>

      <p className="text-xs text-fg-muted">
        <Link href="/terms" className="underline hover:text-fg">
          Terms of Service &amp; Acceptable Use Policy
        </Link>
      </p>
    </div>
  );
}
