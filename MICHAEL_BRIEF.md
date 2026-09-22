# MICHAEL BRIEF — how to build for SpaceWorker (read this first, then your tasks)

**Welcome — this doc tells you everything: what this codebase is, the rules,
how to push your work, and exactly what your tasks are.**

---

## 1. What SpaceWorker is (30-second version)

`spaceworker.top` is a web app (Next.js 16, App Router, TypeScript, Postgres
via Prisma) that bundles: a private browser + browser profiles, lead
extraction, email outreach campaigns, an AI agent with a human-approval gate,
and (in progress) device management via our Vantra RMM. We are adding an AI
device assistant, a Browser Clone capability, and a Cyber Lab.

**There is also a separate desktop product** — the Lead Extractor EXE (Tauri,
`src-tauri/`) — it's a different product; don't touch it unless a task says so.

## 2. Repo map (what lives where)

| Path | What it is |
|---|---|
| `app/` | Next.js App Router pages + API routes (`app/api/...`) |
| `components/` | React components (UI lives here) |
| `lib/` | Server libraries — `lib/agent.ts` (AI brain), `lib/entitlements.ts` (feature gates), `lib/telegram.ts` / `lib/notify.ts` (notifications), `lib/vantra-link.ts` (RMM link, Task 93) |
| `prisma/` | `schema.prisma` + `migrations/` (hand-written SQL — see rules) |
| `worker/`, `browser-server/`, `local-engine/` | extraction/browser automation runtimes |
| `src-tauri/` | the Extractor EXE only — NOT the web app |
| `HOW_WE_MOVE_FAST.md` | the deploy/migration playbook — read §0–§3 once |
| `PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md` | the master plan your tasks come from |

**Repos**: upstream `origin` = `github.com/softdeployautomation-sketch/spaceworker`
(production). **You push to `michael-fork` = `github.com/Mikeolab/spaceworker`**
(already configured as a git remote). The owner is the only one who merges to
`origin main` and deploys.

## 3. The rules (violating any of these breaks production)

1. **NEVER touch `.env` files** — server-only secrets. Never commit, never
   copy, never reference real values in code or logs.
2. **Schema changes**: write migration SQL BY HAND in
   `prisma/migrations/<timestamp>_<name>/migration.sql`, matching the style of
   existing migrations (plain SQL + a top comment explaining why). Then
   `npx prisma generate` locally. The owner applies it on the VPS.
3. **Type-check before pushing**: `npx tsc --noEmit -p .` must be clean.
4. **Stay inside your contract**: build only what your task spec says
   (folders/files named in it). If you think something else needs changing,
   note it in your README instead of changing it.
5. **No secrets in code, logs, or test data** — ever. Your scripts must print
   paths/counts, never cookie/password content.
6. **`app/proxy.ts`** (middleware) lives at the REPO ROOT, not in `app/` — and
   never rely on it for your features (it's a special isolated bundle).

## 4. How to push your work

```bash
# one-time
git clone https://github.com/Mikeolab/spaceworker.git   # or use the existing michael-fork remote
cd spaceworker && npm install

# per task
git checkout -b michael/<task-slug>        # e.g. michael/browser-clone-scripts
# ...build inside the EXACT folder your task names (e.g. michael/browser-clone/)...
npx tsc --noEmit -p .                       # only if you touched TS
git add michael/<folder> && git commit -m "MT-1: browser clone capture/restore scripts"
git push -u origin michael/<task-slug>      # 'origin' here = Mikeolab/spaceworker (your fork)
```

Then open a PR on `github.com/Mikeolab/spaceworker` (base: main) — the owner
reviews, merges, and integrates into the production repo. **Pure-script
deliverables can also live in your own standalone repo** — same README rules.

## 5. README template (REQUIRED in every deliverable folder)

```markdown
# <Deliverable name>
## What it does
(two sentences)
## Files
(one line per file: name — purpose)
## Usage
(exact command + arguments + expected exit codes)
## Inputs / outputs
(args in, files out, what the integration side must provide)
## Safety
(what it must never log/emit; cleanup behavior on failure)
## Test evidence
(how you tested it, on what OS/browser versions)
```

## 6. Your tasks (contracts live in the task docs in this repo)

- **MT-1 — Browser Clone capture/restore scripts** → contract in
  **`TASK_97_BROWSER_CLONE.md` §"Michael MT-1 contract"**. PowerShell, Windows
  first, Chrome/Edge/Firefox profile capture + restore, encrypted archives,
  headless under the Vantra agent.
- **MT-2 — Cyber Lab scenario pack** → contract in
  **`TASK_98_CYBER_LAB_STAFF_TRACK.md` §"Michael MT-2 + MT-3 contracts"**.
  5 ATT&CK-mapped Caldera adversary profiles + per-scenario telemetry docs.
- **MT-3 — Detection derivation** → same doc, MT-3 section. Sigma-class rules
  per scenario + hardening check scripts (AV, Defender, RDP, run-keys, SMB).
- **MT-4 (optional, ongoing)** — extraction pipeline improvements: propose via
  README notes in your branch; owner scopes before you build.

## 7. Collaboration model (we're usually in the same room)

- You build in isolation on `michael/<task>` branches in the fork; the owner
  reviews, merges to `softdeployautomation-sketch/spaceworker` main, and runs
  the deploy (build + migration + restart + live verify per
  `HOW_WE_MOVE_FAST.md` §2/§3).
- Working together live? Same flow — commit to your branch early and often so
  integration is always a fast-forward, never a rescue.
- Every task doc lists acceptance criteria — the owner runs those before
  merging. If a check fails, fix on your branch, re-push.
