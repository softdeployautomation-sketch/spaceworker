# PLAN — CyberLab Next: S7 Episode Replay + Tool Bridge (PLAN_CYBERLAB_STANDALONE_UI.md §3 remainder)

Status: **DRAFT — awaiting owner approval.** Written after UI-1 shipped (commit `3765ab4`, gates green) and the run+deploy was handed to the deploy owner (`HANDOFF_CYBERLAB_UI1_DEPLOY.md`). **No code yet.** This is the next slice, scoped and gated.

Playbook: `HOW_WE_MOVE_FAST.md`. Prior steps: `TASK_156B_CYBERLAB_STANDALONE_UI_STEPS.md`. Worktree `sw-lab`, branch `main` (local commits only until the deploy owner says otherwise).

---

## 0. Where we are

UI-1 (the standalone `/cyberlab` Operation Console) is built and locally committed:
- `lib/lab/console-map.ts` — pure event→visual map (stage rail + radar model).
- `GET /api/cyberlab/runs/[id]/stream` — SSE replay stream, owner-scoped, `live:false` = REPLAY.
- `app/cyberlab/*` + `components/cyberlab-ops-console.tsx` — three-pane console (rail · radar · feed), `SIMULATION · YOUR EQUIPMENT` watermark.
- Gates: tsc 0, eslint 0, `test:lab` 51/51.

The console already **renders a recorded run** by streaming the episode's real timeline through the map. What it does NOT yet do is the two remaining §3 items that turn it into the sales machine: a **standalone replay player** (S7, the "video-ad factory") and the **tool bridge** (deep-links to mailer/extractor/RMM with return-to-run). Both are additive UI on top of data that already exists and is already signed — **no new evidence machinery, no schema change, no new infra.**

---

## 1. The two slices

### Slice A — S7 Episode Replay player (the video-ad factory)
**Idea (PLAN §3):** episodes are already stored signed with full timelines, so a replay player renders a real recorded run like a video — zero fakes needed.

- **Data already exists:** `GET /api/cyberlab/episodes/[id]` returns `{ episode: { id, rangeId, startedAt, endedAt, timeline: {mode, scenarioSlug, entries[]}, techniques, telemetrySignatures, outcome, evidenceManifest, signedHash, createdAt }, signatureValid }` with `signatureValid` **recomputed server-side** from the stored row. The SSE stream route already replays the same entries with their real `at` timestamps.
- **Build:** a `/cyberlab/replay/[id]` view (inside the existing `.lab-ops` layout) that fetches the episode once, then plays its `entries[]` back on a timeline scrubber — reusing `console-map.ts` (the SAME map, never a second copy) so the radar/rail animate off the identical geometry the live console uses. Play/pause, speed, and a scrub bar; the watermark and the honest "this is a recorded run" caption stay on screen.
- **Hard line (unchanged):** every frame the player draws comes from a stored timeline entry. Nothing interpolates, nothing invents. `signatureValid` is displayed as returned by the server — the player cannot claim a run is verified if the server says otherwise.
- **Share/embed angle (why it's the "video-ad factory"):** because the input is a signed episode, a replay is a **verifiable** demo — the ad *is* real evidence, which is the whole positioning against competitors whose ads are staged.

### Slice B — Tool bridge (deep-links, not clones)
**Idea (PLAN §3):** scenarios deep-link to the mailer (phishing sim), extractor, and RMM (device access + phase-2 malware sim) with return-to-run; their outputs re-enter as signed artefacts.

- **Confirmed deep-link targets exist:** `app/dashboard/mailboxes` + `campaigns` (mailer), `app/dashboard/extract` (extractor), `app/dashboard/devices` (RMM/device access). These are the launch points; we link to them, we do **not** re-implement them.
- **Build:** from the console's scenario rail / a target's node, a "Run with <tool>" action that deep-links out with a `?returnTo=/cyberlab/runs/[id]` (and the run/scenario context in the query). On return, the tool's output is offered as an artefact to attach to the run — reusing the existing signed-manifest path so a bridged output lands the same way in-engine outputs do.
- **Scope discipline:** Slice B is the riskier of the two (cross-feature contract, auth context on the return hop). Recommend shipping **Slice A first** (self-contained, high sales value), then B.

---

## 2. Build order (recommended)

1. **Slice A — S7 replay player.** `app/cyberlab/replay/[id]/page.tsx` + a `cyberlab-replay.tsx` component; a thin client fetch of the existing episode route; scrubber + play/pause driving `buildRadarModel`/`stagesHit` over `entries[]`. Pure mapping stays in `console-map.ts` (extend only if a scrubber needs a "stage up to index N" helper — still one module).
2. **Tests (`tests/lab-ui2.test.ts`):** house require-hook harness. Prove: (a) the replay builds the SAME geometry as the live stream for the same episode (one mapping, no drift); (b) the player surfaces `signatureValid` exactly as the server returns it and never flips a false to true; (c) a tampered stored episode replays but shows **invalid**; (d) owner-scope still holds (foreign episode id = 404 via the existing route).
3. **Gates:** `tsc --noEmit -p .` = 0 · eslint 0 · `npm run test:lab` all green (add ui2 to `test:lab`).
4. **Slice B — tool bridge** (after A is green + approved): deep-link helpers + return-to-run + artefact attach reusing the signed manifest. Separate steps record.

---

## 3. Owner gates (new — needed before UI-2 builds)

1. **Ship order:** A (replay) first, then B (tool bridge)? *(I recommend yes.)*
2. **Replay URL shape:** `/cyberlab/replay/[id]` inside the existing `.lab-ops` layout — confirm.
3. **Tool-bridge return contract:** is `?returnTo=` + query-carried run/scenario context acceptable for the mailer/extractor/RMM handoff, or do you want a server-side "pending bridge" token instead? *(Affects Slice B only.)*
4. **Share/embed:** do replays need a public share link (signed, read-only, no auth) so they can be used in marketing — or customer-authenticated only? *(This is the "video-ad" unlock; if public, it needs its own rate-limit + no-PII audit before build.)*

---

## 4. Hard lines (carried forward, unchanged)

- Nothing on screen moves unless a real event moved it. One mapping module (`console-map.ts`), shared by live + replay.
- `signatureValid` is always server-recomputed from the stored row; the client never trusts or fabricates it.
- No schema change; no new evidence machinery; local commit on `main` only; **no push / no deploy** without the deploy owner's word.
- Zero file overlap with the other agent's `spaceworker` hosting work (task-205).

