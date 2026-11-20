# TASK_258-S03 — Rate Limiting on Auth Endpoints

**Goal:** Add brute-force / rate limiting protection to MainStreet Shield auth endpoints so an attacker cannot spam login/signup/password-change attempts.

**Repo:** `/Users/mikeolab/mainstreet-shield`

**Status:** READY FOR CLINE

---

## 1. CURRENT STATE (deep trace)

| Endpoint | File | Current protection |
|----------|------|-------------------|
| `POST /api/auth/login` | `app/api/auth/login/route.ts:13-71` | None — unlimited attempts per IP |
| `POST /api/auth/signup` | `app/api/auth/signup/route.ts:17-219` | None — unlimited attempts per IP |
| `POST /api/auth/settings/password` | `app/api/auth/settings/password/route.ts` | None — unlimited attempts per IP |
| Middleware | `middleware.ts` | Explicitly excludes `/api/*` (line 74 matcher) — rate limiting MUST be in route handlers |

No rate limiting exists anywhere. `lib/rate-limit.ts` does not exist.

## 2. DESIGN DECISIONS

- **In-memory rate limiter** (`lib/rate-limit.ts`) using a `Map` keyed by `ip:endpoint`. Single VPS instance, no Redis needed.
- **Sliding window**: track timestamps of requests, evict entries older than window.
- **IP extraction**: `x-forwarded-for` header (first entry), fallback `x-real-ip`, fallback `"unknown"`.
- **Response on limit exceeded**: HTTP 429 with `Retry-After` header and JSON body `{ error: "rate limited", retryAfter: <seconds> }`.
- **Config**: Login: 5 per IP per 15 min. Signup: 3 per IP per 15 min. Password change: 5 per IP per 15 min.
- **No schema change, no migration** — pure code addition.

## 3. FILES TO CHANGE (4)

| # | File | Lines | Change |
|---|------|-------|--------|
| 1 | `lib/rate-limit.ts` | NEW | In-memory sliding-window rate limiter |
| 2 | `app/api/auth/login/route.ts` | ~13-20 + POST handler | Import rate limiter, extract IP, check → 429 |
| 3 | `app/api/auth/signup/route.ts` | ~17-25 + POST handler | Import rate limiter, extract IP, check → 429 |
| 4 | `app/api/auth/settings/password/route.ts` | ~1-10 + POST handler | Import rate limiter, extract IP, check → 429 |

## 4. RAW CODE — FILE BY FILE

### File 1 — `lib/rate-limit.ts` (NEW)

```ts
// lib/rate-limit.ts — in-memory sliding-window rate limiter
// Single VPS instance; no Redis. State lost on restart (acceptable).

interface WindowEntry {
  timestamps: number[];
}

const stores = new Map<string, WindowEntry>();

function nowMs(): number {
  return Date.now();
}

function getClientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    return xff.split(",")[0].trim();
  }
  const realIp = req.headers.get("x-real-ip");
  if (realIp) {
    return realIp.trim();
  }
  return "unknown";
}

export function createRateLimiter(windowMs: number, max: number) {
  return (req: Request, endpointKey: string) => {
    const ip = getClientIp(req);
    const storeKey = `${ip}:${endpointKey}`;
    const now = nowMs();

    let entry = stores.get(storeKey);
    if (!entry) {
      entry = { timestamps: [] };
      stores.set(storeKey, entry);
    }

    entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);

    if (entry.timestamps.length >= max) {
      const oldest = Math.min(...entry.timestamps);
      const retryAfterSeconds = Math.ceil((oldest + windowMs - now) / 1000);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, retryAfterSeconds),
      };
    }

    entry.timestamps.push(now);
    return {
      allowed: true,
      remaining: max - entry.timestamps.length,
      retryAfterSeconds: 0,
    };
  };
}

setInterval(() => {
  const now = nowMs();
  for (const [key, entry] of stores.entries()) {
    entry.timestamps = entry.timestamps.filter((t) => now - t < 60 * 60 * 1000);
    if (entry.timestamps.length === 0) {
      stores.delete(key);
    }
  }
}, 5 * 60 * 1000);
```

### File 2 — `app/api/auth/login/route.ts`

**Add after line 4 (after zod import):**
```ts
import { createRateLimiter } from "@/lib/rate-limit";

const loginRateLimit = createRateLimiter(15 * 60 * 1000, 5);
```

**In POST handler, after extracting email/password (line 26), before user lookup:**
```ts
    const ipCheck = loginRateLimit(req, "login");
    if (!ipCheck.allowed) {
      return NextResponse.json(
        { error: "Too many login attempts. Try again later." },
        { status: 429, headers: { "Retry-After": String(ipCheck.retryAfterSeconds) } }
      );
    }
```

### File 3 — `app/api/auth/signup/route.ts`

**Add after line 11 (after referral imports):**
```ts
import { createRateLimiter } from "@/lib/rate-limit";

const signupRateLimit = createRateLimiter(15 * 60 * 1000, 3);
```

**In POST handler, after extracting body fields (line 39), before referral gate:**
```ts
    const ipCheck = signupRateLimit(req, "signup");
    if (!ipCheck.allowed) {
      return NextResponse.json(
        { error: "Too many signup attempts. Try again later." },
        { status: 429, headers: { "Retry-After": String(ipCheck.retryAfterSeconds) } }
      );
    }
```

### File 4 — `app/api/auth/settings/password/route.ts`

**Add after imports:**
```ts
import { createRateLimiter } from "@/lib/rate-limit";

const passwordRateLimit = createRateLimiter(15 * 60 * 1000, 5);
```

**In POST handler, after session check, before password validation:**
```ts
    const ipCheck = passwordRateLimit(req, "password-change");
    if (!ipCheck.allowed) {
      return NextResponse.json(
        { error: "Too many password change attempts. Try again later." },
        { status: 429, headers: { "Retry-After": String(ipCheck.retryAfterSeconds) } }
      );
    }
```

## 5. ACCEPTANCE CRITERIA

| ID | Criterion | Test |
|----|-----------|------|
| AC-1 | `tsc --noEmit` = 0 | `cd /Users/mikeolab/mainstreet-shield && npx tsc --noEmit` |
| AC-2 | Login 5th attempt within 15 min → 429 | Live: POST /api/auth/login 5 times quickly, 6th returns 429 |
| AC-3 | Signup 3rd attempt within 15 min → 429 | Live: POST /api/auth/signup 3 times quickly, 4th returns 429 |
| AC-4 | Password change 5th attempt within 15 min → 429 | Live: POST /api/auth/settings/password 5 times quickly, 6th returns 429 |
| AC-5 | 429 response includes `Retry-After` header | Live check headers on 429 |
| AC-6 | Different IPs not affected by one IP's limit | Live test from two different IPs |
| AC-7 | After window expires, requests allowed again | Documented; not tested live |
| AC-8 | No secrets committed | `git diff` + grep clean |
| AC-9 | `prisma validate` passes (no schema change) | `npx prisma validate` |

## 6. LINKAGE TO MASTER PLAN

- **Master plan:** `task/TASK_258_MAINSTREET_ARCHITECTURE_RESTRUCTURE.md` — Phase 0, S0-3
- **Status:** Mark S0-3 as DONE with commit SHA when complete
- **Progress log:** Update `task/TASK_258_PLAN.md` (mainstreet-shield) before/after

## 7. RULES FOR CLINE

1. **NO DEPLOY** — Deploy is owner's decision only.
2. **NO `prisma migrate`/`db push`/schema change** — pure code addition, no DB changes.
3. **`npx tsc --noEmit` must equal 0** before you report.
4. **Never print/commit `.env`, `SESSION_SECRET`, or any keys.**
5. **Do not touch:** middleware `/signup ?ref` stamping semantics, `app/r/[code]/route.ts` cookie attrs, `ReferralLink @@map`, mainstreet proxies.
6. **Do not change `middleware.ts`** — it excludes `/api/*`; rate limiting lives in route handlers.
7. **Work S0-3 only.** Do not start S0-8 or other sub-tasks.
8. **Per HOW_WE_MOVE_FAST.md §2:** Never start a production deploy without asking the owner first.
9. **Confirm before deploying** — the owner will trigger the deploy workflow after you report done.

---

**Next:** Hand off to cline for implementation.