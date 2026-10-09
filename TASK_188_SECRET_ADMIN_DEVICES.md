# TASK_188 — Secret admin devices page (`/admin/device/101`) + deleted-devices subtab with restore/reassign

**Owner's words (verbatim, 2026-10-08):** *"I want to take out the device tab from the
admin page, and put it in a tab only me know, like /admin/device/101. And also the view
device button in the users tab as well. Also I want when every user deletes a device from
their devices, it should show in the new device page as deleted devices, so I can either
run command on them to recover to any user I choose."*

**Extracted from TASK_185 (P3 + P4 there — TASK_185 now only holds P5 + W9).**
**TRACKING (MANDATORY, step 0):** create `TASK_188_STEPS.md` immediately, model it on
`TASK_181_STEPS.md` / `TASK_185_STEPS.md`, update it after EVERY step. Playbook
**HOW_WE_MOVE_FAST.md** binding (§7 gates → §2/§3 deploy → §4 live evidence). NEVER
`git stash`; never edit `.env`; never commit `TASK_133_RMM_ENGINE_BRINGUP.md`; REJECT
commits/docs containing live secrets.

## WHAT EXISTS ALREADY (read before editing)

- `app/admin/(protected)/admin-panel.tsx`:
  - `:65` Tab union includes `"devices"` · `:72` tab button `{ id: "devices", label: "Devices" }`
  - `:227` `setTab("devices")` jump · `:231` `{tab === "devices" && <DevicesTab owner={deviceOwner} onOwnerChange={setDeviceOwner} />}`
  - `:652-660` UsersTab **"View devices →"** jump
  - `DevicesTab` component `:5910-~6460` (fetches `/api/admin/devices` or
    `/api/admin/users/[id]/devices`, run-command `:5972`, mesh-urls `:6018`, live
    session console `:6449`)
  - **Pre-existing eslint errors in this file — do NOT fix them; just don't add new ones.**
- API: `GET /api/admin/devices` (`app/api/admin/devices/route.ts`, self-asserts admin
  session) → `lib/admin-devices.ts listAdminDevices()` — check whether it filters
  `removedAt: null` (the user route does: `app/api/devices/route.ts:46`).
- Admin auth: `lib/admin-auth.ts` (`getAdminSession()`, cookie
  `spaceworker_admin_session`); guard pattern lives in `app/admin/(protected)/layout.tsx`
  — the new secret route is OUTSIDE `(protected)` and needs its own copy of the guard.
- Soft delete: user delete sets `removedAt` (`lib/vantra-link.ts removeDevice`; list
  drops the row client-side `components/device-list.tsx:683`). Sync NEVER clears
  `removedAt` — restore must clear it explicitly (TASK_185 P4 decision).


## SCOPE

### S1 — extract the Devices tab out of the admin panel
- [ ] Remove from admin-panel.tsx: `"devices"` Tab union member (`:65`), tab button
      (`:72`), `setTab("devices")` jump (`:227`), render (`:231`).
- [ ] Remove the **"View devices →"** jump in UsersTab (`:652-660`).
- [ ] Extract the whole `DevicesTab` into **`components/admin/devices-tab.tsx`**
      (self-contained, same props `{ owner, onOwnerChange }`, same API calls — pure
      move, no behavior change).

### S2 — the secret page `/admin/device/101`
- [ ] New route **`app/admin/device/101/page.tsx`** renders the extracted `DevicesTab`
      (owner state local to the page).
- [ ] Guard: copy the admin-session check from `app/admin/(protected)/layout.tsx` into
      a local layout or inline check: no valid `getAdminSession()` ⇒ redirect
      `/admin/login`. (APIs self-assert admin; the page guard is UX-only but required.)
- [ ] **Secrecy:** NO link to this URL anywhere (nav, dashboard, admin panel, footer,
      robots/sitemap). Confirm nothing lists it.

### S3 — deleted-devices subtab (inside the secret page)
- [ ] `GET /api/admin/devices?removed=1` (admin-only flag; DEFAULT response unchanged)
      → `listAdminDevices` returns soft-deleted rows (`removedAt != null`). **run-command
      and mesh-urls must work on deleted rows** — verify those routes don't filter
      `removedAt`; if they do, scope the filter so the Deleted view can operate them.
- [ ] UI: segmented control **Active | Deleted** in the secret page. Deleted rows show
      device, original owner email, `removedAt` date + **Recover** with a **user
      picker** (owner: *"recover to any user I choose"* — dropdown from the existing
      admin users list endpoint).

### S4 — restore/reassign endpoint (keep the commit separate from UI)
- [ ] New **`PATCH /api/admin/devices/[deviceId]/restore`** body `{ userId? }`: admin
      session required; sets **`removedAt: null` explicitly** (never relies on sync —
      P4 rule); when `userId` given, reassign owner (validate target user exists).
      Audit line per house convention if a pattern exists nearby (check how other admin
      mutations log), else NotificationLog.
- [ ] After restore: row leaves Deleted subtab and appears in the owner's device list
      (user route already filters `removedAt: null` — no change there).

### S5 — gates + deploy (playbook §7/§2)
- [ ] `npx tsc --noEmit` → 0. ESLint touched files → 0 NEW (stash A/B; admin-panel
      pre-existing errors are NOT yours).
- [ ] Tests: new `tests/admin-devices-secret.test.ts` (xdevice-route-gate style):
      restore → 403 without admin session; `removed=1` gated behind admin; restore
      clears `removedAt` + reassigns userId in fake-db; default list still excludes
      deleted rows; static locks that admin-panel.tsx no longer contains the devices
      tab entry or the "View devices →" jump. Regression: `test:devices` 6 ·
      `test:xdevice` 38 · `test:module-gate` · `test:wallet` 63 · `test:wrapper-cookie` 6.
- [ ] Deploy (house flow): fresh BUILD_ID, service active, site 200, repo↔box md5
      parity. Live evidence: `/admin/device/101` → redirect to `/admin/login` WITHOUT
      admin session, 200 WITH it; main admin panel has no Devices tab; a deleted device
      shows in Deleted subtab, run-command works, Recover restores to a chosen user
      (owner eyeball = final).

### S6 — admin site root moves to `/admin=topsecret6199` (owner directive, 2026-10-09)

**Owner's words (verbatim, 2026-10-09):** *\"I want to change the admin site to
/admin=topsecret6199\".*

- [ ] Rename the admin PAGE tree `app/admin/**` → `app/admin=topsecret6199/**`
      (the `(protected)` panel, its `layout.tsx` guard, `login/`, and the secret
      device page). Page URLs become `/admin=topsecret6199`,
      `/admin=topsecret6199/login`, … (API tree `app/api/admin/**` does NOT move —
      it is an API prefix, not the admin site).
- [ ] Update every code reference (inventory from research):
      `app/admin/(protected)/layout.tsx:17` `redirect("/admin/login")` ·
      `app/admin/(protected)/page.tsx:9` `redirect("/admin/login")` ·
      `components/admin/admin-login-form.tsx:29` `router.push("/admin")` ·
      `components/admin/admin-shell.tsx:30` `router.push("/admin/login")` + `:39`
      `Link href="/admin"` · `proxy.ts` (`pathname.startsWith("/admin")` `:224`,
      `pathname === "/admin/login"` `:231`, `loginPath` `:238`, comments, and the
      **matcher config** `"/admin/:path*"` `:274-277`).
- [ ] **Old `/admin` must die silently:** it 404s — NO redirect that would print
      the new path for anyone who guesses `/admin`. Old `/admin/login` likewise.
- [ ] Secrecy: `grep -rn "topsecret6199" app components lib proxy.ts` → only the
      route tree + the guard/login references that must name it; no nav, footer,
      sitemap, robots, or marketing link mentions it.
- [ ] Verify box-side config too (nginx `location /admin`, any deploy/docs
      script, `scripts/deploy-vps.sh`-adjacent greps) — nothing may keep serving
      the old path as an admin surface.
- [ ] Gates: `npx tsc --noEmit` 0 · eslint 0 NEW · static-lock test that
      `app/admin/` no longer exists and that `proxy.ts` gates the new prefix ·
      live: `/admin` → 404, `/admin=topsecret6199` → redirect to login without
      session, 200 with session; secret devices page reachable only with session.


No change to `/api/devices` (user list) semantics; no MeshCentral changes; no nav
changes elsewhere; Vantra agent keeps running on recovered devices (restore only flips
our soft-delete + ownership); NEVER hard-delete rows.

**VERIFICATION:** `PROMPT_VERIFY_TASK_188.md` — owner hands it to the verifier when the
implementer finishes; PASS/FAIL over S1–S5.
