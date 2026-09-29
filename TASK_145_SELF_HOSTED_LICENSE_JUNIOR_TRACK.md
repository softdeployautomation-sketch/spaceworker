# TASK_145 — Phase 5: self-hosted product license — JUNIOR / IMPLEMENTATION TRACK

## Owned by the junior engineering agent (writes ALL code) — verify with the senior track

**Companion (must read first):** `TASK_145_SELF_HOSTED_LICENSE_SENIOR_TRACK.md` — it holds the verified findings (`V1–V18`), the decisions (`D1–D7`), the enforcement points (`E1–E6`), the verification protocol (`S1–S12`) and the **reject list (§6)**. This file is the work order; that file is the spec of record. If the two ever disagree, the senior track wins and you append a `⚠️` entry.

**Status: NOT STARTED.** Do not begin until you have read both files end to end.

---

## 0. THE TWO-TRACK RULE (non-negotiable)

- Both agents append to **both** files. **Append-only, newest at the bottom, one dated entry per session.** Never edit, reorder or delete another agent's entry.
- The junior writes `READY FOR VERIFICATION` — **never** `VERIFIED` or "done". Only the senior closes a verification row (`S1–S12`).
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

> You are implementing **Phase 5** of the SpaceWorker self-hosted build: a self-hosted product licence that can be issued as **either** a time-bound term (e.g. 30 days) **or** perpetual/lifetime, with an **admin-cancelable** revocation path. Work in `/Users/mikeolab/sw-selfhost` on branch `self-hosted-build`.
>
> Read `TASK_145_SELF_HOSTED_LICENSE_SENIOR_TRACK.md` completely before writing anything. Implement **D1–D7** in the order given in §2 below. The signing scheme, the signed payload shape, and `lib/exe-license-validator.ts` **do not change** — a lifetime grant is the same payload with a far-future `expires_at`. Revocation is enforced **only** where the app already talks to our servers (bind, transfer, and the admin issue-reuse check); it is deliberately **not** checked on app launch.
>
> The riskiest parts, in order: (1) the admin "issue" action currently hands back an existing unexpired key — if you skip **E4** the whole cancel feature is cosmetic; (2) the new product id must resolve through `getProduct()` (bind/transfer throw without it) but must **not** enter `ALL_PRODUCTS` (that feeds the public store); (3) `app/dashboard/settings/licenses-section.tsx` currently hardcodes 180 days and will show a wrong date for any other term.
>
> Run `npx tsc --noEmit` and `npm run build` before reporting. Append your entry to **both** TASK_145 files with raw command output, then write `READY FOR VERIFICATION`. If anything in the senior track looks wrong, append a `⚠️ OBJECTION` entry instead of silently deviating.


---

## 2. WORK ORDER — T1 → T10, in this order. Do not skip ahead.

Each task has: the file(s), the exact change, and the acceptance check. **Do not proceed to the next task until its check passes.** T1 must be first (everything else reads the generated Prisma client).

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

If a check fails: fix it, or **stop and log a `⚠️ OBJECTION`** on both files. Never mark a failed check as passing and never work around it by weakening an acceptance rule.

## 4. DO NOT (these are automatic rejects — senior track §6)

Touch `lib/exe-license-validator.ts` · change the signed payload's key set · add `SELF_HOSTED_OS` to `ALL_PRODUCTS` · use `daysValid` arithmetic for lifetime · check revocation anywhere except E1/E2/E4 · skip E4 · make revoke non-idempotent or skip the ownership check · delete/rename `TASK_134..TASK_144` or any main-only file · run a destructive migration or migrate the live VPS DB · leave `tsc` or `build` failing · edit `app/api/store/prices/route.ts` or `admin/wallets/route.ts`.

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


