"use client";

import { useState } from "react";

// ---------------------------------------------------------------------------
// TASK_152 M3 — the Screen monitoring TIMELINE (the owner's "summary section").
//
// WHY THIS IS ITS OWN COMPONENT (and its own file): the owner asked to
// "quickly recollect" what a machine was doing without opening every picture, so
// each frame's summary has to sit BESIDE its thumbnail, newest first, in a
// SCROLLABLE list. Keeping the timeline presentational and dependency-free
// (no fetch, no hooks, no Next/router) is what lets it be server-rendered
// against representative frames in a test — so the "a frame with NO summary
// renders sanely" rule is checked against the REAL markup, not a paraphrase.
//
// THE TWO AXES STAY SEPARATE HERE (this is the whole point of the component):
//   * status !== "captured"      -> a real CAPTURE failure, shown in red.
//   * status === "captured" but  -> NORMAL: "not summarised yet", shown muted.
//     summary === null
// A captured frame with no summary must NEVER be coloured like a failure. The
// reason (summaryError) is information, not an error.
// ---------------------------------------------------------------------------

export interface ScreenTimelineFrame {
  id: string;
  status: string;
  failureReason: string | null;
  /** null on a FAILED frame — nothing was captured, so there is no capture time. */
  capturedAt: string | null;
  createdAt: string;
  summary: string | null;
  summaryError: string | null;
  /** Set when retention deleted the raw image but KEPT the summary row. */
  imagePurgedAt: string | null;
  // TASK_157 — the free local extraction, shown behind the "Full extraction"
  // toggle. null = never read; "" WITH ocrAt = read, and there were no words.
  ocrText: string | null;
  ocrAt: string | null;
  ocrConfidence: number | null;
}

/**
 * Why a CAPTURED frame has no summary, in human words (neutral, never red).
 *
 * TASK_168 Bug B — `framesPerDay` is the ADMIN DIAL's resolved value
 * (summaryMaxCalls × 3 images/call), passed in by the caller. It defaults to
 * 24 (the old hardcoded 8 × 3) so existing callers keep reading identically.
 */
export function summaryPendingCopy(summaryError: string | null, framesPerDay = 24): string {
  switch (summaryError) {
    case null:
    case "":
      return "Not summarised yet.";
    case "cap_exhausted":
      return "No summary — today's AI limit for this account is used up.";
    // 2026-10-04 — this is a LOCAL per-device processing limit (TASK_168: the
    // admin "Summaries per device per day" dial, default 24 frames/day),
    // enforced by lib/screenshot-summaries.ts — NOT anything to do with the
    // Channelry AI budget. It used to read as a money problem, which sent the
    // operator chasing a spend cap that was 99.98% unused. Name the limit and
    // say when it clears.
    case "daily_call_budget":
      return `No summary — this machine's daily summary limit (${framesPerDay} frames) is reached. It resets at 00:00 UTC and they will be retried.`;
    // The ONLY copy in this function that is allowed to say "budget": it is set
    // solely from the relay's explicit spend-cap response body.
    case "over_cap":
      return "No summary — the Channelry AI budget is exhausted. It resets at the relay's day boundary.";
    // A bare 429 is back-pressure, NOT money. Never let it read as a budget.
    case "rate_limited":
      return "No summary — the AI service is rate limiting requests right now. Not a budget problem; it will be retried.";
    case "ai_unavailable":
    case "temporarily_unavailable":
      return "No summary — the AI service was unavailable. It will be retried.";
    case "image_missing":
      return "No summary — the stored image could not be read.";
    default:
      return `No summary — ${summaryError}.`;
  }
}

/** A failed frame has no capturedAt, so label it by when the attempt happened. */
export function frameTimestamp(frame: Pick<ScreenTimelineFrame, "capturedAt" | "createdAt">): Date {
  return new Date(frame.capturedAt ?? frame.createdAt);
}

/**
 * Why a FAILED capture reads the way it does — the mirror of summaryPendingCopy
 * above, but for the OTHER axis (status !== "captured", which IS a real error).
 *
 * The stored `failureReason` is NOT a clean enum: it can be a short code
 * ("device_offline"), a code WITH detail ("capture_service_http_500: {…}"), or a
 * RAW upstream dump (a Playwright `locator.click: Timeout … Call log: …`). The
 * owner must never read that last kind on their screen timeline — it reached
 * them once verbatim, as unreadable red text with the one relevant fact buried
 * in it. So the reason is first REDUCED to a short code (`failureCode`), then
 * mapped to a plain sentence. An unknown code is still shown honestly; only a
 * code can reach the sentence, so a dump can never leak through.
 */
const CAPTURE_FAILURE_COPY: Record<string, string> = {
  device_offline:
    "The machine was offline, so nothing could be captured. This clears by itself once it checks in.",
  worker_timeout: "A capture started but never finished. It will be retried.",
  capture_service_token_not_set: "Screen capture is not set up on the server yet.",
  capture_service_unreachable: "The capture service on the server could not be reached.",
  capture_service_http_error: "The capture service could not take the frame. It will be retried.",
  empty_frame: "The screen came back blank, so there was nothing to store.",
  no_frame: "No image was produced for this attempt.",
  capture_failed: "The capture failed. It will be retried.",
  request_too_large: "The request was rejected as too large. It will be retried.",
};

export function captureFailureCopy(reason: string | null): string {
  if (!reason) return "Couldn’t take the frame — no reason was recorded.";
  const code = failureCode(reason);
  return CAPTURE_FAILURE_COPY[code] ?? `Capture failed — ${code}.`;
}

/**
 * Reduce ANY stored reason to a short, speakable code. This is the boundary that
 * keeps raw text off the screen: only a bare code is ever returned.
 */
function failureCode(reason: string): string {
  const raw = reason.trim();
  if (CAPTURE_FAILURE_COPY[raw]) return raw;

  // The raw Playwright dump this codebase used to produce: an OFFLINE machine's
  // Connect button is DISABLED, so the click waits out its 10s timeout and
  // throws a call log. New frames no longer produce it (capture.ts
  // `connectRefusal`), but a frame stored BEFORE that fix must still read as
  // offline rather than as a stack trace.
  if (/locator\.click:\s*Timeout/i.test(raw)) {
    return /(machine is offline|disabled|not enabled)/i.test(raw) ? "device_offline" : "capture_failed";
  }

  // "<code>: <detail>" — keep the code, drop the detail.
  const prefixed = /^([a-z0-9_]{3,40}):/i.exec(raw);
  if (prefixed) {
    const base = prefixed[1].toLowerCase();
    if (CAPTURE_FAILURE_COPY[base]) return base;
    // capture_service_http_500 / _401 / … → one sentence, never the JSON body.
    if (/^capture_service_http_\d{3}$/.test(base)) return "capture_service_http_error";
    return base;
  }

  // A bare short machine code is honest to show; anything longer is a dump.
  return /^[a-z][a-z0-9_]{2,40}$/i.test(raw) ? raw.toLowerCase() : "capture_failed";
}

/**
 * TASK_157 — the per-frame readout: a SUMMARY by default, and a full EXTRACTION
 * behind a toggle, on the same line.
 *
 * WHY BOTH (the owner's requirement): the two legs have completely different
 * dependencies. Extraction is local OCR — free, no key, no meter, no network — so
 * it is there even when the AI is unconfigured, over budget, or down. The summary
 * is the paid, best-effort layer on top. Showing only the summary meant a day with
 * no AI looked like a day with no information at all.
 *
 * The toggle only appears when there is actually text to show. We do not offer a
 * view that is empty.
 */
export function FrameReadout({ frame, framesPerDay = 24 }: { frame: ScreenTimelineFrame; framesPerDay?: number }) {
  const hasText = frame.ocrText !== null && frame.ocrText !== undefined && frame.ocrText !== "";
  const [showText, setShowText] = useState(false);
  const lowConfidence = frame.ocrConfidence !== null && frame.ocrConfidence < 45;

  return (
    <div className="mt-0.5">
      {showText && hasText ? (
        <>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowText(false)}
              data-frame-toggle="summary"
              className="rounded border border-border px-1 text-[10px] text-fg-muted"
            >
              Summary
            </button>
            <span className="text-[10px] text-fg-muted">Full extraction</span>
            {lowConfidence && (
              <span title="The OCR read is uncertain; the words may be wrong.">
                {frame.ocrConfidence}% confident
              </span>
            )}
          </div>
          {/* Long desktop OCR output gets its own scroll box rather than a wall
              of text — the timeline is already a max-h-80 scroller. */}
          <pre
            data-frame-ocr=""
            className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded border border-border bg-bg-subtle p-2 text-xs text-fg"
          >
            {frame.ocrText}
          </pre>
        </>
      ) : (
        <>
          {frame.summary ? (
            <p className="mt-0.5 text-sm text-fg">{frame.summary}</p>
          ) : (
            <p className="mt-0.5 text-sm text-fg-muted">
              {summaryPendingCopy(frame.summaryError, framesPerDay)}
            </p>
          )}
          {hasText && (
            <button
              type="button"
              onClick={() => setShowText(true)}
              data-frame-toggle="extraction"
              className="mt-1 rounded border border-border px-1 text-[10px] text-fg-muted hover:bg-bg-subtle"
            >
              Full extraction
            </button>
          )}
        </>
      )}
    </div>
  );
}

export function ScreenTimeline({
  deviceId,
  frames,
  openFrameId,
  onToggleFrame,
  onDeleteFrame,
  // TASK_168 Bug B — the resolved daily FRAMES budget (dial × 3), so the
  // deferred copy names the limit that actually binds, not a hardcoded 24.
  framesPerDay = 24,
}: {
  deviceId: string;
  frames: ScreenTimelineFrame[];
  openFrameId: string | null;
  onToggleFrame: (frameId: string) => void;
  onDeleteFrame?: (frameId: string) => void;
  framesPerDay?: number;
}) {
  return (
    <div
      data-screen-timeline=""
      className="mt-1 max-h-80 overflow-y-auto overscroll-contain rounded-md border border-border"
    >
      {frames.map((frame) => {
        const at = frameTimestamp(frame);
        const hasImage = frame.status === "captured" && !frame.imagePurgedAt;
        const isOpen = openFrameId === frame.id;
        return (
          <div
            key={frame.id}
            data-frame-row=""
            data-frame-status={frame.status}
            className="flex gap-3 border-b border-border px-2 py-2 last:border-b-0"
          >
            <div className="w-24 shrink-0">
              {hasImage ? (
                <button
                  type="button"
                  onClick={() => onToggleFrame(frame.id)}
                  title="Open this frame in place"
                  className={`block w-full overflow-hidden rounded border ${
                    isOpen ? "border-brand-600" : "border-border"
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/devices/${deviceId}/screenshots/${frame.id}`}
                    alt=""
                    loading="lazy"
                    className="h-14 w-full object-cover object-top"
                  />
                </button>
              ) : (
                <div className="flex h-14 w-full items-center justify-center rounded border border-dashed border-border px-1 text-center text-[10px] leading-tight text-fg-muted">
                  {frame.status === "captured" ? "image expired" : "no frame"}
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <p className="text-xs text-fg-muted">{at.toLocaleString()}</p>
                {onDeleteFrame && (
                  <button
                    type="button"
                    onClick={() => onDeleteFrame(frame.id)}
                    data-frame-delete=""
                    aria-label="Delete this frame"
                    title="Delete this frame"
                    className="shrink-0 rounded px-1 text-sm leading-none text-fg-muted hover:bg-bg-subtle hover:text-red-500"
                  >
                    ×
                  </button>
                )}
              </div>
              {frame.status === "captured" && (
                <FrameReadout frame={frame} framesPerDay={framesPerDay} />
              )}
              {frame.status !== "captured" && (
                <p className="mt-0.5 text-sm text-red-500">
                  {captureFailureCopy(frame.failureReason)}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
