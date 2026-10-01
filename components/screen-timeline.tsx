"use client";

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
}

/** Why a CAPTURED frame has no summary, in human words (neutral, never red). */
export function summaryPendingCopy(summaryError: string | null): string {
  switch (summaryError) {
    case null:
    case "":
      return "Not summarised yet.";
    case "cap_exhausted":
      return "No summary — today's AI limit for this account is used up.";
    case "daily_call_budget":
      return "No summary — today's summary budget for this machine is used up.";
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

export function ScreenTimeline({
  deviceId,
  frames,
  openFrameId,
  onToggleFrame,
}: {
  deviceId: string;
  frames: ScreenTimelineFrame[];
  openFrameId: string | null;
  onToggleFrame: (frameId: string) => void;
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
              <p className="text-xs text-fg-muted">{at.toLocaleString()}</p>
              {frame.status === "captured" && frame.summary && (
                <p className="mt-0.5 text-sm text-fg">{frame.summary}</p>
              )}
              {frame.status === "captured" && !frame.summary && (
                <p className="mt-0.5 text-sm text-fg-muted">{summaryPendingCopy(frame.summaryError)}</p>
              )}
              {frame.status !== "captured" && (
                <p className="mt-0.5 text-sm text-red-500">
                  Capture failed
                  {frame.failureReason ? ` — ${frame.failureReason}` : ""}.
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
