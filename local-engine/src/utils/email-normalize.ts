/**
 * Email normalization — TypeScript port of `worker/utils/email_normalize.py`.
 * The Python original was itself extracted from lead-extractor's exporter.py and
 * deliberately does NOT import that module (it carries a commercial license
 * secret). Only the two self-contained functions needed by the domain-rules
 * filter are ported here.
 */
import { extractEmails } from "../extractors/email";

/**
 * Strip mailto:, angle brackets, trailing punctuation — one candidate string.
 * Mirrors _coerce_email_string(s) in email_normalize.py.
 */
export function coerceEmailString(s: string | null): string | null {
  let t = (s ?? "").trim().replace("\n", " ").replace("\r", "");
  if (!t || !t.includes("@")) return null;

  if (t.toLowerCase().startsWith("mailto:")) {
    t = t.slice("mailto:".length).split("?")[0].trim();
  }

  const m = /<([a-zA-Z0-9._%+\-]+@[^>\s]+)>/.exec(t);
  if (m) t = m[1].trim();

  t = t.replace(/[.,;)>\]"']+$/, "").trim();
  return t.includes("@") ? t : null;
}

/**
 * Parse one database `email` cell into 0..N addresses (lowercased, trailing dot
 * stripped). Handles comma/space-separated lists and messy PDF extractions the
 * same way as extraction. Mirrors normalize_email_cell_to_addresses(raw).
 */
export function normalizeEmailCellToAddresses(raw: string | null): string[] {
  if (raw === null || !String(raw).trim()) return [];

  const s = String(raw).trim();

  let found = extractEmails(s, "");
  if (found.length) return found;

  const coerced = coerceEmailString(s);
  if (!coerced) return [];

  found = extractEmails(coerced, "");
  if (found.length) return found;

  const c = coerced.toLowerCase().trim().replace(/\.+$/, "");
  if (c.includes("@") && c.split("@", 2)[1].includes(".")) return [c];

  return [];
}