# SpaceWorker Task 1 — Project Scaffold + Auth

**Read `PLAN.md` in this same directory first** for full context (architecture, data model, why decisions were made). This task builds the foundation everything else sits on — Tasks 2–5 all assume this exists.

## What to build

A new Next.js project, structurally identical in stack to the existing Vantra app at `/Users/mikeolab/vantra` (a working reference you should read from, not copy wholesale — this is a separate product with its own repo, database, and domain):

- Next.js 16.x (App Router), React 19, Tailwind v4, TypeScript 5, npm.
- Prisma + PostgreSQL, own fresh database (`spaceworker`), own dedicated Postgres role — zero shared tables or connections with Vantra's database.
- `import "server-only"` on any file holding secrets, same discipline as Vantra throughout.

## Patterns to copy from Vantra (adapt, don't share at runtime)

Read each of these in `/Users/mikeolab/vantra` and port the *pattern*, renamed/adapted for this product:

- **`lib/auth.ts`** — bcrypt password hashing (cost 12) + `jose` JWT session signing. Cookie name, issuer, and audience must all be distinct strings from Vantra's (`"vantra"`/`"vantra_session"`) so a session token from one product can never be mistaken for the other's, even in theory.
- **`lib/admin-auth.ts`** — shared-passcode admin panel, fails closed when the passcode env var is unset, constant-time comparison (`timingSafeEqual`), separate cookie/issuer/audience from the customer session (same "never interchangeable" discipline, one level down: admin vs. customer, on top of SpaceWorker vs. Vantra).
- **`proxy.ts`** — the Next.js 16 `proxy` convention (not the deprecated `middleware.ts`) gating `/dashboard/**` and `/admin/**` (or whatever the equivalent routes end up named here) behind their respective session cookies, verified with `jose` (Edge-safe).
- **`lib/rate-limit.ts`** — DB-backed IP rate limiting (`RateLimitEvent` table, `allowAndRecord`/`getClientIp`). Start with `signup`, `login`, `resend-code`, `verify` kinds, matching Vantra's exact rule shape (5/hr signup, etc.) as a sensible default.
- **`lib/email.ts`** (Resend) — **for this product's own transactional email only** (signup verification codes). Use a **separate Resend account/API key from Vantra's** — do not reuse Vantra's `RESEND_API_KEY`. This is a hard requirement, not a nice-to-have: Task 4's cold-outreach email sending must never touch this same account either (see Task 4 — it uses each *customer's own* SMTP, never this product's transactional sender).
- **`components/ui.tsx`, `components/modal.tsx`, `components/toast.tsx`** — copy these three files close to verbatim; they're pure presentational/interaction primitives with no Vantra-specific logic in them.
- The systemd + nginx + certbot deploy pattern already proven on the Contabo VPS (ask Claude for the exact unit-file template when this is ready to deploy — that part is infra, not app code).

## Prisma schema (this task's slice)

```prisma
model User {
  id                 String   @id @default(cuid())
  email              String   @unique
  passwordHash       String
  emailVerified      Boolean  @default(false)
  tier               Int      @default(0) // admin-settable only, see Task 3 — higher = higher queue priority
  createdAt          DateTime @default(now())
  verifications      VerificationCode[]
}

model VerificationCode {
  id         String    @id @default(cuid())
  userId     String
  user       User      @relation(fields: [userId], references: [id])
  codeHash   String
  expiresAt  DateTime
  consumedAt DateTime?
  attempts   Int       @default(0)
}

model RateLimitEvent {
  id        String   @id @default(cuid())
  ip        String
  kind      String
  createdAt DateTime @default(now())
  @@index([ip, kind, createdAt])
}

model AdminSetting {
  id        String   @id @default("singleton")
  updatedAt DateTime @updatedAt
  // Task 3/4/5 each add fields here (wallet addresses, alert debounce timestamps, etc.)
  // — keep this singleton-row pattern, don't create a second settings table later.
}
```

`User.tier` is included now (defaulted to 0) even though nothing reads it until Task 3, so later tasks don't need a schema migration just to add it.

## Routes for this task

`app/api/auth/{signup,verify,resend-code,login,logout}/route.ts` — same flow as Vantra's: signup creates an unverified user (rate-limited, bcrypt-hashed, no side effects beyond the DB row + a verification email), verify consumes a 6-digit code (rate-limited, capped attempts) and issues the session cookie, login/logout are what they say. No client/site provisioning step exists here (that was Vantra-specific, TRMM-related) — verification success just flips `emailVerified` and redirects to the dashboard.

Pages: `app/signup`, `app/login`, `app/verify`, `app/dashboard/layout.tsx` (auth gate: no session → `/login`, unverified → `/verify`), `app/dashboard/page.tsx` (placeholder — Task 2/3 fill this in with the actual extraction UI).

## Verification

1. Full signup → email received → verify → land on an authenticated (empty) dashboard.
2. Confirm rate limits actually trip (rapid repeated signup from one IP gets blocked, matching Vantra's proven behavior).
3. Confirm the admin passcode panel is reachable at whatever path you choose, and — critically — **fails closed** if the admin token env var is unset (returns "not configured," never falls open).
4. Confirm this app's session cookie and Vantra's session cookie coexist without collision if both are open in the same browser (different cookie names/issuers) — a quick manual check, not an automated test.
