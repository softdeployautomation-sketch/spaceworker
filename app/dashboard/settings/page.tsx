import type { Metadata } from "next";
import Link from "next/link";

import { Badge, Card } from "@/components/ui";
import { ChangePasswordForm } from "@/components/change-password-form";
import { NotificationsSettings } from "@/components/notifications-settings";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { accountHref, isLocalExeRuntime } from "@/lib/exe-runtime";
import { wrapperMode } from "@/lib/wrapper-mode";
import { getCurrentUser } from "@/lib/session-user";
import { generateTelegramLinkToken, parseTelegramLinkToken } from "@/lib/telegram";
import { ExeLicensePanel } from "./exe-license-panel";
import { LicensesSection } from "./licenses-section";
import { SendRegionSettings } from "@/components/send-region-settings";
import { HostingCredentialsSettings } from "@/components/hosting-credentials-settings";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  // Desktop EXE runs fully offline — the web session/Postgres read below has no
  // meaning in the local runtime (same pattern as app/dashboard/layout.tsx, which
  // passes user=null there). The only Settings content the EXE needs is the local
  // License panel, which talks exclusively to /api/exe-license/*; the account/
  // security/etc. cards are web-host-only. Split here so the EXE build never
  // touches the DB.
  if (isLocalExeRuntime()) {
    return (
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-bold text-fg">Settings</h1>
          <p className="mt-1 text-sm text-fg-muted">Licensing and preferences for this device.</p>
        </div>
        <ExeLicensePanel buyHref={accountHref("/pricing")} />
      </div>
    );
  }

  const user = await getCurrentUser();
  if (!user) return null;

  // TASK_181 — the devices-only wrapper build: user-only settings (account,
  // licenses, security); the cross-product config cards below are web-only.
  const wrapper = wrapperMode() !== null;

  // Tier 1 trial — "Pro" is tier 5 (Premium) only; tier 1 (trial) shows Free.
  const plan = user.tier >= 5 ? "Pro" : "Free";

  // Task 39 — Telegram connect link. When a bot username is configured and the
  // user isn't linked yet, ensure a short-lived link token exists (reusing a
  // still-valid one so the shown link doesn't churn on every page load) and build
  // the deep link. Unlinked + no username => null (the UI shows a note).
  let connectUrl: string | null = null;
  // 2026-09-26 (live incident) — Telegram doesn't carry the ?start= payload
  // through when the user already has a chat with this (shared) bot from
  // another product; the raw token lets them paste it directly instead.
  let linkToken: string | null = null;
  // TASK_181 — skip the token mint in the wrapper build: the Notifications
  // card (its only consumer) is web-only there, so the DB write is wasted.
  if (!wrapper && env.telegramBotUsername && !user.telegramChatId) {
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
    linkToken = token;
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

      {/* TASK_100 MK5 — Licenses, folded in from the old standalone
          /dashboard/licenses page (still redirects here for a full session). */}
      <Card className="max-w-2xl p-6">
        <LicensesSection />
      </Card>

      <Card className="max-w-2xl p-6">
        <h2 className="text-lg font-semibold text-fg">Security</h2>
        <p className="mt-1 text-sm text-fg-muted">Change your password.</p>
        <ChangePasswordForm />
      </Card>

      {/* Owner ask (2026-10-02) — the Cloudflare account token lives in
          Settings; once saved it becomes an option across all hosting (the
          Hosting page's engine picker reads it via /api/hosting/status).
          TASK_181 — from here down these are cross-product config cards:
          web-only, never rendered in the devices wrapper build. */}
      {!wrapper && (
      <Card className="max-w-2xl p-6">
        <h2 className="text-lg font-semibold text-fg">Hosting accounts</h2>
        <p className="mt-1 text-sm text-fg-muted">
          Bring your own Cloudflare account for premium hosting. The token is encrypted and never shown — only
          the last 4 characters. The default account powers new premium deploys.
        </p>
        <div className="mt-4">
          <HostingCredentialsSettings />
        </div>
      </Card>
      )}

      {/* TASK_134 (premium) — deliberately just the region toggle, not the
          full mailbox management UI (that stays at the Campaigns page's
          "Mailboxes" tab, components/mailboxes-panel.tsx — adding/editing/
          testing mailboxes and the test-mailbox section don't belong on the
          account Settings page). */}
      {!wrapper && (
      <Card className="max-w-2xl p-6">
        <h2 className="text-lg font-semibold text-fg">Send region</h2>
        <p className="mt-1 text-sm text-fg-muted">
          Route a sending mailbox through a regional exit instead of this server&apos;s own IP.
        </p>
        <div className="mt-4">
          <SendRegionSettings />
        </div>
      </Card>
      )}

      {!wrapper && (
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
              telegramApprovalsEnabled: user.telegramApprovalsEnabled,
              telegramChatEnabled: user.telegramChatEnabled,
              notifyDeviceOffline: user.notifyDeviceOffline,
              notifyDeviceOnline: user.notifyDeviceOnline,
              agentWidgetEnabled: user.agentWidgetEnabled,
              digestEnabled: user.digestEnabled,
              deviceTelemetryEnabled: user.deviceTelemetryEnabled,
              agentActionsEnabled: user.agentActionsEnabled,
              linked: user.telegramChatId !== null,
              connectUrl,
              linkToken,
            }}
          />
        </div>
      </Card>
      )}

      {!wrapper && (
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
      )}

      {!wrapper && (
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
      )}

      <p className="text-xs text-fg-muted">
        <Link href="/terms" className="underline hover:text-fg">
          Terms of Service &amp; Acceptable Use Policy
        </Link>
      </p>
    </div>
  );
}
