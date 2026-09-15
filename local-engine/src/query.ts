/**
 * Query construction for the extraction engine — TypeScript port of the relevant
 * pure-logic parts of `worker/automation.py`:
 *
 *   - `_EXPANSION_SUFFIXES` / `_SUFFIX_PAIR_INDICES` / `_round_queries`
 *   - `_bias_query_toward_pdfs` (and its `MAX_DDG_QUERY_CHARS` cap)
 *
 * These are the same bulk-document-targeting suffixes the server worker uses to
 * hunt for multi-email rosters/directories rather than one business's contact page.
 * Pure and deterministic (no I/O), so this is safe to run inside the desktop EXE
 * and in the repo's test runner.
 */

// The worker's real expansion-suffix list (see automation.py _EXPANSION_SUFFIXES):
// deliberately hunts for BULK multi-email documents (rosters, membership/staff
// directories, board lists) rather than one business's single contact page.
export const EXPANSION_SUFFIXES: string[] = [
  " directory",
  " roster",
  " members",
  " membership",
  " board of directors",
  " committee",
  " officers",
  " chapter",
  " email directory",
  " staff directory",
  " contact list",
  " member directory",
  " phone directory",
  " directory contact",
  " annual report",
  " meeting minutes",
  " registration form",
  " volunteers",
  " club",
  " association",
  " foundation",
  " nonprofit",
  " public records",
  " state filing",
  " tax exempt",
  " organization",
  " leadership",
  " team",
  " contacts page",
];

/**
 * Precomputed indices of every 2-suffix pair — mirrors Python's
 * `itertools.combinations(range(28), 2)` (378 pairs) used by `_round_queries`.
 */
export const SUFFIX_PAIR_INDICES: Array<[number, number]> = (() => {
  const pairs: Array<[number, number]> = [];
  const n = EXPANSION_SUFFIXES.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) pairs.push([i, j]);
  }
  return pairs;
})();

// Pure safety valve against pathological input (e.g. hundreds of base terms) —
// NOT a design target. Mirrors MAX_TOTAL_QUERIES_SAFETY_CEILING = 20000.
export const MAX_TOTAL_QUERIES_SAFETY_CEILING = 20000;

// Cap applied by _bias_query_toward_pdfs. Mirrors MAX_DDG_QUERY_CHARS = 420.
export const MAX_QUERY_CHARS = 420;

/**
 * Generate the raw candidate query strings for one expansion round, in an order
 * determined ONLY by `round_index` — this determinism is what lets a resumed job
 * regenerate the exact same continuing sequence from a bare `nextQueryIndex`
 * integer. Mirrors `_round_queries(base_terms, round_index)`.
 *
 * Round 0: the original base terms, unmodified.
 * Rounds 1..N: base_terms + ONE single suffix.
 * Rounds after that: base_terms + a PAIR of two different suffixes, cycling
 * through SUFFIX_PAIR_INDICES in order.
 * Returns [] once round_index runs past every pair combination too.
 */
export function roundQueries(baseTerms: string[], roundIndex: number): string[] {
  const n = EXPANSION_SUFFIXES.length;
  if (roundIndex === 0) return [...baseTerms];
  if (roundIndex <= n) {
    const suffix = EXPANSION_SUFFIXES[roundIndex - 1];
    return baseTerms.map((t) => `${t}${suffix}`);
  }
  const pairIdx = roundIndex - n - 1;
  if (pairIdx >= SUFFIX_PAIR_INDICES.length) return [];
  const [i, j] = SUFFIX_PAIR_INDICES[pairIdx];
  const combinedSuffix = `${EXPANSION_SUFFIXES[i]}${EXPANSION_SUFFIXES[j]}`;
  return baseTerms.map((t) => `${t}${combinedSuffix}`);
}

/**
 * Bias a query toward PDFs that actually contain email addresses, using the same
 * "pdf_emails" mode the standalone desktop extractor's search modes use
 * (`filetype:pdf intext:@`). Mirrors `_bias_query_toward_pdfs(query)`.
 */
export function biasQueryTowardPdfs(query: string): string {
  let q = (query ?? "").trim();
  if (!q.toLowerCase().includes("filetype:pdf") && !q.toLowerCase().includes("filetype: pdf")) {
    q = `${q} filetype:pdf`;
  }
  if (!q.toLowerCase().includes("intext:@")) {
    q = `${q} intext:@`;
  }
  if (q.length > MAX_QUERY_CHARS) {
    q = q.slice(0, MAX_QUERY_CHARS).trim();
  }
  return q;
}