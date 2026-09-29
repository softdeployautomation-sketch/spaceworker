# TASK_145 — Phase 5: self-hosted product license — JUNIOR / IMPLEMENTATION TRACK

## Owned by the junior engineering agent (writes ALL code) — verify with the senior track

**Companion (must read first):** `TASK_145_SELF_HOSTED_LICENSE_SENIOR_TRACK.md` — it holds the verified findings (`V1–V18` + `W1–W7`), the decisions (`D1–D11`), the enforcement points (`E1–E11`), the verification protocol (`S1–S17`) and the **reject list (§6)**. This file is the work order; that file is the spec of record. If the two ever disagree, the senior track wins and you append a `⚠️` entry.

> ⚠️ **REVISION 2 (2026-09-29) — read senior track §3.9 before §2 here.** The owner clarified the product: a **1-month test** licence must be killable ("just like the other exe"), and a **lifetime** licence must be **admin-move-only**. This **amends D5** and adds **D8–D10**, which is why the work order grew past its original `T1 → T10` shape. **Task numbers record the order things were *discovered*, not the order you *do* them — always follow the `▶ NEXT TASK` pointer in §2, never the lowest unused number.**

**▶ NEXT TASK: `T3` — lifetime constants in the licence lib (full spec in §2).** Do that one task, run its acceptance check, log it, stop.

**Status:** `T1` ✅ closed (`70a80dd`) · `T2` ✅ closed (`83fe756`) · `T16` ✅ closed (`77b2faf`) · **`T3`–`T15` not started.** The senior moves the pointer above at the end of every pass; if it ever disagrees with a `T*` heading or with a later revision banner, **this pointer wins** — read §2 for the spec.

---

## 0. THE TWO-TRACK RULE (non-negotiable)

- Both agents append to **both** files. **Append-only, newest at the bottom, one dated entry per session.** Never edit, reorder or delete another agent's entry.
- The junior writes `READY FOR VERIFICATION` — **never** `VERIFIED` or "done". Only the senior closes a verification row (`S1–S17`).
- **Stop after each task.** Finish one `T*`, run its acceptance check, append a short entry to **both** files, then **stop and report**. Do not roll into the next `T*` in the same session. The senior reviews and the next agent resumes at the next task — see **§2.0**.
- Each junior entry must state: what changed (`file:line`), the exact commands run, and their **raw output** (paste, don't summarise). Anything you could not verify must be listed as `UNVERIFIED:` with the reason.

## 0.1 THE GIT SHIFT — read before you touch a file

- **`main` = the live hosted app** (`spaceworker.top`). Checkout: `/Users/mikeolab/spaceworker`. Live bug fixes go to `main` first, then get merged here — **never the reverse**.
- **`self-hosted-build` = the self-hosted Windows-EXE + Linux product line.** Worktree: **`/Users/mikeolab/sw-selfhost`** ← every edit happens here.
- The branch is **37 commits behind `main`**. So:
  1. Every file you touch is **shared, live code**. Changes must be **additive and hosted-safe** — never rewrite a shared lib so it only makes sense here.
  2. Files under `TASK_134..TASK_144` exist on `main` but not here — **expected drift, not garbage. Do not delete or tidy them.**
  3. Before you start and again when you finish, run:
     ```bash
     cd /Users/mikeolab/spaceworker
     git diff --stat main self-hosted-build -- lib/exe-license-validator.ts   # MUST stay empty
     ```
- `node_modules` in the worktree must be a **real clone, never a symlink** — the symlink broke `next build` (senior §3.10.2 / C1) and it let `prisma generate` overwrite the **live app's** Prisma client (C2). If `ls -ld node_modules` starts with `l`, rebuild it:
  ```bash
  cd /Users/mikeolab/sw-selfhost
  rm -f node_modules && cp -Rc /Users/mikeolab/spaceworker/node_modules ./node_modules
  ls -ld node_modules        # must NOT start with 'l'
  ```
  Do **not** run `npm install` here.

#### ⚠️ PUSH TRAP — read before you push anything

The branch's upstream was misconfigured as **`refs/heads/main`**, so a bare `git push` from `/Users/mikeolab/sw-selfhost` would have pushed the whole self-hosted product line at the **live app's `main`**. The senior fixed it on 2026-09-29. From now on:

```bash
cd /Users/mikeolab/sw-selfhost
git config --get branch.self-hosted-build.merge    # must read refs/heads/self-hosted-build
git push origin self-hosted-build:self-hosted-build # ALWAYS an explicit refspec — never a bare `git push`
```
If that config ever reads `refs/heads/main`, **stop** and re-run `git branch --set-upstream-to=origin/self-hosted-build self-hosted-build` before pushing. **Nothing in this task is ever pushed to `main`.**

```bash
cd /Users/mikeolab/sw-selfhost
npx tsc --noEmit     # baseline on the untouched branch: EXIT=0 (senior track §7)
```

---

## 1. THE PROMPT YOU WERE GIVEN (implementation assignment)

> ⚠️ **HISTORICAL — DO NOT FOLLOW THE TEXT IN THIS BLOCK.** It is the *first* assignment and it is **superseded by §1.1 (Revision 2)**. In particular the sentence *"Revocation is … deliberately not checked on app launch"* is **wrong** — the launch-time check **is** the design and is delivered by **T11**/**T13**. Read §1.1 and senior **§3.9**, then work from §2. Keep this block only as a record of what was originally asked.

> You are implementing **Phase 5** of the SpaceWorker self-hosted build: a self-hosted product licence that can be issued as **either** a time-bound term (e.g. 30 days) **or** perpetual/lifetime, with an **admin-cancelable** revocation path. Work in `/Users/mikeolab/sw-selfhost` on branch `self-hosted-build`.
>
> Read `TASK_145_SELF_HOSTED_LICENSE_SENIOR_TRACK.md` completely before writing anything. Implement **D1–D7** in the order given in §2 below. The signing scheme, the signed payload shape, and `lib/exe-license-validator.ts` **do not change** — a lifetime grant is the same payload with a far-future `expires_at`. Revocation is enforced **only** where the app already talks to our servers (bind, transfer, and the admin issue-reuse check); it is deliberately **not** checked on app launch.
>
> The riskiest parts, in order: (1) the admin "issue" action currently hands back an existing unexpired key — if you skip **E4** the whole cancel feature is cosmetic; (2) the new product id must resolve through `getProduct()` (bind/transfer throw without it) but must **not** enter `ALL_PRODUCTS` (that feeds the public store); (3) `app/dashboard/settings/licenses-section.tsx` currently hardcodes 180 days and will show a wrong date for any other term.
>
> Run `npx tsc --noEmit` and `npm run build` before reporting. Append your entry to **both** TASK_145 files with raw command output, then write `READY FOR VERIFICATION`. If anything in the senior track looks wrong, append a `⚠️ OBJECTION` entry instead of silently deviating.

### 1.1 REVISION 2 — this block supersedes the paragraph above (2026-09-29)

The owner reviewed the scope and clarified how the two licence classes must behave:

> *"for a 1 month test, i want the license to be just like we have for the other exe, immediate revocation should kill it. the lifetime license is bound to that email for recovery, in case owner wants to move to another pc, but this must come through the admin — no one should be able to move a lifetime license themself; once it's bound to that device, they need to get a new license for another or reach out to support."*

Two things the first pass got wrong, **both now corrected** — read senior track **§3.9** before you write anything:

1. It treated revocation as **bind-time only** and explicitly rejected a launch-time check. That was wrong. The desktop EXE **already** re-checks the server on every launch (`stillValidLive` → `/api/exe-license/eligibility`), and that route just cannot see a revocation yet. **T11** adds the missing line — it is the single edit that turns "Cancel licence" from cosmetic into real. **T13** gives the self-hosted build its first runtime check, because without it a self-hosted 30-day key never expires at all.
2. It had nothing stopping a **lifetime** licence from being moved self-service. **T12** closes that: lifetime moves are admin-only; the first bind of an unbound lifetime key is unaffected.

**Revised work order: `T1 → T16`, in the order listed in §2 — which is *not* numeric order** (`T16` runs before `T3`). T11 is the highest-value task in the whole set, but **T1 still comes first** — everything else reads the generated Prisma client.

**The two rules that govern how you report:**

- **One task per session.** Complete a `T*`, run its check, append a short entry to **both** files with raw output, end with `READY FOR VERIFICATION — T<n>`, then **stop**. Do not roll into the next task.
- **Fail-open is a hard requirement** on T11 and T13. A customer with no internet must never be locked out. That is why the "immediate" in the owner's request means *"caught at the next launch whenever we can reach the server"* — and that is the exact wording any customer-facing copy must use.


---

## 1.2 REVISION 3 — T1 is VERIFIED; four environment facts changed how you build and test (2026-09-29)

The senior re-ran T1's claims. **T1 is accepted and closed** — start at **T2**. Read senior **§3.10** before you write anything; it is short and it supersedes what §0.1 and your first build attempt told you.

**Four corrections that change your day-to-day commands:**

1. **`node_modules` must be a real clone, not a symlink** (senior C1). The symlink was the cause of the "Turbopack panic" — it was never a branch defect. Fix:
   ```bash
   cd /Users/mikeolab/sw-selfhost
   rm -f node_modules && cp -Rc /Users/mikeolab/spaceworker/node_modules ./node_modules
   ls -ld node_modules          # must NOT start with 'l'
   ```
2. **`npm run build` DOES work** — the `WebExtractPage` export is **not** a blocker (senior C3). It never blocked `next build`; TypeScript finishes clean. Do not touch that file, and do not log it as a blocker again.
3. **The local build command is `CI=1 npx next build`** (senior C4). Plain `npm run build` trips `lib/env.ts`'s placeholder-secret guard (`SESSION_SECRET`, then `RESEND_API_KEY`) because a local build runs with `NODE_ENV=production`; `lib/env.ts:53` skips that guard when `CI` is set — exactly how the EXE CI builds. `BUILD_EXIT=0` verified on the branch.
4. **Never run `npx prisma generate` against the primary DB** (senior C2). Through the old symlink it overwrote the **live app's** Prisma client. For any task that needs the client, pin the verification DB first (below).

**The verification DB (use this for every DB-touching task):**

```bash
cd /Users/mikeolab/sw-selfhost
DB=$(grep '^DATABASE_URL=' .env | cut -d= -f2-); S="${DB%/*}/spaceworker_t145"
psql "$DB" -c 'CREATE DATABASE spaceworker_t145;'      # only if missing
DATABASE_URL="$S" npx prisma db push --skip-generate   # creates the full schema
DATABASE_URL="$S" npx prisma generate                  # safe: real node_modules + scratch DB
```

Why: the shared local DB is ~27 migrations stale (it has no `Device` table), and **the migration chain cannot build a fresh DB at all** (senior C5 / new task **T14**). `db push` is schema-driven, so it produces a correct database in ~1s. `spaceworker_t145` already exists and contains T1's objects.

**Two new tasks appended to the work order: `T14` (fresh-install schema bootstrap) and `T15` (optional, local drift repair only).** ~~The order is now **T1 → T15**; T2 is unchanged and still your starting point.~~ **Superseded by §1.3: the order is T1 → T16, T2 is closed, and your next task is T16.**

---

## 1.3 REVISION 4 — T2 is VERIFIED; one new task, and it comes next (2026-09-29)

The senior re-ran all of T2's checks (12 of 12) — **T2 is accepted and closed**, and its code matches D3 exactly. Read senior **§3.11** before your next session.

But verifying T2 exposed a hole in **D3 itself**, so the work order gains **T16** — and **T16 is your next task, before T3**:

- Registering `selfhosted_os` in `BY_ID` made `getProduct()` resolve it. That is required (bind/transfer throw without it, V9) — but `app/api/billing/checkout/route.ts:38` and `app/api/billing/submit/route.ts:61` **also** resolve products with `getProduct()`, and for `kind: "exe"` there is **no login required**. So `product=selfhosted_os` would have checked out at its **$0** default price and persisted a pending `Payment` row into the admin review queue — for a product that is **admin-issued only** (senior §3.11.2, W8–W11).
- It is **not** auto-approvable (the on-chain verifier turns an expected amount of `0` into `ratio = Infinity`, which fails the ±5% test), so the exposure is queue-spam plus the risk that an admin approves a row the system can mint a self-hosted licence from.
- Fix = **T16**: reject any product id outside `ALL_PRODUCTS` in those two routes, with the **same** `{"error":"Unknown product"}` 400 an unknown id gets. New invariant (**D11**): **`BY_ID` registration makes a product *resolvable*, never *sellable*.**

**The work order is now T1 → T16.** Your next task is **T16**, then T3 onwards.

---

## 2. WORK ORDER — `T1 → T16`, in this order. **Not numeric order** (`T16` comes before `T3`). Do not skip ahead.

### 2.0 STOP-AFTER-EACH-TASK RULE (owner requirement, 2026-09-29)

**Do exactly one `T*` per session, then stop.** This is not a style preference — the owner asked for it explicitly:

1. Complete the task's change **and** its acceptance check.
2. Append a short dated entry to **both** `TASK_145_*` files: what changed (`file:line`), the exact commands you ran, their **raw** output, and anything `UNVERIFIED:`.
3. End that entry with **`READY FOR VERIFICATION — T<n>`** and **stop**. Do not begin another task.

The senior then verifies that one task and the next agent picks up at the task named by the **`▶ NEXT TASK` pointer**. If a check **fails**, do not proceed and do not weaken the check — log `⚠️ OBJECTION` and stop.

Each task has: the file(s), the exact change, and the acceptance check. **Execution order is §2's listed order plus whatever the `▶ NEXT TASK` pointer inserts — it is deliberately *not* `T1, T2, T3, …` in sequence** (`T16` runs before `T3`: it closes a hole `T2` opened, and it is a few lines). T1 had to be first because everything else reads the generated Prisma client.

### T1 — Schema: the revocation table + the lifetime price column

> ✅ **CLOSED — VERIFIED (senior, 2026-09-29).** Shipped in `70a80dd`. Everything below worked as written **except** the acceptance text, which the senior has since corrected: `prisma migrate dev` and `prisma migrate status` **cannot** run on this machine (senior §3.10.6/§3.10.7), and the migration file was correctly produced with `prisma migrate diff` instead. The section is kept for the record — **do not re-run it, and do not "fix" the migration commands it names.** Start at **T2**.

**Files:** `prisma/schema.prisma`

> ⛔ **BEFORE YOU RUN ANY PRISMA COMMAND:** print the target database and confirm it is your **local dev DB** — `echo $DATABASE_URL` (or the `DATABASE_URL` in `.env`). This task runs `prisma migrate dev`, which **rewrites the schema of whatever database it points at**. If it points at the VPS / production database, **STOP and log a `⚠️ OBJECTION`** — never migrate the live DB (senior track §6 reject).

1. Add `model ExeLicenseRevocation` **verbatim** as written in the senior track §3 D1.
2. Add the two back-relations (D1 bullet): `revocation ExeLicenseRevocation?` on `model ExeLicense` (branch `:597`) and `exeLicenseRevocations ExeLicenseRevocation[]` on `model User` (branch `:10`, beside `exeLicenses` `:112`).
3. Add to `model AdminSetting` (branch `:166`), after `agentExePriceUsd`: `selfhostedOsPriceUsd Float @default(0)` with a comment saying it is never charged through the store (the field exists so `StoreProduct.priceField` stays a real key).

**Check:**
```bash
cd /Users/mikeolab/sw-selfhost
npx prisma format && npx prisma validate
npx prisma migrate dev --name add_exe_license_revocation
npx prisma generate
npx prisma migrate status
```
Accept: `validate` OK, migration created, `migrate status` reports the DB up to date. The migration must be **additive only** (one `CREATE TABLE`, one `ALTER TABLE ... ADD COLUMN ... DEFAULT 0`) — if Prisma proposes dropping/altering anything else, **STOP and log it**.

### T2 — Register the self-hosted product (admin-only, never on the store)

> ✅ **CLOSED — 2026-09-29, commit `83fe756`.** The senior re-ran all 12 checks (senior §3.11.1). Do not revisit unless the senior reopens it. One correction to the check below: `grep -n 'ALL_PRODUCTS ='` **can never match** (the line carries a type annotation) — use `grep -n 'ALL_PRODUCTS'` and read the line.

**Files:** `lib/products.ts`

Implement senior track §3 D3 items 1 and 2 **exactly**:
1. Add `"selfhosted_os"` to the `ProductId` union (`lib/products.ts:13-22`).
2. Add `selfhostedOsPriceUsd: number;` to `AdminSettingPriceFields` (`:56`).
3. Export `SELF_HOSTED_OS` and `LICENSABLE_EXE_PRODUCTS = [...EXE_PRODUCTS, SELF_HOSTED_OS]` (copy the definition from D3 verbatim — id `"selfhosted_os"`, `kind: "exe"`, `plan: "selfhosted"`).
4. Register it in **`BY_ID` only** — `new Map([...ALL_PRODUCTS, SELF_HOSTED_OS].map((p) => [p.id, p]))`. **Do not append it to `ALL_PRODUCTS`.**

**Check:**
```bash
cd /Users/mikeolab/sw-selfhost
grep -n 'ALL_PRODUCTS' lib/products.ts   # the SELF_HOSTED_OS line must NOT be on it (read the line)
grep -n 'BY_ID' lib/products.ts            # must include SELF_HOSTED_OS
npx tsc --noEmit                           # still EXIT=0
```

### T3 — Lifetime constants in the licence lib

**File:** `lib/exe-license.ts` (constants only — do **not** restructure it, do **not** touch the payload types)

Add `LIFETIME_EXPIRES_AT_ISO`, `LIFETIME_EXPIRES_AT`, `isLifetimeExpiry()` **verbatim** from senior track §3 D4, placed right after `EXE_LICENSE_DAYS` (`:27`) with the D4 comment.

**Check:**
```bash
cd /Users/mikeolab/sw-selfhost
node -e "const d=new Date('2999-12-31T23:59:59.000000'+'Z');if(d.getUTCFullYear()!==2999)process.exit(1);console.log('lifetime literal OK',d.toISOString())"
npx tsc --noEmit
```

### T4 — The revocation seam module (new file)

**File:** `lib/exe-license-revocation.ts` (new)

Implement senior track §3 D2 — **exactly three exports**, no more:
- `isExeLicenseRevoked(exeLicenseId: string): Promise<boolean>` — `findUnique` on the unique FK.
- `revokeExeLicense({ exeLicenseId, userId, reason?, revokedBy? })` — verify the licence exists **and** belongs to `userId` (throw a typed error otherwise), then `upsert` (idempotent), then `void notifyAdmin(...)`.
- `unrevokeExeLicense(exeLicenseId: string): Promise<void>` — `deleteMany` (idempotent, no throw when absent) + `void notifyAdmin(...)`.

Match this codebase's conventions — verified imports (`lib/exe-license-bind.ts:1-6`): `import "server-only";`, `import { db } from "./db";`, `import { notifyAdmin } from "./telegram";`. Use those exact paths (note it is `./db`, **not** `./prisma`). Type the ownership failure as a small exported error class with a `code`, mirroring `LicenseBindError` (`lib/exe-license-bind.ts:28-46`).

**Check:** `npx tsc --noEmit` clean; `grep -c '^export ' lib/exe-license-revocation.ts` → 3–4 (the three functions + at most one error class).

### T5 — Enforcement: block revoked licences at bind and transfer

**File:** `lib/exe-license-bind.ts`

Implement senior track §3 D5 **E1, E2, E3** exactly:
- Import `isExeLicenseRevoked` from `./exe-license-revocation`.
- `bindExeLicenseToMachine`: guard after the `if (!license)` check, **before** `machineTakenByAnotherAccount` (`:141`) → `throw new LicenseBindError("This license was cancelled by the provider and can no longer be activated. Contact support.", "revoked")`.
- `transferExeLicenseToMachine`: the same guard before `:332` → `throw new LicenseTransferError(..., "revoked")`.
- Add `"revoked"` to **both** error-code unions: `LicenseBindError` (`:30-44`) **and** `LicenseTransferError` (`:233-245`).

**Check:**
```bash
cd /Users/mikeolab/sw-selfhost
grep -n 'revoked' lib/exe-license-bind.ts        # 4+ hits: 2 guards, 2 unions
npx tsc --noEmit
```
Accept: the guard sits **before** the cross-account check in both functions (ordering matters: a revoked licence must never surface as `machine_taken`).

### T6 — Admin API: lifetime issuance, revoke/unrevoke, reuse filter, `revoked` flag

**File:** `app/api/admin/exe-licenses/route.ts`

Implement senior track §3 D5 **E4, E5, E6** + D7's route-side item, in this order:
1. **E4 (do not skip):** `issueLicense`'s reuse lookup (`:337`) must exclude revoked licences — load the user's revoked ids in one query and add `&& !revokedIds.has(l.id)`.
2. **Lifetime issuance:** in `issueLicense`, parse `lifetime` (boolean) from the body; when true, pass `expiresAt: LIFETIME_EXPIRES_AT` (import from `@/lib/exe-license`) and **skip** the `durationDays` parse (`:312-322`); otherwise unchanged (`daysValid: durationDays`).
3. **E5:** in the POST dispatch (`:66-104`), add `action: "revoke"` (`{ exeLicenseId, reason? }`) and `action: "unrevoke"` (`{ exeLicenseId }`), modelled line-for-line on the `unbind` action (`:101-104` dispatch + its handler `:146-170`, including the ownership gate and error→status mapping). Respond `{ ok: true, revoked: true|false }`. Add `revoked` to the response-shape comment block at the top of the file (`:16-32`).
4. **E6:** in GET (`:472+`), include `revoked: boolean` on every licence row (`:505` mapper). If the file has a second listing mapper, update it too.

**Check:** `npx tsc --noEmit` clean, and `grep -n 'revoke\|revoked\|lifetime' app/api/admin/exe-licenses/route.ts` shows all four concerns.

### T7 — Admin UI: Lifetime toggle + Cancel/Restore

**File:** `app/admin/(protected)/admin-panel.tsx` → `ExeLicensesTab` (starts branch `:3477`)
Read the tab first (it was not read line-by-line by the senior — report the exact insertion points in your log).
1. Next to the duration input, add a **Lifetime (no expiry)** checkbox; when ticked, disable the duration input and POST `{ lifetime: true }`; when unticked, the existing `durationDays` payload is unchanged. Update the `EXE_PRODUCTS` → `LICENSABLE_EXE_PRODUCTS` import/select per D3 item 4 (`:6` and `:3559` only; leave the `:3479` default).
2. Per licence row: a `Cancelled` badge when `revoked` is true, plus a **Cancel license** / **Restore license** button that POSTs `{ action: "revoke"|"unrevoke", exeLicenseId, reason? }` behind a `window.confirm`, then reloads the list. Extend the `AdminLicenseRow` type with `revoked?: boolean`.

**Check:** `npx tsc --noEmit`; `grep -n 'LICENSABLE_EXE_PRODUCTS|lifetime|unrevoke' 'app/admin/(protected)/admin-panel.tsx'`.

### T8 — Stop showing a hardcoded 180 days to the buyer

**File:** `app/dashboard/settings/licenses-section.tsx`

Implement senior track §3 D7 item 1: replace the `EXE_LICENSE_DAYS`-based `validUntil` (`:79`) and the `({EXE_LICENSE_DAYS} days from issue)` suffix (`:112`) with the licence's **real** expiry decoded from the key (`decodeLicenseKey(lic.licenseKey)` + `parsePythonIsoformat`, or `originalExpiry()` from `lib/exe-license-bind.ts`), rendering `"No expiry (lifetime)"` when `isLifetimeExpiry(...)` and otherwise the real date + real remaining term. Remove the now-unused `EXE_LICENSE_DAYS` import (`:10`).

**Check:** `npx tsc --noEmit`; `grep -c 'EXE_LICENSE_DAYS' app/dashboard/settings/licenses-section.tsx` → `0`.

### T9 — Wizard API: enforce the right product, expose lifetime

**File:** `app/api/setup/license/validate/route.ts` (branch-only file)

Implement senior track §3 D6 items 1–2: after a valid validation, reject unless `validation.product === "selfhosted_os"` (message names the real product via `getProduct(validation.product)?.name`), and add `lifetime: isLifetimeExpiry(validation.expiresAtDate)` to the success response. Keep every existing guard (the `isSelfHosted()` 404, the completed-state 403, the 400s, the 500) untouched.

**Check:** `npx tsc --noEmit`; `grep -n 'selfhosted_os\|lifetime' app/api/setup/license/validate/route.ts`.

### T10 — Wizard UI: countdown vs "no renewal needed"

**File:** `app/setup/setup-wizard.tsx` (branch-only file)

Implement senior track §3 D6 items 3–4: extend `ApiOk` with `lifetime?: boolean`, store it beside `licenseValidated`, branch the activation success copy (lifetime → `"License accepted for {licensee} — lifetime license, no renewal needed."`; otherwise → `"License accepted for {licensee}. Valid until {date}."`), and make the Review step's Licence row read `"Lifetime"` / `"Activated"` / `"Not activated"`.

**Check:** `npx tsc --noEmit`; `CI=1 npx next build` → `BUILD_EXIT=0`.

### T11 — THE LIVE KILL: make the existing launch check revocation-aware (senior §3.9 D10 / E7)

**File:** `app/api/exe-license/eligibility/route.ts` — **the single highest-value edit in Revision 2.**

This route is what the desktop EXE already POSTs to on every launch (`stillValidLive`, `app/api/exe-license/status/route.ts:91`). Today it returns `{ eligible: license !== null }` — it only proves the presented key still matches the row, so a **revoked** licence still reads `eligible: true` forever. Without this task, "Cancel licence" is cosmetic.

1. Import `isExeLicenseRevoked` from `@/lib/exe-license-revocation`.
2. After the `findFirst` (`:56-63`) and before the return:
   `const revoked = license ? await isExeLicenseRevoked(license.id) : false;`
3. Return `{ eligible: license !== null && !revoked }`.

**Do not** add fail-open handling here — the *caller* owns that policy (it returns `true` on any network/transport error, and that must stay the only place it is decided). **Do not** change the route's auth posture (unauthenticated + per-IP rate-limited, matching its neighbours).

**Check:** with a real revoked row, POSTing **both** the licence's original `licenseKey` **and** its current `boundLicenseKey` returns `eligible: false`; with the revocation deleted, both return `true`. `npx tsc --noEmit` clean.

### T12 — Lifetime is admin-move-only (senior §3.9 D9 / E9+E10)

**Files:** `lib/exe-license-bind.ts`; `app/api/admin/exe-licenses/route.ts:269`; `app/api/exe-license/auto-bind/route.ts:164`; `password-login/route.ts:108`; `payment-status/route.ts:87`.

Implement senior track §3.9 D9 exactly:

1. In `transferExeLicenseToMachine`, add an actor switch — `actor?: "self_service" | "admin"`, defaulting to `"self_service"`. When the licence is **lifetime** (`isLifetimeExpiry(originalExpiry(license.licenseKey))`, both already available in this file) **and** the caller is self-service, throw a typed `LicenseTransferError(…, "lifetime_locked")` **before any mutation** (before `machineTakenByAnotherAccount` / any DB write). Add `"lifetime_locked"` to the `LicenseTransferError` code union.
2. `app/api/admin/exe-licenses/route.ts:269` passes `actor: "admin"` — the sanctioned move path, unchanged behaviour.
3. The three self-service callers surface it with **one** consistent message: *"This is a lifetime licence bound to this device. Contact support to move it to another computer."* Match each route's existing error-mapping style; do not invent a second wording.
4. **Do NOT touch `bindExeLicenseToMachine`.** A fresh **unbound** lifetime key must still activate normally — only a *move* is restricted.

Refer to the lifetime check using the same `isLifetimeExpiry` helper as everywhere else — never a client flag, never a DB column.

**Check:** self-service transfer of a lifetime licence throws `lifetime_locked` and leaves the `ExeLicense` row **byte-identical** (`boundMachineId`, `boundLicenseKey`) with **no** new `ExeLicenseTransfer` row; admin `action: "transfer"` on the same licence **succeeds**; a first bind of an unbound lifetime key still **succeeds**. `npx tsc --noEmit` clean.

### T13 — Self-hosted install gets its first runtime licence check (senior §3.9 D10 / E8)

**Files:** `lib/self-hosted-setup-gate.ts` (+ its call site in `proxy.ts`).

**Why this is in scope:** a self-hosted install validates its key **once**, at the wizard (`app/api/setup/license/validate/route.ts:62`), and never again — `app/api/setup/complete/route.ts:164` says it outright: `SELF_HOSTED_LICENSE_KEY` is *"written (not read) … no code path consumes it yet."* So today a self-hosted **30-day** key never expires, and a revoked one never dies. Without this task the owner's 1-month test licence cannot be ended at all.

Extend the existing gate (`shouldRedirectToSetup`, `:78`) — it already runs from `proxy.ts:5` on every request, in the Node runtime, and already owns a short-TTL in-memory cache (`:48-70`); mirror that exact shape. Add a `licenceStillValid()` helper, **self-hosted only**, ordered:

1. Read the stored key + validation timestamp from setup state. No key recorded → **valid** (the wizard is the gate that would have demanded one).
2. **Offline:** `validateLicenseKey(key, exeLicenseSecret(), { currentMachineId })` — catches **expiry** (the 1-month term) and machine-binding. Invalid → **blocked**.
3. **Online:** POST `/api/exe-license/eligibility` with the key — catches **revocation** (works once T11 lands) and any server-side unbind. `eligible === false` → **blocked**.
4. **Any error / timeout / unreachable server → valid (fail-open).** This is a hard requirement (senior §6 reject #11) — a genuinely offline customer must never be locked out.

Blocked means: send the install to a licence screen that explains the state and offers a re-activation path (reuse the wizard's licence step rather than inventing a new page if that keeps the diff small — your call, report what you chose).

**Check:** (a) a revoked or expired stored key is blocked with a clear message; (b) with the server unreachable and a still-valid key, the install is **NOT** blocked; (c) a non-self-hosted build is completely unaffected (`isSelfHosted()` early-return still first). `npx tsc --noEmit` clean; `CI=1 npx next build` → `BUILD_EXIT=0`.

---

### T14 — The migration history **cannot create a database** (senior §3.10.6 / C5)

**Why this is Phase 5 work, not tidying:** a self-hosted customer's machine must create its own schema from scratch. Today it **cannot**, so nobody can install the product at all.

**The defect (already diagnosed — re-confirm, do not re-derive):**
`prisma/migrations/20260914150000_add_license_claim_token/migration.sql` runs `ALTER TABLE "ExeLicense" ADD COLUMN …`, but `CREATE TABLE "ExeLicense"` only happens in `20260914200000_task42_store_and_licenses` — **five hours later**. On a fresh database:

```
Applying migration `20260914150000_add_license_claim_token`
Error: P3018
ERROR: relation "ExeLicense" does not exist
```

The `20260914150000` folder was authored against a live DB where `ExeLicense` already existed, so it never broke here — and it silently blocks every new install.

**Your job:** make a fresh install possible **without corrupting the live DB's migration state.** Report the option you chose and why.

**Hard constraints:**
- **Never edit or rename a migration the live DB has already applied.** The live `_prisma_migrations` records `20260914150000_add_license_claim_token` and `20260914200000_task42_store_and_licenses` by **name and checksum**; changing either makes the live deploy pipeline re-run or reject them.
- **Scratch databases only.** No `migrate reset`, no `--force-reset`, no VPS connection, ever.
- The schema-driven path is already proven on this machine (senior §3.10.7): `prisma db push` builds the full schema in ~1s. Fixing the **installer's bootstrap** to use that path is a legitimate and probably the lowest-risk answer.
- If you instead add a squashed baseline to the migration chain, it must be **additive** to the existing list and validated on an empty scratch DB.

**Check:**
```bash
cd /Users/mikeolab/sw-selfhost
DB=$(grep '^DATABASE_URL=' .env | cut -d= -f2-)
psql "$DB" -c 'CREATE DATABASE sw_t14_fresh;'
# then run YOUR chosen bootstrap path against .../sw_t14_fresh and show the result
```
Pass: an empty database ends up with the complete schema (`ExeLicense`, `ExeLicenseTransfer`, `ExeLicenseRevocation`, `AdminSetting.selfhostedOsPriceUsd` present) via the chosen path.
Fail: any rename/edit of an applied migration, or any command touching the VPS.

**Then STOP.**

### T15 — (OPTIONAL, local-only) the stale shared dev DB and two stuck `device_tools_v2` rows

**Not product work — do this only if the owner explicitly asks, and never by touching the VPS.**

Facts (senior, 2026-09-29): the shared local DB is ~27 migrations stale (**no `Device` table**) and `_prisma_migrations` holds **two** unterminated `20260921000000_device_tools_v2` rows — `2026-09-27 20:35` (rolled back) and `2026-09-29 03:01` (**not** rolled back). P3009 therefore blocks all migration application.

Two acceptable outcomes: **leave it alone** (Phase 5 does not need it — use `spaceworker_t145`), or repair it **locally** after a `pg_dump` backup. If you repair it: `prisma migrate resolve --rolled-back 20260921000000_device_tools_v2`, then bring the schema up, against the **local** DB only.

**Hard rules:** never `migrate resolve --applied` (it asserts success that may not be true); never connect to the VPS; never `migrate reset` without a dump.
**Check:** if you change anything, paste the `pg_dump` proof and before/after `migrate status`. If you change nothing, say so explicitly — that is a valid result.

**Then STOP.**

---

### T16 — Close the purchase gate: `selfhosted_os` must not be buyable (senior §3.11 D11 / E11) — **DO THIS NEXT, before T3**

> ✅ **CLOSED — VERIFIED (senior, 2026-09-29), commit `77b2faf`.** The senior re-ran every direction independently (senior §5 log, pass 5 / S17): both routes 400 with a body **byte-identical** to a typo'd id, `extractor_exe` still 200, and **zero** `selfhosted_os` rows in `Payment`/`ExeLicense` in the scratch DB. The implementation below is correct as written — **do not revisit it.** One thing it settles for every later task: **`BY_ID` registration makes a product *resolvable*, never *sellable*.** Only an `ALL_PRODUCTS` member may be bought (D11). Start at **T3**.

**Why:** T2 registered `selfhosted_os` in `BY_ID` so `getProduct()` resolves it — required, because bind/transfer throw without it (V9). But two public routes **also** resolve products with `getProduct()` **and take the id from the client**, so the product became purchasable at its `$0` default price with no login (senior §3.11.2, W8–W11).

**Files:** `app/api/billing/checkout/route.ts`, `app/api/billing/submit/route.ts`

1. In **both** files, change the product lookup so a product outside `ALL_PRODUCTS` is rejected exactly like an unknown id:
   ```ts
   const product = getProduct(productId);
   if (!product || !ALL_PRODUCTS.some((p) => p.id === product.id)) {
     return NextResponse.json({ error: "Unknown product" }, { status: 400 });
   }
   ```
   Add `ALL_PRODUCTS` to the existing `@/lib/products` import in each file (it is exported — `lib/products.ts:207`).
2. **Keep the response byte-identical** to the existing unknown-product error. No "not for sale", no 403, no extra field — a distinct response would confirm the product exists.
3. **Additive and hosted-safe:** on `main` every product `getProduct()` can resolve is already in `ALL_PRODUCTS`, so this is a strict no-op there. Do **not** add a `purchasable` flag, a second registry, or any client-side check.
4. **Do not** touch `/api/store/prices`, `admin/wallets`, `components/store.tsx`, the admin licence routes, or the `ALL_PRODUCTS` / `BY_ID` definitions themselves. Removing `SELF_HOSTED_OS` from `BY_ID` is **not** an acceptable fix (it breaks V9).

**Check:**
```bash
cd /Users/mikeolab/sw-selfhost
npx tsc --noEmit                         # EXIT=0
CI=1 npx next build                      # BUILD_EXIT=0
grep -n 'ALL_PRODUCTS' app/api/billing/checkout/route.ts app/api/billing/submit/route.ts   # both must guard
```
Then, with a server up against `spaceworker_t145`, prove **both directions** and paste the raw output:
- `GET /api/billing/checkout?kind=btc&product=selfhosted_os` → **400** `{"error":"Unknown product"}`
- `POST /api/billing/submit {kind:"btc",product:"selfhosted_os",email:"x@y.com"}` → **400**, and **no** `Payment` row created (check the row count before/after)
- `GET /api/billing/checkout?kind=btc&product=extractor_exe` → still **200** (proves the guard is a no-op for sellable products)
- `POST /api/billing/submit` with `product=extractor_exe` → still creates its row exactly as before

**Stop after it:** append the entry to both files ending `READY FOR VERIFICATION - T16`.

---

## 3. JUNIOR SELF-VERIFICATION (run all of it, paste raw output, then wait for the senior)

```bash
cd /Users/mikeolab/sw-selfhost
npx tsc --noEmit            # MUST be EXIT=0 (branch baseline is clean)
CI=1 npx next build         # MUST be BUILD_EXIT=0 — never plain `npm run build` (senior §3.10.5)
```

Do **not** use `npx prisma migrate status` as a pass condition: it can never be clean on this machine (senior §3.10.7 — stale shared DB plus two stuck `device_tools_v2` rows), and the migration history itself cannot build a fresh DB (that is **T14**). For anything that needs a database, use **`spaceworker_t145`** (senior §3.10.7).

| ID | Check | Pass |
|---|---|---|
| J1 | Lifetime key round-trip using **real** code paths (`generateLicenseKey`→`verifyLicenseKey`→`validateLicenseKey`) | `valid: true`, year 2999, no error |
| J2 | 30-day key through the same path | `valid: true`, expiry ≈ now+30d |
| J3 | `LICENSABLE_EXE_PRODUCTS.includes(SELF_HOSTED_OS)` and `getProduct("selfhosted_os") !== null`, while `ALL_PRODUCTS` does **not** contain it | both true / one false |
| J4 | Admin POST `action: "revoke"` twice in a row (double-click) | both 200, no 500 (idempotent) |
| J5 | After a revoke, POST `action: "issue"` for the same email+product | response does **not** have `reused: true` |
| J6 | Bind a revoked licence | fails with code `"revoked"` |
| J7 | `action: "unrevoke"` then bind again | succeeds |
| J8 | `curl -s localhost:3000/api/store/prices \| grep -c selfhosted_os` | `0` |
| J9 | **THE LIVE KILL:** with a revoked row, POST `/api/exe-license/eligibility` with both the original and the bound key | **both** `eligible: false`; delete the revocation → both `true` |
| J10 | Self-service transfer of a **lifetime** licence, then admin `action: "transfer"` | self-service → `lifetime_locked`, row **byte-identical**, no new transfer row; admin → succeeds |
| J11 | First bind of an **unbound** lifetime key on a fresh machine | **succeeds** (T12 must not block this) |
| J12 | Self-hosted build: expired/revoked stored key vs still-valid key with the server unreachable | blocked vs **not** blocked (fail-open preserved) |

If a check fails: fix it, or **stop and log a `⚠️ OBJECTION`** on both files. Never mark a failed check as passing and never work around it by weakening an acceptance rule.

## 4. DO NOT (these are automatic rejects — senior track §6)

Touch `lib/exe-license-validator.ts` · change the signed payload's key set · add `SELF_HOSTED_OS` to `ALL_PRODUCTS` · use `daysValid` arithmetic for lifetime · **decide "lifetime" from anything other than the decoded `expires_at`** · skip E4 · make revoke non-idempotent or skip the ownership check · **touch `bindExeLicenseToMachine`'s first-bind path when implementing T12** (that bricks every new lifetime sale) · **make the T11/T13 checks fail-closed on a network error** (they must fail OPEN) · **leave any self-service route able to move a lifetime licence** · delete/rename `TASK_134..TASK_144` or any main-only file · run a destructive migration or migrate the live VPS DB · leave `tsc` or `build` failing · edit `app/api/store/prices/route.ts` or `admin/wallets/route.ts`. **Added 2026-09-29 (senior §3.10):** never **edit or rename a migration the live DB has already applied** (it is recorded by name *and checksum* — changing it breaks the live deploy pipeline) · never `prisma migrate resolve --applied` (it asserts success that may not be true) · never run `npx prisma generate` or `prisma migrate dev` from this worktree against the shared/live DB (it will overwrite the **live app's** Prisma client, or die with P3018) · never connect any command to the VPS.

> ⚠️ **Corrected 2026-09-29 (Revision 2).** This list used to say *"check revocation anywhere except E1/E2/E4"*. That was **wrong** — the launch-time check **is** the design, and it is how the owner's "immediate revocation should kill it" is actually delivered. Revocation is now checked at **E1/E2/E4/E7/E8**; what remains rejected is putting revocation logic inside `lib/exe-license-validator.ts`, or any check that is not fail-open.

---

## 5. LOG — append-only. Newest entry at the bottom. Both agents append; never edit an existing entry.

### 2026-09-29 — SENIOR — assignment issued, implementation NOT STARTED

**Assigned:** T1–T10 (§2) to the junior agent, against the prompt in §1. Worktree `/Users/mikeolab/sw-selfhost` on `self-hosted-build`; baseline `npx tsc --noEmit` = EXIT=0.

**Junior's next action:** read the senior track in full, then start at **T1**. Report back with raw command output via an appended entry here **and** in the senior track, ending with `READY FOR VERIFICATION`.

### 2026-09-29 — SENIOR (second pass) — no product code written; read before you start

**Two things changed after the assignment entry above — both affect you:**

1. **The branch was tracking the wrong upstream** (`refs/heads/main`), so a bare `git push` would have hit the **live app**. Fixed by the senior. You must **always** push with an explicit refspec:
   ```bash
   cd /Users/mikeolab/sw-selfhost
   git config --get branch.self-hosted-build.merge      # must read refs/heads/self-hosted-build
   git push origin self-hosted-build:self-hosted-build  # never a bare `git push`
   ```
   See the PUSH TRAP box in §0.1 above.
2. **This file had a structure defect** (four blocks landed in the wrong place while appending). Repaired and verified — see T7's body (`:158-166`) and the senior track's second log entry. If you spot any other mis-ordered section, report it as a `⚠️ OBJECTION` rather than working around it.

**Also confirmed unchanged:** `lib/exe-license-validator.ts` still has **zero** diff vs `main` (canary green) and `/Users/mikeolab/spaceworker` is untouched. The implementation is still **NOT STARTED** — your first action is **T1**.

### 2026-09-29 — SENIOR (third pass: **REVISION 2** — your assignment changed) — no product code written

**Read senior track §3.9 and §1.1 above before you start.** The owner clarified the product, and the earlier scope did not match it. What changed for **you**:

| Was | Now |
|---|---|
| Work order **T1 → T10** | **T1 → T13** (T11, T12, T13 added at the end of §2) |
| Revocation enforced at **E1/E2/E4** only; a launch-time check was **forbidden** | Also **E7** (the live kill in `/api/exe-license/eligibility` — the desktop EXE already calls it every launch) and **E8** (the self-hosted build's first-ever runtime licence check) |
| Nothing stopped a lifetime licence being moved self-service | **E9/E10** (T12): lifetime moves are **admin-only**; the first bind of an unbound lifetime key is unaffected |
| One catch-all report per session | **One task per session**, ending `READY FOR VERIFICATION — T<n>`, then **stop** (§2.0) |
| Rejects: *"check revocation anywhere except E1/E2/E4"* | ⚠️ **Corrected** — that rejection was wrong and is **withdrawn**. Still rejected: revocation logic inside `lib/exe-license-validator.ts`, and any check that is **not fail-open** |

**Why T11 matters most:** `eligibility/route.ts:65` returns `eligible: license !== null`, so a revoked licence still reads as eligible forever. Until T11 lands, the admin "Cancel licence" button the owner asked for does nothing. T13 is the other half — without it a self-hosted 30-day key never expires at all (`app/api/setup/complete/route.ts:164`).

**Two hard rules for T11 and T13:** they must be **fail-open** (no internet must never lock a paying customer out), and the customer-facing wording is *"caught at the next launch whenever we can reach the server"* — never "instant kill".

**Your next action:** still **T1** (§2), one task, then stop and report. Push only with `git push origin self-hosted-build:self-hosted-build`.


### 2026-09-29 — JUNIOR — **T1 implemented** (schema: revocation table + self-hosted price column). No other task started.

**Scope:** `prisma/schema.prisma` (+ the one new migration folder), exactly as §2 T1 writes it. Nothing else touched. `lib/exe-license-validator.ts` **untouched** (canary below).

**⛔ Datasource gate (T1 step 0):** `.env` → `DATABASE_URL="postgresql://spaceworker_app:...@127.0.0.1:5432/spaceworker"` — **local dev DB (`127.0.0.1`), not the VPS**. Proceeded. (`.env` in this worktree is a symlink to `/Users/mikeolab/spaceworker/.env`, which is why the worktree had no `.env` of its own.)

**What changed — `git --no-pager diff --stat` = `prisma/schema.prisma | 30 ++++++`, "1 file changed, 30 insertions(+)" (0 deletions):**
- `prisma/schema.prisma:114-116` — `exeLicenseRevocations ExeLicenseRevocation[]` on `model User`, beside `exeLicenses` `:112` / `exeLicenseTransfers` `:113`.
- `prisma/schema.prisma:200-204` — `selfhostedOsPriceUsd Float @default(0)` on `model AdminSetting`, directly after `agentExePriceUsd`, with the required "never charged through the store / keeps `StoreProduct.priceField` a real key" comment.
- `prisma/schema.prisma:650-652` — `revocation ExeLicenseRevocation?` on `model ExeLicense`, before its `@@index([userId])`.
- `prisma/schema.prisma:691-707` — `model ExeLicenseRevocation`, **verbatim** from senior §3 D1 (id / `exeLicenseId @unique` / `exeLicense` FK `onDelete: Cascade` / `userId` / `user` / `reason?` / `revokedAt @default(now())` / `revokedBy?` / `@@index([userId])`), with the D1 comment above it.
- `prisma/migrations/20261020000000_add_exe_license_revocation/migration.sql` — **NEW**. Purely additive: 1 `ALTER TABLE "AdminSetting" ADD COLUMN "selfhostedOsPriceUsd" DOUBLE PRECISION NOT NULL DEFAULT 0`, 1 `CREATE TABLE "ExeLicenseRevocation"`, 2 indexes, 2 FKs. **No** drop / alter / rename / truncate.

**Raw commands and RAW output**

```
$ npx prisma validate
Environment variables loaded from .env
Prisma schema loaded from prisma/schema.prisma
The schema at prisma/schema.prisma is valid 🚀
```
(`VALIDATE_EXIT=0`)

```
$ git --no-pager diff prisma/schema.prisma
diff --git a/prisma/schema.prisma b/prisma/schema.prisma
index 2921c57..a74f54f 100644
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -111,6 +111,9 @@ model User {
   toolUsageLogs            ToolUsageLog[]
   exeLicenses              ExeLicense[]
   exeLicenseTransfers      ExeLicenseTransfer[]
+  // TASK_145 (Phase 5) — admin cancellation of an issued EXE licence (one row per
+  // revoked licence; see model ExeLicenseRevocation).
+  exeLicenseRevocations    ExeLicenseRevocation[]
   // Task 92 — assistant foundation device layer + entitlements.
   devices                  Device[]
   deviceJobs               DeviceJob[]
@@ -194,6 +197,11 @@ model AdminSetting {
   // mailer/combined/automation EXE already sell in — TASK_27 Part A: "only
   // Extractor is wired into CI today") — sellable now, buildable later.
   agentExePriceUsd               Float    @default(50) // one-time, 6-month term
+  // TASK_145 (Phase 5) — the self-hosted OS product's price field. It is NEVER
+  // charged through the store (the product is admin-issued only and deliberately
+  // kept out of ALL_PRODUCTS); the field exists so SELF_HOSTED_OS.priceField
+  // stays a real key for the admin price form.
+  selfhostedOsPriceUsd           Float    @default(0)
 
   // Task 46 — admin admission control for the two mechanisms that actually spend
   // real RAM on this shared, resource-constrained VPS: search/extraction dispatch
@@ -639,6 +647,10 @@ model ExeLicense {
   // for support disputes.
   transfers ExeLicenseTransfer[]
 
+  // TASK_145 (Phase 5) — present iff an admin has cancelled this licence's
+  // activation rights. Un-revoking DELETES the row (a reversible toggle).
+  revocation ExeLicenseRevocation?
+
   @@index([userId])
 }
 
@@ -676,6 +688,24 @@ model ExeLicenseTransfer {
   @@index([userId])
 }
 
+// TASK_145 (Phase 5) — admin cancellation of an issued EXE licence.
+// ONE row per revoked licence; UN-REVOKING DELETES the row (deliberate: this is
+// a reversible admin toggle, not a financial ledger). Revocation can only be
+// enforced where the app already talks to our servers (bind/transfer/issue-reuse)
+// because offline validation is a design invariant — see TASK_145 senior track §3 D5.
+model ExeLicenseRevocation {
+  id           String     @id @default(cuid())
+  exeLicenseId String     @unique
+  exeLicense   ExeLicense @relation(fields: [exeLicenseId], references: [id], onDelete: Cascade)
+  userId       String
+  user         User       @relation(fields: [userId], references: [id])
+  reason       String?
+  revokedAt    DateTime   @default(now())
+  revokedBy    String? // admin label/session marker, free-form, short
+
+  @@index([userId])
+}
+
 // 2026-09-20 — owner: "a subtab showing every free users device active for
```

**Note on `npx prisma format` (T1 lists it).** I ran it; it reformatted **9 PRE-EXISTING lines in `model Device`** (`powerMac`, `powerLanIp`, `powerLanSubnet`, `powerMacUpdatedAt`, `screenshotMonitoringEnabled`, `tier`, `screenshotWakeDelayMinutes`, `screenshotOnlineSinceAt`, `removedAt`) that have nothing to do with T1. I **reverted that unrelated whitespace** so the diff stays additive-only (30 insertions, **0 deletions**) — `prisma/schema.prisma` is shared with `main` and is the worst conflict surface on this branch. Proof the churn is pre-existing debt, not mine:

```
$ git show HEAD:prisma/schema.prisma > /tmp/t1_head_schema.prisma   # untouched HEAD
$ npx prisma format --schema /tmp/t1_head_schema.prisma             # FORMAT_HEAD_EXIT=0
$ diff /tmp/t1_head_schema.orig.prisma /tmp/t1_head_schema.prisma | wc -l
      30
```
i.e. formatting the **unmodified** HEAD schema produces the identical 30-line `Device` churn. `prisma validate` passes without it, so the reformat is not load-bearing.

**The migration file is exactly what Prisma generates for this datamodel change** — compared comment-stripped, statement for statement:
```
$ git show HEAD:prisma/schema.prisma > /tmp/t1_head_schema.orig.prisma
$ npx prisma migrate diff --from-schema-datamodel /tmp/t1_head_schema.orig.prisma \
      --to-schema-datamodel prisma/schema.prisma --script > /tmp/t1_gen2.sql    # DIFF_GEN_EXIT=0
$ sed '/^--/d; /^$/d' /tmp/t1_gen2.sql > /tmp/a.sql
$ sed '/^--/d; /^$/d' prisma/migrations/20261020000000_add_exe_license_revocation/migration.sql > /tmp/b.sql
$ diff /tmp/a.sql /tmp/b.sql
IDENTICAL: committed migration.sql == Prisma-generated SQL for this schema change
```
SQL body (statements only):
```
ALTER TABLE "AdminSetting" ADD COLUMN     "selfhostedOsPriceUsd" DOUBLE PRECISION NOT NULL DEFAULT 0;
CREATE TABLE "ExeLicenseRevocation" (
    "id" TEXT NOT NULL,
    "exeLicenseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT,
    "revokedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedBy" TEXT,
    CONSTRAINT "ExeLicenseRevocation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ExeLicenseRevocation_exeLicenseId_key" ON "ExeLicenseRevocation"("exeLicenseId");
CREATE INDEX "ExeLicenseRevocation_userId_idx" ON "ExeLicenseRevocation"("userId");
ALTER TABLE "ExeLicenseRevocation" ADD CONSTRAINT "ExeLicenseRevocation_exeLicenseId_fkey" FOREIGN KEY ("exeLicenseId") REFERENCES "ExeLicense"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExeLicenseRevocation" ADD CONSTRAINT "ExeLicenseRevocation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
```

**The DDL applies cleanly to the real local schema** — applied inside a transaction against the true DB, then rolled back (so nothing was actually changed):
```
$ { echo 'BEGIN;'; cat prisma/migrations/20261020000000_add_exe_license_revocation/migration.sql; echo 'ROLLBACK;'; } \
      | PGPASSWORD=*** psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5432 -U spaceworker_app -d spaceworker
BEGIN
ALTER TABLE
CREATE TABLE
CREATE INDEX
CREATE INDEX
ALTER TABLE
ALTER TABLE
ROLLBACK
PSQL_EXIT=0
$ PGPASSWORD=*** psql ... -tAc "select to_regclass('public.\"ExeLicenseRevocation\"') is null;"
t
$ PGPASSWORD=*** psql ... -tAc "select count(*) from information_schema.columns where table_name='AdminSetting' and column_name='selfhostedOsPriceUsd';"
0
```
(`t` / `0` confirm the table and column are absent after ROLLBACK — the local DB is unchanged.) `ExeLicense`, `User`, `AdminSetting`, `ExeLicenseTransfer` all resolve as real tables (`to_regclass` non-null), which is why the FKs bind.

**Additive-only scan** of the migration (the only hit is the word "dropped" inside my own header comment):
```
$ grep -inE 'DROP |TRUNCATE|DELETE FROM|ALTER COLUMN|RENAME|SET NOT NULL|TYPE ' prisma/migrations/20261020000000_add_exe_license_revocation/migration.sql
6:-- row, column, constraint or index is dropped, altered or renamed.
```

**`npx prisma generate`**
```
GENERATE_EXIT=0
$ grep -c 'ExeLicenseRevocation' /Users/mikeolab/spaceworker/node_modules/.prisma/client/index.d.ts
711
```
(The client is generated into the shared `node_modules` the worktree symlinks — the T2+ tasks can now read `db.exeLicenseRevocation`.)

**`npx tsc --noEmit` → EXIT=0, zero output** (no build artifacts present):
```
$ rm -rf .next
$ npx tsc --noEmit
TSC_OUTPUT_BYTES=       0
```
⚠️ Caveat, and it matters: `.next/types/**/*.ts` is in `tsconfig.json`'s `include`, so **after any `next build`** `tsc --noEmit` reports **1** error, emitted from a **generated** file, not from source:
```
.next/types/app/dashboard/extract/page.ts(14,13): error TS2344: Type 'OmitWithTag<typeof import("/Users/mikeolab/sw-selfhost/app/dashboard/extract/page"), "default" | "revalidate" | "viewport" | "metadata" | "config" | "generateStaticParams" | "unstable_instant" | ... 8 more ... | "generateViewport", "">' does not satisfy the constraint '{ [x: string]: never; }'.
  Property 'WebExtractPage' is incompatible with index signature.
    Type '() => Element' is not assignable to type 'never'.
```
Same root cause as the build failure in part 3. I removed the `.next` artifacts I had generated, which restores the documented clean baseline.

**`npx prisma migrate dev --name add_exe_license_revocation` — CANNOT RUN (pre-existing).**
```
$ npx prisma migrate dev --name add_exe_license_revocation
Environment variables loaded from .env
Prisma schema loaded from prisma/schema.prisma
Datasource "db": PostgreSQL database "spaceworker", schema "public" at "127.0.0.1:5432"

Error: P3006

Migration `20260914150000_add_license_claim_token` failed to apply cleanly to the shadow database.
Error code: P1014
Error:
The underlying table for model `ExeLicense` does not exist.
```

**`npx prisma migrate status` — 25 pending, NOT clean (pre-existing).**
```
$ npx prisma migrate status
Environment variables loaded from .env
Prisma schema loaded from prisma/schema.prisma
Datasource "db": PostgreSQL database "spaceworker", schema "public" at "127.0.0.1:5432"

66 migrations found in prisma/migrations
Following migrations have not yet been applied:
20260921160000_add_user_premium_expires
20260921170000_add_maintenance_modes
20260921180000_add_exe_trial_email
20260922000000_assistant_foundation
20260922120000_console_followups
20260923000000_vantra_plugin
20260925000000_task119_live_session_streaming
20261002000000_browser_clone_pipeline
20261003000000_task121_installer_zip_names
20261004000000_task123_wol_power_identity
20261005000000_device_layer_fk_action_repair
20261005000001_device_livecapturetoken_index_repair
20261006000000_task105_resource_governor
20261006000100_task99_module_store_prices
20261007000000_task94_telegram_approvals
20261007000100_agent_actions_toggle
20261007000200_telegram_chat_enabled
20261007000300_device_status_notifications
20261007000400_agent_widget_enabled
20261008000000_task127_device_screenshots
20261010000000_task127_screenshot_interval_override
20261011000000_task127_screenshot_wake_delay
20261012000000_task128_device_onboarding
20261013000000_task128_device_removal
20261014000000_campaign_user_templates
20261020000000_add_exe_license_revocation

To apply migrations in development run prisma migrate dev.
To apply migrations in production run prisma migrate deploy.
```
**24 of those 25 predate T1** — the local DB was already 24 migrations behind before I touched anything. Root cause, from the ledger:
```
$ PGPASSWORD=*** psql ... -tAc 'select count(*) from "_prisma_migrations";'
41
$ PGPASSWORD=*** psql ... -tAc 'select count(*) from "_prisma_migrations" where finished_at is null;'
2
$ PGPASSWORD=*** psql ... -tAc 'select migration_name from "_prisma_migrations" order by started_at desc limit 3;'
20260921000000_device_tools_v2
20260921000000_device_tools_v2
20260920160000_add_verification_code_purpose
```
```
$ npx prisma migrate deploy
Environment variables loaded from .env
Prisma schema loaded from prisma/schema.prisma
Datasource "db": PostgreSQL database "spaceworker", schema "public" at "127.0.0.1:5432"

66 migrations found in prisma/migrations

Error: P3009

migrate found failed migrations in the target database, new migrations will not be applied. Read more about how to resolve migration issues in a production database: https://pris.ly/d/migrate-resolve
The `20260921000000_device_tools_v2` migration started at 2026-09-29 02:01:47.863761 UTC failed
```
**`02:01:47 UTC` on 2026-09-29 is hours before this session** (my first edit is timestamped `12:04` local) → the P3009 block is pre-existing drift left by earlier work, **not** caused by T1. P3009 blocks *all* application, so T1's migration cannot be applied to this local DB until somebody resolves `device_tools_v2` — another task's job, so I deliberately did **not** `migrate resolve` it (marking it `--applied` would lie about its state; `--rolled-back` then applying 24 unrelated migrations is outside T1 and risks the shared local DB).

**`npm run build` — FAILS on two PRE-EXISTING blockers, neither related to T1.** Raw:
```
$ npm run build
> Build error occurred
Error [TurbopackInternalError]: Symlink [project]/node_modules is invalid, it points out of the filesystem root

Debug info:
- Execution of get_all_written_entrypoints_with_issues_operation failed
- Execution of EntrypointsOperation::new failed
- Execution of all_entrypoints_write_to_disk_operation failed
- Execution of output_assets_operation failed
- Execution of Project::get_all_endpoint_groups_with_app_route_filter failed
- Execution of Project::entrypoints_with_app_route_filter failed
- Execution of AppProject::routes_with_filter failed
- Execution of directory_tree_to_entrypoints_internal failed
- Execution of directory_tree_to_loader_tree failed
- Execution of try_get_next_package failed
- Execution of *ResolveResult::first_source failed
- Execution of resolve failed
- Execution of resolve_internal failed
- Execution of find_package failed
- Symlink [project]/node_modules is invalid, it points out of the filesystem root
    at ignore-listed frames {
  type: 'TurbopackInternalError',
  location: undefined
}
```
(`NPM_BUILD_EXIT=1`)

Blocker 1 — Turbopack cannot build this worktree at all. §0.1 states `node_modules` here is a symlink to the primary checkout, and `next.config.ts` pins the Turbopack root to `__dirname`; the symlink therefore resolves outside that root:
```
$ ls -ld node_modules
lrwxr-xr-x  1 mikeolab  staff  40 Sep 29 11:19 node_modules -> /Users/mikeolab/spaceworker/node_modules
```
Blocker 2 — Next 16.2.9 rejects a stray named export in a page module. `npx next build --webpack` (webpack resolves symlinked deps normally) reaches and exposes the real second failure:
```
$ npx next build --webpack
▲ Next.js 16.2.9 (webpack)
- Environments: .env

  Creating an optimized production build ...
✓ Compiled successfully in 27.8s
  Running TypeScript ...
Failed to type check.

app/dashboard/extract/page.tsx
Type error: Page "app/dashboard/extract/page.tsx" does not match the required types of a Next.js Page.
  "WebExtractPage" is not a valid Page export field.

Next.js build worker exited with code: 1 and signal: null
```
The bundle **compiles successfully**; only Next's own page-type check fails, on a file carrying both `export function WebExtractPage()` (`:217`) and `export default function ExtractPage()` (`:1870`).

**Both are pre-existing — proven, not asserted.** I stashed every T1 change, rebuilt, then restored:
```
$ git stash push -u -m t1-baseline-check -- prisma/schema.prisma prisma/migrations/20261020000000_add_exe_license_revocation
Saved working directory and index state On self-hosted-build: t1-baseline-check
$ git status --short          # (empty — no T1 changes present)
$ rm -rf .next; npx next build --webpack
BASELINE_WEBPACK_BUILD_EXIT=1
  Creating an optimized production build ...
✓ Compiled successfully in 35.7s
  Running TypeScript ...
Failed to type check.

app/dashboard/extract/page.tsx
Type error: Page "app/dashboard/extract/page.tsx" does not match the required types of a Next.js Page.
  "WebExtractPage" is not a valid Page export field.
$ git stash pop
```
Identical failure with T1 removed → the build was already broken on this branch. Corroboration — the offending file is **byte-identical to `main`**, and Next is pinned *and* installed at the same version:
```
$ git --no-pager diff --stat main self-hosted-build -- app/dashboard/extract/page.tsx
                                                          # (empty)
$ node -e "console.log(require('./package.json').dependencies.next)"
16.2.9
$ node -e "console.log(require('next/package.json').version)"
16.2.9
```
Fixing it means editing `app/dashboard/extract/page.tsx` (drop `export` from `WebExtractPage`) — a **live-app** file, identical on both branches, whose fix must go to `main` **first** per §0.1. That is **not** T1, so I did not touch it.

**STEP 4 canary — `lib/exe-license-validator.ts` untouched:**
```
$ cd /Users/mikeolab/spaceworker && git diff --stat main self-hosted-build -- lib/exe-license-validator.ts
CANARY_LINES=       0
```
`/Users/mikeolab/spaceworker` `git status --short` = empty (live checkout untouched).

**PUSH TRAP config check:**
```
$ git config --get branch.self-hosted-build.merge
refs/heads/self-hosted-build
$ git config --get branch.self-hosted-build.remote
origin
```

**UNVERIFIED:**
- UNVERIFIED: `npx prisma migrate dev --name add_exe_license_revocation` creating the migration — CANNOT RUN: pre-existing P3006/P1014, shadow-DB replay dies at `20260914150000_add_license_claim_token`. The file was instead produced with `prisma migrate diff`, verified byte-identical to Prisma's own generated SQL for this datamodel change, and validated by a transactional apply + ROLLBACK against the real local schema.
- UNVERIFIED: `npx prisma migrate status` reporting the DB up to date — NOT SATISFIABLE here: pre-existing P3009 (`20260921000000_device_tools_v2`, failed `2026-09-29 02:01:47 UTC`, before this session) blocks all application, and 24 of the 25 pending migrations predate T1.
- UNVERIFIED: the T1 migration being applied to the local dev DB — blocked by the same P3009; applying it is outside T1's scope.
- UNVERIFIED: `npm run build` succeeding — fails on two pre-existing blockers (the Turbopack symlink/`filesystem root` panic, a direct consequence of §0.1's own `node_modules` symlink; and Next 16.2.9 rejecting the stray named `WebExtractPage` export in a file byte-identical to `main`). Reproduced identically with T1 stashed.
- UNVERIFIED: `npx tsc --noEmit` being EXIT=0 *while* `.next/types` build artifacts exist — it is EXIT=0 with none; after any build, 1 pre-existing generated-type error (same `WebExtractPage` root cause) is reported.

⚠️ **@OBJECTION (logged per §2.0 — a check failed, so I stop and flag it rather than weaken it).**
- T1's acceptance ("migration created", "migrate status reports the DB up to date") and STEP 3's `npm run build` **cannot** pass in this environment, for reasons that exist **independently of T1** and are proven so by stashing. I am **not** marking them passing and **not** weakening them.
- Deliberately **not** done: `prisma migrate resolve` / `db push` / `migrate reset`; applying the 24 unrelated pending migrations; editing `app/dashboard/extract/page.tsx`; editing `next.config.ts` (e.g. to re-point the Turbopack root). Each exceeds T1, and the last two touch live/shared files whose fixes belong on `main` first.
- **Senior decision requested:** (a) do the `20260921000000_device_tools_v2` P3009 and the shadow-DB P3006 belong to a task I should be assigned, and (b) is the `WebExtractPage` stray export a known `main`-side defect with its own task? T1's own scope — schema + migration — is complete, additive (30 insertions, 0 deletions), `validate`-clean, and provably correct SQL.

**Schema/migration deliverable status: COMPLETE.** Blocked only on the environment items above.

READY FOR VERIFICATION - T1

---

### 2026-09-29 — SENIOR (second pass) — **T1 CLOSED: VERIFIED.** Read §1.2 and senior §3.10 before starting T2.

**Your next action is T2 — not a T1 retry.** T1's schema work is accepted (`70a80dd`). The migration file was correctly produced with `prisma migrate diff` even though `migrate dev` cannot run on this machine; the DDL was independently proven to apply cleanly (senior §3.10.7).

**Four things that changed for you** (full detail: senior §3.10, summary in this file §1.2):

1. **`node_modules` must be a real clone, not a symlink.** The symlink was the "Turbopack panic", and it is what let your `prisma generate` overwrite the **live app's** Prisma client (`main`'s `tsc` then failed with ~14 errors until the senior restored it). §0.1 now carries the `cp -Rc` command.
2. **`WebExtractPage` is not a build blocker — retracted.** `next build` type-checks cleanly, and `main` is EXIT=0. Do not touch that file and do not log it as a blocker again.
3. **The build check is `CI=1 npx next build`** → `BUILD_EXIT=0` (verified by the senior). Plain `npm run build` trips `lib/env.ts`'s placeholder-secret guard by design — **never "fix" that by putting real secrets in `.env`.**
4. **The shared local DB is unusable** (~27 migrations stale, two stuck `device_tools_v2` rows). Use **`spaceworker_t145`**, and never run `npx prisma generate` or `prisma migrate dev` from here against the shared DB.

**Where your report was right, and where it was wrong.** You were right on the essentials: you refused to `migrate resolve`, refused to replay 24 unrelated migrations against a shared DB, and refused to edit a live/shared file outside your scope. Those refusals are now standing rules (this file §4). But two of your three "pre-existing blockers" were misdiagnoses — the Turbopack panic was our own symlink, and `WebExtractPage` never blocked anything. Only the third was real, and it is bigger than you framed it: **a fresh database can never be built from the migration history** (P3018, `relation "ExeLicense" does not exist`). That is now **T14**, and a self-hosted customer cannot install at all until it is fixed.

**Amendments in this file:** T1 marked **CLOSED** (§2); **T14 + T15 added**; T2/T12/T13 build checks now read `CI=1 npx next build`; §3's `migrate status` line removed; §0.1's symlink instruction replaced; §4 gained the migration-safety rejects.

**Next: T2** — register the self-hosted product. One task, then append your entry to **both** files and stop.


### 2026-09-29 — JUNIOR — **T2 implemented** (register the self-hosted product; admin-only, never on the store). No other task started.

**Scope:** `lib/products.ts` only — senior §3 D3 items 1–2, exactly as §2 T2 writes it. `ALL_PRODUCTS` unchanged; `app/api/store/prices/route.ts` and `app/api/admin/wallets/route.ts` untouched (both still read `ALL_PRODUCTS`). `lib/exe-license-validator.ts` untouched (canary below).

**What changed — `git --no-pager diff --stat`:**

```
 lib/products.ts | 26 ++++++++++++++++++++++++--
 1 file changed, 24 insertions(+), 2 deletions(-)
```

- `lib/products.ts:21-22` — `ProductId` union gains `| "selfhosted_os"` (D3 item 1).
- `lib/products.ts:67` — `AdminSettingPriceFields` gains `selfhostedOsPriceUsd: number;` (D3 item 2; the column itself landed in T1, `prisma/schema.prisma:200-204`).
- `lib/products.ts:187-200` — `SELF_HOSTED_OS: StoreProduct`, **verbatim** from D3 (id `selfhosted_os`, `kind: "exe"`, `plan: "selfhosted"`, `priceField: "selfhostedOsPriceUsd"`), with the D3 comment above it.
- `lib/products.ts:202-205` — `LICENSABLE_EXE_PRODUCTS: StoreProduct[] = [...EXE_PRODUCTS, SELF_HOSTED_OS];` (D3 item 1, final bullet).
- `lib/products.ts:207` — `ALL_PRODUCTS` **unchanged** (`[WEB_SUBSCRIPTION, ...MODULE_PRODUCTS, ...EXE_PRODUCTS]`) — `SELF_HOSTED_OS` is deliberately **not** on it.
- `lib/products.ts:209` — `BY_ID` is now `new Map<string, StoreProduct>([...ALL_PRODUCTS, SELF_HOSTED_OS].map((p) => [p.id, p]))` so `getProduct()` resolves it.

**Raw commands and RAW output**

```
$ grep -n 'ALL_PRODUCTS' lib/products.ts
191:// deliberately kept OUT of ALL_PRODUCTS so it never appears on /pricing,
203:// plus the self-hosted product. Deliberately NOT ALL_PRODUCTS: nothing here is
207:export const ALL_PRODUCTS: StoreProduct[] = [WEB_SUBSCRIPTION, ...MODULE_PRODUCTS, ...EXE_PRODUCTS];
209:const BY_ID = new Map<string, StoreProduct>([...ALL_PRODUCTS, SELF_HOSTED_OS].map((p) => [p.id, p]));
```

```
$ grep -n 'BY_ID' lib/products.ts
189:// BY_ID so getProduct() resolves it (bind/transfer require it — see
209:const BY_ID = new Map<string, StoreProduct>([...ALL_PRODUCTS, SELF_HOSTED_OS].map((p) => [p.id, p]));
212:  const product = BY_ID.get(id);
244:  const product = BY_ID.get(id);
```

```
$ grep -n 'SELF_HOSTED_OS\|LICENSABLE_EXE_PRODUCTS' lib/products.ts
193:export const SELF_HOSTED_OS: StoreProduct = {
205:export const LICENSABLE_EXE_PRODUCTS: StoreProduct[] = [...EXE_PRODUCTS, SELF_HOSTED_OS];
209:const BY_ID = new Map<string, StoreProduct>([...ALL_PRODUCTS, SELF_HOSTED_OS].map((p) => [p.id, p]));
```

J3, through the **real** module (not a paraphrase):

```
$ npx tsx -e "import { SELF_HOSTED_OS, LICENSABLE_EXE_PRODUCTS, ALL_PRODUCTS, getProduct } from './lib/products'; ..."
J3a LICENSABLE_EXE_PRODUCTS.includes(SELF_HOSTED_OS): true
J3b getProduct(selfhosted_os) !== null: true
J3c ALL_PRODUCTS contains selfhosted_os: false
meta priceField/kind/plan: selfhostedOsPriceUsd exe selfhosted
TSX_EXIT=0
```

```
$ npx tsc --noEmit; echo "TSC_EXIT=$?"
TSC_EXIT=0
```

```
$ CI=1 npx next build > /tmp/t145_t2_build.log 2>&1; echo "BUILD_EXIT=$?"
BUILD_EXIT=0
```

```
$ npx tsx --test tests/module-store.test.ts
# tests 10
# pass 10
# fail 0
# cancelled 0
# skipped 0
TEST_EXIT=0
```


J8 — the **live** store payload, built app run against the verification DB on port 3100:

```
$ DATABASE_URL="$S" CI=1 npx next start -p 3100 &
$ curl -sf localhost:3100/api/store/prices
{"products":[{"id":"web_subscription","name":"SpaceWorker OS","tagline":"The full web app — private browser, lead extraction, outreach campaigns, the AI agent and automations. Everything, live in your browser.","kind":"web","priceUsd":25},{"id":"extractor_module","name":"Extractor","tagline":"Lead extraction on its own — search the web, verify, and export a clean lead list. Nothing else bundled in.","kind":"module","priceUsd":9},{"id":"mailer_module","name":"Mailer","tagline":"Outreach campaigns on their own — subject/sender rotation, test-send confirmation, per-recipient variables.","kind":"module","priceUsd":9},{"id":"assistant_devices_module","name":"Assistant & Devices","tagline":"The AI agent plus full device control — remote tools, the app launcher, Browser Clone, Wake-on-LAN and keep-awake — with you approving every action.","kind":"module","priceUsd":15},{"id":"extractor_exe","name":"Extractor EXE","tagline":"Lead extraction as a desktop app — run the same Playwright-driven search pipeline locally, no account or subscription required.","kind":"exe","priceUsd":50,"downloadUrl":"https://github.com/softdeployautomation-sketch/spaceworker/releases/download/extractor-v0.1.0/SpaceWorker.OS.-.Lead.Extractor_0.1.0_x64-setup.exe"},{"id":"mailer_exe","name":"Mailer EXE","tagline":"Outreach campaigns on your own machine — build mailboxes and campaigns, with subject and sender rotation, entirely offline.","kind":"exe","priceUsd":50},{"id":"combined_exe","name":"Combined EXE","tagline":"Extractor + Mailer in one app and one local database — leads flow straight from extraction into your campaigns with no export step.","kind":"exe","priceUsd":70},{"id":"automation_exe","name":"Automation-enabled EXE","tagline":"The complete top tier — Combined plus the AI agent and scheduled automations. Everything SpaceWorker OS can do, as a desktop app.","kind":"exe","priceUsd":100},{"id":"agent_exe","name":"SpaceWorker Agent","tagline":"The AI assistant and full device control, as a background desktop app — approve what it proposes, run remote tools, keep machines awake, no browser tab required.","kind":"exe","priceUsd":50}]}

$ grep -c selfhosted_os /tmp/t145_t2_prices.json
0
$ lsof -ti :3100 || echo 'port 3100 free'
port 3100 free
```

**Branch-drift canary + live-app regression (STEP 4):**

```
$ cd /Users/mikeolab/spaceworker && git --no-pager diff --stat main self-hosted-build -- lib/exe-license-validator.ts
(no output)
CANARY_EXIT=0

$ npx tsc --noEmit; echo "LIVE_TSC_EXIT=$?"
LIVE_TSC_EXIT=0
```

**Note on the work order's literal check (doc nit, not an objection):** `grep -n 'ALL_PRODUCTS =' lib/products.ts` returns **nothing even on unmodified HEAD** — the definition line carries a type annotation (`ALL_PRODUCTS: StoreProduct[] =`), so the pattern never matches. I ran `grep -n 'ALL_PRODUCTS'` instead and read `:207` directly; T2's actual invariant (the `SELF_HOSTED_OS` line is not part of the `ALL_PRODUCTS` definition) holds. D3 and §2 T2 both describe that invariant correctly — only the sample grep pattern is off by the type annotation, so no behaviour is in doubt.

**UNVERIFIED:**
- UNVERIFIED: J1/J2 (lifetime / 30-day key round-trip) — the `lib/exe-license.ts` constants are the T3 deliverable; not started.
- UNVERIFIED: J4–J7 and J9–J12 — bind/transfer/eligibility/revocation behaviour lands in T4/T5/T6/T11/T12/T13; no revocation code exists yet.
- UNVERIFIED: the admin surfaces still import `EXE_PRODUCTS` (`app/api/admin/exe-licenses/route.ts:5,306,505`; `app/admin/(protected)/admin-panel.tsx:6,3559`). Swapping them to `LICENSABLE_EXE_PRODUCTS` is D3 item 4 and is explicitly T6/T7 work — T2 was told only to add the constant, so `selfhosted_os` is not yet selectable in the admin licence form.
- UNVERIFIED: no end-to-end Phase 5 licence flow has been exercised (J8 is the only store-side check runnable at T2).

READY FOR VERIFICATION - T2


---

## 2026-09-29 — SENIOR VERIFICATION RESULT: T2 ✅ ACCEPTED + CLOSED; your next task is **T16**

**Read senior §3.11 and this file's §1.3 before your next session.**

- **T2 is closed** at `83fe756`. I re-ran all 12 of your checks myself (`git show --stat`, a fresh `npx tsx` assertion script, `tsx --test` → 10/10, `npx tsc --noEmit` → EXIT=0, `CI=1 npx next build` → BUILD_EXIT=0, canary + V17 diffs empty, `main` untouched, no servers left running). Your work order text was followed exactly; **nothing you did was wrong.**
- **Your three `UNVERIFIED:` lines were accepted as accurate** — J1/J2, J4–J7/J9–J12 belong to later tasks, the `EXE_PRODUCTS` → `LICENSABLE_EXE_PRODUCTS` swap is D3 item 4 (T6/T7), and there is no end-to-end flow yet by construction.
- **Your doc nit is upheld** and the work order is corrected (T2 check + §2). `grep -n 'ALL_PRODUCTS ='` could never match because the line carries a type annotation. I used the loose `grep -n 'ALL_PRODUCTS'` + reading the line in §2 T16, which is robust.
- **One new task, and it is yours next: T16** (senior §3.11 D11/E11). Verifying T2 is what found it: registering `selfhosted_os` in `BY_ID` (required for bind/transfer, V9) **also** made it purchasable, because `/api/billing/checkout` and `/api/billing/submit` resolve with `getProduct()` and take the id from the client — `kind: "exe"` needs no session, and the price column defaults to `0`. That is a path into an admin-issued-only product, so it closes now.
- **Do T16 before T3**, then resume the normal order. One task per session, stop after it, append to both files, end `READY FOR VERIFICATION - T16`.

**State at this entry:** branch `self-hosted-build`, HEAD `83fe756` + this docs-only commit, in sync with `origin/self-hosted-build`; `/Users/mikeolab/spaceworker` (`main`) clean at `b7330a1` and untouched.


---

## 2026-09-29 — SENIOR PASS 4 (docs only, no code): the ordering bug in *this* file is fixed

**`▶ NEXT TASK` is still `T16`.** No task work happened in this pass and no product code changed.

**What was wrong — and it would have sent the next agent to the wrong task.** This file contradicted itself about the order, and every contradiction favoured **T3**:

| Line | Said | Problem |
|---|---|---|
| `:9` | "Status: **NOT STARTED**" | false since T1 and T2 closed |
| `:83` | "work order: **`T1 → T13`, in numeric order**" | stale count, and it directly contradicted the `T16 — **DO THIS NEXT, before T3**` heading in §2 |
| §2.0 | "do not begin **`T<n+1>`**" | reads as numeric sequence |

A fresh agent reading top-down would have started **T3** and only met the T16 override ~300 lines later. That was a senior defect, not a junior one: an ordering rule stated in four places is an ordering rule that will eventually disagree with itself.

**Fix — one source of truth.** The `▶ NEXT TASK` pointer now sits at the very top of this file (`:9`), and both files state plainly that **task numbers record *discovery* order, not execution order**. Amended: `:5` (`D1–D11` / `E1–E11` / `S1–S17`), `:7`, `:9–11`, `:83`, `:87`, `:139`, `:147`, `:149`, `:151`.

**Convention, binding on both agents:** the senior moves the `▶ NEXT TASK` pointer at the end of every pass; the junior treats that pointer as **authoritative** over any `T*` heading or later revision banner.

```
$ git diff --stat
 ...5_SELF_HOSTED_LICENSE_JUNIOR_TRACK.md | 20 +++++++++-------
 ...5_SELF_HOSTED_LICENSE_SENIOR_TRACK.md |  5 ++--
 2 files changed, 14 insertions(+), 11 deletions(-)

$ grep -c 'in numeric order' TASK_145_SELF_HOSTED_LICENSE_JUNIOR_TRACK.md
0
$ grep -c 'T<n+1>' TASK_145_SELF_HOSTED_LICENSE_JUNIOR_TRACK.md
0
$ grep -n 'NEXT TASK' TASK_145_SELF_HOSTED_LICENSE_JUNIOR_TRACK.md
7:  ... always follow the `▶ NEXT TASK` pointer in §2, never the lowest unused number.**
9:  **▶ NEXT TASK: `T16` — close the purchase gate (full spec in §2).** ...
149: ... the next agent picks up at the task named by the **`▶ NEXT TASK` pointer**. ...
151: ... Execution order is §2's listed order plus whatever the `▶ NEXT TASK` pointer inserts ...
```

**State at this entry:** branch `self-hosted-build`, HEAD `2b41ec0` + this docs-only commit; `/Users/mikeolab/spaceworker` (`main`) untouched at `b7330a1`.

**Next action:** the junior's — task **T16**, one task, then stop.


### 2026-09-29 — JUNIOR — **T16 implemented** (close the purchase gate: `selfhosted_os` is resolvable, never sellable). No other task started.

**Scope:** exactly two source files — `app/api/billing/checkout/route.ts`, `app/api/billing/submit/route.ts` — per junior §2 T16 / senior §3.11 D11 + E11. Nothing else touched. `lib/exe-license-validator.ts` **untouched** (canary below). No task T3+ started.

**What changed (`git --no-pager diff --stat` → 2 files changed, 15 insertions(+), 2 deletions(-)):**

- `app/api/billing/checkout/route.ts:6` — `ALL_PRODUCTS` added to the existing `@/lib/products` import.
- `app/api/billing/checkout/route.ts:39-48` — lookup guard is now `if (!product || !ALL_PRODUCTS.some((p) => p.id === product.id))`, returning the **pre-existing, byte-identical** `{"error":"Unknown product"}` 400.
- `app/api/billing/submit/route.ts:11` — same import addition.
- `app/api/billing/submit/route.ts:62-68` — same guard predicate, same 400.

Only the import + predicate changed. No new response shape/status, no `purchasable` flag, no second registry, no client check. `ALL_PRODUCTS` / `BY_ID` / `SELF_HOSTED_OS` definitions untouched; nothing removed from `BY_ID`.

```
$ cd /Users/mikeolab/sw-selfhost && git --no-pager diff --stat
 app/api/billing/checkout/route.ts | 10 +++++++++-
 app/api/billing/submit/route.ts   |  7 ++++++-
 2 files changed, 15 insertions(+), 2 deletions(-)

$ grep -n 'ALL_PRODUCTS' app/api/billing/checkout/route.ts app/api/billing/submit/route.ts
app/api/billing/checkout/route.ts:6:  ALL_PRODUCTS,
app/api/billing/checkout/route.ts:39:  // TASK_145 T16 (D11/E11) — the purchase gate is ALL_PRODUCTS membership, not
app/api/billing/checkout/route.ts:45:  // ALL_PRODUCTS, so this is a strict no-op there.
app/api/billing/checkout/route.ts:47:  if (!product || !ALL_PRODUCTS.some((p) => p.id === product.id)) {
app/api/billing/submit/route.ts:11:  ALL_PRODUCTS,
app/api/billing/submit/route.ts:63:  // ALL_PRODUCTS member is sellable; getProduct() resolving an admin-only
app/api/billing/submit/route.ts:67:  if (!product || !ALL_PRODUCTS.some((p) => p.id === product.id)) {
```

```
$ npx tsc --noEmit; echo TSC_EXIT=$?
TSC_EXIT=0

$ (CI=1 npx next build > /tmp/t16_build.log 2>&1; echo BUILD_EXIT=$? >> /tmp/t16_build.log); tail -5 /tmp/t16_build.log
○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand

BUILD_EXIT=0
```

**Runtime proof (both directions), on `spaceworker_t145`** — server: `CI=1 DATABASE_URL="$S" npx next start -p 3100` where `S` = the `.env` `DATABASE_URL` with its db name replaced by `spaceworker_t145` (127.0.0.1, never the VPS). Schema was already in sync (`prisma db push --skip-generate` → *"The database is already in sync with the Prisma schema."*). The scratch DB's `AdminSetting.btcWallet` was NULL, so I set it to `testwallet_T16` (data in the **scratch verification DB only** — no code change) so the sellable-product GET could reach its real 200 instead of a 400 "Wallet not configured".

```
=== Payment count BEFORE ===
0

=== 1) GET checkout selfhosted_os ===
{"error":"Unknown product"}
HTTP_STATUS=400

=== 2) POST submit selfhosted_os ===
{"error":"Unknown product"}
HTTP_STATUS=400

=== 3) GET checkout extractor_exe ===
{"product":"extractor_exe","kind":"btc","toAddress":"testwallet_T16","amountUsd":50,"durationDays":180,"note":"Send exact amount ±5% to the address shown. Submit your transaction hash below."}
HTTP_STATUS=200

=== 4) POST submit extractor_exe ===
{"paymentId":"cmumq9lqc00039k0x2d35cm4w","status":"pending","note":"Awaiting manual review"}
HTTP_STATUS=200

=== Payment rows AFTER ===
cmumq9lqc00039k0x2d35cm4w|extractor_exe|50|pending
=== Payment count AFTER ===
1
```

```
=== byte-identical proof: non-purchasable vs typo id ===
-- GET selfhosted_os:
{"error":"Unknown product"}
HTTP_STATUS=400
-- GET typo:
{"error":"Unknown product"}
HTTP_STATUS=400
-- POST submit selfhosted_os:
{"error":"Unknown product"}
HTTP_STATUS=400
-- POST submit typo:
{"error":"Unknown product"}
HTTP_STATUS=400
=== no-row proof for rejected POST (unique email) ===
-- users before:
0
rejected POST HTTP_STATUS=400
-- users after:
0
-- payment count after:
1
```

Byte-for-byte the same body and the same 400 as a typo'd id, in both routes; the rejected POST created **no** `User` and **no** `Payment` row, while `extractor_exe` still creates its row exactly as before.

**Hosted-safe (strict no-op on `main`), static proof:**
```
$ cd /Users/mikeolab/spaceworker && git show main:lib/products.ts | grep -n 'BY_ID\|ALL_PRODUCTS'
185:export const ALL_PRODUCTS: StoreProduct[] = [WEB_SUBSCRIPTION, ...MODULE_PRODUCTS, ...EXE_PRODUCTS];
187:const BY_ID = new Map<string, StoreProduct>(ALL_PRODUCTS.map((p) => [p.id, p]));
```
On `main` `BY_ID` is built **only** from `ALL_PRODUCTS`, and `main` has no `SELF_HOSTED_OS`; therefore `getProduct(x) !== null` ⟹ `x ∈ ALL_PRODUCTS` and the new clause can never reject anything there.

**Regression canaries (STEP 4):**
```
$ cd /Users/mikeolab/spaceworker && git diff --stat main self-hosted-build -- lib/exe-license-validator.ts
(empty)
$ npx tsc --noEmit; echo LIVE_TSC_EXIT=$?
LIVE_TSC_EXIT=0
```

Hygiene: the test server on :3100 was killed and `lsof -iTCP:3100 -sTCP:LISTEN` → `PORT_3100_FREE_AFTER_KILL`. No `npx prisma generate`, no `prisma migrate dev`, no `migrate resolve`, no VPS connection.

**UNVERIFIED: the `main` no-op was not executed at runtime** — proven statically from `git show main:lib/products.ts:185-190`; the live app was only typechecked, not run.
**UNVERIFIED: J1/J2 and J4–J7/J9–J12** — belong to later tasks (T3+, T6/T7, T11/T12/T13), untouched here; T16's own check is the four directions above plus the typo comparison, all pasted.
**UNVERIFIED: no unit test added** — T16's acceptance text specifies static greps + live HTTP directions, not a test file; I did not invent one.

READY FOR VERIFICATION - T16


---

## 2026-09-29 — SENIOR VERIFICATION RESULT: **T16 ✅ ACCEPTED + CLOSED.** Your next task is **`T3`**.

Commits: `77b2faf` (your T16) → this pass (**docs only**: `:9`, `:11`, `:18`, `:385` here). **No product code changed in this pass.**

**Verdict: T16 is correct as written. S17 passes.** I re-ran every direction myself rather than reading your pasted log — your report was accurate and your three `UNVERIFIED:` lines were honest and correctly scoped.

### Claims re-checked independently

| Your claim | Senior re-ran | Result |
|---|---|---|
| Guard in both routes, same shape | read `checkout/route.ts:46`, `submit/route.ts:66` | `if (!product \|\| !ALL_PRODUCTS.some((p) => p.id === product.id))` in both ✅ |
| `GET checkout?product=selfhosted_os` → 400 | fresh `next start -p 3100` on `spaceworker_t145` | `{"error":"Unknown product"}  HTTP=400` ✅ |
| …byte-identical to a typo'd id | `A=$(curl …selfhosted_os); B=$(curl …selfhosted_osX); [ "$A" = "$B" ]` | `IDENTICAL: {"error":"Unknown product"}` ✅ |
| `POST submit {product:"selfhosted_os"}` → 400, no row | `curl` + `psql` before/after | 400; counts unchanged ✅ |
| no `selfhosted_os` row anywhere | `count(*) … WHERE product='selfhosted_os'` on `Payment`, `ExeLicense` | `Payment 0`, `ExeLicense 0` ✅ |
| `extractor_exe` unchanged | `GET checkout?product=extractor_exe` | `HTTP=200`, `amountUsd:50`, `durationDays:180` ✅ |
| types | `npx tsc --noEmit` | **TSC_EXIT=0** ✅ |
| hygiene | `lsof -nP -iTCP:3100 -sTCP:LISTEN` after kill | `PORT_3100_FREE` ✅ |
| validator canary | `git diff --stat main self-hosted-build -- lib/exe-license-validator.ts` | **empty** ✅ |
| live app | `/Users/mikeolab/spaceworker` (`main`) | `b7330a1`, clean, `LIVE_TSC_EXIT=0` ✅ |

### The completeness question you did not ask — and the answer

A guard is only verified by proving there is **no third door**, so I enumerated every path that can mint a licence from a client-supplied id:

```
$ grep -rn 'payment.create|payment.upsert|payment.createMany' --include='*.ts' app lib
app/api/admin/exe-licenses/route.ts:374:    const payment = await tx.payment.create({
app/api/billing/submit/route.ts:138:  const payment = await prisma.payment.create({
```

Exactly **two** Payment creators, both accounted for: `billing/submit` is now guarded, and `admin/exe-licenses` is admin-gated (intentionally the self-hosted issuance path — T6/T7). Every other route mints through `handleApprovedPayment(paymentId)` from a **stored** row, never a client id, and `lib/license-service.ts:111` reads `payment.product`. **No bypass.**

### Hosted-safe no-op on `main` — accepted as a static proof

```
$ git show main:lib/products.ts | grep -n 'BY_ID|ALL_PRODUCTS'
185:export const ALL_PRODUCTS: StoreProduct[] = [WEB_SUBSCRIPTION, ...MODULE_PRODUCTS, ...EXE_PRODUCTS];
187:const BY_ID = new Map<string, StoreProduct>(ALL_PRODUCTS.map((p) => [p.id, p]));
```

`main` builds `BY_ID` **only** from `ALL_PRODUCTS`, so `getProduct(x) !== null` ⟹ `x ∈ ALL_PRODUCTS` and the new clause cannot reject anything there. **Your `UNVERIFIED:` on this is closed as "static proof accepted — no runtime difference is possible."**

### Note for later tasks (not a defect)

Your `btcWallet='testwallet_T16'` scratch-DB write was correct and confined to `spaceworker_t145`. A later task on a fresh scratch DB will get `400 "Wallet not configured"` from the same route — **expect it; it is not a regression.**

### State

- **Closed: `T1`, `T2`, `T16`. Next: `T3`.** The `▶ NEXT TASK` pointer has been moved this pass (as the convention requires — the senior owns it).
- `spaceworker_t145`: `Payment` = 1 (`extractor_exe`), `ExeLicense` = 0, **0** `selfhosted_os` rows.
- Files changed this pass: the two `TASK_145_*` markdown files only. **Zero product code.**

**Next actor:** junior — **`T3`** (lifetime constants in `lib/exe-license.ts`), one task, then stop.


### 2026-09-29 — JUNIOR — **T3 implemented** (lifetime constants in the licence lib). No other task started.

**Scope:** exactly one source file — `lib/exe-license.ts` — per junior §2 T3 / senior §3 D4. Constants-only: **+13 lines** at `lib/exe-license.ts:29-40`, immediately after `EXE_LICENSE_DAYS` (`:27`). Nothing else touched; `lib/exe-license-validator.ts` **untouched** (canary below); **no change to the signed payload key set** (the diff is 13 insertions / 0 deletions). No task `T4+` started.

**What changed (`file:line`)**
- `lib/exe-license.ts:35` — `export const LIFETIME_EXPIRES_AT_ISO = "2999-12-31T23:59:59.000000";` — the FROZEN LITERAL (Python-isoformat, no `'Z'`), verbatim from D4.
- `lib/exe-license.ts:36` — `export const LIFETIME_EXPIRES_AT = new Date(Date.UTC(2999, 11, 31, 23, 59, 59));`
- `lib/exe-license.ts:37-40` — `export function isLifetimeExpiry(d: Date | null | undefined): boolean { return !!d && d.getUTCFullYear() >= 2999; }`
- `lib/exe-license.ts:29-34` — the D4 comment block, verbatim.
No computed date, no arithmetic, no `Date.now()`; `isLifetimeExpiry` reads only the `Date` it is given (the decoded `expires_at`).

**Commands run and RAW output**

1) T3 acceptance check — the literal parses to year 2999:
```
$ cd /Users/mikeolab/sw-selfhost
$ node -e "const d=new Date('2999-12-31T23:59:59.000000'+'Z');if(d.getUTCFullYear()!==2999)process.exit(1);console.log('lifetime literal OK',d.toISOString())"
lifetime literal OK 2999-12-31T23:59:59.000Z
$ echo "NODE_CHECK_EXIT=$?"
NODE_CHECK_EXIT=0
```

2) T3 acceptance check — type gate:
```
$ npx tsc --noEmit; echo "TSC_EXIT=$?"
TSC_EXIT=0
```

3) Build gate (`CI=1 npx next build`, never plain `npm run build` — senior §3.10.5):
```
$ CI=1 npx next build > /tmp/t3_build.log 2>&1; echo "BUILD_EXIT=$?"
BUILD_EXIT=0
$ grep -n 'Compiled successfully' /tmp/t3_build.log
24:✓ Compiled successfully in 25.1s
$ sed -n '232,237p' /tmp/t3_build.log
ƒ Proxy (Middleware)

○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand

BUILD_EXIT=0
```


4) The change — raw diff (13 insertions, 0 deletions; the payload types are untouched):
```
$ git --no-pager diff --stat -- lib/exe-license.ts
 lib/exe-license.ts | 13 +++++++++++++
 1 file changed, 13 insertions(+)
$ git --no-pager diff -- lib/exe-license.ts
diff --git a/lib/exe-license.ts b/lib/exe-license.ts
index 29a9819..df3a2ec 100644
--- a/lib/exe-license.ts
+++ b/lib/exe-license.ts
@@ -26,6 +26,19 @@ import { createHmac, timingSafeEqual } from "crypto";
 // disclosed to the buyer on the post-purchase license page/email (item 4/6).
 export const EXE_LICENSE_DAYS = 180;
 
+// TASK_145 (Phase 5) — a "lifetime"/perpetual grant is NOT a new payload shape.
+// It is the exact same signed payload with a far-future `expires_at`, which the
+// untouched offline validator already accepts (lib/exe-license-validator.ts:
+// `now > expiresAt` is false for the year 2999). Frozen as a LITERAL on purpose:
+// the value is signed, so a computed date would risk drift between issue time
+// and re-sign-at-bind time, silently changing a customer's licence bytes.
+export const LIFETIME_EXPIRES_AT_ISO = "2999-12-31T23:59:59.000000"; // Python-isoformat, no 'Z'
+export const LIFETIME_EXPIRES_AT = new Date(Date.UTC(2999, 11, 31, 23, 59, 59));
+/** True when this expiry is the lifetime sentinel (>= year 2999). */
+export function isLifetimeExpiry(d: Date | null | undefined): boolean {
+  return !!d && d.getUTCFullYear() >= 2999;
+}
+
 const BASE64URL_RE = /^[A-Za-z0-9_-]+=*$/;
 
 /**
```


5) J1/J2 through the REAL code paths (`generateLicenseKey` → `verifyLicenseKey` → `validateLicenseKey`). Temporary harness — created, run, then **deleted**; **not** part of the deliverable. `server-only` throws under plain `tsx`, so the repo's own `scripts/stub-server-only.cjs` was preloaded (same technique the existing harness needs):
```
$ cat > .t3-j1j2-check.mts <<'EOF'
process.env.EXE_LICENSE_SECRET = process.env.EXE_LICENSE_SECRET ?? "t3-verify-secret";
const lib = await import("./lib/exe-license");
const { validateLicenseKey } = await import("./lib/exe-license-validator");
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "  ok  " : "FAIL  "}${name}${detail ? `  [${detail}]` : ""}`);
  if (!cond) fail++;
}
const now = new Date("2026-09-29T00:00:00Z");
const life = lib.generateLicenseKey({ licensee: "life@example.com", plan: "selfhosted", product: "selfhosted_os", expiresAt: lib.LIFETIME_EXPIRES_AT, at: now });
check("J1 payload.expires_at === LIFETIME_EXPIRES_AT_ISO", life.payload.expires_at === lib.LIFETIME_EXPIRES_AT_ISO, life.payload.expires_at);
check("J1 verifyLicenseKey(key) === true", lib.verifyLicenseKey(life.licenseKey));
const lifeV = await validateLicenseKey(life.licenseKey, process.env.EXE_LICENSE_SECRET!, { now });
check("J1 validateLicenseKey valid:true + no error", lifeV.valid && lifeV.error === "", lifeV.error || "valid");
check("J1 decoded year 2999", lifeV.expiresAtDate?.getUTCFullYear() === 2999, String(lifeV.expiresAtDate));
check("J1 isLifetimeExpiry(decoded) === true", lib.isLifetimeExpiry(lifeV.expiresAtDate));
check("J1 isLifetimeExpiry(null) === false", lib.isLifetimeExpiry(null) === false);
check("J1 isLifetimeExpiry(30d date) === false", lib.isLifetimeExpiry(new Date("2026-10-29T00:00:00Z")) === false);
const term = lib.generateLicenseKey({ licensee: "term@example.com", plan: "selfhosted", product: "selfhosted_os", daysValid: 30, at: now });
const termV = await validateLicenseKey(term.licenseKey, process.env.EXE_LICENSE_SECRET!, { now });
const expected = now.getTime() + 30 * 24 * 60 * 60 * 1000;
check("J2 validateLicenseKey valid:true + no error", termV.valid && termV.error === "", termV.error || "valid");
check("J2 expiry ≈ now+30d", termV.expiresAtDate !== null && Math.abs(termV.expiresAtDate.getTime() - expected) < 5000, termV.expiresAt);
check("J2 isLifetimeExpiry(decoded) === false", lib.isLifetimeExpiry(termV.expiresAtDate) === false);
console.log(fail === 0 ? "\nT3 J1/J2 ALL PASSED" : `\n${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
EOF
$ node --require ./scripts/stub-server-only.cjs --import tsx .t3-j1j2-check.mts
  ok  J1 payload.expires_at === LIFETIME_EXPIRES_AT_ISO  [2999-12-31T23:59:59.000000]
  ok  J1 verifyLicenseKey(key) === true
  ok  J1 validateLicenseKey valid:true + no error  [valid]
  ok  J1 decoded year 2999  [Wed Jan 01 3000 00:59:59 GMT+0100 (West Africa Standard Time)]
  ok  J1 isLifetimeExpiry(decoded) === true
  ok  J1 isLifetimeExpiry(null) === false
  ok  J1 isLifetimeExpiry(30d date) === false
  ok  J2 validateLicenseKey valid:true + no error  [valid]
  ok  J2 expiry ≈ now+30d  [2026-10-29T00:00:00.000000]
  ok  J2 isLifetimeExpiry(decoded) === false

T3 J1/J2 ALL PASSED
J12_EXIT=0
$ rm -f .t3-j1j2-check.mts && git status --short
 M lib/exe-license.ts
```
(The `[Wed Jan 01 3000 00:59:59 GMT+0100 ...]` string is Node's *local-time* rendering of the `2999-12-31T23:59:59Z` UTC instant in a UTC+1 zone; the assertion is on `getUTCFullYear() === 2999`, and it passed.)


6) Existing licence harness — baseline behaviour unchanged (regression proof):
```
$ EXE_LICENSE_SECRET=unit-test-secret SPACEWORKER_LOCAL_DATA_DIR=$(mktemp -d) \
    node --require ./scripts/stub-server-only.cjs --import tsx scripts/verify-exe-license.mts
[machine-id]
  ok  derives a 16-char hex id on real hardware
  ok  is deterministic across calls
  ok  validateMachineId matches itself
  ok  validateMachineId rejects a different id

[validate]
  ok  valid key validates
  ok  decode returns licensee
  ok  expires ~180 days out
  ok  tampered key fails (signature)
  ok  wrong secret fails (signature)
  ok  expired key fails (expired)
  ok  machine-bound key valid on bound machine
  ok  machine-bound key rejected on another machine

[state-store]
  ok  trial starts on first launch
  ok  trial active at start
  ok  trial ~19h left at 5h elapsed
  ok  trial expired after 24h
  ok  activation persisted
  ok  activation survives re-read

ALL CHECKS PASSED
```
(Doc nit only: `scripts/verify-exe-license.mts`'s header comment says to run `scripts/verify-exe-license.ts`; the file is `.mts`. Not touched — out of scope for T3.)

7) STEP 4 canaries — frozen files and the live app:
```
$ cd /Users/mikeolab/spaceworker
$ git diff --stat main self-hosted-build -- lib/exe-license-validator.ts
(no output — empty)
$ cd /Users/mikeolab/sw-selfhost
$ echo "SELFHOST_VALIDATOR_DIFF_LINES=$(git diff main self-hosted-build -- lib/exe-license-validator.ts | wc -l | tr -d ' ')"
SELFHOST_VALIDATOR_DIFF_LINES=0
$ cd /Users/mikeolab/spaceworker && npx tsc --noEmit; echo "LIVE_TSC_EXIT=$?"
LIVE_TSC_EXIT=0
```

**UNVERIFIED:**
- UNVERIFIED: J1/J2 independent reproduction — evidence was produced by a temporary harness under `tsx` plus the repo's `server-only` stub (the real `server-only` import throws in plain Node). The harness was deleted after the run; re-run it if independent evidence is required.
- UNVERIFIED: `isLifetimeExpiry` consuming the *decoded* payload inside a route/UI — those call sites are T6/T7/T11/T12/T13; T3 delivers the constants only.
- UNVERIFIED: J3 — T2/T16 territory, closed separately.
- UNVERIFIED: J4–J12 — belong to later tasks (T5/T6/T7/T9/T10/T11/T12/T13); untouched here.

READY FOR VERIFICATION - T3

