# TASK_145 — Phase 5: self-hosted product license — JUNIOR / IMPLEMENTATION TRACK

## Owned by the junior engineering agent (writes ALL code) — verify with the senior track

**Companion (must read first):** `TASK_145_SELF_HOSTED_LICENSE_SENIOR_TRACK.md` — it holds the verified findings (`V1–V18` + `W1–W7`), the decisions (`D1–D10`), the enforcement points (`E1–E10`), the verification protocol (`S1–S16`) and the **reject list (§6)**. This file is the work order; that file is the spec of record. If the two ever disagree, the senior track wins and you append a `⚠️` entry.

> ⚠️ **REVISION 2 (2026-09-29) — read senior track §3.9 before §2 here.** The owner clarified the product: a **1-month test** licence must be killable ("just like the other exe"), and a **lifetime** licence must be **admin-move-only**. This **amends D5** and adds **D8–D10**, which is why the work order below now runs **T1 → T13**, not T1 → T10.

**Status: NOT STARTED.** Do not begin until you have read both files end to end.

---

## 0. THE TWO-TRACK RULE (non-negotiable)

- Both agents append to **both** files. **Append-only, newest at the bottom, one dated entry per session.** Never edit, reorder or delete another agent's entry.
- The junior writes `READY FOR VERIFICATION` — **never** `VERIFIED` or "done". Only the senior closes a verification row (`S1–S16`).
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
- `node_modules` in the worktree is a symlink to the primary checkout's — do **not** run `npm install` there.

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

**Revised work order: `T1 → T13`, in numeric order.** T11 is the highest-value task in the whole set, but **T1 still comes first** — everything else reads the generated Prisma client.

**The two rules that govern how you report:**

- **One task per session.** Complete a `T*`, run its check, append a short entry to **both** files with raw output, end with `READY FOR VERIFICATION — T<n>`, then **stop**. Do not roll into `T<n+1>`.
- **Fail-open is a hard requirement** on T11 and T13. A customer with no internet must never be locked out. That is why the "immediate" in the owner's request means *"caught at the next launch whenever we can reach the server"* — and that is the exact wording any customer-facing copy must use.


---

## 2. WORK ORDER — T1 → T13, in this order. Do not skip ahead.

### 2.0 STOP-AFTER-EACH-TASK RULE (owner requirement, 2026-09-29)

**Do exactly one `T*` per session, then stop.** This is not a style preference — the owner asked for it explicitly:

1. Complete the task's change **and** its acceptance check.
2. Append a short dated entry to **both** `TASK_145_*` files: what changed (`file:line`), the exact commands you ran, their **raw** output, and anything `UNVERIFIED:`.
3. End that entry with **`READY FOR VERIFICATION — T<n>`** and **stop**. Do not begin `T<n+1>`.

The senior then verifies that one task and the next agent picks up at `T<n+1>`. If a check **fails**, do not proceed and do not weaken the check — log `⚠️ OBJECTION` and stop.

Each task has: the file(s), the exact change, and the acceptance check. T1 must be first (everything else reads the generated Prisma client).

### T1 — Schema: the revocation table + the lifetime price column

**Files:** `prisma/schema.prisma`

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

**Files:** `lib/products.ts`

Implement senior track §3 D3 items 1 and 2 **exactly**:
1. Add `"selfhosted_os"` to the `ProductId` union (`lib/products.ts:13-22`).
2. Add `selfhostedOsPriceUsd: number;` to `AdminSettingPriceFields` (`:56`).
3. Export `SELF_HOSTED_OS` and `LICENSABLE_EXE_PRODUCTS = [...EXE_PRODUCTS, SELF_HOSTED_OS]` (copy the definition from D3 verbatim — id `"selfhosted_os"`, `kind: "exe"`, `plan: "selfhosted"`).
4. Register it in **`BY_ID` only** — `new Map([...ALL_PRODUCTS, SELF_HOSTED_OS].map((p) => [p.id, p]))`. **Do not append it to `ALL_PRODUCTS`.**

**Check:**
```bash
cd /Users/mikeolab/sw-selfhost
grep -n 'ALL_PRODUCTS =' lib/products.ts   # the SELF_HOSTED_OS line must NOT be on it
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

**Check:** `npx tsc --noEmit`; `npm run build` succeeds.

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

**Check:** (a) a revoked or expired stored key is blocked with a clear message; (b) with the server unreachable and a still-valid key, the install is **NOT** blocked; (c) a non-self-hosted build is completely unaffected (`isSelfHosted()` early-return still first). `npx tsc --noEmit` clean; `npm run build` succeeds.

---

## 3. JUNIOR SELF-VERIFICATION (run all of it, paste raw output, then wait for the senior)

```bash
cd /Users/mikeolab/sw-selfhost
npx tsc --noEmit            # MUST be EXIT=0 (branch baseline was clean)
npm run build               # MUST succeed
npx prisma migrate status   # MUST be clean
```

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

Touch `lib/exe-license-validator.ts` · change the signed payload's key set · add `SELF_HOSTED_OS` to `ALL_PRODUCTS` · use `daysValid` arithmetic for lifetime · **decide "lifetime" from anything other than the decoded `expires_at`** · skip E4 · make revoke non-idempotent or skip the ownership check · **touch `bindExeLicenseToMachine`'s first-bind path when implementing T12** (that bricks every new lifetime sale) · **make the T11/T13 checks fail-closed on a network error** (they must fail OPEN) · **leave any self-service route able to move a lifetime licence** · delete/rename `TASK_134..TASK_144` or any main-only file · run a destructive migration or migrate the live VPS DB · leave `tsc` or `build` failing · edit `app/api/store/prices/route.ts` or `admin/wallets/route.ts`.

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


