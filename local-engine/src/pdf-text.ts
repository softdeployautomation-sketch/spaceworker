/**
 * PDF text extraction — TypeScript port of `worker/automation.py`'s `_fetch_pdf_text`
 * (download a PDF and return its extracted text, or "" on any failure).
 *
 * The Python side uses pypdf (`from pypdf import PdfReader`). PDF is a binary format —
 * not something you can hand-roll the way the HTML scanner was — so the byte-to-text
 * step uses a REAL dependency: **pdfjs-dist** (the same rendering engine Firefox uses),
 * loaded lazily so the module stays light until a PDF is actually parsed.
 *
 * Structure (same isolated/testable pattern as everything else):
 *   - `fetchPdfText(url, deps)` — pure orchestration; bytes fetch + text parse are
 *     *injected* via `PdfTextDeps`, so the failure/empty/per-page semantics are fully
 *     testable without a network or a parser.
 *   - `parsePdfTextWithPdfjs(bytes)` — the real byte-to-text step (pdfjs-dist), with
 *     per-page try/catch and encrypted-tolerant behavior mirroring pypdf's usage.
 *   - `defaultPdfTextDeps()` — wires a global-`fetch` bytes fetcher to the pdfjs parser.
 */
import { CRAWL_USER_AGENT } from "./html";

/** Injectables for fetchPdfText — mirrors the fetchHtml/fetchPdfText hooks already. */
export interface PdfTextDeps {
  /** Fetch a PDF's raw bytes; return an EMPTY buffer on ANY failure (unreachable / non-2xx). */
  fetchBytes(url: string, opts?: { userAgent?: string }): Promise<Uint8Array>;
  /** Convert raw PDF bytes to page text (see parsePdfTextWithPdfjs). */
  parsePdfText(bytes: Uint8Array): Promise<string>;
}

/**
 * Download a PDF and return its extracted text, or "" on any failure (unreachable,
 * corrupt, encrypted, scanned-image-only, or parser unavailable). Shared by a PDF
 * result and by a page's embedded-PDF links. Ported from _fetch_pdf_text(url).
 */
export async function fetchPdfText(url: string, deps: PdfTextDeps): Promise<string> {
  let bytes: Uint8Array;
  try {
    bytes = await deps.fetchBytes(url);
  } catch {
    return "";
  }
  if (!bytes || bytes.length === 0) return "";

  let text: string;
  try {
    text = await deps.parsePdfText(bytes);
  } catch {
    return "";
  }
  return text ?? "";
}

/**
 * Byte-to-text via pdfjs-dist: collect extracted text across all pages, per-page
 * try/catch so one bad page doesn't discard the whole document; an encrypted/corrupt
 * document yields "" (mirrors pypdf's is_encrypted check + per-page guard).
 */
export async function parsePdfTextWithPdfjs(bytes: Uint8Array): Promise<string> {
  if (!bytes || bytes.length === 0) return "";

  // Lazy import: keeps the module (and the EXE/app startup) free of pdfjs-dist until
  // a PDF is actually parsed.
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");

  let doc: { numPages: number; getPage(i: number): unknown; destroy?(): Promise<void> } | undefined;
  try {
    const task = getDocument({ data: bytes });
    doc = await task.promise;
  } catch {
    return ""; // encrypted / corrupt / unparseable
  }

  try {
    const pageTexts: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      let text = "";
      try {
        const page = await doc.getPage(i);
        const content = await contentText(page);
        text = content;
      } catch {
        text = ""; // one bad page doesn't discard the whole document
      }
      if (text.trim()) pageTexts.push(text);
    }
    return pageTexts.join("\n");
  } finally {
    try {
      if (doc && typeof doc.destroy === "function") await doc.destroy();
    } catch {
      // best-effort cleanup
    }
  }
}

/** Extract the concatenated text of one parsed pdfjs page. */
async function contentText(page: unknown): Promise<string> {
  const p = page as { getTextContent(): Promise<{ items: Array<{ str?: string }> }> };
  const tc = await p.getTextContent();
  return (tc.items?.map((it) => it.str ?? "").join("")) ?? "";
}

/**
 * Default PdfTextDeps: global `fetch` for bytes (engine User-Agent, 10s timeout,
 * mirrors REQUEST_TIMEOUT_SECONDS) + the pdfjs byte-to-text parser.
 */
export function defaultPdfTextDeps(userAgent: string = CRAWL_USER_AGENT): PdfTextDeps {
  return {
    async fetchBytes(url) {
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": userAgent },
          redirect: "follow",
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return new Uint8Array(0);
        return new Uint8Array(await res.arrayBuffer());
      } catch {
        return new Uint8Array(0);
      }
    },
    parsePdfText: parsePdfTextWithPdfjs,
  };
}