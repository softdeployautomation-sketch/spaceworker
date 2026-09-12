import "server-only";
import dns from "node:dns/promises";

// Task 26, Piece 3 — survival-mode email deliverability validation, ported from
// the standalone Lead Extractor's proven validator (app/lead_manager/validator.py):
//
//   1. RFC-ish syntax/format check (instant, no I/O).
//   2. DNS MX record lookup on the domain — confirms the domain actually accepts
//      mail, cached per-domain in-process so repeated domains (gmail.com,
//      yahoo.com, ...) in one batch are instant after the first lookup.
//
// Deliberately NOT an SMTP handshake: SMTP is slow, unreliable from a shared VPS,
// and (crucially) has no cached/safe bulk story. MX checking is the fast, proven
// approach — the same one the standalone (and virtually every list-hygiene tool)
// relies on.

const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const mxCache = new Map<string, boolean>();

export interface ValidationResult {
  email: string;
  isValid: boolean;
  reason?: "invalid_format" | "no_mx_records";
}

async function domainHasMx(domain: string): Promise<boolean> {
  if (mxCache.has(domain)) return mxCache.get(domain)!;
  try {
    const records = await dns.resolveMx(domain);
    // resolveMx[] is empty rather than throwing when the domain simply
    // publishes no MX records (a valid but un-hosted domain) — only DNS
    // FAILURE (NXDOMAIN / SERVFAIL / no such host) throws. Both cases are
    // "not deliverable", so collapse them and cache the result.
    const ok = records.length > 0;
    mxCache.set(domain, ok);
    return ok;
  } catch {
    mxCache.set(domain, false);
    return false;
  }
}

export async function validateEmail(rawEmail: string): Promise<ValidationResult> {
  const email = rawEmail.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return { email, isValid: false, reason: "invalid_format" };
  }
  const domain = email.split("@")[1];
  const hasMx = await domainHasMx(domain);
  return hasMx
    ? { email, isValid: true }
    : { email, isValid: false, reason: "no_mx_records" };
}

// Batch helper — validates many emails with bounded concurrency so a large batch
// doesn't fire hundreds of simultaneous DNS lookups at once. The per-domain cache
// above means a batch dominated by a few common domains is fast regardless of size.
export async function validateEmailsBatch(
  emails: string[],
  concurrency = 20,
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = new Array(emails.length);
  let index = 0;
  async function worker() {
    while (index < emails.length) {
      const i = index++;
      results[i] = await validateEmail(emails[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, emails.length) }, worker));
  return results;
}