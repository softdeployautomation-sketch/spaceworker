# TASK_189 — STORE/PRICING: drop web+module subscription cards, signup-first copy, apps sold via ONE dropdown

## STATUS (before edits — record written BEFORE first edit, 2026-10-09)
- HEAD: `ed7f1f9` (TASK_187 verifier closeout pushed; 187 CLOSED). TASK_188 (secret admin devices) **not started — untouched**.
- Working tree clean except stray `TASK_133_RMM_ENGINE_BRINGUP.md` (**NEVER commit**).
- HOUSE RULES: no stash; no `.env` edits; never batch-create+edit migration files in one call; multiline commit msg via file + `git commit -F`; UI commit separate from money.

## SPEC (owner, two messages, this task supersedes the earlier "take signup out")
1. "no need for the modules in the store, just keep it as sign up for spaceworker without a pricing. so when they sign up they can request for premium" → REMOVE the `web` subscription card AND the `module` section from `<Store />`. KEEP signup CTA (header "Get started" stays; add a signup band where the web card was). No webapp pricing anywhere on /store or /pricing.
2. "make the apps sale a dropdown. so users can select which one and checkout to payment" → exe apps become ONE `<select>` (label `Name — $price`), selected app's card (price + Buy) below → existing `CheckoutModal` → `/api/billing/checkout` → Submit Payment. (Dropdown design chosen via ask_question: one dropdown, price+Buy below.)
3. "the pricing and store shows almost the same thing.. so you do the same thing to both" → both pages render `<Store />` (app/store/page.tsx:49, app/pricing/page.tsx:51) → component edit covers both; ALSO update both pages' intro copy (they promise "priced per capability"/"modules ship" which becomes false).

## RESEARCH ANCHORS (verified before edits)
- `components/store.tsx` (448 ln): web grid L79-85, module section L87-106, exe grid L108-121, StoreCard L137-193 (`isWeb/isModule/isExe`, Subscribe branch), CheckoutModal L195+ (`needsAccount = kind==="web"||kind==="module"` L209, `unauthorized` L207+L230+L313-328, title L286, result L298, intro L330, email field L383, submit validation L254).
- `/api/store/prices` returns ALL_PRODUCTS incl. web/module/xdevice prices → **LEAVE API UNCHANGED**: `device-console` fetches it (tests/premium-request-static.test.ts:275 pins its shape/usage). Filter `kind==="exe"` client-side only.
- `/api/billing/checkout` (L48-52): web/module/xdevice session-required; **exe is session-free** → "checkout to payment" works signed-out. Route untouched.
- `lib/exe-runtime.ts` = `import "server-only"` → store.tsx (client) must NOT import it → signup band gets `signupHref/loginHref` props, pages pass `accountHref(...)` (same pattern headers already use).
- `<Select>` primitive exists: components/ui.tsx:132.
- Tests: NO test pins store.tsx / store-page / pricing-page source (grepped). `test:premium-static` pins billing/device-console + N4 naming — run it. `module-store.test.ts` pins ALL_PRODUCTS catalog (untouched).
- Old plain-`href="/signup"` anchors exist in modal today (L320) — removing unauthorized branch removes them; new band links come via props → EXE-runtime safe.

## PLAN
- [ ] S1 `components/store.tsx`: State+filter (`apps`, `selectedId`), new h2/intro, signup band (props), dropdown + single StoreCard, delete web/module sections.
- [ ] S2 `components/store.tsx`: StoreCard → exe-only (drop isWeb/isModule/Subscribe ternary, badge, price suffix).
- [ ] S3 `components/store.tsx`: CheckoutModal → drop `needsAccount`/`unauthorized` entirely (title "Buy", email always, EXE disclosure only, plain error on 401).
- [ ] S4 Pages: pass `accountHref` props + rewrite intro copy on BOTH /store and /pricing (keep headers with "Get started").
- [ ] S5 Gates: tsc=0, eslint=0 (3 files), `test:premium-static`, `module-store`, `test:xdevice`, `CI=true npm run build`.
- [ ] S6 AFTER-record (edit this file), commit `TASK_189 …` (4 files incl. this steps file) via `/tmp` + `git commit -F`, push. NEVER `TASK_133_*`.

## AFTER-RECORD (filled after edits — 2026-10-09)

### S1–S3 `components/store.tsx` — DONE
- Import `Select` from `@/components/ui`; `Store` now takes **required props** `{ signupHref, loginHref }` (client component can't import server-only `exe-runtime`; pages resolve via `accountHref`).
- New state `selectedId`; derived `exeProducts = products?.filter(kind==="exe")`, `selected = exeProducts.find(id===selectedId)`.
- h2 → **"Sign up for SpaceWorker OS"**; intro → signup + request-Premium-in-dashboard + "apps don't need an account".
- **Signup band** replaces the web card (Create account / Sign in links from props).
- **One dropdown** (`Select`): placeholder "Select an app…" + options `Name — $price`; below it either the selected app's `StoreCard` (price + Try-free + Buy) or a hint; empty-catalog fallback message.
- Web grid + module section + exe grid **deleted**.
- `StoreCard` → exe-only (dropped `isWeb/isModule/isExe`, Subscribe branch, Module badge, `/month` suffix; badge now unconditional "Desktop app"; price always `/ 6 months` + term hint).
- `CheckoutModal` → exe-only: `needsAccount` + `unauthorized` state/branches **fully removed** (title `Buy …`, email field unconditional, 401 → generic error, EXE disclosure only). Remaining `product.kind === "exe"` guards in fetch/submit left (harmless, catalog-shaped).
- **Incident (self-caught):** first page-copy edit wrote internal marker `TASK_189 note:` into customer-facing intro on BOTH pages → replaced in the next edit with real copy: *"Sign up free, then request Premium from your dashboard when you're ready — or pick a desktop app below and check out straight away."*

### S4 pages — DONE
- `app/store/page.tsx` + `app/pricing/page.tsx`: `<Store signupHref={accountHref("/signup")} loginHref={accountHref("/login")} />`; intro copy replaced on both (identical, per owner "do the same thing to both"); headers w/ "Get started" kept (signup stays — owner's revised spec).

### Deliberately untouched
- `/api/store/prices` (device-console reads its shape — test:premium-static:275 pins it; server still sells ALL_PRODUCTS).
- `/api/billing/checkout` + `/api/billing/submit` (exe session-free path unchanged; web/module/xdevice still work for in-app surfaces).
- Dashboard Premium request surfaces (SupportTicketButton etc.) — the "request premium after signup" path.
- `lib/products.ts` catalog (module-store tests pin it).

### S5 GATES — ALL GREEN (run on this exact tree)
| Gate | Result |
|---|---|
| leftover grep (needsAccount/unauthorized/isWeb/isModule/isExe) | **0 hits** |
| `npx tsc --noEmit` | **0** |
| eslint (3 touched files) | **0** |
| `test:premium-static` | **15/15** |
| `module-store.test.ts` | **11/11** |
| `test:xdevice` | **38/38** |
| `CI=true npm run build` | **exit 0** (`/store`, `/pricing` in route table) |

### Git
- Files: `components/store.tsx`, `app/store/page.tsx`, `app/pricing/page.tsx`, `TASK_189_STEPS.md`.
- Commit msg → `/tmp/commit-189-msg.txt` + `git commit -F` → push. **NEVER** `TASK_133_RMM_ENGINE_BRINGUP.md`. TASK_188 untouched.
- **DONE: `12a37f3` pushed** (`ed7f1f9..12a37f3`), 4 files, +205/−134. Tree clean except strays.

### S7 DEPLOY — record written BEFORE starting (owner said "go ahead" to deploy)
- No schema change → NO migrate needed; build+restart half only.
- Method: files-from list (3 code files) → `scripts/deploy-vps.sh <list>` (rsync + chown + build + restart + verify, per §WHY header — never hand-rsync root files).
- After: verify BUILD_ID bump, `/store`+`/pricing` 200, built chunk contains new strings (`Choose an app`, `Select an app`) and NOT old ones (`Subscribe to the full web app`, `Or pick just what you need`), append AFTER-RECORD.

#### S7 AFTER-RECORD — DEPLOYED ✅ (2026-10-09 ~06:17 UTC)
- Deploy: `bash scripts/deploy-vps.sh /tmp/deploy-189-files.txt` → log `/tmp/deploy189.log`.
- Flow observed: preflight ✓ (env snapshot `spaceworker.env.bak-20261009051411`, `.env`/`.next`/`node_modules`/`maintenance.html` all survived) → rsync **4 files** (additive, no `--prune`) → `chown -R trmm` → `prisma generate` → maintenance ON → `.next.prev` rollback copy → **build exit 0** → restart + verify → maintenance OFF → `-- done`.
- **BUILD_ID `F5n788UVXZqaX0b5cFb-j` → `1KWwOhU-lrarvxiQpQ01W`**; `systemctl is-active` = **active**; `localhost:3500/store` = **200**.
- Public: **https://spaceworker.top/store → 200**, **https://spaceworker.top/pricing → 200**.
- Chunk evidence (`.next/static/chunks/19kv91meso364.js`): **NEW present** — `Choose an app`, `Select an app`, `New to SpaceWorker? Start free`, `Sign up for SpaceWorker OS`, `request Premium from your dashboard`. **OLD absent** — `Subscribe to the full web app` (0 hits), `Or pick just what you need` (0 hits).
- Journal: `✓ Ready in 357ms`, `[env-health] OK`, no errors.
- Steps file re-committed after this record (this file was in the deploy list — the server copy predates this append; harmless, docs only).