import "server-only";
import { htmlToPlainText } from "./html-to-text";
import { generateUnsubscribeToken } from "./unsubscribe-token";
import { env } from "./env";

/**
 * Task 144 — the ONE place a campaign message is assembled.
 *
 * WHY THIS MODULE EXISTS: the real send (app/api/internal/mail-queue-drain) and
 * the test/preview send (lib/deliverability.ts's runTestSend) used to build their
 * MIME payloads SEPARATELY, and they had drifted apart in exactly the two ways
 * that decide whether a message reaches an inbox:
 *
 *   - the drain sent `text` (a plaintext alternative); the test send did NOT, so
 *     every test was an HTML-only single-part message — a long-documented spam
 *     heuristic. The "deliverability gate" was therefore grading a message nobody
 *     was ever going to receive.
 *   - the drain sent `List-Unsubscribe` / `List-Unsubscribe-Post` and a visible
 *     footer link; the test send sent neither, so a test could pass cleanly while
 *     the real send was filtered for LACKING an unsubscribe mechanism.
 *
 * Confirmed live 2026-09-29: a hand-built plain-text "hello" through this same
 * mailbox reached the Comcast INBOX, while the app's campaign/test sends from the
 * identical SMTP login, From address and server did not — the message body was
 * the only variable left. Two independent builders is the class of bug; one
 * shared builder is the fix, and tests/campaign-message.test.ts fails if either
 * caller ever re-inlines its own copy.
 *
 * The subject is passed in already-rendered because only the caller knows it: the
 * drain renders the item's assigned variant/pin with per-recipient merge vars,
 * while a test send may additionally tag it with a lookup token.
 */
export interface CampaignMessage {
  subject: string;
  /** ABSENT for a plain-text-only campaign (see `format` below). */
  html?: string;
  text: string;
  headers: Record<string, string>;
}

export function buildCampaignMessage(opts: {
  /** Already-rendered (merge vars applied) subject line. */
  subject: string;
  /** Already-rendered BODY, without any footer. */
  bodyHtml: string;
  /** The envelope/header From this message is sent as — it is also the mailto arm. */
  from: string;
  /** The recipient, used to mint that recipient's own unsubscribe token. */
  toEmail: string;
  /** Owner of the campaign, used to mint that recipient's own unsubscribe token. */
  userId: string;
  /**
   * Task 144 — "html" (default) sends `bodyHtml` as HTML plus a derived plaintext
   * alternative. "text" sends a PLAIN-TEXT-ONLY message: the body is taken
   * literally (markup and all — that is what the user chose) and there is no HTML
   * part at all. Text-only is the strongest available lever against markup-based
   * spam heuristics, which is why it is offered rather than only fixed.
   */
  format?: "html" | "text";
}): CampaignMessage {
  // The mailto: arm needs no server round-trip and always works even if this app
  // is down; the https: arm is the real one-click action modern clients use.
  const unsubscribeToken = generateUnsubscribeToken(opts.userId, opts.toEmail);
  const unsubscribeUrl = `${env.appBaseUrl}/api/unsubscribe/${unsubscribeToken}`;

  const headers = {
    "List-Unsubscribe": `<mailto:${opts.from}?subject=unsubscribe>, <${unsubscribeUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };

  // A plain-text-only message still needs a findable unsubscribe route, so the
  // footer is appended as TEXT — never by wrapping the body in HTML, which would
  // defeat the entire point of choosing text.
  if (opts.format === "text") {
    return {
      subject: opts.subject,
      text: `${opts.bodyHtml}\n\n--\nUnsubscribe: ${unsubscribeUrl}`,
      headers,
    };
  }

  // The List-Unsubscribe HEADER alone is not enough — confirmed live 2026-09-28:
  // it's invisible metadata most mail clients only surface as their OWN button
  // under specific bulk-sender eligibility rules (Gmail in particular), so a real
  // recipient often sees nothing at all. A VISIBLE footer link in the actual body
  // is what guarantees a recipient can always find it, on every client.
  const html =
    `${opts.bodyHtml}<p style="margin-top:24px;padding-top:12px;border-top:1px solid #e5e7eb;` +
    `font-size:12px;color:#6b7280">If you'd rather not receive these, ` +
    `<a href="${unsubscribeUrl}" style="color:#6b7280;text-decoration:underline">unsubscribe here</a>.</p>`;

  // The plaintext alternative is derived from the BODY only — the footer is
  // appended as text rather than re-converting the HTML we just assembled, so the
  // two parts describe the same content instead of the text part quoting markup.
  const text = `${htmlToPlainText(opts.bodyHtml)}\n\n--\nUnsubscribe: ${unsubscribeUrl}`;

  return { subject: opts.subject, html, text, headers };
}

/**
 * Task 144 — normalise any stored/requested value to a supported format.
 * Lives here (next to the builder that consumes it) so the create route, the
 * PATCH route and the send paths cannot each pick their own default: an unknown
 * value must degrade to "html", i.e. the pre-existing behaviour, never to a
 * surprise text-only blast.
 */
export function normalizeBodyFormat(value: unknown): "html" | "text" {
  return value === "text" ? "text" : "html";
}

