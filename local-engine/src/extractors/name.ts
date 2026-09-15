/**
 * Name Extractor — TypeScript port of `worker/extractors/name_extractor.py`.
 * Pure regex string processing (no I/O). Mirrors the Python original's three
 * functions and their exact output strings so the desktop EXE produces the same
 * business/contact names the server worker does.
 */

const COMMON_PAGES = new Set([
  "home",
  "about",
  "contact",
  "services",
  "products",
  "blog",
  "news",
  "faq",
  "help",
  "login",
  "sign up",
  "about us",
  "contact us",
  "our services",
]);

const TITLE_SEPARATORS = [" | ", " - ", " – ", " — ", " :: ", " >> ", " : "];

const TRAILING_PATTERNS = [
  /\s*[-–—]\s*Home\s*$/i,
  /\s*[-–—]\s*Official Site\s*$/i,
  /\s*[-–—]\s*Official Website\s*$/i,
  /\s*\|\s*Home\s*$/i,
  /\s*®\s*$/i,
  /\s*™\s*$/i,
  /\s*Inc\.?\s*$/i,
  /\s*LLC\.?\s*$/i,
  /\s*Ltd\.?\s*$/i,
  /\s*Corp\.?\s*$/i,
];

/**
 * Extract the most likely business name from a search result.
 * Mirrors extract_business_name(title, url, snippet) in name_extractor.py.
 * (Note: `url`/`snippet` are part of the original signature but unused by the
 * current implementation — kept for signature parity.)
 */
export function extractBusinessName(title: string, url = "", snippet = ""): string {
  if (!title) return "";

  const name = title.trim();

  let out: string | undefined;
  // Remove common title separators and what follows.
  for (const sep of TITLE_SEPARATORS) {
    if (name.includes(sep)) {
      const parts = name.split(sep);
      for (const part of parts) {
        const partClean = part.trim();
        if (!COMMON_PAGES.has(partClean.toLowerCase()) && partClean.length > 2) {
          out = partClean;
          break;
        }
      }
      break;
    }
  }
  let result = out ?? name;

  // Remove trailing common words.
  for (const pattern of TRAILING_PATTERNS) {
    result = result.replace(pattern, "").trim();
  }

  return result.length > 1 ? result : "";
}

// Pattern: Title + Name (e.g., "Dr. John Smith", "Mr. Jane Doe").
const TITLE_PATTERN = /\b(Mr|Mrs|Ms|Miss|Dr|Prof|Rev|Sr|Jr)\.?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/g;

// Pattern: "Contact: Name" or "Contact Person: Name".
const CONTACT_PATTERN = /(?:contact(?:\s+person)?|owner|manager|director|ceo|founder|president)\s*[:\-–]\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/gi;

// Pattern: "By FirstName LastName" (author attribution).
const AUTHOR_PATTERN = /\b(?:by|author|written by|posted by)\s+([A-Z][a-z]+\s+[A-Z][a-z]+)\b/g;

/**
 * Extract potential person names from text content.
 * Mirrors extract_contact_names(text) in name_extractor.py.
 */
export function extractContactNames(text: string): string[] {
  const names = new Set<string>();

  for (const m of text.matchAll(TITLE_PATTERN)) {
    // Original formats `"{group1}. {group2}"` — always inserts ". " even when no dot present.
    names.add(`${m[1]}. ${m[2]}`);
  }

  for (const m of text.matchAll(CONTACT_PATTERN)) {
    names.add(m[1].trim());
  }

  for (const m of text.matchAll(AUTHOR_PATTERN)) {
    names.add(m[1].trim());
  }

  return [...names].sort();
}

/**
 * Attempt to derive a name from an email address, e.g. john.smith@company.com -> "John Smith".
 * Mirrors extract_names_from_email(email) in name_extractor.py.
 */
export function extractNamesFromEmail(email: string): string {
  if (!email || !email.includes("@")) return "";

  const localPart = email.split("@")[0];

  // Common separators in email local parts.
  for (const sep of [".", "_", "-"]) {
    if (localPart.includes(sep)) {
      const parts = localPart.split(sep);
      // Filter out numbers and very short parts.
      const nameParts = parts
        .filter((p) => p.length > 1 && !/^\d+$/.test(p) && /^[a-zA-Z]+$/.test(p))
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase());
      if (nameParts.length >= 2) return nameParts.slice(0, 3).join(" "); // Max 3 parts
      break;
    }
  }

  return "";
}