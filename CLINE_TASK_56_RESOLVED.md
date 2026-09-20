# Task 56 is fixed — stop debugging it, here's what was wrong and what's done

You were right to distrust `app/proxy.ts` — it's genuinely dead code and always was. Here's the full picture so you don't have to re-derive it.

## What was actually wrong (two separate bugs, not one)

1. **`app/proxy.ts` is not Next.js 16's middleware file.** The real one must be at the repo root (`/opt/spaceworker/proxy.ts`, sibling to `next.config.ts`). Next gives no warning when you put one in the wrong place — it just silently never runs, forever. Confirmed via a grep: nothing in the codebase imports `app/proxy.ts`, and its cookie names (`sw_session`, `sw_admin`, `JWT_SECRET`) don't even match the real app's conventions (`spaceworker_session`, `SESSION_SECRET`) — it was never wired to anything.

2. **The admin-bypass check had a gap.** The maintenance logic (now correctly in the root `proxy.ts`) excluded `/admin/**` pages from the maintenance gate, but not `/api/admin/**` routes — so flipping `maintenanceModeWeb` on locked the admin out of `/api/admin/maintenance`, the one endpoint that turns it back off. I hit this live during verification (real, if brief, production outage) and had to hand-restore the DB row. Fixed: `isAdminPath` now checks both `/admin` and `/api/admin` prefixes.

## What I did

- Ported the maintenance logic from `app/proxy.ts` into the real root `proxy.ts`, merged correctly with the existing session-gate/license_only logic (nothing else in that file changed behavior).
- Deleted `app/proxy.ts`.
- Broadened `proxy.ts`'s matcher from `["/dashboard/:path*", "/admin/:path*", "/api/:path*"]` to `["/((?!_next/static|_next/image|favicon.ico).*)"]` — the old one never even reached `/`, `/pricing`, `/login`, which is part of why earlier tests looked like nothing was happening.
- Fixed the `/api/admin` exclusion gap above.
- Live-verified the whole thing end-to-end through the **real** `/api/admin/maintenance` route (not direct DB writes): web flag → `/`, `/pricing`, `/login`, `/dashboard` all correctly 503 with the maintenance page; `/admin` and `/api/admin/**` stay reachable; exeApi flag → exe-license routes correctly 503 `{maintenance:true}`; both off → full recovery. Both flags are `false` in production right now.
- Committed as `633af74` on `main`, already deployed and confirmed healthy on the VPS.

## One thing worth internalizing for future debugging on this repo

`.next/server/middleware-manifest.json` is **not reliable** in this Next.js version (16.2.9 + Turbopack) — it can read `"middleware": {}` even when a correctly-placed `proxy.ts` is genuinely executing. If you ever need to confirm proxy.ts is running, don't check that file — add a temporary `console.log` inside it, hit the route, and read `journalctl -u spaceworker.service --since '1 minute ago'`. This is now written into `HOW_WE_MOVE_FAST.md` §1a along with the other two lessons above (proxy's isolated-bundle cache behavior, and the `/admin` vs `/api/admin` prefix gap) — read that section before touching `proxy.ts` again on either this repo or Vantra's.

## What's left (not urgent, just flagging)

The nginx-level fallback (`error_page 502/503/504 → deploy/maintenance.html`, for the literal `systemctl restart` window when the process isn't listening at all) was deployed earlier but hasn't been re-verified with a timed restart in this pass. Not blocking — this is a separate, independent mechanism from what was just fixed — but worth a real test before calling Task 56 fully closed.

Move on to whatever's next in your queue — this one's done.
