# TASK_181 — Device wrapper EXE: Devices-only app, Premium XDevice tier (SCOPED 2026-10-07)

**Status: SCOPED, not started.** Written for the next agent from the owner's brief
(2026-10-07, verified against the repo the same day — every "today" claim cites
`file:line`). The playbook is binding: `HOW_WE_MOVE_FAST.md`. Verification is scripted in
`PROMPT_NEXT_VERIFICATION_AGENT.md` (rewritten for this task).

## 0. Owner's brief (verbatim, 2026-10-07)

> creating a exe wrapper for just the device tab alone, and i want just the public agent
> available and no need saying anything about private movement. what i want that wrapper to
> have is just the devices and vbs installer and exe and mac saying coming soon. no private
> agent, or public agent, just agent, and also for free users they get to access the tab and
> also generate a vbs link, and get the device enrolled, but no option for terminal or any
> other tools, all will be locked until they become premium xdevice. premium xdevice is a
> subscription i want to name for users who just want the device, and maybe just the device
> wrapper, so we use the same flow we have for the vantra exe, users need to create account,
> and pay to use this, then will also have the payment flow working, so any free user can pay
> to get to premium easily. and i want the support ticket also there as it is, and the menu
> also, but only device will be unlocked for that user to move, he cant click other tabs, can
> only see the menu. or maybe we just make the menu smaller and show just the device and
> settings, with only settings concerning the user, no other settings to other tabs.
> [and] if this will be blocked by the grant user admin bug or completing the wallet task,
> then lets finish those and resume this, this is priority.

Screenshot (owner's, 2026-10-07): "SpaceWorker OS" desktop window — full dock (Overview /
Devices / Extract / Campaigns / Automations / Private Browser / Hosting / Cyber Lab /
Settings), Wallet chip, Sign out, support bubble bottom-left, Panic button, Devices tab with
the public Add-device panel (Public/Private toggle, Install method dropdown, ALL LINKS).

## 1. Dependency verdict (the owner's conditional, answered)

**Not hard-blocked. Two small pre-flights land first, then TASK_181 builds.**

| Dependency | State (verified) | Verdict |
|---|---|---|
| **0c grant bug** ("Grant failed" $50 founders funding) | ROOT-CAUSED, ready to fix, SMALL: `grantBalance` gets `adminId: session.sub` = `"admin"`, FK to `User` → P2003 → HTML 500 → generic "Grant failed" (`SENIOR_HANDOFF.md` §7 row 0c; only caller `app/api/admin/wallet/grant/route.ts`) | **Do FIRST (P0a)** — ~30 min, already owner-queued ahead of this, and admins need working grants to comp test accounts during acceptance. Fix = nullable-admin + JSON 500 + unit test (row 0c option A). Own money-code commit. |
| **Wallet W5** (`POST /api/wallet/spend`, the debit path) | BUILT `b3e2540`, pushed, deploy run `37470986552` success — **awaits verifier live-confirm** (§7 row 2b). Note: W5 writes **tier 5** today (`TASK_174` §1) | **P0b: live-confirm only** (no build). Premium XDevice "activate with balance" rides this path, so verify it end-to-end before building on it. Spending on an xdevice product needs a small grant-target extension (P3). |
| **Wallet W6** (EXE-from-wallet) | Not started; owner order keeps it after the grant fix | **NOT a dependency.** XDevice is a subscription/tier grant, not an EXE license — W5 (terms spend) + the `Payment` flow cover it. W6 stays queued. |
| **TASK_175** desktop-only link gate | SCOPED, not built (`desktopOnly` absent from code) — owner said "BUILD FIRST" 2026-10-06 | Not a dependency of the wrapper (different feature). Leave its queue position alone. |
| **TASK_174** Premium/Plus split | SCOPED, NOT STARTED (no tier 10 / `grantPlus` in code) | Not a blocker, but **interacts**: XDevice must pick a tier number that does not collide with 174's plan (1=trial, 5=Premium, 10=Plus). Use **3** (2/3/4 unused — `TASK_174` §1). Document the interaction both ways when either lands. |

**Order: P0a grant fix → P0b W5 live-confirm → P1–P4 of this task.** If P0a/P0b turn up
surprises (e.g. W5 broken live), fix those before continuing — that is exactly the owner's
conditional. W6/TASK_175/TASK_174 do NOT gate this work.

## 2. What exists today (verified 2026-10-07 — do not re-derive)

| Thing | Reality | Cite |
|---|---|---|
| Nav single source | `NAV_ITEMS` = Overview, Devices, Extract, Campaigns, Automations, Private Browser, Hosting, Cyber Lab, Settings; consumed by dock + sidebar + mobile row + Window menu | `components/dashboard-nav.tsx:37-76` |
| Build narrowing | `BUILD_ALLOWED_HREFS: Record<string, Set<string>>` — **only `extractor` narrows**; a `buildTarget` without an entry sees the FULL nav (documented live bug for mailer/combined/automation) | `components/dashboard-nav.tsx:80-91`; `PLAN_TASK_163_SELFHOST_DEVICES_FIRST.md` |
| Build targets | `ExeBuildTarget = extractor \| mailer \| combined \| automation`, read from `BUILD_TARGET` env (default `extractor`) | `lib/exe-build-target.ts:10-18` |
| Shell build mode | `buildTarget` set ⇒ **WalletChip hidden, Logout hidden, local runtime with no DATABASE_URL** | `components/shell.tsx:18-77` (esp. `:52`, `:56`, `:77` comment) |
| Devices tab gating | **View is ungated** (no `hasEntitlement`/tier check in the page); **public mint is ungated**; **private mint = `devices` entitlement (premium 5; free/trial 403)** | `app/dashboard/devices/page.tsx` (no hits); `app/api/assistant/vantra/install-link/route.ts:26-27,38` |
| Mint kinds | `private`, `public` (zip link), `public-powershell`, `public-vbs`, `public-vbs-link` — NO exe kind in this route (EXE method is handled separately in the UI) | `install-link/route.ts:110-116`; `components/device-list.tsx:966-971` |
| Install-method dropdown | zip / powershell / vbs / exe / `mac` disabled "macOS (coming soon)" | `components/device-list.tsx:966-971` |
| Device tools server gates | **No tier/entitlement checks found** on device run-command routes or console | `app/api/admin/devices/*/run-command/route.ts`, `app/console/**` (grep clean) |
| Entitlements | `ENTITLEMENT_KEYS = extractor, mailer, assistant, devices, cyberlab, hosting`; tier 5 ⇒ every key implicitly | `lib/entitlements.ts:12,35` |
| Tiers | 1 = trial, 5 = Premium, **2/3/4 unused**, 10 planned for Plus (not built) | `TASK_174_PREMIUM_PLUS_TIERS.md` §1 |
| Payment rails | `GET /api/billing/checkout?kind=btc\|usdt_trc20\|usdt_erc20&product=…` (crypto addresses from `AdminSetting.btcWallet/usdtWallet/usdtErc20Wallet`) → `POST /api/billing/submit` builds a `Payment` (product kinds `web` / `module` / `exe`) → admin approve → `handleApprovedPayment` grants. Wallet: W1–W4 live, W5 deployed-unconfirmed | `app/api/billing/checkout/route.ts:15-21`, `submit/route.ts:60-129`, `lib/license-service.ts:39-44`; `SENIOR_HANDOFF.md` §7.1 |
| Vantra reference | Vantra already runs wallet-style confirm (guarded credit/debit) in production — reuse its shape, "on-chain confirmation is not payment" discipline | `SENIOR_HANDOFF.md` §7.1 (cites `vantra/app/api/admin/payments/[paymentId]/confirm/route.ts:70-123`) |
| Support UI | `components/support-widget.tsx` = full ticket list/create/reply UI (TASK_159 Ph1 backend + UI) | that file, `:34-176` |
| Desktop build | Tauri desktop product line built by `.github/workflows/build-exe.yml`; the owner's screenshot has WalletChip + Sign out visible ⇒ that window runs **without** `buildTarget` (server-bound to the hosted app) | `SENIOR_HANDOFF.md` §1; `components/shell.tsx:52,56` |

## 3. Product spec (what to build)

### 3.1 The wrapper
A **server-bound desktop EXE** ("device wrapper") of the SpaceWorker OS shell where:

- **Menu/dock shows only `Devices` + `Settings`** (decision D1, option B default).
- **Top bar stays as-is**: Wallet chip ("add funds"), clock, Sign out, support bubble —
  payment and support are part of the product, not removable chrome.
- **Devices tab only, with ZERO public/private language.** No "Public device"/"Private
  device" toggle, no "public agent"/"private agent", no "silently move to your private
  agent". Copy is just "Add a device", "Install method", "agent". The private mint flow is
  out of the wrapper entirely (server keeps its existing `devices`-entitlement 403).
- **Install-method dropdown in the wrapper: `.vbs` file, `EXE link`, `macOS (coming soon)`**
  only — **zip and PowerShell hidden** (they stay in the web app untouched).
- Other dashboard routes (extract/campaigns/…) are **not reachable in wrapper mode**
  (route-level guard, not just hidden links).
- Settings shows **only user-concerning sections** (profile/security, licenses) — no
  sections that configure other tabs. Audit `app/dashboard/settings/page.tsx` and split.
- **No Panic button** (owner 2026-10-07: "take away the panic button on devices, they
  dont need it since the agent wont be with the wrapper") — `PanicButton`
  (`components/device-list.tsx:19` import, `:1506` render) must not render in wrapper
  mode. Web app keeps it.
- **Branding (owner 2026-10-07):** window/app name = **"SpaceWorker OS"**; dock/taskbar
  label for the tab = **"Devices"** (not "Devices"→ anything else; the wrapper's one
  destination is labelled "Devices").

### 3.2 Free vs Premium XDevice

| Capability | Free (account, tier ≤ 1) | Premium XDevice (tier 3) |
|---|---|---|
| Open Devices tab, list devices, enroll via VBS/EXE link | ✅ (already true today — keep, verify) | ✅ |
| Mint VBS file / VBS share link / EXE link | ✅ | ✅ |
| Terminal / run-command / console / any other device tool | ❌ **server-side 403 `xdevice_required`** + UI lock ("Premium XDevice") | ✅ |
| Support ticket (widget as-is) | ✅ | ✅ |
| Settings (user-only) | ✅ | ✅ |
| Everything else (extract, campaigns, hosting…) | not present in wrapper | not present in wrapper |

- **"Premium XDevice"** is the public name of the subscription: "for users who just want
  the device (and maybe just the device wrapper)".
- **Tier 3** stores it (2/3/4 unused — zero migration; `User.tier` already an Int).
- `hasEntitlement`: tier 3 ⇒ `["devices"]` only (never the tier-5 catch-all).
- Tool gate = one shared server-side helper (e.g. `canUseDeviceTools(user)` ⇒ tier ≥ 3 or
  admin) returning **403 `xdevice_required`**; the wrapper UI mirrors it with an upgrade
  card. **The gate must be server-side** — today the tool routes have no tier check at all
  (§2), so UI-only locking would be cosmetic.

### 3.3 Payment (the flow the owner wants working)
"Same flow as the Vantra EXE": **create account → pay → unlocked**, two rails:

1. **Card/crypto checkout** — existing `billing/checkout` → `billing/submit` → admin
   approve → grant tier 3. New store product (e.g. `xdevice_30d`), price set by owner (Q1).
2. **Pay with wallet balance** — W5 `POST /api/wallet/spend` on the same product; extend
   the spend route's grant target so an xdevice purchase grants tier 3 (today W5 writes
   tier 5). Free user tops up ("add funds") → activates Premium XDevice from balance.

**Money rule (binding):** money code NEVER shares a commit with UI
(`PLAN_TASK_158_WALLET_BALANCE.md` §8, `PLAN_TASK_165` §5 rule 1). Payment work is its own
commit(s), tested separately.

## 4. Decisions (locked unless the owner overrides)

- **D1 — Menu: Option B CONFIRMED (owner, 2026-10-07): dock/menu = Devices + Settings
  only.** (Option A — full menu, tabs visible-but-disabled — is withdrawn unless the owner
  reverses it.)
- **D2 — Mechanism: a new wrapper mode, NOT `buildTarget`.** `buildTarget` implies local
  runtime, no `DATABASE_URL`, hidden wallet/logout (`shell.tsx:52,56,77`) — Devices needs
  the hosted backend (`PLAN_TASK_163`: "Devices is web-only because it needs the hosted
  Postgres + server-side device runtime"). Introduce an orthogonal flag (e.g.
  `WRAPPER_MODE=devices` env / build arg) that narrows nav + routes + copy while keeping
  the server-bound shell. **First job: find how the owner's screenshot build is produced
  (build-exe.yml / Tauri config) and add the wrapper as a variant of THAT**, not of the
  local-runtime targets.
- **D3 — Wording: no public/private vocabulary anywhere in the wrapper** (owner: "no need
  saying anything about private movement… just agent").
- **D4 — Free access is already true server-side** (view + public mint ungated today).
  Verify, do not "fix". No web-app gating changes.
- **D5 — XDevice = tier 3**, `["devices"]` entitlement only; tool gate tier ≥ 3 server-side.
  Coordinate with TASK_174 when it lands (174 must not assume 5 vs 10 is the only axis).
- **D6 — Money commits separate** (§3.3).
- **D7 — Support widget ships as-is** for every wrapper user (owner: "as it is").

### Owner answers (2026-10-07 — ALL RESOLVED, no open questions)
- **Q1 price → $500**, and **admin-adjustable at runtime "just like the rest"**: store the
  default as `$500` and surface it in the admin price store exactly like the existing
  per-product prices (schema `prisma/schema.prisma:241-253` "still admin-adjustable at
  runtime", edited under **Admin > Wallets & Prices**; the `hostingModulePriceUsd` /
  `cyberlabModulePriceUsd` AdminSetting pattern at `:442/:560` is the alternative — match
  whichever surface the xdevice product naturally lands in). **Never hardcode 500.**
- **Q2 menu → Option B confirmed** (D1).
- **Q3 branding → "SpaceWorker OS"** window name; **"Devices"** is the one dock/taskbar
  label (§3.1).
- **Panic button → removed in wrapper** (§3.1); web keeps it.

## 5. Build plan (phases, each with its own gate)

- **P0a — Grant fix (first, SMALL):** nullable-admin in `app/api/admin/wallet/grant` +
  try/catch JSON 500 + unit test (row 0c option A). Money commit. Then grant $X on a test
  user live → balance +X, ledger `admin_grant`.
- **P0b — W5 live-confirm:** exercise `POST /api/wallet/spend` once on prod (disposable
  user) → debit + ledger + terms granted. If broken → fix before continuing (owner's
  conditional).
- **P1 — Wrapper shell (UI commit):** wrapper-mode flag; nav = Devices + Settings; route
  guards; copy scrub (no public/private); dropdown = vbs/exe/mac-soon; settings split;
  support + wallet chip kept. Full web app behavior byte-identical when flag off.
- **P2 — Gating (code commit):** tier 3 + `hasEntitlement` mapping + `canUseDeviceTools`
  403 on every tool route the wrapper exposes + UI upgrade card ("Premium XDevice").
  No migration.
- **P3 — Payment (money commit):** xdevice product (**default $500, admin-adjustable**,
  §4 Q1) + checkout/submit approve → tier 3; wallet-spend grant-target for xdevice;
  success path = tools unlock live.
- **P4 — Ship:** desktop build artifact (extend build-exe.yml or its wrapper variant) +
  web deploy per playbook §3 if server code changed; owner acceptance below.

## 6. Owner acceptance script (run after P4)
1. Fresh free account in the wrapper → Devices visible; Extract etc. absent (menu B).
2. Mint VBS file + share link with a renamed file → run on VM → device enrolls.
3. Terminal/tool button → locked UI + API returns 403 `xdevice_required`.
4. Top up wallet (or pay via checkout) → activate Premium XDevice → tools unlock without
   re-login (or after refresh — state which). Offer shows **$500** default; admin changes
   the price → checkout/offer shows the new number (no redeploy).
5. Open a support ticket from the wrapper → reply works.
6. Settings shows only user sections; Support/Wallet/Sign out all present; **NO Panic
   button anywhere in the wrapper** (web still has it).
7. Branding: window "SpaceWorker OS", dock label "Devices".
8. Web app in a browser: full dock, zip/powershell methods, private tier, Panic button —
   unchanged.

## 7. Out of scope
TASK_174 Plus split · W6 EXE-from-wallet · TASK_175 desktop-only link gate · marketing
copy · macOS build (dropdown stays "coming soon") · any private-tier behavior change on
the web app · OpenFrame (frozen — `TASK_177` report only) · local-runtime EXE targets.

## 8. Checklist
- [x] P0a grant fix deployed (live grant succeeds) — **LIVE PASS 21/21** (`e2e-xdevice-grant-live-p5.ts`: 200 JSON, `adminId IS NULL`, balance credited)
- [x] P0b W5 live-confirm recorded — PASS 18/18 (2026-10-07, raw output in `TASK_181_STEPS.md` §P0b)
- [x] Q1/Q2/Q3 + panic/branding resolved by owner 2026-10-07 — $500 admin-adjustable ·
  menu B · no Panic in wrapper · "SpaceWorker OS" / dock "Devices" (§3.1, §4)
- [x] P1 wrapper shell built + full-web regression proven (flag off = unchanged) — commit `831e816`
- [x] P2 server-side 403 + tier 3 + UI lock; tests — `4ee8e24`, `tests/xdevice-tier.test.ts` + `tests/xdevice-route-gate.test.ts`
- [x] P3 payment rails both work — wallet spend live-confirmed (21/21) + checkout/submit rail covered by `tests/xdevice-payment.test.ts`; price admin-configurable (`xdevicePriceUsd`, migration applied)
- [x] Playbook gates: `tsc` 0 · ESLint 0 NEW errors (admin-panel 44 = pre-existing, stash A/B identical) · full test suites green (xdevice 38 · vantra 90 · wallet 63 · carriers 21+6 · devices 6) · leak scan clean (harness deleted from VPS)
- [x] Deployed with §4/§6 evidence (BUILD_ID `qOhtBtkIXCxhsWeEjrz1p200`, mtime 2026-10-07 21:21 +0200; server chunk greps `xdevice_required` + `grantXDevice`; client chunk `3ier_oz-u5gbm.js` greps "30d XDevice"; site 200; live route harness PASS 8/8 + 21/21)
- [ ] Owner acceptance script (§6) run and passed — **OPEN: step 35, owner's Windows box** (CI artifact exe+vbs downloaded + byte-exact verified locally; no real double-click run yet)
- [x] `SENIOR_HANDOFF.md` §6/§7 + §9 log updated; this doc checked off — 2026-10-07


