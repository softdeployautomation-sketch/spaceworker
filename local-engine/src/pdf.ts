/**
 * PDF result detection — TypeScript port of `worker/automation.py`'s `_is_pdf_result`
 * (and its `_PDF_CONTENT_TYPES` constant). Pure *sniffing* logic: URL-path pattern
 * matching, Content-Type classification, and `%PDF-` magic-byte detection.
 *
 * No binary parsing here — this only decides whether a result is a PDF. The network
 * probe (HEAD + streamed GET) is *injected* via `PdfProbeDeps` so the decision logic is
 * fully testable in isolation while still running for real in the desktop EXE.
 *
 * Faithful behavior port:
 *   1. URL ending in `.pdf`  → PDF, immediately.
 *   2. HEAD Content-Type     → PDF if a known PDF type; a NON-ambiguous non-PDF type
 *                              is trusted and returns false (no GET).
 *   3. HEAD ambiguous/none   → streamed GET: PDF Content-Type OR `%PDF-` magic bytes.
 *   4. Any failure           → false (never crash the caller).
 */
import { CRAWL_USER_AGENT } from "./html";

/** _PDF_CONTENT_TYPES from automation.py (Content-Type variants search engines
 * actually serve PDFs under — application/pdf is the overwhelmingly common one). */
export const PDF_CONTENT_TYPES = new Set([
  "application/pdf",
  "application/x-pdf",
  "application/acrobat",
  "text/pdf",
]);

/** The `%PDF-` magic bytes at the start of an actual PDF file. */
export const PDF_MAGIC = "%PDF-";

/** Content-Type values that say "this is *something*, but not necessarily PDF". */
const AMBIGUOUS_CONTENT_TYPES = new Set(["application/octet-stream", "binary/octet-stream"]);

function normalizeContentType(raw: string | null | undefined): string {
  return (raw ?? "").toLowerCase().split(";")[0].trim();
}

/**
 * True when the URL path ends in `.pdf` (case-insensitive, ignoring a trailing
 * query string and trailing slashes). Mirrors the first branch of _is_pdf_result.
 */
export function isPdfUrlPath(url: string): boolean {
  const path = url.toLowerCase().split("?")[0].replace(/\/+$/, "");
  return path.endsWith(".pdf");
}

/** True when a Content-Type header classifies the payload as a PDF. */
export function isPdfContentType(contentType: string | null | undefined): boolean {
  return PDF_CONTENT_TYPES.has(normalizeContentType(contentType));
}

/** True when a payload's leading bytes carry the `%PDF-` magic marker. */
export function sniffPdfMagic(bodyStart: string | null | undefined): boolean {
  return (bodyStart ?? "").startsWith(PDF_MAGIC);
}

/** Network probe injected into isPdfResult — simulates a HEAD + streamed GET. */
export interface PdfProbeDeps {
  /** HEAD request: return { contentType } on success, or {} / throw on failure. */
  head(url: string): Promise<{ contentType?: string }>;
  /** Streamed GET: return { contentType?, bodyStart? } (bodyStart = leading bytes). */
  getBytes(url: string): Promise<{ contentType?: string; bodyStart?: string }>;
}

/**
 * Cheap-reliable PDF detection before deciding which extractor to run.
 * Ported from _is_pdf_result(url).
 */
export async function isPdfResult(url: string, deps: PdfProbeDeps): Promise<boolean> {
  // 1. URL ends in .pdf — no network needed.
  if (isPdfUrlPath(url)) return true;

  // 2. HEAD Content-Type.
  try {
    const head = await deps.head(url);
    if (head.contentType) {
      if (isPdfContentType(head.contentType)) return true;
      const ct = normalizeContentType(head.contentType);
      // Server gave an unambiguous non-PDF answer — trust it.
      if (ct && !AMBIGUOUS_CONTENT_TYPES.has(ct)) return false;
    }
  } catch {
    // HEAD unsupported/failed (405, connection reset) — fall through to a real GET.
  }

  // 3. Streamed GET, checked by Content-Type then by `%PDF-` magic bytes, closed
  //    immediately anyway since the real extraction re-fetches in extractLeadPdf.
  try {
    const get = await deps.getBytes(url);
    if (get.contentType && isPdfContentType(get.contentType)) return true;
    if (sniffPdfMagic(get.bodyStart)) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * A default PdfProbeDeps using the runtime's global `fetch` (HEAD + a streamed GET
 * that reads only the leading chunk) with the engine's browser User-Agent and a 5s
 * timeout (mirrors _is_pdf_result's timeout=5). Returns {}/relevant fields on failure.
 */
export function defaultProbe(userAgent: string = CRAWL_USER_AGENT): PdfProbeDeps {
  return {
    async head(url) {
      try {
        const res = await fetch(url, {
          method: "HEAD",
          headers: { "User-Agent": userAgent },
          redirect: "follow",
          signal: AbortSignal.timeout(5_000),
        });
        return { contentType: res.headers.get("content-type") ?? undefined };
      } catch {
        return {};
      }
    },
    async getBytes(url) {
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": userAgent },
          redirect: "follow",
          signal: AbortSignal.timeout(5_000),
        });
        const contentType = res.headers.get("content-type") ?? undefined;
        return { contentType, bodyStart: await readLeadingChunk(res) };
      } catch {
        return {};
      }
    },
  };
}

/** Read only the leading bytes of a fetch Response (stays closed quickly). */
async function readLeadingChunk(res: Response): Promise<string> {
  // `getReader` is an undici runtime extension on the body stream (not always typed);
  // guard it dynamically and fall back to reading the whole buffer if unavailable.
  const readerApi = (res.body as unknown as {
    getReader?: () => { read(): Promise<{ value?: Uint8Array }>; cancel(): Promise<void> };
  } | null);
  if (readerApi?.getReader) {
    try {
      const reader = readerApi.getReader();
      const { value } = await reader.read();
      await reader.cancel();
      if (value && value.length) return new TextDecoder().decode(value);
      return "";
    } catch {
      // fall through to arrayBuffer below
    }
  }
  try {
    const buf = await res.arrayBuffer();
    const head = new Uint8Array(buf, 0, Math.min(buf.byteLength, 8));
    return new TextDecoder().decode(head);
  } catch {
    return "";
  }
}