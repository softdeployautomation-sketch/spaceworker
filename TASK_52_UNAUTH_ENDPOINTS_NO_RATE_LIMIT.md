# Task 52 — Two unauthenticated write endpoints have no rate limit: `billing/submit` (EXE path) and `exe-license/trial-ping`

**Status: ready to build. Found during a security audit, 2026-09-20.**

## The real gap, confirmed live in code (not assumed)

`lib/rate-limit.ts` defines rate limiting for `signup`, `login`, `resend-code`, `verify`, `admin-login`, `change-password`, `exe-password-login`. Two other endpoints that accept unauthenticated input and write to the database have no entry here and call `allowAndRecord` nowhere:

**1. `app/api/billing/submit/route.ts`** — for `product.kind === "exe"` (lines 71–85), no session is required at all: a bare syntactically-valid email is enough. `findOrCreateUser(email)` creates a new `User` row on demand (line 83). A `txHash` is optional (lines 52–53, 142–147) — when omitted, the payment is created with `status: "pending"` and a `PaymentVerificationAttempt` row noting "awaiting manual review," with zero on-chain check performed. A script can therefore create unlimited `User` + `Payment` rows with fabricated emails and no transaction hash, each one landing in the admin's manual-review queue (the Payments tab) with no rate limit stopping it. This is a straightforward way to flood the admin's own review queue and grow the `User`/`Payment` tables indefinitely.

**2. `app/api/exe-license/trial-ping/route.ts`** — intentionally unauthenticated (the EXE has no web session, per its own comment at lines 18–22), and by design "low-stakes" since it only logs trial activity, never grants access. But `machineId`, `product`, `trialStartedAt`, and `machineLabel` are all attacker-controlled with only basic Zod shape validation (non-empty strings, valid date) — no rate limit, no cap on distinct `machineId` values per IP. This is exactly the endpoint that feeds the admin's new "active trial devices" visibility tab (built this session specifically so the admin could see trial usage) — an attacker can trivially spam it with random `machineId`s to (a) grow the `ExeTrialSession` table unbounded, and (b) pollute that exact admin visibility view with junk rows, undermining the feature's purpose.

## The fix

1. Add a `"billing-submit"` `RateLimitKind` (IP-based, generous but real — e.g. 10/hour) applied to `billing/submit`'s no-session EXE path specifically (the web-subscription path already requires a session, so it's lower risk, but consider covering both for consistency).
2. Add a `"trial-ping"` `RateLimitKind` (IP-based) to `exe-license/trial-ping` — since the upsert key is `(machineId, product)` and legitimate traffic is one ping per real device roughly once per session, a modest per-IP cap (e.g. 20/hour) comfortably covers real usage while blocking a spam script.
3. Consider requiring `billing/submit`'s no-session EXE path to at minimum verify the email isn't obviously junk (already-used throwaway-domain heuristics are optional/lower priority — the rate limit is the load-bearing fix here).

## Verification expected

- Script 20+ rapid `trial-ping` calls with random `machineId`s from one IP; confirm it gets rate-limited well before the admin's trial-visibility tab fills with junk.
- Script repeated no-session `billing/submit` EXE-path calls with fabricated emails; confirm rate limiting kicks in and the Payments admin queue doesn't grow unbounded from a single source.
