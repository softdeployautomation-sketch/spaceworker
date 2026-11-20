# EXE Build — Lessons Learned (read before starting any new desktop build)

This document exists because the SpaceWorker Extractor EXE (Task 27 Part A) hit
the same handful of real, sometimes-severe bugs — several of them more than
once — before shipping a genuinely working build to a customer. The plan is to
eventually ship desktop builds for Vantra and for SpaceWorker's other
BUILD_TARGET variants (mailer / combined / automation) too. **Read this before
starting any of those** so the same bugs aren't re-discovered from scratch.

Every item below was a REAL bug hit and fixed during the Extractor build, not
a hypothetical concern.

---

## 1. Security — never trust "it should be scrubbed," verify the actual artifact

- **GitHub Actions secrets do not automatically leak into the packaged
  binary** — but only if the assembly script explicitly scrubs any copied
  `.env`/`.env.local` before packaging and writes a fresh, minimal one
  containing only what the EXE genuinely needs (a license secret, a build
  target flag). Don't assume this works — verify it.
- **Next's `output: "standalone"` file-tracer can copy raw, uncompiled `.ts`
  source files** (not just compiled JS) into the standalone output. This
  really happened — 59 real source files, including the license validator,
  shipped in plaintext in an early build, readable by anyone with `7z` in
  under a minute. The compiled code is already inlined into `.next/server`
  chunks; the raw `.ts` copies are redundant. **Fix:** after the standalone
  copy step and before packaging, recursively delete every `.ts`/`.tsx` file
  from the assembled runtime tree as a defensive last line, regardless of
  whether you've diagnosed *why* the tracer copied them.
- **Add a fail-closed build guard against shipping a known dev/placeholder
  secret.** If the resolved secret still equals the hardcoded dev placeholder
  string, abort the build entirely. A human forgetting to swap a secret
  before cutting a customer build is a "when," not an "if."
- **After every build that will reach a customer, independently verify the
  actual artifact** — don't trust a report that says "scrubbed" or
  "verified." Download the real CI artifact, unpack it (`7z x` works on NSIS
  installers, no special tooling needed), and grep for: (a) real production
  secret *values* from your own `.env` (not just variable names), (b) the
  known placeholder secret string, (c) a `.ts`/`.tsx` file count of zero
  outside `node_modules`. This takes under a minute and has caught a real
  issue every single time it was skipped.

## 2. The Tauri shell itself — `build()` vs `run()`

- `tauri::Builder::build(context)` only **constructs** the `App` — it does
  NOT start the event loop. `tauri::Builder::run(context)` is what actually
  blocks and runs the app. Calling `.build(...).expect(...)` instead of
  `.run(...).expect(...)` means: the process launches, `setup()` fires (so a
  background sidecar server might even spawn), and then `main()` returns and
  the process exits almost immediately — no window is ever meaningfully
  shown. This is a **one-word bug with total-failure severity**, and it
  compiles cleanly with no warning.
- **This was not caught by any CI check or API-level test** — CI's own
  `node --version` probe and direct `curl`/API tests against the bundled
  Next.js server all passed fine, because none of them exercise the actual
  Tauri app lifecycle. It was only caught by literally launching the packaged
  EXE on a real Windows machine and watching the process exit in ~6 seconds
  with no window. **There is no substitute for actually running the packaged
  app on the target OS before calling a build "done."**

## 3. Windows NSIS resource path quirk — the `_up_` folder

- When a Tauri `bundle.resources` entry points **outside** `src-tauri/`
  (e.g. `"../exe/runtime"`, because the runtime lives at the repo root), the
  NSIS packager stages it under a literal `_up_/` folder inside the
  **installed** app directory — not flattened away, a real permanent folder
  on the end user's disk (e.g.
  `C:\Users\<user>\AppData\Local\<App>\_up_\exe\runtime\...`).
- Code that locates bundled resources at runtime must **probe multiple
  candidate paths** rather than assume one fixed layout — it varies by
  platform/packager. The working pattern used here:
  ```rust
  let candidates = [
      resource_dir.join("runtime"),
      resource_dir.join("exe").join("runtime"),
      resource_dir.join("_up_").join("runtime"),
      resource_dir.join("_up_").join("exe").join("runtime"),
  ];
  ```
  Find whichever one actually contains the expected marker file
  (`standalone/server.js` in this case) rather than hardcoding one path.

## 4. Windows Node is not a single self-contained binary

- macOS/Linux ship a monolithic `node` binary — copy the one file and it
  works. **Windows `node.exe` needs `node.dll`, ICU data files, and VC
  runtime DLLs in the same directory**, or it silently fails to launch
  (`0xC0000135`) with no useful error visible to the end user.
- **Fix:** bundle the *entire* Windows Node distribution directory, not just
  the `.exe`. Add a functional guard in the build script — literally execute
  the bundled `node --version` and fail the build if it doesn't return 0 —
  so a broken bundle is caught before the installer is ever cut, not after a
  customer reports "nothing happens."

## 5. UI layout bugs only reproduce at the REAL packaged window size

- A search-bar row using `flex md:flex-row` with **no `flex-wrap`**, plus
  several elements with fixed pixel widths, rendered fine in a normal wide
  browser tab — and still pushed the Search button completely off-screen
  and unclickable at the packaged app's actual configured window size
  (`tauri.conf.json`'s `width`/`minWidth`, 1280×860 down to 1024×700 here).
  **The app was completely unusable as shipped and nobody caught it** until
  a real customer clicked through it.
- **Headless Chrome on macOS does not reliably hydrate a Next.js 16 client
  app** — API calls return 200, JS chunks load, but `#__next` can stay empty
  with no console error. This gave false confidence during automated layout
  checks. It mounts fine in the customer's real WebView2 — the headless-env
  failure is an artifact of the test environment, not the app.
- **Lesson:** code review and API-level SSE/HTTP tests are necessary but not
  sufficient for anything involving rendered layout. Before calling desktop
  UI work done, either (a) get a real screenshot/click-through on the actual
  target OS at the actual configured window dimensions (down to the
  configured `minWidth`/`minHeight`, not just the default size), or (b) at
  minimum, replicate the exact utility classes against the real compiled CSS
  in headless Chrome and check true computed geometry/clickability
  (`elementsFromPoint`) at both the default and minimum window sizes — this
  caught the button-visibility class of bug even when full hydration didn't
  work.

## 6. CI builds from `origin/main` — uncommitted work is invisible to it

- This happened **repeatedly** (at least four separate times across this
  build): real, correct work was done and validated locally, then reported
  as complete — but never actually `git commit`ed and `git push`ed. CI always
  builds from `origin/main`, so triggering a build in that state silently
  built the **old** code, and the "fix" was never actually exercised by the
  real pipeline.
- **Before triggering any build**, run `git status --short --branch` and
  `git log origin/main..HEAD` (or equivalent) to confirm what's actually
  pushed matches what's being reported as done. Don't trust a "done" report
  on this point — verify it directly every time.

## 7. Local `next build` can fail for reasons that have nothing to do with your code

- A local macOS `next build` attempt failed on Turbopack being unable to
  resolve Google Fonts (`@vercel/turbopack-next/internal/font/google/font`)
  — a network/sandbox artifact of that specific local environment, not a
  real code defect (nothing about fonts had changed). The real CI Windows
  runner build succeeded the whole time.
- **The authoritative correctness check is the real CI build**, not a local
  build attempt in a possibly-sandboxed dev environment. Use local
  `tsc --noEmit` + `eslint` for fast iteration, but don't let a local
  `next build` failure block shipping if it's clearly environmental — and
  don't skip the real CI build either, since it's what actually produces
  the shipped artifact.

## 8. A GitHub Actions artifact is not a customer-ready download link

- A workflow-run artifact requires GitHub repo access/login to download —
  useless for handing to an external customer directly.
- The build workflow's release step defaults to `releaseDraft: true`, and
  the repo itself may be **private** — a "GitHub Release" isn't automatically
  a public link either, without deliberately deciding to make the whole repo
  (including all its source) public, which is a real decision, not a
  default to fall into.
- **What worked:** host the verified `.exe` on existing company download
  infrastructure (an existing `dl.*` subdomain/nginx static-file route)
  instead of fighting repo visibility or draft-release settings. Verify the
  SHA-256 matches across build → server → public fetch every time a new
  build replaces the one at that link.

## 9. Server-side numeric caps should be safety-bound, not arbitrarily small

- An early cap of 200 on both min/max lead counts blocked real customer
  usage almost immediately, for no real safety reason. The actual safety
  mechanism against a runaway/unreachable target should be a **wall-clock
  deadline** (already implemented) plus a large structural ceiling (a query
  count safety valve), not a small arbitrary number on the business value
  itself. When in doubt, raise the number and let the time-based bound do
  the actual safety work.

## 10. CSV export/import round trips need header vocabulary kept in sync

- The app's own CSV export wrote camelCase headers (`businessName`,
  `sourceUrl`); the shared import parser's alias-matching only recognized
  snake_case/space-separated forms and did **not** actually separator-
  normalize despite a comment claiming it did. Exporting a run and
  re-importing that exact file silently dropped real fields with no error.
- If a future EXE variant adds its own export/import pair, either reuse the
  exact same parser + alias lists already fixed here, or make sure the
  header vocab produced by export is a strict subset of what import
  recognizes — and add a round-trip test.

## 11. Deployment drift on the hosted web app is real and silent

- There is no automated CI/CD from GitHub to the production VPS — deploys
  are manual file syncs. This let the live web app fall significantly out of
  sync with `origin/main` (missing entire already-built, already-committed
  features) for an extended period, with nothing surfacing the drift until a
  routine file copy hit a stale-code type error.
- **When deploying any fix to the hosted app, don't assume the VPS tree is
  current** — check for drift first (a targeted diff of the specific files
  you're touching is a fast signal), and if drift is found, do a full sync
  of git-tracked files (`git ls-files`, rsync/copy that exact list — never a
  blanket sync that could clobber `.env`, `node_modules`, `.next`, or
  VPS-local runtime data) rather than patching file-by-file.

## 12. Small shell gotchas worth remembering

- `.env` file corruption: appending via `echo "KEY=val" >> .env` merges into
  the previous line if that file doesn't already end in a newline. Check
  (`tail -c 50 file | xxd`) before appending, or use a proper file-editing
  tool instead of raw shell redirection.
- Restarting a systemd unit while it's actively serving traffic causes a
  real, visible outage for that window — confirm nothing is mid-flight
  before restarting a production service, and prefer the narrowest-scoped
  control available (a specific worker/subsystem unit) over the main app
  unit when the goal is reclaiming resources, not shipping code.

---

## 13. (TASK_201) Multi-variant EXE = a TRIM, not a theme — a nav-set filter is NOT access control

The Mailer EXE shipped correct nav (Campaigns + Settings only) yet still leaked
the web experience in ways the nav set never governed. A `BUILD_ALLOWED_HREFS`
narrowing only hides dock/menu entries; it does not stop the user REACHING a
page by another path. The mailer build leaked in **three** independent places,
all fixed together (S10) — treat this triad as the pattern for any future
"subset build":

- **The hardcoded logo link.** `components/shell.tsx`'s "SpaceWorker OS" brand
  link was a hardcoded `<Link href="/dashboard">`. Clicking the top-left logo
  in the mailer dropped the user onto the web Overview page. Any global/"go
  home" affordance must derive its target from `buildTarget`, not a literal.
- **The page itself was still reachable.** `/dashboard` renders the wallet /
  AI / lead stats and a web-centric hero ("Welcome back to SpaceWorker OS …
  find leads, send outreach") — none of which is true for a mailer-only build,
  and its numbers are DB/embedded-backed (no `DATABASE_URL` in the EXE). Even
  with nav hidden, a direct URL, a stale bookmark, or the old logo link reached
  it. Fix: `app/dashboard/page.tsx` now `router.replace("/dashboard/campaigns")`
  and `return null` for `buildTarget === "mailer"` **before** rendering anything.
- **The landing route was hardcoded in the Rust launcher (S9).**
  `src-tauri/src/main.rs` navigated every build to `/dashboard/extract`, so the
  mailer opened on the EXTRACTOR screen with a Mailer title — a live bug a
  customer reproduced on a clean PC. Fix: `landing_route(identifier)` keyed off
  the tauri `identifier`, fail-closed to the extractor route.

**Lesson:** when a build is a genuine subset, enumerate EVERY route/entry the
excluded set can still be reached through — nav filter, global links, the OS
launcher's initial URL, and the route's own page — and close each. Missing one
is exactly how "nav is correct" ships a broken window.

## 14. (TASK_201) Verify against the SHIPPED build, not the source or the local dev server

Every S9 claim that turned out wrong this cycle ("it's old app state", "the
route must be missing") was falsified only by probing the **installed** runtime
on the target box: the compiled server chunk read `BUILD_TARGET=mailer`
correctly, the gate said Mailer, the nav set was right — and the window STILL
opened on Extract, because the defect lived in the Rust launcher, a layer that
none of the source-level checks exercise. Trust the artifact (see §6/§11) over
any "it should work" reasoning, and probe the thing the user actually runs.

## 15. (TASK_201) A marketing domain is not the same host as the validation API

The "Get a license on the website →" link now points at
`https://spaceworker.instaweb.top` (S10). It lives as its own constant
(`LICENSE_PURCHASE_URL` in `lib/exe-runtime.ts`), deliberately **separate** from
`HOSTED_APP_URL`. `HOSTED_APP_URL` is ALSO the host of `/api/exe-license/*`
(trial-ping, eligibility) and the billing routes via `lib/hosted-fetch.ts` —
repointing that to a marketing domain would silently break activation and
checkout. When a URL serves both a human-facing page and a machine API, split
the constants; never conflate "where the user buys" with "where the app calls
out to."

## 16. (TASK_201) Per-variant state must be isolated or the next build inherits it

The Devices (TASK_190) and Mailer (TASK_201) build cycles each needed the
license secret baked in per variant and warned that NEXT_PHASE / build-time
`process.env` can bleed across variants if the assembler or the CI arm doesn't
reset it. `scripts/runtime-assemble.mjs` writes `BUILD_TARGET` and scrubs `.env`
fail-closed; the CI `variant` switch must set the per-variant tauri `--config`
AND the runtime env for that arm only. For any new variant, confirm the previous
variant's build-time state cannot leak in before shipping.

---

## 17. (TASK_254) EXE local PGlite schema drift — shipped `db/schema.sql` must match `prisma/schema.prisma`

**The EXE ships `exe/runtime/standalone/db/schema.sql`, generated at CI build time by `prisma migrate diff --from-empty --to-schema-datamodel`. Prisma Client is generated from `prisma/schema.prisma`, but PGlite inside the EXE is built from `schema.sql`. If a schema change (new column, new table) lands in `schema.prisma` but `schema.sql` is not regenerated, Prisma Client will SELECT/INSERT columns that PGlite doesn't have → `column "fromNames" does not exist` → 500 errors → "Failed to load campaign" / "Failed to create campaign".**

**This is silent on fresh installs:** the EXE's local DB is created from `schema.sql`, so every table exists but is missing columns. Everything that touches those columns fails at SQL level, not code level.

**Fix:** Whenever `prisma/schema.prisma` changes for a mailer EXE feature, regenerate `exe/runtime/standalone/db/schema.sql` from it (`prisma migrate diff --from-empty --to-schema-datamodel`), AND add `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements in `lib/local-exe-db.ts` `initLocalExeDatabase()` so existing installs can upgrade their local DB without data loss. Verify both the fresh-install path (schema.sql has the columns) and the upgrade path (ALTER TABLE adds them to an older local DB).

**Verify:** on a fresh EXE install, create a campaign and hit `/api/campaigns` — if it 500s, `schema.sql` is stale.

---

## 18. (TASK_254) Null-safety for optional mailbox fields — `fromAddresses[0]` throws when null

**`app/api/internal/mail-queue-drain/route.ts` line 243 did `mailbox.fromAddresses[0] || mailbox.username`. When `fromAddresses` is `null` (user added a mailbox on the EXE without setting from addresses), this throws `TypeError: Cannot read properties of null (reading '0')`. Every queued item was caught by the item-level try/catch → marked `"failed"` → nothing was sent. The web app worked because `fromAddresses` was set when adding the mailbox there.**

**`lib/campaign-recipients.ts` line 20 already used `(r.fromAddresses ?? [])` — null-safe. `lib/deliverability.ts` line 146 already used `opts.mailbox.fromAddresses?.[0]` — null-safe. The drain route was the only place still using bare `[0]`.**

**Fix:** change `mailbox.fromAddresses[0]` → `mailbox.fromAddresses?.[0] || mailbox.username`. Add `console.error` in drain route and `runTestSend` catch blocks so SMTP failures are visible rather than opaque. When auditing any file that reads `mailbox.fromAddresses`, check every `[0]` access — not just one.

---

## 19. (TASK_254) From address is REQUIRED on the EXE — username alone is not enough

**Null-safety alone (`fromAddresses?.[0] || mailbox.username`) is NOT enough. If `fromAddresses` is empty/null AND the SMTP username isn't a valid email address (e.g. `"admin"`), there is no usable From address. The EXE sent nothing until the user added a proper `from address` in the mailbox settings.**

**On the EXE (mailer variant), users MUST set a valid from address before sending. Fix:**
- **At mailbox creation/edit (EXE-only):** require `fromAddresses` to contain at least one valid email address — block save otherwise, with a clear message ("A from address is required before you can send campaigns").
- **In the drain route:** if `fromAddresses` is empty/null AND `mailbox.username` is not a valid email, mark the item `"failed"` with a clear error ("No from address configured for this mailbox — add one in mailbox settings") instead of sending with an invalid from.
- **Web app:** same validation is recommended for consistency, though the web app had `fromAddresses` set in this case.

**Don't let users send without a from address — the SMTP server may reject it, or the recipient server may filter it as spam.**

---

## 20. (TASK_254) Don't blame tier/entitlement for EXE sending failures

**The mailer EXE is a standalone — tier is a web-app concept, license gating is separate. A tier-5 user seeing "campaigns fail to load" or "messages don't send" on the EXE is NOT a tier problem. Possible real causes: (a) stale `schema.sql` missing columns (§17), (b) null `fromAddresses[0]` deref (§18), (c) missing from address (§19), (d) SMTP host validation rejecting the host, (e) recipient server filtering after SMTP acceptance. Diagnose from the actual error (check `errorCategory`, `error` text, `console.error` output), not from the account tier.**

---

## Checklist for the next EXE build (Vantra, or a SpaceWorker mailer/combined/
automation variant)

- [ ] Runtime-assembly script scrubs `.env`, strips `.ts`/`.tsx`, and
      fail-closes on a placeholder secret (reuse/adapt the Extractor's
      `scripts/runtime-assemble.mjs` rather than rewriting from scratch).
- [ ] Tauri entry point calls `.run(...)`, not `.build(...)`.
- [ ] Resource-path lookup probes multiple candidate layouts, including the
      `_up_/` NSIS quirk if any resource path traverses outside `src-tauri/`.
- [ ] Windows build bundles the full Node dist directory and functionally
      verifies the bundled `node --version` before packaging.
- [ ] UI has been checked (real click-through or headless-computed-geometry)
      at the exact configured window size AND the configured minimum size —
      not just a wide browser tab.
- [ ] `git status`/`git log origin/main..HEAD` confirmed clean before every
      build trigger — nothing reported "done" that isn't actually pushed.
- [ ] The real CI-built artifact — not a local build — is downloaded and
      independently verified (`.ts` count, secret grep) before it's called
      customer-ready.
- [ ] A real public download link is decided deliberately (own
      infrastructure vs. a public repo/release), not defaulted into.
- [ ] Any shared parser/export logic reused across variants has been
      round-trip tested, not just unit-tested in isolation.
- [ ] If the variant is a SUBSET build (fewer pages/features than the web app),
      every route to an excluded page is closed, not just the nav filter:
      `BUILD_ALLOWED_HREFS` (dock/menu), the shell logo/"go home" link, the
      Tauri launcher's initial URL (`landing_route`), AND the excluded page's
      own fail-closed redirect for direct URLs / stale bookmarks (§13).
- [ ] Any host used for both a human page and a machine API has SEPARATE
      constants (e.g. `LICENSE_PURCHASE_URL` vs `HOSTED_APP_URL`) so repointing
      one can't break the other (§15).
- [ ] **EXE local database schema (`exe/runtime/standalone/db/schema.sql`) has been regenerated from `prisma/schema.prisma` for any schema changes — and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` exists in `lib/local-exe-db.ts` for existing installs.**
- [ ] **Every `mailbox.fromAddresses[0]` (and similar bare `[0]` access on optional arrays) has been audited and made null-safe (`?.[]` or `?? []`).**
- [ ] **From address validation: mailbox creation/edit on the EXE mailer variant requires at least one valid `fromAddresses` email — save is blocked with a clear message otherwise.**
- [ ] **Drain route: if `fromAddresses` is empty/null AND `mailbox.username` is not a valid email, items are marked `"failed"` with a clear error — no silent sends with invalid from.**
- [ ] Console error logging exists in drain route and test-send catch blocks so SMTP failures are visible, not opaque.
      not just the source or local dev server — especially anything in the Rust
      launcher that source-level checks never exercise (§14).
