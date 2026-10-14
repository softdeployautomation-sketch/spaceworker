# TASK_156B STANDALONE UI STEPS — /cyberlab Operation Console (UI-1)

Playbook: `HOW_WE_MOVE_FAST.md`. Plan: `PLAN_CYBERLAB_STANDALONE_UI.md`.
**This file is the senior standoff.** Update BEFORE any code (BEFORE record) and AFTER every slice (PROGRESS). Real greps only; never assume.

Repo worktree: **`/Users/mikeolab/sw-lab`**, branch **`main`** (local commits only, no push/deploy without the owner's word). NOTE: the earlier cyberlab steps doc lived untracked in the shared `/Users/mikeolab/spaceworker` checkout and was lost between sessions — this file lives ON MY BRANCH, committed, so the record cannot vanish again.

---

## BEFORE record — 2026-10-14 (UI-1 scoped, plan APPROVED by owner)

### Owner word received (do NOT re-litigate)
- Plan `PLAN_CYBERLAB_STANDALONE_UI.md` **APPROVED**, including all three UI gates:
  1. Standalone top-level `/cyberlab` route (own layout, outside `app/dashboard/*` so the Shell chrome never renders): **APPROVED**.
  2. Panel watermark wording **`SIMULATION · YOUR EQUIPMENT`**: **APPROVED as written**.
  3. Lab theme may diverge from the dashboard palette: **APPROVED** — the lab ships its own always-dark SOC canvas scoped to `.lab-ops` in `app/globals.css`, independent of the Night Studio light/dark toggle.

### Deploy-state reconciliation (real checks, 2026-10-14)
- Local `main` (sw-lab) is 5 commits ahead of `origin/main` — cyberlab commits `db988d2` (C2a chain), `cdd454e` (panel console), `bb873d7` (victim sensor), `3e641ba` (unrelated clone fix), `26afcf7` (device picker) are **local only; nothing pushed**.
- Live VPS (`root@164.68.105.96`, rsync deploys per playbook §2, not git): `/opt/spaceworker` still runs **C1 only** — `lib/lab/` has aup/catalog-seed/consent/gate/research/tools, `app/api/cyberlab/` has only `consent` + `status`. `victim-sensor.ts`, `engine.ts`, `runs/route.ts`, `episodes/route.ts` are NOT on the box ⇒ **C2a/C2b were never deployed**.
- Live DB `LabTarget` columns: `id, userId, kind, value, attestedAt, attestationId, rangeId, createdAt` — **no `sourceDeviceId`**. The one nullable column from `26afcf7` still needs `npx prisma db push` (or a migration) before any deploy of C2b. Unchanged from the last handoff: deploy stays pending owner word.
- Another agent is in-flight on **TASK_205 (hosting wording)** in the `spaceworker` checkout on branch `agent/task-205-link-routing-wording` cut from `origin/main`. It shares ZERO files with cyberlab. My work stays in the `sw-lab` worktree on `main`; I do not touch their branch, their worktree, or `origin`.

### Measured baseline (before any edit)
`npx tsc --noEmit -p .` = 0 errors; `npm run test:lab` = 36/36 pass. node_modules present.

### Build scope (UI-1)
1. `lib/lab/console-map.ts` — pure, client-safe (no server-only): LAB_STAGES rail + `mapEventToStage` + `buildRadarModel` (nodes ONLY from attested targets; arcs only from real from→to pairs at attested nodes; pulses only from `detection.*`; rings are LAYOUT, never a measurement) + `targetsFromTimeline`.
2. `app/api/cyberlab/runs/[id]/stream/route.ts` — SSE (house text/event-stream pattern, exe/advanced-search/run precedent): owner-scoped by range id (foreign id = 404, no oracle), frames `open` → `event` (real `at` + stage) → `evidence` (signed manifest) → `done` (server-recomputed `signatureValid`). Honest flag `live:false` = REPLAY of the signed episode timeline (engine synchronous today; same frame shape serves live events when async execution lands).
3. `app/cyberlab/layout.tsx` + `app/cyberlab/page.tsx` — top-level session-gated route, own dark theme, back-to-SpaceWorker chrome.
4. `components/cyberlab-ops-console.tsx` — the S2 three-pane console: stage rail · SVG radar-rings (sweep only while events play; `prefers-reduced-motion` kills motion) · live tool-output feed; watermark `SIMULATION · YOUR EQUIPMENT` on every panel; ports the C2a console features (scenarios, attest + device dropdown, Start dry-run, run history with replay, signed-episode viewer).
5. `components/cyberlab-panel.tsx` — becomes a launcher card linking to `/cyberlab`; `components/cyberlab-console.tsx` REMOVED (superseded — one console).
6. `tests/lab-ui1.test.ts` — pure map tests + stream-route house require-hook harness + owner-gate copy guards; added to `test:lab`.

Hard lines: §5.2 unchanged; nothing on screen moves unless a real event moved it; no schema change; local commit on `main` only; NO push, NO deploy (deploy still awaits `prisma db push` + owner word).

## PROGRESS

_(entries appended after every slice — dated, with proof)_

### 2026-10-14 — SCOPED + BUILDING (UI-1, in progress)
- Steps + plan docs recreated ON-BRANCH after the untracked originals were lost between sessions. Deploy state reconciled: C1 live on VPS, C2a/C2b/UI-1 undeployed, `sourceDeviceId` absent on live DB, nothing pushed. Another agent (TASK_205 hosting wording) works in the `spaceworker` checkout on its own `origin/main`-cut branch — zero file overlap.
- DONE so far:
  - `lib/lab/console-map.ts` — pure stage rail + `buildRadarModel` + `targetsFromTimeline` (client-safe; no server-only).
  - `app/api/cyberlab/runs/[id]/stream/route.ts` — SSE replay stream, owner-scoped (404 no-oracle), server-recomputed `signatureValid`, `live:false` = REPLAY. Fixed `Json?`→`string[]` narrowing with a `jsonStringArray` helper (no trust of stored shape).
  - `app/globals.css` — `.lab-ops` always-dark SOC theme + keyframes (labSweep/labPulse/labFlow/labBlipIn) + `prefers-reduced-motion` block. Stray duplicated comment line at the top of the block was de-duped.
  - `components/cyberlab-ops-console.tsx` — three-pane console (rail · SVG radar · live feed) porting ALL C2a console features (scenarios, attest + device dropdown, Start dry-run, run history w/ replay, signed-episode viewer). `SIMULATION · YOUR EQUIPMENT` watermark on every panel. Fixed the `OpenFrame`/`DoneFrame` discriminated-union (added `type` literals) and simplified stale-closure pacing in `onmessage`.
  - `app/cyberlab/page.tsx` + `app/cyberlab/layout.tsx` — top-level session-gated route (proxy passes non-/dashboard,/admin through, so page self-gates via getSession() like /console), own `.lab-ops` layout.
  - `components/cyberlab-panel.tsx` — removed `CyberLabConsole` import; render swapped for a gate-guarded launcher card linking to `/cyberlab`.
  - `components/cyberlab-console.tsx` — DELETED (superseded), zero lingering references.
  - `tests/lab-ui1.test.ts` — 15 tests: pure map hard-line + SSE route owner-scope/signature/401/404 + watermark/route/launcher copy guards. House require-hook harness; `next/server`, db, session, module-gate, episode verifier all faked. console-map forwarded by ABSOLUTE path (relative resolves wrong from the route's dir).
- REMAINING: (1) finish panel launcher card, (2) delete superseded `components/cyberlab-console.tsx`, (3) write `tests/lab-ui1.test.ts` (pure map tests + stream-route owner-scope/signature harness + watermark/route copy guards) and add to `test:lab`, (4) run gates: `prisma generate` → `tsc --noEmit -p .` → eslint on changed files → `npm run test:lab`, (5) local commit on `main` only — NO push, NO deploy.

### 2026-10-14 — AFTER record (UI-1 gates green, committed locally)
- Gates ALL GREEN: `prisma generate` ok, `npx tsc --noEmit -p .` = 0, eslint on all changed files + new test = 0, `npm run test:lab` = **51/51** (lab-gate + c2 + c2b + ui1).
- Committed on `main` as **425cce2** (12 files, +1746/−513): the standalone `/cyberlab` Operation Console. NOT pushed, NOT deployed — per plan this batch has no schema change, but the whole C1→C2b→UI-1 line still needs an owner-run `prisma db push` (the `sourceDeviceId` column) before any deploy.
- Zero file overlap with the other agent's `spaceworker` hosting work; `main` is now 6 ahead of `origin/main` (C2a, C2a-console, clone fix, C2b×2, UI-1).
- NEXT (owner decision): (a) `prisma db push` + deploy the whole cyberlab line to VPS, or (b) continue UI-1 to S7 Episode Replay / tool deep-links (mailer/extractor/RMM) per PLAN §3. No further UI-1 build step exists until an owner gate is answered.

