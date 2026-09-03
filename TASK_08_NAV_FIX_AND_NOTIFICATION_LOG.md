# SpaceWorker Task 8 — Dashboard Nav Fix + Notification Audit Log

**Assigned to Cline.** Two independent, ready-now pieces — neither blocked on anything pending. Do them in order; Part A is a 10-minute fix, Part B is real new infrastructure.

## Part A — Dashboard sidebar is missing three real features

Confirmed live: Task 6 (Browser Profiles) is deployed and working (`app/dashboard/browser-profiles/page.tsx`), and Mailboxes/Campaigns (Task 4) are deployed and working — but **none of the three have a sidebar nav entry**. They're only reachable via two cards on the Overview page. Add them to `components/dashboard-nav.tsx`'s (or wherever the sidebar item list lives) nav items array: "Mailboxes" → `/dashboard/mailboxes`, "Campaigns" → `/dashboard/campaigns`, "Browser Profiles" → `/dashboard/browser-profiles`. Match the existing nav item shape/icon convention already used for whatever's there today (likely just "Overview" + "Settings").

## Part B — Notification audit log (new infrastructure, cross-platform pattern)

**Context**: SpaceWorker and Vantra both send notifications (email on signup/verification, and — once the payment-flow redesign lands, separately tracked — payment-related emails/Telegram alerts). Right now nothing records "a notification was actually sent" as its own durable record — sends either fire-and-forget or silently fail. The user wants a dedicated admin tab on both products listing every notification sent: event type, recipient, channel, timestamp, delivery outcome. This task is the SpaceWorker half; Vantra gets the equivalent separately.

### Prisma model

```prisma
model NotificationLog {
  id         String   @id @default(cuid())
  userId     String?  // null for admin-only notifications (no specific user)
  user       User?    @relation(fields: [userId], references: [id])
  eventType  String   // e.g. "verification_code", "payment_pending", "payment_confirmed" (grow this enum-by-convention as new sends are added)
  channel    String   // "email" | "telegram" (SpaceWorker doesn't have Telegram yet — email only for now, but keep the field generic so it's ready if that changes)
  recipient  String   // the email address or chat id actually targeted, for audit purposes
  outcome    String   @default("sent") // "sent" | "failed"
  errorMessage String? // populated when outcome is "failed"
  createdAt  DateTime @default(now())

  @@index([userId, createdAt])
  @@index([eventType, createdAt])
}
```
Add `notificationLogs NotificationLog[]` to `User`. Migration: `npx prisma migrate dev --name add_notification_log`.

### Wiring

Every existing send path in `lib/email.ts` (`sendEmail`, `sendVerificationEmail`) should write one `NotificationLog` row per attempt — wrap the actual send in a try/catch, log `outcome: "sent"` on success or `outcome: "failed"` + `errorMessage` on failure, and **still let the original call succeed/fail as it does today** (the logging is additive, never blocking or altering existing behavior). Don't retrofit this as a decorator/wrapper that changes call signatures across the codebase — the simplest correct approach is adding the log-write call at the bottom of each existing send function, right where the actual send already happens.

### Admin UI

New tab in the admin panel (wherever `/admin`'s existing tabs live — Users/Payments/Browser Profiles etc.) called "Notifications": a table (event type, recipient, channel, outcome badge, timestamp), most recent first, paginated (don't load the whole table at once — same `take`/`skip` pattern likely already used for other admin list views in this codebase). A simple filter by outcome (all / sent / failed) is a nice-to-have, not required for v1.

## Explicitly not in this task

- Any of the new payment-flow notification events (top-up submitted, admin confirmed/rejected) — those land once the payment-flow redesign itself is built, as part of that work, not here. This task's job is just to have `NotificationLog` and the admin tab **ready** so those future events have somewhere to log to.
- Telegram logging — SpaceWorker has no Telegram integration yet; the `channel` field is just future-proofed for it.

## Verification

1. Confirm the three new sidebar links appear and correctly navigate.
2. Sign up a fresh test account, confirm a `NotificationLog` row is created for the verification email with `outcome: "sent"`.
3. Temporarily break `RESEND_API_KEY` (or otherwise force a failure) and confirm a `failed` row is logged with a real error message, and that the signup flow itself still degrades the same way it does today (this task must not change existing error-handling behavior, only add logging alongside it).
4. Confirm the admin Notifications tab renders the logged rows correctly, most recent first.
