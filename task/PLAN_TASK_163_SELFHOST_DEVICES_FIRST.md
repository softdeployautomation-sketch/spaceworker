# PLAN — Task 163: Self-host build that can ship ONLY the device manager

**Status: SCOPED, not started.** 2026-10-05.
Owner: *"check the selfhost plan we had, if its possible for a user to select just devices for the
selfhost without wanting other apps... the first priority for the self host is the devices part, so
in case a user dont want the mailer or the extractor, they only want the device manager, we should be
able to create each tool like that. If its not in the plan, lets add it so when we resume that, we
will tackle that first."*

## 1. Direct answer to the owner's question

**No — a devices-only self-host build is not possible today, and the gap is much bigger than one
enum value.** Adding `"devices"` to `EXE_BUILD_TARGETS` is necessary but nowhere near sufficient.
Three independent blockers, all verified 2026-10-05:

### Blocker 1 — there is no `devices` build target at all
```ts
// lib/exe-build-target.ts:9
export type ExeBuildTarget = "extractor" | "mailer" | "combined" | "automation";
```
No `devices`. "Which apps are in this build" has no vocabulary for a devices-only build.

### Blocker 2 — narrowing is implemented for exactly ONE target, as a hardcoded allow-list
```ts
// components/dashboard-nav.tsx:64-66
const BUILD_ALLOWED_HREFS: Record<string, Set<string> | undefined> = {
  extractor: new Set(["/dashboard", "/dashboard/extract", "/dashboard/settings"]),
};
```
`mailer`, `combined` and `automation` are **declared but have no narrowing entry**, so those EXEs
ship the **full web nav** today. Adding `devices` inherits the same bug unless the table is

---

## 2. Two genuinely different products — the owner must pick

| | **(A) Self-host = same web app, self-hosted infra** | **(B) Devices-only EXE build** |
|---|---|---|
| What ships | All modules, on the customer's own infra | Only the device manager, as a desktop app |
| Turns other apps off? | Yes — via `hasEntitlement` + nav narrowing | Yes — via build target |
| Needs a customer-run DB | Yes | **No local DB exists** — must be built |
| Effort | Infrastructure packaging + entitlement tiering | New local data plane for devices |
| Honest risk | Medium | **High** — devices genuinely needs a server |

**Recommendation: (A), with per-module entitlement gating as the "turn off" mechanism.** It reuses
machinery that already exists and is already correct:

- `ENTITLEMENT_KEYS = ["extractor","mailer","assistant","devices","cyberlab","hosting"]`
  (`lib/entitlements.ts:9`) — **`devices` is already its own key.**
- `hasEntitlement(userId, key)` is the single gate; features check **capabilities, never tiers**
  (design note, `lib/entitlements.ts:6-11`).
- Modules already grant per-key entitlements on payment (`lib/products.ts`,
  `lib/license-service.ts:79-84`).

**So the entitlement half of the request already works.** A user who buys only `extractor_module`
holds only `["extractor"]`. What is missing is (i) a **nav/dashboard visibility** layer driven by
entitlements, and (ii) the `devices` key being **sellable on its own**.

## 3. The one genuinely missing commercial item — do this first

```ts
// lib/products.ts:106-119
export const ASSISTANT_DEVICES_MODULE: StoreProduct = {
  id: "assistant_devices_module",
  name: "Assistant & Devices",
  entitlementKeys: ["assistant", "devices"],   // ← bundled; devices not separable
};
```
**There is no way to buy `devices` by itself today** — it is welded to `assistant`. The owner's
"devices first" priority needs a `DEVICES_MODULE` granting `["devices"]`: one `StoreProduct`, one
`priceField` on the pricing settings, plus tests. Small, contained, independently shippable, and
it directly serves the stated priority. **Start here.**

## 4. Phases (after the owner picks A or B)

- **V1** `DEVICES_MODULE` — sell `devices` standalone. *(No blockers. Start here.)*
- **V2** Entitlement-aware nav — `DashboardNav`/`Dock`/overview tiles filter by
  `listEffectiveEntitlements(userId)`, so a user's OS shows only what they bought. This is the real
  "turn the others off" UX, and it works under **both** A and B.
- **V3** Generalise `BUILD_ALLOWED_HREFS` from a one-entry table to
  `Record<ExeBuildTarget, Set<string>>` covering **all four** existing targets, so `mailer`,
  `combined` and `automation` stop leaking the full web nav. *Fixes a live bug regardless of the
  self-host decision.*
- **V4** Add `"devices"` to `ExeBuildTarget` **and** make the Devices page + device runtime work
  with no `DATABASE_URL`. **The hard one** — needs either a bundled embedded store for device
  records or a mandatory link to the hosted API. Scope properly before promising it.
- **V5** Only if (B): the local-first device plane + sync model.

## 5. Rules
- **Devices is not a browser feature.** Any V4 design that pretends otherwise fails at the first
  restart, first lost connection, or first offline machine.
- Keep `hasEntitlement` as the single gate; never add tier checks (`tier >= 5` is exactly the trap
  the schema warns about, `prisma/schema.prisma:22-23`).
- **Every phase ends with the full suite green**: tsc, test:hosting 334, test:support 30,
  test:wallet 29, ESLint, `CI=true npm run build`. No CI runs these (handoff §5 trap 2).
- **No CLI that prints a secret.** Follow `scripts/set-platform-token.ts`: stdin only, never argv,
  never a log line.

## 5A. Re-verified 2026-10-05 + owner ruling (this is the priority)
**Owner ruling, locked:** *"the first priority for the self host is the devices part… we should be
able to create each tool like that. If its not in the plan, lets add it so when we resume that, we
will tackle that first."*

I re-checked all three blockers against the source rather than trusting the prose above. **All
three still hold:**

| Claim | Re-verified at |
|---|---|
| `ExeBuildTarget = "extractor" \| "mailer" \| "combined" \| "automation"` — no `devices` | `lib/exe-build-target.ts:9-11` |
| `BUILD_ALLOWED_HREFS` has **exactly one** entry (`extractor`), so the other three ship the full nav | `components/dashboard-nav.tsx:64-66` |
| `devices` is already its own entitlement key | `lib/entitlements.ts:12` |
| …but it is welded to `assistant` — no standalone product exists | `lib/products.ts:106-112` |

**So the priority the owner named is exactly V1, and V1 is genuinely cheap.** The expensive work
(V4's local device data plane) is *not* on the critical path for "sell devices on its own".

### Build order — V1 first, and it is small
- **V1 — `DEVICES_MODULE`.** One `StoreProduct` with `id: "devices_module"`, `name: "Device
  Manager"`, `priceField: "devicesModulePriceUsd"`, `kind: "module"`, **`entitlementKeys:
  ["devices"]` only**. Needs: the product entry, the new `AdminSetting` price column (additive,
  nullable or defaulted — never NOT NULL without a default on a live table), a `/pricing` entry
  if prices are listed there, the store test, and the entitlement-gate test proving a holder of
  `["devices"]` alone passes `hasEntitlement(userId, "devices")`.
  **Deliverable the owner actually asked for:** a user can buy device management *without* the
  mailer or the extractor.
- **V2 — entitlement-aware nav.** `DashboardNav`/dock/overview filter by
  `listEffectiveEntitlements(userId)`. This is the real "turn the others off" UX and works under
  both A and B.
- **V3 — generalise `BUILD_ALLOWED_HREFS`.** `Record<ExeBuildTarget, Set<string>>` covering **all
  four** targets. **Fixes a live bug regardless of the self-host decision** — `mailer`, `combined`
  and `automation` currently leak the entire web nav into their EXEs. Cheapest real win in this
  whole plan and it needs no product input; consider shipping it before V1.
- **V4 — the hard one.** Add `"devices"` to `ExeBuildTarget` **and** make the Devices page +
  device runtime work with **no `DATABASE_URL`**. Needs either a bundled embedded store for
  device records or a mandatory link to the hosted API. Scope properly before promising it.
- **V5** — only if the owner picks option (B): the local-first device plane + sync model.

### ⚠ Sequencing warning
V4 is where the real cost is, and V4 is **only reachable after V1 ships devices standalone**. Do
**not** let V4's difficulty push V1 backwards: V1 is independently valuable and independently
deployable, and it is the literal thing the owner asked for.

## 5B. Open questions I deliberately did NOT guess
1. **A or B** (§2) — still the owner's structural call. V1/V2/V3 are valid under **both**, which is
   exactly why they are sequenced first.
2. **Should V1 deprecate the `assistant_devices_module` bundle?** The owner should decide: keep
   selling the bundle as "Assistant & Devices" (assistant + devices together), or split it so
   `assistant` becomes its own product. **Splitting changes what existing customers bought**, so
   that is a commercial decision, not a refactor.
3. **Default price for a standalone Devices module** — needs a real number from the owner; I did
   not invent one.
4. **Does a devices-only buyer need the Vantra link?** Device online/idle telemetry is a
   pass-through to the separate Vantra service (`SENIOR_HANDOFF.md` §1). A devices-only customer
   arguably needs that integration configured on day one, and nobody has confirmed what happens
   today if `VANTRA_INTERNAL_TOKEN` is absent.
5. **Is the hosted-device limit per-user or per-plan** for a devices-only customer?

generalised. (`undefined` = allow everything — `:70-74`.)

### Blocker 3 — Devices is deliberately **web-only**, because it needs infrastructure the EXE lacks
`/dashboard/devices` is absent from the extractor allow-list, and the overview page is explicit
that the browser button used to be hardcoded because its page *"needs the real database + VPS
browser-session infrastructure, neither of which exist there"* (`app/dashboard/page.tsx:40-47`).
Devices is worse:
- **Devices needs the hosted Postgres.** The EXE ships with **no `DATABASE_URL` by design**
  (`app/dashboard/layout.tsx:13-19`, `:33-35`). Device records, wake-on-LAN state and screenshots
  are all database rows.
- **Devices needs the server-side device runtime** — remote control, screen capture, the app
  launcher. Not browser code.

**So "turning off the other apps" is the easy half.** Shipping devices *in* a self-host build
requires standing up the data + device-runtime plane first. That is why it was never scoped.
