import "server-only";

import { sendEmail } from "./email";
import { env } from "./env";
import { notifyAdmin } from "./telegram";

// TASK_187 S2 — support notifications, both directions, both channels.
//
//   * New ticket created      → OWNER on Telegram + email (admin channel).
//   * Admin replied to ticket → the TICKET'S OWNER by email (user channel).
//
// Mirrors lib/payment-notify.ts exactly: fire-and-forget, best-effort PER
// CHANNEL — notifyAdmin swallows its own Telegram failures and sendEmail
// records its own NotificationLog row (and is .catch()-ed here), so both
// helpers are sync, try/catch-wrapped functions that can never fail the
// request they are merely reporting on (a 201 must stay a 201 even if every
// notify stub throws).

export interface TicketCreatedNotice {
  ticketId: string;
  userEmail: string; // who opened it (from session, not client input)
  subject: string;
  category: string;
}

export interface TicketReplyNotice {
  ticketId: string;
  to: string; // ticket owner's email
  subject: string; // original ticket subject — the reply is "Re: <subject>"
}

const ADMIN_URL = `${env.appBaseUrl}/admin`;
// Where the user reads replies — the support widget lives in the dashboard
// shell (components/shell.tsx mounts SupportWidget once; no deep-link param).
const DASHBOARD_URL = `${env.appBaseUrl}/dashboard`;

/** A new ticket landed — ping the OWNER on BOTH admin channels. */
export function notifyAdminTicketCreated(n: TicketCreatedNotice): void {
  try {
    void notifyAdmin(
      `🎫 [ADMIN] Support ticket ${n.ticketId} · ${n.category} · "${n.subject}"` +
        ` — from ${n.userEmail} — open admin: ${ADMIN_URL}`,
    );

    const to = env.adminEmail;
    if (!to) return;
    void sendEmail({
      to,
      subject: `New support ticket: ${n.subject}`,
      html: [
        `<div style="font-family:sans-serif;max-width:520px">`,
        `<h2 style="margin:0 0 12px">New support ticket</h2>`,
        `<table style="border-collapse:collapse;font-size:14px">`,
        `<tr><td style="padding:4px 12px 4px 0;color:#666">Ticket</td><td>${n.ticketId}</td></tr>`,
        `<tr><td style="padding:4px 12px 4px 0;color:#666">From</td><td>${n.userEmail}</td></tr>`,
        `<tr><td style="padding:4px 12px 4px 0;color:#666">Category</td><td>${n.category}</td></tr>`,
        `<tr><td style="padding:4px 12px 4px 0;color:#666">Subject</td><td>${n.subject}</td></tr>`,
        `</table>`,
        `<p style="font-size:14px"><a href="${ADMIN_URL}">Open the admin support queue</a> to read and reply.</p>`,
        `</div>`,
      ].join(""),
      eventType: "admin_support_ticket",
    }).catch(() => {
      // Best-effort — sendEmail already logged outcome:"failed". An alert must
      // never be able to break the ticket flow it is reporting on.
    });
  } catch (err) {
    console.error("[support-notify] admin ticket alert failed:", err instanceof Error ? err.message : String(err));
  }
}

/** The admin replied — email the TICKET'S OWNER (Telegram is owner-only). */
export function notifyUserTicketReply(n: TicketReplyNotice): void {
  try {
    // A non-email recipient would only be a caller bug; skip rather than throw.
    if (!n.to || !n.to.includes("@")) return;

    void sendEmail({
      to: n.to,
      subject: `Re: ${n.subject}`,
      html: [
        `<div style="font-family:sans-serif;max-width:520px">`,
        `<h2 style="margin:0 0 12px">Support replied to your ticket</h2>`,
        `<p style="font-size:14px;color:#374151">Ticket <strong>${n.ticketId}</strong> — "${n.subject}"</p>`,
        `<p style="font-size:14px;color:#374151">Open your dashboard and use the support widget to read the reply and answer back.</p>`,
        `<p style="font-size:14px"><a href="${DASHBOARD_URL}">Go to your dashboard</a></p>`,
        `</div>`,
      ].join(""),
      eventType: "support_reply",
    }).catch(() => {
      // Best-effort — sendEmail already logged outcome:"failed".
    });
  } catch (err) {
    console.error("[support-notify] user reply alert failed:", err instanceof Error ? err.message : String(err));
  }
}
