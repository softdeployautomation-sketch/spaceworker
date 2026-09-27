# TASK_130 — Self-hosted Phase 2, part 2: first-run setup wizard

**Status: OPEN. Assigned to Cline.** Part 1 of Phase 2 (env centralization +
BYO AI provider) is done — see `lib/env.ts`, `lib/ai-provider.ts`, and the
commit `499dcc9` ("Self-hosted Phase 2 (part 1)...") on this branch. This task
is the rest of Phase 2: the mandatory first-run wizard a self-hosted customer
walks through before the app is usable.

**Branch discipline**: work from `origin/self-hosted-build` (already has part
1 — pull it first, don't rebase on a stale local copy). Never merge to
`main`. Push back to `self-hosted-build` only. Full context: the plan file at
`/Users/mikeolab/.claude/plans/transient-moseying-tome.md` (Phase 2), and
`TASK_129_SELF_HOSTED_BUILD_FLAG.md` (Phase 1, already shipped) for the
`isSelfHosted()` pattern this all builds on.

Owner has since confirmed (2026-09-27): for now this is for **personal use**,
not resale — so the TacticalRMM white-label/licensing question (a real,
documented blocker if this were ever sold to outside customers — see the
Phase 0 findings folded into the plan) does not block this task. Build
Phase 2 as scoped below regardless of that question's eventual resolution.

## The one architectural wrinkle you must respect

`lib/env.ts` builds its exported `env` object **once, at module import time**
(`export const env = {...}`), and several fields (`databaseUrl`,
`sessionSecret`, `resendApiKey`, `appBaseUrl`) are `required(...)` — they
**throw and crash the process at boot** if unset. That means:

- A self-hosted install cannot possibly boot far enough to *serve* a wizard
  page unless `DATABASE_URL`, `SESSION_SECRET`, `RESEND_API_KEY` (or an
  equivalent non-throwing default — see below), and `APP_BASE_URL` are
  already present in the environment **before Next.js starts**. Getting
  those four set is a **native installer concern** (Phase 6 — the Tauri
  shell's first-run flow writes an initial `.env` before ever spawning the
  Node server), explicitly **out of scope for this task**. Do not try to
  make the in-app wizard collect these four — it physically cannot run
  before they exist.
- Everything this wizard DOES collect (license key, RMM Engine connection
  URL/token, AI provider key, email/Telegram settings) is written to a local
  JSON state file (pattern below), not directly into `process.env` — the
  running Node process can't rewrite its own already-evaluated `env` object
  live. **Applying a change requires a process restart.** For this task,
  that's fine: write the value, tell the user a restart is needed, and (best
  effort) also append/update `.env.local` in the project root so a manual or
  Tauri-orchestrated restart picks it up automatically. Wiring an *automatic*
  restart from inside the wizard is a Tauri/Rust-side concern (Phase 6,
  separate task) — don't attempt it here.
- `RESEND_API_KEY` specifically: a self-hoster may not have Resend at all.
  Confirm with a quick read of `lib/env.ts`'s `requiredSecret("RESEND_API_KEY")`
  call and `lib/notify.ts`'s email path before assuming it's mandatory forever
  — if it's genuinely hard-required today, note that as a followup for
  whoever handles Phase 6's installer (may need a "no email, disable digest
  emails" self-hosted default), but do NOT loosen `lib/env.ts`'s required()
  calls yourself as part of this task — that's Phase 6/installer scope, and
  loosening a `required()` used by the hosted SaaS too is exactly the kind of
  change that needs its own careful review.

## 1. Local setup-state file (new: `lib/self-hosted-setup-state.ts`)

Model this **exactly** on `lib/license-state.ts`'s existing pattern (already
in the repo, read it first): same `SPACEWORKER_LOCAL_DATA_DIR` override, same
per-OS app-data fallback path (swap the filename to
`self-hosted-setup-state.json`), same `mkdir`+`readFile`/`writeFile` shape,
same `version: 1` envelope.

```ts
export interface SelfHostedSetupState {
  version: 1;
  completedAt?: string; // ISO — presence = wizard has been completed at least once
  license?: { key: string; validatedAt: string };
  rmmEngine?: { url: string; token: string; testedAt: string };
  aiProvider?: { configured: boolean; baseUrl?: string; model?: string; testedAt: string };
  email?: { configured: boolean };
  telegram?: { configured: boolean };
}
```

Never store the raw AI/RMM Engine/Telegram secret values in this JSON file
in plaintext readable by any UI response — this file is server-side only
(same trust boundary as `exe-license-state.json`), but still: don't echo
secrets back in API responses once saved (return `{ configured: true }`
shapes, not the value).

## 2. Setup pages (`app/setup/**`)

Gated: only reachable/meaningful when `isSelfHosted()` is true (import from
`@/lib/exe-build-target`, the Phase 1 flag). On a **non**-self-hosted (our
own hosted SaaS) build, `/setup` should 404 or redirect to `/dashboard` —
this must never appear for our own hosted customers.

Six steps, single-page wizard with step state (client component + a
`currentStep` query param or local state is fine — no need for a multi-route
structure unless you find one cleaner):

1. **License activation** (mandatory, no skip). Text input for the license
   key. "Activate" button calls a new API (below) that runs
   `validateLicenseKey` (`lib/exe-license-validator.ts` — already exists,
   generic/offline, no changes needed there) against the key using
   `EXE_LICENSE_SECRET` from `lib/env.ts` (add `exeLicenseSecret` there if
   not already exported as a plain accessor — check first, it may already be
   read raw at exe-license route call sites). On success, write
   `license: { key, validatedAt }` to the setup-state file. On failure, show
   the validator's own `.error` string — don't invent a different message.
2. **Database** — informational only in THIS task (per the wrinkle above:
   `DATABASE_URL` is already set or the page wouldn't be running). Show the
   currently-connected database's identity (e.g. run a trivial `SELECT 1` or
   read `env.databaseUrl`'s host/db-name portion, never the password) so the
   owner can confirm "yes, this is the right DB" — no "change it here" UI in
   this task.
3. **RMM Engine connection** (device management) — two fields: connection
   URL + token (these map directly to `VANTRA_INTERNAL_URL`/
   `VANTRA_INTERNAL_TOKEN` — internal names, never surfaced in the UI copy;
   call them "RMM Engine URL" / "RMM Engine token" in the UI). "Test
   connection" button hits a new API that does a live fetch against
   `<url>/api/internal/sw/orgs` (or any cheap authenticated GET already
   defined on that surface — check `lib/vantra-link.ts` /
   `lib/device-tools.ts` for the lightest existing call) using the
   entered token as Bearer, and reports success/failure — do NOT persist
   anything until the test succeeds. On success, write to the setup-state
   file AND best-effort append to `.env.local` (`VANTRA_INTERNAL_URL=`,
   `VANTRA_INTERNAL_TOKEN=`) so a restart picks it up; show a "restart
   required for device management to activate" notice. This step is
   explicitly **skippable** (a checkbox "set this up later from Admin →
   Infrastructure" — check whether that admin tab already has a place for
   this; if not, note it as a gap but don't build the admin-side UI in this
   task, that's separate scope).
4. **AI provider key** — field for `AI_PROVIDER_API_KEY`, optional fields
   for base URL/model (defaults already in `lib/env.ts`:
   `https://api.openai.com/v1` / `gpt-4o-mini`). "Test" button calls
   `aiProviderChat` (`lib/ai-provider.ts`, already built) with a trivial
   prompt (e.g. `{ user: "Say OK.", max_tokens: 5, external_user_id: "setup-wizard-test" }`)
   and reports the mapped `AiProviderError.code`/message on failure.
   Skippable via an explicit "I understand AI features will be disabled"
   checkbox — do not let Next continue without either a successful test OR
   that checkbox checked.
5. **Email (Resend) / Telegram** — same skippable pattern; a "Test" action
   for whichever notify channel already has one (check `lib/notify.ts` /
   the existing admin settings test-connection routes for a pattern to
   reuse rather than inventing a new one).
6. **Final review** — list every value about to be saved (mask secrets,
   e.g. `sk-••••1234`), one "Confirm and finish setup" button that writes
   `completedAt` to the setup-state file. This is the single point where
   everything collected in steps 1–5 is actually persisted/appended to
   `.env.local` (steps 3–5's own "Test" actions should NOT silently persist
   before this final confirm — hold each tested value in wizard-local React
   state until this step, matching the plan's "deliberate friction" intent:
   nothing is written until this explicit final confirmation).

## 3. APIs (`app/api/setup/**`)

- `POST /api/setup/license/validate` — body `{ licenseKey }`, runs
  `validateLicenseKey`, returns the validation result (never the raw
  secret).
- `POST /api/setup/rmm-engine/test` — body `{ url, token }`, live-tests the
  connection (see step 3 above), returns `{ ok, error? }`.
- `POST /api/setup/ai-provider/test` — body `{ apiKey, baseUrl?, model? }`,
  calls a variant of `aiProviderChat` using the SUBMITTED values (not
  `env.aiProviderApiKey`, which won't be set yet) — you'll need a small
  overload/parameter on `aiProviderChat` or a thin duplicate that accepts an
  explicit key/baseUrl/model instead of reading `env` directly; prefer
  refactoring `lib/ai-provider.ts` to accept an optional override object
  over duplicating the whole file.
- `POST /api/setup/complete` — body carrying everything collected across
  steps 1–5; validates nothing is missing except explicitly-skipped optional
  steps; writes the setup-state file's `completedAt`, best-effort appends to
  `.env.local`, returns `{ ok, restartRequired: true }`.

All setup APIs must **also** early-return 404 when `!isSelfHosted()` — same
discipline as `TASK_129`'s admin-route guards. No session/auth check needed
on these routes (there IS no user session yet at first run) — but consider:
once `completedAt` is already set, these routes (especially
`/api/setup/complete`) should require an existing admin session to prevent
a random unauthenticated visitor from re-running setup on an already-live
instance. Gate re-entry: if `completedAt` exists AND the requester has no
valid admin session (`getAdminSession()`/`requireAdminSession()` from
`lib/admin-auth.ts`), 403 instead of re-running.

## 4. Gate: unconfigured self-hosted install redirects to `/setup`

In `proxy.ts` (read it fully first — it already has a similar precedent in
the `license_only` scope-allowlist logic near the top of the file): when
`isSelfHosted()` is true and the setup-state file has no `completedAt`,
redirect every request EXCEPT `/setup/**`, `/api/setup/**`, and Next's own
static asset paths (`/_next/**`, favicon, etc.) to `/setup`. Mirror the
existing allowlist-array style (`LICENSE_ONLY_ALLOWED_PAGE_PREFIXES`) rather
than inventing a different pattern. Reading the setup-state file from
`proxy.ts` (Edge-ish middleware context) may need a Node-only check —
confirm `proxy.ts`'s existing runtime (it already imports `jose`/cookie
logic, so it's likely already Node-runtime, not edge-runtime; if it turns
out to be edge-runtime and can't do `fs.readFile`, use a lightweight
in-memory cached flag refreshed via a tiny API call instead — check before
assuming either way).

## 5. Verification

- `npx tsc --noEmit`, `npx eslint <changed files>` — zero new errors (warn
  parity, same discipline as TASK_129).
- New tests for: `validateLicenseKey` wiring through the new route (mock the
  HMAC secret), the RMM Engine/AI-provider test endpoints' success/failure
  paths, and the `proxy.ts` redirect gate (self-hosted + incomplete → `/setup`;
  self-hosted + complete → passes through; non-self-hosted → `/setup` 404s
  or redirects away, whichever you implement).
- **Exit-code warning** (learned the hard way earlier this project): never
  check a command's exit code through a pipe whose last stage is `tail`/
  `head`/`grep` — that reports the PIPE's last command's exit code, not the
  one you're checking. Redirect to a file and check `$?` directly with no
  trailing pipe: `npm run build > logfile 2>&1; echo "EXIT:$?"`.
- Two real production builds (`SELF_HOSTED=true` and without), following
  `TASK_129`'s §5 verification pattern for the full required-env-var list
  needed to get `next build` to actually complete (it's a long list —
  `DATABASE_URL`, `APP_BASE_URL`, `EMAIL_FROM`, `SESSION_SECRET`,
  `RESEND_API_KEY`, `MAILBOX_ENCRYPTION_KEY` (valid hex!),
  `EXE_LICENSE_SECRET`, `BROWSER_SERVER_TOKEN`, `BROWSER_SERVER_URL`,
  `INTERNAL_BEARER_TOKEN`, `BROWSER_PROFILE_BASE_DIR`,
  `SPACEWORKER_LOCAL_DATA_DIR` — all of these were needed to get a clean
  build in this session; don't assume a shorter list works).
- Manual smoke test (real `next start`, not just build): confirm a
  self-hosted build with no setup-state file redirects everything to
  `/setup`; confirm completing the wizard (mock RMM Engine/AI endpoints or
  skip them) lets subsequent requests through; confirm a non-self-hosted
  build never shows `/setup` at all.

## Deferred / explicitly out of scope for this task

- Writing `DATABASE_URL`/`APP_BASE_URL`/`SESSION_SECRET`/`RESEND_API_KEY` —
  native installer concern (Phase 6).
- Automatic process restart after wizard completion — Tauri/Rust
  orchestration (Phase 6).
- The admin panel's "Infrastructure" tab RMM Engine connection editor for
  post-setup changes (skippable step 3 mentions this as a future landing
  spot — don't build it now).
- Loosening any `lib/env.ts` `required()`/`requiredSecret()` call.
- Everything in Phases 3–6 of the plan (sw-rmm-core extraction, the RMM
  Engine app itself, the flexible-term license admin UI, the build
  pipeline).
