// Task 27, Part B — the ONE shared Find × Location cross-multiply, so an
// automation's extract runs build the exact same `queries` list the Extract
// page's form does (flattened "Find in Location" strings, capped at 300 to match
// worker/automation.py's MAX_TOTAL_QUERIES ceiling). Comments adapted from
// app/dashboard/extract/page.tsx's submit handler.

const MAX_QUERIES = 300;

export function buildSearchQueries(findTerms: string[], locationTerms: string[]): string[] {
  const finds = (findTerms ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
  const locs = (locationTerms ?? []).map((t) => t.trim()).filter((t) => t.length > 0);

  // With no Location terms, fall back to just the Find terms unchanged.
  const rawQueries = locs.length === 0 ? finds : finds.flatMap((f) => locs.map((l) => `${f} in ${l}`));
  return rawQueries.slice(0, MAX_QUERIES);
}