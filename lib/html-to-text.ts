// A deliberately simple, dependency-free HTML→plaintext conversion for the
// campaign mailer's plaintext MIME alternative. Not meant to be a general
// HTML renderer — good enough that an HTML-only single-part message (a real,
// well-documented spam heuristic) never goes out, without pulling in a new
// npm dependency for it.
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<(br)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
