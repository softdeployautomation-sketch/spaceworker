# Task 45 — Let EXE-only buyers see their license, without giving them the whole app for free

**Status: ready for Cline.** This replaces the "just add a magic sign-in link" idea I floated earlier — the owner correctly caught that a plain login fix would hand EXE-only buyers full access to the paid web product too. This task specs the fix that avoids that.

## The problem, precisely

Confirmed live, 2026-09-14: **lead extraction, campaigns, mailboxes, and the AI agent have NO tier gating at all** — any logged-in user, `tier: 0` ("Free") included, can already use all of them. The ONLY tier-gated feature in the whole app is the private browser session (`app/api/browser-sessions/route.ts`, `user.tier < 1` → 403 "Pro plan required"). An EXE buyer who never had a web account gets one auto-created for them (`findOrCreateUser` in `app/api/billing/submit/route.ts`, Task 42), with `tier` left untouched at its default (`0`). If they could log into that account today, they'd get the ENTIRE web product for free — exactly the leak the owner flagged.

## The fix: a genuinely restricted session, not a full one

New concept: a session can be **`"full"`** (everything that exists today, unchanged) or **`"license_only"`** (can see and manage their licenses, nothing else). Purely additive — every existing login/signup keeps producing a `"full"` session exactly as today; `"license_only"` is a NEW, narrower kind only ever issued by the license-claim flow below.

### 1. Extend the session payload

`lib/auth.ts`'s `SessionPayload` gains `scope: "full" | "license_only"`. `createSessionToken`/`verifySessionToken` carry it through (default to `"full"` if absent on an older token, so any session issued before this change keeps working unchanged). `setSessionCookie` (wherever that's defined — likely `lib/session.ts`) gains an optional `scope` param, defaulting to `"full"` — every EXISTING call site (login, signup, verify) needs zero changes.

### 2. The license-claim flow (the actual "let them see their key" fix)

A short-lived, single-use, signed claim token — same shape/discipline as the Telegram link tokens from Task 39 (`generateTelegramLinkToken`-style: crypto-random + embedded expiry, or a `VerificationCode`-style row) — included in the license-issued email (`lib/email.ts`'s `exeLicenseIssuedEmailHtml`) as a real link, e.g. `https://spaceworker.instaweb.top/api/exe-license/claim?token=...`.

That route:
- Resolves the token to the `ExeLicense`/`Payment`/`User` it belongs to (rejects expired/invalid/already-used tokens with a clear message, mirroring the Telegram webhook's exact-match discipline).
- **Only issues a `license_only` session if this user doesn't already have a `"full"`-worthy account** — i.e., they're exactly the inline-created buyer from `findOrCreateUser`, never had a real password, never signed up normally. If a currently-logged-in `"full"` session already owns this license (the "bought an EXE while already a real customer" case), this route is a no-op redirect to `/dashboard/licenses` — never downgrades an existing real session.
- Sets the cookie via `setSessionCookie({ sub, email, emailVerified: true, scope: "license_only" })` and redirects to `/dashboard/licenses`.

### 3. Enforce the restriction centrally — new `middleware.ts`

This app has no `middleware.ts` today (confirmed — everything gates itself per-route via `getSession()`/`getCurrentUser()`). Add one at the repo root, Next.js's standard convention, so this is enforced in ONE place instead of needing every current and future route to remember to check `scope` individually (the actual security property here depends on this being centralized, not opt-in per route):

- Read the session cookie, resolve `scope`.
- If `scope !== "license_only"`, do nothing (today's behavior, completely unchanged for every normal user).
- If `scope === "license_only"`, allow only an explicit allowlist: `/dashboard/licenses`, `/api/exe-license/*` (their own claim/license routes), `/api/settings/*` (so they CAN set a real password if they want to become a proper customer later — see item 4), `/login`, `/api/auth/logout`, `/`, `/pricing`, `/terms`, `/privacy`, static assets (`/_next/*`, favicon, etc.). Everything else — every other `/dashboard/*` page and every other `/api/*` route (jobs, campaigns, mailboxes, agent, automations, browser) — gets redirected to `/dashboard/licenses` (page requests) or a 403 JSON (`/api/*` requests).
- Write the matcher/config narrowly enough that this doesn't add meaningful latency to every request for the 99% of users who are `"full"` scope — a cheap cookie-read-and-branch, not a DB round trip, if `verifySessionToken` can resolve scope from the JWT alone (it should, since `scope` lives in the token payload itself, no DB lookup needed for the common `"full"` case).

### 4. The upgrade path — becoming a real customer

`lib/license-service.ts`'s `bumpWebTier` (the web-subscription approval branch) should ALSO upgrade a `license_only` user to `"full"` scope when they legitimately buy the web subscription — check the user's CURRENT session scope isn't something `handleApprovedPayment` can reach directly (it doesn't run in a request context), so this likely means: the NEXT time a `license_only` user logs in through the normal `/login` flow with a real password they've set (via `/api/settings/*`, already allowlisted above) after their `tier` has been bumped to `1`, `setSessionCookie` should check `user.tier >= 1` and issue `"full"` scope instead of assuming `license_only` forever. Concretely: the scope decision belongs in whatever code path calls `setSessionCookie` for a `license_only`-origin user — base it on `user.tier` at sign-in time (`tier >= 1` → `"full"`, `tier === 0` → `"license_only"`), not on a sticky flag that never changes. This means a `license_only` user who sets a real password (Settings, allowlisted) and later logs in normally, AFTER paying for the subscription, naturally gets promoted — no special-case code needed beyond "compute scope from tier at login time for this class of account."

## Explicitly out of scope

- Changing anything about the EXISTING `tier < 1` browser-session gate — orthogonal, unchanged.
- Retroactively restricting any CURRENTLY logged-in `"full"` session — this only ever narrows a brand-new session type going forward.
- A UI for "upgrade to unlock the full app" beyond a plain, honest message on `/dashboard/licenses` when scope is `license_only` (e.g. "Want the full web app too? Subscribe" linking to `/pricing`) — a real upsell-design pass can come later if this converts well.

## Verification expected

- `npx tsc --noEmit` / `npm run build` clean.
- Live: buy an EXE tier as a genuinely new email (no prior account), claim the license via the emailed link, confirm you land on `/dashboard/licenses` and CANNOT reach `/dashboard/extract`, `/dashboard/campaigns`, `/dashboard/automations`, or call `/api/jobs`/`/api/campaigns`/`/api/agent` directly (403/redirect) — this is the actual security property, verify it against the real API, not just by not seeing the nav link.
- Confirm a normal signup (`/signup` → `/verify`) still gets a `"full"` session and full access, completely unaffected.
- Confirm an ALREADY-logged-in real customer who buys an EXE while logged in keeps their existing full session untouched — the claim link is a no-op for them, never a downgrade.
- Confirm the upgrade path: bump that `license_only` user's `tier` to 1 (simulate a real web-subscription purchase), have them set a real password and log in again, confirm they now get `"full"` scope and full access.
