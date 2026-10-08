import "server-only";

import { sendEmail } from "./email";
import { env } from "./env";

// TASK_187 B3 (MONEY) — the email that tells a user an admin has sent them an
// invoice to pay. Mirrors lib/support-notify.ts / lib/payment-notify.ts:
// synchronous, fire-and-forget, best-effort — a failed email can NEVER fail the
// 201 that created the invoice (sendEmail has already logged its own
// NotificationLog row by the time this .catch() runs).
//
// TASK_181 wording rule: no duration / term / "days" string appears anywhere in
// this email. The invoice states plan + amount + where to pay; the term granted
// on settlement is not part of what the user is being asked to approve here.

export interface InvoiceSentNotice {
  invoiceId: string;
  to: string; // the invoice's user's email (from the DB row, not the body)
  plan: string; // "premium_plus" | "premium_xdevice" — DB CHECK pins both
  amountUsd: number;
}

// Display names for the two plan strings the DB CHECK allows. Local map (not
// support-templates) because this is a money email, not a ticket template —
// and it must keep working even if support copy is reworded.
const PLAN_LABELS: Record<string, string> = {
  premium_plus: "Premium Plus",
  premium_xdevice: "Premium XDevice",
};

// Pay target: the billing page hosts the PremiumInvoiceCard (pay form) — same
// destination the invoice email in TASK_184's flow already uses.
const BILLING_URL = `${env.appBaseUrl}/dashboard/billing`;

/** A new invoice exists — email its owner the plan, amount and pay link. */
export function notifyUserInvoiceSent(n: InvoiceSentNotice): void {
  try {
    // A non-email recipient would only be a caller bug; skip rather than throw.
    if (!n.to || !n.to.includes("@")) return;

    const label = PLAN_LABELS[n.plan] ?? n.plan;
    const amount = `$${Number(n.amountUsd).toFixed(2)} USD`;

    void sendEmail({
      to: n.to,
      subject: `Invoice ready to pay: ${label}`,
      html: [
        `<div style="font-family:sans-serif;max-width:520px">`,
        `<h2 style="margin:0 0 12px">You have a new invoice</h2>`,
        `<table style="border-collapse:collapse;font-size:14px">`,
        `<tr><td style="padding:4px 12px 4px 0;color:#666">Plan</td><td>${label}</td></tr>`,
        `<tr><td style="padding:4px 12px 4px 0;color:#666">Amount</td><td>${amount}</td></tr>`,
        `<tr><td style="padding:4px 12px 4px 0;color:#666">Invoice</td><td>${n.invoiceId}</td></tr>`,
        `</table>`,
        `<p style="font-size:14px">Pay from your billing page — the invoice and its payment
          options are waiting there.</p>`,
        `<p style="font-size:14px"><a href="${BILLING_URL}">Pay this invoice</a></p>`,
        `</div>`,
      ].join(""),
      eventType: "invoice_sent",
    }).catch(() => {
      // Best-effort — sendEmail already logged outcome:"failed". The invoice
      // row itself is saved; the user still sees it on the billing page.
    });
  } catch (err) {
    console.error("[invoice-notify] invoice-sent email failed:", err instanceof Error ? err.message : String(err));
  }
}