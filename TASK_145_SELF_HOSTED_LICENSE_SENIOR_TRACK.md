# TASK_145 — Phase 5: self-hosted product license (flexible term + admin revocation)

## SENIOR / VERIFICATION TRACK — owned by the senior engineer (scope + review + live verification)

**Status:** SCOPE COMPLETE, all findings below verified against real code on 2026-09-29. Implementation NOT started.
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
- Worktrees use a shared `node_modules` (this repo's existing convention):
  ```bash
  ls -ld /Users/mikeolab/sw-selfhost/node_modules   # -> symlink to /Users/mikeolab/spaceworker/node_modules
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
npx prisma generate                     # after ANY prisma/schema.prisma edit
npx prisma migrate dev --name <slug>    # creates the migration file (local DB)
```

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
| V17 | `lib/exe-license*.ts`, `lib/license-service.ts`, `app/dashboard/settings/licenses-section.tsx` | Verified **zero diff** between `main` and `self-hosted-build` — `git diff --stat main self-hosted-build -- lib/exe-license.ts lib/exe-license-validator.ts lib/exe-license-bind.ts lib/license-service.ts app/dashboard/settings/licenses-section.tsx` returned empty. | Confirms §0.2: this is shared, live code. Every edit must be additive / hosted-safe. |
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

Exactly three exports; nothing else:

```ts
export async function isExeLicenseRevoked(exeLicenseId: string): Promise<boolean>
export async function revokeExeLicense(input: { exeLicenseId: string; userId: string; reason?: string | null; revokedBy?: string | null }): Promise<void>
export async function unrevokeExeLicense(exeLicenseId: string): Promise<void>
```

- `revokeExeLicense` must be **idempotent** (`upsert` on the unique `exeLicenseId`) — a double-click must not throw a unique-constraint 500.
- It must also `void notifyAdmin(...)` on both revoke and un-revoke (mirrors the bind/transfer notification style at `lib/exe-license-bind.ts:191`), so there is an operational trail even though un-revoke deletes the row.
- `revokeExeLicense` must **verify the licence belongs to `userId`** and throw a typed error otherwise — the same ownership discipline every other action in the admin route uses.

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

**Rejected alternatives (do not use):** checking revocation in `lib/exe-license-validator.ts` (deliberately offline and ships inside the customer's binary — it can never see our DB); checking it on every app launch (breaks the design invariant); storing revocation as a column on `ExeLicense` (loses `reason`, and muddies a table `main` also owns).

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

## 4. Verification protocol (senior-owned — the junior must not self-approve)

### 4.1 What the junior may run themselves

```bash
cd /Users/mikeolab/sw-selfhost
npx prisma generate && npx prisma migrate dev --name add_exe_license_revocation
npx tsc --noEmit        # MUST be clean; the branch baseline is EXIT=0 (§7)
npm run build           # must succeed
```
Plus the narrow unit assertions listed in the junior track §V.

### 4.2 What only the senior verifies (evidence required, pasted into this file's log)

| ID | Check | Pass condition |
|---|---|---|
| S1 | `git diff --stat main self-hosted-build -- lib/exe-license-validator.ts` | **empty** — the validator was not touched |
| S2 | Round-trip a lifetime key end-to-end with real code paths (script, not mocks): `generateLicenseKey({expiresAt: LIFETIME_EXPIRES_AT})` → `verifyLicenseKey` → `validateLicenseKey` | `valid: true`, `expiresAtDate.getUTCFullYear() === 2999`, `error === ""` |
| S3 | 30-day key through the same path | `valid: true`, `expiresAtDate` ≈ now+30d (proves flexible term, not 180) |
| S4 | Bind a lifetime key with a real `ExeLicense` row | `boundLicenseKey` decodes to `expires_at` starting `2999-` (verbatim preservation — V8) |
| S5 | Revoke that licence, then attempt a bind on a fresh machine | throws with code `"revoked"`, and the DB row is unchanged |
| S6 | Revoke, then POST `action: "issue"` for the same user+product | response is **not** `reused: true` — a NEW key is minted (E4) |
| S7 | Un-revoke, then bind | succeeds again (reversibility) |
| S8 | `curl -s localhost:3000/api/store/prices \| grep -c selfhosted_os` | `0` — new product not leaked to the public store |
| S9 | Admin panel: issue a 30-day licence and a lifetime licence; buyer Settings page shows 30 days and "No expiry" respectively | both correct, no `180` anywhere in the rendered copy |
| S10 | Self-hosted wizard: enter a store-bought `extractor_exe` key | rejected with a product-mismatch message (D6.1) |
| S11 | `isSelfHosted()` early-returns at `app/api/admin/exe-licenses/route.ts:50,473` still present | unchanged — revoke endpoints are inert on a customer's box |
| S12 | Migration sanity | `npx prisma migrate status` clean; migration is **additive only** (one new table, one new column with a default) — no destructive statement |

### 4.3 Deployment note (do not deploy as part of this task)

The hosted VPS runs the **live** app from `main`. Phase 5 lands on `self-hosted-build` only. When the branch is eventually merged, the schema migration must be applied on the VPS per `HOW_WE_MOVE_FAST.md` §2/§3 — a new table + a column with a default is a safe online migration, but it still needs the maintenance-window script. Do not run a migration against the live DB to "test" this task.

---

## 5. Assignment

The implementation is handed to the **junior agent** in `TASK_145_SELF_HOSTED_LICENSE_JUNIOR_TRACK.md`. That file is the work order; this file is the spec of record. The junior must:

1. Work **only** in `/Users/mikeolab/sw-selfhost` on branch `self-hosted-build`.
2. Implement §3 D1–D7 in the stated order and stop at the first `⚠️` in the log rather than guessing.
3. Append a dated entry to **both** files when the code is written (what changed, `file:line`, commands run + raw results, anything unverified).
4. **Not** mark anything "done" or "verified" — only the senior closes a verification row (S1–S12). The junior writes `READY FOR VERIFICATION`, never `VERIFIED`.

## 6. Review reject list — the senior will bounce the PR for any of these

1. Any edit to `lib/exe-license-validator.ts`, or to the signed payload's key set (`V4`) — including "helpfully" adding a `revoked` field to the payload.
2. Putting `SELF_HOSTED_OS` into `ALL_PRODUCTS` (leaks to the public store — S8 fails).
3. Using `daysValid: 999999` or any arithmetic instead of the frozen `expiresAt: LIFETIME_EXPIRES_AT`.
4. Revocation checked anywhere other than E1/E2/E4 (e.g. inside the validator, or a launch-time network call).
5. Skipping E4 (the reuse filter) — cancel then re-issue must mint a new key, not hand the revoked one back.
6. A non-idempotent revoke (double-click → 500) or a revoke that does not check licence ownership.
7. Deleting/renaming anything under `TASK_134..TASK_144` or any other main-only file (§0.2.3).
8. A destructive migration, or any migration run against the live VPS DB.
9. `tsc --noEmit` not clean, or `npm run build` failing.
10. Touching `app/api/store/prices/route.ts` / `admin/wallets/route.ts` "to hide" the product instead of simply not adding it to `ALL_PRODUCTS`.

## 7. Verified environment baseline (2026-09-29)

| Fact | Value |
|---|---|
| Worktree | `/Users/mikeolab/sw-selfhost` — branch `self-hosted-build`, HEAD `68afc6b` |
| Primary checkout (live app) | `/Users/mikeolab/spaceworker` — branch `main`, HEAD `b7330a1` |
| Merge base | `1499a9e` (2026-09-27); branch is 37 behind / 8 ahead |
| `node_modules` | symlink to `/Users/mikeolab/spaceworker/node_modules` (this repo's worktree convention) |
| `npx tsc --noEmit` on the untouched branch | **EXIT=0 (clean)** — `/tmp/tsc-baseline.txt` |
| Node date check | `new Date("2999-12-31T23:59:59.000000Z")` → year 2999, valid (not `NaN`) |
| Files byte-identical to `main` (must not drift, V17) | `lib/exe-license.ts`, `lib/exe-license-validator.ts`, `lib/exe-license-bind.ts`, `lib/license-service.ts`, `app/dashboard/settings/licenses-section.tsx` |
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

**5. Next actor:** the junior agent starts at **T1** in `TASK_145_SELF_HOSTED_LICENSE_JUNIOR_TRACK.md`. Every push it makes must use the explicit refspec above. Only the senior closes S1–S12.


