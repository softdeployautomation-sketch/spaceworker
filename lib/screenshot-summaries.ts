import "server-only";

import { readFile } from "node:fs/promises";

import { db } from "./db";
import { getAdminSettings } from "./admin-settings";
import {
  recordAiUsage,
  aiCapReached,
  getUsedAiTodayHundredthsCent,
  startOfTodayUTC,
} from "./ai-metering";
import {
  assertSafeFramePath,
  frameAbsPath,
  resolveScreenshotSettings,
  startOfUtcDay,
} from "./device-screenshots";
import { channelryAiChat } from "./channelry-ai";
import { extractText, ocrViaTesseract, type OcrFn } from "./screenshot-ocr";

// ---------------------------------------------------------------------------
// TASK_152 M3 — per-frame screen summaries (the owner's "summary section").
// ---------------------------------------------------------------------------
//
// The owner asked for a summary of EACH frame on the Screen monitoring tab, so
// they can "quickly recollect" what a machine was doing without opening every
// picture. TASK_127:58 recommended ONE VISION CALL PER DEVICE PER DAY rather
// than one per frame, because per-frame multiplies cost. This module RECONCILES
// the two — the owner gets a per-frame summary in the UI, and the money is
// bounded — with three deliberate levers, none of them silent:
//
//   1. BATCHING. One relay call carries up to SCREENSHOT_SUMMARY_IMAGES_PER_CALL
//      frames. The pool's Groq vision model is `qwen/qwen3.8-27b`, whose
//      documented hard limit is 3 images per request (each image = 2048 input
//      tokens; console.groq.com/docs/vision, verified 2026-10-01). So 3 is the
//      API ceiling, not a taste choice — asking for more would be a 400.
//   2. A CHEAPER MODEL FOR ROUTINE FRAMES. `qwen/qwen3.8-27b` IS the cheap
//      vision route on the pooled relay ($0.80 / 1M input, $4.00 / 1M output);
//      the expensive alternative would be a per-frame call to a larger model.
//      The id is sent as a hint (lib/channelry-ai.ts forwards `model`) so the
//      relay can override it without a redeploy. See the COST GATE below.
//   3. A PER-DEVICE DAILY FRAME BUDGET. SCREENSHOT_SUMMARY_MAX_FRAMES_PER_DEVICE_PER_DAY
//      (= IMAGES_PER_CALL * MAX_CALLS_PER_DEVICE_PER_DAY = 3 * 8 = 24) caps how
//      many of one device's frames are EVER summarised in a UTC day. At the
//      default hourly cadence that is exactly every frame (24/day); at a denser
//      cadence the budget binds and the extras are MARKED (never silently
//      dropped) with summaryError = "daily_call_budget".
//
// WHY THE AI LEG IS INJECTED (exactly like CaptureFn in lib/device-screenshots):
// the browser is a separate process; the AI relay is a separate service. Taking
// the call as a parameter makes the whole pass testable against a fake and keeps
// one process from owning both. The METERING is NOT injected — it is the real
// lib/ai-metering rule, so the cap being tested is the cap that runs.
//
// INDEPENDENCE: nothing here can fail a capture. A summarisation error is written
// to the frame's summaryError and the pass moves on; the raw frame is untouched.

// ---------------------------------------------------------------------------
// The cost gate — the constants behind the number
// ---------------------------------------------------------------------------

/** The pooled relay's vision model. Sent as a hint; the relay may override it. */
export const SCREENSHOT_SUMMARY_MODEL = "qwen/qwen3.8-27b";

/**
 * Frames per relay call. The pool's vision model accepts a MAXIMUM OF 3 images
 * per request (console.groq.com/docs/vision, verified 2026-10-01), so this is a
 * hard API ceiling — 4 would be a 400, not a bigger batch.
 */
export const SCREENSHOT_SUMMARY_IMAGES_PER_CALL = 3;

/** Metered relay calls allowed per device per UTC day. The cost ceiling. */
export const SCREENSHOT_SUMMARY_MAX_CALLS_PER_DEVICE_PER_DAY = 8;

/** Frames per device per UTC day = what the budget actually buys. */
export const SCREENSHOT_SUMMARY_MAX_FRAMES_PER_DEVICE_PER_DAY =
  SCREENSHOT_SUMMARY_IMAGES_PER_CALL * SCREENSHOT_SUMMARY_MAX_CALLS_PER_DEVICE_PER_DAY;

// Published qwen/qwen3.8-27b prices, converted to this codebase's unit
// (hundredths of a cent — the unit AiUsageLog and aiDailyCapHundredthsCent use).
//   input  $0.80 / 1M tokens = 0.80 * 10000 hc / 1e6 tokens = 0.008 hc/token
//   output $4.00 / 1M tokens = 4.00 * 10000 hc / 1e6 tokens = 0.04  hc/token
export const SCREENSHOT_SUMMARY_INPUT_HUNDREDTHS_CENT_PER_TOKEN = 0.008;
export const SCREENSHOT_SUMMARY_OUTPUT_HUNDREDTHS_CENT_PER_TOKEN = 0.04;

/** 2048 tokens per image (the model's documented rate) * 3 images, + prompt text. */
export const SCREENSHOT_SUMMARY_EST_INPUT_TOKENS_PER_CALL =
  SCREENSHOT_SUMMARY_IMAGES_PER_CALL * 2048 + 160;

/** ~90 output tokens per one-sentence summary * 3, plus the JSON envelope. */
export const SCREENSHOT_SUMMARY_EST_OUTPUT_TOKENS_PER_CALL =
  SCREENSHOT_SUMMARY_IMAGES_PER_CALL * 90 + 30;

/** Estimated hundredths of a cent for ONE batched call, at published prices. */
export function summariseCostPerCallHundredthsCent(): number {
  return (
    SCREENSHOT_SUMMARY_EST_INPUT_TOKENS_PER_CALL *
      SCREENSHOT_SUMMARY_INPUT_HUNDREDTHS_CENT_PER_TOKEN +
    SCREENSHOT_SUMMARY_EST_OUTPUT_TOKENS_PER_CALL *
      SCREENSHOT_SUMMARY_OUTPUT_HUNDREDTHS_CENT_PER_TOKEN
  );
}

/**
 * The headline figure the task demands: cost per DEVICE per DAY, worst case, at
 * the default hourly cadence (24 frames/day = 8 batched calls).
 */
export function summariseCostPerDevicePerDayHundredthsCent(): number {
  return summariseCostPerCallHundredthsCent() * SCREENSHOT_SUMMARY_MAX_CALLS_PER_DEVICE_PER_DAY;
}

/**
 * A printable cost report. Kept as CODE (not a comment) so the number can be
 * re-derived and re-checked rather than trusted, and so the UI/tests can print
 * the exact figure the copy describes instead of paraphrasing it.
 */
export function summariseCostReport(): string {
  const perCall = summariseCostPerCallHundredthsCent();
  const perDevice = summariseCostPerDevicePerDayHundredthsCent();
  const userCap = 20000; // User.aiDailyCapHundredthsCent default
  const devicesPerCap = Math.floor(userCap / perDevice);
  return [
    `model ${SCREENSHOT_SUMMARY_MODEL}`,
    `${SCREENSHOT_SUMMARY_IMAGES_PER_CALL} frames/call (API max), ` +
      `${SCREENSHOT_SUMMARY_MAX_CALLS_PER_DEVICE_PER_DAY} calls/device/day`,
    `<= ${SCREENSHOT_SUMMARY_MAX_FRAMES_PER_DEVICE_PER_DAY} frames/device/day summarised ` +
      `(default hourly cadence = 24/day)`,
    `est ${SCREENSHOT_SUMMARY_EST_INPUT_TOKENS_PER_CALL} in + ` +
      `${SCREENSHOT_SUMMARY_EST_OUTPUT_TOKENS_PER_CALL} out tokens/call`,
    `est ${perCall.toFixed(1)} hc/call = $${(perCall / 10000).toFixed(5)}/call`,
    `est ${perDevice.toFixed(0)} hc/device/day = $${(perDevice / 10000).toFixed(4)}/device/day`,
    `one user's $${(userCap / 10000).toFixed(2)}/day cap covers ~${devicesPerCap} summarised devices`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Choosing which frames to summarise
// ---------------------------------------------------------------------------

/**
 * A summary failure that clears itself: a frame carrying one of these is
 * re-considered on a later pass. Everything else is TERMINAL for that frame —
 * a frame whose image is unreadable, or whose model refuses images, will not
 * become summarisable by being retried every minute.
 */
export const RETRYABLE_SUMMARY_ERRORS = new Set([
  "cap_exhausted", // transient: the cap resets at UTC midnight
  "daily_call_budget", // transient: the device's budget resets at UTC midnight
  // 2026-10-04 — the relay's OWN spend cap. "over_cap" was NOT in this set, so
  // a frame that hit a real cap was TERMINAL: every later sweep skipped it, so
  // it could never be summarised even though the cap resets at Channelry's day
  // boundary. Same class of stranding bug as the "bad_request" one below.
  "over_cap",
  // Same day — a bare 429 (no usage body) is Cloudflare back-pressure, NOT
  // money. Transient, so it must retry rather than strand the frame.
  "rate_limited",
  "ai_unavailable", // transient: the relay was briefly down (502/network)
  "temporarily_unavailable",
  // TASK_157 — the two that used to strand frames forever, and must not any more.
  //
  // "bad_request" was NOT retryable, so the 8 frames that hit the relay's broken
  // vision path were permanently excluded: every sweep skipped them, so they could
  // never recover even once the payload was fixed. It is a client-side shape error
  // (fixed in summariseViaRelay), so re-attempting is exactly right.
  //
  // "ocr_failed"/"ocr_empty" are about the FREE leg: retrying costs nothing but a
  // few seconds of CPU, and a frame that read as empty on a locked screen often
  // reads fine later.
  //
  // "image_missing" is DELIBERATELY absent and stays terminal: the file is gone
  // from disk, so no amount of retrying will ever produce text or a summary.
  // Retrying it would just re-mark it on every sweep, forever. The user deletes
  // such a frame from the timeline instead (TASK_157 delete path).
  "bad_request",
  "ocr_failed",
  "ocr_empty",
  "summary_parse_failed",
]);

export interface PendingSummaryFrame {
  id: string;
  deviceId: string;
  userId: string;
  filePath: string;
}

/**
 * Captured frames that have no summary yet and are not terminally failed.
 *
 * A frame with NO summary is the NORMAL state, not an error — that is the whole
 * point of summaryError being a separate axis from failureReason. This query
 * reads inside the retention window only, so a frame about to be purged is never
 * sent to a paid model. Device opt-in is applied after the read so the query
 * stays a single indexed scan rather than a join.
 */
export async function listPendingSummaryFrames(
  now: Date,
  retentionDays: number,
  limit = 200,
): Promise<PendingSummaryFrame[]> {
  const optedIn = await db.device.findMany({
    where: { screenshotMonitoringEnabled: true },
    select: { id: true },
  });
  const allowed = new Set(optedIn.map((d) => d.id));
  if (allowed.size === 0) return [];

  const cutoff = startOfUtcDay(new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000));
  const rows = await db.deviceScreenshot.findMany({
    where: { status: "captured", summary: null, summaryDate: { gte: cutoff } },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true, deviceId: true, userId: true, filePath: true, summaryError: true },
  });

  return rows
    .filter(
      (r) =>
        r.filePath !== null &&
        allowed.has(r.deviceId) &&
        (r.summaryError === null || RETRYABLE_SUMMARY_ERRORS.has(r.summaryError as string)),
    )
    .map((r) => ({
      id: r.id,
      deviceId: r.deviceId,
      userId: r.userId,
      filePath: r.filePath as string,
    }));
}

/** How many of a device's frames already carry a summary written today (UTC). */
export async function countSummarisedToday(deviceId: string): Promise<number> {
  return db.deviceScreenshot.count({
    where: { deviceId, summary: { not: null }, summarisedAt: { gte: startOfTodayUTC() } },
  });
}

// ---------------------------------------------------------------------------
// The AI leg (injected)
// ---------------------------------------------------------------------------

export interface SummariseCallFrame {
  id: string;
  /**
   * TASK_157 — the TEXT read off this frame by OCR (lib/screenshot-ocr.ts).
   *
   * This replaced the image. The relay's vision leg answers 502 to any image
   * payload (verified live 2026-10-02), so an image is no longer something we can
   * send. `dataUrl` is kept only for the legacy image path and is normally null.
   */
  text: string;
  /** Legacy image payload. Retained so an image-capable relay can be re-enabled. */
  dataUrl?: string;
}

export interface SummariseCallInput {
  userId: string;
  model: string;
  frames: SummariseCallFrame[];
}

export interface SummariseCallResult {
  /** frame id -> one-sentence summary. A missing key means "no summary for it". */
  summaries: Map<string, string>;
  /** The REAL cost the relay reported for this call (hundredths of a cent). */
  costHundredthsCent: number;
}

export type SummariseFn = (input: SummariseCallInput) => Promise<SummariseCallResult>;

const SUMMARY_SYSTEM_PROMPT =
  "You summarise screenshots of a person's own computer screen for their private " +
  "activity log. For EACH image, write ONE short plain sentence (at most 20 words) " +
  "describing what was on screen: the application or website, and what was being " +
  "done. Be specific but never invent detail you cannot see; if a screen is blank, " +
  "locked, or unreadable, say exactly that. Do not moralise. Do not add commentary.";

/**
 * The REAL summariser: one metered relay call per batch.
 *
 * TASK_157 — this now sends TEXT (the OCR read of each frame), not the image, and
 * in the `system` + `user` shape. Both changes are forced by live evidence, not
 * preference. Probes run 2026-10-02 from the VPS against the real endpoint with
 * the real key:
 *
 *   messages[] + tools + image_url  -> 502 "AI service temporarily unavailable"
 *                                      (the relay's vision leg is DOWN)
 *   messages[] (no tools)           -> 400 "system and user are required"
 *                                      (messages-mode needs tools — or system/user)
 *   system + user, TEXT, no json    -> 200 + {"summary":"Viewing Gmail inbox..."}
 *
 * The text shape is also ~30x cheaper: a frame is ~900 characters of OCR (a few
 * hundred tokens) rather than a 2048-token image, and it needs no vision model at
 * all. json_mode is deliberately NOT set: the relay passes it through as
 * Groq `response_format`, and Groq rejects that unless the literal word "json"
 * appears in the messages (observed 502: "'messages' must contain the word 'json'").
 * The prompt already asks for JSON and parseSummaries is tolerant, so the flag
 * buys nothing and can only fail.
 */
export const summariseViaRelay: SummariseFn = async ({ userId, model, frames }) => {
  const blocks = frames.map((frame, i) => `--- Screen ${i + 1} ---\n${frame.text}`);
  const body =
    `Here is the text read from ${frames.length} screenshot(s) of a computer screen, ` +
    `in order.\n\n${blocks.join("\n\n")}\n\n` +
    `For EACH screen write ONE short plain sentence (at most 20 words) saying what ` +
    `was on it: the app or website, and what was being done. ` +
    `Return ONLY json of the form {"summaries":[{"index":1,"summary":"..."}]} with ` +
    `one entry per screen, index starting at 1, in the order given.`;

  const result = await channelryAiChat({
    system: SUMMARY_SYSTEM_PROMPT,
    user: body,
    max_tokens: 400,
    temperature: 0.2,
    external_user_id: userId,
  });

  return {
    summaries: parseSummaries(result.content, frames),
    costHundredthsCent: result.usage.cost_hundredths_cent ?? 0,
  };
};

/**
 * Read the model's JSON back into frame-id -> summary. Deliberately tolerant:
 * a model that wraps the JSON in prose, or returns a bare array instead of the
 * requested envelope, still gets used rather than thrown away.
 */
export function parseSummaries(content: string, frames: SummariseCallFrame[]): Map<string, string> {
  const out = new Map<string, string>();
  const json = extractJson(content);
  if (json === null) return out;

  let list: unknown[] = [];
  if (Array.isArray(json)) list = json;
  else if (Array.isArray((json as Record<string, unknown>).summaries)) {
    list = (json as Record<string, unknown>).summaries as unknown[];
  }

  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const summary = typeof rec.summary === "string" ? rec.summary.trim() : "";
    if (!summary) continue;
    const rawIndex = typeof rec.index === "number" ? rec.index : NaN;
    // The prompt says index starts at 1; accept a 0-based model too so a
    // convention slip produces a usable summary instead of nothing.
    const zeroBased =
      Number.isInteger(rawIndex) && rawIndex >= 1 ? rawIndex - 1 : Number.isInteger(rawIndex) ? rawIndex : NaN;
    if (!Number.isInteger(zeroBased)) continue;
    const frame = frames[zeroBased];
    if (frame) out.set(frame.id, summary);
  }
  return out;
}

/** Pull the first JSON object/array out of a possibly-chatty model reply. */
function extractJson(content: string): unknown | null {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to the first {...} / [...] block
  }
  const start = trimmed.search(/[[{]/);
  if (start === -1) return null;
  const close = trimmed[start] === "{" ? "}" : "]";
  const end = trimmed.lastIndexOf(close);
  if (end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export interface SummaryPassOptions {
  now?: Date;
  /** Cap on frames considered in one pass (bounds memory: each holds its OCR text). */
  limit?: number;
}

export interface SummaryPassResult {
  /** Set when the pass did nothing: "disabled" | "no_frames". */
  skipped: string | null;
  /** Metered relay calls actually made. */
  calls: number;
  summarised: number;
  /** Frames left unsummarised because the budget or the cap ran out. */
  deferred: number;
  /** Frames whose image could not be read (terminal, no call spent). */
  unreadable: number;
  costHundredthsCent: number;
  results: Array<{ deviceId: string; frames: number; status: string; reason?: string }>;
}

/** The relay's typed error carries a `.code`; anything else is a generic failure. */
function classifySummaryError(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.length > 0) return code;
  return "ai_error";
}

/**
 * One summarisation pass.
 *
 * Order inside a device is strictly: daily budget -> per-user cap -> read images
 * -> ONE call -> write every summary -> log the real cost. The cap is re-read
 * immediately before EACH call (not once per pass) because a user's other AI use
 * can cross it mid-pass, and the SUM-over-AiUsageLog rule is what makes that
 * check race-safe.
 *
 * NOTHING here throws to its caller: every failure becomes a summaryError on the
 * affected frames. That is the "the two fail independently" requirement — a
 * capture must never fail because a summary did.
 */
export async function runSummaryPass(
  summarise: SummariseFn,
  opts: SummaryPassOptions = {},
  ocr: OcrFn = ocrViaTesseract,
): Promise<SummaryPassResult> {
  const now = opts.now ?? new Date();
  const result: SummaryPassResult = {
    skipped: null,
    calls: 0,
    summarised: 0,
    deferred: 0,
    unreadable: 0,
    costHundredthsCent: 0,
    results: [],
  };

  const settings = resolveScreenshotSettings(await getAdminSettings());
  if (!settings.enabled) {
    result.skipped = "disabled";
    return result;
  }

  const pending = await listPendingSummaryFrames(now, settings.retentionDays, opts.limit ?? 200);
  if (pending.length === 0) {
    result.skipped = "no_frames";
    return result;
  }

  // Group by device, preserving oldest-first order within each device.
  const byDevice = new Map<string, PendingSummaryFrame[]>();
  for (const frame of pending) {
    const list = byDevice.get(frame.deviceId) ?? [];
    list.push(frame);
    byDevice.set(frame.deviceId, list);
  }

  const model = SCREENSHOT_SUMMARY_MODEL;

  for (const [deviceId, frames] of byDevice) {
    const userId = frames[0].userId;

    // (3) per-device daily budget — checked BEFORE any cap read or call.
    const alreadyToday = await countSummarisedToday(deviceId);
    const remaining = Math.max(0, SCREENSHOT_SUMMARY_MAX_FRAMES_PER_DEVICE_PER_DAY - alreadyToday);
    const eligible = frames.slice(0, remaining);
    const overBudget = frames.slice(remaining);
    if (overBudget.length > 0) {
      await markFrames(
        overBudget.map((f) => f.id),
        "daily_call_budget",
      );
      result.deferred += overBudget.length;
    }
    if (eligible.length === 0) {
      result.results.push({
        deviceId,
        frames: 0,
        status: "budget_exhausted",
        reason: `already summarised ${alreadyToday} frames today`,
      });
      continue;
    }

    let deviceSummaryCount = 0;
    let deviceStatus = "summarised";
    let deviceReason: string | undefined;

    for (let i = 0; i < eligible.length; i += SCREENSHOT_SUMMARY_IMAGES_PER_CALL) {
      const batch = eligible.slice(i, i + SCREENSHOT_SUMMARY_IMAGES_PER_CALL);

      // (1) the per-user daily cap — re-read per call, through the shared rule.
      const user = await db.user.findUnique({
        where: { id: userId },
        select: { aiDailyCapHundredthsCent: true },
      });
      const used = await getUsedAiTodayHundredthsCent(userId);
      const cap = user?.aiDailyCapHundredthsCent ?? 20000;
      if (aiCapReached(used, cap)) {
        const rest = eligible.slice(i);
        await markFrames(
          rest.map((f) => f.id),
          "cap_exhausted",
        );
        result.deferred += rest.length;
        deviceStatus = "cap_exhausted";
        deviceReason = `${used}/${cap} hundredths of a cent used today`;
        break;
      }

      // TASK_157 — read each frame's TEXT locally (free, no network, no key).
      //
      // This is the primary path now, not a fallback: the relay cannot read images
      // (502), so without text there is nothing to summarise. OCR runs BEFORE the
      // AI call and its output is PERSISTED regardless of whether the AI call
      // then succeeds, which is what guarantees the owner still has the full
      // extraction on a day the AI is down, capped, or unconfigured.
      //
      // A frame whose file is gone is marked, never sent. A frame whose OCR throws
      // is marked "ocr_failed" and skipped for this batch, but the pass continues.
      const callFrames: SummariseCallFrame[] = [];
      for (const frame of batch) {
        let bytes: Buffer;
        try {
          const abs = frameAbsPath(frame.filePath);
          assertSafeFramePath(abs);
          bytes = await readFile(abs);
        } catch {
          await markFrames([frame.id], "image_missing");
          result.unreadable += 1;
          deviceStatus = "partial";
          deviceReason = "one or more frame images were unreadable";
          continue;
        }

        let text: string;
        try {
          const extracted = await extractText(ocr, bytes);
          if (!extracted) {
            // OCR ran and the screen genuinely had no words (black/locked screen).
            // Record that it RAN, so the UI can say "nothing readable on this
            // screen" instead of "not read yet".
            await markOcr(frame.id, "", 0);
            await markFrames([frame.id], "ocr_empty");
            result.unreadable += 1;
            deviceStatus = "partial";
            deviceReason = "a frame had no readable text";
            continue;
          }
          text = extracted.text;
          await markOcr(frame.id, extracted.text, extracted.confidence);
        } catch {
          await markFrames([frame.id], "ocr_failed");
          result.unreadable += 1;
          deviceStatus = "partial";
          deviceReason = "text extraction failed on one or more frames";
          continue;
        }

        callFrames.push({ id: frame.id, text });
      }
      if (callFrames.length === 0) continue;

      let callResult: SummariseCallResult;
      try {
        callResult = await summarise({ userId, model, frames: callFrames });
      } catch (err) {
        const reason = classifySummaryError(err);
        await markFrames(
          callFrames.map((f) => f.id),
          reason,
        );
        result.deferred += callFrames.length;
        deviceStatus = "failed";
        deviceReason = reason;
        continue;
      }

      result.calls += 1;
      const written = await writeSummaries(callFrames, callResult, model);
      deviceSummaryCount += written;
      result.summarised += written;

      // The real cost, through the ONE metered path. A relay that reports 0 is a
      // no-op row, exactly as lib/agent.ts behaves.
      const cost = callResult.costHundredthsCent;
      if (typeof cost === "number" && cost > 0) {
        result.costHundredthsCent += cost;
        await recordAiUsage(userId, cost, "screenshot_summary");
      }
    }

    result.results.push({
      deviceId,
      frames: deviceSummaryCount,
      status: deviceStatus,
      reason: deviceReason,
    });
  }

  return result;
}

/** Write one batch's summaries. A frame the model skipped is left un-summarised. */
async function writeSummaries(
  frames: SummariseCallFrame[],
  callResult: SummariseCallResult,
  model: string,
): Promise<number> {
  let written = 0;
  const at = new Date();
  for (const frame of frames) {
    const summary = callResult.summaries.get(frame.id);
    if (!summary) continue;
    await db.deviceScreenshot.update({
      where: { id: frame.id },
      data: { summary, summaryError: null, summaryModel: model, summarisedAt: at },
    });
    written += 1;
  }
  return written;
}

/**
 * Mark frames as "no summary, and here is why". updateMany, so a batch is one
 * statement. This is the ONLY thing a failed summary does to a frame — the
 * frame's status, filePath and capturedAt are never touched, which is what keeps
 * capture and summarisation independent.
 */
async function markFrames(ids: string[], summaryError: string): Promise<void> {
  if (ids.length === 0) return;
  await db.deviceScreenshot.updateMany({ where: { id: { in: ids } }, data: { summaryError } });
}

/**
 * TASK_157 — persist one frame's extracted text.
 *
 * Written the moment OCR succeeds, BEFORE any AI call, so the extraction survives
 * independently of the summary. This is the owner's "users still get the
 * extraction" guarantee: cap_exhausted / ai_unavailable / bad_request only ever
 * affect the `summary` columns and never touch `ocrText`.
 *
 * `text: ""` is a legitimate stored value (OCR ran, screen had no words) — the
 * paired `ocrAt` is what distinguishes it from "never read".
 */
async function markOcr(id: string, text: string, confidence: number): Promise<void> {
  await db.deviceScreenshot.update({
    where: { id },
    data: { ocrText: text, ocrAt: new Date(), ocrConfidence: confidence },
  });
}




