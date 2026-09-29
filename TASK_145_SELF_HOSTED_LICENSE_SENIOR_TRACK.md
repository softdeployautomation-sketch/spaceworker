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
| S13 | **THE LIVE KILL (E7)** — with a real revoked row, POST `/api/exe-license/eligibility` with (a) the licence's original key and (b) its current bound key | **both** return `eligible: false`. Before the edit both returned `true` (W2) — this single row is what makes the owner's "immediate revocation" real. |
| S14 | End-to-end kill on the desktop class: revoke a bound licence, then POST `/api/exe-license/status` against a local runtime holding that activation | `licensed: false`, message *"This license has been revoked…"*, and the local activation is cleared (mirrors the W1 path). |
| S15 | **Lifetime move control (E9)** — self-service transfer of a lifetime licence, then the same transfer via admin `action: "transfer"` | self-service throws `"lifetime_locked"` **and** the `ExeLicense` row is unchanged (`boundMachineId` / `boundLicenseKey` byte-identical, no new `ExeLicenseTransfer` row); admin transfer **succeeds**. |
| S16 | **Self-hosted runtime check (E8)** — (a) expired/revoked stored key, (b) still-valid key with the server unreachable (W4) | (a) blocked with a clear message; (b) **NOT** blocked (fail-open preserved). Confirms W4 is closed without breaking offline use. |

### 4.3 Deployment note (do not deploy as part of this task)

The hosted VPS runs the **live** app from `main`. Phase 5 lands on `self-hosted-build` only. When the branch is eventually merged, the schema migration must be applied on the VPS per `HOW_WE_MOVE_FAST.md` §2/§3 — a new table + a column with a default is a safe online migration, but it still needs the maintenance-window script. Do not run a migration against the live DB to "test" this task.

---

## 5. Assignment

The implementation is handed to the **junior agent** in `TASK_145_SELF_HOSTED_LICENSE_JUNIOR_TRACK.md`. That file is the work order; this file is the spec of record. The junior must:

1. Work **only** in `/Users/mikeolab/sw-selfhost` on branch `self-hosted-build`.
2. Implement §3 **D1–D10** — including **§3.9 (Revision 2)**, which **amends D5** and adds **D8–D10** — in the stated order, and stop at the first `⚠️` in the log rather than guessing.
3. Append a dated entry to **both** files when the code is written (what changed, `file:line`, commands run + raw results, anything unverified).
4. **Not** mark anything "done" or "verified" — only the senior closes a verification row (S1–S16). The junior writes `READY FOR VERIFICATION`, never `VERIFIED`.
5. **Stop after each task.** Report at the end of every `T*` (§2 of the junior track) rather than working through the whole list in one session — see the junior track's **§2.0 stop-after-each-task rule**.

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

