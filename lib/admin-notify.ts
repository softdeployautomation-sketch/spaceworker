import "server-only";

import { db } from "./db";
import { env } from "./env";
import { sendEmail } from "./email";
import { writeNotificationLog } from "./notification-log";
import { cooldownElapsed } from "./screen-notifications";
import { sendTelegramMessage, telegramConfigured } from "./telegram";

// ---------------------------------------------------------------------------
// TASK_190 S3/S4 — the ADMIN's own notification surface.
//
// TWO LAYERS, deliberately separate from every owner-facing feature:
//   1. CHANNEL PREFS  — one singleton row (AdminNotificationPref, the admin is
//      not a User row) with per-channel switches, both default OFF. The
//      telegramChatId is WRITE-ONLY: pasted by the admin into the panel
//      header, validated as a numeric string, and never rendered back out of
//      the API (PROMPT_CONTINUE: paste-chat-id design — the schema comment
//      says the same thing).
//   2. PER-DEVICE ALERTS — Device.adminNotifyEnabled says "tell the admin when
//      THIS device produces a summarized frame". It never turns capturing ON
//      (TASK_127 consent boundary: capture still needs the OWNER's own
//      screenshotMonitoringEnabled). Delivery honours the 120-minute cooldown
//      on Device.adminNotifyLastSentAt with the same claim-then-send
//      discipline as claimFiring (lib/screen-notifications.ts): a conditional
//      updateMany whose WHERE only matches rows already outside the cooldown,
//      so two sweeps racing on one device cannot double-send.
//
// FAILURE POSTURE (PROMPT_VERIFY §2.5/§3.6): a dead Telegram token or a
// Resend outage must NEVER 500 a toggle or fail the sweep. Every send is
// caught per channel; the failure is still visible in NotificationLog
// (outcome "failed", eventType "admin_screen_alert", userId null — the admin
// is not a User, so admin-path rows are always ownerless).
// ---------------------------------------------------------------------------

/** The NotificationLog eventType every admin screen alert is recorded under. */
export const ADMIN_NOTIFY_EVENT_TYPE = "admin_screen_alert";
/** Per-device cooldown between admin alerts — same default as trigger cooldown. */
export const ADMIN_NOTIFY_COOLDOWN_MINUTES = 120;
/** Longest summary excerpt embedded in a message (Telegram hard-caps at 4096). */
const SUMMARY_EXCERPT_CHARS = 800;

/** Numeric-string rule for a pasted Telegram chat id (groups are negative). */
const TELEGRAM_CHAT_ID_RE = /^-?\d+$/;

/**
 * The SAFE view of the prefs — the shape every response is built from. By
 * construction it cannot contain `telegramChatId` (the write-only secret):
 * only `telegramLinked` (boolean) reflects it.
 */
export interface AdminNotifyPrefsView {
  telegramEnabled: boolean;
  emailEnabled: boolean;
  telegramLinked: boolean;
  /** Env reality — the UI greys a toggle out when its channel cannot send. */
  configured: { telegram: boolean; email: boolean };
}

interface AdminNotificationPrefRow {
  telegramEnabled: boolean;
  telegramChatId: string | null;
  emailEnabled: boolean;
}

/** The raw singleton row (internal — the chat id never leaves this module). */
async function readPrefRow(): Promise<AdminNotificationPrefRow | null> {
  return db.adminNotificationPref.findUnique({ where: { id: "singleton" } });
}

function toView(row: AdminNotificationPrefRow | null): AdminNotifyPrefsView {
  return {
    telegramEnabled: row?.telegramEnabled ?? false,
    emailEnabled: row?.emailEnabled ?? false,
    telegramLinked: Boolean(row?.telegramChatId),
    configured: {
      telegram: telegramConfigured(),
      email: Boolean(env.adminEmail),
    },
  };
}

/**
 * GET layer — missing row reads as both channels OFF (an alert feature that
 * defaults itself on is how trust is lost). Never returns the chat id.
 */
export async function getAdminNotifyPrefs(): Promise<AdminNotifyPrefsView> {
  return toView(await readPrefRow());
}

export interface SettableAdminNotifyPrefs {
  telegramEnabled?: boolean;
  emailEnabled?: boolean;
  /** WRITE-ONLY. Numeric string; null clears the link. Never returned by GET. */
  telegramChatId?: string | null;
}

/**
 * PATCH layer — partial update of the singleton. Validates the chat id here
 * (not only at the route edge) so every caller gets the same rule; throws
 * Error with a clear message on a non-numeric id.
 */
export async function setAdminNotifyPrefs(
  patch: SettableAdminNotifyPrefs,
): Promise<AdminNotifyPrefsView> {
  if (
    patch.telegramChatId !== undefined &&
    patch.telegramChatId !== null &&
    !TELEGRAM_CHAT_ID_RE.test(patch.telegramChatId)
  ) {
    throw new Error(
      "Telegram chat id must be a numeric string, e.g. 123456789 (groups: -1001234567890).",
    );
  }

  const update: Record<string, unknown> = {};
  if (patch.telegramEnabled !== undefined) update.telegramEnabled = patch.telegramEnabled;
  if (patch.emailEnabled !== undefined) update.emailEnabled = patch.emailEnabled;
  if (patch.telegramChatId !== undefined) update.telegramChatId = patch.telegramChatId;

  await db.adminNotificationPref.upsert({
    where: { id: "singleton" },
    update,
    create: {
      id: "singleton",
      telegramEnabled: patch.telegramEnabled ?? false,
      emailEnabled: patch.emailEnabled ?? false,
      telegramChatId: patch.telegramChatId ?? null,
    },
  });
  return getAdminNotifyPrefs();
}

// ---------------------------------------------------------------------------
// Per-device claim-then-send
// ---------------------------------------------------------------------------

/**
 * Claim the 120-minute send slot for THIS device — conditional updateMany,
 * exactly the claimFiring pattern: the WHERE only matches a row whose
 * `adminNotifyLastSentAt` is already outside the cooldown (or null = never
 * sent), so a racing pass loses with count 0. The UPDATE touches ONLY the
 * cooldown stamp. Returns true only when THIS call owns the send.
 */
async function claimAdminNotify(deviceId: string, now: Date): Promise<boolean> {
  const cutoff = new Date(now.getTime() - ADMIN_NOTIFY_COOLDOWN_MINUTES * 60 * 1000);
  const claimed = await db.device.updateMany({
    where: {
      id: deviceId,
      adminNotifyEnabled: true,
      removedAt: null,
      OR: [{ adminNotifyLastSentAt: null }, { adminNotifyLastSentAt: { lte: cutoff } }],
    },
    data: { adminNotifyLastSentAt: now },
  });
  return claimed.count > 0;
}

function excerpt(summary: string): string {
  return summary.length > SUMMARY_EXCERPT_CHARS
    ? `${summary.slice(0, SUMMARY_EXCERPT_CHARS)}…`
    : summary;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Fan out ONE admin screen alert for a summarized frame, honouring the
 * per-device cooldown. Returns true when THIS call claimed the cooldown and
 * attempted delivery (a channel failure after the claim is logged, not
 * rethrown — see the failure posture above).
 *
 * Order matters, and it is the verify contract:
 *   1. device read — unknown / removed / notify-off ⇒ false, no claim.
 *   2. channel readiness — with BOTH channels off nothing can be sent, so we
 *      return BEFORE claiming: no NotificationLog rows, `adminNotifyLastSentAt`
 *      untouched (PROMPT_VERIFY §2.3's "both off ⇒ no rows").
 *   3. `cooldownElapsed` fast path (the reused helper), then the race-safe
 *      claim — two sweeps racing still cannot both send.
 *   4. per-channel try/catch sends; exactly one `admin_screen_alert` row per
 *      attempted channel: sendEmail writes its own (eventType pass-through in
 *      its finally), we write the telegram family row ourselves with
 *      userId null.
 */
export async function maybeAdminScreenNotify(
  deviceId: string,
  frameSummary: string,
  now: Date,
  capturedAt?: Date,
): Promise<boolean> {
  const device = await db.device.findUnique({
    where: { id: deviceId },
    select: {
      id: true,
      name: true,
      removedAt: true,
      adminNotifyEnabled: true,
      adminNotifyLastSentAt: true,
      user: { select: { email: true } },
    },
  });
  if (!device || device.removedAt || !device.adminNotifyEnabled) return false;

  const prefs = await readPrefRow();
  const chatId = prefs?.telegramChatId ?? null;
  const emailReady = Boolean(prefs?.emailEnabled && env.adminEmail);
  const telegramReady = Boolean(prefs?.telegramEnabled && chatId && telegramConfigured());
  if (!emailReady && !telegramReady) return false; // nothing can send — no claim

  if (!cooldownElapsed(device.adminNotifyLastSentAt, ADMIN_NOTIFY_COOLDOWN_MINUTES, now)) {
    return false; // still inside the cooldown window
  }
  if (!(await claimAdminNotify(deviceId, now))) return false; // lost the race

  const captured = capturedAt ?? now;
  const when = captured.toISOString().replace("T", " ").slice(0, 16);
  const summary = excerpt(frameSummary);
  // The console deep link belongs in the ADMIN's own message (PROMPT_VERIFY
  // §3.2): a server-only fan-out to the admin channels — it never ships to a
  // client bundle or the build manifest.
  const consoleUrl = `${env.appBaseUrl}/admin=topsecret6199/device/${deviceId}`;
  const ownerEmail = device.user.email;

  if (emailReady) {
    try {
      await sendEmail({
        to: env.adminEmail,
        subject: `Admin screen alert: ${device.name}`,
        html:
          `<p><strong>${escapeHtml(device.name)}</strong> produced a summarized frame.</p>` +
          `<p>Owner: ${escapeHtml(ownerEmail)}<br>Captured: ${escapeHtml(when)} UTC</p>` +
          `<p>What was on screen: ${escapeHtml(summary)}</p>` +
          `<p><a href="${escapeHtml(consoleUrl)}">Open the device console</a></p>`,
        eventType: ADMIN_NOTIFY_EVENT_TYPE,
      });
    } catch (err) {
      // sendEmail already logged its own failed admin_screen_alert row in its
      // finally — contain here so the other channel and the sweep carry on.
      console.error(
        "[admin-notify] email send failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (telegramReady && chatId) {
    const text =
      `🖥 Admin screen alert — ${device.name}\n\n` +
      `Owner: ${ownerEmail}\n` +
      `Captured: ${when} UTC\n\n` +
      `${summary}\n\n${consoleUrl}`;
    let outcome: "sent" | "failed" = "sent";
    let errorMessage: string | null = null;
    try {
      await sendTelegramMessage(chatId, text);
    } catch (err) {
      outcome = "failed";
      errorMessage = err instanceof Error ? err.message : String(err);
      console.error("[admin-notify] telegram send failed:", errorMessage);
    }
    // The family row (lib/telegram.ts logs its own row under eventType
    // "telegram_send"); userId is null BY CONSTRUCTION — the admin is not a
    // User row (PROMPT_VERIFY symptom map: a non-null userId here is a bug).
    await writeNotificationLog({
      userId: null,
      eventType: ADMIN_NOTIFY_EVENT_TYPE,
      channel: "telegram",
      recipient: chatId,
      outcome,
      errorMessage,
    });
  }

  return true;
}

// ---------------------------------------------------------------------------
// Sweep pass
// ---------------------------------------------------------------------------

export interface AdminNotifyPassResult {
  /** Devices with admin notify turned on (live rows only). */
  eligible: number;
  /** Devices where this call claimed the cooldown and attempted a send. */
  notified: number;
  /** No new summarized frame / no channel / cooldown / per-device failure. */
  suppressed: number;
}

/**
 * The admin pass, run by app/api/internal/screen-notify-sweep AFTER the
 * trigger pass: for every device with adminNotifyEnabled, take its NEWEST
 * summarized frame newer than `adminNotifyLastSentAt ?? epoch` and try to
 * notify. Per-device try/catch — one broken device must not stop the rest
 * (and the sweep route wraps THIS whole pass in its own try/catch too).
 */
export async function runAdminNotifyPass(now: Date = new Date()): Promise<AdminNotifyPassResult> {
  const devices = await db.device.findMany({
    where: { adminNotifyEnabled: true, removedAt: null },
    select: { id: true, adminNotifyLastSentAt: true },
  });
  const result: AdminNotifyPassResult = { eligible: devices.length, notified: 0, suppressed: 0 };

  for (const device of devices) {
    try {
      const since = device.adminNotifyLastSentAt ?? new Date(0);
      const frame = await db.deviceScreenshot.findFirst({
        where: {
          deviceId: device.id,
          status: "captured",
          summary: { not: null },
          summarisedAt: { gt: since },
        },
        orderBy: { summarisedAt: "desc" },
        select: { summary: true, capturedAt: true },
      });
      if (!frame?.summary) {
        result.suppressed += 1; // nothing summarized since the last send
        continue;
      }
      const claimed = await maybeAdminScreenNotify(device.id, frame.summary, now, frame.capturedAt ?? undefined);
      if (claimed) result.notified += 1;
      else result.suppressed += 1;
    } catch (err) {
      console.error(`[admin-notify] pass failed for device ${device.id}:`, err);
      result.suppressed += 1;
    }
  }
  return result;
}

