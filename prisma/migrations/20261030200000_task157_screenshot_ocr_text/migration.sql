-- TASK_157 — screenshot OCR text layer.
--
-- The relay's VISION leg is down (live probe 2026-10-02 from the VPS with the real
-- key: messages+tools+image_url returns 502 "AI service temporarily unavailable"),
-- while the same relay answers a plain TEXT call with 200 + a good summary. So the
-- image can no longer be what we send. Instead we read the words OFF each frame
-- locally with tesseract.js — no network, no API key, no meter — and summarise THAT.
-- This also delivers the owner's fallback guarantee: ocrText still exists on a day
-- the AI is unconfigured, over budget, or broken.
--
-- Purely ADDITIVE and NULLABLE: three new columns, no default, no rewrite, no change
-- to any existing row. A frame captured before this migration has NULL in all three
-- and renders exactly as it did before.

-- The full text read off the frame. "" is meaningful (a blank/locked screen read
-- successfully but yielded no words), which is why ocrAt below exists alongside it.
ALTER TABLE "DeviceScreenshot" ADD COLUMN "ocrText" TEXT;

-- Set when OCR ran on this frame. Distinguishes "not run yet" (NULL) from
-- "ran and found nothing" (set, with ocrText = '').
ALTER TABLE "DeviceScreenshot" ADD COLUMN "ocrAt" TIMESTAMP(3);

-- 0-100 engine confidence. Kept so the UI can explain a poor read rather than
-- showing the owner garbled text with no explanation, and so triage can spot the
-- sub-40 frames that are almost always blank or locked screens.
ALTER TABLE "DeviceScreenshot" ADD COLUMN "ocrConfidence" INTEGER;