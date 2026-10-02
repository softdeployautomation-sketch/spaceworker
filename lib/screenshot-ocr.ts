import "server-only";

// TASK_157 — PNG bytes -> the words that were on the screen.
//
// WHY THIS EXISTS AT ALL: the Channelry relay's vision leg is DOWN (live probe
// 2026-10-02 from the VPS with the real key — messages+tools+image_url returns
// 502 "AI service temporarily unavailable"), so every image-based summary call
// failed and every captured frame sat at summaryError="bad_request" forever.
// The same relay answers a plain TEXT call with a 200 and a good summary. So the
// fix is to stop sending pixels: read the words off the frame HERE, locally, and
// send text.
//
// This is deliberately FREE and NON-DEPENDENT:
//   * no network call — tesseract.js runs the WASM OCR engine in-process;
//   * no API key, no meter, no daily cap, no usage log;
//   * therefore it still works when the AI is unconfigured, over budget, or down,
//     which is precisely the owner's requirement ("users still get the extraction").
//
// MEASURED (real production frame, Gmail, on this codebase's Node):
//   ~6.7s per 1920x1080 frame, 888 characters, confidence 59 — and the text was
//   genuinely readable (folder names, unread counts, tab titles, an email body).
//   Confidence in the 50s-60s is NORMAL for a desktop screenshot: it is dense UI
//   text at small sizes, not a scanned document. We keep the score rather than
//   hiding it, and the UI can explain a low one.
//
// WHY LAZY + WHY AN INJECTED TYPE: importing tesseract.js pulls in a ~44MB WASM
// core. It is imported dynamically (first use only) so `next build`, every other
// route, and the whole test suite never pay for it — the same discipline
// local-engine/src/pdf-text.ts uses for pdfjs-dist. Tests inject a fake OcrFn and
// NEVER run real OCR.

/** The result of reading one frame. */
export interface OcrResult {
  /** The text found. "" means the read worked and the screen had no words. */
  text: string;
  /** Engine confidence, 0-100. */
  confidence: number;
}

/** Reads PNG bytes to text. Injected so tests never load the OCR engine. */
export type OcrFn = (png: Buffer) => Promise<OcrResult>;

export const OCR_DEFAULT_MAX_CHARS = 8000;

/**
 * Below this confidence we keep the text but tell the caller it is a poor read, so
 * the UI can label it rather than presenting garbled words as fact.
 */
export const OCR_LOW_CONFIDENCE = 45;

/** The slice of the tesseract worker API we actually use. */
interface OcrWorker {
  recognize(image: Buffer): Promise<{ data: { text?: string; confidence?: number } }>;
  terminate(): Promise<unknown>;
}

// The real OCR. Loads tesseract.js on first use, then reuses one worker.
let workerPromise: Promise<OcrWorker> | null = null;

/**
 * Lazily create and cache the OCR worker.
 *
 * `createWorker` downloads the language data ON FIRST USE and caches it on disk.
 * That is a one-time ~5MB fetch to the tessdata CDN — NOT per frame. We verified
 * the VPS can reach it (HTTP 200, 2.9MB in 0.37s), so this works in production;
 * if it ever fails, `ocrViaTesseract` throws and the caller records "ocr_failed"
 * on the frame rather than failing the pass.
 */
async function getWorker(lang: string): Promise<OcrWorker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import("tesseract.js");
      return (await createWorker(lang)) as unknown as OcrWorker;
    })().catch((err) => {
      // Do NOT cache a failed construction: the next pass should retry rather
      // than inherit this failure forever.
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

/**
 * Read a frame's text with tesseract.js.
 *
 * Throws on an engine failure — the caller (runSummaryPass) turns that into a
 * per-frame "ocr_failed" marker and moves on. OCR failing must never fail a
 * summary pass, and must never fail a capture.
 */
export const ocrViaTesseract: OcrFn = async (png) => {
  const worker = await getWorker("eng");
  const { data } = await worker.recognize(png);
  return {
    text: (data.text ?? "").trim(),
    confidence: typeof data.confidence === "number" ? data.confidence : 0,
  };
};

/**
 * Tidy raw OCR output for storage and for the UI.
 *
 * OCR of a dense desktop screen produces a lot of runs of spaces and stray empty
 * lines (see the measured sample in this file's header). We collapse them, drop
 * the noise lines, and cap the length. Pure and exported so it is unit-testable
 * without any OCR at all.
 */
export function normaliseOcrText(
  raw: string,
  maxChars = OCR_DEFAULT_MAX_CHARS,
): { text: string; truncated: boolean } {
  const lines = raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    // Collapse runs of spaces/tabs (OCR reads column gaps as many spaces).
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
    // A line with no alphanumerics at all is separator noise from the layout.
    .filter((line) => /[A-Za-z0-9]/.test(line));
  const joined = lines.join("\n").trim();
  if (joined.length <= maxChars) return { text: joined, truncated: false };
  return { text: joined.slice(0, maxChars), truncated: true };
}

/**
 * The OCR leg as the pass consumes it: raw engine output -> a storable record.
 * Returns null when there is nothing worth storing, so the caller leaves the
 * columns NULL ("has not run") rather than writing an empty string that the UI
 * would have to special-case.
 */
export async function extractText(
  ocr: OcrFn,
  png: Buffer,
  opts: { maxChars?: number } = {},
): Promise<{ text: string; confidence: number } | null> {
  const res = await ocr(png);
  const { text } = normaliseOcrText(res.text, opts.maxChars ?? OCR_DEFAULT_MAX_CHARS);
  if (!text) return null;
  return { text, confidence: Math.round(res.confidence) };
}

/** Release the cached OCR worker. Used by tests and long-lived shutdown paths. */
export async function terminateOcr(): Promise<void> {
  const p = workerPromise;
  workerPromise = null;
  if (!p) return;
  try {
    await (await p).terminate();
  } catch {
    // Already gone — nothing to do.
  }
}