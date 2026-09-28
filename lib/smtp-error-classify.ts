import "server-only";

// Classifies a nodemailer SMTP send failure into something the drain can
// actually act on, instead of every failure landing in one undifferentiated
// "failed" bucket with just a raw error string. See EmailQueueItem.errorCategory
// in prisma/schema.prisma for what each category means to the retry/suppression
// logic that reads it.
export type SmtpErrorCategory = "hard_bounce" | "soft_bounce" | "rate_limited" | "auth_failed" | "other";

interface NodemailerLikeError {
  responseCode?: number;
  code?: string;
  message?: string;
}

export function classifySmtpError(e: unknown): SmtpErrorCategory {
  const err = e as NodemailerLikeError | undefined;
  if (!err) return "other";

  if (err.code === "EAUTH") return "auth_failed";

  const msg = (err.message ?? "").toLowerCase();

  // 2026-09-28 — a credential that cannot even be READ is an auth problem, and
  // it is the worst possible one to retry: `transporterForMailbox` throws before
  // any connection is made, so every remaining recipient in the batch fails
  // identically. This matches the raw OpenSSL text from decryptSecret AND the
  // actionable message decryptSecretOrThrow wraps it in, so the category holds
  // whichever path reports it. 50 items previously landed in "failed" with the
  // bare crypto string as the reason and no hint of the cause.
  if (msg.includes("unable to authenticate data") || msg.includes("invalid initialization vector") || msg.includes("cannot be decrypted")) {
    return "auth_failed";
  }

  const throttled = msg.includes("rate") || msg.includes("throttl") || msg.includes("too many");

  const code = err.responseCode;
  if (typeof code === "number") {
    if (code === 535) return "auth_failed";
    if (code >= 400 && code < 500) return throttled ? "rate_limited" : "soft_bounce";
    if (code >= 500) {
      // A content/reputation-based 550 ("high-probability spam", "message
      // discarded") says nothing about whether the ADDRESS itself is valid —
      // suppressing it as a hard bounce would be wrong, and it's not an
      // address problem the campaign's own deliverability gate doesn't
      // already handle separately. Only a genuine "no such user / mailbox
      // unavailable" style 5xx is a real hard bounce.
      if (msg.includes("spam") || msg.includes("discarded") || throttled) return "other";
      return "hard_bounce";
    }
  }

  // Connection-level failures (timeout, reset, DNS) are transient by nature.
  if (err.code === "ETIMEDOUT" || err.code === "ECONNECTION" || err.code === "ESOCKET" || err.code === "EDNS") {
    return "soft_bounce";
  }

  return "other";
}

// Retry backoff by category, minutes before the item is eligible again.
// hard_bounce/auth_failed/other are NOT retried automatically (return null):
// hard_bounce because the address is bad, auth_failed because retrying the
// same broken credential per-recipient wastes every remaining item in the
// batch, other because it's ambiguous (see classifySmtpError above) and
// retrying unchanged content immediately would likely just repeat the same
// outcome — surfaced to the owner instead, same as today.
const RETRY_DELAY_MINUTES: Partial<Record<SmtpErrorCategory, number>> = {
  soft_bounce: 15,
  rate_limited: 60,
};

const MAX_RETRY_ATTEMPTS = 3;

export function nextRetryAt(category: SmtpErrorCategory, attempts: number): Date | null {
  if (attempts >= MAX_RETRY_ATTEMPTS) return null;
  const delayMinutes = RETRY_DELAY_MINUTES[category];
  if (!delayMinutes) return null;
  return new Date(Date.now() + delayMinutes * 60_000);
}
