# TASK_252 — Cyber Lab Cline Agent: live replies, real tools, bug-hunting teacher

Status: CODE COMPLETE + BOX E2E PASS (pre-deploy) — awaiting owner GO to deploy
Owner authority: fix the Cyber Lab agent so it answers, uses its tools, hunts bugs for the
owner, and teaches bug hunting. Deploy only after explicit owner GO (HOW_WE_MOVE_FAST).

## Symptom
- User types `hello` in `components/cyberlab-agent-console.tsx`.
- Console bubble says **"Agent error"**.
- DB session stays `active` but context doc ends `agent_event:error errorClass:"auth"` → `idle`.

## Evidence (box, 2026-11-06, BUILD_ID 5Rnrx2JAtcsnTanitC63m)
- Latest `CyberLabAgentSession` `643c70e7-40cd-4d9e-aca9-b5ca80d429ab` (user `cmtl47mcc0000kpr1ds5s2xic`)
  provider `cline-free`, model `cline-free/nemotron-3.5-super-vl`.
- `CyberLabAgentSettings.clineOAuthTokenEnc` decrypts to `{access, refresh, expires, email, accountId, metadata}`.
  `access` is a **WorkOS JWT**; it is valid (refresh succeeds).
- Raw access passed as `config.apiKey` → SDK 401:
  `Unauthorized: ... re-authenticate your Cline account. (Request ID: ...)`; `finishReason:"error"`,
  `errorClass:"auth"`.
- Probe with `apiKey = "workos:" + access` (the output of `formatProviderOAuthApiKey("cline", {access})`):
  `finishReason:"completed"`, assistant text `"Hello! How can I help you?"`.
- `startClineLabSession` returns `result.finishReason` as `message`, so the UI prints "error"/"completed"
  instead of the assistant text. `AgentResult.text` DOES contain the reply; `outputText` is undefined.
- `start`/`send` await the whole turn. A tool call waits on `requestToolApproval`, but the console only
  starts polling approval after the POST resolves → approval deadlock. Tools cannot be used from the UI.
- `GET /api/cyberlab/agent/session` has no GET handler, so `loadSessions()` always 405s.
- `resumeClineSession` passes the prompt to `start` AND then `send`s it again → duplicate prompt.
- Host tooling check: `curl wget dig whois nc jq python3 node` present; `nmap ffuf hydra nuclei`
  not installed. Prompt must say "check `command -v` first", not pretend scanners exist.

## Root cause
1. **Auth**: OAuth access token must be formatted as `workos:<access>` for provider `cline`; code passed raw.
2. **Output**: UI renders `finishReason`, not `AgentResult.text` / transcript messages.
3. **Tools/liveness**: synchronous turn + approval = deadlock; no live status/transcript.
4. **Sessions**: missing list GET; resume duplicates prompt.
5. **Teaching**: system prompt lists missing scanners as if installed and never asks the agent to teach.

## Edit ledger (update immediately before/after each edit)
- [x] B0 Diagnosis + probe evidence (above).
- [x] B1 `lib/lab/cline-agent.ts` — `workos:` OAuth key via `formatProviderOAuthApiKey`; friendly auth error.
- [x] B2 `lib/lab/cline-agent.ts` — fire-and-forget turns (start/send/resume), busy state, no approval deadlock;
      correct resume (no duplicate prompt); fix event subscription payload shape + error capture.
- [x] B3 `lib/lab/cline-agent.ts` — `listClineSessions`, `getClineSessionMessages` (text + tool parts + steps).
- [x] B4 `app/api/cyberlab/agent/session/route.ts` — GET list.
- [x] B5 `app/api/cyberlab/agent/session/[id]/messages/route.ts` — new GET transcript/live feed.
- [x] B6 `components/cyberlab-agent-console.tsx` — poll transcript/status, render agent text + tool activity,
      show busy/auth guidance, teaching-mode start prompt, fix broken layout.
- [x] B7 `lib/lab/cline-agent.ts` — teaching system prompt (bug-hunting loop, check tools exist, ask for target).
- [x] B8 Tests: update TASK_246 expectations (`workos:`), add transcript/friendly-auth/GET-list coverage.
- [x] B9 Gates: `npx tsc --noEmit` 0 errors; `tests/cline-agent-spike.test.ts` 23/23 pass;
      `npm run test:lab` 97/97 pass. Full `npm test`: 1881 pass / 18 fail — all 18 are in
      unrelated dirty-worktree areas (device-list/signup/vantra/TASK_238/TASK_179); no failing file
      imports any TASK_252 file.
- [ ] B10 Commit on branch, merge to main, deploy via `gh workflow run 'Build & Deploy'` only after owner GO.
- [x] Local verification detail: `node --input-type=module -e "import{formatProviderOAuthApiKey}from'@cline/sdk';..."` → `workos:abc`.
- [x] B11a Pre-deploy exact-code box E2E (2026-11-06): ran a temp copy of the new `lib/lab/cline-agent.ts`
      on the box against the real DB/token/model (only import aliases changed for the standalone bundle).
      `hello` → `status:"active", busy:true` then `busy:false, lastFinish:"completed", lastError:null`;
      transcript 2 messages / 80 steps; assistant text was the real teaching intro + 5-step bug-hunting map.
      Test session `e6919325-8324-4445-99b8-beba0cd63eb6` stopped, DB row/steps + session/context files
      deleted; all temp files removed. No deploy performed.
- [ ] B11 Post-deploy box verify: BUILD_ID changed, `hello` returns a real assistant reply, no `errorClass:"auth"`,
      tools approval appears and can be approved, transcript visible through the real HTTP routes/UI.
- [ ] B12 Remove diagnostic scripts from box (`/opt/spaceworker/scripts/_diag-*`, `/root/_run-*.sh`).

## Files
- `lib/lab/cline-agent.ts` (auth, runtime, transcript, prompt)
- `app/api/cyberlab/agent/session/route.ts` (+GET)
- `app/api/cyberlab/agent/session/[id]/messages/route.ts` (new)
- `components/cyberlab-agent-console.tsx`
- `tests/cline-agent-spike.test.ts`

## Non-goals / hard lines
- No schema change, no migration.
- Do not install offensive scanners on the production VPS in this task.
- Do not commit unrelated dirty files already in the worktree.
- No deploy without owner GO; no claim of "fixed" without box evidence.
