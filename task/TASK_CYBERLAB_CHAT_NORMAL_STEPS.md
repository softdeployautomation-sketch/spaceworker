# TASK — Cyber Lab chat: not hardcoded to the teaching lesson

## Goal
Make the Cyber Lab agent chat usable for normal conversation (random chat + give the agent tasks) instead of forcing the teaching lesson on every session start. The teaching lesson becomes an opt-in option. Add a place in the lesson that tells users how to get attested targets they can run attacks on for bug hunting, so they can hand the agent a target to run.

## Context (verified by reading code)
- `components/cyberlab-agent-console.tsx` line 96-97: `TEACHING_KICKOFF` constant — the hardcoded lesson prompt.
- `startSession` (line 251): sends `prompt: TEACHING_KICKOFF` unconditionally → every new session starts the lesson.
- Button label line 554: "Start Teaching Session".
- Input placeholder line 503: "Teach me / ask for the next step…".
- `resumeSession` (line 326): sends a lesson-continuation prompt.
- Server route `app/api/cyberlab/agent/session/route.ts` requires `prompt: z.string().min(1)` — a non-empty prompt is required to start.
- System prompt `buildCyberLabSystemPrompt` (cline-agent.ts:1432) already supports general chat ("If the user says hello or asks a general question, answer directly…") and two jobs (teach + do work with tools against attested targets). So only the UI/start path needs changing, not the agent brain.

## Plan (before edits)
- [x] 1. Create plan file (this doc) — insurance before editing.
- [x] 2. Edit `components/cyberlab-agent-console.tsx`:
  - [x] Replace single "Start Teaching Session" button with a mode selector: "Normal chat" (default) vs "Teaching lesson (bug-hunting 5-step plan)".
  - [x] "Start Session" button sends mode-appropriate prompt:
    - [x] Normal: neutral prompt inviting conversation + tasks, no lesson.
    - [x] Teaching: existing `TEACHING_KICKOFF` + an attested-targets how-to paragraph.
  - [x] Update input placeholder to be mode-neutral.
  - [x] Make resume prompt mode-aware (teaching mode = lesson continuation; normal = continue where we left off).
- [ ] 3. Add attested-targets how-to content inside the teaching lesson prompt (DONE — included in TEACHING_KICKOFF edit).
- [x] 4. Typecheck (`npx tsc --noEmit`) + run lab test suite (`npm run test:lab`) to verify no regressions. (tsc exit 0; tests 97/97 pass, 0 fail)
- [x] 5. Update plan file after edits (insurance).
- [x] 6. Test run: while you handle the cyberlab agent, research vulnerable practice targets / IPs (DVWA, OWASP Juice Shop, Metasploitable, tryhackme, hackthebox, shodan, etc.) and how to obtain/use IPs for runs so you can explain to others. → DEPLOYED & VERIFIED on VPS 207.244.224.57 (BUILD_ID 9nEs5UnxYPQT2j7C3CX2F).

## After-edit state (target)
- New session opens with an empty transcript; user types anything (random chat or a task) and the agent responds normally.
- Choosing "Teaching lesson" starts the 5-step bug-hunting plan including how to obtain attested targets.
- All existing run/episode/evidence/approval behavior unchanged.
