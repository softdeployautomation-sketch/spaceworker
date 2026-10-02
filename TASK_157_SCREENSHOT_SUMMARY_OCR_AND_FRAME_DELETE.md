# TASK_157 — Screenshot summaries that survive the relay + per-frame delete + OCR leg

Owner report (2026-10-02): captures work again, but (1) frames show `bad_request` forever —
the agent replies fine when chatted with, so the relay is up and the *summary path's payload
shape* looks like the problem, not the AI; (2) clicking the ✕ chips on failed frames doesn't
remove them (no per-frame delete exists — the strip is an open/close toggle and ✕ is just a
"failed" glyph); (3) no per-frame "summarise now" button; (4) no free text fallback when the
AI is down/over budget.

## What the code + box already proved (do not re-investigate)

1. Live DB 2026-10-02: 8 captured rows ALL `summaryError = "bad_request"`, 0 summaries ever
   written on prod. `bad_request` is only produced in `lib/channelry-ai.ts` — every other
   relay failure has its own code.
2. Live relay probes (run 2026-10-02 from /opt/spaceworker, real key + real endpoint):
   - `messages` WITHOUT `tools` → **400** "system and user are required (or pass messages +
     tools for tool mode)". This is EXACTLY what `summariseViaRelay` sends today.
   - `system`+`user` (+`json_mode`) TEXT → 200, valid `{summaries:[...]}`, mode `plain`, 2¢.
   - `messages`+`tools` TEXT → 200, valid JSON, mode `tool`, 3¢.
   - Chain: relay needs tools for messages-mode (or system/user instead); the vision path
     sends neither → every summary call 400s → `bad_request` on every frame.
   - GENUINELY UNKNOWN: does `messages`+`tools`+`image_url` ALSO 200, or does the vision leg
     reject images even with tools? One live probe with a real PNG dataUrl answers it.
3. No OCR in repo: `tesseract` not on PATH (checked), `tesseract.js` not in package.json
   (checked); only hit is a comment in `lib/screen-notifications.ts`. The "lead extractor
   that extracts PDF text" is `local-engine/src/pdf-text.ts` (pdfjs-dist BYTE-to-text) — it
   cannot read PNGs. There is no PNG→text step anywhere. OCR is a NEW dependency.
4. No per-frame delete: `app/api/devices/[deviceId]/screenshots/route.ts` DELETE wipes the
   whole tree (`deleteDeviceFrameTree`); the `[frameId]` route is GET-only. ✕ = status glyph.
5. `DeviceScreenshot` (~schema line 2300) has NO text column — storing OCR text needs an
   additive nullable migration.

## The four fixes (in this order — each ships alone)

### F1 — Fix the relay payload (the actual bug; no new deps)
In `summariseViaRelay` (`lib/screenshot-summaries.ts:252`): add the `tools` array the relay
demands for messages-mode (a no-op function tool, same as the probe). Everything else
byte-identical: batching, caps, `parseSummaries`, tests. Then run the **one live image
probe** (real frame PNG as `image_url` + tools): 200 → F1 alone fixed it. 400 → the relay's
vision leg itself is down → OCR (F2) becomes the PRIMARY, not the fallback. Either way the
8 stuck `bad_request` frames must be made retryable: `bad_request` is NOT in
`RETRYABLE_SUMMARY_ERRORS` — add it (or clear those rows once).

### F2 — Free, non-dependent OCR leg (the owner's core ask)
New `lib/screenshot-ocr.ts`: PNG bytes → text via `tesseract.js` (lazy import, same pattern
as pdfjs-dist; worker + eng data cached locally — no network, no key, no meter). Runs in the
summary pass BEFORE the AI call: OCR text persisted to a new nullable `ocrText` column, then
the AI is asked to summarise the TEXT (proven shapes: system/user, or messages+tools from
the probes) instead of the image. Cost drops from vision-tokens to text-tokens and a
"my AI bill is due" day still yields OCR text. Tests: injectable `OcrFn` fake — never real
tesseract in tests. Perf: runs inside the existing sweep's `maxDuration = 300` route; cap
batch size; a failure marks `ocr_failed`, never `bad_request`.

### F3 — Summary / Full-text toggle (the owner's UI ask)
`ScreenTimeline` row: when BOTH `summary` and `ocrText` exist, a Summary | Full text toggle
(default Summary). Full text = same cell, scrollable (`max-h-32 overflow-y-auto`), no new
layout. `FrameView` + `listRecentFrames` gain `ocrText`. OCR-only (AI failed / cap hit)
still shows everything the machine had on screen — the owner's "users still get the
extraction" requirement. Extend `tests/screen-timeline.test.ts` (real component render).

### F4 — Per-frame delete + per-frame "Summarise now"
- DELETE on `app/api/devices/[deviceId]/screenshots/[frameId]/route.ts` (GET-only today):
  owner-scope (device.userId, 404-not-403 like its GET), file first then row (same order as
  collection DELETE + retention purge). Timeline row gains a real delete button; strip chips
  keep their toggle behaviour (add a title so ✕ stops reading as broken delete).
- POST `…/[frameId]/summarise`: single-frame OCR+summarise through the SAME pass functions
  with the SAME caps (per-user cap re-read, per-device daily budget) — never a side channel.
  Disabled with a title when opted-out / budget-hit ("today's summary budget for this
  machine is used up").

## Non-negotiables (TASK_152 §6, carried forward)
Live app only, branch main. No `lib/` imports in `browser-capture/`. OCR import must be lazy
(deploy tar ships `.next node_modules …`; get `tesseract.js` + eng data into the tar or
lazily fetched once and cached — verify on the box). AI calls metered through
`lib/ai-metering.ts`. Consent per-device, defaults off. Frames sensitive: keep retention, no
wider readership. Additive nullable schema only; scratch DB for migration proof, never
touch live DB. Stage by explicit path, never `git add -A`. Report SHA.

## Open owner decisions
1. Run the live image+tools probe first (1 vision call, ~cents), or build F1+F2 blind and
   let the sweep prove it? (Recommend: probe — 2 minutes, decides whether OCR is fallback
   or primary.)
2. `tesseract.js` (~5MB eng data) bundled in deploy tar vs. fetched once + cached in
   `/var/spaceworker`? (Recommend: cache dir, keeps tar small.)
3. OCR language: English only, or others at ~5MB each?
4. Keep vision-AI summaries once OCR+text-summarise works, or OCR-first always (cheaper)
   with vision as fallback?

## Pause point this task interrupts
P6a platform-accounts: `M prisma/schema.prisma` + `?? prisma/migrations/20261002120000_task155_p6a_platform_accounts/` — uncommitted, untouched here. Resume after.
