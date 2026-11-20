# Task 47 — Lock a license to one machine; admin manual generator first, self-service claim next

**Status: ready to build, but QUEUED BEHIND the Extractor EXE build (Task 27 Part A's current slice).** This only matters once a real EXE exists to activate — don't start it before the Extractor build is functional. Written 2026-09-15, grounded in the real current code (`lib/exe-license.ts`, `lib/exe-license-validator.ts`, `lib/license-state.ts`, `app/api/exe-license/{activate,status}/route.ts`).

## The real gap, confirmed by reading the code (not assumed)

Today a license key can be activated on **unlimited machines**. Here's why: `generateLicenseKey()` (`lib/exe-license.ts`) never sets `machine_id`/`machine_ids` on the payload at issuance — by original design, "machine binding happens client-side inside the EXE at first activation." But the actual local activation route (`app/api/exe-license/activate/route.ts`) only writes the binding to a **local file on that one machine** (`lib/license-state.ts`) — it never touches the server. Copy the same license key string into a second, fresh EXE install and it validates and "activates" there too, with zero friction, because:
1. The signed key itself carries no `machine_id` (nothing to check against).
2. There is no server-side record of "this key already belongs to machine X" to reject a second claim.

The offline validator (`lib/exe-license-validator.ts`) **already fully supports** checking `machine_id`/`machine_ids` against the current machine when those fields ARE present on the payload — this was built for the old standalone generator's machine-bound keys and never wired up to SpaceWorker's own issuance. That means real single-device enforcement doesn't need a new validator — it needs the **issued key itself** to start carrying a machine_id, which today it never does.

## The mechanism: claim = re-sign the key with a machine_id, not a phone-home check

Per the doc's own established principle ("don't build a system that requires the EXE to phone home on every launch just to check a license"), the fix must NOT add a server round-trip to ongoing validation. Instead:

1. A license is issued **unbound** exactly as today (no `machine_id`), immediately on payment approval — this part is already automatic (`lib/license-service.ts`'s `issueExeLicense`, called from `handleApprovedPayment`) and needs no change.
2. **Corrected 2026-09-15 — the unbound key is a purchase reference, never something the EXE accepts.** The email delivering it must NOT read as "enter this in the app" — frame it as purchase confirmation, with the NEXT step being "run the app, copy your Device ID, submit it on your Licenses page to get your real activation key." This matters because `lib/exe-license-validator.ts`'s machine-binding check (step 4, confirmed by reading it) is a no-op when `machine_id`/`machine_ids` are both absent — an unbound key validates successfully on ANY machine today. Relying on the email's wording alone isn't enough (the unbound key IS a real, syntactically valid signed key — nothing stops someone from pasting it into the EXE directly), so **`app/api/exe-license/activate/route.ts` must explicitly reject an activation attempt with a key that decodes to no `machine_id`**, with a clear message ("this is a purchase reference, not an activation key — claim your license on the dashboard first to get one"). This is a policy check in the activation ROUTE, not a change to the shared validator (which stays a pure signature/expiry/machine check reused by both the EXE and anything server-side that decodes a key).
3. The EXE, even before any key is entered, can compute its own machine id locally (`lib/machine-id.ts`'s port already exists) and **display it on screen** — "Your Device ID: `XXXX` — copy this into your account's Licenses page to activate."
4. The buyer pastes that device id into a "claim" form (see below — admin-run first, self-service second). The claim endpoint:
   - Confirms the caller is allowed to claim this specific license (owns it, or is the admin acting on their behalf).
   - Rejects if the license already has a *different* bound machine id (a real, clear "this license is already active on another device — contact support to transfer it" error — never silently overwrite).
   - Otherwise **re-signs a NEW license key** via `generateLicenseKey()` extended to accept `machineId` (threaded into the payload's `machine_id` field), using the SAME `licensee`/`plan` and the license's *original* `issuedAt`/remaining validity (don't reset the 180-day clock on a claim — see "Duration" below).
   - Stores the result on the `ExeLicense` row (new `boundMachineId`, `boundMachineLabel`, `boundLicenseKey`, `boundAt` columns — see schema below) and returns the new bound key to show/email the buyer.
4. The buyer enters *that* key into the EXE. The already-built offline validator checks `machine_id` against the current machine — passes here, and will *reject* on any other machine going forward, with **zero new code in the validator itself**.

This means the EXE integration is minimal: it needs a "show my device id" screen before/alongside its existing key-entry screen, but it makes **no new network calls of its own** — the claim happens entirely on the web dashboard or via the admin panel, both of which already talk to the real server. The one-time claim step is a legitimate, expected network action (the buyer is on their web account anyway); ongoing validation inside the EXE stays fully offline.

### Duration — don't let a claim reset or extend the term

`ExeLicense` doesn't currently store `expiresAt` as its own column (it's only inside the signed payload). Read the ORIGINAL key's payload to get its real `expires_at`, and re-sign the bound key with `daysValid` computed as the remaining time to that SAME expiry (not a fresh `EXE_LICENSE_DAYS`) — a claim binds a machine, it must never quietly extend a 180-day license into a new 180 days from the claim date.

## 1. Schema — `ExeLicense` gains claim-tracking columns (additive)

```prisma
model ExeLicense {
  ...
  boundMachineId    String? // set once, on first successful claim; null = unclaimed
  boundMachineLabel String? // optional buyer-chosen label ("Office PC"), cosmetic only
  boundLicenseKey   String? // the RE-SIGNED, machine-bound key actually given to the buyer post-claim
  boundAt           DateTime?
}
```
All nullable — every existing row (issued before this feature) reads as "unclaimed," which is accurate (no machine info was ever bound for them either).

## 2. `generateLicenseKey()` — accept an optional machine binding

Extend `GenerateLicenseKeyInput` with `machineId?: string`, thread it into the payload as `machine_id` when present. Keep the default (no `machineId` passed) producing today's exact unbound-key behavior — this is the same code path `issueExeLicense` already calls at payment time, now just also usable for the claim step.

## 3. Admin manual tool — build this slice first

A new admin page/section: input a buyer's **email**, pick which of their (unclaimed) EXE licenses to bind (or none exist yet → issue a brand-new one manually: product tier + duration, for an off-platform payment or a comp), enter the **machine id** (+ optional device label), submit. Runs synchronously (key generation is HMAC + a DB write — milliseconds, no real background job needed despite "runs in background" in the ask; show a spinner + a clear success confirmation with the resulting key, which reads the same to the admin as an actual background action would).

- Reuses `generateLicenseKey()` (extended above) for both "issue new" and "bind existing" — one function, two entry points, no duplicated signing logic.
- "Issue new" also needs a `Payment`-row story: either require a real `Payment` (for off-platform payments, admin creates one manually with `status: "approved"`, `kind` reflecting the manual method) so `ExeLicense.paymentId` stays a real foreign key with no special-cased nullable path, or make `paymentId` nullable for admin-issued licenses — **the former is safer and keeps the accounting/audit trail consistent with every other license**, prefer it unless it proves awkward in practice.

## 4. Customer self-service claim — build this second, after the admin tool is proven

On `/dashboard/licenses`, any of the signed-in buyer's `ExeLicense` rows with `boundMachineId === null` gets an inline "Activate this license" form (device id + optional device label) that calls the same claim logic, scoped to `ExeLicense.userId === session.userId` (ownership is the only gate needed — only paid buyers have a row here at all, so "only paid users' email get access" falls out for free, no separate check required). Shows the resulting bound key to copy once claimed; a re-visit of an already-claimed license just shows its bound key and device label, read-only (claiming is one-time; going to a *different* machine is the admin re-bind/support case, not self-service — don't build silent self-service re-binding, that's the DRM hole this whole task closes).

## Explicitly out of scope

- Any change to the offline validator itself — it already does everything needed.
- Automatic re-binding without a human (support) decision — a customer who genuinely needs to move to a new machine should go through the admin tool as a deliberate support action, not a self-service "just claim again" button.
- A real background job queue for "runs in background" — key generation is fast enough that a synchronous call with a loading state reads identically to the user.

## Verification expected

- `npx tsc --noEmit` / `npm run build` clean; migration applied.
- Live: generate an unbound key (simulating a real purchase), claim it from the admin tool with machine id A, confirm `boundLicenseKey`'s payload decodes with `machine_id: "A"` and the SAME `expires_at` as the original unbound key (no silent extension).
- Live: attempt to claim the SAME license again with a DIFFERENT machine id B — confirm it's rejected with a clear "already active on another device" error, and `boundMachineId` stays A.
- Live, once the Extractor EXE exists: enter the bound key + machine A into the EXE — succeeds. Copy that same key string into a fresh EXE install on machine B (or simulate a different `getMachineId()` return) — confirm the OFFLINE validator rejects it, no server involved.
- Live: attempt to activate the EXE with the ORIGINAL unbound key (the one from the instant purchase email, never claimed) — confirm `app/api/exe-license/activate/route.ts` rejects it with the "claim your license first" message rather than accepting it as a working, machine-agnostic license. This is the actual vulnerability this task exists to close — verify it directly, don't assume the email wording alone prevents it.
