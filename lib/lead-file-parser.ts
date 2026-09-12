import * as XLSX from "xlsx";
import { parseCsv } from "./csv";

// Task 26, Piece 3 — lead upload parsing, ported from the standalone Lead
// Extractor's proven, permissive uploader (app/lead_manager/uploader.py).
//
// Import is deliberately PERMISSIVE: rows with no recognizable email are dropped,
// everything else is kept as-is, and email-format validation happens as a SEPARATE
// explicit step (the "Validate all" button) — never automatically at upload time.
//
// Format notes vs. the Python source:
//  - CSV/TSV reuse lib/csv.ts's `parseCsv`, the app's existing hand-rolled RFC-4180
//    parser (this codebase deliberately avoids a CSV dependency — see lib/csv.ts's
//    header comment), then apply the same header→field alias mapping as
//    `normalize_lead`.
//  - JSON and plain-text (one email per line) are trivial and dependency-free.
//  - .xlsx uses the `xlsx` (SheetJS) package, as the plan specifies — it's the only
//    format with no built-in / existing in-repo solution.

export interface ParsedLead {
  email: string;
  businessName?: string;
  contactName?: string;
  phone?: string;
  website?: string;
}

export interface ParseLeadFileResult {
  leads: ParsedLead[];
  messages: string[];
  format: "csv" | "tsv" | "json" | "txt" | "xlsx";
}

// Decode bytes as UTF-8, falling back to Latin-1 for files saved with a legacy
// single-byte encoding (the same fallback the standalone uses), so a stray é in
// a business name never nukes the whole import.
function decode(buf: Buffer): string {
  try {
    return buf.toString("utf-8");
  } catch {
    return buf.toString("latin1");
  }
}

// Mirror `normalize_lead`: lowercases/trims every header, then picks the first
// recognized alias for each standard field (case-insensitive, space/underscore
// tolerant). The alias lists are ported field-for-field from uploader.py.
const EMAIL_ALIASES = ["email", "e-mail", "mail", "email_address", "email address", "contact_email"];
const BUSINESS_ALIASES = ["business_name", "business name", "company", "company_name", "organization", "business"];
const CONTACT_ALIASES = ["contact_name", "contact name", "name", "full name", "contact", "person_name", "first_name"];
const PHONE_ALIASES = ["phone", "phone_number", "phone number", "telephone", "tel", "contact_phone"];
const WEBSITE_ALIASES = ["website", "url", "web", "website_url", "site", "source_url", "source url"];

function normalizeLead(leadData: Record<string, unknown>): ParsedLead {
  const lc: Record<string, string> = {};
  for (const [k, v] of Object.entries(leadData)) {
    if (k != null && v != null) lc[String(k).toLowerCase().trim()] = String(v).trim();
  }

  const firstMatch = (aliases: string[]) =>
    aliases.map((a) => lc[a]).find((v) => v && v.length > 0);

  const email = firstMatch(EMAIL_ALIASES) ?? "";
  const businessName = firstMatch(BUSINESS_ALIASES);
  const contactName = firstMatch(CONTACT_ALIASES);
  const phone = firstMatch(PHONE_ALIASES);
  const website = firstMatch(WEBSITE_ALIASES);

  let resolvedEmail = email;
  if (!resolvedEmail && Object.keys(lc).length === 1) {
    // Single-column fallback: one non-empty value that looks like an address.
    const single = Object.values(lc)[0];
    if (single && single.includes("@")) resolvedEmail = single;
  }

  const out: ParsedLead = { email: resolvedEmail };
  if (businessName) out.businessName = businessName;
  if (contactName) out.contactName = contactName;
  if (phone) out.phone = phone;
  if (website) out.website = website;
  return out;
}

function parseJson(content: string): Record<string, unknown>[] {
  const data = JSON.parse(content);
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    for (const key of ["leads", "items", "records", "data"]) {
      if (Array.isArray((data as Record<string, unknown>)[key])) {
        return (data as Record<string, unknown>)[key] as Record<string, unknown>[];
      }
    }
    return [data as Record<string, unknown>];
  }
  throw new Error("JSON must be an array or an object with a 'leads'/'items'/'records'/'data' key");
}

/** Dispatch by file extension, honoring the plan's "guess by suffix" behavior. */
export function parseLeadFile(
  fileName: string,
  fileContent: Buffer,
): ParseLeadFileResult {
  const messages: string[] = [];
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  let leads: ParsedLead[] = [];
  let format: ParseLeadFileResult["format"] = "txt";

  if (ext === "xlsx" || ext === "xls") {
    format = "xlsx";
    // SheetJS reads bytes directly and returns the first sheet by default.
    const wb = XLSX.read(fileContent, { type: "buffer", cellDates: false });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (sheet) {
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
      leads = rows.map(normalizeLead);
    }
  } else if (ext === "csv" || ext === "tsv") {
    format = ext === "csv" ? "csv" : "tsv";
    const text = decode(fileContent);
    const rows = parseCsv(text);
    if (rows.length === 0) {
      leads = [];
    } else if (rows.length === 1) {
      // No data rows under the header — treat the file as a bare list of emails.
      leads = rows[0]
        .map((c) => c.trim())
        .filter((c) => c.includes("@"))
        .map((email) => ({ email }));
    } else {
      const headers = rows[0];
      const dataRowCount = rows.length - 1;
      const records: Record<string, unknown>[] = [];
      for (let r = 1; r < rows.length; r++) {
        const rec: Record<string, unknown> = {};
        headers.forEach((h, i) => {
          const value = (rows[r][i] ?? "").trim();
          if (h && value) rec[h] = value;
        });
        records.push(rec);
      }
      leads = records.map(normalizeLead);
      if (leads.length !== dataRowCount) {
        messages.push(`${dataRowCount} data rows parsed; ${leads.length} produced records`);
      }
    }
  } else if (ext === "json") {
    format = "json";
    const raw = parseJson(decode(fileContent));
    leads = raw.map((r) => (r && typeof r === "object" ? normalizeLead(r) : { email: String(r) }));
  } else {
    // Plain text — one email per line.
    format = "txt";
    leads = decode(fileContent)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && l.includes("@"))
      .map((email) => ({ email }));
  }

  // Permissive import: drop any row that ended up with no usable email at all.
  const before = leads.length;
  leads = leads.filter((l) => l.email && l.email.trim().length > 0);
  if (before !== leads.length) {
    messages.push(`${before - leads.length} row(s) dropped (no usable email)`);
  }

  if (leads.length === 0) {
    messages.push("No valid leads found in file (no email column/values detected)");
  } else {
    messages.push(`Parsed ${leads.length} leads from file`);
  }

  return { leads, messages, format };
}