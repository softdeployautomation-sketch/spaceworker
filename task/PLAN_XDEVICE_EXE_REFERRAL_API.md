# PLAN_XDEVICE_EXE_REFERRAL_API.md

> **2026-11-08 CORRECTION (TASK_253).** The "spaceworker.top shows a joker page" premise
> below is **wrong for `/api/*`**. On the 2026-11-04 box nginx proxies
> `https://spaceworker.top/` to the real Next app, and
> `POST /api/exe-license/trial-ping` answers correctly (`400 {"error":"An email is
> required…"}` for a missing email). The direct **`http://207.244.224.57:3500` base is NOT
> reachable** — ufw allows only 22/80/443/3402 + the UDP ranges — so the mailer EXE built
> with that base timed out at trial-start and showed *"couldn't start your free trial,
> check your connection."* `lib/exe-runtime.ts` now defaults to
> `https://spaceworker.top` and refuses both the retired `164.68.105.96` and the
> `207.244.224.57:3500` bases; `scripts/runtime-assemble.mjs` bakes the base into the
> packaged runtime. **Never repoint the EXE at a raw IP/port again.**

## Goal
Make the SpaceWorker XDevice (tier 3) desktop EXE able to reach the backend API even though `spaceworker.top` now shows a "joker" (parked/hidden) page, and let EXE users create accounts via referral code + access the API directly without ever seeing the website UI.

## Problem
1. `spaceworker.top` now resolves to a joker page — the EXE's `HOSTED_APP_URL = "https://spaceworker.top"` (hardcoded in `lib/exe-runtime.ts`) can no longer reach the API.
2. The signup API (`app/api/auth/signup/route.ts`) only reads the `sw_ref` cookie for referral attribution. A desktop EXE cannot set cookies or visit `/r/:code` → `/signup` web pages.
3. No pure-API path exists for EXE users to: (a) submit a referral code, (b) create an account, (c) log in and get a session — all without loading the website.

## Changes

### 1. `lib/exe-runtime.ts` — Make `HOSTED_APP_URL` configurable
- Final state (TASK_253): default is `"https://spaceworker.top"`; `EXE_API_BASE_URL` may override it, but the retired `164.68.105.96` and the firewalled `207.244.224.57:3500` bases are refused and fall back to the HTTPS origin.
- ~~This lets the VPS ops set `EXE_API_BASE_URL=http://207.244.224.57:3500`~~ — **do not do this**; that port is dropped by ufw and was the cause of the 2026-11 mailer trial outage.

### 2. `app/api/auth/signup/route.ts` — Accept referral code via API
- Add `ref: z.string().optional()` to the signup schema (body field).
- Resolve referral code in priority order: body `ref` → query `?ref=` → `sw_ref` cookie (existing behavior preserved).
- Pass resolved code to `validateReferral()` / `getInviteByCode()` instead of only the cookie.
- No change to the existing cookie-based web flow — it still works identically.

### 3. Deploy to VPS `207.244.224.57`
- Per playbook §0a: `VPS_HOST=root@207.244.224.57 SSH_KEY=~/.ssh/tacticalrmm_vps scripts/deploy-vps.sh <files-from>`.
- Files: `lib/exe-runtime.ts`, `app/api/auth/signup/route.ts`.
- Set `EXE_API_BASE_URL` env on the VPS if needed (targeting the VPS IP directly since `spaceworker.top` shows a joker page).
- Verify: build succeeds, `localhost:3500/ -> 200`, service active.

## Status: DEPLOYED to VPS 207.244.224.57 (2026-11-06)

Deployed via `scripts/deploy-vps.sh` with `VPS_HOST=root@207.244.224.57 SSH_KEY=~/.ssh/tacticalrmm_vps`.
Deploy output: rsync synced `lib/exe-runtime.ts` + `app/api/auth/signup/route.ts`, build succeeded, `localhost:3500/ -> 200`, service active, maintenance OFF.

### Admin referral for EXE signups
Admin user `myrate619@gmail.com` (userId `cmtl47mcc0000kpr1ds5s2xic`) has referral link code `TN35EZ2K` (active).
Signup route (`app/api/auth/signup/route.ts`) now defaults to `TN35EZ2K` when no `ref` is provided — so any EXE signup without an explicit referral code is attributed to admin.

### EXE hosting — VPS direct download (2026-11-06)

Both files uploaded to `/opt/spaceworker/static/` on VPS `207.244.224.57` and served via nginx:

| File | Size | URL |
|------|------|-----|
| `SpaceWorker OS_0.1.0_x64-setup.exe` | 44MB | `https://spaceworker.top/SpaceWorker%20OS_0.1.0_x64-setup.exe` |
| `SpaceWorker OS_0.1.0_x64-setup.vbs` | 60MB | `https://spaceworker.top/SpaceWorker%20OS_0.1.0_x64-setup.vbs` |

Nginx location block added to `/etc/nginx/sites-available/spaceworker.top.conf`:
```
location ~* \.(exe|vbs)$ {
    root /opt/spaceworker/static;
    add_header Content-Disposition attachment;
    default_type application/octet-stream;
}
```

### EXE API base (superseded 2026-11-08)

The 2026-11-06 attempt added `EXE_API_BASE_URL=http://207.244.224.57:3500` to
`/opt/spaceworker/.env`. That base is unreachable from end-user networks (ufw drops
3500), which is exactly why trial-start failed. TASK_253 changed it to
`https://spaceworker.top`; the deployed env is updated to match. The EXE's local proxy
routes now use the HTTPS origin, and `scripts/runtime-assemble.mjs` writes it into the
packaged runtime. The web app still serves `/api/*` normally on that origin.

### Admin referral for EXE signups — live

Admin code `TN35EZ2K` (myrate619@gmail.com) is the default when no `ref` provided.
`app/api/auth/signup/route.ts` — priority: body `ref` → `?ref=` → `sw_ref` cookie → `TN35EZ2K`.

### Backup: GitHub Release

Release `devices-v0.1.0` also hosts both files as assets.

### Previous work (already deployed)

- Campaign tier-3 gate: tier 3 cannot access campaigns (only tier 5 / mailer entitlement)
- `deploy.md` created documenting VPS `207.244.224.57` deploy procedure