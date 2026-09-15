/**
 * Lead building — TypeScript port of `worker/automation.py`'s `_build_leads`
 * (and the `SearchResult` data shape it consumes).
 *
 * This is the deterministic step that turns one page's extracted emails/phones/
 * names into 0..N lead dicts, mirroring the engine's original convention:
 * one lead PER EMAIL (falling back to a single phone/name-only lead when no email
 * was found at all, and to nothing when none of the three were found).
 */
import { extractBusinessName } from "./extractors/name";

/** Mirror of automation.py's `SearchResult` dataclass. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** The lead object shape the worker emits (Prisma `Lead`-friendly, singular strings). */
export interface Lead {
  email: string | null;
  phone: string | null;
  contactName: string | null;
  businessName: string;
  website: string;
  sourceUrl: string;
  snippet: string;
}

/**
 * Turn one page's extracted emails/phones/names into 0..N lead dicts.
 * Mirrors `_build_leads(result, emails, phones, contact_names)`.
 */
export function buildLeads(
  result: SearchResult,
  emails: string[],
  phones: string[],
  contactNames: string[],
): Lead[] {
  const businessName = extractBusinessName(result.title, result.url, result.snippet);
  const common = {
    businessName,
    website: result.url,
    sourceUrl: result.url,
    snippet: result.snippet,
  };

  if (emails.length) {
    const leads: Lead[] = [];
    for (let i = 0; i < emails.length; i++) {
      const contactName =
        i < contactNames.length ? contactNames[i] : contactNames.length ? contactNames[0] : null;
      const phone = i < phones.length ? phones[i] : phones.length ? phones[0] : null;
      leads.push({ email: emails[i], phone, contactName, ...common });
    }
    return leads;
  }

  if (phones.length || contactNames.length) {
    return [
      {
        email: null,
        phone: phones.length ? phones[0] : null,
        contactName: contactNames.length ? contactNames[0] : null,
        ...common,
      },
    ];
  }

  return [];
}