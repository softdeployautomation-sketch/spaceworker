import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

// TASK_152 M3 — the Screen monitoring timeline, rendered for real.
//
// The acceptance bar includes "the rendered timeline; a frame with NO summary
// rendering sanely". There is no device/Playwright VM here, but the timeline is
// a pure presentational component (components/screen-timeline.tsx) with no fetch
// and no hooks, so it can be rendered to static markup and COUNTED. This asserts
// against the REAL component the console mounts — not a copy of its markup.

import {
  ScreenTimeline,
  captureFailureCopy,
  summaryPendingCopy,
  type ScreenTimelineFrame,
} from "../components/screen-timeline";

function frame(over: Partial<ScreenTimelineFrame> & { id: string }): ScreenTimelineFrame {
  return {
    status: "captured",
    failureReason: null,
    capturedAt: "2026-10-01T12:00:00.000Z",
    createdAt: "2026-10-01T12:00:00.000Z",
    summary: null,
    summaryError: null,
    imagePurgedAt: null,
    // TASK_157 — default to "never read", which is what every pre-TASK_157 row
    // looks like. The toggle must not appear for these.
    ocrText: null,
    ocrAt: null,
    ocrConfidence: null,
    ...over,
  };
}

/** Render and split into per-row chunks, so presence/absence is per frame. */
function render(frames: ScreenTimelineFrame[], openFrameId: string | null = null) {
  const html = renderToStaticMarkup(
    ScreenTimeline({ deviceId: "dev1", frames, openFrameId, onToggleFrame: () => {} }),
  );
  const chunks = html.split('data-frame-row=""');
  return { html, rows: chunks.slice(1), head: chunks[0] };
}

test("the timeline is one SCROLLABLE container with exactly one row per frame", () => {
  const { html, rows } = render([
    frame({ id: "f3", summary: "A" }),
    frame({ id: "f2", summary: "B" }),
    frame({ id: "f1", summary: "C" }),
  ]);

  assert.equal((html.match(/data-screen-timeline=""/g) ?? []).length, 1);
  assert.equal(rows.length, 3, "one data-frame-row per frame");
  // "Quickly recollect" without clicking each frame — the container scrolls.
  assert.match(html, /overflow-y-auto/);
  assert.match(html, /max-h-80/);
});

test("each summary is rendered BESIDE its own frame, in the given (newest-first) order", () => {
  const { rows } = render([
    frame({ id: "f3", summary: "Third: a report was open." }),
    frame({ id: "f2", summary: "Second: email." }),
    frame({ id: "f1", summary: "First: a spreadsheet." }),
  ]);

  assert.match(rows[0], /Third: a report was open\./);
  assert.match(rows[1], /Second: email\./);
  assert.match(rows[2], /First: a spreadsheet\./);

  // The thumbnail for a summarised frame is still fetched by frame id.
  assert.match(rows[0], /<img[^>]*src="\/api\/devices\/dev1\/screenshots\/f3"/);
});

test("a captured frame with NO summary renders SANELY — neutral copy, never a failure", () => {
  const { rows } = render([frame({ id: "f1", summary: null })]);

  assert.match(rows[0], /Not summarised yet\./);
  assert.doesNotMatch(rows[0], /Capture failed/);
  assert.doesNotMatch(rows[0], /text-red-500/);
  assert.match(rows[0], /text-fg-muted/, "the pending line is muted, not alarming");
});

test("a cap-exhausted frame explains itself calmly — still not an error", () => {
  const { rows } = render([frame({ id: "f1", summary: null, summaryError: "cap_exhausted" })]);
  assert.match(rows[0], /AI limit for this account is used up/);
  assert.doesNotMatch(rows[0], /Capture failed/);
  assert.doesNotMatch(rows[0], /text-red-500/);
});

test("a purged-image summary shows the TEXT with an \"image expired\" tile and no <img>", () => {
  const { rows } = render([
    frame({ id: "f1", summary: "Excel on a staffing sheet.", imagePurgedAt: "2026-10-01T00:00:00.000Z" }),
  ]);
  assert.match(rows[0], /Excel on a staffing sheet\./);
  assert.match(rows[0], /image expired/);
  assert.doesNotMatch(rows[0], /<img/);
});

test("only a real CAPTURE failure is rendered as a failure — and as a sentence", () => {
  const { rows } = render([
    frame({ id: "f1", status: "failed", failureReason: "device_offline", capturedAt: null }),
  ]);
  // The owner reads a sentence, never the machine code.
  assert.match(rows[0], /The machine was offline, so nothing could be captured\./);
  assert.doesNotMatch(rows[0], /device_offline/);
  assert.match(rows[0], /text-red-500/);
  assert.match(rows[0], /no frame/);
  assert.doesNotMatch(rows[0], /<img/);
});

test("the reported raw Playwright dump reads as OFFLINE, never as a call log", () => {
  // The EXACT reason stored on 2026-10-01 13:36:40 (DeviceScreenshot, WilkSF9) —
  // the string the owner saw as unreadable red text.
  const raw =
    'capture_service_http_500: {"ok":false,"failureReason":"locator.click: Timeout 10000ms exceeded.\\nCall log:\\n  - waiting for getByRole(\'button\', { name: /^connect$/i })\\n    - locator resolved to <button disabled title=\\"The machine is offline\\" class=\\"flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white ...';
  const { rows } = render([
    frame({ id: "f1", status: "failed", failureReason: raw, capturedAt: null }),
  ]);

  // Still an honest failure, still red...
  assert.match(rows[0], /text-red-500/);
  // ...but a sentence, with the machine-offline fact UP FRONT and no call-log
  // noise, no JSON, no CSS classes.
  assert.match(rows[0], /The machine was offline, so nothing could be captured\./);
  assert.doesNotMatch(rows[0], /capture_service_http_500/);
  assert.doesNotMatch(rows[0], /locator\.click/);
  assert.doesNotMatch(rows[0], /Call log/);
  assert.doesNotMatch(rows[0], /bg-brand-600/);
});

test("a capture-service HTTP failure with no recognisable cause is one sentence", () => {
  const { rows } = render([
    frame({
      id: "f1",
      status: "failed",
      failureReason: 'capture_service_http_500: {"ok":false,"failureReason":"boom\\nstack"}',
      capturedAt: null,
    }),
  ]);
  assert.match(rows[0], /The capture service could not take the frame\. It will be retried\./);
  assert.doesNotMatch(rows[0], /\{|\}|boom|stack/);
});

test("every known capture-failure code maps to plain, actionable copy", () => {
  assert.match(captureFailureCopy("device_offline"), /machine was offline/);
  assert.match(captureFailureCopy("worker_timeout"), /retried/);
  assert.match(captureFailureCopy("capture_service_token_not_set"), /not set up on the server/);
  assert.match(captureFailureCopy("empty_frame"), /came back blank/);
  assert.match(captureFailureCopy(null), /no reason was recorded/);
  // Prefixed forms reduce to the SAME sentence — the detail is dropped, not shown.
  assert.match(captureFailureCopy("capture_service_unreachable: connect ECONNREFUSED 127.0.0.1:3403"), /could not be reached/);
  // An unknown CODE is still shown, never swallowed...
  assert.equal(captureFailureCopy("something_new"), "Capture failed — something_new.");
  // ...but an unknown SLAB OF TEXT never is.
  assert.equal(captureFailureCopy("Some huge runtime error\nat foo (bar.ts:1)"), "The capture failed. It will be retried.");
});

test("every summaryError code maps to calm, specific copy", () => {
  assert.equal(summaryPendingCopy(null), "Not summarised yet.");
  assert.match(summaryPendingCopy("temporarily_unavailable"), /retried/);
  assert.match(summaryPendingCopy("image_missing"), /could not be read/);
  assert.match(summaryPendingCopy("something_new"), /something_new/);
});

test("2026-10-04: the local daily cap, a real Channelry spend cap, and a bare 429 are three DISTINCT things on screen", () => {
  // This distinction is the whole fix. The local cap once read as "budget used
  // up", which sent the operator chasing a spend cap that was 99.98% unused.
  const local = summaryPendingCopy("daily_call_budget");
  const money = summaryPendingCopy("over_cap");
  const limited = summaryPendingCopy("rate_limited");

  // The LOCAL cap names the local limit and the reset time — never "budget".
  assert.match(local, /daily summary limit/i);
  assert.match(local, /24 frames/);
  assert.match(local, /00:00 UTC/);
  assert.doesNotMatch(local, /budget/i);

  // ONLY the real relay spend cap is allowed to say "budget", because only it
  // comes from the relay's explicit usage-bearing 429.
  assert.match(money, /Channelry AI budget/i);

  // A bare 429 is back-pressure: it must not read as money at all.
  assert.match(limited, /rate limiting/i);
  assert.match(limited, /not a budget problem/i);
  assert.match(limited, /retried/);

  // All three are visibly different strings — no two states collapse into one.
  assert.equal(new Set([local, money, limited]).size, 3);
});

// ---------------------------------------------------------------------------
// TASK_157 — the extraction toggle, and the delete affordance.
//
// Render assertions on the returned React element tree (this file already works
// that way), so the test needs no renderer dependency.
// ---------------------------------------------------------------------------

/** Pull out the per-frame row elements by their data-frame-row marker. */
function frameRows(tree: unknown): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") return;
    const props = (node as { props?: Record<string, unknown> }).props;
    if (props && typeof props["data-frame-row"] === "string") {
      found.push(props as Record<string, unknown>);
    }
    if (props) walk(Object.values(props));
  };
  walk(tree);
  return found;
}

test("a frame that was never read still renders, with no extraction toggle", () => {
  // ocrText === null is what every pre-TASK_157 row looks like. We must not show
  // the user a button that opens onto nothing.
  const rows = frameRows(
    ScreenTimeline({
      deviceId: "d1",
      frames: [frame({ id: "f1" })],
      openFrameId: null,
      onToggleFrame: () => {},
    }),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]["data-frame-status"], "captured");
});

test("a frame read as EMPTY (locked screen) renders, with no extraction toggle", () => {
  // "" WITH an ocrAt means "read it, there were no words" — a different state
  // from "never read", and neither one is worth a toggle that shows nothing.
  const rows = frameRows(
    ScreenTimeline({
      deviceId: "d1",
      frames: [frame({ id: "f1", ocrText: "", ocrAt: "2026-10-01T12:00:00.000Z" })],
      openFrameId: null,
      onToggleFrame: () => {},
    }),
  );
  assert.equal(rows.length, 1);
});

test("a frame with BOTH a summary and extracted text stays mounted and shows the summary", () => {
  const rows = frameRows(
    ScreenTimeline({
      deviceId: "d1",
      frames: [
        frame({
          id: "f1",
          summary: "An email was open in Gmail.",
          ocrText: "Inbox (3)\nSubject: Hello",
          ocrAt: "2026-10-01T12:00:00.000Z",
          ocrConfidence: 61,
        }),
      ],
      openFrameId: null,
      onToggleFrame: () => {},
    }),
  );
  assert.equal(rows.length, 1, "having text does not change whether the frame is shown");
});

test("a FAILED frame is still listed and still deletable — the dead frames can be cleared", () => {
  // The reported symptom: frames that could not be captured, each with a × that
  // did nothing. The row must render and the delete control must be wired.
  const rows = frameRows(
    ScreenTimeline({
      deviceId: "d1",
      frames: [frame({ id: "f1", status: "failed", failureReason: "device_offline" })],
      openFrameId: null,
      onToggleFrame: () => {},
      onDeleteFrame: () => {},
    }),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]["data-frame-status"], "failed");
});
