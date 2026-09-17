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
