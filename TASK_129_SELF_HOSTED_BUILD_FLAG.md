# Task 129 — `SELF_HOSTED` build-time flag (Phase 1 of the self-hosted SpaceWorker OS project)

**Status: Phase 1 split in progress. §1 (foundation) is BUILT and verified on branch `self-hosted-build`. §2-§5 below are the open work — pick up from there.**

**Full project plan**: `/Users/mikeolab/.claude/plans/transient-moseying-tome.md` (SpaceWorker OS self-hosted/standalone build — read the "Context" and "Phase 1" sections there for the big picture; this doc is just Phase 1's execution spec). This project is **not urgent** — see the branching note below before doing anything.

## Branch / workflow (read first, this is not optional)

- Everything for this project lives on branch **`self-hosted-build`**, pushed to `origin` but **never merged to `main`** until the owner says so. This is a long-running side project running in parallel with normal live-app hotfix work on `main` — the two must never block each other.
- **Before touching anything**: `git fetch origin && git worktree add <some-tmp-path> origin/self-hosted-build` (or `git checkout self-hosted-build` if working directly) — do NOT branch this off `main` fresh; it must include the §1 commit already on `self-hosted-build`, or you'll be redoing `isSelfHosted()` from scratch and creating a merge conflict with yourself later.
- When done: commit on `self-hosted-build`, push to `origin/self-hosted-build` (never `origin/main`), and stop — no deploy, no PR to main, this doesn't ship until the whole self-hosted project is ready.
- If `main` has moved on since `self-hosted-build` was cut (very likely, live fixes land there constantly), that's fine and expected — do not rebase/merge `main` into this branch unless asked; conflicts get resolved deliberately later, not as a side effect of routine Phase 1 work.

## §1 — Already built (verify, don't redo)

Three files, on `self-hosted-build`, already committed:

- **`lib/exe-build-target.ts`** — added `isSelfHosted(): boolean` (reads `process.env.SELF_HOSTED === "true"`), sibling to the existing `exeBuildTarget()`. This is the ONE function every other gate in this task imports.
- **`lib/exe-runtime.ts`** — `accountHref()` now returns `path` unchanged when `isSelfHosted()` is true, before falling through to its existing `isLocalExeRuntime()` check. A self-hosted deployment has no "our hosted account" to redirect to.
- **`next.config.ts`** — the CSP `frame-ancestors` directive now reads `process.env.FRAME_ANCESTORS ?? (process.env.SELF_HOSTED === "true" ? "'self'" : "'self' https://vantra.spaceworker.top")` instead of the old hardcoded string. Read `process.env` directly here (NOT via `isSelfHosted()`/an import) — this file is evaluated outside Next's normal module graph at `next build` time, same reason `MESH_FRAME_ORIGINS` right below it does the same thing; importing project modules into `next.config.ts` is fragile and unnecessary here.

**Verified**: `npx tsc --noEmit` clean, `npx eslint` clean on all three files, full test suite (222 tests) green, and TWO real production builds both genuinely succeeded (checked via a real captured `$?`, not a `| tail` pipe whose exit code lies about the command before it — learned that the hard way earlier in this same task, see the note in §5):
- `CI=true NODE_ENV=production npm run build` (SELF_HOSTED unset) → CSP header baked into `.next/routes-manifest.json` is unchanged: `frame-ancestors 'self' https://vantra.spaceworker.top`.
- `SELF_HOSTED=true CI=true NODE_ENV=production npm run build` → CSP header is `frame-ancestors 'self'` (no vantra origin).

Do not modify these three files as part of this task unless you find a genuine bug in them — if you think you do, stop and flag it rather than silently changing the approach.

## §2 — Admin panel: hide 4 tabs in a self-hosted build

File: **`app/admin/(protected)/admin-panel.tsx`**.

1. The `Tab` union (line 54) and `TABS` array (lines 56-76) currently list all 15 tabs. Self-hosted builds must drop exactly 4: `payments`, `wallets`, `ai`, `licenses`. Everything else stays (`overview`, `users`, `notifications`, `sessions`, `queue`, `infrastructure`, `services`, `templates`, `mailboxes`, `campaigns`, `automations`).
2. `AdminPanel`'s props (line 136: `export default function AdminPanel({ initialUsers }: { initialUsers: AdminUser[] })`) need a new prop: `selfHosted: boolean`. Filter `TABS` down to the kept set when `selfHosted` is true (a `const visibleTabs = selfHosted ? TABS.filter(t => !["payments","wallets","ai","licenses"].includes(t.id)) : TABS;`, then render `visibleTabs` in the nav map at line 157 instead of `TABS` directly). Also guard the `{tab === "payments" && <PaymentsTab />}` etc. render lines (183-184, 191-192) the same way, or simply leave them — since `tab` state can never BECOME one of those 4 values once they're not in `visibleTabs`'s buttons, but do add the guard for defensive correctness (someone could still land on `tab==="payments"` via a stale bookmark/hash if this ever gets URL-synced later).
3. Wire the prop from the server side — **`app/admin/(protected)/page.tsx`**: import `isSelfHosted` from `@/lib/exe-build-target`, and pass `selfHosted={isSelfHosted()}` on the existing `<AdminPanel initialUsers={...} />` call (around line 33-41). `isSelfHosted()` is a `server-only` module — this file is already an async server component (`export default async function AdminPage()`), so this is a plain synchronous call, no `await` needed. **This exact two-file coupling (prop added to the component + prop passed from the page) is why this was left as one unit instead of me half-wiring it — do both together, verify `npx tsc --noEmit` passes, since a mismatched prop is a real type error, not a lint nit.**

## §3 — Admin API routes: 404 even on direct request

Same 4 areas, but the actual API routes — hiding a tab in the UI is not a security boundary, a self-hosted deployment's admin routes for these must be **genuinely inert**, not just unlisted. Add `if (isSelfHosted()) return NextResponse.json({ error: "Not found" }, { status: 404 });` as the FIRST line inside every exported handler below (import `isSelfHosted` from `@/lib/exe-build-target`), before any existing admin-session check — a self-hosted build should refuse before it even checks who's asking.

Exact files and handlers (12 handler functions across 9 files):

| File | Handlers |
|---|---|
| `app/api/admin/payments/route.ts` | `GET` |
| `app/api/admin/payments/[id]/approve/route.ts` | `POST` |
| `app/api/admin/payments/[id]/reject/route.ts` | `POST` |
| `app/api/admin/payments/[id]/retry-license/route.ts` | `POST` |
| `app/api/admin/wallets/route.ts` | `GET`, `PUT` |
| `app/api/admin/ai/route.ts` | `GET`, `POST` |
| `app/api/admin/ai-usage/route.ts` | `GET`, `PATCH` |
| `app/api/admin/exe-licenses/route.ts` | `POST`, `GET` |
| `app/api/admin/exe-trials/route.ts` | `GET` |

Use 404 ("Not found"), not 403 — matches this codebase's established "fail closed and don't confirm the resource even exists" convention (see `lib/vantra-link.ts`'s and `lib/exe-license.ts`'s own comments on this if you want the reasoning restated).

**Do NOT touch any other admin API route** — `users`, `notifications`, `browser-sessions`/`browser-profiles`, `queue`, `governor`/`admission-control`/`clone-limits`/`vantra-links`, `services`, `campaign-templates`/`user-campaign-templates`, `mailboxes`, `campaigns`, `automations`, `screenshots` all stay fully functional in a self-hosted build — they're genuinely useful there.

## §4 — Internal sweep routes

1. **`app/api/internal/payment-verify/route.ts`** — add the same `if (isSelfHosted()) return NextResponse.json({ error: "Not found" }, { status: 404 });` as the first line of `POST`, before the `requireInternalBearer` check. This is our own crypto-payment auto-verification for OUR storefront — unconditionally irrelevant to a self-hosted deployment, no configuration makes it relevant.
2. **`app/api/internal/device-status-sweep/route.ts`** and **`app/api/internal/device-onboarding-sweep/route.ts`** — these are DIFFERENT: do **not** gate on `isSelfHosted()` directly. A self-hoster who's set up device management (the future "SpaceWorker RMM Engine" from Phase 4 of the full plan) DOES want these running. Instead, gate on "is the internal device-check-in service actually configured" — add, as the first check inside `POST` (after `requireInternalBearer`, not before — this check still needs a valid bearer caller to even ask): `if (!process.env.VANTRA_INTERNAL_URL || !process.env.VANTRA_INTERNAL_TOKEN) return NextResponse.json({ ok: true, skipped: "device management not configured" });` (200, not an error — a hosted deploy always has both set, so this is a no-op there; a self-hosted deploy with device management not yet configured should have its sweep timer fire harmlessly instead of erroring every 5 minutes in the logs). Use the raw `process.env` reads here, matching how these two vars are read TODAY elsewhere in the codebase (`lib/vantra-link.ts:34`, `lib/device-tools.ts:29`) — Phase 2 of the full plan centralizes these into `lib/env.ts`, but that hasn't happened yet and is explicitly out of scope for this task.

## §5 — Verification (do this before committing, all of it)

1. `npx tsc --noEmit` — must be clean.
2. `npx eslint app/admin/(protected)/admin-panel.tsx app/admin/(protected)/page.tsx app/api/admin/payments/route.ts "app/api/admin/payments/[id]/approve/route.ts" "app/api/admin/payments/[id]/reject/route.ts" "app/api/admin/payments/[id]/retry-license/route.ts" app/api/admin/wallets/route.ts app/api/admin/ai/route.ts app/api/admin/ai-usage/route.ts app/api/admin/exe-licenses/route.ts app/api/admin/exe-trials/route.ts app/api/internal/payment-verify/route.ts app/api/internal/device-status-sweep/route.ts app/api/internal/device-onboarding-sweep/route.ts` — check against this repo's PRE-EXISTING lint errors first (there are some unrelated `react-hooks/set-state-in-effect` errors already in `admin-panel.tsx` before you touch it — run eslint on a clean checkout of the same file first if unsure whether a reported error is yours or pre-existing).
3. `npx tsx --test tests/*.test.ts` — must stay at the same pass count as before your change (222 as of this writing) plus any new tests you add; zero regressions.
4. **Real build verification, TWICE** — once with `SELF_HOSTED` unset, once with `SELF_HOSTED=true`, both via `CI=true NODE_ENV=production npm run build`. **Capture the exit code directly** (`npm run build; echo "EXIT:$?"` or redirect to a file with `> log 2>&1; echo $?` — do NOT pipe through `| tail` and trust that tail's own exit code, it lies about whether the command before it in the pipe actually succeeded — this cost real time earlier in this same task, a font-fetch transient failure was masked as a false "pass" this exact way). For the `SELF_HOSTED=true` build specifically, confirm: (a) it completes with a real `0` exit code, (b) hitting `/admin` in a quick local `next start` smoke-test (or just checking the generated page) never renders Payments/Wallets/AI/Licenses tab buttons, (c) `curl` (or equivalent) a couple of the gated routes directly (e.g. `POST /api/admin/wallets` with no other setup) and confirm a 404, not a 403 or a 500.
5. Commit with a clear message referencing this task, push to `origin/self-hosted-build` (never `main`), and update this file's status header at the top to reflect what's done — leave a clean handoff note for whoever (me, verifying; or the owner) picks this up next, same as how other `TASK_*.md` files in this repo track their own progress (see `TASK_127_DEVICE_SCREENSHOT_DAILY_SUMMARY.md`'s "Built 2026-09-27" section for the style: what shipped, what's still open, what a reviewer needs to know).

## Deferred / explicitly out of scope for this task (don't do these, they belong to a later phase)

- **Swapping "buy a license" UI copy for "activate your license" copy** — the plan's Phase 1 description mentions this, but it's deliberately deferred: there is no self-hosted license-activation wizard UI yet (that's Phase 5's `app/setup/**` work), so writing new copy now would just be replaced/thrown away later. `accountHref()` already stops pointing at our storefront (§1, done) — that's the part that actually matters for correctness right now.
- **The EXE trial-ping mechanism** (`app/api/exe-license/trial-start/route.ts`, `app/api/exe-license/status/route.ts`, `lib/hosted-fetch.ts`) — these call `HOSTED_APP_URL` directly for a silent 24h trial-eligibility check against our real server, a SEPARATE system from `accountHref()`. Found while implementing §1: a self-hosted build's license model (Phase 5 — perpetual or admin-issued time-bound, activated via its own offline wizard) doesn't need or want this hosted trial-ping round trip at all. Left untouched for now — flagging it here so whoever builds Phase 5 knows to also gate or replace this, not just add the new activation flow alongside a stale hosted-trial-ping path that would silently fail/hang in a self-hosted build with no route to `spaceworker.top`.
- Anything about `sw-rmm-core`, the RMM Engine app, WSL2, TRMM, MeshCentral, or the license scheme itself — those are Phases 3/4/5 of the full plan, not this task.

## Acceptance

- All of §2-§4 built, on `self-hosted-build`, pushed to `origin`.
- §5's verification steps all genuinely pass (real exit codes, not a masked pipe).
- A self-hosted build's `/admin` shows exactly 11 tabs (not 15); the 4 omitted areas' API routes 404 on direct request; `payment-verify` 404s outright; `device-status-sweep`/`device-onboarding-sweep` no-op cleanly (200, not an error) when the internal device-check-in service isn't configured, and are UNCHANGED (still run normally) when it is — confirm this last part by checking a hosted-style `.env` (both vars set) still lets these two sweeps behave exactly as before, no regression for the live app.
