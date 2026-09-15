/**
 * SpaceWorker local extraction engine — public API.
 *
 * A dependency-free TypeScript port of the *deterministic core* of the production
 * Python extraction worker (`worker/*`), intended to be bundled into the desktop
 * Extractor EXE (Task 27 Part A) and run/tested in isolation (`tsx --test`).
 *
 * Only the pure string-processing / query-building logic is ported here. The
 * I/O layer (search-engine crawling, page/PDF fetching, contact-link discovery
 * via an HTML parser, job scheduling, persistence) is intentionally out of scope
 * — see local-engine/README.md.
 */
export {
  extractEmails,
} from "./extractors/email";
export {
  extractBusinessName,
  extractContactNames,
  extractNamesFromEmail,
} from "./extractors/name";
export {
  extractPhones,
  cleanPhone,
} from "./extractors/phone";
export {
  coerceEmailString,
  normalizeEmailCellToAddresses,
} from "./utils/email-normalize";
export {
  type EmailDomainRules,
  isEmptyRules,
  normalizeDomainToken,
  parseEmailDomainAllowlist,
  emailMatchesRules,
  leadRowMatchesEmailRules,
  filterLeadsByEmailDomains,
  parseSiteDomainsForSearch,
  domainsToSiteClause,
  buildSiteRestrictionClause,
  prepareSiteRestrictionForAutomation,
  applySiteRestrictionToQuery,
  siteRestrictionTargetsOnlyPdfRareHosts,
} from "./filters/email-domain-rules";
export {
  EXPANSION_SUFFIXES,
  SUFFIX_PAIR_INDICES,
  MAX_TOTAL_QUERIES_SAFETY_CEILING,
  MAX_QUERY_CHARS,
  roundQueries,
  biasQueryTowardPdfs,
} from "./query";
export {
  type SearchResult,
  type Lead,
  buildLeads,
} from "./lead";
export {
  MAX_CONTACT_LINKS_PER_PAGE,
  MAX_EMBEDDED_PDFS_PER_PAGE,
  CONTACT_LINK_KEYWORDS,
  CRAWL_USER_AGENT,
  type Anchor,
  absoluteUrl,
  netlocOf,
  decodeDdgUrl,
  scanHtml,
  extractAnchors,
  htmlToText,
  findContactLinks,
  findEmbeddedPdfLinks,
} from "./html";
export {
  type CrawlDeps,
  type ExtractLeadPageOptions,
  type HtmlAnchor,
  extractLeadPage,
  leadsFromPageText,
  extractLeadPdf,
  defaultFetcher,
} from "./crawl";
export {
  PDF_CONTENT_TYPES,
  PDF_MAGIC,
  type PdfProbeDeps,
  isPdfUrlPath,
  isPdfContentType,
  sniffPdfMagic,
  isPdfResult,
  defaultProbe,
} from "./pdf";
export {
  type PdfTextDeps,
  fetchPdfText,
  parsePdfTextWithPdfjs,
  defaultPdfTextDeps,
} from "./pdf-text";

/** Current module major/minor for tooling/diagnostics. */
export const ENGINE_VERSION = "0.3.0";