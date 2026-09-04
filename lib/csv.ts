/**
 * Minimal-but-robust CSV parser used for the Mailer's recipient upload.
 *
 * Supports the subset of RFC 4180 that matters for real recipient lists:
 *  - quoted fields so a value containing a comma/newline works: "Smith, John"
 *  - doubled double-quotes as an escaped quote inside a quoted field: "He said ""hi"""
 *  - CRLF or LF line endings
 *  - a trailing newline on the last row is ignored, blank rows are skipped
 *
 * We deliberately avoid pulling in a CSV dependency for this one parse path (the
 * per-recipient merge-variable flow is the only consumer today); this parser is
 * small, side-effect free, and unit-testable without network access.
 */

export type CsvRow = string[];

export function parseCsv(text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  // Normalise CRLF and lone CR to LF, then iterate char by char.
  const src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        // Lookahead for the escaped-quote pattern "" -> literal ".
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    // Per RFC 4180, a quote only STARTS a quoted field when it's the very
    // first character of that field — a bare quote appearing after other
    // content (e.g. an unquoted value like O"Brien or 5"11) is literal text,
    // not the start of quote-mode (which would otherwise swallow every
    // following comma/newline as literal content until another stray quote).
    if (ch === '"' && field.length === 0) {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      if (row.length > 0 && !(row.length === 1 && row[0].trim() === "")) {
        rows.push(row);
      }
      row = [];
      field = "";
      continue;
    }
    field += ch;
  }

  // Handle a final row with no trailing newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (!(row.length === 1 && row[0].trim() === "")) {
      rows.push(row);
    }
  }

  return rows;
}

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase();
}

export interface CsvRecipient {
  email: string;
  variables: Record<string, string>;
}

export interface ParseRecipientsResult {
  recipients: CsvRecipient[];
  errors: string[];
}

/**
 * Parse an uploaded recipient CSV into { email, variables } records.
 *
 * The first row is the header row. An `email` column is required (matched
 * case-insensitively); every other non-empty cell becomes a per-recipient merge
 * variable (e.g. `firstName` -> `{{firstName}}`). Rows without an email address
 * are skipped and reported. Duplicate emails are dropped (first wins).
 */
export function parseRecipientsCsv(text: string): ParseRecipientsResult {
  const rows = parseCsv(text);
  const recipients: CsvRecipient[] = [];
  const errors: string[] = [];

  if (rows.length === 0) {
    return { recipients: [], errors: ["CSV file is empty"] };
  }

  const headers = rows[0].map(normalizeHeader);
  const emailIndex = headers.indexOf("email");
  if (emailIndex === -1) {
    return {
      recipients: [],
      errors: ["CSV must include an 'email' column (first row is the header row)"],
    };
  }

  const seen = new Set<string>();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const email = (row[emailIndex] ?? "").trim();
    if (!email) {
      errors.push(`Row ${r + 1}: missing email address — skipped`);
      continue;
    }
    // Emails are matched case-insensitively (Foo@x.com == foo@x.com), first wins.
    const emailKey = email.toLowerCase();
    if (seen.has(emailKey)) {
      continue;
    }
    seen.add(emailKey);

    const variables: Record<string, string> = {};
    headers.forEach((header, idx) => {
      if (idx === emailIndex) return;
      const raw = (row[idx] ?? "").trim();
      if (header && raw) variables[header] = raw;
    });

    recipients.push({ email, variables });
  }

  if (recipients.length === 0 && errors.length === 0) {
    errors.push("No recipients found in CSV");
  }

  return { recipients, errors };
}