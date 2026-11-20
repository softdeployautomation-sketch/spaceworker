# Task 39 — Expand owner notifications: agent chat channel + Telegram

**Status: ready for Cline.** Independent of Task 38 (can be built in parallel or either order) — this task generalizes the notification MECHANISM; Task 38 is what makes the agent channel this task adds actually useful (a stuck campaign notification landing in the chat is more valuable once the agent can act on it). No hard dependency either direction.

## The ask, as given (2026-09-13)

> there is an email system working that emails me when something is stucked in the mailing, i got it today we can expand to agent as well, and also we will add the same notification system thats in vantra, so user can link there telegram and set notifications and we use that also to notify users.

Two things:
1. The email-only "something's stuck" notifications that already exist should ALSO be able to reach the agent chat panel and Telegram, not just email.
2. Users should be able to link their own Telegram (same pattern as Vantra, the owner's other product) and choose which notification channels they want.

## What already exists (verified 2026-09-13, don't rebuild)

Two real notification call sites today, both email-only via `lib/email.ts`'s `sendEmail()`:
- `lib/automation-run.ts`'s `notifyNeedsConfirmation()` — a daily automation finished extracting and needs the owner's confirmation before sending.
- `app/api/internal/mail-queue-drain/route.ts`'s batch-gate pause block (~line 368) — a campaign got paused after a deliverability probe came back spam/unknown. **This is the exact "stuck in mailing" email the owner just received.**

Both write to `NotificationLog` (`prisma/schema.prisma`), whose `channel` field is `String // "email" | "telegram" — SpaceWorker is email-only for now, kept generic` — this was already anticipated, just never built. `lib/email.ts` even says in a comment: *"Uses a SEPARATE Resend account/API key from Vantra's"* — so Vantra is a sibling product already known to this codebase's own history; there's no need to go find Vantra's code, the pattern being asked for is the standard one (bot-linking deep link → chat id → preference toggles) and this doc specs it directly.

## 1. A shared multi-channel dispatcher (`lib/notify.ts`, new)

Replace ad-hoc `sendEmail()` calls at the two sites above with one function:

```ts
notifyUser(userId: string, opts: {
  eventType: string;          // e.g. "batch_deliverability_pause", "automation_needs_confirmation"
  subject: string;            // email subject line
  emailHtml: string;          // existing HTML builders, unchanged
  telegramText: string;       // short plain-text version for Telegram
  agentText: string;          // short plain-text version for the agent chat thread
  link?: string;              // optional deep link appended to telegram/agent text
}): Promise<void>
```

It fans out based on the user's own preferences (item 3 below), best-effort per channel (one channel's failure must never block another's — same discipline `sendEmail` already applies to its own Resend call vs. its audit-log write). Each channel attempt gets its own `NotificationLog` row (`channel: "email" | "telegram" | "agent"`) so the audit trail shows exactly what was tried and what succeeded, per user, per event.

Migrate both existing call sites to `notifyUser` — this must not change today's default behavior for a user who hasn't touched notification settings (email stays on by default, see item 3).

## 2. Telegram channel (`lib/telegram.ts`, new)

- New env vars: `TELEGRAM_BOT_TOKEN` (the bot's API token from @BotFather) and `TELEGRAM_BOT_USERNAME` (for building the deep link). Add to `lib/env.ts` (optional/fail-soft, same pattern as `CHANNELRY_AI_API_KEY` — Telegram notifications simply don't fire if unconfigured, everything else keeps working) and `.env.example`.
- `sendTelegramMessage(chatId: string, text: string): Promise<void>` — thin wrapper around the Bot API's `POST https://api.telegram.org/bot<token>/sendMessage`, mirroring `lib/email.ts`'s error-handling shape (throws with a clear message on failure, caller decides whether to swallow).
- **Linking flow**: `User` gains `telegramChatId String?`, `telegramLinkToken String?` (a short-lived random token, cleared once used). Settings page generates/shows a "Connect Telegram" deep link: `https://t.me/<TELEGRAM_BOT_USERNAME>?start=<telegramLinkToken>`. New webhook route `app/api/telegram/webhook/route.ts` — Telegram POSTs here on any bot interaction; verify the request via the secret path segment or `X-Telegram-Bot-Api-Secret-Token` header (set at `setWebhook` time), parse a `/start <token>` message, match `token` to a `User.telegramLinkToken`, set `telegramChatId` to the sender's chat id, clear the token, and reply with a confirmation message via `sendTelegramMessage`. This route is NOT session-authed (Telegram calls it directly) — its only trust boundary is the secret token check, which must be present and correct.
- Settings page (`app/dashboard/settings/page.tsx`) gets a "Notifications" section: shows linked/unlinked state, the connect link/QR-friendly URL when unlinked, an "Unlink" action (clears `telegramChatId`) when linked.

## 3. Per-channel preferences

`User` gains three booleans: `notifyEmail Boolean @default(true)`, `notifyTelegram Boolean @default(false)` (off until linked — flipping it on before linking is a no-op, `notifyUser` should just skip telegram when `telegramChatId` is null regardless of the flag), `notifyAgent Boolean @default(true)`. Settings UI: three toggles in the same Notifications section, a normal `PATCH /api/settings` (extend the existing settings route, or add `app/api/settings/notifications/route.ts` if that reads cleaner — match whatever `change-password/route.ts` already does for the auth/validation pattern).

## 4. The agent channel

When `notifyAgent` is true (default) and the user has an `AgentThread`, `notifyUser` inserts a new `AgentMessage` (`role: "assistant"`, `content: opts.agentText` (+ link if given)) directly into their thread — no LLM call, this is a system-authored message, not a model turn. It shows up next time they open "Ask the agent" exactly like any assistant reply, satisfying "expand to agent as well" without inventing a second inbox. If Task 38 has landed by the time this is built, prefer attaching the relevant `inlineWidget`/plan-card context (e.g. a `campaign_status_list` widget for the specific paused campaign) instead of bare text — check whether `lib/agent.ts`'s widget types already cover this case before adding a new one.

## Explicitly out of scope

- Two-way Telegram chat (talking to the agent FROM Telegram) — this task is notification-out only, matching the literal ask ("so user can link there telegram and set notifications and we use that also to notify users").
- Any change to what triggers a notification — only the two existing trigger points from item 0, delivered through more channels. No new notification EVENTS in this pass (Task 38's future stuck-campaign findings, once it exists, should also route through `notifyUser` — a small follow-up wire-up, not new event design).
- Push notifications / web push / SMS.

## Verification expected

- `npx tsc --noEmit` / `npm run build` clean.
- Trigger both existing notification events for real (a real paused campaign, a real daily-automation needing confirmation) and confirm each configured channel actually fires — email (already working, must keep working identically), Telegram (link a real chat, confirm the message arrives), and the agent thread (confirm the message appears in the chat panel on next load).
- Confirm the webhook route rejects a request without the correct secret token (403/401), and that a `/start` with an invalid/expired token doesn't link to the wrong account.
- Confirm turning `notifyTelegram`/`notifyAgent` off actually suppresses that channel while `notifyEmail` keeps working — and that a user who never opens Settings still gets email exactly as before (the default-on/off split from item 3 preserves current behavior).
