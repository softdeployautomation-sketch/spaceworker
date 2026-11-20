# PLAN — CyberLab Standalone UI (Operation Console)

Status: **APPROVED by owner 2026-10-14** (including the three UI gates at §5). Built as TASK_156B UI-1; steps record: `TASK_156B_CYBERLAB_STANDALONE_UI_STEPS.md`.

> NOTE (2026-10-14): the first version of this doc lived untracked in the shared
> `spaceworker` checkout and was lost between sessions; this copy is committed
> on the cyberlab branch. Its content is the owner-approved plan as quoted back
> and approved verbatim in chat.

---

## 1. What shipped first (context)

The in-flight device-picker step (commit `26afcf7`, gates green): the attest form has a "Pick from your devices" dropdown (same machines as the Devices tab), prefills the address from the agent's last reported IP, and stores a validated link (`sourceDeviceId`) — a foreign or hosted device id is rejected server-side, never an ownership oracle. Honest caption included: agent IPs are often LAN addresses, and scans run from our servers, so the service under test must be exposed or the target reachable. 1,425/1,425 tests pass, tsc 0, eslint 0. Not deployed — needs `prisma db push` first (one nullable column).

## 2. The research — what "looks real" actually is

The "rings around showing different IPs" is a real, proven design — it's Zenmap's RadialNet (nmap's own radial topology). The formula across the products that make those ads:

| Reference | What we take |
|---|---|
| RadialNet (nmap) | concentric rings + sweep beam that reveals hosts as it crosses them |
| Norse/Kaspersky attack maps | glowing arcs lure→click→callback, detonation pulse |
| Falcon visual kill chain | stage rail — every event lands on its stage, live |
| ATT&CK Navigator | tactic×technique heat matrix — the "coverage scoreboard" |
| Elastic timelines | live evidence feed beside the pretty picture |
| AttackIQ/SafeBreach/Pentera | run lifecycle + defence payoff panel |

Two codebase facts that shaped it: 21 deps, zero viz libraries — so hand-rolled SVG/CSS (nothing fake, nothing bloated); and an SSE streaming precedent already exists (`exe/advanced-search/run`) — so live run streaming uses the proven house pattern, no new infra.

## 3. The plan

- **Its own section**: `/cyberlab` becomes a top-level route with its own layout and identity (like `/console`, `/clone`) — entering it feels like a different place; the dashboard keeps a launcher card.
- **Tool bridge, not clones**: scenarios deep-link to the mailer (phishing sim), extractor, and RMM (device access + phase-2 malware sim) with return-to-run; their outputs re-enter as signed artefacts.
- **S2 Operation Console is the ad machine**: radar-rings map + stage rail + real tool text scrolling beside it — the pairing of pretty + credible is what sells it.
- **S7 Episode Replay = the video-ad factory**: episodes are already stored signed with full timelines, so a replay player renders a real recorded run like a video — zero fakes needed.
- **Hard line**: nothing on screen moves unless a real event moved it — that's what kills "looks hardcoded".

## 4. UI-1 build order

1. `lib/lab/console-map.ts` — pure stage-rail + radar mapping (client-safe, one copy shared by server + client).
2. `GET /api/cyberlab/runs/[id]/stream` — SSE replay of the signed episode timeline (house pattern), owner-scoped, server-recomputed signature.
3. `app/cyberlab/*` — top-level route, own layout + always-dark SOC theme.
4. `components/cyberlab-ops-console.tsx` — three-pane console (rail · radar · live feed) porting the C2a console's full feature set.
5. Dashboard launcher card; the old in-dashboard console is removed.

## 5. Owner gates — ALL THREE APPROVED 2026-10-14

1. **Standalone `/cyberlab` route move: APPROVED.**
2. **`SIMULATION · YOUR EQUIPMENT` watermark wording: APPROVED as written** (rendered on every console panel).
3. **Lab theme may diverge from the dashboard palette: APPROVED** — the lab ships its own always-dark SOC canvas scoped to `.lab-ops`, independent of the Night Studio light/dark toggle.

## 6. Deploy discipline

Local commits on `main` only. Deploy (rsync per `HOW_WE_MOVE_FAST.md` §2) still requires `npx prisma db push` for `LabTarget.sourceDeviceId` **and** the owner's explicit go-ahead — neither has happened as of this writing. The live box is still C1; C2a/C2b/UI-1 are undeployed.
