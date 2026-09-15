/**
 * Phone Number Extractor — TypeScript port of `worker/extractors/phone_extractor.py`.
 * Pure regex string processing (no I/O). Faithful to the Python original including
 * the `len(phone) >= 10` check (length of the *cleaned string*, not digit count)
 * and the tel: link handling plus date/ZIP exclusions.
 */

// Phone number patterns (US, international, various formats).
const PHONE_PATTERNS = [
  // US formats: (555) 123-4567, 555-123-4567, 555.123.4567
  /\(?\b\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}\b/g,
  // International: +1-555-123-4567, +44 20 7946 0958
  /\+\d{1,3}[\s.\-]?\(?\d{1,4}\)?[\s.\-]?\d{1,4}[\s.\-]?\d{1,9}/g,
  // With country code: 1-800-555-1234
  /\b1[\s.\-]?\d{3}[\s.\-]?\d{3}[\s.\-]?\d{4}\b/g,
];

// Patterns to exclude (dates, zip codes, etc.). The Python original applies these
// with re.match (anchored to the start of the candidate) — anchored here with ^.
const EXCLUDE_PATTERNS = [
  /^\b\d{4}[\/\-]\d{2}[\/\-]\d{2}\b/, // Dates: 2024-01-15
  /^\b\d{2}[\/\-]\d{2}[\/\-]\d{4}\b/, // Dates: 01/15/2024
  /^\b\d{5}[\-]\d{4}\b/, // ZIP+4: 12345-6789
];

/** Clean and normalize a phone number string. Mirrors clean_phone(raw). */
export function cleanPhone(raw: string): string {
  if (!raw) return "";

  let cleaned = raw.trim();

  // Keep only digits, +, -, (, ), spaces.
  cleaned = cleaned.replace(/[^\d+\-() ]/g, "");

  // Remove extra whitespace.
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  // Must have at least 7 digits.
  const digitsOnly = cleaned.replace(/\D/g, "");
  if (digitsOnly.length < 7 || digitsOnly.length > 15) return "";

  return cleaned;
}

/**
 * Extract phone numbers from text and HTML content.
 * Mirrors extract_phones(text, html="") in phone_extractor.py.
 */
export function extractPhones(text: string, html = ""): string[] {
  const phones = new Set<string>();
  const searchText = html ? `${text} ${html}` : text;

  if (!searchText) return [];

  // Look for tel: links in HTML first (most reliable).
  if (html) {
    const telPattern = /href=["']tel:([^"']+)["']/gi;
    for (const m of html.matchAll(telPattern)) {
      const phone = cleanPhone(m[1]);
      if (phone) phones.add(phone);
    }
  }

  // Search with each pattern.
  for (const pattern of PHONE_PATTERNS) {
    for (const m of searchText.matchAll(pattern)) {
      const raw = m[0];

      // Check if it matches an exclusion pattern.
      let isExcluded = false;
      for (const excPattern of EXCLUDE_PATTERNS) {
        if (excPattern.test(raw)) {
          isExcluded = true;
          break;
        }
      }

      if (!isExcluded) {
        const phone = cleanPhone(raw);
        if (phone && phone.length >= 10) {
          phones.add(phone);
        }
      }
    }
  }

  return [...phones].sort();
}