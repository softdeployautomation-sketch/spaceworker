import "server-only";

import { sendEmail } from "./email";
import { env } from "./env";
import { notifyAdmin } from "./telegram";

// TASK_186 — owner (2026-10-07): "email and telegram notification to the usual
// notification route for any pending payment". Every payment that lands in the
// manual-review queue pings the OWNER on both admin channels:
//
//   * Telegram — the established notifyAdmin() route (signups, license binds,
//     campaign pauses already use it; same fixed admin chat).
//   * Email — sendEmail to ADMIN_EMAIL (falls back to EMAIL_FROM so there is a
//       recipient even before ADMIN_EMAIL is set).
//
// Fire-and-forget, best-effort PER CHANNEL — notifyAdmin already swallows its
// own Telegram failures and sendEmail records its own NotificationLog row, so
// this helper is a `void`-safe sync function that can never fail the payment
// request it is merely reporting on.

export interface PendingPaymentNotice {
  paymentId: string;
  product: string; // product id (web_subscription / wallet_topup / xdevice / …)
  amountUsd: number;
  method: string; // crypto kind (usdt_trc20, usdt_erc20, btc)
  stage: string; // "opened" (order created) | "submitted" (customer says paid) | "attach" (hash step)
  status: string; // "pending" | "flagged"
  hasHash: boolean;
  userRef?: string; // userId or email — who is waiting on the confirmation
}

const ADMIN_REVIEW_URL = `${env.appBaseUrl}/admin`;

export function notifyAdminPendingPayment(n: PendingPaymentNotice): void {
  const hashBit = n.hasHash ? "hash given" : "NO hash";
  void notifyAdmin(
    `💳 [ADMIN] Pending payment $${n.amountUsd} · ${n.product} · ${n.method} · ${n.status}` +
      ` (${hashBit}, ${n.stage}) — confirm in admin: ${ADMIN_REVIEW_URL}`,
  );

  const to = env.adminEmail;
  if (!to) return;
  void sendEmail({
    to,
    subject: `Pending payment: $${n.amountUsd} — ${n.product} awaiting your confirmation`,
    html: [
      `<div style="font-family:sans-serif;max-width:520px">`,
      `<h2 style="margin:0 0 12px">Pending payment awaiting confirmation</h2>`,
      `<table style="border-collapse:collapse;font-size:14px">`,
      `<tr><td style="padding:4px 12px 4px 0;color:#666">Payment</td><td>${n.paymentId}</td></tr>`,
      `<tr><td style="padding:4px 12px 4px 0;color:#666">Product</td><td>${n.product}</td></tr>`,
      `<tr><td style="padding:4px 12px 4px 0;color:#666">Amount</td><td>$${n.amountUsd}</td></tr>`,
      `<tr><td style="padding:4px 12px 4px 0;color:#666">Method</td><td>${n.method}</td></tr>`,
      `<tr><td style="padding:4px 12px 4px 0;color:#666">Hash</td><td>${n.hasHash ? "given" : "NOT given"}</td></tr>`,
      `<tr><td style="padding:4px 12px 4px 0;color:#666">Stage</td><td>${n.stage} → ${n.status}</td></tr>`,
      n.userRef ? `<tr><td style="padding:4px 12px 4px 0;color:#666">User</td><td>${n.userRef}</td></tr>` : ``,
      `</table>`,
      `<p style="font-size:14px"><a href="${ADMIN_REVIEW_URL}">Open the admin payments queue</a> to approve or reject it.</p>`,
      `</div>`,
    ].join(""),
    eventType: "admin_pending_payment",
  }).catch(() => {
    // Best-effort — sendEmail already logged outcome:"failed". An alert must
    // never be able to break the payment flow it is reporting on.
  });
}
