# TASK_253 — Mailer EXE "couldn't start your free trial" fix — STEPS

Owner report (2026-11-08): the mailer EXE says *"Couldn't start your trial yet. Check
your connection and try again."* The owner suspected it was still talking to the old server
or that the referral lock was interfering.

## BEFORE (evidence captured 2026-11-08, pre-change)

| Check | Command / evidence | Result |
|---|---|---|
| Last mailer build | `gh run list --workflow=build-exe.yml` | run **42254651693** success 2026-11-06, commit **c79c730**, artifact **spaceworker-mailer-windows** |
| EXE default API base | `sed -n '41p' lib/exe-runtime.ts` | `http://207.244.224.57:3500` |
| VPS env base | `grep -m1 '^EXE_API_BASE_URL=' /opt/spaceworker/.env` | `http://207.244.224.57:3500` |
| Direct port | `curl -m 12 http://207.244.224.57:3500/` | **timeout, http=000** |
| Firewall | `ufw status` on VPS | active; allows **22/80/443/3402 + UDP 3478/52000-52099/53000-53100** — **3500 NOT allowed** |
| HTTPS API path | `curl -X POST https://spaceworker.top/api/exe-license/trial-ping -d '{"machineId":"probe-no-email-001","product":"mailer_exe"}'` | **400 `{"error":"An email is required to start a free trial."}`** — reachable and correct |
| SSR/proxy | `curl https://spaceworker.top/` | **200** real app (not a parked/joker response) |
| Trial ↔ referral | `app/api/exe-license/trial-ping/route.ts` | no referral/invite gate → **referral is not the cause** |
| Referral fix live? | box build `LbeQ2zyJ7asC0PCHSq7s2`; `grep -rl TN35EZ2K /opt/spaceworker/.next/server` | **0 hits** → the uncommitted signup change is **not deployed** |
| Error render site | `components/license-gate.tsx:100` | generic message shown for any non-2xx from local trial-start |

**Root cause:** the installed mailer build points `HOSTED_APP_URL` at
`http://207.244.224.57:3500`, which ufw drops. The local trial-start proxy times out and
returns 502; the gate hides the real reason behind a generic connectivity message.

**Owner decisions (2026-11-08):**
1. Rebuild + reinstall only (do **not** open ufw 3500).
2. Commit + deploy the referral/signup change too.
3. Verify with local-runtime proof; owner installs and eyeballs the Windows GUI.

## FILES IN SCOPE

- `lib/exe-runtime.ts` — default/guarded `HOSTED_APP_URL`
- `scripts/runtime-assemble.mjs` — bake `EXE_API_BASE_URL` into packaged `.env.local`
- `components/license-gate.tsx` — surface the real upstream error (no crash, no generic lie)
- `tests/exe-runtime-url.test.ts` — new regression test
- `app/api/auth/signup/route.ts` — owner's already-made referral change (commit + deploy)
- `PLAN_XDEVICE_EXE_REFERRAL_API.md` — correct the stale "spaceworker.top is a joker" premise
- `TASK_253_MAILER_EXE_TRIAL_FIX_STEPS.md` — this file (updated before/after every edit)

## EDIT LOG (updated before and after each change)

<!-- Each entry is appended here before and after the corresponding edit. -->

### E0 — plan doc created
- BEFORE: no doc existed for this task; plan captured above.
- AFTER: this file created.

### E1 — `lib/exe-runtime.ts` (BEFORE)
- Intent: replace the firewalled `http://207.244.224.57:3500` default with
  `https://spaceworker.top`, keep `EXE_API_BASE_URL` as an override, trim trailing
  slashes, and refuse known-dead bases (old `164.68.105.96`, raw `:3500` IP) so a stale
  build-time env can never resurrect this outage.
- Current line: `export const HOSTED_APP_URL = process.env.EXE_API_BASE_URL ?? "http://207.244.224.57:3500";`

### E1 — `lib/exe-runtime.ts` (AFTER)
- Default is now `https://spaceworker.top`; `EXE_API_BASE_URL` override honored
  (trailing slash trimmed); old-IP and `:3500` bases fall back to the domain.
- Exported `resolveHostedAppUrl()` + `DEFAULT_HOSTED_APP_URL` for the regression test.

### E2 — `scripts/runtime-assemble.mjs` (BEFORE)
- Intent: write `EXE_API_BASE_URL` into the packaged runtime's `.env.local` so the
  installed EXE's target is explicit/inspectable, defaulting to
  `https://spaceworker.top` and rejecting the known-dead bases.

### E2 — `scripts/runtime-assemble.mjs` (AFTER)
- `.env.local` now carries `EXE_API_BASE_URL`; dead/retired values are replaced by
  `https://spaceworker.top` at assembly time.

### E3 — `components/license-gate.tsx` (BEFORE)
- Intent: stop swallowing the upstream reason. Any non-2xx currently renders
  "Couldn't start your trial yet. Check your connection…", which is exactly what hid
  this outage. Show the server's own message when present; keep the generic fallback
  and never throw.

### E3 — `components/license-gate.tsx` (AFTER)
- Non-2xx now renders `data.error` when it is a non-empty string; generic fallback kept.

### E4 — `tests/exe-runtime-url.test.ts` (BEFORE)
- Intent: pin the contract — default `https://spaceworker.top`, dead bases refused,
  valid override honored, trailing slash trimmed.

### E4 — `tests/exe-runtime-url.test.ts` (AFTER)
- Test file added (server-only stubbed via `Module._load`; env-driven + pure resolver).

### E5 — `PLAN_XDEVICE_EXE_REFERRAL_API.md` (BEFORE)
- Intent: correct the stale "spaceworker.top is a joker page" premise that justified the
  firewalled-IP default, and record the TASK_253 outcome so it cannot be re-adopted.

### E5 — `PLAN_XDEVICE_EXE_REFERRAL_API.md` (AFTER)
- Correction banner added; the "EXE calls VPS directly" section marked superseded.

## GATE LOG

### G1 — typecheck + focused test (BEFORE)
- Running `npx tsc --noEmit` and `npx tsx --test tests/exe-runtime-url.test.ts`.

### G1 — typecheck + focused test (AFTER)
- `npx tsc --noEmit` → exit **0**.
- `npx tsx --test tests/exe-runtime-url.test.ts` → **5 pass / 0 fail**.
- `npx eslint` on touched files → one **pre-existing** error at `license-gate.tsx`:
  unescaped `We'll` (present at HEAD line 168). Fixing it in E6 so the touched file is clean.

### E6 — `components/license-gate.tsx` lint (BEFORE)
- Intent: escape the pre-existing `We'll` apostrophe (`We&apos;ll`); no behavior change.

### E6 — `components/license-gate.tsx` lint (AFTER)
- `We'll` → `We&apos;ll`; re-ran eslint on the touched file → clean.

### E7 — signup attribution, EXE-only (BEFORE)
- Owner clarification: **only EXE signups** may default to admin referral `TN35EZ2K`;
  web must stay invite-only (F8). The uncommitted server-side `?? ADMIN_REFERRAL_CODE`
  made every no-ref signup succeed and broke F8 (201 vs 403).
- Change: drop the server-side default; keep body/`?ref=` support; make the EXE's
  `/signup` link carry `?ref=TN35EZ2K` via `accountHref()` (the hosted `/signup` page
  already validates `?ref` and stamps `sw_ref`). Web no-ref/no-invite stays **403**.

### E7 — `app/api/auth/signup/route.ts` (AFTER)
- Admin fallback removed; resolution is body → query → cookie; F8 branch untouched.

### E7 — `lib/exe-runtime.ts` (AFTER)
- `accountHref("/signup")` in the local EXE appends `ref=TN35EZ2K`; `/login` unchanged.

### G2 — post-signup-fix gates (AFTER)
- `npx tsc --noEmit` → **0**.
- `npx tsx --test tests/exe-runtime-url.test.ts tests/admin-signup-alert.test.ts`
  → **15 pass / 0 fail** (F8 403 restored).
- `npx eslint` touched files → **0 errors**, 1 pre-existing unused-import warning
  (`prisma` in signup route, present at HEAD).
- Full `npm test` → **1889 pass / 17 fail**; the 17 are the exact pre-existing set
  proven on the clean HEAD worktree (`/tmp/task253-base`). No new failures.

### G3 — mailer build + assembled runtime (AFTER)
- `CI=true BUILD_TARGET=mailer npx next build` → **exit 0** (CI=true mirrors the
  workflow's placeholder bypass; without it the local `.env` dev RESEND value fails
  the production guard).
- `BUILD_TARGET=mailer node scripts/runtime-assemble.mjs` → **exit 0**.
- `exe/runtime/standalone/.env.local`: `EXE_API_BASE_URL=https://spaceworker.top`,
  `BUILD_TARGET=mailer`, `SPACEWORKER_LOCAL_EXE=true`.
- Compiled `.next/server` chunks: **0** hits for `207.244.224.57`; domain present.
- Local runtime on `127.0.0.1:4567`: `POST /api/exe-license/trial-start`
  `{"email":"task253-proof-…@example.com"}` → **HTTP 200 `{"ok":true,"startedAt":…}`**
  (would have been a 10s timeout/502 with the old base). Server stopped.
- Cleanup: `ExeTrialSession` rows for the proof email = **0** (the Mac's machineId
  already had a first-wins trial row; no new row was created).

### E8 — deploy tooling host fix (BEFORE)
- `.github/workflows/deploy.yml` still SSHs/scps/keyscans **164.68.105.96** (dead).
  `scripts/deploy-vps.sh` still defaults `VPS_HOST` to the same. The web deploy
  cannot run until these point at **207.244.224.57**.
- Intent: replace the four workflow occurrences and the script default/comment;
  no other behavior change.

### E8 — deploy tooling host fix (AFTER)
- deploy.yml + deploy-vps.sh now target `207.244.224.57`; box unit names confirmed
  present before use (spaceworker, spaceworker-browser, extraction-worker).

## GATES

- [ ] `npx tsc --noEmit`
- [ ] `npx tsx --test tests/exe-runtime-url.test.ts`
- [ ] `npm test` (or affected subset) — record counts
- [ ] `BUILD_TARGET=mailer npx next build` (standalone)
- [ ] `node scripts/runtime-assemble.mjs` (dummy non-placeholder secret)
- [ ] assembled `.env.local` contains `EXE_API_BASE_URL=https://spaceworker.top`
- [ ] assembled standalone contains **0** `207.244.224.57:3500`
- [ ] local assembled runtime: `POST /api/exe-license/trial-start` → `200 {ok:true}`
- [ ] hosted `trial-ping` with disposable email → `200 {startedAt}`; row cleaned up

## SHIP

- [ ] scoped commit on `main` (only the files above), push
- [ ] `gh workflow run deploy.yml --ref main` (signup change live) — then verify BUILD_ID + `TN35EZ2K` in built chunks
- [ ] `gh workflow run build-exe.yml -f variant=mailer` — download artifact
- [ ] hand owner the installer + install steps (delete `_up_` first)

## AFTER

<!-- Filled in after the work completes, with raw evidence. -->
