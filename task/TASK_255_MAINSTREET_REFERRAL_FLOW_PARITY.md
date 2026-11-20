# TASK_255 — MainStreet Shield referral / signup / login parity with SpaceWorker

**Role split (binding):** the **Task Agent (Cline) writes the code**. The **Senior Verification Agent
plans (this file), hands off, then verifies**. No code was edited by the planner — every finding below
was read from source or probed live.
**Plan written:** 2026-11-20 (BEFORE state). Update the **PROGRESS LOG** at the bottom AFTER every step.

**Owner's ask (verbatim intent):** *"the same flow we have working already in spaceworker — ref
generation, full signup and login system works — we can just replicate that and see the gaps both in
backend and UI."* Plus the 3 open bugs in the bug report (link → dashboard, copy button navigates,
referral column null).

**Repos:**
| Repo | Path | Remote | Deploy |
|---|---|---|---|
| SpaceWorker | `/Users/mikeolab/spaceworker` | `softdeployautomation-sketch/spaceworker` | `gh workflow run 'Build & Deploy'` (dispatch only) |
| MainStreet Shield | `/Users/mikeolab/mainstreet-shield` | `softdeployautomation-sketch/mainstreet-shield` | `gh workflow run deploy.yml -R softdeployautomation-sketch/mainstreet-shield` (rsync `--delete` with `.env`/`.next`/`node_modules` excluded, then `npm ci` + `prisma generate` + `npm run build` + `systemctl restart mainstreet-shield`) |

**Reference implementation to copy from (SpaceWorker, working):**
`lib/referral.ts` · `app/r/[token]/route.ts` · `app/api/auth/set-referral-cookie/route.ts` ·
`app/api/auth/signup/route.ts` (F8 gate + ordering) · `app/signup/page.tsx` · `app/login/page.tsx` ·
`components/auth-form.tsx` (client fetch + `router.push`) · `app/api/admin/referrals/route.ts` ·
`app/admin=…/admin-panel.tsx` copy pattern (`copyToClipboard` from `@/lib/clipboard`, already imported).

**VPS (read-only unless deploying):** `ssh -i ~/.ssh/tacticalrmm_vps root@207.244.224.57`
· MainStreet app `/opt/mainstreet-shield`, service `mainstreet-shield.service`, `next start -p 3000`,
nginx vhost `sites-enabled/mainstreet-shield` → `127.0.0.1:3000` · DB `mainstreet_shield`
(`sudo -u postgres psql -d mainstreet_shield`).
🚦 **Deploy only on the owner's explicit GO** (playbook §2 deploy-coordination rule), and only from
`main` — never from an unmerged branch.

---

## 1. Verified BEFORE state (evidence, 2026-11-20)

| Probe | Result |
|---|---|
| `curl -L 'https://mainstreetmint.click/signup?ref=85b274af…c333'` (anon, no cookies) | **200**, `<title>Apply for Access — MainStreet Shield</title>` — the gate/middleware is NOT broken for a clean browser |
| Live SpaceWorker BUILD_ID `gOq_0EAmyOAXp8ye2sE3l` (2026-11-20 06:58), built chunk grep | `Copy Signup Link` present · **`Users & Tiers` absent** · **`referralLink` 0 hits** in the admin-panel chunk → the deployed panel has **no** subtabs and never reads a referral code |
| MainStreet BUILD_ID `LJ4zbYqFTLK9aEspA78DN2` (2026-11-20 08:11), box rsync 08:08 | local `main` ≈ box |
| `mainstreet_shield` DB | `User` **7** · `referrallink` **0** · `Referral` **9** · `SignupInvite` **8** · `PendingSignup` **7` → **every user's `referralLink` is null (Bug #3), and all 9 admin codes live in `Referral`/`SignupInvite`, not in `referrallink`** |
| SpaceWorker `app/api/admin/mainstreet/` | only `invites/`, `tier/`, `users/` — **`referrals/` does not exist** (the panel calls it anyway → silent 404) |
| MainStreet `app/login/page.tsx:66` form → `POST /api/auth/login` which does `await req.json()` | **every browser login returns 500** (form posts urlencoded, not JSON) |
| MainStreet `app/api/auth/signup/route.ts` | creates the `User` **before** validating the code, and has **no** "referral required" gate at all |

**Conclusion:** the bugs are real, but not where the report guessed. The middleware is fine; the
breaks are (a) session redirect on `/signup`, (b) three mutually inconsistent code validators, (c) the
signup route's missing gate + wrong ordering + ReferralLink-only lookup, (d) the login route's
JSON-only body, (e) `referrallink` never being written (0 rows), and (f) the SpaceWorker admin UI
column/copy button/dead fetch.

---

## 2. THE GAPS — exact fix for each (this is the task)

### A. Backend — MainStreet Shield (the core)

**G1 — ONE combined access gate.** Today there are **three** different notions of a valid code:
- `lib/referral.ts` `hasAccessGate()` → **`ReferralLink` only** (used by `/login`)
- `app/signup/page.tsx:125-133` local `hasAccessGate()` → **`Referral` only** (used by `/signup`)
- `app/api/admin/referrals/validate/route.ts:14-21` → **`Referral` only** (used by `middleware.ts`
  for both `/r/*` and `/signup?ref=`)

**FIX:** make `lib/referral.ts` export exactly SpaceWorker's semantics —
`hasAccessGate(code)` = *valid active `ReferralLink` **OR** active, unused, unexpired `SignupInvite`
**OR** `Referral` with `status === "pending"`* — and make **every** caller use that one function:
- delete the local `hasAccessGate` in `app/signup/page.tsx` and import from `@/lib/referral`
- rewrite `app/api/admin/referrals/validate/route.ts` to return `{valid}` from `hasAccessGate(code)`
  (keep it unauthenticated; it is a pure lookup)

**G2 — `/r/:code` must accept a user's own link.** `middleware.ts:22-39` intercepts `/r/*`, validates
against `Referral` **only**, then redirects. A user's own 8-char `ReferralLink` code is not in
`Referral` → **every personal share link bounces to `/`**, and `app/r/[code]/route.ts` (which is
correct: ReferralLink → invite → cookie → `/login`) **never runs**.
**FIX:** in `middleware.ts`, replace the whole `/r/` branch with `return NextResponse.next()` and let
`app/r/[code]/route.ts` own it (it already stamps `sw_ref` with `httpOnly/secure/sameSite=lax/maxAge=30d`
and 302s to `/login`, matching SpaceWorker's regression pin 6). Do not delete the route.

**G3 — `/signup?ref=` gate must use the combined validator.** `middleware.ts:46-74`: after G1, the
`?ref` branch already validates + stamps the cookie + `next()`. Keep it; only the validator changes.
Also fix `middleware.ts:26,53`: the `http://localhost:3000` fetch is fragile — replace with a direct
import of `hasAccessGate` from `@/lib/referral` if the proxy bundle allows it; otherwise keep the
fetch but point it at `process.env.APP_BASE_URL ?? http://localhost:3000`. **Do not** hard-code a port.

**G4 — signup has no invite-only gate (the F8 equivalent is missing).**
`app/api/auth/signup/route.ts`: if `referralCode` is null/empty the whole block is skipped and the
account is created anyway → anonymous signup is open (this is exactly SpaceWorker's F8 403, which is a
standing regression pin).
**FIX (mirror SpaceWorker `app/api/auth/signup/route.ts` order-for-order):**
1. resolve `refCode` = body `ref` → `?ref=` → `sw_ref` cookie
2. `referredLink = validateReferral(refCode)`; if null, `invite = lookupInvite(refCode)`
3. **if neither → `403 { error: "An invite or referral link is required to create an account." }`**
4. invite checks: already-used → 403; **email mismatch → 403** (Model C; `SignupInvite.email` is set
   by the SpaceWorker admin form — honour it when present, ignore when null)
5. only **then** `db.user.create` (**G5 below**), then attribution, then `getUserReferralLink`

**G5 — orphaned users.** Today `db.user.create` runs *before* `validateReferral`, so a bad code leaves
a permanent orphan row (DB has 7 users / 7 pending signups and **0** referral links — consistent with
orphan + un-gated signups). **FIX:** move every validation/gate step above `db.user.create`. Add an
assert to the verification battery: signup with a bogus code → 400/403 **and `select count(*) from "User"` unchanged**.

**G6 — Bug #3 root cause: a user never gets a `ReferralLink`.**
`getUserReferralLink(user.id)` is only called inside `if (referralCode) { … }`, and that branch
unreachable for admin-generated codes (G1/G4). `referrallink` = 0 rows.
**FIX:** call `await getUserReferralLink(user.id)` **unconditionally** for every new user (same as
SpaceWorker's signup, which does it in both branches). Wrap in `.catch(() => undefined)` so a link
failure never fails a signup (SpaceWorker's posture).

**G7 — admin codes are `SignupInvite` + `Referral`, not `ReferralLink`; the invite branch is missing.**
`POST /api/admin/invites` writes `SignupInvite{token}` **and** `Referral{code: token}` (64-hex), while
the SpaceWorker proxy surfaces `invite.token` as *the* referral code. Signup's
`validateReferral()` (ReferralLink only) → **400 "Invalid or already used referral code"** for every
code the SpaceWorker admin just generated.
**FIX:** add the invite branch exactly like SpaceWorker:
- on success: `db.signupInvite.updateMany({ where: { token, usedById: null }, data: { usedById: user.id, usedAt: now } })`
- attribute to the invite creator's link when `invite.createdBy !== user.id`
  (`getUserReferralLink(createdBy)` → `attributeReferral(...)`), mirroring SpaceWorker's
  `invite.referredById` logic — `createdBy` is MainStreet's equivalent field
- mark the legacy `Referral` row `status: "claimed", referredId: user.id` (already present — keep)

**G8 — `attributeReferral` shape.** MainStreet's version writes `referredBy` + `referredByLinkId` and
increments `conversions`, but is not idempotent (SpaceWorker early-returns when unchanged and uses a
`$transaction`). **FIX:** copy SpaceWorker's idempotent `$transaction` version verbatim.

**G9 — login is 500 in a browser.** `app/api/auth/login/route.ts:17` does `await req.json()` while
`app/login/page.tsx:66` posts a **form** (`application/x-www-form-urlencoded`) → `req.json()` throws →
500 `login failed`, and even a success would paint raw JSON.
**FIX (do both):**
1. route: accept **both** bodies — `if content-type includes application/json → req.json() else req.formData()`
   (same dual-read already used in `app/api/auth/signup/route.ts`), and on success return
   `{ ok, redirectTo: "/dashboard" }` with the `Set-Cookie: shield-session` header **and** a
   `redirect("/dashboard")`-equivalent so a non-JS form submission still lands somewhere sane.
2. UI: convert `/login` (and `/signup`) from `<form action=… method=POST>` to a client submit that
   `fetch`es the JSON API and navigates on success — copy `components/auth-form.tsx`'s pattern
   (`fetch(\`/api/auth/${mode}\`)` → `if (!res.ok) setError` → `router.push(redirectTo)`), wrapped in a
   `"use client"` component (the pages are server components).
   Signup success → `redirectTo` from the API (`/settings?ref=…` or `/settings`).
   Login success → `/dashboard`.

**G10 — `/login`'s gate uses the wrong validator (admin codes bounce).** `app/login/page.tsx:30-39`
calls `lib/referral.ts hasAccessGate` (ReferralLink-only today) → an admin-generated invite code fails
and the visitor is redirected to `/?error=referral_required`, while `/signup` accepts it.
**FIX:** falls out of G1 — one shared gate. Also forward `?ref=` to the login POST body the way
SpaceWorker does (page can't `cookies().set()` during render), and stamp `sw_ref` on login via the
route handler (allowed there) so a refresh keeps access.

**G11 — `/signup` bounces a signed-in visitor to `/dashboard` (Bug #1 AND Bug #2's actual cause).**
`app/signup/page.tsx:21` `if (await getSession()) redirect("/dashboard")` runs **before** the
referral gate. The owner's browser holds a `shield-session` (they signed up while testing) so
`…/signup?ref=CODE` → `/dashboard` → "error / blank screen".
**FIX:** resolve `hasAccess` first, then:
- valid access **and** a session → **render the Apply-for-Access form** with a dismissible notice:
  *"You're signed in as `<email>`. This form creates a new account."* plus a `Go to dashboard` link
  (so a real signed-in user is never trapped and the owner can see the form).
- no valid access → keep today's `redirect("/dashboard")` for a session holder, `redirect("/?error=referral_required")` otherwise.
Do **not** simply delete the session check (SpaceWorker has the same rule for the ref-less case).

**G12 — `POST /api/admin/*` auth is swallowed (security, backend parity).** In
`app/api/admin/invites/route.ts`, `app/api/admin/referrals/route.ts`, `app/api/admin/users/route.ts`
the pattern is `await requireAdmin(session).catch(() => NextResponse.json(…, {status:403}))` — the
`.catch` **returns a discarded value**, so a non-admin session falls straight through and the handler
runs. SpaceWorker's `requireAdminSession()` returns a boolean that is actually checked.
**FIX:** `try { await requireAdmin(session) } catch { return NextResponse.json({error:"forbidden"},{status:403}) }`
in all three (and any other route using this shape). Do it **after** the functional fixes so the
SpaceWorker proxy (X-Service-Token) path stays untouched.

**G13 — no backfill → the column stays empty even after the code fix.**
**FIX:** one-off idempotent backfill, run once on the box **after** deploy:
`select u.id from "User" u left join referrallink r on r."userId" = u.id where r.id is null;` then for
each, insert an 8-char code from the 32-char alphabet (no `0/1/I/L/O`), retrying on the unique clash —
i.e. ship it as `scripts/backfill-referral-links.ts` in **mainstreet-shield** (uses `lib/referral.ts`'s
`generateCode`, run with `npx tsx --require <server-only-stub> scripts/…` per playbook §4) **and**
**delete the script from the repo when done** (playbook §2 rule 4: never leave box-only artefacts).
Alternative accepted if the owner prefers: lazy-ensure inside `GET /api/admin/users` (call
`getUserReferralLink` per user when null). **Do both is fine; the DB must end non-empty.**

### B. UI — SpaceWorker admin panel (`app/admin=topsecret6199/(protected)/admin-panel.tsx`)

**G14 — Bug #3 column shows the tier label, not a code.** `:6114-6120` renders
`tierLabel[u.tier]` in the cell under the `Referral Code` header (`:6093`), and `:6094` has an
`Actions` `<th>` with **no matching `<td>`** (5 headers, 4 cells → the whole row is misaligned).
**FIX:**
- `:5926` add `referralLink?: { code: string } | null` to the `users` state type (the fetch already
  returns it — `mainstreet /api/admin/users` selects `referralLink { code }`).
- cell = `{u.referralLink?.code ?? "—"}` (+ a per-row copy button, G16).
- drop the orphan `Actions` `<th>` (there are no row actions) **or** add an Actions `<td>`; keep header
  count == cell count; fix `colSpan={4}` at `:6125` to match.

**G15 — "Copy Signup Link" navigates instead of copying (Bug #2).** `:6177-6185` is an
`<a target="_blank" href="https://mainstreetmint.click/signup?ref=…">` mislabelled "Copy Signup Link".
It opens a new tab (which then hits G11 → `/dashboard`).
**FIX:** `<button type="button" onClick={async () => { const ok = await copyToClipboard(url); setCopied(ok); }}>`
using the already-imported `copyToClipboard` from `@/lib/clipboard` (`:8`) with a `Copied ✓` state for
~2s — same UX as `:4565`. Keep the visible URL as selectable text. Add a separate, clearly labelled
`Open` link only if the owner wants both (default: copy button + selectable URL, **no navigation on the
primary action**).

**G16 — dead fetch + missing proxy route.** `:5953-5973` fetches
`/api/admin/mainstreet/referrals` → **route does not exist** (only `invites/`, `tier/`, `users/`) →
silent 404; `referralCodes`/`referralLoading` are **never rendered**.
**FIX:** either (a) add `app/api/admin/mainstreet/referrals/route.ts` (GET, `requireAdminSession()`,
`env.mainstreetServiceToken`, proxy to `https://mainstreetmint.click/api/admin/referrals` with
`X-Service-Token`, return `{ referrals }`) **and** render the list (code, referrer email, status,
created, copy-link button) — this is what the report's "Referral Codes" subtab needs; or (b) delete the
dead `useEffect` + its two state vars. **(a) is the requested UI; do (b) only if the owner says drop it.**

**G17 — subtab shell.** The report's repro steps say *"MainStreet Shield → **Referral Codes**
subtab"*, and `PLAN_SPACEWORKER_ADMIN_FINAL.md` / `PLAN_SPACEWORKER_ADMIN_CONSOLIDATE.md` both specify
subtabs — but **no subtab code exists in local `main` or in the live build** (grep: `Users & Tiers` =
0 hits).
**FIX:** inside `MainStreetShieldTab` add local state `const [sub, setSub] = useState<"users"|"referrals">("users")`
and a small segmented control:
- **`Users & Tiers`** = the existing users table (tier select + referral code cell, G14)
- **`Referral Codes`** = the Generate form + generated code/copy button (G15) + the codes list (G16) +
  the existing "How it works" note
`CyberLab` subtab is **OUT OF SCOPE** for TASK_255 (see §4).

### C. What does **not** need changing (do not touch)
- `middleware.ts` `/signup` `?ref` stamping logic, `app/r/[code]/route.ts` cookie attributes,
  `app/api/admin/users/route.ts` `select` (already has `referralLink`), the `@@map("referrallink")`
  (already committed `a6b6b44`), `POST /api/admin/invites` dual-write of `SignupInvite` + `Referral`,
  the SpaceWorker proxies `invites`/`tier`/`users`, `prisma/schema.prisma` (**no migration — the table
  exists and is empty**).
- SpaceWorker's own referral flow — it is the reference, not the target.

---

## 3. Step order for the Task Agent (run in this order; tick each in §5)

1. **S1 — one gate:** `lib/referral.ts` combined `hasAccessGate` + `validateReferral` accept
   `ReferralLink`/`SignupInvite`/`Referral`; rewrite `app/api/admin/referrals/validate/route.ts`;
   delete the local `hasAccessGate` in `app/signup/page.tsx`.
2. **S2 — middleware:** `middleware.ts` `/r/` → `next()` (let the route handler own it); keep the
   `/signup?ref` stamping but call the shared gate (drop/genericise the `localhost:3000` hard-code).
3. **S3 — signup route:** gate-before-create (403 no-code / 400 bad-code / 403 used / 403 email-mismatch),
   invite branch + redemption + attribution, unconditional `getUserReferralLink`, idempotent
   `attributeReferral`.
4. **S4 — login route + both auth pages:** dual body read on login; client submit components
   (copy `components/auth-form.tsx` shape); `/signup` session redirect reworked (G11); `?ref`
   forwarded from both forms.
5. **S5 — admin auth:** fix the swallowed `requireAdmin` in the three mainstreet admin routes.
6. **S6 — SpaceWorker UI:** G14 column, G15 copy button, G16 proxy route + list, G17 subtabs.
7. **S7 — gates:** `npx tsc --noEmit` = 0 in **both** repos; `npx prisma validate` in mainstreet
   (mainstreet has **no `tests/` dir** — `npm test` will fail by construction, record that, do not
   "fix" it by inventing tests unless the owner asks).
8. **S8 — commit** (both repos, to `main`), then **STOP and hand back** for verification + the
   owner's 🚦 GO before any deploy.
9. **S9 (post-GO, verification agent):** deploy mainstreet **first**, then spaceworker; run §5's battery;
   run the G13 backfill; re-run the battery; update this file's PROGRESS LOG.

---

## 4. Explicitly OUT of scope (say so in your report — do not build it)
- The `CyberLab` subtab (VM start/stop, MSS Agent console) — belongs to
  `PLAN_SPACEWORKER_ADMIN_FINAL.md`, separate task.
- CyberLab removal from SpaceWorker (`PLAN_REFERRAL_REPLICATION.md` Phase 6) — separate.
- MainStreet dashboard redesign, pricing, email/verification-code flow, rate limiting, zod hardening
  beyond what G4/G9 require.
- Any schema/migration change (**none is needed** — say "no migration" in the handoff).
- Never print or commit `MAINSTREET_SERVICE_TOKEN` / `SESSION_SECRET` / `.env` values (the panel already
  hard-codes the token at `admin-panel.tsx:5933` — **leave that alone**, it is pre-existing and not
  part of this task; note it, don't fix it here).

---

## 5. Verification battery (ALL must pass; paste raw output here)

| # | Probe | Expected |
|---|---|---|
| V1 | `curl -s -o /dev/null -w '%{http_code}\n' 'https://mainstreetmint.click/signup?ref=<valid64hex>'` (anon) | `200`, title `Apply for Access` |
| V2 | same URL **with a `shield-session` cookie for an existing test user** | `200` + the Apply form (G11) — **this is Bug #1** |
| V3 | `curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' 'https://mainstreetmint.click/signup'` (anon, no ref) | `3xx` → `/` (still gated) |
| V4 | `curl -X POST https://mainstreetmint.click/api/auth/signup -H 'content-type: application/json' -d '{"email":"e2e-<ts>@x.test","why":"test","acceptedTerms":true}'` **no ref** | **403** `An invite or referral link is required…` |
| V5 | same POST **with an invalid code** | `400`/`403` **and `select count(*) from "User"` unchanged** (no orphan, G5) |
| V6 | same POST **with a valid admin-generated code** (`POST /api/admin/invites` via the SpaceWorker proxy or service token) | **201**, then `select id,email,"referredBy","referredByLinkId" from "User" where email=…` populated **and a `referrallink` row exists for the new user** |
| V7 | re-POST with the **same** code → `403`/`400` (single-use honoured) |
| V8 | `curl -s -i 'https://mainstreetmint.click/r/<users8charLink>'` | `302/307` → `/login` **+ `Set-Cookie: sw_ref=…; Path=/; Max-Age=…`** (G2 — today it goes to `/`) |
| V9 | browser login (the real form) | signs in, lands on `/dashboard`, **not** 500 raw JSON (G9) |
| V10 | `curl -s -X POST https://mainstreetmint.click/api/admin/users -H "X-Service-Token: …"` → every `user.referralLink.code` non-null after backfill (Bug #3) |
| V11 | SpaceWorker admin → MainStreet Shield: `Referral Code` cell shows a real 8-char code (not `Tier 1 - Explorer`); `Actions` header no longer orphaned |
| V12 | click **Copy Signup Link** → clipboard contains `…/signup?ref=…`, **no new tab, no navigation** (Bug #2); paste into a clean browser → V1 |
| V13 | `curl -s -o /dev/null -w '%{http_code}\n' https://mainstreetmint.click/` | `200` (public homepage never gated) |
| V14 | `npx tsc --noEmit` in both repos | `0` errors; `git status` clean after commit |
| V15 | box: `systemctl is-active mainstreet-shield spaceworker` + `cat /opt/mainstreet-shield/.next/BUILD_ID` (changed) | both `active`, BUILD_ID old→new |

**Honest unverified list is mandatory in the handoff** (playbook §5/§7).

---

## 6. Risks / traps
- **No `prisma` migration is needed.** If a step asks for one, STOP — the table exists, only the rows are missing.
- `middleware.ts` runs in an isolated bundle (playbook §1a): do not import server-only state into it
  beyond a pure lookup, and never rely on cross-module invalidation reaching it.
- MainStreet deploy is `rsync --delete` from CI — anything left out of git is deleted from the box; `.env`
  is excluded. Never `source /opt/mainstreet-shield/.env` by hand (playbook §0 env rule).
- Green **push** CI ≠ deployed for SpaceWorker (deploy job = `workflow_dispatch` only).
- Regression pins 1/2/6 of `PROMPT_NEXT_VERIFICATION_AGENT.md` must stay true (invite-only homepage,
  F8 403, `/r/:code` sets `sw_ref` → `/login`) — V3/V4/V8 are those pins.
- SpaceWorker's own tree has one uncommitted comment deletion in `admin-panel.tsx` (from HEAD): either
  restore it or fold it into the commit deliberately; do not leave the tree dirty.

---

## 7. HANDOFF → TASK AGENT (Cline)

**TREE:** `/Users/mikeolab/spaceworker` **and** `/Users/mikeolab/mainstreet-shield` (both on `main`).
**READ:** this file end-to-end → `HOW_WE_MOVE_FAST.md` §1a/§2/§3 → SpaceWorker's reference files in
§"Reference implementation" → `PROMPT_NEXT_VERIFICATION_AGENT.md` pins 1/2/6.
**DO:** §3 steps S1–S8 only. **NO deploy** (S9 is the verification agent's, owner GO required).
**REPORT:** files+line ranges changed · raw BEFORE/AFTER for V4, V5, V6, V9 · exact commands + raw
outputs · the honest unverified list · commit SHAs · "no migration" confirmation · anything you did NOT
change and why.

---

## 8. PROGRESS LOG (update BEFORE starting each step and AFTER finishing it)

| Step | BEFORE (started at) | AFTER (evidence) | By |
|---|---|---|---|
| S0 plan | file written, **no code edited** | — | verification agent |
| S1 | mainstreet BEFORE: referral gate is ReferralLink-only; local hasAccessGate in signup page; attributeReferral non-idempotent | | |
| S1 | mainstreet AFTER: lib/referral.ts combined gate (ReferralLink/SignupInvite/Referral), validate route rewritten, local gate deleted | tsc 0 both repos (S7) | Cline |
| S2 | | | |
| S3 | | | |
| S4 | mainstreet BEFORE: login route req.json() only (500 on form posts); pages are <form action> server submits; /signup bounces signed-in visitors | | |
| S4 | mainstreet AFTER: login dual body read + redirectTo; login & signup pages become client submit (fetch JSON → router.push); /signup session reworked (G11) | tsc 0 both repos (S7) | Cline |
| S5 | | | |
| S6 | mainstreet AFTER: lib/referral.ts combined gate, signup route gate-before-create + invite branch + unconditional getUserReferralLink + idempotent attributeReferral; login dual body + redirectTo; login & signup pages client submit (fetch→router.push); /signup session reworked (G11); middleware /r/→next(), /signup?ref uses APP_BASE_URL; admin requireAdmin fixed in 3 routes | tsc 0 both repos (S7) | Cline |
| S6 | spaceworker AFTER: admin panel G14 referralLink.code cell + fixed header/cell alignment, G15 copy button (no nav), G16 referrals proxy route + codes list render, G17 users/referrals subtabs | tsc 0 both repos (S7) | Cline |
| S7 | mainstreet AFTER: tsc 0 mainstreet, tsc 0 spaceworker; prisma validate OK schema-wise (P1012 DATABASE_URL env absent = environmental, not a schema error); npm test fails by construction (no tests/ dir — recorded, not invented) | tsc 0 both repos | Cline |
| S8 | mainstreet AFTER: committed a182f1a to main (S1-S5 backend parity) | a182f1a | Cline |
| S8 | spaceworker AFTER: committed 85e37f2 to main (S6 UI parity; pre-existing comment deletion folded in) | 85e37f2 | Cline |
| S9 deploy+verify | | | |
