/**
 * Merge-variable renderer for the Mailer.
 *
 * A recipient's uploaded-CSV columns are stored per-`EmailQueueItem` in
 * `variables: Json` (e.g. `{ "firstName": "Ada", "company": "ACME" }`). This turns
 * `{{firstName}}`-style placeholders in a variant's subject/bodyHtml into concrete
 * values, applied at send time (not queue time) so editing a template later never
 * requires re-parsing the CSV.
 *
 * Behaviour contract:
 *  - Placeholder syntax: `{{name}}` or `{{ name }}` (whitespace around the key is
 *    tolerated).
 *  - A missing/empty variable renders to an empty string (never a literal
 *    `{{name}}` and never another recipient's value).
 *  - Leftover placeholders whose key isn't a known variable are also rendered to
 *    an empty string rather than leaking, so a recipient never sees someone
 *    else's data or a raw brace token.
 */

export function renderMerge(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_\-]+)\s*\}\}/g, (match, key: string) => {
    const value = variables[key];
    return typeof value === "string" ? value : "";
  });
}