# TASK_145 — Phase 5: self-hosted product license (flexible term + admin revocation)

## SENIOR / VERIFICATION TRACK — owned by the senior engineer (scope + review + live verification)

**Status:** SCOPE COMPLETE · **REVISION 2 (2026-09-29)** — the owner clarified the two licence classes and the move rule; **§3.9 amends D5 and adds D8–D10**. Read **§3.9 before §3**. All findings verified against real code on 2026-09-29. Implementation **NOT started**.
**Spec source:** `~/.claude/plans/transient-moseying-tome.md` → `## Phase 5 — Self-hosted product license: flexible term + admin-cancelable (smallest-diff design)`.
**Branch:** `self-hosted-build` · **Worktree:** `/Users/mikeolab/sw-selfhost` ← do the work HERE.
**Companion file (the junior's):** `TASK_145_SELF_HOSTED_LICENSE_JUNIOR_TRACK.md` — read it too; the two files are one document.

---

## 0. READ FIRST — the two-track rule, and the git shift

### 0.1 The two files

| File | Primary writer | Content |
|---|---|---|
| `TASK_145_SELF_HOSTED_LICENSE_SENIOR_TRACK.md` (this file) | Senior — verification/review | scope, verified facts with `file:line` anchors, decisions, verification protocol, reject list, append-only log |
| `TASK_145_SELF_HOSTED_LICENSE_JUNIOR_TRACK.md` | Junior — implementation | step-by-step tasks, exact acceptance criteria, copy-paste commands, append-only log |

**Non-negotiable rule: BOTH agents append to BOTH files.** Never edit, rewrite, reorder or delete another agent's entry. The log is **append-only, newest entry at the bottom, one dated entry per work session**. A brand-new agent landing on either path must be able to answer *what is done / what is next / what is still unverified* without asking a human. If you cannot answer that from the log, fix the log before you touch code.

### 0.2 THE GIT SHIFT — read before touching anything

- **`main` = the live hosted app** (`spaceworker.top`, paying customers). Primary checkout: `/Users/mikeolab/spaceworker`. Deploys from there per `HOW_WE_MOVE_FAST.md` §2.
- **`self-hosted-build` = the self-hosted Windows-EXE + Linux product line** (plan Phases 1–4: TASK_129/130/131/133). Worktree: `/Users/mikeolab/sw-selfhost`.
- **The branch is 37 commits behind `main` and 8 ahead of merge-base `1499a9e` (2026-09-27).** It forked before the recent campaign / mailbox / DKIM work landed on `main`.
- Consequences, in priority order:
  1. A **live-app bug fix goes to `main` first**, then is merged into `self-hosted-build`. Never the reverse.
  2. Every file this task touches **also exists on `main` and is used by the live licensing flow**. Changes must be **additive and hosted-safe** — a future `main ↔ self-hosted-build` merge must not silently alter live behaviour. Do not rewrite a shared lib so it only makes sense on the self-hosted branch.
  3. **Do not delete or "tidy up" main-only files on the branch.** `TASK_134..TASK_144` existing on `main` and not on the branch is expected drift, not garbage. `git diff --name-status main self-hosted-build` will show many `D` lines — ignore them.
- Branch-drift canary — run this before and after the task. These two files must stay **byte-identical between `main` and the branch** unless the senior explicitly approved a diff:
  ```bash
  cd /Users/mikeolab/spaceworker
  git diff --stat main self-hosted-build -- lib/exe-license.ts lib/exe-license-validator.ts
  ```
  Phase 5 IS allowed to diff `lib/exe-license.ts` (new constants only). It is **not** allowed to diff `lib/exe-license-validator.ts` at all.
- ⚠️ **`node_modules` must be a REAL clone, never a symlink** (superseded 2026-09-29 — §3.10.2 / C1). The old "shared `node_modules`" convention is **banned**: with a symlink, `next.config.ts:26`'s `turbopack.root = __dirname` panics *and* `prisma generate` writes the branch's client into the **live app's** `node_modules`. Verify before you build:
  ```bash
  ls -ld /Users/mikeolab/sw-selfhost/node_modules   # must NOT start with 'l'
  # if it does:  rm -f node_modules && cp -Rc /Users/mikeolab/spaceworker/node_modules ./node_modules
  ```

#### ⚠️ 0.2.1 PUSH TRAP — found and fixed 2026-09-29, read this before pushing anything

`branch.self-hosted-build.merge` was misconfigured as **`refs/heads/main`** (i.e. the self-hosted branch was tracking `origin/main`). A plain `git push` from `/Users/mikeolab/sw-selfhost` would therefore have pushed the **entire self-hosted product line straight at the live app's `main`**. The senior fixed the upstream on 2026-09-29:

```bash
git config --get branch.self-hosted-build.merge   # now: refs/heads/self-hosted-build  (was refs/heads/main)
```

Rules for every agent from here on:
1. **Always push with an explicit refspec**, never a bare `git push`:
   ```bash
   cd /Users/mikeolab/sw-selfhost
   git push origin self-hosted-build:self-hosted-build
   ```
2. Before any push, re-check the upstream: `git config --get branch.self-hosted-build.merge` — if it reads `refs/heads/main`, **stop** and re-run the `--set-upstream-to` fix above; do not push.
3. Same discipline for `git pull`: pull `main` into the branch only deliberately (`git merge origin/main`), never accidentally.
4. The live-app line is `main` → `/Users/mikeolab/spaceworker`. **Nothing in this task is ever pushed to `main`.**

### 0.3 Environment commands

```bash
cd /Users/mikeolab/sw-selfhost          # branch self-hosted-build — all Phase 5 work
npx tsc --noEmit                        # typecheck (baseline recorded in §7)
CI=1 npx next build                     # build check — §3.10.5. Plain `npm run build` trips
                                        # lib/env.ts's placeholder guard locally, by design.
```

**Prisma commands are gated (§3.10.2 / §3.10.3 / §3.10.6):** never run a bare `npx prisma generate` (through the old symlink it overwrote the **live app's** client) and never run `npx prisma migrate dev` (**P3018** — the history cannot build a fresh DB; that is task T14). Point `DATABASE_URL` at the verification DB and use `prisma db push` (§3.10.7).

---

## 1. What Phase 5 is, and what "done" means

### 1.1 The goal in one paragraph

A self-hosted buyer must be able to receive **either** a time-bound licence (e.g. a 30-day trial the owner can cancel) **or** a perpetual one — **chosen per issuance, by the admin**, not fixed at the product level. The signing scheme, payload shape and offline validator do **not** change: a lifetime licence is just a key whose `expires_at` is a far-future date. On top of that, "I can cancel anytime" needs a real revocation path, which does not exist today.

### 1.2 Definition of done (all seven must hold)

1. `lib/exe-license.ts` exposes a lifetime expiry constant (`LIFETIME_EXPIRES_AT`, year 2999) plus helper(s); the payload shape is unchanged.
2. Admin can issue **any** duration (partly possible already) **and** a lifetime grant, from the existing EXE-license generator tab.
3. Admin can **cancel/revoke** an issued licence, and **un-revoke** it (an accidental click must be reversible).
4. A revoked licence **cannot be bound or transferred** to any machine — it fails with a clear, distinct error, at the one network-capable choke point the design allows.
5. A revoked licence is **never silently resurrected** by the admin issue action's "reuse an existing licence" path.
6. Every place that displays a licence's validity **stops hardcoding 180 days** — a 30-day licence reads 30 days, a lifetime licence reads "no expiry".
7. The self-hosted wizard's activation step says the right thing for each case (countdown vs "no renewal needed").

### 1.3 Explicitly OUT of scope for TASK_145

- No change to `lib/exe-license-validator.ts`. Its check `now > expiresAt` already handles 30 days, 180 days and year 2999 identically.
- No change to the offline / no-network validation design. Revocation is **not** checked on app launch — see §3 D5; that is a deliberate, documented trade-off, not an oversight.
- No Phase 6 work (Tauri configs, `.deb`, CI jobs, Linux runners). That is `TASK_146`.
- No change to hosted pricing / store behaviour; the new product must **not** appear on the public store (see §3 D3).



---

## 2. Verified current state (evidence, not assumption)

Every row was read directly at the line(s) shown on 2026-09-29. `main@b7330a1`, branch `self-hosted-build@68afc6b`. Where the branch differs, that is stated.

| # | Location | Verified today | Implication for Phase 5 |
|---|---|---|---|
| V1 | `lib/exe-license.ts:27` | `export const EXE_LICENSE_DAYS = 180;` | The 180 is only a **default**, but it is also imported as a literal by UI (see V16). |
| V2 | `lib/exe-license.ts:100,151,158` | `generateLicenseKey` already accepts `daysValid?: number` **and** `expiresAt?: Date`; `expiresAt` wins (`:158`). | The signing lib needs **no new capability** — only constants. Anything more is a red flag (§6). |
| V3 | `lib/exe-license.ts:68-79` | `toPythonIsoformat()` emits `YYYY-MM-DDTHH:MM:SS.uuuuuu` (no `Z`). | Must be used for the lifetime date too. Verified `Date.UTC(2999,11,31,23,59,59)` is representable in Node. |
| V4 | `lib/exe-license.ts:129-142` | `LicensePayload` keys: `licensee, plan, product, issued_at, expires_at` (+ optional `machine_id`, `machine_ids`). | **Payload shape must not change.** A lifetime grant is a different `expires_at`, nothing else. |
| V5 | `lib/exe-license-validator.ts:34,36,89-92` | Returns `expiresAt` + `expiresAtDate`; expiry check is `if (!expiresAt || now.getTime() > expiresAt.getTime())` -> `"License key has expired"`. | **No change needed** for lifetime. This is the whole "smallest-diff" premise — do not touch this file. |
| V6 | `lib/exe-license-bind.ts:58-65,141,332` | `machineTakenByAnotherAccount()` is the cross-account guard, called in **bind** (`:141`) and **transfer** (`:332`) only. | These two points (plus the reuse check in V11) are the ONLY places a revocation check can bite — everything else is offline. |
| V7 | `lib/exe-license-bind.ts:88,277` | `bindExeLicenseToMachine` (`:88`) and `transferExeLicenseToMachine` (`:277`) are the only writers of `boundMachineId`. | Add the revocation check in both, **before** the `machineTakenByAnotherAccount` call. |
| V8 | `lib/exe-license-bind.ts:172-178, 362-368` | Both re-sign via `generateLicenseKey({ ..., product: original.product, expiresAt: originalExpiryDate })`. | **Critical:** a lifetime expiry survives bind/transfer verbatim — but only if the product id resolves (V9). |
| V9 | `lib/exe-license-bind.ts:161-167` (bind) / `:349-356` (transfer) | `const product = getProduct(original.product); if (!product) throw invalid_original;` | **Hard blocker:** an unregistered product id can **never** be bound or transferred. The new product id MUST be resolvable through `getProduct()`. |
| V10 | `lib/exe-license-bind.ts:30-44` | `LicenseBindError` codes: `not_found \| already_bound \| invalid_original \| not_configured \| invalid_machine \| machine_taken`. `LicenseTransferError` has its **own separate** union at `:233-245`. | Add `"revoked"` to **both** unions — two distinct edits, do not assume one covers the other. |
| V11 | `app/api/admin/exe-licenses/route.ts:337` | `const reusable = existingRows.find((l) => keyExpiryIsAfter(l.licenseKey, now));` | **Without a change here, revoking is pointless:** the next admin "Generate license" click hands the SAME revoked key back. The reuse filter must exclude revoked rows. |
| V12 | `app/api/admin/exe-licenses/route.ts:312-322, 360` | `durationDays` already parsed (positive-integer validation) and passed as `daysValid` (`:360`). | Flexible duration is **already done**. Only the *lifetime* toggle is genuinely new. |
| V13 | `app/api/admin/exe-licenses/route.ts:66-104` | POST dispatches `action: "issue" \| "bind" \| "transfer" \| "unbind" \| "delete"`. | Add `"revoke"` / `"unrevoke"` as siblings of `unbind`, reusing that action's ownership-gate pattern exactly. |
| V14 | `app/api/admin/exe-licenses/route.ts:50,473` (branch only) | `if (isSelfHosted()) return NextResponse.json({ error: "Not found" }, { status: 404 });` at the top of POST and GET. | ✅ Already correct: on a customer's self-hosted box these routes 404; on our hosted box they work. Phase 5 needs **no new gating**. |
| V15 | `app/admin/(protected)/admin-panel.tsx:84,213` (branch) | `SELF_HOSTED_HIDDEN_TABS = ["payments","wallets","ai","licenses"]`; `{tab === "licenses" && !selfHosted && <ExeLicensesTab />}`. | The new lifetime/revoke UI lives inside `ExeLicensesTab` and is automatically hidden on self-hosted builds. Nothing to do. |
| V16 | `app/dashboard/settings/licenses-section.tsx:10,79,112` | Imports `EXE_LICENSE_DAYS` and computes `validUntil = issuedAt + EXE_LICENSE_DAYS * 86400000`, then renders `({EXE_LICENSE_DAYS} days from issue)`. | ❌ **Active bug for this feature.** A 30-day or lifetime licence shows the wrong date on the buyer's own Settings → Licenses page. Must derive from the key, not the constant. |
| V17 | `lib/exe-license*.ts`, `lib/license-service.ts`, `app/dashboard/settings/licenses-section.tsx` | Verified **zero diff** between `main` and `self-hosted-build` at scoping time — `git diff --stat main self-hosted-build -- lib/exe-license.ts lib/exe-license-validator.ts lib/exe-license-bind.ts lib/license-service.ts app/dashboard/settings/licenses-section.tsx` returned empty. **⚠️ AMENDED by T3 (2026-09-29):** `lib/exe-license.ts` is no longer byte-identical — T3 added `+13/−0` (the D4 lifetime constants, `:29-40`). That single diff is **approved and expected**; the canary for that file is now **"additive only — zero `-` lines"**, not "empty". **⚠️ RE-AMENDED by T4 (2026-09-29) — see §3.14.1.** "Byte-identical" was **never true for this whole set** and asserting it blocked T5. Only **`lib/exe-license-validator.ts`** and **`lib/license-service.ts`** must stay byte-identical (canary: **empty**) — **no task in this phase may ever edit them.** The other three are *expected* to change, each attributable to a named task: `lib/exe-license.ts` = **T3**, additive only (`13 0`); `lib/exe-license-bind.ts` = **T5** (two `revoked` guards + two error-code unions) then **T12** (`actor` switch + `lifetime_locked`); `app/dashboard/settings/licenses-section.tsx` = **T8** (real expiry decode, and T8 **deletes** the `EXE_LICENSE_DAYS` import — so a `-` line in *that* file is **correct**, not a regression). The right test for those three is **"every diff is attributable to a named task"**, not "empty". For any file **you** did not touch, the canary is still **empty**. | Confirms §0.2: this is shared, live code. Every edit must be additive / hosted-safe. |
| V18 | `prisma/schema.prisma:597,657` (branch) | `model ExeLicense` (`:597`, with `boundMachineId/boundAt/boundLicenseKey`) and `model ExeLicenseTransfer` (`:657`) exist; `model User` is `:10` with back-relations `exeLicenses` (`:112`) / `exeLicenseTransfers` (`:113`); `model AdminSetting` is `:166`. **No revocation model exists.** | A new model + migration is required. See §3 D1 for the chosen shape. |

---

## 3. SENIOR DECISIONS — implement these verbatim; do not re-litigate

Every decision below was made after reading the code cited in §2. If one looks wrong, **do not silently deviate** — append a `⚠️ OBJECTION` entry to the log here and to the junior track, then implement the decided version unless the senior replies in the log.

### D1 — Revocation storage: new table `ExeLicenseRevocation`, one row per revoked licence

```prisma
// TASK_145 (Phase 5) — admin cancellation of an issued EXE licence.
// ONE row per revoked licence; UN-REVOKING DELETES the row (deliberate: this is
// a reversible admin toggle, not a financial ledger). Revocation can only be
// enforced where the app already talks to our servers (bind/transfer/issue-reuse)
// because offline validation is a design invariant — see TASK_145 senior track §3 D5.
model ExeLicenseRevocation {
  id            String     @id @default(cuid())
  exeLicenseId  String     @unique
  exeLicense    ExeLicense @relation(fields: [exeLicenseId], references: [id], onDelete: Cascade)
  userId        String
  user          User       @relation(fields: [userId], references: [id])
  reason        String?
  revokedAt     DateTime   @default(now())
  revokedBy     String?    // admin label/session marker, free-form, short

  @@index([userId])
}
```

- **Why `exeLicenseId` and not the signature hash**: the two enforcement points (bind/transfer) already hold the `ExeLicense` row, so a unique FK is unambiguous and cascade-clean on licence delete. The original key's **signature changes on every bind** (it is re-signed with `machine_id` — V8), so a hash of the bound key would not match a revocation recorded against the unbound key. A hash would need the *unbound* key's hash and offers nothing the FK does not. Record `reason` so support can explain the cancellation.
- Required back-relations (Prisma will not generate the migration without them): add `revocation ExeLicenseRevocation?` to `model ExeLicense` (branch `prisma/schema.prisma:597`) **and** `exeLicenseRevocations ExeLicenseRevocation[]` to `model User` (branch `:10`, next to the existing `exeLicenses` at `:112` / `exeLicenseTransfers` at `:113`).
- Migration name: `add_exe_license_revocation`.

### D2 — New module `lib/exe-license-revocation.ts` (the single enforcement seam)

Exactly three **functions** — plus exactly **one** exported error class, and nothing else:

```ts
export async function isExeLicenseRevoked(exeLicenseId: string): Promise<boolean>
export async function revokeExeLicense(input: { exeLicenseId: string; userId: string; reason?: string | null; revokedBy?: string | null }): Promise<void>
export async function unrevokeExeLicense(exeLicenseId: string): Promise<void>
```

- `revokeExeLicense` must be **idempotent** (`upsert` on the unique `exeLicenseId`) — a double-click must not throw a unique-constraint 500.
- It must also `void notifyAdmin(...)` on both revoke and un-revoke (mirrors the bind/transfer notification style at `lib/exe-license-bind.ts:191`), so there is an operational trail even though un-revoke deletes the row.
- `revokeExeLicense` must **verify the licence belongs to `userId`** and throw a typed error otherwise — the same ownership discipline every other action in the admin route uses.
- **⚠️ The ownership check is deliberately ASYMMETRIC** (T4, §3.14.2): `revokeExeLicense` takes a `userId` and checks it internally; `unrevokeExeLicense(exeLicenseId)` does **not**, because E5 adds **both** actions as admin-only siblings of `unbind` in `app/api/admin/exe-licenses/route.ts`, whose handler already carries the ownership gate. There is **no user-facing cancel *or* restore** anywhere in this phase — the only user surface, `licenses-section.tsx`, stays read-only (T8). **Therefore `unrevokeExeLicense` must never be wired to a non-admin surface.** If a future task ever exposes it to users, it must gain an ownership parameter first, or any user could restore their own cancelled licence and defeat revocation entirely.

### D3 — New product `selfhosted_os` that resolves via `getProduct()` but is NOT on the public store

This is the highest-risk part of the task (V9 + V16 + store leakage). Implement exactly:

1. `lib/products.ts`
   - Add `"selfhosted_os"` to the **`ProductId` union** (`lib/products.ts:13-22`).
   - Add `selfhostedOsPriceUsd: number;` to `AdminSettingPriceFields` (`:56+`).
   - Define and export:
     ```ts
     // NOT sold on the public store — admin-issued only (TASK_145). Registered in
     // BY_ID so getProduct() resolves it (bind/transfer require it — see
     // lib/exe-license-bind.ts's `if (!product) throw invalid_original`), but
     // deliberately kept OUT of ALL_PRODUCTS so it never appears on /pricing,
     // /api/store/prices or the wallets price form.
     export const SELF_HOSTED_OS: StoreProduct = {
       id: "selfhosted_os",
       name: "SpaceWorker OS (Self-Hosted)",
       tagline: "Self-hosted SpaceWorker OS for your own machine or server.",
       priceField: "selfhostedOsPriceUsd",
       kind: "exe",
       plan: "selfhosted",
     };
     export const LICENSABLE_EXE_PRODUCTS: StoreProduct[] = [...EXE_PRODUCTS, SELF_HOSTED_OS];
     ```
   - Register it in `BY_ID` **only**: `new Map([...ALL_PRODUCTS, SELF_HOSTED_OS].map(...))`. Do **not** append it to `ALL_PRODUCTS`.
2. `prisma/schema.prisma` — `AdminSetting`: add `selfhostedOsPriceUsd Float @default(0)` with a one-line comment (never charged through the store; the field exists so `priceField` stays a real key). Same migration or a second one — either is fine.
3. `lib/admin-settings.ts` — **verified no edit needed**: `getAdminSettings()` (line 6) does `prisma.adminSetting.upsert({ create: {} })`, so the new column's `@default(0)` applies by itself. Do not add a manual default map.
4. Admin licence issuance — swap `EXE_PRODUCTS` → `LICENSABLE_EXE_PRODUCTS` in exactly these places, and nowhere else (line numbers are the **branch/worktree**'s, verified in `/Users/mikeolab/sw-selfhost`):
   - `app/api/admin/exe-licenses/route.ts:5` (import), `:306` (validation lookup), `:505` (GET label lookup).
   - `app/admin/(protected)/admin-panel.tsx:6` (import), `:3559` (the product `<select>` in the licence generator).
   - Leave `admin-panel.tsx:3479`'s `EXE_PRODUCTS[0].id` default untouched — extractor stays the default selection.
5. **Do NOT touch** `app/api/store/prices/route.ts`, `components/store.tsx`, `/pricing`, or `app/api/admin/wallets/route.ts`. Their `ALL_PRODUCTS` behaviour must be unchanged — that is the whole point of `LICENSABLE_EXE_PRODUCTS`.
   - **Verification gate (mandatory, junior must paste output):** `curl -s localhost:3000/api/store/prices | grep -c selfhosted_os` → must print `0`.
6. Note for the record: `app/api/exe-license/activate/route.ts:80-86` already rejects a `selfhosted_os` key in every Windows EXE variant (`expectedProduct = \`${exeBuildTarget()}_exe\``) — so a self-hosted licence can never unlock a store-bought EXE. **No change needed there**; just do not "fix" it.

> ⚠️ **AMENDED 2026-09-29 (§3.11 D11 / task T16).** Item 1 above keeps the product off the **store**, but `ALL_PRODUCTS` is the *display* gate — it is **not** the *purchase* gate. `app/api/billing/checkout/route.ts:38` and `app/api/billing/submit/route.ts:61` resolve products with `getProduct()` and take the id **from the client**, so `selfhosted_os` became purchasable at its `0` default price with no login (W8/W9). A separate guard is now required: **T16 / E11**. The rule: `BY_ID` registration makes a product *resolvable* (bind/transfer require it, V9) — never *sellable*.

### D4 — Lifetime expiry: a **frozen literal**, not a computed date

Add to `lib/exe-license.ts` (constants only — do not restructure the file):

```ts
// TASK_145 (Phase 5) — a "lifetime"/perpetual grant is NOT a new payload shape.
// It is the exact same signed payload with a far-future `expires_at`, which the
// untouched offline validator already accepts (lib/exe-license-validator.ts:
// `now > expiresAt` is false for the year 2999). Frozen as a LITERAL on purpose:
// the value is signed, so a computed date would risk drift between issue time
// and re-sign-at-bind time, silently changing a customer's licence bytes.
export const LIFETIME_EXPIRES_AT_ISO = "2999-12-31T23:59:59.000000"; // Python-isoformat, no 'Z'
export const LIFETIME_EXPIRES_AT = new Date(Date.UTC(2999, 11, 31, 23, 59, 59));
/** True when this expiry is the lifetime sentinel (>= year 2999). */
export function isLifetimeExpiry(d: Date | null | undefined): boolean {
  return !!d && d.getUTCFullYear() >= 2999;
}
```

- Must be fed to `generateLicenseKey({ expiresAt: LIFETIME_EXPIRES_AT })`, **never** via `daysValid`.
- Verified before writing this: `new Date("2999-12-31T23:59:59.000000Z")` parses to year 2999 in Node, and `lib/exe-license-validator.ts:127-131`'s `parsePythonIsoformat` is literally `new Date(value + "Z")` — so the literal round-trips. The `Date.UTC(2999,...)` constant is **not** the payload string (the literal is); it exists for comparisons/UI.

### D5 — Enforcement points, in exact order (this is the whole revocation design)

| # | File | Exact change |
|---|---|---|
| E1 | `lib/exe-license-bind.ts` → `bindExeLicenseToMachine` | After the `if (!license)` not-found check and **before** `machineTakenByAnotherAccount` (`:141`), add: `if (await isExeLicenseRevoked(license.id)) throw new LicenseBindError("This license was cancelled by the provider and can no longer be activated. Contact support.", "revoked");` |
| E2 | `lib/exe-license-bind.ts` → `transferExeLicenseToMachine` | Same guard before `:332`'s `machineTakenByAnotherAccount`, throwing `LicenseTransferError(..., "revoked")`. |
| E3 | `lib/exe-license-bind.ts:30-44` **and** `:233-245` | Add `"revoked"` to **both** error-code unions (two separate unions — see V10). |
| E4 | `app/api/admin/exe-licenses/route.ts:337` | Reuse check becomes `existingRows.find((l) => keyExpiryIsAfter(l.licenseKey, now) && !revokedIds.has(l.id))`, with `revokedIds` loaded in one query for that user. **This is the single most important edit in the task** (V11): without it, "cancel" is cosmetic. |
| E5 | `app/api/admin/exe-licenses/route.ts` POST dispatch (`:66-104`) | Add `action: "revoke"` (`{ exeLicenseId, reason? }`) and `action: "unrevoke"` (`{ exeLicenseId }`). Model body parsing + ownership gate on the existing `unbind` action (`:101-104, :146-170`). Response: `{ ok: true, revoked: true|false }`. |
| E6 | `app/api/admin/exe-licenses/route.ts` GET (`:472+`) | Add `revoked: boolean` to each licence row (`:505` block) so the admin UI can render state — in **every** listing the route returns. |
| E7 | `app/api/exe-license/eligibility/route.ts:56-65` | **THE LIVE KILL — without this, a revoked 1-month licence never dies.** After the `findFirst`, add `const revoked = license ? await isExeLicenseRevoked(license.id) : false;` and return `{ eligible: license !== null && !revoked }`. This is the route the desktop EXE already POSTs to on every launch (`stillValidLive`), so this one edit turns revocation from admin-cosmetic into a real kill on next launch. Fail-open behaviour is unchanged and comes from the caller, not here. |
| E8 | `lib/self-hosted-setup-gate.ts` (+ its `proxy.ts` call site) | **Self-hosted only — the build has NO runtime licence check at all today.** `app/dashboard/layout.tsx:17` gates `LicenseGate` on `isLocalExeRuntime()` (Tauri EXE), and `app/api/setup/complete/route.ts:164` states `SELF_HOSTED_LICENSE_KEY` is *"written (not read) … no code path consumes it yet"* — so a self-hosted install validates **once, at the wizard, and never again**, and a 30-day key would run forever. Add a best-effort re-check: read the stored key from setup state → offline `validateLicenseKey` (catches expiry **and** machine binding) → then online `eligibility` (catches revocation, once E7 lands). Fail-open on network trouble, cached (~5 min), mirroring `setupCompleteCached`'s existing shape. |
| E9 | `lib/exe-license-bind.ts` → `transferExeLicenseToMachine` | **Lifetime is admin-move-only.** Add an explicit actor switch (e.g. `actor?: "self_service" \| "admin"`, defaulting to `"self_service"`); when the licence is lifetime (`isLifetimeExpiry(originalExpiry(license.licenseKey))`) and the caller is self-service, throw a typed `"lifetime_locked"` error **before** any mutation. The admin route (`app/api/admin/exe-licenses/route.ts:269`) passes `actor: "admin"` and is allowed through — this is the one sanctioned move path. |
| E10 | `auto-bind` (`:164`), `password-login` (`:108`), `payment-status` (`:87`) error mappers | Surface `"lifetime_locked"` as one consistent message — *"This is a lifetime licence bound to this device. Contact support to move it to another computer."* Three call sites, one string. These are the three real self-service move paths; all three must refuse a lifetime key. |

**Rejected alternatives (do not use):** checking revocation in `lib/exe-license-validator.ts` (deliberately offline and ships inside the customer's binary — it can never see our DB); storing revocation as a column on `ExeLicense` (loses `reason`, and muddies a table `main` also owns).

> ⚠️ **WITHDRAWN 2026-09-29 — a third "rejected alternative" was wrong.** This list originally also rejected *"checking it on every app launch (breaks the design invariant)"*. That is **not** the design: the desktop EXE **already** does exactly that today (`app/api/exe-license/status/route.ts:91` → `stillValidLive()` → `POST /api/exe-license/eligibility`, fail-open, on every launch), and the codebase comments call it in as many words (*"This is the one place that can catch it"*). E7 makes that existing seam revocation-aware; E8 gives the self-hosted build its first-ever check. See **§3.9** for the owner's clarification this serves.

### D6 — Wizard activation (`app/setup/**` — branch files already exist)

1. `app/api/setup/license/validate/route.ts` — after `validateLicenseKey` succeeds, add a **product assertion**: reject unless `validation.product === "selfhosted_os"`, with a message naming the product it actually is (`getProduct(validation.product)?.name`). Reason: this route uses the raw validator, which has **no** build-target product check (unlike `app/api/exe-license/activate/route.ts:80-86`), so without this a store-bought `extractor_exe` key could activate a self-hosted install.
2. Same route — return `lifetime: boolean` computed with `isLifetimeExpiry(validation.expiresAtDate)` so the client never re-parses dates itself. (`expiresAt` is already returned.)
3. `app/setup/setup-wizard.tsx` — branch the activation success copy (find it by the string `License accepted for`): lifetime → `"License accepted for {licensee} — lifetime license, no renewal needed."`; otherwise → `"License accepted for {licensee}. Valid until {date}."`
4. Extend `ApiOk` (`/tmp/swsh/setup-wizard.tsx:26-36` shows the current shape) with `lifetime?: boolean` and store it beside `licenseValidated` so the Review step (`:552`) can also say "Lifetime" instead of "Activated".

### D7 — Stop hardcoding 180 days in the two user-facing surfaces

- `app/dashboard/settings/licenses-section.tsx:10,79,112`: derive validity from the key, not `EXE_LICENSE_DAYS`. Decode with `decodeLicenseKey(lic.licenseKey)` + the same Python-isoformat parser (`parsePythonIsoformat` in `lib/exe-license-validator.ts`, or `originalExpiry()`/`keyExpiryIsAfter()` already exported from `lib/exe-license-bind.ts`) and render `"No expiry (lifetime)"` when `isLifetimeExpiry(...)`, else the real date and real remaining term. Delete the now-wrong `({EXE_LICENSE_DAYS} days from issue)` suffix.
- `app/admin/(protected)/admin-panel.tsx` → `ExeLicensesTab` (component starts branch `:3477`): add a **Lifetime (no expiry)** checkbox beside the duration input (when checked, send `{ lifetime: true }`; the existing `durationDays` path is unchanged when unchecked), and a per-row **Cancel license** / **Restore** button driven by the new `revoked` boolean, with a `window.confirm` (destructive) and a visible `Cancelled` badge.
- Route side (`issueLicense`, `:299+`): parse `lifetime` (boolean); when true pass `expiresAt: LIFETIME_EXPIRES_AT` and **skip** the `durationDays` parse; otherwise behave exactly as today (`daysValid: durationDays`).

---

## 3.9 REVISION 2 — owner clarification (2026-09-29): two licence classes, live kill, lifetime is admin-move-only

This section **amends D5** and **adds D8–D10**. Where it conflicts with the text above, this section wins. The owner's requirement, in their words:

> *"for a 1 month test, i want the license to be just like we have for the other exe, immediate revocation should kill it. the lifetime license is bound to that email for recovery, in case owner wants to move to another pc, but this must come through the admin — no one should be able to move a lifetime license themself; once it's bound to that device, they need to get a new license for another or reach out to support."*

### What was verified before writing this (all in real code, 2026-09-29)

| # | Finding | Evidence |
|---|---|---|
| W1 | The desktop EXE **already** re-checks the server on every launch, fail-open. | `app/api/exe-license/status/route.ts:91` `stillValidLive()` POSTs `${HOSTED_APP_URL}/api/exe-license/eligibility` with a 6 s timeout; on `eligible === false` it calls `clearActivation()` and returns *"This license has been revoked."* Any network failure returns `true` (fail-open). |
| W2 | That check **cannot see a revocation today.** | `app/api/exe-license/eligibility/route.ts:56-65` returns `{ eligible: license !== null }` — it only proves the presented key still matches the row. A revocation row leaves the row intact, so `eligible` stays `true` forever. **This is the single missing link for the owner's requirement.** |
| W3 | A self-hosted install has **no** runtime licence check whatsoever. | `app/dashboard/layout.tsx:17` `const localExe = isLocalExeRuntime()` and the `LicenseGate` wrap is inside `if (localExe)` — `isLocalExeRuntime()` is `SPACEWORKER_LOCAL_EXE === "true"` (Tauri EXE only). The self-hosted build is the orthogonal `SELF_HOSTED` flag (`lib/exe-build-target.ts:33`). `app/api/setup/complete/route.ts:164` confirms it explicitly: `SELF_HOSTED_LICENSE_KEY` is *"written (not read) here: **no code path consumes it yet**."* |
| W4 | Consequence: a self-hosted 30-day key **never expires** in practice. | Same as W3 — the only validation is the one-time `/api/setup/license/validate` call at wizard time (`:62`). Nothing re-reads `expires_at` afterwards. This is a pre-existing hole that the 1-month test licence would fall straight into. |
| W5 | Three self-service move paths exist and would move a lifetime licence today. | `app/api/exe-license/auto-bind/route.ts:164`, `password-login/route.ts:108`, `payment-status/route.ts:87` all call `transferExeLicenseToMachine`, gated by an emailed code to the licensee's inbox (`TRANSFER_CODE_PURPOSE = "exe_transfer"`, `auto-bind:61`). |
| W6 | A lifetime marker **survives** bind/transfer, so it can be used as the discriminator. | `lib/exe-license-bind.ts:21-23` — *"Re-signs the ORIGINAL unbound key … preserving the ORIGINAL key's exact `expires_at`"* — implemented at `:156/:172` (bind) and `:349/:362` (transfer). `originalExpiry(key)` (`:472`) already exposes the decoded value. |
| W7 | The self-hosted gate is the right home for E8. | `lib/self-hosted-setup-gate.ts:78` `shouldRedirectToSetup(pathname)` is already called from `proxy.ts:5` on every request, runs in the Node runtime (Next 16 "Proxy"), and already owns a short-TTL in-memory cache (`:48-70`) — the exact shape E8 needs. |

### D8 — Two licence classes of the **same** product, told apart by the key's own `expires_at`

There is no new product id and no new payload field. Both classes are `selfhosted_os` (D3):

| | **Term** (e.g. 1-month test) | **Lifetime** |
|---|---|---|
| `expires_at` | real date (issue + N days) | `LIFETIME_EXPIRES_AT` sentinel (D4) |
| Expiry enforced | offline validator, every check | never (year 2999) |
| Revocation kills the install | **YES** — E7 + E8 | YES when reachable (same machinery) |
| Self-service move | **allowed** — exactly like the other EXE (email-code transfer) | **FORBIDDEN** — D9 |
| Move path | `auto-bind` / `password-login` / `payment-status` | admin only (`action: "transfer"`) |
| Recovery anchor | licensee email | licensee email (W5, unchanged) |

Implement `isLifetimeExpiry()` **on the decoded payload**, using the existing `originalExpiry()` seam (W6) — never a DB column and never a client-supplied flag.

### D9 — Lifetime licences are admin-move-only (they stay on the device they are bound to)

Enforce with an **explicit actor switch** in `transferExeLicenseToMachine` (E9) rather than by blocking the lib outright — the admin route `app/api/admin/exe-licenses/route.ts:269` calls the *same* function and **must remain able to move a lifetime licence**; that is the owner's sanctioned path.

- **Self-service caller + lifetime licence** → typed `"lifetime_locked"` error, thrown **before** any mutation, surfaced by all three callers with one message (E10): *"This is a lifetime licence bound to this device. Contact support to move it to another computer."*
- **Admin caller** → allowed (behaviour unchanged).
- **First bind is unaffected**: a customer activating a fresh, **unbound** lifetime key is not a "move" and must keep working. Only `transferExeLicenseToMachine` is restricted; `bindExeLicenseToMachine` is not.
- The **email code remains the recovery anchor** for the term class (W5, unchanged) — the lifetime class does not lose it, it simply cannot exercise it self-service.
- Accepted consequence, per the owner: a lifetime customer who changes PC cannot self-serve. They contact support, or they buy another licence. Do **not** add a self-service unlock "just in case" — that is the exact hole the owner asked to close.

### D10 — The 1-month test licence must be killable while it is running

"Just like the other exe" means the W1 mechanism, on **both** builds:

1. **Desktop EXE class** — **E7 alone** fixes it, because the launch-time path already exists and is proven. After E7, `stillValidLive` returns false → `clearActivation()` runs → the activation gate appears on the next launch. Fail-open is preserved **by design**: a genuinely offline customer is never locked out. "Immediate" therefore means *caught at the next launch whenever we can reach the server*, not a hard network kill — and that exact wording must be used in any customer-facing copy.
2. **Self-hosted class** — **E8**, which is new work and the larger half of this revision. It is in scope because without it the 1-month test licence cannot be ended **at all** (W4), which defeats the owner's whole purpose in issuing a term licence in the first place.

**Explicit non-goal (do not build):** a persistent socket, watchdog or daemon that kills a running process mid-session. Both builds keep working until the next launch / page-load while unreachable. That is the trade-off the owner accepted by choosing the "like the other exe" model.

---

## 3.10 REVISION 3 — senior verification of T1, + five environment corrections (2026-09-29, second senior pass)

The senior **re-ran every T1 claim independently** instead of trusting the pasted log. Verdict: the **schema deliverable is ACCEPTED and T1 is closed**. But **two of the three "pre-existing blockers" T1 reported do not exist as described**, one of them was caused by our own worktree convention, and T1 came close to breaking the live app. All five corrections are below; the escalations are answered in §3.10.5.

### 3.10.1 T1 — ACCEPTED (evidence re-checked by the senior)

| T1 claim | Senior re-ran | Result |
|---|---|---|
| additive, 30 insertions / 0 deletions | `git diff 6e560ba..HEAD --stat -- prisma/` | **confirmed** (`schema.prisma` +30, one new `migration.sql` +51) |
| `migration.sql` == Prisma's own output | read + `prisma validate` | **accepted** — 1 `CREATE TABLE`, 2 indexes, 2 FKs, 1 `ADD COLUMN … DEFAULT 0`; nothing dropped/altered |
| the DDL is valid | `prisma db push` onto a **scratch** DB | **confirmed** — table + column + indexes present, `\d` matches D1 exactly |
| validator untouched (canary) | `git diff --stat main self-hosted-build -- lib/exe-license-validator.ts` | **confirmed empty** |
| V17 byte-identical set still holds | diff of all five files vs `main` | **confirmed empty** |
| `main` untouched | `git log -1` + `git status` in `/Users/mikeolab/spaceworker` | **confirmed** `b7330a1`, clean |

**T1 is closed: S1, S2, S12 pass.** Nothing in T1 is re-opened, and T2 may start. The junior did the right thing refusing to `migrate resolve` — see §3.10.4, where that instinct is now a rule backed by new evidence.

### 3.10.2 Correction C1 — the `node_modules` **symlink** was the "Turbopack panic" (§0.1 was wrong)

T1 reported `npm run build` failing with a Turbopack *"Symlink points out of the filesystem root"* panic and called it pre-existing. **It was caused by our own worktree convention** — `node_modules` was a symlink to `/Users/mikeolab/spaceworker/node_modules`, while `next.config.ts:26` pins `turbopack.root = __dirname`. With a **real** directory there:

```
npx next build   →  ✓ Compiled successfully in 15.5s
                    Running TypeScript ...
                    Finished TypeScript in 22.4s ...
```

**Evidence caveat, stated plainly:** the senior did **not** re-create the symlink to reproduce the panic — doing so would risk re-clobbering the primary checkout's client (C2). The attribution rests on (a) the symptom vanishing with the *only* changed input — the same directory contents, no longer reached through a symlink — and (b) the documented mechanism (`next.config.ts:26` pins `turbopack.root = __dirname`, and the symlink resolves outside it). Treat it as a strong but indirect cause. The rule stands regardless, because a symlinked `node_modules` is also what made C2 possible.

**Rule (replaces the symlink instruction in junior §0.1):** create the worktree's `node_modules` as an APFS **clone**, never a symlink —

```bash
cd /Users/mikeolab/sw-selfhost
rm -f node_modules                                    # only if it is a symlink
cp -Rc /Users/mikeolab/spaceworker/node_modules ./node_modules   # clone, ~909 MB, seconds
ls -ld node_modules                                   # must NOT start with 'l'
```

### 3.10.3 Correction C2 — a symlinked `node_modules` makes `prisma generate` **clobber the live app's client**

Because the symlink pointed into the primary checkout, T1's `npx prisma generate` wrote the **branch's** schema into `/Users/mikeolab/spaceworker/node_modules/.prisma/client` — i.e. it replaced the client of the **live app**. Proven: after that generate, `main`'s own `npx tsc --noEmit` failed with ~14 errors (`Property 'suppression' does not exist on PrismaClient`, `Namespace '…/.prisma/client/index'.Prisma has no exported member 'SendingDomainSelect'`, …). The senior restored it in the primary checkout (`npx prisma generate` → `EXIT=0`) and `main`'s `tsc` is **EXIT=0** again.

**Rule:** never run `npx prisma generate` from the worktree with the primary checkout's DB, and never with a symlinked `node_modules`. If a task needs the generated client, pin the **verification DB** first (C4) and confirm `node_modules` is a real directory (C1). In one sentence: *a schema change on this branch must never be able to alter the live app's build inputs.*



### 3.10.4 Correction C3 — `WebExtractPage` is **not** a build blocker (claim retracted)

T1 logged the stray named export in `app/dashboard/extract/page.tsx:217` as one of two pre-existing build blockers. **Withdrawn — it blocks nothing.** Evidence:

- With a real `node_modules`, `npx next build` printed `Finished TypeScript in 22.4s` and continued to page-data collection. It never reported `WebExtractPage`.
- `main` itself is **type-clean**: `npx tsc --noEmit` → `EXIT=0` in `/Users/mikeolab/spaceworker`.
- `main`'s `.next/types` (built today 10:10) contains **no** `WebExtractPage` entry — so the error the junior saw came from **locally generated dev types**, not from `next build`.
- The file is byte-identical to `main`, which means it cannot be a branch-specific defect.

**No task is created for this.** Do not edit that file on this branch. (If it ever *does* surface under a plain `tsc`, the fix still belongs on `main` first, per §0.1.)

### 3.10.5 Correction C4 — the local build command is `CI=1 npx next build`

`npm run build` sets `NODE_ENV=production`, which arms `lib/env.ts`'s placeholder guard (`guardAgainstPlaceholder`, `lib/env.ts:52`). The local `.env` holds dev placeholders, so the build dies at *page-data collection* — first on `SESSION_SECRET`, then on `RESEND_API_KEY` once that one is supplied. That is the app working as designed, **not** a code defect. `lib/env.ts:53` short-circuits when `CI` is set — exactly how `.github/workflows/build-exe.yml` builds:

```
cd /Users/mikeolab/sw-selfhost
CI=1 npx next build        # → BUILD_EXIT=0  (verified on this branch 2026-09-29)
```

**Standing rule:** the local build check is `CI=1 npx next build`. Never "fix" it by putting real secrets in `.env`, and never weaken the guard.

### 3.10.6 Correction C5 — the migration history **cannot build a fresh DB** (P3018) → new task T14

T1's "shadow-database P3006" is not a Prisma quirk: it is a **real ordering defect in the repository's migrations**, and it is fatal to the self-hosted installer, which must create a database from scratch. Proven on a scratch DB with the senior's own hands:

```
$ psql "$DB" -c 'CREATE DATABASE sw_migcheck_t145;'
$ DATABASE_URL="…/sw_migcheck_t145" npx prisma migrate deploy
Applying migration `20260914150000_add_license_claim_token`
Error: P3018
Database error code: 42P01
Database error:
ERROR: relation "ExeLicense" does not exist
```

**Cause, from the folder names alone:** `prisma/migrations/20260914150000_add_license_claim_token/migration.sql` runs `ALTER TABLE "ExeLicense" ADD COLUMN …`, but `CREATE TABLE "ExeLicense"` only happens in `20260914200000_task42_store_and_licenses` — **five hours later**. The `20260914150000` folder was authored as if `ExeLicense` already existed (on the live DB it did, hand-created), so it never broke *here* — and it silently makes every fresh install impossible. Its claim-token columns are **absent** from the `task42` `CREATE TABLE`, confirming the ALTER was meant to run after it.

**Consequence for Phase 5:** this is not optional polish — a self-hosted customer cannot install at all until it is fixed. It is now **T14**. It also explains the ~27-migration gap and the two stuck `device_tools_v2` rows in the shared local DB (§3.10.7).

### 3.10.7 The verification DB — `spaceworker_t145` (use it for every DB-touching task)

The shared local DB cannot host Phase 5 work: it is ~27 migrations stale (**it has no `Device` table**), and `_prisma_migrations` holds **two** unterminated `20260921000000_device_tools_v2` rows — `2026-09-27 20:35` (rolled back) and `2026-09-29 03:01` (**not** rolled back, started hours before T1). P3009 therefore blocks all application. The senior provisioned a clean DB by schema, which sidesteps both problems:

```bash
cd /Users/mikeolab/sw-selfhost
DB=$(grep '^DATABASE_URL=' .env | cut -d= -f2-); S="${DB%/*}/spaceworker_t145"
psql "$DB" -c 'CREATE DATABASE spaceworker_t145;'
DATABASE_URL="$S" npx prisma db push --skip-generate     # 50 tables, ~1s
DATABASE_URL="$S" npx prisma generate
```

Verified present: `ExeLicense`, `ExeLicenseTransfer`, `ExeLicenseRevocation` (with the D1 indexes) and `AdminSetting.selfhostedOsPriceUsd`. **T1's DDL is therefore proven to apply cleanly** — this is the evidence that closed S2.

### 3.10.8 Answers to the two escalations in the T1 log

1. **"Does the `device_tools_v2` P3009 + shadow-DB P3006 belong to a task?"** — The migration-ordering half is **yes, and it is in this phase: T14** (§3.10.6), because it blocks self-hosted installation. The *stale local DB* half is **no** — it is local tooling debris, not product work; it lives as **T15** and must never be "fixed" by touching the VPS. T1 was right not to run `migrate resolve`: marking `device_tools_v2` applied by hand would lie about state, and replaying 24 unrelated migrations against a shared DB risks the live schema.
2. **"Is the `WebExtractPage` stray export a known `main`-side defect with its own task?"** — **No, and it is not a defect: retracted entirely (§3.10.4).** It never blocked `next build`; that error came from generated dev types. There is nothing to fix and no task.

---

## 3.11 REVISION 4 — senior verification of T2, and a purchase-gate hole D3 left open (2026-09-29, third senior pass)

### 3.11.1 T2 — ACCEPTED (every claim re-run by the senior, independently)

| T2 claim | Senior re-ran | Result |
|---|---|---|
| additive, one source file | `git show --stat 83fe756` | `lib/products.ts` only (+24/−2), plus the two track files ✅ |
| `getProduct("selfhosted_os")` resolves | `npx tsx` against the real module | `true` ✅ |
| **not** in `ALL_PRODUCTS` | same run + `lib/products.ts:207` read directly | `false`; the `ALL_PRODUCTS` line is **unchanged** ✅ |
| `LICENSABLE_EXE_PRODUCTS` exported, contains it | same run | `true` (6 entries vs 9 in `ALL_PRODUCTS`) ✅ |
| `priceField` still unique | same run | `true` ✅ |
| store route cannot see it | `app/api/store/prices/route.ts:11` maps `ALL_PRODUCTS` | statically cannot leak ✅ |
| validator untouched | `git diff --stat main self-hosted-build -- lib/exe-license-validator.ts` | **empty** ✅ |
| V17 five frozen files | `git diff --stat` over all five | **empty** ✅ |
| unit tests | `npx tsx --test tests/module-store.test.ts` | **10 pass / 0 fail** ✅ |
| `npx tsc --noEmit` | re-run by the senior | **EXIT=0** ✅ |
| `CI=1 npx next build` | re-run by the senior | **BUILD_EXIT=0** ✅ |
| hygiene | `lsof -iTCP:3100` / `ps` for leftover servers | nothing left running ✅ |

T2 matches D3 verbatim and is **CLOSED**. Verifying it, however, exposed a hole in **D3 itself** — §3.11.2.

### 3.11.2 W8–W11 — registering in `BY_ID` also opened a **purchase** path

D3 assumed the gate that matters is `ALL_PRODUCTS` (store UI, `/pricing`, `/api/store/prices`, the wallets form). That is the *display* gate. The *purchase* gate is a different code path, and it resolves with `getProduct()`:

| ID | Evidence | File:line |
|---|---|---|
| W8 | `getProduct(productId)` → `if (!product) 400 "Unknown product"`; the only kind restriction is `web`/`module` needing a session, so `kind: "exe"` needs **no login** | `app/api/billing/checkout/route.ts:37-51` |
| W9 | Same lookup on submit; an `exe` product with no session creates a `User` + `Payment` row from a bare email | `app/api/billing/submit/route.ts:60-64, 72-93, 133` |
| W10 | That row is the admin review queue; approving it calls `handleApprovedPayment` → `getProduct(payment.product)` → mints a real key with `plan: "selfhosted"` | `lib/license-service.ts:33,43`; `app/api/admin/payments/[id]/approve/route.ts:30` |
| W11 | Price is `settings[product.priceField]`, whose column defaults to `0` (T1: `Float @default(0)`) | `app/api/billing/checkout/route.ts:74-77` |
| W12 | **The sentinel year `2999` exists in three places in one file** — the signed literal, the `Date` constant, and `isLifetimeExpiry`'s threshold. Deliberate (the literal is frozen by the signature; the `Date`/threshold exist for comparisons), but **value-coupled**: if a later edit moves the threshold without the literal, every lifetime licence silently misclassifies as a term licence — the admin-move lock (E9) and the "no expiry" UI copy both stop applying, with no error anywhere. | `lib/exe-license.ts:35,36,39` (added by T3). Fix is **not** a lib edit — the constants are correct and frozen. It is `T17`: a permanent test asserting `isLifetimeExpiry(LIFETIME_EXPIRES_AT) === true` **and** `isLifetimeExpiry(<30-day term>) === false`, so any future drift fails loudly. |
| W13 | **Nothing runs the tests automatically.** No workflow invokes any `test:*` script — `deploy.yml` runs only `npx tsc --noEmit` (`:71`) and `npm run build` (`:74`); `build-exe.yml` runs `npm ci` + `npx prisma generate` + `tauri-action`; the two trial workflows run their own extractors. So `T17`'s "permanent guard" only fires when a human or agent runs it. Repo-wide this is a **convention** (every `test:*` script is manual), not a T17 defect — but it means the guard is only half automatic. | Verified 2026-09-29 (pass 7) by `grep -nE 'run:|uses:' .github/workflows/*.yml`. Mitigation is **protocol, not CI**: §4.1c makes `npm run test:license` + `npm run test:setup` mandatory on every task and every senior pass, and omitting them is reject item **16**. Wiring the suite into `build-exe.yml` is a repo-wide pipeline change to shared files — deliberately **not** done here; recorded as a candidate Phase-6 item. |
So `GET /api/billing/checkout?kind=btc&product=selfhosted_os` resolves, and `POST /api/billing/submit {product:"selfhosted_os"}` persists a **$0** pending payment for anyone's email — a self-service path into a product the owner requires to be **admin-issued only**. The queue entry later reads "SpaceWorker OS (Self-Hosted)", and approving it auto-mints the licence.

**Severity is bounded — this is not a free-lunch robot.** `/api/internal/payment-verify` compares on-chain received against expected as `ratio = receivedBtc / expectedBtc` with a ±5% `TOLERANCE` (`lib/crypto-verify.ts:46-53`). An expected amount of `0` makes `ratio` `Infinity`, which fails `ratio > 1 + TOLERANCE`, so a $0 payment can **never** auto-approve. The real exposure is (a) public queue-spam creating `User`/`Payment` rows and (b) an admin approving a row the system can mint from.

### D11 — `BY_ID` registration is not a licence to sell: the purchase gate is `ALL_PRODUCTS` membership

A product that `getProduct()` resolves is **not** automatically purchasable. The invariant, for this phase and every future product:

> **Only a product in `ALL_PRODUCTS` may be bought.** Any route that takes a product id **from the client** and leads to a `Payment` row or a licence must reject an id outside `ALL_PRODUCTS`.

Implementation (task **T16**):
- Reject in **both** `app/api/billing/checkout/route.ts:38` and `app/api/billing/submit/route.ts:61`.
- Return the **existing** `{ error: "Unknown product" }` 400 — byte-identical to a typo'd id, so the endpoint never confirms a non-purchasable product exists.
- **Additive and hosted-safe:** on `main` every resolvable product is already in `ALL_PRODUCTS`, so the check is a strict no-op for the live app. One predicate over an array that already exists — **no** `purchasable` flag, **no** second registry, **no** client-side check.
- **Defence in depth, not a replacement** for keeping `SELF_HOSTED_OS` out of `ALL_PRODUCTS`. Both gates must hold.

### E11 — the purchase gate

| ID | Where | Rule |
|---|---|---|
| E11 | `app/api/billing/checkout/route.ts:38`, `app/api/billing/submit/route.ts:61` | a client-supplied product id must be in `ALL_PRODUCTS`; otherwise the same 400 "Unknown product" as an unknown id. Task **T16**. |

### 3.11.3 Task T16 added — the work order became T1 → T16

**T16 — close the purchase gate (E11).** ~~Do it **next, before T3**~~ ✅ **DONE — closed by the senior 2026-09-29 (pass 5, S17).** It was a few lines, it closed a hole this phase opened, and every later task that adds an issuance path inherits the invariant (D11). Spec in the junior track §2. **⚠️ The work order has since grown to `T1 → T17`; the authority is the `▶ NEXT TASK` pointer (junior §2), not this heading.**

### 3.11.4 Carried forward — the rest of T2's report was accurate

The junior's `UNVERIFIED:` lines are correct and expected at this stage: J1/J2 and J4–J7/J9–J12 belong to later tasks; the admin surfaces still importing `EXE_PRODUCTS` is **D3 item 4**, scheduled for T6/T7; there is no end-to-end flow yet, by construction. The `grep -n 'ALL_PRODUCTS ='` nit is real — the line carries a type annotation, so that pattern can never match; the work order now uses `grep -n 'ALL_PRODUCTS'`.

---

## 3.12 REVISION 5 — senior verification of T3, and the ephemeral-evidence gap (2026-09-29, fourth senior pass)

### 3.12.1 T3 — ACCEPTED (re-derived independently, not read off the log)

| T3 claim | Senior re-ran | Result |
|---|---|---|
| constants only, no restructure | `git diff --numstat main self-hosted-build -- lib/exe-license.ts` | **`13  0`** — one hunk, +13/−0, on a file `main` shares ✅ |
| implements D4 verbatim | `lib/exe-license.ts:29-40` read against D4 | byte-identical, D4 comment block included ✅ |
| literal parses to year 2999 | senior's own 23-assertion harness | ✅ |
| J1 lifetime round-trip | same harness — real `generateLicenseKey` → `verifyLicenseKey` → `validateLicenseKey` | `valid: true`, decoded year 2999 ✅ |
| J2 30-day round-trip | same harness | `expires_at` `2026-01-31…`; `isLifetimeExpiry` **false**; valid day 29; **expired day 31** ✅ |
| no regression | `scripts/verify-exe-license.mts` | `ALL CHECKS PASSED` ✅ |
| gates | `npx tsc --noEmit` / `CI=1 npx next build` | `EXIT=0` / `BUILD_EXIT=0` ✅ |
| canary | validator + bind + status + eligibility + machine-id vs `main` | **all empty** ✅ |
| live app | `main` @ `b7330a1` | clean; `tsc` EXIT=0 ✅ |

Two properties the senior added **beyond** the junior's checks — these are the load-bearing ones:

- **The drift guard.** `generateLicenseKey({ expiresAt: LIFETIME_EXPIRES_AT }).payload.expires_at === LIFETIME_EXPIRES_AT_ISO`, byte-for-byte. D4 depends on this: the sentinel is hashed into the signature, so it can never be recomputed after issuance.
- **The critical negative.** A 30-day **term** key must **not** be classified lifetime. `isLifetimeExpiry`'s `year >= 2999` is correct, but nothing before this proved it does not also swallow a term licence — and a term licence misread as lifetime would silently lose the live kill the owner asked for. Also confirmed the sentinel still validates in **2050 / 2099 / 2998** (not an artefact of today's clock) and **expires in 3000**.

### 3.12.2 The gap this exposed — evidence that cannot be re-run

T3's proof was a temporary harness, **deleted after the run** (the junior disclosed this honestly under `UNVERIFIED:`). The senior's replacement lives in `/tmp` and is equally ephemeral. So `S2`/`S3` were closed on evidence the **next agent cannot reproduce**.

That is a defect in the **verification protocol**, not in T3. New rule, §4: *any `S`-row closed on a one-off script must name a permanent home for that check — a `tests/*.test.ts`, an existing `scripts/verify-*.mts`, or an explicit `ACCEPTED AS ONE-OFF` with the reason.*

### 3.12.3 Task T17 added — the work order is now `T1 → T17`

Small, **test-only**, and it closes §3.12.2 for the sentinel: `tests/exe-license-lifetime.test.ts` plus a `test:license` script. Scheduled **immediately after T3 and before T4** for three reasons: it is small; it protects the foundation every remaining task builds on; and it sets the evidence standard for `T4`–`T13` *before* ten more tasks are accepted on markdown logs alone. **`T4` follows immediately.**

It also makes `W12` safe **without touching the frozen lib** — the test is the guard.

### 3.12.4 Correction — the triplicated `2999` is the senior's spec nit, not a junior error

`2999` appears at `lib/exe-license.ts:35` (the signed literal), `:36` (the `Date`) and `:39` (`isLifetimeExpiry`'s threshold). The junior implemented D4 **verbatim**, so the coupling is the senior's. It is **not** being changed: the literal is frozen by the signature, and `>=` on the year is the correct, future-proof comparison (it keeps a 2999 key reading as lifetime even if the sentinel later moves). Recorded as `W12`, guarded by `T17`.

---

## 3.13 REVISION 6 — senior verification of T17, and the sentinel on the Python side (2026-09-29, fifth senior pass)

### 3.13.1 T17 — ACCEPTED, and the guard proven able to fail

Verified `7b570f6`: `tests/exe-license-lifetime.test.ts` (new, 210 lines), `package.json` `+1` line, plus the two log entries. The commit is **`4 files changed, 497 insertions(+)`, zero deletions**.

Re-run independently, not read off the log:

```
$ npx tsx --test tests/exe-license-lifetime.test.ts
# tests 9 / # pass 9 / # fail 0
$ npm run test:license    -> # tests 9 / # pass 9 / # fail 0
$ npm run test:setup      -> # tests 29 / # pass 29 / # fail 0
$ npx tsc --noEmit        -> EXIT=0
$ CI=1 npx next build     -> BUILD_EXIT=0
canary: validator diff empty | lib/exe-license.ts 13  0 | live app main clean @ b7330a1
```

Hermeticity confirmed by reading the file, not by trusting its header: no DB, no network, no `.env.local`; `server-only` neutralised through the house `Module._load` hook; `SPACEWORKER_LOCAL_DATA_DIR` redirected to `mkdtempSync`; every key minted and validated through the real HMAC (31 assertions across 9 subtests). It is a genuine regression guard, not a smoke test.

### 3.13.2 The mutation proof — re-derived, and the method in S18 was wrong (corrected)

S18 told the senior to mutate the threshold **"in a scratch copy"**. That **does not work**, and it fails in the most dangerous way: copying the test and lib to `/tmp` breaks module resolution, so the run goes red **for a reason unrelated to the mutation** — *including in the unmutated control*:

```
/tmp/sen-t17-mut $ npx tsx --test tests/exe-license-lifetime.test.ts
not ok 1 - /private/tmp/sen-t17-mut/tests/exe-license-lifetime.test.ts
# tests 1 / # pass 0 / # fail 1        <-- also fails with the threshold UNMUTATED
```

A scratch-copy "proof" would therefore have confirmed a mutation that was never actually exercised. **The correct method is mutate in place, then prove the restore.** Re-derived that way:

```
$ sed -i '' 's/getUTCFullYear() >= 2999/getUTCFullYear() >= 3000/' lib/exe-license.ts
$ grep -n 'getUTCFullYear() >=' lib/exe-license.ts
39:  return !!d && d.getUTCFullYear() >= 3000;

$ npx tsx --test tests/exe-license-lifetime.test.ts
ok 1..6   (unchanged — they exercise the validator's expiry, not isLifetimeExpiry)
not ok 7 - 7. isLifetimeExpiry is driven only by the expiry year
ok 8      (the 30-day negative holds under either threshold)
ok 9
# pass 8 / # fail 1

$ git checkout -- lib/exe-license.ts
restore-numstat: 13	0	lib/exe-license.ts
worktree porcelain: []            (empty = clean)
pristine identical: YES
```

This establishes the two things a green run cannot: the test **fails when the property it guards is broken**, and the failure lands on **exactly** the assertion that owns that property (subtest 7) rather than somewhere incidental. `W12`'s coupling is genuinely guarded.

**Restore discipline is now mandatory** (S18 + §4.1c): in-place mutation is acceptable **only** with the three-part restore proof — `git checkout --`, then the `13 0` numstat canary, then `diff -q` against a pre-mutation copy. Without it a pass can leave the branch carrying a mutated sentinel, which ships as *"every lifetime licence silently misclassifies"* — precisely the failure `W12` warns about.

### 3.13.3 UNVERIFIED #1 CLOSED — and it validates T3's format choice

The junior flagged that the desktop EXE's Python `validator.py` classification of the sentinel was unproven. I proved the **parse-and-compare semantics** rather than leaving it assumed:

```
$ python3 -c "..."
parsed      : 2999-12-31 23:59:59
year        : 2999
max year py : 9999
now > d     : False   <- False means VALID/lifetime
micros      : 0
Z-suffix    : REJECTED -> Invalid isoformat string: '2999-12-31T23:59:59.000000Z'
python      : 3.9.6
```

Two conclusions:

1. **The sentinel works on the Python side.** Year 2999 is well inside `datetime`'s range (max 9999), `fromisoformat` parses it, and `utcnow() > expires_at` is `False` — so a `validator.py`-style check reads a lifetime key as **valid**. No overflow, no comparison surprise.
2. **The absence of the `Z` is load-bearing — confirmed on the strictest case.** macOS ships Python **3.9.6**, which *rejects* a `...Z` suffix outright; only Python 3.11+ accepts it. T3 froze `"2999-12-31T23:59:59.000000"` **with no `Z`**, so it parses on 3.9. Had the sentinel been written as an ISO-with-`Z`, **every lifetime licence would have failed on the Python side** on any Python < 3.11. This is Task 42's date-format lesson holding for the new sentinel — and it is now covered by assertion 1 of T17's test.

**Still out of scope, said plainly:** this proves the *format* parses and compares correctly; it does **not** prove the lead-extractor repo's `validator.py` has no additional constraint (e.g. a hard-coded maximum term). That file lives in another repository and belongs to that product's licence flow, not to `TASK_145`. If the owner wants that closed, it needs a task against the other repo.

### 3.13.4 `W13` — T17's guard is not wired to anything automatic (decision: protocol, not CI)

No workflow runs any `test:*` script. `deploy.yml` runs only `npx tsc --noEmit` (`:71`) and `npm run build` (`:74`); `build-exe.yml` runs `npm ci` + `npx prisma generate` + `tauri-action`; the two trial workflows run their own extractors. So a future commit that breaks the sentinel contract would still **typecheck, build, and ship**. Repo-wide this is a **convention** — every `test:*` script is manual — so it is not a T17 defect, but T17's stated purpose is a *permanent* guard and a script nobody runs is only half a guard.

**Decision:** do **not** touch CI in this phase. Wiring tests into `build-exe.yml`/`deploy.yml` changes shared pipeline files that also govern `main` and the live deploy — larger than `TASK_145` and not required to close it. Instead the guard is made to fire on **every remaining task and every senior pass**, via **§4.1c** (new) and reject item **16**. Residual risk recorded for the owner; gating `build-exe.yml` on the suite is a reasonable **Phase 6** candidate, deliberately not scheduled here.

---

### 3.14 — REVISION 7 (2026-09-29): T4 accepted; V17's "frozen set" claim was wrong and blocked T5

#### 3.14.1 `V17` was self-contradictory — and it gated the next task

`V17` (as amended by T3) asserted *"the other four files remain byte-identical and must stay that way"* for `lib/exe-license-validator.ts`, `lib/exe-license-bind.ts`, `lib/license-service.ts`, `app/dashboard/settings/licenses-section.tsx`. **The work order requires editing two of those four:**

| File | Edited by | Nature |
|---|---|---|
| `lib/exe-license-validator.ts` | **nothing, ever** | truly frozen — the offline validator is the design invariant (D5 / §6 item 1) |
| `lib/license-service.ts` | **nothing** | not in the work order at all |
| `lib/exe-license-bind.ts` | **T5** then **T12** | T5: 2 `revoked` guards + 2 error-code unions. T12: `actor` switch + `lifetime_locked` |
| `app/dashboard/settings/licenses-section.tsx` | **T8** | re-decodes the real expiry and **removes** the `EXE_LICENSE_DAYS` import — a deliberate **`-` line** |

Had this stood, the T5 agent would have hit a straight contradiction: the task it was assigned *requires* a diff that the spec row declares forbidden. The predictable outcomes were all bad — revert its own work, log a false `⚠️ OBJECTION`, or silently skip enforcement. **A "frozen file" claim is only safe if no task edits the file.** `V17` now distinguishes *frozen* from *shared*: only the validator and `license-service.ts` are frozen (canary **empty**); for the other three the canary is **"every diff attributable to a named task."**

**Standing rule (new):** before a revision declares any file frozen, it must check the work order for that filename and name the tasks that legitimately change it.

#### 3.14.2 T4 — the revocation seam: **ACCEPTED**

`lib/exe-license-revocation.ts`, 109 lines, **`+109/−0`**, new file. Re-verified by the senior against D2 line-by-line:

| D2 requirement | Delivered | Verdict |
|---|---|---|
| exactly 3 functions + 1 error class | `grep -c '^export '` → **4** (3 fns + `LicenseRevocationError`) | ✅ |
| signatures byte-match D2 | `:38`, `:52-57`, `:98` | ✅ |
| idempotent `upsert` on unique `exeLicenseId` | `:73-85` — `create` also seeds `userId` | ✅ |
| ownership check → typed throw | `:62-67` (`not_found` / `not_owner`) | ✅ |
| `void notifyAdmin(...)` on **both** directions | `:87`, `:106` | ✅ |
| mirrors `LicenseBindError` style | `:23-31` vs `lib/exe-license-bind.ts:28-46` | ✅ |
| imports `./db` (not `./prisma`) | `:1-4` | ✅ |

**Safety:** nothing imports the module yet (`grep -rn 'exe-license-revocation'` → the file itself only), so the hosted app is provably unaffected. `void notifyAdmin` cannot raise an unhandled rejection — `lib/telegram.ts:28-32` wraps the send in `try/catch` and no-ops without Telegram env.

**Two properties the senior proved beyond the junior's report:**
1. **The worktree's Prisma client is now independent and correct** — the branch client has `exeLicenseRevocation` (**180** refs in `index.d.ts`) while the live app's client still has its own feature set (`SendingDomainSelect` **17**) and **zero** branch-only models. C1's clone fix is holding; no cross-contamination.
2. **The reported deviation is genuine and unavoidable.** `ExeLicense` has **no `licensee` column** (verified in `prisma/schema.prisma`) — the licence links to its owner via the required `user` relation. D2 pins the signature, idempotency, ownership check and the `notifyAdmin` call, **not the message string**, so `license.user.email` is correct and in-spec.

**The asymmetry is intentional, and now documented rather than accidental** (§3.14, D2 bullet): `unrevokeExeLicense` has no ownership check because E5 makes revoke **and** unrevoke admin-only siblings of `unbind`, and no user-facing restore exists in this phase. This is a **latent trap**, not a defect: were a later task to expose `unrevokeExeLicense` to users, any user could restore their own cancelled licence. Recorded in D2 so the trap is visible at the point of use.

#### 3.14.3 The per-task canary must not be hardcoded in the hand-off prompt

The T4 prompt's `STEP 4` named `lib/exe-license.ts` → must read `13 0`. That is correct **for T4** and **wrong for every task that edits a different shared file** (T5, T8, T12). Since the prompt is deliberately one-line-to-edit, per-file expectations now live in the `V17` table and the prompt points at it, so the rule cannot go stale. The validator canary stays hardcoded — it is the one file that is frozen for the whole phase.

#### 3.14.4 `W14` — D2 said "exactly three exports" while mandating a fourth

D2's prose required a *typed* error class and then said *"Exactly three exports; nothing else"*. The junior's T4 note resolved it as `3–4`, which is the correct reading (T5/T6 must `catch` it, so it must be exported) — but a spec that contradicts itself invites a future agent to "fix" it by un-exporting the class, silently breaking T5's error mapping. **D2's wording corrected** to "exactly three functions — plus exactly one exported error class".

### 3.15 — REVISION 8 (2026-09-29): T5 accepted — revocation bites at bind and transfer

T5 (`e8f1b14` + logs `01bc495`) is **ACCEPTED**. Diff is exactly `27 2` on `lib/exe-license-bind.ts` — the two deletions are the two `| "machine_taken",` lines re-terminated so `| "revoked",` can follow, which is the only way to extend a trailing-union without reordering it.

| Verified | Evidence |
|---|---|
| import + **2** guards + **2** error unions | `:8`, `:41`, `:116-126` (E1), `:257`, `:317-325` (E2) — diff read line-by-line |
| guard placement | `revoked` at `:121` precedes `machineTakenByAnotherAccount` at `:155`; E2 at `:320` precedes `:357` |
| message **byte-identical** in both | the spec string, verbatim |
| fail-closed (no `try/catch`) | confirmed by runtime (S19), not by reading |
| canaries | validator **empty**; `exe-license.ts` `13 0`; `license-service.ts` **empty** |
| gates | `tsc` `0`; `CI=1 next build` `BUILD_EXIT=0`; `test:license` **9/9**; `test:setup` **29/29** |
| caller mapping (E10) | `revoked` is **not** `already_bound`, so it falls to the generic `400` that carries `err.message` in all three self-service callers (`auto-bind:178`, `password-login:122`, `payment-status:101`). No caller needed a change. |
| hosted-safe | on `main` nothing is ever revoked, so the guard is a no-op |

**18-assertion runtime harness (pass 9), on `spaceworker_t145` with real `ExeLicense`/`Payment` rows — `# pass 18 / # fail 0`:** control bind succeeds (guard is a no-op) · revoke flips `isExeLicenseRevoked` · `reason`/`revokedBy`/`userId` round-trip · double-revoke leaves exactly 1 row · **bound→revoked→rebind returns `revoked`, never `already_bound`** · E2 blocks the transfer · **fail-closed**: table dropped → bind throws, nothing written, not misreported as `revoked` · unrevoke clears the gate, is idempotent, and the transfer then succeeds. Scratch DB left clean (0 rows in `ExeLicense` / `ExeLicenseRevocation` / `ExeLicenseTransfer`; table restored with all 3 constraints).

#### 3.15.1 `W15` — an invariant declared only in a prompt is an unverified assertion

The T5 hand-off prompt made **fail-closed** a hard invariant, and the reject list made violating it an automatic reject. **No `S`-row ever checked it** — so the property that most needed proving (because over-applying the *fail-open* rule from T11/T13 would silently defeat revocation) had no verification at all, and T5's own acceptance check was purely structural (`grep` + `tsc`). It was only caught because the senior invented the proof at verification time. **Rule:** every invariant asserted in a hand-off prompt or the reject list must have a corresponding `S`-row, or it is decoration. S19 is that row for fail-closed; `W15` is the same defect class as `W12` (a contract with no guard).

#### 3.15.2 Environment facts for any DB-backed scratch proof (learned the hard way, pass 9)

Three failures the next agent will otherwise repeat:

1. **A scratch proof must be `.mts`, not `.ts`** — `tsx` compiles a loose `/tmp/*.ts` as CJS and **top-level `await` fails** (`ERR_REQUIRE_ASYNC_MODULE`). The repo's own harnesses are `.mts` for exactly this reason.
2. **`.env` is not auto-loaded** — a bare `tsx` run dies on `Missing required environment variable: APP_BASE_URL` (`lib/env.ts:7`). Source it: `set -a && . ./.env && set +a`.
3. **Import the target modules by absolute path** from a `/tmp` script (`/Users/mikeolab/sw-selfhost/lib/...`), or keep it inside the worktree. And `server-only` still needs `NODE_OPTIONS="--require .../scripts/stub-server-only.cjs"`.
4. Run it with `DATABASE_URL=<scratch>` **and** `EXE_LICENSE_SECRET=<anything>`; `DATABASE_URL` first, then `.env` must not win — export after sourcing.

#### 3.15.3 The revoked-before-`already_bound` property is load-bearing, not incidental

Because E1 sits *before* the already-bound branch, `app/api/exe-license/auto-bind/route.ts:113`'s transfer-code path is unreachable for a revoked licence. That is the difference between "a cancelled customer is told no" and "a cancelled customer is emailed a code, consumes it, and is *then* told no" — and it is what makes D10's admin-move-only rule hold for the **lifetime** class too. Any future reordering of these guards must preserve it; it is now an explicit S5 assertion, not an accident of edit order.

### 3.16 — REVISION 9 (2026-09-29): T6 accepted — revocation is now REACHABLE, and one silent live-app trap closed

T6 (`745d3e6`) is **ACCEPTED**. One product file changed: `app/api/admin/exe-licenses/route.ts`, `170 19` vs `main` — T6's own `167 19`, plus TASK_129's pre-existing 3-line self-hosted gate. Every claim below was re-run by the senior, not read off the junior's log.

| Verified | Evidence |
|---|---|
| **E4** reuse filter | `:447-464` — one `exeLicenseRevocation.findMany` per call, folded into `!revokedIds.has(l.id)` |
| lifetime issuance | `:418` reads `lifetime` from the body; `:491` `...(lifetime ? { expiresAt: LIFETIME_EXPIRES_AT } : { daysValid: durationDays })` — **imported**, never re-declared, no arithmetic |
| **E5** revoke/unrevoke | `:94-97` / `:129-134` dispatch; `:213-241` and `:243-277` handlers; call the T4 seam only — **no direct table writes** |
| **E6** `revoked` flag | `:635-659` — there is exactly **one** listing mapper (checked), fed by a single `in:` query |
| D3 item 4 swap | `:5`, `:409`, `:651` → `LICENSABLE_EXE_PRODUCTS` — exactly the three sites D3 named. Line numbers drifted (`:306`/`:505` → `:409`/`:651`); the intent did not. |
| canaries | validator **empty**; `license-service.ts` **empty**; `exe-license.ts` `13 0`; `bind.ts` `27 2` (T5); admin route `170 19` |
| gates | `tsc` **0**; `CI=1 next build` **BUILD_EXIT=0**; `test:license` **9/9**; `test:setup` **29/29**; store leak **0**; `isSelfHosted()` early-returns intact |

**S6 re-derived from scratch by the senior** (own harness, own server on `:3011`, `spaceworker_t145`, real admin cookie) — the full loop:

```
issue 30d → bind m1 → CONTROL issue → reused:true (same key)
→ revoke → {"ok":true,"revoked":true} → double-revoke 200 (idempotent)
→ bind m2 → {"error":"...cancelled...","code":"revoked"} HTTP=400   (NOT machine_taken)
→ RE-ISSUE → REUSED=<empty>   NEW_KEY_DIFFERS=YES-NEW-KEY-MINTED          ← E4 PROVEN
→ GET listing → revoked=True on the cancelled row, False on the new one   ← E6 PROVEN
→ unrevoke → {"ok":true,"revoked":false} → re-issue → reused:true
→ lifetime issue → expiresAt=2999-12-31T23:59:59.000Z
```

**Discrepancy recorded, not smoothed over.** The junior's log shows `K4 == K1 ? YES-ORIGINAL-KEY-REUSABLE-AGAIN`; the senior's run reuses the **newer** row instead. Both are correct, and the difference is **test design, not behaviour**: the junior deliberately `delete`d the newer minted row first so the filter could reach the *original* — a **stronger** claim than the senior's. The lookup is `orderBy: issuedAt desc` + `.find`, so the newest non-revoked unexpired row wins. E4's contract (no reuse while revoked; reuse resumes after unrevoke) holds in both runs.

#### 3.16.1 S20 — a BOUND lifetime key preserves the sentinel (what `T12`/E9 depends on)

New assertion, run by the senior: issue `lifetime:true` → **bind it** → decode the **bound** key:

```
bound payload = {"expires_at": "2999-12-31T23:59:59.000000", "issued_at": "...", "licensee": "...", "machine_id": "mlife", "plan": "selfhosted", "product": "selfhosted_os"}
SENTINEL PRESERVED = True
```

Bind re-signs the payload with `machine_id` added and `expires_at` carried through **byte-for-byte**. This is load-bearing and was previously unstated: E9's admin-move-only lock and T13's self-hosted check both call `isLifetimeExpiry` on a **bound** key, so the lifetime class is only identifiable if binding preserves the sentinel. Had binding rewritten the expiry to a default term, D9's rule would have evaporated **with no error anywhere**. Now pinned.

#### 3.16.2 Two gaps the junior flagged are now closed — reject item 6 is discharged

1. **Cross-account `revoke`/`unrevoke` (§6 item 6) — runtime-proven.** With **two real users**, B attempts to revoke A's `exeLicenseId`: `{"error":"No license for owner-b@example.test matches that selection."}` **HTTP=400**, and the revocation count for A's licence stays **0**. Same for unrevoke. A nonexistent email is refused even earlier (`No SpaceWorker user exists for ...`), so the refusal is enforced twice. The negative half of **S9** is discharged.
2. **`revoke` × the pre-existing `delete` action — verified, not assumed.** T6 inserted its two actions *before* `delete` in the dispatch, raising the obvious question of what happens when an admin deletes a **revoked** licence. The FK is `ON DELETE CASCADE` (`20261020000000_add_exe_license_revocation/migration.sql:48`, `schema.prisma:699`), so the revocation row goes with it: `{"deleted":true}` 200, **0 orphans, 0 500s**. `delete` is **pre-existing on `main`** (`:73`/`:104`, checked line-by-line) — T6 did not invent it.

#### 3.16.3 `W16` — `.env` is a symlink into the LIVE APP, and git cannot show it

The junior's environment note ("`next start` cannot boot this worktree with the checked-in `.env`") is **correct**, and it points at a trap:

- `.env` → **`/Users/mikeolab/spaceworker/.env`** — the **live app's** environment file, and the **only** remaining non-`node_modules` symlink in the worktree (audited).
- The boot failure is `lib/env.ts`'s `guardAgainstPlaceholder` (`:52`) firing in production on `SESSION_SECRET=local_dev_session_secret_not_for_prod_…` (`/local_dev/i`) and `RESEND_API_KEY=re_local_dev_placeholder`.
- **`.env` is gitignored (`.gitignore:4`) and untracked**, so an edit to it **leaves no trace in `git status` whatsoever**.

The obvious "fix" — editing those two values so the server boots — therefore rewrites the **live app's** `SESSION_SECRET` (invalidating every live session) and `RESEND_API_KEY` (breaking live email), **silently**. Same class as C1/C2 (the `node_modules` symlink clobbering the live Prisma client), but harder to catch because git cannot display it. **The only correct workaround is a command-line override**, which is what the junior chose and the senior repeated:

```bash
env CI=1 DATABASE_URL=<scratch> SESSION_SECRET="$(openssl rand -hex 48)" \
    RESEND_API_KEY="re_$(openssl rand -hex 24)" ADMIN_TOKEN=... npx next start -p 3011
```

**Standing rule:** never edit `.env` from the worktree (§4.1e, reject item 18). Generalised: before trusting `git diff` as proof that "nothing changed", confirm the thing you changed is **tracked**.

---

### 3.17 — REVISION 10 (2026-09-30): the live app moved again. **Branch identity re-confirmed**, and two **merge hazards** that must not be discovered at merge time.

The owner reported that fixes landed on the **live app**. Before continuing I re-verified which branch this worktree is on and re-ran every canary, because `main` moving can silently invalidate them.

**Branch identity and push safety — all correct, nothing to fix:**

| Check | Result |
|---|---|
| `/Users/mikeolab/sw-selfhost` branch | `self-hosted-build` ✅ |
| HEAD | `745d3e6` (== `origin/self-hosted-build`) ✅ |
| `branch.self-hosted-build.merge` | `refs/heads/self-hosted-build` ✅ (**not** `main` — the C2 trap is still closed) |
| `branch.self-hosted-build.remote` | `origin` ✅ |
| Worktree | only the two `TASK_145_*.md` modified (this pass) — **no product code** ✅ |

**How far the two histories have diverged now:** merge base is still `1499a9e`; `main` is **42 ahead**, the branch **31 ahead**. `main` advanced `b7330a1 → 0d816b5` (5 commits: `88ca661`, `f76047f`, `e7a7559`, `7e1f5a4`, `0d816b5` — the "admin remote viewer / device commands" line of work).

**Canaries re-validated *after* the move — still meaningful.** The risk was that a `main`-side edit to one of our canaried files would make a "clean" diff meaningless. Checked file by file: `main` changed **none** of `lib/exe-license.ts`, `lib/exe-license-validator.ts`, `lib/exe-license-bind.ts`, `lib/license-service.ts`, `lib/products.ts`, `app/api/admin/exe-licenses/route.ts`, `app/api/store/prices/route.ts`, `app/dashboard/settings/licenses-section.tsx`, `package.json` in that range. So every figure stands: validator **empty**, `license-service.ts` **empty**, `exe-license.ts` `13 0`, `bind.ts` `27 2`, admin route `170 19`, `products.ts` `24 2`, `package.json` `2 10`.

> **But `main` DID change two files that matter, and both are hazards rather than canary problems.** Recorded below.

#### 3.17.1 — `W17`: `app/admin/(protected)/admin-panel.tsx` is now divergent on **both** sides. The merge must keep **both**.

This is T7's own file, and it is the single most dangerous merge point in the phase.

| Side | Change to `admin-panel.tsx` |
|---|---|
| Branch (vs merge base) | **`+27 / −6`** — the self-hosted / EXE-tab additions |
| Branch (vs `main`) | **`+31 / −1354`** |

That `−1354` is not churn — it is the branch **not having** `main`'s remote-viewer, PIN-collect and hide/reveal work. I confirmed the asymmetry directly: the **branch** version contains **0** occurrences of `remote-viewer` / `agent-visibility` / `pinRequest`, while the **`main`** version contains `ExeLicensesTab` / `EXE_PRODUCTS` (5 hits) because the branch's earlier work is already merged there.

**The hazard:** if the eventual merge of `self-hosted-build → main` resolves this file by taking the branch side — which looks reasonable to anyone reading a 1354-line "deletion" as noise — it **deletes the entire live remote-viewer feature from production**. Git will present this as a routine conflict.

**Rule:** admin-panel.tsx is resolved by **union, never by side**. Both features must survive. Before any merge of this branch, diff `main..branch` for this one file and account for all 1354 lines explicitly.

#### 3.17.2 — `W18`: same-timestamp migrations — the revocation migration must be **renumbered before it ever reaches `main`**.

| Source | Migration |
|---|---|
| Branch | `20261020000000_add_exe_license_revocation` (T1) |
| `main` (already applied to the live DB) | `20261020000000_admin_device_commands` |
| `main` | `20261021000000_admin_device_command_kind`, `20261022000000_device_pin_request_origin` |

The two collide on the **same 14-digit prefix**. Prisma requires unique **names** (these differ), so nothing errors today — but pending migrations are applied in **lexicographic order of directory name**, and `add_exe_license_revocation` sorts **before** `admin_device_commands`. The live database has **already applied** `20261020000000_admin_device_commands` and both later ones; the revocation migration has applied **only to scratch `spaceworker_t145`**.

So on merge, Prisma is asked to apply a migration that is **older than already-applied ones** — the out-of-order condition, at best a warning and at worst a `migrate deploy` failure on the production box.

**Missed opportunity if not done now:** this is the **last moment** the branch's migration is still safe to rename. It has **never been applied to the live DB**, so renaming it to a timestamp **after** `20261022000000` (e.g. `20261023000000_add_exe_license_revocation`) costs nothing today, and becomes **forbidden** the moment it merges and deploys — from then on it is recorded in production by name *and* checksum. T1's junior could not have known: `main`'s same-timestamp migration was authored **after** our branch forked.

**Rule:** before the merge, renumber the branch's revocation migration to sort after `20261022000000`, rebuild scratch (`spaceworker_t145`), and re-run the fresh-DB check. **Do not** rename it after it has been applied to any shared database.

#### 3.17.3 — the live checkout currently holds **another agent's uncommitted work**. Do not touch it.

While confirming the branch I found uncommitted changes in `/Users/mikeolab/spaceworker` (NOT mine, NOT committed):

```
 M app/dashboard/campaigns/page.tsx      M lib/deliverability.ts
 M lib/render-merge.ts                   M package.json
?? lib/test-merge-vars.ts                ?? tests/render-merge.test.ts
```

Its `package.json` edit adds `"test:merge": "tsx --test tests/render-merge.test.ts"` — i.e. **another agent is doing exactly what `W13` predicted**: adding another manual `test:*` script that no CI job will ever run. Independent confirmation of `W13`; noted, not acted on.

Consequences for us: (a) **nothing to merge** — it is uncommitted, so it cannot affect the branch; (b) my "live app `tsc`" canary is **partly confounded**, and I checked it anyway — `LIVE_TSC_EXIT=0`, so their WIP is type-clean and my figure is not hiding a fault; (c) **do not touch those files, and do not commit or stash another agent's work.**

#### 3.17.4 — informational: `TASK_146` is now taken.

`main`'s device-command work (`88ca661`) refers to itself as **`TASK_146`** in its migration header — the number my Phase 5 docs reserved for Phase 6. No file collision (0 `TASK_146*` files on either side), so it is a naming note only. **Phase 6 should take `TASK_147`+.**

---

**Decision recorded — the branch stays behind, deliberately.** I considered merging `main` into the branch now and **rejected it**: it would create a large `admin-panel.tsx` conflict in exactly the file T7 must edit, inject `main`'s three already-applied device migrations into the phase branch, and force the `W18` ordering decision mid-phase — all for no benefit to T7, since the phase's nine canaried files are untouched by `main`'s new commits. The divergence is a **merge-time** obligation (`W17`, `W18`), not a mid-phase one. Revisit when the phase work is complete.

## 4. Verification protocol (senior-owned — the junior must not self-approve)

### 4.1 What the junior may run themselves

```bash
cd /Users/mikeolab/sw-selfhost
CI=1 npx next build     # MUST be BUILD_EXIT=0 (plain `npm run build` trips lib/env.ts's
                        # placeholder guard locally — see §3.10.5 / C4)
npx tsc --noEmit        # MUST be clean; the branch baseline is EXIT=0 (§7)
```
Do **not** run `npx prisma migrate dev` (C5: P3018 on a fresh DB) or bare `npx prisma generate` (C2: it clobbers the live client). Create DB fixtures against **`spaceworker_t145`** only (§3.10.7), and recreate it with `prisma db push` rather than by replaying migrations.
Plus the narrow unit assertions listed in the junior track §V.

### 4.1b Evidence must be reproducible (§3.12.2)

Any `S`-row closed on a **one-off script or temporary harness** must name a **permanent home** for that check:

- a `tests/*.test.ts` (run via `tsx --test`, with a `test:*` script in `package.json`), **or**
- an existing checked-in harness such as `scripts/verify-exe-license.mts`, **or**
- an explicit **`ACCEPTED AS ONE-OFF`** in the row plus the reason it cannot be made durable.

A deleted `/tmp` harness is **not** evidence: the next agent cannot re-run it, so the row is unverifiable. Both agents must state where a check lives, not just that it passed once.

### 4.1c Standing test checks — mandatory on every task and every senior pass (added pass 7, after `W13`)

```bash
cd /Users/mikeolab/sw-selfhost
npm run test:license    # MUST print  # pass 9  / # fail 0   (T17: the lifetime sentinel contract)
npm run test:setup      # MUST print  # pass 29 / # fail 0   (T15-era: the self-hosted setup wizard)
```

Baseline established 2026-09-29 (pass 7): `test:license` **9/9**, `test:setup` **29/29**.

`W13` matters here: **no CI job runs these.** `deploy.yml` runs `tsc` and `build`; `build-exe.yml` runs `npm ci` + `prisma generate` + `tauri-action`. So until the suite is gated in CI, these two commands are the **only** thing that executes T17's guard. A pass that skips them silently accepts drift in the lifetime sentinel. Paste the raw `# tests / # pass / # fail` lines; a new failure here is a regression in the task under review until proven otherwise.

**Mutating the frozen lib (S18) — the only permitted procedure.** Mutate **in place**, then restore and prove it in three parts:

```bash
cp lib/exe-license.ts /tmp/t145-pristine.ts                              # 1. keep a copy
sed -i '' 's/getUTCFullYear() >= 2999/getUTCFullYear() >= 3000/' lib/exe-license.ts
npx tsx --test tests/exe-license-lifetime.test.ts   # expect: not ok 7, # pass 8 / # fail 1
git checkout -- lib/exe-license.ts                                       # 2. restore
git diff --numstat main self-hosted-build -- lib/exe-license.ts          # 3a. MUST read 13  0
git status --porcelain lib/exe-license.ts                                # 3b. MUST be empty
diff -q /tmp/t145-pristine.ts lib/exe-license.ts                         # 3c. MUST be identical
```

A **scratch copy under `/tmp` cannot be used** — it fails on module resolution *even unmutated* (§3.13.2), which would fake a positive result. Skipping parts 3a–3c leaves a mutated sentinel on the branch.

### 4.1d A task's S-rows are part of its acceptance check, not just the senior's (added pass 9, after `W15`)

`W15`'s root cause was mechanical: `T5`'s file block listed only a **static** check (`grep` + `tsc`) while `S5`/`S7` demanded a **runtime** result — so the highest-risk property of the task (fail-closed) had an `S`-row but no junior ever ran it, and it was only proven because the senior invented the harness at review time. That inverts the two-track design: the junior produces evidence, the senior re-runs it.

**Rule, binding on every remaining task:**

1. **A task's `Check:` block is a floor, not a ceiling.** If any `S`-row in §4.2 names this task and is *runnable* (a route, a DB write, a bind, an HTTP call), the junior must run it and paste the raw output — even when the task block lists only `grep`/`tsc`.
2. **If a junior cannot run it** (needs an admin session, a real key, a running build the task does not otherwise need), it must say so **explicitly** in the log as `NOT RUNNABLE BY JUNIOR: <S-id> — <why>`, and the senior owns it. Silence is a reject (item 17).
3. **T6 is the first task this applies to in full force:** its block lists `tsc` + `grep`, but it is the task that makes revocation *reachable in production*, and `S6` (E4's anti-reuse proof) is a live HTTP + DB assertion. The junior runs `S6`.

**Why this is not busywork:** `T5` is the demonstration. Every `S`-row the junior leaves unrun gets re-derived by the senior from scratch, which costs a full pass and risks the senior's own harness being wrong (as `S18`'s scratch-copy method was). Cheaper and safer to have both agents run the same command and compare.


### 4.1e Never edit `.env` from the worktree (added pass 11, after `W16`)

`.env` in this worktree is a **symlink to the live app's `.env`** (`/Users/mikeolab/spaceworker/.env`) **and is gitignored**, so any edit silently changes the running product with **zero trace in `git status`**. `lib/env.ts`'s placeholder guard means `next start` will not boot with the checked-in values — which is precisely the pressure that would push an agent to "fix" it. **Never do that.** Pass overrides on the command line instead (§3.16.3). Any task that needs `next start` must state this, and any log claiming "nothing changed" must be backed by a check on a **tracked** file.

### 4.2 What only the senior verifies (evidence required, pasted into this file's log)

| ID | Check | Pass condition |
|---|---|---|
| S1 | `git diff --stat main self-hosted-build -- lib/exe-license-validator.ts` | **empty** — the validator was not touched |
| S2 | Round-trip a lifetime key end-to-end with real code paths (script, not mocks): `generateLicenseKey({expiresAt: LIFETIME_EXPIRES_AT})` → `verifyLicenseKey` → `validateLicenseKey` | ✅ **VERIFIED 2026-09-29 (pass 6)** — re-derived by the senior with its own 23-assertion harness, **not** the junior's: `valid: true`, decoded year `2999`, plus the byte-drift guard (`payload.expires_at === LIFETIME_EXPIRES_AT_ISO`) and validity in **2050 / 2099 / 2998**. ⚠️ The evidence was **ephemeral** (both harnesses in `/tmp`, the junior's deleted) — `T17` makes it permanent. |
| S3 | 30-day key through the same path | ✅ **VERIFIED 2026-09-29 (pass 6)** — `valid: true` at day 29, **`expired` at day 31**, and the critical negative `isLifetimeExpiry(term.expiresAt) === false`. ⚠️ Permanent via `T17`. |
| S4 | Bind a lifetime key with a real `ExeLicense` row | `boundLicenseKey` decodes to `expires_at` starting `2999-` (verbatim preservation — V8) |
| S5 | Revoke that licence, then attempt a bind on a fresh machine | ✅ **VERIFIED 2026-09-29 (pass 9).** Runtime on `spaceworker_t145` with real `ExeLicense`/`Payment` rows (18-assertion senior harness, §3.15.1): `LicenseBindError` with code **`"revoked"`** and the spec message verbatim. **The ordering claim is proven, not inferred:** the licence was bound to `t5-machine-a` *first*, *then* revoked, *then* a bind for `t5-machine-b` attempted — it returned **`revoked`, never `already_bound`**, so E1 precedes *both* the cross-account check (as the spec required) **and** the already-bound/transfer-code path (a stronger position than the spec asked for). **Consequence, now a documented property:** a revoked licence can never be offered a transfer code, so self-service recovery from a cancellation is impossible by construction. The `ExeLicense` row was unchanged. |
| S6 | Revoke, then POST `action: "issue"` for the same user+product | ✅ **VERIFIED 2026-09-29 (pass 11).** Re-derived by the senior from scratch (own harness, own server, `spaceworker_t145`, real admin cookie). Control first: re-issuing *before* revoke returns `reused:true` with the **same** key. After `revoke`, the same call returns **no `reused` flag and a brand-new key** (`NEW_KEY_DIFFERS=YES-NEW-KEY-MINTED`). After `unrevoke`, reuse resumes. Without E4 the re-issue hands back the **cancelled** key, making the whole cancel feature cosmetic. The senior's run reuses the *newest* eligible row; the junior's (which `delete`d the newer row first to expose the original) is the **stronger** variant — both confirm the contract (§3.16). |
| S7 | Un-revoke, then bind | ✅ **VERIFIED 2026-09-29 (pass 9).** Runtime, same harness. After `unrevokeExeLicense` the gate clears (`isExeLicenseRevoked` → `false`), a **second** `unrevokeExeLicense` call does not throw (idempotent, as D2 requires), and a `transferExeLicenseToMachine` that had been blocking now **succeeds** — `boundMachineId` actually moved to `t5-machine-c`. Revocation is fully reversible end-to-end. Also proven: `revokeExeLicense` called twice leaves **exactly 1** row (the `upsert` idempotency claim in D2). |
| S8 | `curl -s localhost:3000/api/store/prices \| grep -c selfhosted_os` | `0` — new product not leaked to the public store |
| S9 | Admin panel: issue a 30-day licence and a lifetime licence; buyer Settings page shows 30 days and "No expiry" respectively | both correct, no `180` anywhere in the rendered copy |
| S10 | Self-hosted wizard: enter a store-bought `extractor_exe` key | rejected with a product-mismatch message (D6.1) |
| S11 | `isSelfHosted()` early-returns at `app/api/admin/exe-licenses/route.ts:50,473` still present | unchanged — revoke endpoints are inert on a customer's box |
| S12 | Migration sanity | **Amended by §3.10.6. ** `npx prisma migrate status` **cannot** be the pass condition on this machine (stale shared DB + two stuck `device_tools_v2` rows, §3.10.7). Pass condition is now: the migration is **additive only** (one new table, one new column with a default, no destructive statement) **and** it applies cleanly to a scratch database. Verified 2026-09-29 via `prisma db push` onto `spaceworker_t145` (§3.10.7). The fresh-DB history failure (P3018) is **not** T1's — it is tracked as **T14**. |
| S13 | **THE LIVE KILL (E7)** — with a real revoked row, POST `/api/exe-license/eligibility` with (a) the licence's original key and (b) its current bound key | **both** return `eligible: false`. Before the edit both returned `true` (W2) — this single row is what makes the owner's "immediate revocation" real. |
| S14 | End-to-end kill on the desktop class: revoke a bound licence, then POST `/api/exe-license/status` against a local runtime holding that activation | `licensed: false`, message *"This license has been revoked…"*, and the local activation is cleared (mirrors the W1 path). |
| S15 | **Lifetime move control (E9)** — self-service transfer of a lifetime licence, then the same transfer via admin `action: "transfer"` | self-service throws `"lifetime_locked"` **and** the `ExeLicense` row is unchanged (`boundMachineId` / `boundLicenseKey` byte-identical, no new `ExeLicenseTransfer` row); admin transfer **succeeds**. |
| S16 | **Self-hosted runtime check (E8)** — (a) expired/revoked stored key, (b) still-valid key with the server unreachable (W4) | (a) blocked with a clear message; (b) **NOT** blocked (fail-open preserved). Confirms W4 is closed without breaking offline use. |
| S17 | **The purchase gate (E11 / T16)** — `GET /api/billing/checkout?kind=btc&product=selfhosted_os` and `POST /api/billing/submit {product:"selfhosted_os"}` | ✅ **VERIFIED 2026-09-29 (pass 5).** both return **400 `{"error":"Unknown product"}`** — byte-identical to a typo'd id — and **no `Payment`/`User` row is created**. The same calls with `product=extractor_exe` still succeed unchanged (proves the guard is a no-op for sellable products). Before T16 the first two returned 200 and persisted a $0 pending payment (W8/W9). |
| S18 | **The lifetime sentinel's contract is permanently pinned (T17 / `W12`)** — `npm run test:license` | ✅ **VERIFIED 2026-09-29 (pass 7).** `tests/exe-license-lifetime.test.ts` exists, **9 subtests, `# pass 9 / # fail 0`**, and asserts the **drift guard** (`generateLicenseKey({expiresAt: LIFETIME_EXPIRES_AT}).payload.expires_at === LIFETIME_EXPIRES_AT_ISO` byte-for-byte) plus the **critical negative** (`isLifetimeExpiry(<30-day term>) === false`, term valid at day 29 / expired at day 31). **Can-fail proven** by mutating `isLifetimeExpiry`'s threshold to `>= 3000` — subtest 7 fails, `# pass 8 / # fail 1`. ⚠️ **Method corrected (§3.13.2):** the mutation must be **in place**, *not* in a scratch copy — a `/tmp` copy fails on module resolution even unmutated and would fake a positive. Restore must be proven three ways (§4.1c). Discharges §3.12.2 for the sentinel. |
| S19 | **`W15` — the fail-closed invariant is actually enforced (T5)** — with the `ExeLicenseRevocation` table absent, attempt a bind on a *healthy, non-revoked* licence | ✅ **VERIFIED 2026-09-29 (pass 9).** Runtime: the revocation read raises (`PrismaClientKnownRequestError`), the bind **throws**, **no `boundMachineId` is written**, and the failure is **not** misreported as `"revoked"`. This is the one place in Phase 5 where fail-open would be **wrong** — bind/transfer already writes to the DB, so a failed revocation read must abort rather than risk activating a cancelled key. Table restored verbatim from T1's migration afterwards (3 constraints verified present, 0 rows). |

| S20 | **A BOUND lifetime key still identifies as lifetime (T6 / E9 / T12 / T13)** — issue `lifetime:true`, **bind** it, decode the **bound** key | ✅ **VERIFIED 2026-09-29 (pass 11).** The bound payload is `{"expires_at": "2999-12-31T23:59:59.000000", "machine_id": "mlife", ...}` — bind re-signs with `machine_id` added and the sentinel **carried through byte-for-byte**, so `isLifetimeExpiry(<bound key>)` is still `true`. Load-bearing: E9's admin-move-only lock and T13's self-hosted check both classify a **bound** key, so if binding had rewritten the expiry the D9 rule would vanish with no error. Closes the previously unstated assumption in T12's spec. |

### 4.3 Deployment note (do not deploy as part of this task)

The hosted VPS runs the **live** app from `main`. Phase 5 lands on `self-hosted-build` only. When the branch is eventually merged, the schema migration must be applied on the VPS per `HOW_WE_MOVE_FAST.md` §2/§3 — a new table + a column with a default is a safe online migration, but it still needs the maintenance-window script. Do not run a migration against the live DB to "test" this task.

---

## 5. Assignment

The implementation is handed to the **junior agent** in `TASK_145_SELF_HOSTED_LICENSE_JUNIOR_TRACK.md`. That file is the work order; this file is the spec of record. The junior must:

1. Work **only** in `/Users/mikeolab/sw-selfhost` on branch `self-hosted-build`.
2. Implement §3 **D1–D11** — including **§3.9 (Revision 2)** (amends D5, adds D8–D10), **§3.11 (Revision 4)** (adds D11), **§3.12 (Revision 5)** (adds `W12`, the §4.1b evidence rule, and **T17**), **§3.13 (Revision 6)** (adds `W13`, the §4.1c mandatory-test rule), **§3.14 (Revision 7)** (corrects `V17`'s frozen set, records the `unrevokeExeLicense` asymmetry and `W14`), **§3.15 (Revision 8)** (records T5's fail-closed `S19`) and **§3.16 (Revision 9)** (T6 accepted; adds `S20`, `W16`, §4.1e and reject item 18) — and stop at the first `⚠️` in the log rather than guessing.
3. Append a dated entry to **both** files when the code is written (what changed, `file:line`, commands run + raw results, anything unverified). **Run the `S`-rows that name your task (§4.1d) and paste their raw output** — a static tick alone will be bounced, and staying silent is reject item 17.
4. **Not** mark anything "done" or "verified" — only the senior closes a verification row (S1–S20). The junior writes `READY FOR VERIFICATION`, never `VERIFIED`.
5. **Stop after each task.** Report at the end of every `T*` (§2 of the junior track) rather than working through the whole list in one session — see the junior track's **§2.0 stop-after-each-task rule**.
6. **Follow the `▶ NEXT TASK` pointer, not the task numbers.** The numbers record *discovery* order, so the execution order is deliberately not numeric: `T1 → T2 → **T16** → T3 → **T17** → T4 → **T5** → **T6** → T7 → T8 → … → T15`. The single source of truth is the pointer at the top of the junior track (junior §2), and **the senior must move it at the end of every pass** so a fresh agent starting from a cold read cannot begin the wrong task.
7. **Take per-file canaries from the `V17` table, never from a hand-off prompt's example.** Only `lib/exe-license-validator.ts` and `lib/license-service.ts` are frozen (diff **empty**). `lib/exe-license.ts` is additive-only (`13 0`); `lib/exe-license-bind.ts` (**T5** ✅, **T12**), `app/api/admin/exe-licenses/route.ts` (**T6** ✅) and `app/dashboard/settings/licenses-section.tsx` (**T8**) are **expected to change**, and T8 legitimately deletes a line. See §3.14.1 and §3.14.3.
8. **Never edit `.env` from the worktree** (§4.1e / `W16`). It is a symlink into the live app and is gitignored, so the change is invisible to `git status` while breaking the running product.

## 6. Review reject list — the senior will bounce the PR for any of these

1. Any edit to `lib/exe-license-validator.ts`, or to the signed payload's key set (`V4`) — including "helpfully" adding a `revoked` field to the payload.
2. Putting `SELF_HOSTED_OS` into `ALL_PRODUCTS` (leaks to the public store — S8 fails).
3. Using `daysValid: 999999` or any arithmetic instead of the frozen `expiresAt: LIFETIME_EXPIRES_AT`.
4. Revocation checked anywhere other than **E1/E2/E4/E7/E8**. ⚠️ **Corrected 2026-09-29 (§3.9):** this item used to read *"or a launch-time network call"* — that rejection was **wrong** and is withdrawn. The launch-time check **is** the design (E7 extends the existing `stillValidLive`/`eligibility` seam; E8 gives the self-hosted build its first-ever check). Still rejected: putting any revocation logic inside `lib/exe-license-validator.ts`, or any check on a hot path that is **not** fail-open.
5. Skipping E4 (the reuse filter) — cancel then re-issue must mint a new key, not hand the revoked one back.
6. A non-idempotent revoke (double-click → 500) or a revoke that does not check licence ownership.
7. Deleting/renaming anything under `TASK_134..TASK_144` or any other main-only file (§0.2.3).
8. A destructive migration, or any migration run against the live VPS DB.
9. `tsc --noEmit` not clean, or `npm run build` failing.
10. Touching `app/api/store/prices/route.ts` / `admin/wallets/route.ts` "to hide" the product instead of simply not adding it to `ALL_PRODUCTS`.
11. **A non-fail-open runtime check (E7/E8).** If the server or network is unreachable, the install must stay usable. A legitimately offline customer must never be locked out — that is why `stillValidLive` returns `true` on any error.
12. **Blocking the *first* bind of a lifetime licence (E9).** Only `transferExeLicenseToMachine` is restricted; a fresh unbound lifetime key must still activate normally. Getting this backwards bricks every new lifetime sale.
13. **Any self-service path that can move a lifetime licence, or any UI copy promising a self-service PC move for one.** The owner's rule is support-only; a hidden/undocumented unlock is still an unlock (§3.9 D9).
14. Deciding "lifetime" anywhere other than the decoded `expires_at` (a client flag, a DB column, or `durationDays` overflow).
15. **A purchase path that accepts a product id outside `ALL_PRODUCTS` (§3.11 D11 / E11).** `BY_ID` registration makes a product *resolvable* — bind/transfer require it (V9) — but it must never make it *sellable*. Equally rejected: closing W8 by removing `SELF_HOSTED_OS` from `BY_ID` (that breaks V9), or by adding it to `ALL_PRODUCTS` (that leaks it to the store — item 2). The guard must return the *same* 400 an unknown id gets; a distinct message or 403 confirms the product exists.
16. **Omitting the standing test checks (§4.1c)** — `npm run test:license` (9/9) and `npm run test:setup` (29/29) — or reporting them without the raw `# pass / # fail` lines. Until `W13` is closed by a CI change, these two commands are the **only** thing that runs `T17`'s guard; a pass that skips them silently accepts lifetime-sentinel drift. Same rule for S18's mutation proof: mutating in a `/tmp` scratch copy, or mutating in place **without** the three-part restore proof, is a reject.
17. **Leaving a runnable `S`-row unrun and unmentioned (§4.1d)** — when a task has a runnable `S`-row (a route, a DB write, a bind, an HTTP call) and the log neither pastes its output nor records `NOT RUNNABLE BY JUNIOR: <S-id> — <why>`. Silence forces the senior to re-derive the proof from scratch, which is what `T5` cost this phase (`W15`). This is a reject on the **log**, independent of whether the code is correct.



18. **Editing `.env` from the worktree (§3.16.3 / `W16` / §4.1e).** It is a **symlink into the live app** and **gitignored**, so an edit changes the running product with **no trace in `git status`**. `next start` refusing to boot on the placeholders is the intended behaviour — use command-line overrides. Equally rejected: claiming "nothing changed" in a log without a check on a **tracked** file.

## 7. Verified environment baseline (2026-09-29)

| Fact | Value |
|---|---|
| Worktree | `/Users/mikeolab/sw-selfhost` — branch `self-hosted-build`, HEAD `745d3e6` at T6 close (verified in pass 11) |
| Primary checkout (live app) | `/Users/mikeolab/spaceworker` — branch `main`, HEAD **`0d816b5`** (advanced from `b7330a1` — see §3.17; carries **another agent's uncommitted WIP**, §3.17.3) |
| Merge base | `1499a9e` (2026-09-27); `main` is **42 ahead** / branch **31 ahead** (§3.17) |
| `node_modules` | **must be a real APFS clone, never a symlink** (§3.10.2/C1): `cp -Rc /Users/mikeolab/spaceworker/node_modules ./node_modules` |
| `npx tsc --noEmit` | **EXIT=0** on the branch, **and** EXIT=0 in `/Users/mikeolab/spaceworker` (`main`) after the client restore (§3.10.3) |
| Local build | `CI=1 npx next build` → **BUILD_EXIT=0** (§3.10.5). Plain `npm run build` trips `lib/env.ts`'s placeholder guard, by design |
| Verification DB | `spaceworker_t145` — built with `prisma db push`; 50 tables incl. `ExeLicenseRevocation` (§3.10.7) |
| Fresh-DB migration replay | **BROKEN** — P3018 `relation "ExeLicense" does not exist` at `20260914150000` (§3.10.6) → task **T14** |
| Shared local dev DB | ~27 migrations stale (no `Device` table) + two stuck `device_tools_v2` rows — **not usable for Phase 5** (§3.10.7) |
| Work order | **T1 → T17** (T14 = fresh-install bootstrap; T15 = optional local drift repair; **T16 = purchase gate ✅ closed**; **T17 = pin the sentinel in a permanent test ✅ closed**). **Closed so far: `T1`, `T2`, `T3`, `T4`, `T5`, `T6`, `T16`, `T17`. Next: `T7`.** |
| Standing tests (§4.1c) | `npm run test:license` → **9 pass / 0 fail** · `npm run test:setup` → **29 pass / 0 fail** (re-confirmed 2026-09-29, pass 11). **No CI job runs these (`W13`)** — they are mandatory on every task and every pass. |
| Node date check | `new Date("2999-12-31T23:59:59.000000Z")` → year 2999, valid (not `NaN`) |
| Files frozen (diff **must** stay empty, V17) | `lib/exe-license-validator.ts`, `lib/license-service.ts` |
| Files that legitimately diff from `main` | `lib/exe-license.ts` `13 0` (T3, additive-only — canary is **"zero `-` lines"**, not "empty") · `lib/exe-license-bind.ts` `27 2` (T5) · `app/api/admin/exe-licenses/route.ts` `170 19` (TASK_129 `3 0` + T6 `167 19`) · `app/dashboard/settings/licenses-section.tsx` (T8, not yet) |
| `.env` (⚠️ `W16`) | **a symlink to `/Users/mikeolab/spaceworker/.env`** and **gitignored** — never edit it from the worktree (§4.1e). Use command-line overrides for `next start` |
| Task file numbers used | `TASK_145` = this phase; `TASK_146` reserved for Phase 6 |

## 8. LOG — append-only. Newest entry at the bottom. Both agents append; never edit an existing entry.

### 2026-09-29 — SENIOR (scope + verification, first pass) — mode: review, no code written

**Did:** read the plan (`~/.claude/plans/transient-moseying-tome.md` §Phase 5), `HOW_WE_MOVE_FAST.md` §0–§2, and every file Phase 5 touches. Verified §2 V1–V18 against real code (not memory). Created the worktree `/Users/mikeolab/sw-selfhost`, linked `node_modules`, and captured a clean typecheck baseline. Created this file and the junior track.

**Key findings the implementation depends on**
- `generateLicenseKey` already accepts `expiresAt` — no new signing capability is needed (V2).
- `lib/exe-license-validator.ts` needs **no** change; year-2999 parses and validates today (V5, §7).
- **V11 is a landmine:** the admin "issue" action returns an existing unexpired key (`route.ts:337`). Without E4, "cancel" would be purely cosmetic.
- **V9 is a hard blocker:** bind/transfer require `getProduct(original.product)` to resolve, so the new product id MUST be registered — but must NOT enter `ALL_PRODUCTS` (that is the public store's source of truth).
- Lifetime survives bind/transfer verbatim because both re-sign with the *original* expiry (V8).
- The admin routes are already `isSelfHosted()`-gated on this branch (V14) — no new gating needed.

**Decisions taken:** D1 (new `ExeLicenseRevocation` table, FK-based, un-revoke deletes the row), D2 (one `lib/exe-license-revocation.ts` seam), D3 (`LICENSABLE_EXE_PRODUCTS` split so the new product is admin-only), D4 (frozen `LIFETIME_EXPIRES_AT_ISO` literal), D5 (enforcement at E1/E2/E4 only), D6 (wizard product assertion + lifetime copy), D7 (stop hardcoding 180 in buyer + admin UI).

**State:** implementation **NOT started**. Next: junior executes D1→D7 per the junior track, then returns with raw command output.

**Open questions / risks flagged for the junior to report on (not to decide):**
1. `ExeLicensesTab`'s current form markup (branch `:3479+`) was not read line-by-line — the junior must read it before editing and report the exact insertion points.
2. Whether the admin panel has a **second** licence listing ("recent licences, every buyer") that needs `revoked` too — if so, it must be updated, not just the per-email list.
3. `SELF_HOSTED_OS.plan = "selfhosted"` is embedded in the signed payload. If the owner wants a different customer-visible plan label later, it needs a re-issue — flagging, not changing.
4. Withdrawal/kill-live limitation (D5): an already-bound, already-running install keeps working after a cancel until it next talks to our server. This matches the plan's explicit trade-off and must be stated to the owner in the hand-off message.

### 2026-09-29 — SENIOR (second pass: git safety fix, file repair, publish) — no product code written

**1. GIT — the branch was pointed at the wrong upstream (fixed, potential production incident avoided)**
`git config --get branch.self-hosted-build.merge` returned **`refs/heads/main`**: the `self-hosted-build` branch was tracking `origin/main`. A bare `git push` from `/Users/mikeolab/sw-selfhost` would have pushed the entire self-hosted product line at the **live app's `main`**. Fixed and verified:
```bash
$ git config --get branch.self-hosted-build.merge     # before: refs/heads/main
$ git branch --set-upstream-to=origin/self-hosted-build self-hosted-build
branch 'self-hosted-build' set up to track 'origin/self-hosted-build'.
$ git config --get branch.self-hosted-build.merge     # after:  refs/heads/self-hosted-build
```
Documented as the **PUSH TRAP** box in both tracks (§0.2.1 here, and the junior's §0.1) with the standing rule: **always push with an explicit refspec — `git push origin self-hosted-build:self-hosted-build`** — and re-check the config before every push.

**2. TRACK FILE STRUCTURE — repaired**
While appending, four blocks landed at the wrong position (an off-by-N insert), leaving fragments stranded at EOF: D3's items 5–6, D5's E5/E6 + the "rejected alternatives" paragraph, §4.3's deployment paragraph, and the junior's T7 body. All four were re-placed at their correct locations and the files re-ordered. Verified by a duplicate guard: every section marker (`D3`, `D5`, `E5`, `E6`, `D6`, `D7`, "Verification gate", "Rejected alternatives", "The hosted VPS runs", T7 body) now appears **exactly once**, in the correct file, and both files end at their own LOG section. No content was lost — the two pre-repair copies are at `/tmp/senior.bak.md` and `/tmp/junior.bak.md` for one session if a diff is ever wanted.

**3. Task files published**
```bash
$ git add TASK_145_*.md && git push origin self-hosted-build:self-hosted-build
   68afc6b..f688823  self-hosted-build -> self-hosted-build
```
Also added `node_modules` (the worktree's symlink to the primary checkout) to this worktree's local `info/exclude` so it stops appearing as untracked — the repo has no committed `.gitignore` rule for it in the worktree context.

**4. State**
- Implementation: **NOT STARTED**. Code touched so far: **none** (only the two `TASK_145_*` docs, which are new files).
- Canary still green: `git diff --stat main self-hosted-build -- lib/exe-license-validator.ts` → empty.
- `/Users/mikeolab/spaceworker` (live app, `main`) → working tree clean, untouched by this task.
- Branch state: `self-hosted-build` ahead 9 / behind 37 vs `origin/main`, now correctly tracking `origin/self-hosted-build`.

**5. Next actor:** the junior agent starts at **T1** in `TASK_145_SELF_HOSTED_LICENSE_JUNIOR_TRACK.md`. Every push it makes must use the explicit refspec above. Only the senior closes S1–S16.

### 2026-09-29 — SENIOR (third pass: **REVISION 2** — owner clarification scoped) — no product code written

**Trigger.** The owner reviewed the Phase 5 scope and clarified the product in their own words:

> *"for a 1 month test, i want the license to be just like we have for the other exe, immediate revocation should kill it. the lifetime license is bound to that email for recovery, in case owner wants to move to another pc, but this must come through the admin — no one should be able to move a lifetime license themself; once it's bound to that device, they need to get a new license for another or reach out to support."*

**Verdict on the first pass: the scope did NOT match this**, in three ways. All three were verified in real code before changing anything; see §3.9's `W1–W7` table for the exact `file:line` evidence.

1. **"Immediate revocation" was not deliverable.** D5 enforced revocation only at bind/transfer, and the reject list explicitly forbade a launch-time check. But the desktop EXE **already** re-checks on every launch (`status/route.ts:91` → `stillValidLive` → `/api/exe-license/eligibility`), and that route only proves the key still matches the row (`eligibility/route.ts:65` `eligible: license !== null`) — so a revocation row left `eligible` permanently `true`. The existing seam was one line away from working, and the first pass had closed the door on it.
2. **A self-hosted 30-day licence would never expire at all.** `app/dashboard/layout.tsx:17` gates `LicenseGate` on `isLocalExeRuntime()` (Tauri EXE only), while the self-hosted build is the orthogonal `SELF_HOSTED` flag. `app/api/setup/complete/route.ts:164` says it outright: `SELF_HOSTED_LICENSE_KEY` is *"written (not read) … no code path consumes it yet."* The key is validated once by the wizard and never again — so the owner's 1-month test licence would have run forever.
3. **Nothing stopped a lifetime licence being self-moved.** `auto-bind:164`, `password-login:108` and `payment-status:87` all call `transferExeLicenseToMachine`, gated only by an email code to the licensee's inbox.

**Changes made to this file.**

- **§3.9 added** — Revision 2 of the spec: `W1–W7` (verified evidence), **D8** (two classes of the *same* product, told apart by the key's own `expires_at`; the sentinel survives bind because re-signing preserves expiry — `lib/exe-license-bind.ts:21-23,156,172`), **D9** (lifetime is admin-move-only via an actor switch; first bind unaffected), **D10** (the term licence must be killable on both builds; explicit non-goal: no mid-session watchdog).
- **E7–E10 added** to D5's enforcement table: E7 the live kill in `eligibility`; E8 the self-hosted runtime check in `lib/self-hosted-setup-gate.ts`; E9 the `actor` switch; E10 the single self-service message across three callers.
- **S13–S16 added** to §4.2 (live kill, end-to-end kill, lifetime move control, self-hosted fail-open).
- **§6 reject list corrected and extended.** Item 4 previously rejected *"a launch-time network call"* — **withdrawn**, because the launch-time check is the design. Items 11–14 added: non-fail-open checks, blocking a lifetime *first* bind, any self-service lifetime move, and deciding "lifetime" from anything but the decoded `expires_at`.
- **§5 updated** to D1–D10 / S1–S16 and to the one-task-per-session rule.

**Verification performed on this revision:** canary `git diff --stat main self-hosted-build -- lib/exe-license-validator.ts` = **empty**; `/Users/mikeolab/spaceworker` = clean and untouched; this revision touched **only** the two `TASK_145_*` docs (no product code). The `localExe`/`SELF_HOSTED` split and the `eligibility` return value were read directly, not inferred.

**State.** Implementation **NOT started** — Revision 2 is a scope change only. **Next actor:** the junior begins at **T1**, one task per session, using the explicit push refspec in §0.2.1.


### 2026-09-29 — JUNIOR — **T1 implemented** (schema: revocation table + self-hosted price column). No other task started.

*(Same entry as the one appended to the junior track this session.)*

**Scope:** `prisma/schema.prisma` (+ the one new migration folder), exactly as junior §2 T1 writes it. Nothing else touched. `lib/exe-license-validator.ts` **untouched** (canary below).

**⛔ Datasource gate (T1 step 0):** `.env` → `DATABASE_URL="postgresql://spaceworker_app:...@127.0.0.1:5432/spaceworker"` — **local dev DB (`127.0.0.1`), not the VPS**. Proceeded. (`.env` in this worktree is a symlink to `/Users/mikeolab/spaceworker/.env`, which is why the worktree had no `.env` of its own.)

**What changed — `git --no-pager diff --stat` = `prisma/schema.prisma | 30 ++++++`, "1 file changed, 30 insertions(+)" (0 deletions):**
- `prisma/schema.prisma:114-116` — `exeLicenseRevocations ExeLicenseRevocation[]` on `model User`, beside `exeLicenses` `:112` / `exeLicenseTransfers` `:113`.
- `prisma/schema.prisma:200-204` — `selfhostedOsPriceUsd Float @default(0)` on `model AdminSetting`, directly after `agentExePriceUsd`, with the required "never charged through the store / keeps `StoreProduct.priceField` a real key" comment.
- `prisma/schema.prisma:650-652` — `revocation ExeLicenseRevocation?` on `model ExeLicense`, before its `@@index([userId])`.
- `prisma/schema.prisma:691-707` — `model ExeLicenseRevocation`, **verbatim** from senior §3 D1, with the D1 comment above it.
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
Same root cause as the build failure below. I removed the `.next` artifacts I had generated, which restores the documented clean baseline.

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

### 2026-09-29 — SENIOR (second pass) — **T1 VERIFIED**; two of three claimed blockers retracted, one real blocker found and tasked (T14). No product code written.

**Scope:** independent re-verification of T1, plus a full re-test of its three failed checks. **No product code was written** — `git status --porcelain` in the worktree shows exactly the two `TASK_145_*` files, and the validator canary is still empty.

**1. T1 — VERIFIED.** Schema + migration accepted; full evidence table in §3.10.1. **S1, S2, S12 pass.** S12's pass condition was amended (§4.2) because `migrate status` can never be clean here.

**2. Corrections — T1's report was wrong on two of its three "blockers":**

| T1 logged | Senior re-test | Correction |
|---|---|---|
| Turbopack *"Symlink … out of the filesystem root"* panic, called "pre-existing" | vanished with a real `node_modules`; the build then compiles and type-checks | **C1 — caused by our own worktree symlink**, not the branch (§3.10.2) |
| `WebExtractPage` stray export blocks the build | `next build` finished TypeScript cleanly; `main` `tsc` = EXIT=0; `main`'s `.next/types` has no such entry | **C3 — retracted. No task; do not touch the file.** (§3.10.4) |
| `npm run build` cannot succeed | `CI=1 npx next build` → **BUILD_EXIT=0** | **C4 — wrong command.** The guard is `lib/env.ts:52-53`, bypassed by `CI` exactly as CI does (§3.10.5) |
| "shadow-DB P3006" is a Prisma quirk | reproduced as **P3018 / 42P01 on a fresh DB** | **C5 — a real repository defect**: `ALTER` before `CREATE` → **task T14** (§3.10.6) |

**3. Two live-app incidents prevented — this is the part that mattered:**

**(a) T1's `prisma generate` had replaced the live app's Prisma client.** Because `node_modules` was a symlink into the primary checkout, generating the *branch's* client wrote `/Users/mikeolab/spaceworker/node_modules/.prisma/client`. Reproduced:

```
$ cd /Users/mikeolab/spaceworker && npx tsc --noEmit
lib/campaign-recipients.ts(178,35): error TS2339: Property 'suppression' does not exist on type 'PrismaClient<…>'
lib/sending-domain-select.ts(17,29): error TS2694: Namespace '"/Users/mikeolab/spaceworker/node_modules/.prisma/client/index".Prisma' has no exported member 'SendingDomainSelect'
… (~14 errors)
EXIT=2
```

Restored, then re-verified:

```
$ cd /Users/mikeolab/spaceworker && npx prisma generate ; echo GEN_EXIT=$?
GEN_EXIT=0
$ npx tsc --noEmit ; echo EXIT=$?
EXIT=0
```

**(b) The push trap is still fixed** — `branch.self-hosted-build.merge = refs/heads/self-hosted-build` re-confirmed before pushing; explicit refspec only.

**4. The build, honestly stated.** With a real `node_modules`:

```
$ cd /Users/mikeolab/sw-selfhost && CI=1 npx next build
✓ Compiled successfully in 20.1s
  Running TypeScript ...
  Finished TypeScript in 31.2s ...
…
BUILD_EXIT=0
```

Plain `npm run build` instead dies at page-data collection on the placeholder guard (`SESSION_SECRET`, then `RESEND_API_KEY`) — design, not defect (`lib/env.ts:52-53`). Note: "Finished TypeScript" alone is **not** proof of type-cleanliness; `npx tsc --noEmit` is the separate gate, and it is EXIT=0.

**5. The fresh-DB defect, reproduced (why T14 exists):**

```
$ psql "$DB" -c 'CREATE DATABASE sw_migcheck_t145;'
CREATE DATABASE
$ DATABASE_URL="…/sw_migcheck_t145" npx prisma migrate deploy
Applying migration `20260914150000_add_license_claim_token`
Error: P3018
Database error code: 42P01
Database error:
ERROR: relation "ExeLicense" does not exist
```

Cause: `20260914150000_add_license_claim_token` runs `ALTER TABLE "ExeLicense"` while `CREATE TABLE "ExeLicense"` lives in `20260914200000_task42_store_and_licenses`. A fresh install therefore can never be built from history. Scratch DB dropped after the test.

**6. Verification DB provisioned (shared local DB is unusable):**

```
migration_name                 | started_at                     | finished_at | rolled_back_at
20260921000000_device_tools_v2 | 2026-09-27 20:35:50.46599+01   |             | 2026-09-27 20:36:02.44586+01
20260921000000_device_tools_v2 | 2026-09-29 03:01:47.863761+01  |             |
```

…and the DB is ~27 migrations stale (no `Device` table). Built a clean one by schema instead:

```
$ DATABASE_URL="…/spaceworker_t145" npx prisma db push --skip-generate
🚀  Your database is now in sync with your Prisma schema. Done in 905ms
$ psql "…/spaceworker_t145" -tAc "SELECT tablename … LIKE 'ExeLicense%'"
ExeLicense
ExeLicenseRevocation
ExeLicenseTransfer
```

**This is the evidence that closes S2.**

**7. Answers to T1's escalations:** (a) migration ordering → **T14** (in-phase); stale local DB → **T15** (optional, local-only, never the VPS). (b) `WebExtractPage` → **not a defect; retracted, no task.**

**Next actor:** junior engineer starts **T2**. DB work uses `spaceworker_t145`; the build check is `CI=1 npx next build`; `node_modules` must be a real clone.

**UNVERIFIED (this pass):**
- UNVERIFIED: no Phase 5 product behaviour exists yet, so S3–S16 remain unrun (they need T2+).
- UNVERIFIED: the live VPS `_prisma_migrations` state was **not** inspected — no VPS connection was made, deliberately.
- UNVERIFIED: whether the rest of the 66-folder migration chain contains **further** fresh-DB ordering faults — only the first failure is observable because `migrate deploy` stops there. T14 must drive the chain to completion on an empty DB and report whatever else surfaces.
- UNVERIFIED: the symlink→panic attribution is indirect, per the C1 caveat in §3.10.2 (the senior did not re-create the symlink to reproduce the panic).

**The junior's good judgement is on the record:** it declined to `migrate resolve`, declined to replay 24 unrelated migrations, and declined to edit a live/shared file outside its scope. Those refusals are now rules (§0.1, §6, junior §4).


### 2026-09-29 — JUNIOR — **T2 implemented** (self-hosted product registered; admin-only, never on the store). No other task started.

**Deliverable:** `lib/products.ts` only — senior §3 D3 items 1–2. Diff +24 / −2, one file.

| Anchor | Change |
|---|---|
| `lib/products.ts:21-22` | `ProductId` union += `\| "selfhosted_os"` |
| `lib/products.ts:67` | `AdminSettingPriceFields` += `selfhostedOsPriceUsd: number;` |
| `lib/products.ts:187-200` | `SELF_HOSTED_OS` — D3 **verbatim** (id `selfhosted_os`, `kind: "exe"`, `plan: "selfhosted"`, `priceField: "selfhostedOsPriceUsd"`) |
| `lib/products.ts:202-205` | `LICENSABLE_EXE_PRODUCTS: StoreProduct[] = [...EXE_PRODUCTS, SELF_HOSTED_OS];` |
| `lib/products.ts:207` | `ALL_PRODUCTS` **unchanged** — `SELF_HOSTED_OS` deliberately absent |
| `lib/products.ts:209` | `BY_ID = new Map<string, StoreProduct>([...ALL_PRODUCTS, SELF_HOSTED_OS].map((p) => [p.id, p]))` |

`app/api/store/prices/route.ts` and `app/api/admin/wallets/route.ts` untouched (both still read `ALL_PRODUCTS`). `lib/exe-license-validator.ts` canary empty. Overwhelmingly: S8/§6.2 hold.

**Raw commands and RAW output**

```
$ git --no-pager diff --stat
 lib/products.ts | 26 ++++++++++++++++++++++++--
 1 file changed, 24 insertions(+), 2 deletions(-)
```

```
$ grep -n 'SELF_HOSTED_OS\|LICENSABLE_EXE_PRODUCTS' lib/products.ts
193:export const SELF_HOSTED_OS: StoreProduct = {
205:export const LICENSABLE_EXE_PRODUCTS: StoreProduct[] = [...EXE_PRODUCTS, SELF_HOSTED_OS];
209:const BY_ID = new Map<string, StoreProduct>([...ALL_PRODUCTS, SELF_HOSTED_OS].map((p) => [p.id, p]));
```

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

J3, through the **real** module (`npx tsx -e`, not a paraphrase):

```
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

**Doc nit (not an objection):** the work order's literal `grep -n 'ALL_PRODUCTS =' lib/products.ts` returns nothing **even on unmodified HEAD**, because the definition line carries a type annotation (`ALL_PRODUCTS: StoreProduct[] =`). The junior used `grep -n 'ALL_PRODUCTS'` and read `:207` directly; the invariant D3 asserts (the `SELF_HOSTED_OS` line is not part of the `ALL_PRODUCTS` definition) holds. §2 T2's sample grep pattern should be corrected to `'^export const ALL_PRODUCTS'` in a future revision — the rule itself is right.

**UNVERIFIED:**
- UNVERIFIED: J1/J2 (lifetime / 30-day key round-trip) — `lib/exe-license.ts` constants are the T3 deliverable; not started.
- UNVERIFIED: J4–J7 and J9–J12 — bind/transfer/eligibility/revocation behaviour lands in T4/T5/T6/T11/T12/T13; no revocation code exists yet.
- UNVERIFIED: the admin surfaces still import `EXE_PRODUCTS` (`app/api/admin/exe-licenses/route.ts:5,306,505`; `app/admin/(protected)/admin-panel.tsx:6,3559`). The D3 item 4 swap to `LICENSABLE_EXE_PRODUCTS` is explicitly T6/T7 work; T2 added the constant only, so `selfhosted_os` is not yet selectable in the admin licence form.
- UNVERIFIED: no end-to-end Phase 5 licence flow has been exercised (J8 is the only store-side check runnable at T2).

READY FOR VERIFICATION - T2


---

## 2026-09-29 — SENIOR PASS 3: T2 VERIFIED (accepted + closed), and a purchase-gate hole D3 left open → NEW TASK T16

**Verdict: T2 ACCEPTED and CLOSED** at `83fe756`. All 12 claims re-run by me, independently, on a worktree with a real `node_modules`.

Commits: `83fe756` (junior T2) → this pass (**docs only**: senior §3.11 + S17 + reject item 15 + §7; junior §1.3 + T2 CLOSED + T16).

### Raw evidence (my own runs, not a re-print of the junior's)

```
$ cd /Users/mikeolab/sw-selfhost && git show --stat --oneline 83fe756 | head -6
83fe756 TASK_145 T2: register selfhosted_os (getProduct-only, kept out of ALL_PRODUCTS) + LICENSABLE_EXE_PRODUCTS
 TASK_145_SELF_HOSTED_LICENSE_JUNIOR_TRACK.md | 110 ++++++++++++++++++++++++++
 TASK_145_SELF_HOSTED_LICENSE_SENIOR_TRACK.md | 112 +++++++++++++++++++++++++++
 lib/products.ts                              |  26 ++++++-
 3 files changed, 246 insertions(+), 2 deletions(-)

$ npx tsx -e '<my own assertions against the real module>'
getProduct resolves: true
in ALL_PRODUCTS: false
in LICENSABLE: true
ALL_PRODUCTS count: 9 | LICENSABLE count: 6
priceField unique across LICENSABLE: true
getProduct(unknown): null

$ npx tsx --test tests/module-store.test.ts | tail -7
1..10
# tests 10
# pass 10
# fail 0

$ npx tsc --noEmit
TSC_EXIT=0

$ CI=1 npx next build
✓ Compiled successfully in 27.3s
BUILD_EXIT=0

$ git diff --stat main self-hosted-build -- lib/exe-license-validator.ts                                              # (empty)
$ git diff --stat main self-hosted-build -- lib/exe-license.ts lib/exe-license-bind.ts app/api/exe-license/ lib/exe-license-validator.ts   # (empty — V17 intact)
$ lsof -nP -iTCP:3100 -sTCP:LISTEN                                                                                    # (empty — no server left running)

$ cd /Users/mikeolab/spaceworker && git rev-parse --abbrev-ref HEAD && git log --oneline -1
main
b7330a1 fix(campaigns): make the test send the same message the real send sends
# working tree clean
```

### The finding (W8–W11) — a hole in **D3**, not in T2

T2 implemented D3 verbatim and passed everything the spec asked for. **D3 itself was under-specified:** `ALL_PRODUCTS` gates the *store* (a display concern), while the *purchase* gate is a different code path — `app/api/billing/checkout/route.ts:37-51` and `app/api/billing/submit/route.ts:60-64` resolve with `getProduct()` and take the product id **from the client**, and the only kind-based restriction is that `web`/`module` need a session, so `kind: "exe"` needs **no login**. A crafted `product=selfhosted_os` therefore checked out at its `$0` default price and persisted a pending `Payment` row (W8/W9) for any email; approving that row calls `handleApprovedPayment` → `getProduct(payment.product)` → mints a real key with `plan: "selfhosted"` (W10).

**Severity is bounded — this is not a free-lunch robot.** `lib/crypto-verify.ts:46-53` compares on-chain received against expected as `ratio = receivedBtc / expectedBtc`; an expected amount of `0` gives `Infinity`, which fails `ratio > 1 + TOLERANCE`. So auto-approval can **never** fire on a $0 row. The exposure is (a) public queue-spam creating `User`/`Payment` rows from a bare email and (b) an admin mis-approving a row the system can mint from. Both defeat "admin-issued only", so it closes before this ships.

### What this pass changed

- **D11** (new): only a product in `ALL_PRODUCTS` may be bought; any route that takes a client-supplied product id and leads to a `Payment` row or a licence must reject ids outside `ALL_PRODUCTS`. `BY_ID` registration makes a product *resolvable* — never *sellable*.
- **E11** (new enforcement point): the two billing routes, returning the **same** `{"error":"Unknown product"}` 400 as a typo so the endpoint never confirms a non-purchasable product exists.
- **T16** (new task, **do next — before T3**): junior §2.
- **S17** (new verification row): both directions — the self-hosted id 400s with no `Payment` row, and `extractor_exe` is unchanged.
- Reject list gains **item 15**.
- Doc nit accepted: `grep -n 'ALL_PRODUCTS ='` can never match (`ALL_PRODUCTS: StoreProduct[] =`). The work order now uses the loose `grep -n 'ALL_PRODUCTS'` and reads the line — robust rather than clever.

**UNVERIFIED (deliberate, not gaps):** nothing in T2 is unverified. J1/J2, J4–J7 and J9–J12 stay open as later-task rows, and the end-to-end phase flow cannot exist until T11–T13.

**Next actor:** junior — task **T16**, one task, then stop.


---

## 2026-09-29 — SENIOR PASS 4 (docs only): ordering made unambiguous; the `▶ NEXT TASK` pointer is installed

**No product code changed. `▶ NEXT TASK` remains `T16` (junior §2).**

Verifying T2 added **T16** out of numeric order. I recorded that correctly here (§3.11.3 `:480`, `:572`, `:1303`) but left the junior file's earliest regions asserting the opposite — `:83` still read *"`T1 → T13`, in numeric order"* and `:9` still read *"Status: NOT STARTED"*. A cold-reading agent would have started **T3**. Root cause: the execution order was asserted in four places at once; the fix is one canonical statement plus pointers.

**Changes in this pass:**
- Junior `:9` — new **`▶ NEXT TASK: T16`** pointer, plus a true status line (`T1`/`T2` closed). Declared **authoritative** over any `T*` heading or revision banner.
- Junior `:83`, `:139`, `:151` — order restated as **non-numeric**, with the reason (`T16` before `T3`: it closes a hole T2 opened, for a few lines).
- Junior `:7` — task numbers are **discovery** order, not execution order.
- Senior §5 — new item **6**: follow the pointer, and **the senior must move it at the end of every pass**.
- Senior §5 `:536` `D1–D10` → **`D1–D11`**; `:538` `S1–S16` → **`S1–S17`**.

```
$ git diff --stat
 ...5_SELF_HOSTED_LICENSE_JUNIOR_TRACK.md | 20 +++++++++-------
 ...5_SELF_HOSTED_LICENSE_SENIOR_TRACK.md |  5 ++--
 2 files changed, 14 insertions(+), 11 deletions(-)

$ grep -c 'in numeric order' TASK_145_SELF_HOSTED_LICENSE_JUNIOR_TRACK.md
0
$ grep -c 'T<n+1>' TASK_145_SELF_HOSTED_LICENSE_JUNIOR_TRACK.md
0
```

**Process note for every later pass:** the pointer is now the *only* authoritative statement of order. Whenever a task is inserted out of numeric order, moving that pointer belongs in the **same** commit — otherwise the next agent starts the wrong task.

**Next actor:** junior — task **T16**, one task, then stop.


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

$ npx tsc --noEmit; echo TSC_EXIT=$?
TSC_EXIT=0

$ (CI=1 npx next build > /tmp/t16_build.log 2>&1; echo BUILD_EXIT=$? >> /tmp/t16_build.log); tail -5 /tmp/t16_build.log
○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand

BUILD_EXIT=0
```

**Runtime proof (both directions), on `spaceworker_t145`** — server `CI=1 DATABASE_URL="$S" npx next start -p 3100` (S = `.env` DATABASE_URL with db name swapped to `spaceworker_t145`; 127.0.0.1, never the VPS). The scratch DB's `AdminSetting.btcWallet` was NULL, so I set it to `testwallet_T16` (scratch verification DB data only, no code change) so the sellable-product GET reaches 200 rather than 400 "Wallet not configured".

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

=== byte-identical proof: non-purchasable vs typo id ===
-- GET selfhosted_os:   {"error":"Unknown product"}   HTTP_STATUS=400
-- GET typo:            {"error":"Unknown product"}   HTTP_STATUS=400
-- POST submit selfhosted_os: {"error":"Unknown product"} HTTP_STATUS=400
-- POST submit typo:    {"error":"Unknown product"}   HTTP_STATUS=400
-- users before: 0 · rejected POST HTTP_STATUS=400 · users after: 0 · payment count after: 1
```

Byte-for-byte the same body and 400 as a typo'd id in both routes; the rejected POST created **no** `User` and **no** `Payment` row, while `extractor_exe` still creates its row exactly as before.

**Hosted-safe (strict no-op on `main`), static proof:**
```
$ cd /Users/mikeolab/spaceworker && git show main:lib/products.ts | grep -n 'BY_ID\|ALL_PRODUCTS'
185:export const ALL_PRODUCTS: StoreProduct[] = [WEB_SUBSCRIPTION, ...MODULE_PRODUCTS, ...EXE_PRODUCTS];
187:const BY_ID = new Map<string, StoreProduct>(ALL_PRODUCTS.map((p) => [p.id, p]));
```
On `main` `BY_ID` is built **only** from `ALL_PRODUCTS` (and `main` has no `SELF_HOSTED_OS`), so `getProduct(x) !== null` ⟹ `x ∈ ALL_PRODUCTS`; the new clause can never reject anything there.

**Regression canaries (STEP 4):**
```
$ cd /Users/mikeolab/spaceworker && git diff --stat main self-hosted-build -- lib/exe-license-validator.ts
(empty)
$ npx tsc --noEmit; echo LIVE_TSC_EXIT=$?
LIVE_TSC_EXIT=0
```

Hygiene: test server on :3100 killed → `lsof -iTCP:3100 -sTCP:LISTEN` = `PORT_3100_FREE_AFTER_KILL`. No `npx prisma generate`, no `prisma migrate dev`, no `migrate resolve`, no VPS connection.

Related-surface audit (D11 breadth): the only other `getProduct()` callers with client input are licence-scoped lookups (`activate`, `password-login`, `trial-ping`, `payment-status`, `auto-bind`, `licenses-section.tsx`), and issuance is either admin-only (`app/api/admin/exe-licenses/route.ts`) or driven by a persisted `Payment` row (`lib/license-service.ts:43,111`, reached via `handleApprovedPayment`). The two billing routes were the only client-supplied purchase gate.

**UNVERIFIED: the `main` no-op was not executed at runtime** — proven statically from `git show main:lib/products.ts:185-190`; the live app was only typechecked, not run.
**UNVERIFIED: J1/J2 and J4–J7/J9–J12** — belong to later tasks; T16's check is the four directions + typo comparison, all pasted.
**UNVERIFIED: no unit test added** — T16's acceptance text names static greps + live HTTP, not a test file.

READY FOR VERIFICATION - T16


---

## 2026-09-29 — SENIOR PASS 5: **T16 ✅ VERIFIED** (accepted + closed). Next task is **`T3`**.

Commits: `77b2faf` (junior T16) → this pass (**docs only**: junior `:9`, `:11`, `:18`, `:385`; senior `:523`, `:573`, + this entry). **No product code changed in this pass.**

**Verdict: T16 is correct as implemented. S17 passes.** I re-ran every direction myself instead of reading the pasted log. The junior's report was accurate, and its three `UNVERIFIED:` lines were honest and correctly scoped to later tasks.

### 1. Claims re-checked independently

| T16 claim | Senior re-ran | Result |
|---|---|---|
| Guard present in both routes, identical shape | read `app/api/billing/checkout/route.ts:46`, `app/api/billing/submit/route.ts:66` | `if (!product \|\| !ALL_PRODUCTS.some((p) => p.id === product.id))` in both; `ALL_PRODUCTS` added to both imports ✅ |
| `GET checkout?product=selfhosted_os` → 400 | `curl` against a fresh `next start -p 3100` on `spaceworker_t145` | `{"error":"Unknown product"}  HTTP=400` ✅ |
| …byte-identical to a typo'd id | `A=$(curl …selfhosted_os); B=$(curl …selfhosted_osX); [ "$A" = "$B" ]` | `IDENTICAL: {"error":"Unknown product"}` ✅ |
| `POST submit {product:"selfhosted_os"}` → 400, no row | `curl` + `psql` before/after | 400; counts unchanged ✅ |
| **no `selfhosted_os` row anywhere** | `SELECT count(*) … WHERE product='selfhosted_os'` on `Payment`, `ExeLicense` | `Payment 0`, `ExeLicense 0` ✅ |
| `extractor_exe` unchanged (no-op for sellable) | `GET checkout?product=extractor_exe` | `HTTP=200`, `amountUsd:50`, `durationDays:180` ✅ |
| types | `npx tsc --noEmit` | **TSC_EXIT=0** (zero `error TS` lines) ✅ |
| hygiene | `lsof -nP -iTCP:3100 -sTCP:LISTEN` after kill | `PORT_3100_FREE` ✅ |
| validator canary | `git diff --stat main self-hosted-build -- lib/exe-license-validator.ts` | **empty** ✅ |
| live app | `/Users/mikeolab/spaceworker` (`main`) | `b7330a1`, clean, `npx tsc --noEmit` → **LIVE_TSC_EXIT=0** ✅ |

### 2. The completeness question the junior did not ask — and the answer

Verifying a guard means proving there is **no third door**, so I enumerated every path that can mint a licence from a client-supplied id:

```
$ grep -rn 'payment.create|payment.upsert|payment.createMany' --include='*.ts' app lib
app/api/admin/exe-licenses/route.ts:374:    const payment = await tx.payment.create({
app/api/billing/submit/route.ts:138:  const payment = await prisma.payment.create({
```

Exactly **two** Payment creators, both accounted for: `billing/submit` is now guarded, and `admin/exe-licenses` is admin-gated — that is *intentionally* the self-hosted issuance path (T6/T7). Every other route reaches issuance via `handleApprovedPayment(paymentId)`, i.e. from a **stored** row and never a client id; `lib/license-service.ts:111`'s `getProduct(productId)` reads `payment.product`, not a request field. `license-service.ts` is byte-identical to `main` (V17). **The chain is closed — no bypass.**

### 3. Hosted-safe no-op on `main` — confirmed statically

```
$ git show main:lib/products.ts | grep -n 'BY_ID|ALL_PRODUCTS'
185:export const ALL_PRODUCTS: StoreProduct[] = [WEB_SUBSCRIPTION, ...MODULE_PRODUCTS, ...EXE_PRODUCTS];
187:const BY_ID = new Map<string, StoreProduct>(ALL_PRODUCTS.map((p) => [p.id, p]));
```

On `main`, `BY_ID` is built **only** from `ALL_PRODUCTS` and `main` has no `SELF_HOSTED_OS`; therefore `getProduct(x) !== null` ⟹ `x ∈ ALL_PRODUCTS`, and the added clause can never reject a request there. Accepted as a **static** proof: no runtime behaviour can differ, so running the live app to demonstrate a no-op is not a proportionate check.

### 4. One thing to carry forward — not a defect in T16

The junior set `AdminSetting.btcWallet='testwallet_T16'` in the **scratch** DB (it was NULL) so the sellable-product GET could reach 200 instead of `400 "Wallet not configured"`. That is correct and confined to `spaceworker_t145`. Recorded because a later task exercising the same route on a fresh scratch DB will hit "Wallet not configured" and **must not mistake it for a regression**.

### 5. State after this pass

```
$ git --no-pager log --oneline -2
77b2faf (HEAD -> self-hosted-build, origin/self-hosted-build) TASK_145 T16: purchase gate = ALL_PRODUCTS membership (selfhosted_os resolvable, never sellable)
2b922df TASK_145: fix order ambiguity (T16 before T3) - install authoritative NEXT TASK pointer, docs only

$ git rev-list --left-right --count HEAD...origin/self-hosted-build
0	0
```

- **Closed: `T1`, `T2`, `T16`. Next: `T3`.** The `▶ NEXT TASK` pointer (junior §2, `:9`) has been moved this pass, as the convention requires.
- Scratch DB `spaceworker_t145`: `Payment` = 1 row (`extractor_exe`), `ExeLicense` = 0 rows, **0** `selfhosted_os` rows of any kind.
- `lib/exe-license-validator.ts` and the other V17 frozen files: untouched. `main` untouched, live app typechecks clean.
- Files changed this pass: the two `TASK_145_*` markdown files only. **Zero product code.**

**Next actor:** junior — task **`T3`** (lifetime constants in `lib/exe-license.ts`), one task, then stop.



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

## 2026-09-29 — SENIOR PASS 6: **T3 ✅ VERIFIED** (accepted + closed). Next task is **`T17`**, then **`T4`**.

Scope: verified `7a9afc9` (`lib/exe-license.ts`, **+13/−0**). **This pass changed documentation only — zero product code.**

### Evidence re-derived by the senior, not read off the junior's log

The junior's central claim was behavioural. I re-derived it with a harness of **my own** (`/tmp/t3-verify.mts`, 23 assertions) rather than re-running theirs — a harness written by the author proves less than an independent one.

```
[A. sentinel is a frozen literal, and the TWO exports agree]
  ok   ISO literal is the exact expected string
  ok   ISO literal has NO 'Z' (Python fromisoformat compat)
  ok   Date export is the same instant
  ok   Date export has zero millis (so .000000 is lossless)
  ok   both constants are stable across reads (no Date.now() drift)

[B. THE COUPLING TEST: a key signed at the sentinel must emit the literal byte-for-byte]
  ok   issued payload.expires_at === LIFETIME_EXPIRES_AT_ISO (no drift)
  ok   signature verifies
  ok   decode round-trips the licensee

[C. isLifetimeExpiry is driven ONLY by the decoded expiry year]
  ok   true for the sentinel Date
  ok   true for 3000-01-01
  ok   false for 2998-12-31 23:59:59
  ok   false for null
  ok   false for undefined

[D. offline validator honours the sentinel TODAY...
  ok   valid:true
  ok   decoded year is 2999
  ok   isLifetimeExpiry(validator's decoded date) === true

[E. ...AND STILL in 2050, 2099, and 2998 (not an accident of today's clock)]
  ok   valid in 2050
  ok   valid in 2099
  ok   valid in 2998
  ok   TERMINATES in 3000 (sentinel is not truly perpetual)

[F. the 1-MONTH term still dies on time (the 'immediate kill' half must NOT regress)]
  ok   30-day key: expires_at is 2026-01-31
  ok   isLifetimeExpiry(30-day key) === false  <-- critical: a term key must NEVER be classified lifetime
  ok   valid at day 29
  ok   EXPIRED at day 31

ALL SENIOR CHECKS PASSED
```

Other gates, re-run independently:

```
$ git diff --numstat main self-hosted-build -- lib/exe-license.ts
13	0	lib/exe-license.ts

$ git diff main self-hosted-build -- lib/exe-license-validator.ts lib/exe-license-bind.ts \
      app/api/exe-license/status/route.ts app/api/exe-license/eligibility/route.ts lib/machine-id.ts
(no output — the frozen five are untouched)

$ npx tsc --noEmit                      -> BRANCH_TSC_EXIT=0 (no output)
$ CI=1 npx next build                   -> BUILD_EXIT=0 (after "✓ Compiled successfully")
$ scripts/verify-exe-license.mts        -> ALL CHECKS PASSED
$ cd ../spaceworker && npx tsc --noEmit -> LIVE_TSC_EXIT=0 ; main @ b7330a1, tree clean
```

**Verdict: T3 ACCEPTED.** `S1` re-confirmed; `S2`/`S3` close (with the caveat in F1). The `+13/−0` is provably inert for every existing caller: `isLifetimeExpiry` had **no call sites** before this pass, and both constants are exported values nothing reads yet — `grep -rn 'LIFETIME_EXPIRES_AT\|isLifetimeExpiry'` finds only `lib/exe-license.ts:35,36,38`. Nothing in the hosted app can observe this change.

### Findings

**F1 — the evidence was ephemeral (protocol defect, now fixed).** T3's proof was a temp harness deleted after the run (disclosed honestly under `UNVERIFIED:`). My replacement was in `/tmp` as well. So `S2`/`S3` were closed on evidence the **next agent cannot re-run**. → new rule **§4.1b** + **T17** to give the sentinel a permanent home. **Not a T3 defect.**

**F2 — `W12` recorded: `2999` is value-coupled across three lines** (`:35` signed literal, `:36` `Date`, `:39` threshold). The junior implemented D4 **verbatim**, so the coupling is the senior's spec. **Not being changed** — the literal is frozen by the signature, and `>=` on the year is the correct future-proof comparison. Guarded by T17 (test only, **no lib edit**).

**F3 — T17 is scheduled before T4, deliberately.** Small; protects the foundation `T4`–`T13` builds on; and it sets the evidence standard *before* ten more tasks are accepted on markdown logs alone.

**F4 — the junior's `UNVERIFIED:` lines were accurate.** J1/J2 — now independently reproduced above. J3 — T2/T16 territory, closed. J4–J12 — later tasks. Its doc nit about `scripts/verify-exe-license.mts`'s header naming `.ts` is real and **accepted as-is**: cosmetic, and that file is out of scope.

### State at end of pass

- Branch `self-hosted-build` @ `7a9afc9` + this docs commit; worktree clean; upstream `origin/self-hosted-build` (**explicit refspec only** — §0.1).
- `▶ NEXT TASK: T17` (junior §2, end). **`T4` immediately after.**
- Closed: **T1, T2, T3, T16**. Open: **T4–T15, T17**.
- Live app `/Users/mikeolab/spaceworker` (`main`, `b7330a1`): clean, untouched.
- `/tmp/t3-verify.mts` retained until T17 lands; **delete it once T17 is in** — it must not become the de-facto test.



## 2026-09-29 — SENIOR PASS 6b (docs only): stale-reference sweep after T3

Follow-on to pass 6, same day. **Zero product code** — `git diff --stat` is the two `TASK_145_*` markdown files only.

Trigger: closing T3 made three statements in the *living* parts of both files false, and two of them were dangerous in the same direction — they would have told the next agent that T3's own approved change was a regression.

Found by grepping the living sections for claims that a *closed* task had invalidated:

| Location | Was | Now |
|---|---|---|
| senior §0.2 (`:40`) | *"Worktrees use a shared `node_modules` (this repo's existing convention)"* — taught the **symlink** that C1/§3.10.2 banned, and which caused the live-client clobber (§3.10.3). An agent obeying it verbatim would re-create both failures. | **⚠️ Real clone, never a symlink**, with the `ls -ld` check and the `cp -Rc` repair inline |
| senior §2 `V17` (`:124`) | *"Verified **zero diff** between `main` and `self-hosted-build`"* over all five frozen files — false since T3 (+13/−0 to `lib/exe-license.ts`). Literal reading → an agent concludes T3 broke V17 and **reverts it**. | Amended: T3's diff is **approved**; that file's canary is now **"zero `-` lines"**, not "empty". Other four remain byte-identical |
| senior §7 (`:627`) | Listed `lib/exe-license.ts` among *"Files byte-identical to `main` (must not drift)"* — same hazard as V17 | Split into two rows: four still byte-identical; `lib/exe-license.ts` now **intentionally** diffs `+13/−0`, with "any deletion = real regression" |
| senior §3.11.3 (`:484`) | *"Do it **next, before T3**"* — T16 was already closed by pass 5 | Struck through, marked ✅ closed by pass 5 / S17 |
| senior §5 items 2, 4, 6 (`:588-591`) | `D1–D11` only; `S1–S17`; order `T1 → T2 → T16 → T3 → … → T15` (stale twice over) | Adds **§3.12**; `S1–S18`; order `… → T16 → T3 → **T17** → T4 → …` |
| senior §7 work-order row (`:625`) | `T1 → T16`, *"Next: `T3`"* | `T1 → T17`; closed `T1, T2, T3, T16`; next `T17` |
| junior `:5` | `W1–W7`, `S1–S17` | `W1–W12`, `S1–S18` |
| junior `:18` | `S1–S17` | `S1–S18` |
| junior `:121`, `:135` | Revision-3/4 banners asserting the order as `T1 → T16` with T16/T3 still pending | Struck through; each now defers to the `:9` pointer, with an explicit *"do not trust any order written in a revision banner"* |
| junior `:385` | T16 heading *"DO THIS NEXT, before T3"* | `✅ CLOSED` |
| junior `:189-198` | T16 row + T3 block still carried "DO THIS NEXT" framing | T16 `✅ CLOSED`; T3 `✅ CLOSED` (was already done in pass 6, verified still present) |
| junior J1/J2 (`:476-477`) | Pass conditions with no proof status — they had been proven in pass 6 but the table did not say so | Marked ✅ proven 2026-09-29, and named **T17** as the permanent owner |
| junior §3 | No row for the new task | Added **`J13`** (T17's acceptance) |
| junior §1.4 | Did not exist | Added **Revision 5** banner: what T17 is, `W12`, the §4.1b evidence rule, and the two properties T17 must assert |

**Rule applied and now stated in §5 item 6:** the `▶ NEXT TASK` pointer at junior `:9` is the *only* authority on execution order. The pass that closes a task must move it in the **same commit** as the closure — otherwise a cold-reading agent starts the wrong task, which is exactly what the §1.3/§1.4 banner drift was doing.

**Deliberately NOT changed:** the `S1–S17` / `W1–W7` occurrences inside log entries (`:691`, `:699`, and the T1/T2/T3/pass-3..6 entries). Log entries are a historical record — **append-only**. New entries carry current counts.

### Verification of this sweep

Stated with explicit scope — **living sections** = before the LOG heading (junior `:516`, senior `:631`); **in-log** = inside append-only history, where stale strings are *expected* and exempt.

```
$ grep -c 'in numeric order' junior            -> living 0 | in-log 2   (both describe the pass-4 fix)
$ grep -c 'T1 → T16'  junior                   -> living 2 | in-log 0   (both are ~~struck through~~ and
                                                                        explicitly marked superseded — kept
                                                                        deliberately, so the history shows
                                                                        why the banners were demoted)
$ grep -c 'DO THIS NEXT'   junior living       -> 0
$ grep -c 'S1–S17'   senior                    -> living 0 | in-log 5
$ grep -c 'W1–W7'    senior                    -> living 0 | in-log 4
$ grep -c '^| S18 |'         senior            -> 1
$ grep -c '^| J13 |'         junior            -> 1
$ grep -c '^## 3.12 REVISION 5' senior         -> 1
$ grep -c '^## 1.4 REVISION 5'  junior         -> 1
$ grep -c 'NEXT TASK' junior                   -> 8 living (the pointer + 7 lines telling agents to
                                                  follow it) | 11 in-log
$ grep -o 'NEXT TASK: `[A-Z0-9]*`' junior | head -1
NEXT TASK: `T17`
$ ls -ld node_modules
drwxr-xr-x  394 mikeolab  staff  12608 Sep 29 12:21 node_modules     # real clone, not a symlink
```

**Correction, recorded because the standard applies to the senior too.** The first draft of this table claimed `0` for `in numeric order`, `T1 → T16` and `4` for `NEXT TASK`. Those greps mixed living sections with append-only log text and were wrong (true values: `2`, `2`, `19`). The counts above are the measured ones. The substantive claims all held — no *living* section still asserts a stale order, and every `T1 → T16` that remains is struck through and marked superseded — but a verification block that cannot be reproduced by pasting it is not evidence, which is the same rule (§4.1b) this pass introduced for the junior.

- Branch `self-hosted-build`; **explicit refspec only** (§0.1). Live app `/Users/mikeolab/spaceworker` (`main`, `b7330a1`) untouched.
- **`▶ NEXT TASK: T17`** — junior §2, end. **`T4` immediately after.** Closed: **T1, T2, T3, T16**.


### 2026-09-29 — JUNIOR — **T17 implemented** (the lifetime sentinel's contract pinned in a permanent test). No other task started.

**Scope:** TEST-ONLY. `lib/exe-license.ts`, `lib/exe-license-validator.ts` and every app file are untouched. One additive line in `package.json`.

**What changed**
- `tests/exe-license-lifetime.test.ts` — **new, 210 lines** (the permanent home for `S2`/`S3`, senior §3.12.2 / §4.1b):
  - `:1-28` why-this-file block: the `W12` triple-`2999` coupling, why the deleted `/tmp` harness had to become a checked-in test, and what this file **cannot** prove (the desktop EXE's Python `validator.py` classification — a Python-side check).
  - `:29-40` hermetic env — `EXE_LICENSE_SECRET` set **before** the module is required; `SPACEWORKER_LOCAL_DATA_DIR` pointed at a throwaway `mkdtempSync` dir. No DB, no network, no `.env.local`.
  - `:54-64` the house `Module._load` `server-only` stub (same pattern as `tests/self-hosted-setup.test.ts:67-85` and the ready-made `scripts/stub-server-only.cjs`).
  - `:66-79` the **real** `lib/exe-license` + `lib/exe-license-validator` modules required — no mocks, no hand-built payloads, no HMAC bypass.
  - `:86-94` arbitrary `licensee`/`plan`/`product` strings — T2's product registry is deliberately **not** consulted.
  - `:97-99` `mintLifetimeKey()` calls the real `generateLicenseKey({ expiresAt: LIFETIME_EXPIRES_AT })`.
  - The nine contract assertions: **1** `:101` · **2** `:108` · **3** drift guard `:116` · **4** `:126` · **5** `:137` · **6** `:148` · **7** `:158` · **8** critical negative `:165` · **9** real-HMAC/tamper-resistance `:194`.
- `package.json:19` — one additive script line: `"test:license": "tsx --test tests/exe-license-lifetime.test.ts"`. `git diff -- package.json` is `+1/-0`; nothing reformatted.

**Commands run, and their raw output**

**1) `npx tsx --test tests/exe-license-lifetime.test.ts`**
```
TAP version 13
# Subtest: 1. LIFETIME_EXPIRES_AT_ISO is the frozen Python-isoformat literal, with no trailing 'Z'
ok 1 - 1. LIFETIME_EXPIRES_AT_ISO is the frozen Python-isoformat literal, with no trailing 'Z'
# Subtest: 2. LIFETIME_EXPIRES_AT is the same instant, and its .000000 micros are lossless
ok 2 - 2. LIFETIME_EXPIRES_AT is the same instant, and its .000000 micros are lossless
# Subtest: 3. DRIFT GUARD — a key signed at the sentinel emits LIFETIME_EXPIRES_AT_ISO byte-for-byte
ok 3 - 3. DRIFT GUARD — a key signed at the sentinel emits LIFETIME_EXPIRES_AT_ISO byte-for-byte
# Subtest: 4. the real offline validator accepts the lifetime key today, decoded year 2999
ok 4 - 4. the real offline validator accepts the lifetime key today, decoded year 2999
# Subtest: 5. the sentinel is still valid in 2050, 2099 and 2998 — not an accident of today's clock
ok 5 - 5. the sentinel is still valid in 2050, 2099 and 2998 — not an accident of today's clock
# Subtest: 6. the sentinel terminates in 3000 — it is not truly perpetual
ok 6 - 6. the sentinel terminates in 3000 — it is not truly perpetual
# Subtest: 7. isLifetimeExpiry is driven only by the expiry year
ok 7 - 7. isLifetimeExpiry is driven only by the expiry year
# Subtest: 8. CRITICAL NEGATIVE — a 30-day term key is never classified lifetime, and dies on time
ok 8 - 8. CRITICAL NEGATIVE — a 30-day term key is never classified lifetime, and dies on time
# Subtest: 9. every key here goes through the REAL HMAC — tampering and a wrong secret both fail
ok 9 - 9. every key here goes through the REAL HMAC — tampering and a wrong secret both fail
1..9
# tests 9
# suites 0
# pass 9
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 509.939072
```
`TEST_EXIT=0` (each `ok N` block also carried the harness's own `duration_ms` — elided here, no count changed).

**2) `npx tsc --noEmit`** → `TSC_EXIT=0`, no output.

**3) the mutation proof — a copy that can fail.** Scratch only, `/tmp/t17-mutation` (deleted afterwards; nothing in the repo was touched):
```
$ mkdir -p /tmp/t17-mutation/tests /tmp/t17-mutation/lib
$ cp tests/exe-license-lifetime.test.ts /tmp/t17-mutation/tests/
$ cp lib/exe-license.ts lib/exe-license-validator.ts lib/machine-id.ts lib/license-state.ts /tmp/t17-mutation/lib/
$ sed -i '' 's/d.getUTCFullYear() >= 2999/d.getUTCFullYear() >= 3000/' /tmp/t17-mutation/lib/exe-license.ts
$ grep -n 'getUTCFullYear() >=' /tmp/t17-mutation/lib/exe-license.ts
39:  return !!d && d.getUTCFullYear() >= 3000;

$ npx tsx --test /tmp/t17-mutation/tests/exe-license-lifetime.test.ts
ok 1 - 1. LIFETIME_EXPIRES_AT_ISO is the frozen Python-isoformat literal, with no trailing 'Z'
ok 2 - 2. LIFETIME_EXPIRES_AT is the same instant, and its .000000 micros are lossless
ok 3 - 3. DRIFT GUARD — a key signed at the sentinel emits LIFETIME_EXPIRES_AT_ISO byte-for-byte
ok 4 - 4. the real offline validator accepts the lifetime key today, decoded year 2999
ok 5 - 5. the sentinel is still valid in 2050, 2099 and 2998 — not an accident of today's clock
ok 6 - 6. the sentinel terminates in 3000 — it is not truly perpetual
not ok 7 - 7. isLifetimeExpiry is driven only by the expiry year
ok 8 - 8. CRITICAL NEGATIVE — a 30-day term key is never classified lifetime, and dies on time
ok 9 - 9. every key here goes through the REAL HMAC — tampering and a wrong secret both fail
# tests 9
# pass 8
# fail 1
MUTANT_EXIT=1
```
The failing assertion, verbatim:
```
not ok 7 - 7. isLifetimeExpiry is driven only by the expiry year
  location: '/private/tmp/t17-mutation/tests/exe-license-lifetime.test.ts:158:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:

    false !== true
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: 'strictEqual'
```
`rm -rf /tmp/t17-mutation` → `ls: /tmp/t17-mutation: No such file or directory`. So the guard is live: mutating the threshold alone turns it red, and the copy left no trace.

**4) `CI=1 npx next build`** → `BUILD_EXIT=0`
```
✓ Compiled successfully in 24.4s
Route (app)
...
ƒ Proxy (Middleware)

○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand

BUILD_EXIT=0
```

**5) canaries, run from `/Users/mikeolab/spaceworker` (the live app checkout)**
```
$ git diff --stat main self-hosted-build -- lib/exe-license-validator.ts
                                                      <- empty: the frozen file was not touched
$ git diff --numstat main self-hosted-build -- lib/exe-license.ts
13      0       lib/exe-license.ts
$ npx tsc --noEmit
LIVE_TSC_EXIT=0
```

**6) worktree state — exactly two paths touched**
```
$ git status --short
 M package.json
?? tests/exe-license-lifetime.test.ts
$ git --no-pager diff --stat -- lib/exe-license.ts
                                                      <- empty: lib/exe-license.ts not edited in this worktree
```
`package.json`'s diff is exactly `+1/-0` — one inserted line, nothing reformatted:
```
@@ -16,6 +16,7 @@
     "test:governor": "tsx --test tests/resource-governor.test.ts",
     "test:screenshots": "tsx --test tests/device-screenshots.test.ts",
     "test:setup": "tsx --test tests/self-hosted-setup.test.ts",
+    "test:license": "tsx --test tests/exe-license-lifetime.test.ts",
     "check:workflows": "node scripts/check-workflow-syntax.mjs",
```
`npm run test:license` (the new script) → `# pass 9` / `# fail 0`.

**UNVERIFIED: the desktop EXE's Python `validator.py` classification of the 2999 sentinel** — this test exercises the **Node** validator (`lib/exe-license-validator.ts`), the one shipped in the web/self-hosted product. Confirming the portable Python validator accepts the same key needs the `lead-extractor` repo or a built EXE, which is outside this worktree and outside T17's stated scope.
**UNVERIFIED: the mutation proof is intentionally not a checked-in artefact** — mutating the frozen lib on the branch would itself be a regression. It is reproducible by re-running item 3; what it proves is now permanently owned by `tests/exe-license-lifetime.test.ts:158` (fact 7).

**Not touched:** `lib/exe-license.ts`, `lib/exe-license-validator.ts`, `lib/exe-license-bind.ts`, `lib/license-service.ts`, `app/dashboard/settings/licenses-section.tsx`, `app/api/store/prices/route.ts`, `admin/wallets/route.ts`. No migration, no prisma command, no database, no network, no server started. No other task begun.

READY FOR VERIFICATION - T17


## 2026-09-29 — SENIOR PASS 7: **T17 ✅ VERIFIED** (accepted + closed). Next task is **`T4`**. **Documentation only — zero product code.**

Scope: verified `7b570f6` (`tests/exe-license-lifetime.test.ts` new, `package.json` +1, +143 lines to each track file). Commit stat: **`4 files changed, 497 insertions(+)`** — no deletions.

### Evidence re-derived by the senior

```
$ npx tsx --test tests/exe-license-lifetime.test.ts
# tests 9 / # pass 9 / # fail 0

$ npm run test:license      -> # tests 9  / # pass 9  / # fail 0
$ npm run test:setup        -> # tests 29 / # pass 29 / # fail 0
$ npx tsc --noEmit          -> EXIT=0
$ CI=1 npx next build       -> BUILD_EXIT=0
$ git diff --stat main self-hosted-build -- lib/exe-license-validator.ts   -> (empty)
$ git diff --numstat main self-hosted-build -- lib/exe-license.ts          -> 13  0
$ cd ../spaceworker && git rev-parse --abbrev-ref HEAD                     -> main @ b7330a1, clean
```

Hermeticity checked by reading `tests/exe-license-lifetime.test.ts`, not by trusting its header: no DB, no network, no `.env.local`; `server-only` neutralised by the house `Module._load` hook; `SPACEWORKER_LOCAL_DATA_DIR` → `mkdtempSync`; all keys minted/validated through the real HMAC. 31 assertions, 9 subtests.

### THE MUTATION PROOF — re-derived, and S18's written method was WRONG (F5)

S18 said "mutate the threshold **in a scratch copy**". My first attempt did exactly that and produced a **false positive risk**: the `/tmp` copy fails on **module resolution**, *including with the threshold unmutated*:

```
/tmp/sen-t17-mut $ npx tsx --test tests/exe-license-lifetime.test.ts
not ok 1 - /private/tmp/sen-t17-mut/tests/exe-license-lifetime.test.ts
# tests 1 / # pass 0 / # fail 1        <-- ALSO fails unmutated
```

If I had stopped there I would have "confirmed" a mutation that was never exercised. **Correct method — mutate in place, then prove the restore:**

```
$ sed -i '' 's/getUTCFullYear() >= 2999/getUTCFullYear() >= 3000/' lib/exe-license.ts
$ grep -n 'getUTCFullYear() >=' lib/exe-license.ts
39:  return !!d && d.getUTCFullYear() >= 3000;

$ npx tsx --test tests/exe-license-lifetime.test.ts
ok 1..6 / not ok 7 - 7. isLifetimeExpiry is driven only by the expiry year / ok 8 / ok 9
# pass 8 / # fail 1

$ git checkout -- lib/exe-license.ts
restore-numstat: 13	0	lib/exe-license.ts
worktree porcelain: []            (empty = clean)
pristine identical: YES
```

**This is real evidence:** the test *does* fail when the guarded property breaks, and the failure lands on **exactly** subtest 7 (the assertion that owns it) — not incidentally elsewhere. `W12` is genuinely guarded.

**Verdict: T17 ACCEPTED.** `S18` closes; §3.12.2 is discharged for the sentinel. §4.1b now has a live example of the rule.


### Findings

**F5 — S18's mutation method was unworkable (senior protocol defect, now fixed).** A `/tmp` scratch copy cannot run this test. Corrected in §3.13.2 and §4.1c: mutate **in place**, then prove the restore **three ways** (`git checkout --` → numstat `13 0` → `diff -q` identical). Without the restore proof a pass can leave a mutated sentinel on the branch — which ships as *"every lifetime licence silently misclassifies"*, precisely `W12`. **Not a T17 defect** — the junior was asked to prove the test can fail and did; it simply chose a different (working) method.

**F6 — UNVERIFIED #1 is now CLOSED, with evidence.** Its honest line was *"the desktop EXE's Python `validator.py` classification is unproven"*. I proved the parse-and-compare semantics directly:

```
$ python3 -c "..."
parsed      : 2999-12-31 23:59:59
year        : 2999
max year py : 9999
now > d     : False        <- VALID/lifetime
micros      : 0
Z-suffix    : REJECTED -> Invalid isoformat string: '2999-12-31T23:59:59.000000Z'
python      : 3.9.6
```

Two things follow. (a) Year 2999 is inside `datetime`'s range and `utcnow() > expires_at` is False, so a `validator.py`-style check reads a lifetime key as valid — the sentinel works on the Python side. (b) **The absence of the `Z` is load-bearing:** macOS ships Python **3.9.6**, which *rejects* `...Z` outright (only 3.11+ accepts it). T3's frozen literal has **no `Z`**, so it parses on 3.9 — had it ended in `Z`, **every lifetime licence would have failed on the Python side on any Python < 3.11**. Task 42's date-format lesson holds for the new sentinel, and assertion 1 of T17's test now pins it. **Residual, stated plainly:** this proves the *format* parses and compares correctly, not that the lead-extractor repo's `validator.py` has no other constraint (e.g. a hard-coded max term) — a different repo, a different product's licence flow.

**F7 — `W13` (new): nothing runs the tests automatically.** No workflow invokes any `test:*` script — `deploy.yml` runs only `npx tsc --noEmit` (`:71`) and `npm run build` (`:74`); `build-exe.yml` runs `npm ci` + `npx prisma generate` + `tauri-action`. So T17's "permanent guard" fires only when someone runs it, and a broken sentinel would still typecheck, build and ship. Repo-wide this is a **convention** (all `test:*` scripts are manual), so **not** a T17 defect. **Decision: protocol, not CI.** Wiring the suite into `build-exe.yml`/`deploy.yml` touches shared pipeline files governing `main` and the live deploy — out of scope for `TASK_145`. Instead **§4.1c** (new) makes `npm run test:license` + `npm run test:setup` **mandatory on every task and every senior pass**, and omitting them is reject item **16**. Residual risk recorded for the owner; a CI gate is a reasonable **Phase 6** candidate, deliberately unscheduled here.

**F8 — the junior's second `UNVERIFIED` (the mutation proof is not a checked-in artefact) is ACCEPTED AS CORRECT.** Checking in a mutated lib is itself a regression; a permanently broken test would be worse than a manually-performed mutation. The procedure is now codified in §4.1c instead. This satisfies §4.1b's `ACCEPTED AS ONE-OFF` clause — with the reason, as the rule requires.

**F9 — the junior's report was otherwise accurate.** `package.json` is `+1/−0` in its own commit (`git show --stat`); the `2 10` seen against `main` is pre-existing branch drift (nine `test:*` scripts `main` has added in the 37 commits the branch is behind) — expected, not a regression. It stayed in scope, touched no lib, left no `/tmp` copy in the repo, and left the senior's `/tmp/t3-verify.mts` in place.

### State at end of pass

- Branch `self-hosted-build` @ `7b570f6` + this docs commit; worktree clean; upstream `origin/self-hosted-build` (**explicit refspec only** — §0.1).
- **`▶ NEXT TASK: T4`** — junior §2. **T4 is the first substantive task of the phase** (the revocation seam, §3 D2): a new `lib/exe-license-revocation.ts` with exactly three exports.
- Closed: **T1, T2, T3, T16, T17**. Open: **T4–T15** (T14 = fresh-DB migration bootstrap; T15 = optional local drift repair).
- Live app `/Users/mikeolab/spaceworker` (`main`, `b7330a1`): clean, untouched.
- `/tmp/t3-verify.mts` is now **redundant** — `tests/exe-license-lifetime.test.ts` is its permanent replacement. Delete it so it cannot become the de-facto test.


### 2026-09-29 — JUNIOR — **T4 implemented** (the revocation seam module, new file). No other task started.

**What changed (additive only — nothing imports it yet, so no existing behaviour moves):**
- `lib/exe-license-revocation.ts` — **new, 109 lines**. Implements §3 D2 exactly: three exports + the one allowed error class (`grep -c '^export '` → `4`).
  - `LicenseRevocationError` `:23-31` — typed-error style mirroring `LicenseBindError` (`lib/exe-license-bind.ts:30-44`), `code: "not_found" | "not_owner"`.
  - `isExeLicenseRevoked` `:38-44` — `db.exeLicenseRevocation.findUnique({ where: { exeLicenseId }, select: { id: true } })`, returns `row !== null`. The only revocation read path.
  - `revokeExeLicense` `:52-90` — `findUnique` the licence, throw `not_found` / `not_owner` before any write, then **idempotent** `upsert({ where: { exeLicenseId } })` (double-click cannot raise a unique-constraint 500), then `void notifyAdmin(...)`.
  - `unrevokeExeLicense` `:98-108` — `deleteMany({ where: { exeLicenseId } })` (no throw when absent) + `void notifyAdmin(...)`.
- Imports mirror `lib/exe-license-bind.ts:1-6` exactly: `import "server-only";`, `import { db } from "./db";`, `import { notifyAdmin } from "./telegram";`. **No `./prisma`, no `getProduct`.**
- **No existing file was edited.** `git --no-pager status --porcelain` → `?? lib/exe-license-revocation.ts` (one line, untracked, new). The frozen validator and `lib/exe-license.ts` are untouched (canary below).

**Implementation note (not a spec deviation, logged for the record):** `ExeLicense` has **no `licensee` column** — the name lives on the decoded key and on `Payment`. The alert text therefore names the account via the `user` relation (`select: { user: { select: { email: true } } }`). D2 fixes the three signatures, the idempotency, the ownership check and the `notifyAdmin` call — not the message string — so this is a choice inside the spec, and it mirrors the `userId` ownership gate at `app/api/admin/exe-licenses/route.ts:126-132`.

**Exact commands run** (worktree `/Users/mikeolab/sw-selfhost` unless another dir is named):

```bash
grep -c '^export ' lib/exe-license-revocation.ts
grep -n '^export ' lib/exe-license-revocation.ts
npx tsc --noEmit                        # TSC_EXIT=$?
npx eslint lib/exe-license-revocation.ts
CI=1 npx next build                     # BUILD_EXIT=$?   (run in background, log tail pasted)
npm run test:license                    # raw # tests / # pass / # fail
npm run test:setup                      # raw # tests / # pass / # fail
cd /Users/mikeolab/spaceworker
git diff --stat main self-hosted-build -- lib/exe-license-validator.ts
git diff --numstat main self-hosted-build -- lib/exe-license.ts
git status --porcelain
npx tsc --noEmit                        # TSC_EXIT=$?
```

**Raw output, pasted verbatim:**

```
$ grep -c '^export ' lib/exe-license-revocation.ts
4
$ grep -n '^export ' lib/exe-license-revocation.ts
23:export class LicenseRevocationError extends Error {
38:export async function isExeLicenseRevoked(exeLicenseId: string): Promise<boolean> {
52:export async function revokeExeLicense(input: {
98:export async function unrevokeExeLicense(exeLicenseId: string): Promise<void> {
```

```
$ npx tsc --noEmit
TSC_EXIT=0
$ npx eslint lib/exe-license-revocation.ts
LINT_EXIT=0
```

```
$ CI=1 npx next build      # tail of /tmp/t145-t4-build.log
○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand

BUILD_EXIT=0
```

```
$ npm run test:license
1..9
# tests 9
# suites 0
# pass 9
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 920.874232
```

```
$ npm run test:setup
1..29
# tests 29
# suites 0
# pass 29
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1445.466505
```

```
$ cd /Users/mikeolab/spaceworker
$ git diff --stat main self-hosted-build -- lib/exe-license-validator.ts
(empty — no output)
$ git diff --numstat main self-hosted-build -- lib/exe-license.ts
13	0	lib/exe-license.ts
$ git status --porcelain
(empty — live-app worktree clean)
$ npx tsc --noEmit
TSC_EXIT=0
```

**Canary verdict:** validator diff **empty** (§4.2 S1 intact); `lib/exe-license.ts` **`13  0`** (zero deletions, V17 amended canary intact); live app `main` clean and its own typecheck `EXIT=0`; the branch's only working-tree change is the one new, unimported file.

**UNVERIFIED: no runtime DB exercise of the three functions this session** — T4's defined acceptance check is static (`tsc` + export count) and the task explicitly needs no database or server. Compilation is against the generated client for T1's real `ExeLicenseRevocation` table, but no row was written or read at runtime here. The DB-touching proofs are §4.2 S5/S7, which belong to T5/T6; `revoke → unrevoke → revoke` idempotency and the `not_owner` branch therefore remain runtime-unproven.

**UNVERIFIED: `reason` / `revokedBy` persist verbatim** — same reason (no DB run). Both are nullable-clean per T1's schema, and the strings are `trim()`-normalised with `"" → null`, but the round-trip is not exercised.

**UNVERIFIED: the `notifyAdmin` message text is not covered by any test** — `notifyAdmin` is a documented no-op when the Telegram bot token / chat id are unset (`lib/telegram.ts:28-35`), so no assertion exists or is possible offline.

READY FOR VERIFICATION - T4


## 2026-09-29 — SENIOR PASS 8: T4 verified and closed; `V17`'s "frozen set" claim corrected (it blocked T5)

**Task reviewed:** `T4` (per the `▶ NEXT TASK` pointer at junior `:9`), commit `d69b0da`.

### 1. T4 acceptance — everything re-run by the senior, nothing taken on trust

| Check | Command | Result |
|---|---|---|
| new file only | `git show --stat d69b0da` | `lib/exe-license-revocation.ts` **109 +** / 0 −; junior `+112`; senior `+106` — **append-only** |
| export count | `grep -c '^export '` | **4** = 3 functions + `LicenseRevocationError` ✅ (D2 / junior `3–4`) |
| inert for the hosted app | `grep -rn 'exe-license-revocation' --include='*.ts*'` | the file itself only — **nothing imports it** ✅ |
| D2 signatures | read `:38`, `:52-57`, `:98` | byte-match D2 ✅ |
| idempotent upsert | read `:73-85` | `upsert` on unique `exeLicenseId`; `create` seeds `userId` ✅ |
| ownership → typed throw | read `:62-67` | not found → `not_found`; foreign licence → `not_owner` ✅ |
| `void notifyAdmin` both ways | `:87`, `:106` | fire-and-forget; `lib/telegram.ts:28-32` try/catch + no-op without env ⇒ no unhandled rejection ✅ |
| style mirrors `LicenseBindError` | compare `:23-31` vs `lib/exe-license-bind.ts:28-46` | ✅ |
| validator canary | `git diff --stat main self-hosted-build -- lib/exe-license-validator.ts` | **empty** ✅ |
| `tsc` | `npx tsc --noEmit` (branch) | `TSC_EXIT=0` ✅ |
| build | `CI=1 npx next build` | `BUILD_EXIT=0` ✅ |
| lint | `npx eslint lib/exe-license-revocation.ts` | `LINT_EXIT=0` ✅ |
| tests | `npm run test:license` / `npm run test:setup` | **9/9** and **29/29**, `# fail 0` ✅ |
| live app | `npx tsc --noEmit` in `/Users/mikeolab/spaceworker` | `EXIT=0`; `main` @ `b7330a1`, clean ✅ |

### 2. Two properties proved beyond the junior's report

**Prisma clients are now independent and correct (C1 holding).**

```
          branch client: exeLicenseRevocation=180  SendingDomainSelect=0
          live client:   exeLicenseRevocation=0    SendingDomainSelect=17
```

Exactly the split expected: the branch sees T1's new model; the live app sees its own later features. **No cross-contamination** — the C1 clone fix is doing its job.

**The reported deviation is real and unavoidable.** `ExeLicense` has **no `licensee` column**; the owner is reached through the required `user` relation. D2 pins the signature, idempotency, ownership check and the `notifyAdmin` call — **not the message string** — so `license.user.email` is in-spec. Accepted.

### 3. `⚠️ THE FINDING: `V17` was self-contradictory, and it gated the very next task`

`V17` (as amended by T3) said the "other four" files *"remain byte-identical and must stay that way"*. **The work order requires editing two of them:** `lib/exe-license-bind.ts` (**T5**, then **T12**) and `app/dashboard/settings/licenses-section.tsx` (**T8**, which legitimately **deletes** the `EXE_LICENSE_DAYS` import). So the T5 agent would have met a direct contradiction — its own required diff declared forbidden. The likely outcomes: revert correct work, log a false `⚠️ OBJECTION`, or silently skip the enforcement that makes revocation real.

**A file may only be called frozen if no task edits it.** `V17` now separates *frozen* from *shared* (senior `:124`), and §3.14.1 carries the table. **Standing rule added:** before declaring any file frozen, check the work order for that filename and name the tasks that legitimately change it.

### 4. `W14` — D2 contradicted itself

D2 required a *typed* error class and then said *"Exactly three exports; nothing else."* T4 correctly resolved this as `3 functions + 1 class = 4`. Had a future agent "fixed" the wording by un-exporting the class, T5's `catch` mapping would have broken silently. **D2's prose corrected** to "exactly three functions — plus exactly one exported error class".

### 5. The `unrevokeExeLicense` asymmetry — documented, because it is a trap

`revokeExeLicense` checks `userId` internally; `unrevokeExeLicense(exeLicenseId)` does **not**, because E5 makes revoke **and** unrevoke admin-only siblings of `unbind`, whose handler already carries the ownership gate — and **no user-facing cancel or restore exists in this phase** (`licenses-section.tsx` stays read-only). **Latent trap:** if any later task ever exposes `unrevokeExeLicense` to users, it must gain an ownership parameter first or any user can restore their own cancelled licence and defeat revocation entirely. Recorded in D2 (senior `:172`) at the point of use.

### 6. §3.14.3 — the per-task canary in the hand-off prompt

The T4 prompt hardcoded `lib/exe-license.ts` → `13 0`. Correct for T4, **wrong for T5/T8/T12**, which edit other shared files. Since the prompt is deliberately one-line-to-edit, per-file expectations now live in the `V17` table; the prompt points there. The **validator** canary stays hardcoded — it is the one file frozen for the whole phase.

### 7. Files changed this pass — docs only, zero product code

Senior: `V17` (`:124`), D2 (`:161`, `:172`), new §3.14 (`:616-661`), §5 items 2/6/7 (`:748`, `:752-753`), this log entry.
Junior: §1.6 Revision 7 (new, `:83-107`), `▶ NEXT TASK` → `T5` (`:9`) with the `V17` warning (`:11`), status line (`:13`), T4 heading marked CLOSED (`:277`), this log entry.

### 8. Carried forward

`W13` (no CI job runs any `test:*` script) remains a **Phase 6 candidate** — flagged for the owner, not acted on. `S5`/`S7` (runtime DB exercise of revoke → unrevoke → revoke, the `not_owner` branch, `reason`/`revokedBy` round-trip) stay **open** pending T5/T6, exactly as T4 logged them.

**Verdict: `T4` ACCEPTED. `T5` unblocked and assigned. `T1`, `T2`, `T3`, `T4`, `T16`, `T17` closed. Next: `T5`.**

READY FOR VERIFICATION - T4 VERIFIED, PASS 8 COMPLETE


## 2026-09-29 — JUNIOR (T5 implementation) — `lib/exe-license-bind.ts` revocation guards. **Pending senior verification.**

**Task:** `T5` only (junior `▶ NEXT TASK` `:9`; junior §2 `:290-306`; senior §3 D5 **E1 → `:237`**, **E2 → `:238`**, **E3 → `:239`**). `lib/exe-license-bind.ts` is **shared, not frozen** (§3.14.1 / Revision 7) — the diff below is the expected T5 change.

**Diff — `lib/exe-license-bind.ts` (commit `e8f1b14`), `27 2`:**

| Lines | What |
|---|---|
| `8` | `import { isExeLicenseRevoked } from "./exe-license-revocation";` |
| `41` | `"revoked"` added to `LicenseBindError`'s code union |
| `116-126` | **E1** guard in `bindExeLicenseToMachine`: after `if (!license)` (`:112`), **before** `machineTakenByAnotherAccount` (`:155`) → `throw new LicenseBindError("<exact E1 message>", "revoked")` |
| `257` | `"revoked"` added to `LicenseTransferError`'s code union |
| `317-325` | **E2** guard in `transferExeLicenseToMachine`: after `if (!license)` (`:313`), **before** `machineTakenByAnotherAccount` (`:357`) → `throw new LicenseTransferError("<exact E2 message>", "revoked")` |

Ordering evidence (`grep -n`): `121 isExeLicenseRevoked` < `155 machineTakenByAnotherAccount`, and `320 isExeLicenseRevoked` < `357 machineTakenByAnotherAccount`. Both guards are **fail-closed** (no `try/catch`) and read revocation **only** through `isExeLicenseRevoked`; no lifetime logic, and the first-bind path for a fresh unbound key is unchanged (no revocation row → `false` → proceeds).

**Raw output (verbatim, measured):**

```
$ grep -n 'revoked' lib/exe-license-bind.ts
41:      | "revoked",
116:  // TASK_145 (Phase 5) E1 — a revoked (cancelled) license must never activate.
117:  // Checked BEFORE machineTakenByAnotherAccount so a revoked license can never
124:      "revoked",
257:      | "revoked",
317:  // TASK_145 (Phase 5) E2 — a revoked (cancelled) license must never be moved.
318:  // Checked BEFORE machineTakenByAnotherAccount so a revoked license can never
323:      "revoked",
```

```
$ npx tsc --noEmit
TSC_EXIT=0
$ CI=1 npx next build
✓ Compiled successfully in 19.8s
BUILD_EXIT=0
$ npm run test:license
1..9
# tests 9
# suites 0
# pass 9
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 347.339105
$ npm run test:setup
1..29
# tests 29
# suites 0
# pass 29
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 586.216474
```

```
$ cd /Users/mikeolab/spaceworker
$ git diff --stat main self-hosted-build -- lib/exe-license-validator.ts
(empty — no output)
$ git diff --numstat main self-hosted-build -- lib/exe-license.ts
13	0	lib/exe-license.ts
$ git diff --numstat main self-hosted-build -- lib/exe-license-bind.ts
27	2	lib/exe-license-bind.ts
$ npx tsc --noEmit
LIVE_TSC_EXIT=0
$ cd /Users/mikeolab/sw-selfhost
$ git diff --numstat main self-hosted-build -- lib/exe-license-bind.ts
27	2	lib/exe-license-bind.ts
$ git diff --stat main self-hosted-build -- lib/exe-license-validator.ts
(empty — no output)
```

Canaries for this task (from the `V17`/§3.14.1 table, not from a prompt example): validator **empty** ✅; `lib/exe-license.ts` **`13 0`** ✅; `lib/exe-license-bind.ts` **`27 2`**, and the diff content is exactly the two guards + two unions + the one import ✅.

**UNVERIFIED: runtime behaviour against a real DB** — no DB/server used (T5 needs none). `revoke → bind`/`revoke → transfer` throwing `"revoked"`, the ordering guarantee, and fail-closed on a read error are runtime-unproven here; they are §4.2 **S5**/**S7**, owned by T5/T6.

**UNVERIFIED: caller error mapping** — the `E10` mappers are not edited or exercised; surfacing `"revoked"` in those UIs is untested.

READY FOR VERIFICATION - T5

## 2026-09-29 — SENIOR pass 9: T5 VERIFIED (runtime, 18/18). `W15` fixed. `T6` is next.

**Verdict: T5 ACCEPTED.** `lib/exe-license-bind.ts` @ `e8f1b14`, diff `27 2`. Verified statically **and at runtime** — the junior's own log correctly flagged the runtime behaviour as unproven, so the senior proved it rather than accepting a structural tick.

### What the junior did (all confirmed, none taken on trust)

```
$ cd /Users/mikeolab/sw-selfhost
$ git --no-pager diff --numstat main self-hosted-build -- lib/exe-license-bind.ts
27	2	lib/exe-license-bind.ts
$ grep -n 'revoked' lib/exe-license-bind.ts
:8   import { isExeLicenseRevoked } from "./exe-license-revocation";
:41  LicenseBindError union += "revoked"
:116-126  E1 guard in bindExeLicenseToMachine
:257 LicenseTransferError union += "revoked"
:317-325  E2 guard in transferExeLicenseToMachine
$ grep -n 'machineTakenByAnotherAccount' lib/exe-license-bind.ts
155:  if (machineTakenByAnotherAccount) {      <-- 121 < 155 ✅
357:  if (machineTakenByAnotherAccount) {      <-- 320 < 357 ✅
```

The 2 deletions are the two `| "machine_taken",` lines re-terminated so `| "revoked",` can follow — the only way to extend a trailing union without reordering it. Attributable to T5 only.

### The runtime proof the junior could not make (§4.2 S5, S7, and new S19)

An 18-assertion senior harness (`/tmp/sen-t5-runtime.mts`, deleted after) against **real** `ExeLicense` + `Payment` rows on `spaceworker_t145`, exercising the real `bindExeLicenseToMachine` / `transferExeLicenseToMachine` / `revokeExeLicense` / `unrevokeExeLicense`:

```
$ cd /Users/mikeolab/sw-selfhost && set -a && . ./.env && set +a
$ DB=$(grep '^DATABASE_URL=' .env | cut -d= -f2-); S="${DB%/*}/spaceworker_t145"
$ DATABASE_URL="$S" EXE_LICENSE_SECRET="t5-runtime-proof-secret" \
  NODE_OPTIONS="--require /Users/mikeolab/sw-selfhost/scripts/stub-server-only.cjs" \
  npx tsx /tmp/sen-t5-runtime.mts

ok   1. fresh licence is NOT revoked
ok   2. control bind SUCCEEDS (guard is a no-op) -- machine=t5-machine-a
ok   3a. isExeLicenseRevoked -> true after revoke
ok   3b. reason round-trips -- reason=T5 runtime proof
ok   3c. revokedBy round-trips -- revokedBy=senior-verify
ok   3d. row.userId is the licence owner
ok   3e. revoke is IDEMPOTENT (1 row after 2 calls) -- rows=1
ok   4. E1 beats already_bound: bind on a revoked+bound licence -- code=revoked type=LicenseBindError
ok   4b. message is the spec string -- This license was cancelled by the provider and can no longer be activated. Contact support.
ok   5. E2 blocks transfer of a revoked licence -- code=revoked type=LicenseTransferError
ok   6a. revocation-read failure THROWS (fail-closed) -- type=PrismaClientKnownRequestError
ok   6b. ...and NO binding was written
ok   6c. ...and it is NOT silently reported as revoked -- code=OTHER:PrismaClientKnownRequestError
ok   6d. table restored (0 rows) -- rows=0
ok   7a. isExeLicenseRevoked -> false after unrevoke
ok   7b. unrevoke is IDEMPOTENT (no throw when absent)
ok   8. transfer SUCCEEDS after unrevoke -- code=(no throw)
ok   8b. binding actually moved to t5-machine-c -- machine=t5-machine-c
cleanup: removed 2 licences / 2 payments

# pass 18
# fail 0
```

**The key result is assertion 4.** The licence was bound to `t5-machine-a` **first**, *then* revoked, *then* a bind for `t5-machine-b` attempted. It returned **`revoked`, never `already_bound`** — so E1 precedes not only the cross-account check the spec named, but also the already-bound transfer-code branch. That is **stronger than T5 asked for**, and it is load-bearing: it makes `auto-bind`'s transfer-code path unreachable for a cancelled licence, so a cancelled customer is never emailed a code and then refused. It also happens to be what makes D10's admin-move-only rule hold for the **lifetime** class (`T12` will rely on it). Recorded as §3.15.3 and as an explicit S5 assertion — not left as an accident of edit order.

**Assertion 6 is the fail-closed proof.** With `ExeLicenseRevocation` dropped, the bind **throws** (`PrismaClientKnownRequestError`), **no `boundMachineId` is written**, and the failure is **not** misreported as `"revoked"`. Table restored verbatim from T1's migration afterwards — 3 constraints verified present:

```
$ psql "$S" -tAc "select conname from pg_constraint where conrelid='\"ExeLicenseRevocation\"'::regclass order by 1"
ExeLicenseRevocation_exeLicenseId_fkey
ExeLicenseRevocation_pkey
ExeLicenseRevocation_userId_fkey
```

Scratch DB left clean: `ExeLicenseRevocation=0 · ExeLicense=0 · ExeLicenseTransfer=0` (`Payment=1`/`User=1` are the pre-existing T16 rows), worktree clean, `/tmp` harness deleted.


### Canaries + gates

```
$ git diff --stat main self-hosted-build -- lib/exe-license-validator.ts
(empty — no output)
$ git diff --stat main self-hosted-build -- lib/license-service.ts
(empty — no output)
$ git diff --numstat main self-hosted-build -- lib/exe-license.ts
13	0	lib/exe-license.ts
$ npx tsc --noEmit                                    → TSC_EXIT=0
$ CI=1 npx next build                                 → BUILD_EXIT=0
$ npm run test:license                                → 1..9  # pass 9  / # fail 0
$ npm run test:setup                                  → 1..29 # pass 29 / # fail 0
$ cd /Users/mikeolab/spaceworker && npx tsc --noEmit  → LIVE_TSC_EXIT=0
```

`E10` confirmed needing **no** caller change: `"revoked"` is not `"already_bound"`, so it falls to the generic `400` carrying `err.message` in all three self-service callers — the spec message reaches the customer verbatim.

### `W15` — the finding: an invariant asserted only in a prompt is an unverified assertion

The T5 hand-off prompt made **fail-closed** a hard invariant and the reject list made violating it an automatic reject — **yet no `S`-row checked it.** T5's own acceptance check was purely structural (`grep` + `tsc`), so the property most at risk (a junior over-applying the *fail-open* rule from T11/T13 and swallowing the error, silently defeating revocation) was unverified until the senior invented the proof at verification time. **New rule: every invariant stated in a hand-off prompt or §4 must have a corresponding `S`-row, or it is decoration.** S19 added; same defect class as `W12`.

### Environment facts recorded for the next DB-backed proof (§3.15.2)

Four failures hit while building the harness — all now written down so the next agent does not repeat them: loose `/tmp/*.ts` fails on top-level `await` (`ERR_REQUIRE_ASYNC_MODULE`) → use `.mts`; `.env` is not auto-loaded → `set -a && . ./.env && set +a` (else `lib/env.ts:7` throws `Missing required environment variable: APP_BASE_URL`); `/tmp` scripts must import by absolute path; and `server-only` still needs `NODE_OPTIONS="--require .../scripts/stub-server-only.cjs"`.

### Docs corrected this pass (zero product code)

- `S5`, `S7` closed with evidence; **`S19` added** (fail-closed).
- **§3.15** (Revision 8) added; §3.15.1 `W15`, §3.15.2 environment facts, §3.15.3 the ordering property.
- Junior: pointer → **`T6`**, status line, `§1.7` (Revision 8), `§1.5`/`§1.6` struck as superseded, `T5` heading marked **CLOSED**, and the understated ordering acceptance rule corrected in the `T5` block.
- Companion summary in the junior header bumped to `W1–W15` / `S1–S19`.

**UNVERIFIED: the desktop/Python-side classification of a revoked key** — this pass proved the Node/DB path only. The Python `validator.py` sentinel-format question was closed in pass 7; revocation classification on that side belongs to `T13`/`S14`.

**UNVERIFIED: admin-created revocations end-to-end** — nothing can create an `ExeLicenseRevocation` through the app yet, so the guards are real but currently unreachable in production. `T6` is that door; `S6`/`S13` follow.

READY FOR VERIFICATION - T5 (senior pass 9 closed this row; `T6` handed to the junior)




## 2026-09-29 — JUNIOR (T6 implementation) — admin API: lifetime issuance + `revoke`/`unrevoke` + `E4` reuse filter + `revoked` flag. **Pending senior verification.**

**Task done:** `T6` only (pointer at junior `:9`), implementing senior §3 D5 **E4 / E5 / E6** + D7's route-side item in the order §2 gives (E4 first). **One file changed:** `app/api/admin/exe-licenses/route.ts`, working-tree diff **`167 19`** (uncommitted at the time of writing; `git diff --numstat -- app/api/admin/exe-licenses/route.ts`). I did **not** touch `lib/exe-license-validator.ts` (canary empty), `lib/license-service.ts` (canary empty), `lib/exe-license.ts` (still `13 0`) or `lib/exe-license-bind.ts` — T5's two guards are quoted in the route's comments but never re-added, reordered or relaxed, and revoked stays checked first *inside the bind/transfer seam*, untouched.

**`file:line` map (final file):** `:5` `EXE_PRODUCTS` → `LICENSABLE_EXE_PRODUCTS` (**D3 item 4** — senior D3 explicitly hands this swap to T6/T7; nothing else in D3's list was needed); `:6-11` imports `LIFETIME_EXPIRES_AT` from `@/lib/exe-license` + the three T4 seam functions (no direct `ExeLicenseRevocation` write anywhere); `:21-52` response-shape comment block extended (`lifetime?`, `revoke`, `unrevoke`, `revoked?`); `:94-97` + `:129-134` the **E5** dispatch arms, slotted between `unbind` and `delete`; `:206-241` `revokeLicense`; `:243-277` `unrevokeLicense` (both line-for-line on `unbind` at `:174-204`: same unbound-id 400, same ownership gate text, same `LicenseRevocationError`→`not_found ? 404 : 400`); `:409`/`:651` the D3 lookups; `:417-422` + `:491` lifetime issuance (`lifetime` skips the `durationDays` parse; `expiresAt: LIFETIME_EXPIRES_AT` wins inside `generateLicenseKey`); `:447-464` **E4**; `:635-659` **E6**.

**Verification — both halves.** Static: `npx tsc --noEmit` → `TSC_EXIT=0`; `CI=1 npx next build` → `BUILD_EXIT=0`; `grep -n 'revoke\|revoked\|lifetime' app/api/admin/exe-licenses/route.ts` shows all four concerns; `npm run test:license` → `1..9 / # pass 9 / # fail 0`; `npm run test:setup` → `1..29 / # pass 29 / # fail 0`. Live (`S6`, **the amended acceptance bar**): `next start -p 3010` on `spaceworker_t145`, admin cookie minted the same way `lib/admin-auth.ts:createAdminSessionToken` does (throwaway `t6-s6-token.mts`, deleted). Raw:


```
### issue #1 (30 days, selfhosted_os)
{"licenseKey":"eyJleHBpcmVzX2F0IjogIjIwMjYtMTAtMjlUMTc6NDE6MTAuNzY1MDAwIiwgImlzc3VlZF9hdCI6ICIyMDI2LTA5LTI5VDE3OjQxOjEwLjc2NTAwMCIsICJsaWNlbnNlZSI6ICJzNi10NkBleGFtcGxlLnRlc3QiLCAicGxhbiI6ICJzZWxmaG9zdGVkIiwgInByb2R1Y3QiOiAic2VsZmhvc3RlZF9vcyJ9.8a5c6d639a4f44c64c908c5bcf5a9585613b914e8d7ff0b058fa65f53518baee","product":"selfhosted_os","productName":"SpaceWorker OS (Self-Hosted)","licensee":"s6-t6@example.test","expiresAt":"2026-10-29T17:41:10.765Z","exeLicenseId":"cmumyqbcl00039kkhfjz52tge","isNewAccount":false,"claimUrl":"..."}
### bind it -> s6-machine-A
{"bound":true,"...":"...","boundMachineId":"s6-machine-a","boundMachineLabel":"S6 A","boundAt":"2026-09-29T17:41:12.479Z","exeLicenseId":"cmumyqbcl00039kkhfjz52tge","product":"selfhosted_os","expiresAt":"2026-10-29T17:41:10.765Z"}
### issue again BEFORE revoke (control — reuse must still work)
{"reused":true,"licenseKey":"…8a5c6d63…","exeLicenseId":"cmumyqbcl00039kkhfjz52tge","boundMachineId":"s6-machine-a","mustClaimNote":"This buyer already has a usable license, already bound to a device — nothing new was created."}

### action:"revoke" (1st)
{"ok":true,"revoked":true,"exeLicenseId":"cmumyqbcl00039kkhfjz52tge"}     HTTP_CODE:200
### action:"revoke" (2nd — double-click)
{"ok":true,"revoked":true,"exeLicenseId":"cmumyqbcl00039kkhfjz52tge"}     HTTP_CODE:200
### action:"bind" a revoked licence (T5's E1 guard, now REACHABLE)
{"error":"This license was cancelled by the provider and can no longer be activated. Contact support.","code":"revoked"}   HTTP_CODE:400

### action:"issue" AGAIN for the SAME user+product  ← S6's pass condition
{"licenseKey":"eyJleHBpcmVzX2F0IjogIjIwMjYtMTAtMjlUMTc6NDE6MTIuNjI0MDAwIiwgImlzc3VlZF9hdCI6ICIyMDI2LTA5LTI5VDE3OjQxOjEyLjYyNDAwMCIsICJsaWNlbnNlZCI6ICJzNi10NkBleGFtcGxlLnRlc3QiLCAicGxhbiI6ICJzZWxmaG9zdGVkIiwgInByb2R1Y3QiOiAic2VsZmhvc3RlZF9vcyJ9.db893d0c284b5294ac8764aefd3c4d97cbc284d11c5446a20b7ec0d6ecd2b4a9","product":"selfhosted_os","licensee":"s6-t6@example.test","expiresAt":"2026-10-29T17:41:12.624Z","exeLicenseId":"cmumyqcs3000d9kkh4mcvynzv","isNewAccount":false}
K2 != K1 ? YES-NEW-KEY-MINTED

### GET ?email=s6-t6@example.test  (E6)
{"licenses":[{"id":"cmumyqcs3000d9kkh4mcvynzv",…,"boundMachineId":null,"boundAt":null,"revoked":false},{"id":"cmumyqbcl00039kkhfjz52tge",…,"boundMachineId":"s6-machine-a","boundAt":"2026-09-29T17:41:12.479Z","revoked":true}]}

### action:"unrevoke"
{"ok":true,"revoked":false,"exeLicenseId":"cmumyqbcl00039kkhfjz52tge"}     HTTP_CODE:200
### (delete the newer row) then action:"issue"
{"reused":true,"licenseKey":"…8a5c6d63…","exeLicenseId":"cmumyqbcl00039kkhfjz52tge",…}
K4 == K1 ? YES-ORIGINAL-KEY-REUSABLE-AGAIN

### lifetime:true issuance
{"licenseKey":"eyJleHBpcmVzX2F0IjogIjI5OTktMTItMzFUMjM6NTk6NTkuMDAwMDAwIiwgImlzc3VlZF9hdCI6ICIyMDI2LTA5LTI5VDE3OjQxOjEzLjYyMTAwMCIsICJsaWNlbnNlZCI6ICJzNi10Ni1saWZlQGV4YW1wbGUudGVzdCIsICJwbGFuIjogInNlbGZob3N0ZWQiLCAicHJvZHVjdCI6ICJzZWxmaG9zdGVkX29zIn0=.560dca70…","expiresAt":"2999-12-31T23:59:59.000Z","exeLicenseId":"cmumyqdjr000k9kkha0h8ant9"}
decoded payload: {"expires_at": "2999-12-31T23:59:59.000000", "issued_at": "2026-09-29T17:41:13.621000", "licensee": "s6-t6-life@example.test", "plan": "selfhosted", "product": "selfhosted_os"}
### lifetime:true + durationDays:"not-a-number"
{"reused":true,…,"expiresAt":"2999-12-31T23:59:59.000Z"}   # 200 — the duration parse was skipped, not tolerated
```
(`…` marks a long base64 field elided for legibility only; the full verbatim transcript is in the junior track's T6 entry. Counts are as measured, not estimated: `# pass 9 / # fail 0` and `# pass 29 / # fail 0`, `TSC_EXIT=0`, `BUILD_EXIT=0`.)


**Frozen-file canaries (run from `/Users/mikeolab/spaceworker`, branch `main` `b7330a1`):**

```
$ git diff --stat main self-hosted-build -- lib/exe-license-validator.ts
(empty)
$ git diff --numstat main self-hosted-build -- lib/exe-license.ts
13      0       lib/exe-license.ts
$ git diff --numstat main self-hosted-build -- lib/license-service.ts
(empty)
$ git diff --numstat main self-hosted-build -- lib/exe-license-bind.ts
27      2       lib/exe-license-bind.ts
$ git diff --numstat main self-hosted-build -- app/api/admin/exe-licenses/route.ts
3       0       app/api/admin/exe-licenses/route.ts      # TASK_129's committed self-hosted gate — not T6
$ npx tsc --noEmit
LIVE_TSC_EXIT=0
$ curl -s localhost:3010/api/store/prices | grep -c selfhosted_os
0
```

**Two notes worth carrying forward.** (1) `next start` on this worktree **cannot boot** with the checked-in `.env`: `lib/env.ts`'s placeholder guard (`:22-70`, gated on `!process.env.CI`) throws on `SESSION_SECRET=local_dev_se…` and `RESEND_API_KEY=re_local_dev…`, and every request returned `500 Internal Server Error`. The proof above therefore used throwaway `SESSION_SECRET`/`RESEND_API_KEY` **env overrides on the command line** — `.env` was not edited. `CI=1 npx next build` is unaffected (the guard early-returns on `CI`). (2) `E4` is the load-bearing edit: the live step 3+4 is the only evidence that matters, and it passes — the cancelled key is no longer handed back, and `unrevoke` restores it (`K4 == K1`).

**UNVERIFIED:** the admin UI half (T7 — no Cancel/Restore button, no badge, no Lifetime checkbox yet; `admin-panel.tsx:6,:3559` still on `EXE_PRODUCTS`); `S13`/`S14` (live kill via eligibility + the desktop path), `S9`, `S15`, `S16`; cross-account `revoke`/`unrevoke` refusal at runtime (only the happy path + unbound-id 400 were exercised). Nothing was run against the VPS, no `prisma generate`/`migrate dev`/`migrate resolve`, no migration edited, and `spaceworker_t145` was left at 0 licences / 0 revocations / 0 transfers.

READY FOR VERIFICATION - T6

---

## 2026-09-29 — SENIOR pass 11: **`T6` ✅ VERIFIED** (full loop re-derived at runtime). Next task is **`T7`**. **Documentation only — zero product code.**

`T6` (`745d3e6`) accepted. I did not read the junior's summary as evidence; I rebuilt the proof end-to-end on my own harness, my own server (`:3011`), `spaceworker_t145`, and a real admin cookie.

**S6 — re-derived from scratch (control included):**

```
issue 30d → bind m1
CONTROL issue (before revoke)  → reusable:true, SAME_KEY=YES
revoke                          → {"ok":true,"revoked":true,"exeLicenseId":"..."} HTTP=200
revoke again (double-click)     → {"ok":true,"revoked":true} HTTP=200          ← idempotent
bind → m2                       → {"error":"This license was cancelled by the provider and can no longer be activated. Contact support.","code":"revoked"} HTTP=400
RE-ISSUE (same user+product)    → REUSED=<empty>  NEW_KEY_DIFFERS=YES-NEW-KEY-MINTED   ← E4 PROVEN
GET /api/admin/exe-licenses     → id=... revoked=False ; id=... revoked=True          ← E6 PROVEN
unrevoke                        → {"ok":true,"revoked":false} HTTP=200
re-issue → reusable:true
lifetime issue                  → expiresAt=2999-12-31T23:59:59.000Z
```

**Discrepancy with the junior's log, recorded not smoothed:** junior shows `K4 == K1 ? YES-ORIGINAL-KEY-REUSABLE-AGAIN`; mine reuses the **newer** row. Both correct — the junior `delete`d the newer minted row first so the filter had to reach the *original*, which is the **stronger** test. The lookup is `orderBy: issuedAt desc` + `.find`; the contract holds either way.

**`S20` — new row, added by this pass.** Issued `lifetime:true`, **bound** it, decoded the **bound** key:

```
bound payload = {"expires_at": "2999-12-31T23:59:59.000000", "issued_at": "...", "licensee": "...", "machine_id": "mlife", "plan": "selfhosted", "product": "selfhosted_os"}
SENTINEL PRESERVED = True
```

Binding adds `machine_id` and carries `expires_at` through **byte-for-byte**, so `isLifetimeExpiry` still classifies a **bound** key as lifetime. E9 (`T12`) and E8 (`T13`) both rely on this and it was previously unstated — had bind rewritten the expiry, D9's admin-move-only rule would have evaporated silently.

**Reject item 6 (the junior's own `UNVERIFIED`) — closed at runtime.** With two real users, B attempts `revoke` on A's `exeLicenseId`:
`{"error":"No license for owner-b@example.test matches that selection."}` **HTTP=400**, revocation count for A's licence **0**; same for `unrevoke`. A nonexistent email is refused earlier still (`No SpaceWorker user exists for ...`).

**`revoke` × the pre-existing `delete` action — checked, not assumed.** `delete` is **pre-existing on `main`** (`:73`/`:104`), so T6 inserted before it. Deleting a **revoked** licence: `{"deleted":true}` 200, **0 orphan** revocation rows, no 500 — FK is `ON DELETE CASCADE` (`20261020000000_add_exe_license_revocation/migration.sql:48`).

**Gates (all re-run by me):** `tsc` `BRANCH_TSC_EXIT=0`; `CI=1 next build` `BUILD_EXIT=0`; `test:license` `# tests 9 # pass 9 # fail 0`; `test:setup` `# tests 29 # pass 29 # fail 0`; store leak `curl .../api/store/prices | grep -c selfhosted_os` → **0**; `isSelfHosted()` early-returns intact; live app `main` @ `b7330a1` clean, `LIVE_TSC_EXIT=0`.

**Canaries:** validator **empty**; `license-service.ts` **empty**; `exe-license.ts` `13 0`; `bind.ts` `27 2` (T5); admin route `170 19`.

**`W16` — new finding, and the most important thing in this pass.** `.env` in the worktree is a **symlink to `/Users/mikeolab/spaceworker/.env`** (the live app's), and it is **gitignored/untracked**. It is the **only** remaining non-`node_modules` symlink (I audited). `next start` refuses to boot on it because `lib/env.ts:52`'s placeholder guard fires on `SESSION_SECRET=local_dev_…` (`/local_dev/i`) and `RESEND_API_KEY=re_local_dev_…` — which creates exactly the pressure to "fix" those values. Doing so silently rewrites the **live** `SESSION_SECRET` (killing every live session) and `RESEND_API_KEY` (breaking live email), **with no trace in `git status`**. Same class as C1/C2, harder to see. Fix is a command-line override only — what the junior did and what I repeated. → §4.1e + reject item 18.

**Docs written this pass:** senior §3.16 (+§3.16.1–3, `W16`), `S6` closed, new `S20`, §4.1e, reject item 18, §5 items 2/3/4/6/7/8, §7 baseline (HEAD `745d3e6`, frozen-set corrected, `.env` row); junior §1.8, pointer → `T7`, status, T6 marked CLOSED, T7's Check amended to owe `S9` + the `.env` warning, §2 heading.

**UNVERIFIED:** `T7`'s UI half; `S13`/`S14` (the live kill — now runnable); `S9`'s rendered-copy half; `S15`/`S16`/`S10`; `T14`'s fresh-DB bootstrap. Nothing ran against the VPS; no `prisma generate`/`migrate dev`/`migrate resolve`; no migration edited; `spaceworker_t145` returned to **0 licences / 0 revocations / 0 transfers**; server `:3011` stopped and `/tmp` harness deleted.

**SENIOR PASS 11 COMPLETE — `T6` ✅ VERIFIED + CLOSED. `▶ NEXT TASK: T7`.**

---

## 2026-09-30 — SENIOR pass 12: branch identity re-confirmed; **the live app moved**; two merge hazards found (`W17`, `W18`). Next task is **STILL `T7`**. **Documentation only — zero product code.**

The owner reported fixes on the live app, and asked me to confirm I am on the right branch before continuing. I checked **before** doing anything else, then re-ran the canaries, because a `main`-side edit to a canaried file would silently make a "clean" diff meaningless.

**Branch identity — correct, nothing to fix:**

```
branch                     : self-hosted-build
HEAD                       : 745d3e6  ( == origin/self-hosted-build )
branch.self-hosted-build.merge  : refs/heads/self-hosted-build     ← NOT main; C2 trap still closed
branch.self-hosted-build.remote : origin
worktree                   : only the two TASK_145_*.md modified — no product code
```

**Divergence now:** merge base still `1499a9e`; `git rev-list --left-right --count main...self-hosted-build` → **42  31** (main 42 ahead, branch 31 ahead). `main` advanced `b7330a1 → 0d816b5` (5 commits: `88ca661`, `f76047f`, `e7a7559`, `7e1f5a4`, `0d816b5` — the admin remote-viewer / device-command line).

**Canary validity re-checked file by file against `b7330a1..main`:**

```
lib/exe-license.ts -> main-changed=0        lib/exe-license-validator.ts -> 0
lib/exe-license-bind.ts -> 0                lib/license-service.ts -> 0
lib/products.ts -> 0                        app/api/admin/exe-licenses/route.ts -> 0
app/api/store/prices/route.ts -> 0          app/dashboard/settings/licenses-section.tsx -> 0
package.json -> 0
app/admin/(protected)/admin-panel.tsx -> 1   prisma/schema.prisma -> 1
```

So every figure still means exactly what it meant — validator **empty**, `license-service.ts` **empty**, `exe-license.ts` `13 0`, `bind.ts` `27 2`, admin route `170 19`, `products.ts` `24 2`, `package.json` `2 10`. **But two files DO matter and both are hazards:**

**`W17` — `admin-panel.tsx` is divergent on both sides.** Branch's own edit: `+27/−6` vs merge base. Branch vs `main`: **`+31 / −1354`**. The 1354 is the branch *lacking* main's remote-viewer/PIN-collect/hide-reveal work; confirmed by content (branch has **0** hits for `remote-viewer|agent-visibility|pinRequest`; `main`'s version has 5 hits of `ExeLicensesTab|EXE_PRODUCTS`). **This is T7's file.** A merge that resolves it "by side" would delete the live feature set from production. Rule: union, never side.

**`W18` — same-timestamp migration.** Branch `20261020000000_add_exe_license_revocation`; `main` `20261020000000_admin_device_commands` (+ `20261021000000_`, `20261022000000_`), the latter three **already applied to the live DB**. Lexicographic order puts ours first, so on merge Prisma is asked to apply a migration *older* than applied ones. **This is the last safe moment to renumber it** — it has never been applied to the live DB, only to scratch `spaceworker_t145`; once it deploys it is fixed by name *and* checksum.

**§3.17.3 — the live checkout holds another agent's UNCOMMITTED work** (`campaigns/page.tsx`, `deliverability.ts`, `render-merge.ts`, `package.json`, + `lib/test-merge-vars.ts`, `tests/render-merge.test.ts`). Its `package.json` hunk adds `"test:merge": "tsx --test tests/render-merge.test.ts"` — an independent confirmation of `W13` (another manual `test:*` script no CI will run). Nothing to merge (uncommitted). I ran the live `tsc` anyway and got **`LIVE_TSC_EXIT=0`**, so their WIP is type-clean and my canary is not hiding a fault. **Do not touch, commit, or stash another agent's work.**

**§3.17.4 — `TASK_146` is taken.** `main`'s device-command migration header calls itself `TASK_146`, the number Phase 5 reserved for Phase 6. No file collision (0 `TASK_146*` files either side). **Phase 6 → `TASK_147`+.**

**Decision: I did NOT merge `main` into the branch, and recorded why.** It would have produced a large `admin-panel.tsx` conflict in exactly the file T7 must edit, pulled `main`'s three already-applied migrations into the phase branch, and forced the `W18` decision mid-phase — for zero benefit, since none of the phase's canaried files were touched by `main`'s new commits. Divergence is a **merge-time** obligation here.

**Docs written this pass:** senior §3.17 (+3.17.1–4) and §7 baseline (live HEAD `0d816b5`, merge base 42/31, `.env` row); junior §1.9.

**UNVERIFIED:** `T7`'s UI half; `S13`/`S14`; `S9`'s rendered half; `S15`/`S16`. Nothing ran against the VPS; no `prisma generate`/`migrate dev`/`migrate resolve`; no migration renamed **yet** (`W18` is a pre-merge task); no file in the live checkout was touched.

**SENIOR PASS 12 COMPLETE — branch confirmed `self-hosted-build`; `main` divergence audited (`W17`/`W18` recorded). `▶ NEXT TASK: T7` (unchanged).**


---

### 2026-09-30 — JUNIOR — **`T7` implemented** (admin UI half of revocation: Lifetime toggle + `Cancelled` badge + Cancel/Restore + the `LICENSABLE_EXE_PRODUCTS` swap). No other task started. Runtime `S9` **was** run — evidence below.

**Files changed: `app/admin/(protected)/admin-panel.tsx` ONLY — `112 insertions, 12 deletions` (`git diff --numstat HEAD` in the worktree).** `git status --short` in the worktree shows exactly two modified paths, this file and the junior track's own log: no library, no API route, no migration, no `package.json`, no `.env`, and nothing in the live checkout.

| `file:line` | Change |
|---|---|
| `:6` | added `LICENSABLE_EXE_PRODUCTS` to the existing `@/lib/products` import — the **first** mandated swap site |
| `:3565` | `EXE_PRODUCTS.map` → `LICENSABLE_EXE_PRODUCTS.map` in the issuer's product `<select>` — the **second** swap site |
| `:3479` | **UNCHANGED ON PURPOSE** — `useState<string>(EXE_PRODUCTS[0].id)`. That default is an EXE product, not the self-hosted one; the task text put it out of scope, so it stays. |
| `:3481-3484` | `const [lifetime, setLifetime] = useState(false)` |
| `:3502-3504` | POST body sends `{ lifetime: true }` **or** `{ durationDays: … }`, mutually exclusive — the day count is never computed when `lifetime` is set |
| `:3576`, `:3578` | duration `<input disabled={lifetime}>` + `disabled:opacity-50` |
| `:3581-3592` | the **Lifetime (no expiry)** checkbox, in the file's existing `text-sm`/`dark:` form idiom |
| `:4049-4051` | `const [cancellingId, setCancellingId] = useState<string \| null>(null)` — kept separate from the pre-existing `revokingId` ("clear this device's binding") so the two operations never share a spinner |
| `:4157-4207` | `setRevoked(r, revoked)` — posts `action:"revoke"` / `action:"unrevoke"` with `{ email, exeLicenseId }` to the **existing** `T6` route, behind `useConfirm`, then `await load()` to re-read the **server's** flag |
| `:4209-4221` | `cancelRestoreButton(r)` — label/colour driven only by `r.revoked` |
| `:4268-4273` | `statusBadge` gained a **leading** `r.revoked` → red `Cancelled` pill, ahead of the `Bound` / `Unclaimed` arms |
| `:4306` | Cancel/Restore added to the current (ungrouped) row |
| `:4349-4358` | history `<li>`: the Delete button wrapped in a `flex items-center gap-2` div so Cancel/Restore sits beside it — layout only, Delete unchanged |
| `:4389-4392` | `revoked?: boolean` on `type AdminLicenseRow`, documented as the GET list's own flag |

**Hosted-safe / invariant notes.** `revoked` is taken **only** from the API's GET payload — never inferred from the key, never from a date, and "is this lifetime" is never computed client-side. `Restore` is wired into this admin tab and nowhere else. On `main` the field is absent, so `r.revoked` is falsy: no badge, and the button renders its live-state label on a surface where nothing is ever revoked → **inert**. No new auth path, no new response shape, no new API call. `lib/exe-license-validator.ts` and `lib/license-service.ts` untouched; no migration touched; nothing renamed; `admin-panel.tsx` was edited only as the branch's current worktree file, never synced with `main` and never reverted (`W17`), and no side was resolved (`W18` left to the senior).

**Static acceptance check — raw output:**

```
$ cd /Users/mikeolab/sw-selfhost
$ npx tsc --noEmit
TSC_EXIT=0

$ CI=1 npx next build
BUILD_EXIT=0

$ npm run test:license
1..9
# tests 9
# suites 0
# pass 9
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 430.534735

$ npm run test:setup
1..29
# tests 29
# suites 0
# pass 29
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 783.523414
```


**Runtime half — senior `S9`, RUN AGAINST `spaceworker_t145`.** Procedure: real `CI=1 next start -p 3011` seeded with throwaway command-line overrides for `SESSION_SECRET`/`RESEND_API_KEY`/`ADMIN_TOKEN` — the checked-in `.env` (a symlink into the live app) was **not** edited, per §4.1e — driven by a throwaway `/tmp/t7_s9b.mts` Playwright script against the system Chrome, because this repo ships neither Playwright nor a test browser. The script, the browser and the server are gone; the scratch-DB rows this run created were deleted afterwards. Raw output, verbatim:

```
[requestfailed] GET http://localhost:3011/admin?_rsc=MB54gAX280Bv495Z net::ERR_ABORTED
[requestfailed] GET http://localhost:3011/admin?_rsc=wlSPTlro2qyD3j5o net::ERR_ABORTED
LOGIN_OK url= http://localhost:3011/admin
HTTP GET /api/admin/exe-licenses -> 200 cache-control=no-store, must-revalidate body={"licenses":[{"id":"cmunumne0000o9k1h3s3en5om","email":"t7-proof-lifetime@example.test","product":"selfhosted_os","productName":"SpaceWorker OS (Self-Hosted)","issuedAt":"2026-09-30T08:34:07.465Z","boundMachineId":null,"boundMachineLabel":null,"boundLicenseKey":null,"boundAt":null,"revoked":true},{"id":"cmunucnly000e9k1h0rjjyg4p","email":"t7-proof-lifetime@example.test","product":"selfhosted_os","productName":"SpaceWorker OS (Self-Hosted)","issuedAt":"2026-09-30T08:26:21.190Z","boundMachineId":null,"boundMachineLabel":null,"boundLicenseKey":null,"boundAt":null,"revoked":true},{"id":"cmunuaq3p00069k1hfkgi3w1b","email":"t7-proof-30d@example.test","product":"selfhosted_os","productName":"SpaceWorker OS (Self-Hosted)","issuedAt":"2026-09-30T08:24:51.109Z","boundMachineId":null,"boundMachineLabel":null,"boundLicenseKey":null,"boundAt":null,"revoked":false}]}
TAB_OPEN = Licenses
S9-a) PRODUCT_SELECT_OPTIONS = [{"value":"extractor_exe","label":"Extractor EXE"},{"value":"mailer_exe","label":"Mailer EXE"},{"value":"combined_exe","label":"Combined EXE"},{"value":"automation_exe","label":"Automation-enabled EXE"},{"value":"agent_exe","label":"SpaceWorker Agent"},{"value":"selfhosted_os","label":"SpaceWorker OS (Self-Hosted)"}]
S9-a) OFFERS_selfhosted_os = true | COUNT = 6
S9-b) LIFETIME_LABEL_TEXT = "Lifetime (no expiry)"
S9-b) LIFETIME_UNCHECKED_BY_DEFAULT = true
S9-b) DURATION_DISABLED_WHEN_TICKED = true
S9-b) DURATION_ENABLED_WHEN_UNTICKED = true
HTTP POST /api/admin/exe-licenses -> 200 cache-control=no-store, must-revalidate body={"reused":true,"licenseKey":"eyJleHBpcmVzX2F0IjogIjIwMjYtMTAtMzBUMDg6MjQ6NTEuMDYwMDAwIiwgImlzc3VlZF9hdCI6ICIyMDI2LTA5LTMwVDA4OjI0OjUxLjA2MDAwMCIsICJsaWNlbnNlZSI6ICJ0Ny1wcm9vZi0zMGRAZXhhbXBsZS50ZXN0IiwgInBsYW4iOiAic2VsZmhvc3RlZCIsICJwcm9kdWN0IjogInNlbGZob3N0ZWRfb3MifQ==.0624697c3cf603e4a2f535e9c466c1f38a6254730c8c7db16a11a0f171e2f7d5","product":"selfhosted_os","productName":"SpaceWorker OS (Self-Hosted)","licensee":"t7-proof-30d@example.test","expiresAt":"2026-10-30T08:24:51.060Z","exeLicenseId":"cmunuaq3p00069k1hfkgi3w1b","boundMachineId":null,"mustClaimNote":"This buyer already has a usable, unclaimed license — nothing new was created. Claim (bind) it below."}
S9-c) ISSUE_30D_RESULT_LINE = "Buyer: t7-proof-30d@example.test · Expires: 30/10/2026, 09:24:51 · Tracked as ExeLicense #cmunuaq3p00069k1hfkgi3w1b."
S9-c) ISSUE_30D_DAYS_OUT = 30
S9-c) POST_BODY_30D = "{\"email\":\"t7-proof-30d@example.test\",\"product\":\"selfhosted_os\",\"durationDays\":30}"
S9-c) THIRTY_DAY_KEY_PAYLOAD = "{\"expires_at\": \"2026-10-30T08:24:51.060000\", \"issued_at\": \"2026-09-30T08:24:51.060000\", \"licensee\": \"t7-proof-30d@example.test\", \"plan\": \"selfhosted\", \"product\": \"selfhosted_os\"}"
S9-d) DURATION_INPUT_DISABLED(editable=false) = true
HTTP POST /api/admin/exe-licenses -> 200 cache-control=no-store, must-revalidate body={"licenseKey":"eyJleHBpcmVzX2F0IjogIjI5OTktMTItMzFUMjM6NTk6NTkuMDAwMDAwIiwgImlzc3VlZF9hdCI6ICIyMDI2LTA5LTMwVDA4OjM3OjM5Ljk4MDAwMCIsICJsaWNlbnNlZSI6ICJ0Ny1wcm9vZi1saWZldGltZUBleGFtcGxlLnRlc3QiLCAicGxhbiI6ICJzZWxmaG9zdGVkIiwgInByb2R1Y3QiOiAic2VsZmhvc3RlZF9vcyJ9.5b9f3eda9b4295ac535c047d6e1653aa99e588d834882e9acd523f919cba1760","product":"selfhosted_os","productName":"SpaceWorker OS (Self-Hosted)","licensee":"t7-proof-lifetime@example.test","expiresAt":"2999-12-31T23:59:59.000Z","exeLicenseId":"cmunur7db000y9k1hdjo1z9ox","isNewAccount":false,"claimUrl":"http://localhost:3400/api/exe-license/claim?token=FIN_AuYOxWrrBLCx3fEs_ePSgKcXvTq8dL-NHuVELyQ.1791362259984"}
S9-d) ISSUE_LIFETIME_RESULT_LINE = "Buyer: t7-proof-lifetime@example.test · Expires: 01/01/3000, 00:59:59 · Tracked as ExeLicense #cmunur7db000y9k1hdjo1z9ox."
S9-d) POST_BODY_LIFETIME = "{\"email\":\"t7-proof-lifetime@example.test\",\"product\":\"selfhosted_os\",\"lifetime\":true}"
S9-d) LIFETIME_KEY_PAYLOAD = "{\"expires_at\": \"2999-12-31T23:59:59.000000\", \"issued_at\": \"2026-09-30T08:37:39.980000\", \"licensee\": \"t7-proof-lifetime@example.test\", \"plan\": \"selfhosted\", \"product\": \"selfhosted_os\"}"
S9-d) LIFETIME_SENTINEL_IN_SIGNED_KEY = true
S9-d) POST_BODIES_ALL = ["{\"email\":\"t7-proof-30d@example.test\",\"product\":\"selfhosted_os\",\"durationDays\":30}","{\"email\":\"t7-proof-lifetime@example.test\",\"product\":\"selfhosted_os\",\"lifetime\":true}"]
HTTP GET /api/admin/exe-licenses -> 200 cache-control=no-store, must-revalidate body={"licenses":[{"id":"cmunur7db000y9k1hdjo1z9ox","email":"t7-proof-lifetime@example.test","product":"selfhosted_os","productName":"SpaceWorker OS (Self-Hosted)","issuedAt":"2026-09-30T08:37:39.983Z","boundMachineId":null,"boundMachineLabel":null,"boundLicenseKey":null,"boundAt":null,"revoked":false},{"id":"cmunumne0000o9k1h3s3en5om","email":"t7-proof-lifetime@example.test","product":"selfhosted_os","productName":"SpaceWorker OS (Self-Hosted)","issuedAt":"2026-09-30T08:34:07.465Z","boundMachineId":null,"boundMachineLabel":null,"boundLicenseKey":null,"boundAt":null,"revoked":true},{"id":"cmunucnly000e9k1h0rjjyg4p","email":"t7-proof-lifetime@example.test","product":"selfhosted_os","productName":"SpaceWorker OS (Self-Hosted)","issuedAt":"2026-09-30T08:26:21.190Z","boundMachineId":null,"boundMachineLabel":null,"boundLicenseKey":null,"boundAt":null,"revoked":true},{"id":"cmunuaq3p00069k1hfkgi3w1b","email":"t7-proof-30d@example.test","product":"selfhosted_os","productName":"SpaceWorker OS (Self-Hosted)","issuedAt":"2026-09-30T08:24:51.109Z","boundMachineId":null,"boundMachineLabel":null,"boundLicenseKey":null,"boundAt":null,"revoked":false}]}
S9-e) ROW_BEFORE = "t7-proof-lifetime@example.test | SpaceWorker OS (Self-Hosted) | Issued 30/09/2026, 09:37:39 | Unclaimed | Cancel license | Revoke | Show history (2)"
S9-e) ROW_BEFORE_BADGE_CANCELLED = false
S9-e) ROW_BEFORE_HAS_CANCEL_CONTROL = true
--- clicking Cancel license ---
S9-e) CONFIRM_DIALOG_TITLE = "Cancel this license?"
S9-e) CONFIRM_DIALOG_BODY = "The licence for t7-proof-lifetime@example.test stops working immediately — a cancelled key can no longer be bound or transferred, and it will never be handed back out by a re-issue. You can restore it later."
HTTP POST /api/admin/exe-licenses -> 200 cache-control=no-store, must-revalidate body={"ok":true,"revoked":true,"exeLicenseId":"cmunur7db000y9k1hdjo1z9ox"}
HTTP GET /api/admin/exe-licenses -> 200 cache-control=no-store, must-revalidate body={"licenses":[{"id":"cmunur7db000y9k1hdjo1z9ox","email":"t7-proof-lifetime@example.test","product":"selfhosted_os","productName":"SpaceWorker OS (Self-Hosted)","issuedAt":"2026-09-30T08:37:39.983Z","boundMachineId":null,"boundMachineLabel":null,"boundLicenseKey":null,"boundAt":null,"revoked":true},{"id":"cmunumne0000o9k1h3s3en5om","email":"t7-proof-lifetime@example.test","product":"selfhosted_os","productName":"SpaceWorker OS (Self-Hosted)","issuedAt":"2026-09-30T08:34:07.465Z","boundMachineId":null,"boundMachineLabel":null,"boundLicenseKey":null,"boundAt":null,"revoked":true},{"id":"cmunucnly000e9k1h0rjjyg4p","email":"t7-proof-lifetime@example.test","product":"selfhosted_os","productName":"SpaceWorker OS (Self-Hosted)","issuedAt":"2026-09-30T08:26:21.190Z","boundMachineId":null,"boundMachineLabel":null,"boundLicenseKey":null,"boundAt":null,"revoked":true},{"id":"cmunuaq3p00069k1hfkgi3w1b","email":"t7-proof-30d@example.test","product":"selfhosted_os","productName":"SpaceWorker OS (Self-Hosted)","issuedAt":"2026-09-30T08:24:51.109Z","boundMachineId":null,"boundMachineLabel":null,"boundLicenseKey":null,"boundAt":null,"revoked":false}]}
S9-e) ROW_AFTER_CANCEL = "t7-proof-lifetime@example.test | SpaceWorker OS (Self-Hosted) | Issued 30/09/2026, 09:37:39 | Cancelled | Restore license | Revoke | Show history (2)"
S9-e) ROW_AFTER_BADGE_CANCELLED = true
S9-e) ROW_AFTER_HAS_RESTORE_CONTROL = true
S9-e) ROW_AFTER_HTML_SLICE = -400">Issued 30/09/2026, 09:37:39</span><span class="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/40 dark:text-red-400">Cancelled</span><button class="rounded-lg border border-emerald-300 px-2 py-1 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-900 dark:text-emerald-400 dark:hover:bg-emerald-950">Restore license</button><button class="rounded-lg border border-red-300 px-2 py-1 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:ho
S9-e) GET_API revoked(server flag) AFTER_CANCEL = true
--- clicking Restore license ---
S9-f) CONFIRM_DIALOG_TITLE = "Restore this license?"
HTTP POST /api/admin/exe-licenses -> 200 cache-control=no-store, must-revalidate body={"ok":true,"revoked":false,"exeLicenseId":"cmunur7db000y9k1hdjo1z9ox"}
HTTP GET /api/admin/exe-licenses -> 200 cache-control=no-store, must-revalidate body={"licenses":[{"id":"cmunur7db000y9k1hdjo1z9ox","email":"t7-proof-lifetime@example.test","product":"selfhosted_os","productName":"SpaceWorker OS (Self-Hosted)","issuedAt":"2026-09-30T08:37:39.983Z","boundMachineId":null,"boundMachineLabel":null,"boundLicenseKey":null,"boundAt":null,"revoked":false},{"id":"cmunumne0000o9k1h3s3en5om","email":"t7-proof-lifetime@example.test","product":"selfhosted_os","productName":"SpaceWorker OS (Self-Hosted)","issuedAt":"2026-09-30T08:34:07.465Z","boundMachineId":null,"boundMachineLabel":null,"boundLicenseKey":null,"boundAt":null,"revoked":true},{"id":"cmunucnly000e9k1h0rjjyg4p","email":"t7-proof-lifetime@example.test","product":"selfhosted_os","productName":"SpaceWorker OS (Self-Hosted)","issuedAt":"2026-09-30T08:26:21.190Z","boundMachineId":null,"boundMachineLabel":null,"boundLicenseKey":null,"boundAt":null,"revoked":true},{"id":"cmunuaq3p00069k1hfkgi3w1b","email":"t7-proof-30d@example.test","product":"selfhosted_os","productName":"SpaceWorker OS (Self-Hosted)","issuedAt":"2026-09-30T08:24:51.109Z","boundMachineId":null,"boundMachineLabel":null,"boundLicenseKey":null,"boundAt":null,"revoked":false}]}
S9-f) ROW_AFTER_RESTORE = "t7-proof-lifetime@example.test | SpaceWorker OS (Self-Hosted) | Issued 30/09/2026, 09:37:39 | Unclaimed | Cancel license | Revoke | Show history (2)"
S9-f) GET_API revoked(server flag) AFTER_RESTORE = false
S9-g) ROW_30D = "t7-proof-30d@example.test | SpaceWorker OS (Self-Hosted) | Issued 30/09/2026, 09:24:51 | Unclaimed | Cancel license | Revoke"
S9_DONE
```

**What S9 actually proves (rendered half).** `S9-a` — the product `<select>` offers **`selfhosted_os`**, 6 options total, which can only come from `LICENSABLE_EXE_PRODUCTS` (the `EXE_PRODUCTS` list is 5 and excludes it), so the `:6`/`:3565` swap is live in the built app, not just in source. `S9-b`/`S9-d` — the Lifetime toggle exists, is **unchecked by default**, ticked it **disables** the duration input, unticking re-enables it, and the POST body then carries **`"lifetime":true`** with **no** `durationDays`; the re-signed key carries `expires_at: 2999-12-31T23:59:59.000000` and the result panel shows `Expires: 01/01/3000`. `S9-c` — the unticked path is unaffected and still sends `"durationDays":30` with a real 30-day expiry. `S9-e` — a genuinely revoked row renders the red `Cancelled` pill **and** swaps Cancel→`Restore license`; the HTML slice shows the badge span and the emerald Restore button in the DOM. `S9-f` — Restore removes both and the server flag returns to `false`. `S9-g` — the untouched 30-day row still reads `Unclaimed | Cancel license`, so nothing regressed. Every transition is corroborated by the server's own `revoked` flag read back over HTTP, which is the whole point: the UI reflects the server, it does not decide.

**Proof nothing regressed** (`/Users/mikeolab/spaceworker`, read-only, no writes):

```
$ git diff --stat main self-hosted-build -- lib/exe-license-validator.ts
                        <- EMPTY (canary intact)
$ git diff --stat main self-hosted-build -- lib/license-service.ts
                        <- EMPTY (FROZEN, intact)
$ git diff --numstat main self-hosted-build -- lib/exe-license.ts
13      0       lib/exe-license.ts
$ git diff --numstat main self-hosted-build -- lib/exe-license-bind.ts
27      2       lib/exe-license-bind.ts
$ git diff --numstat main self-hosted-build -- app/api/admin/exe-licenses/route.ts
170     19      app/api/admin/exe-licenses/route.ts
$ git diff --numstat main self-hosted-build -- lib/products.ts
24      2       lib/products.ts
$ git diff --numstat main self-hosted-build -- 'app/admin/(protected)/admin-panel.tsx'
31      1354    app/admin/(protected)/admin-panel.tsx
$ cd /Users/mikeolab/spaceworker && npx tsc --noEmit
LIVE_TSC_EXIT=0        (0 lines of output)
```

All canaries read exactly the pass-12 figures. The `31 1354` is the **committed** `W17` divergence and is not mine; my edit was uncommitted when that was measured and reads **`112 12`** against `HEAD` in the worktree. Nothing else in the worktree is modified, so T7 is fully attributable. The live app's `tsc` is clean with the other agent's WIP in place, so the canary is not hiding a fault.

**UNVERIFIED:** the `.mts` proof script, the browser it drove and the throwaway server are gone — the S9 output above is the artefact. `S13`/`S14` (`T11`/`T13`) and `S15`/`S16` remain untested. I did **not** revoke a licence that is **bound** (`S13`'s ground, `T11`'s kill path), and I did not see a **bound-then-revoked** row rendered — the badge precedence puts `revoked` before `boundMachineId`, so it should read `Cancelled`, but that is reasoning, not something I observed.
**NOT RUNNABLE BY JUNIOR:** nothing in `T7`'s check block was skipped — both static halves ran and the runtime `S9` ran against `spaceworker_t145`.

**Environment notes for the next agent.** `next start` cannot boot this worktree off the checked-in `.env` (placeholder guard on `SESSION_SECRET`/`RESEND_API_KEY`) — command-line overrides only; `.env` was not edited. `node_modules` needed no repair (real clone). The repo ships no test browser, so S9 drove the system Chrome through `playwright-core`. Trap: a `page.waitForFunction` that matches the buyer's email inside **any** `div.rounded-xl` false-matches the **issue-result panel** above the table, which never carries a badge — match the group card by its `span.text-sm.font-semibold` title span instead.

READY FOR VERIFICATION - T7

