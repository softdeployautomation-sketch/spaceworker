# PROMPT — NEXT FEATURE AGENT (queue: short links, then mobile remote-control)

## 0. Read first (binding)

- HOW_WE_MOVE_FAST.md + SENIOR_HANDOFF.md §4 + §5 traps.
- PROMPT_NEXT_VERIFICATION_AGENT.md §1 — binding.
- Rules: `git add` explicit paths only (TASK_133 file is the owner's,
  never touch it); commit with `-F<file>`; never print secrets; never edit
  `.env`; never build on the VPS; never `git stash`; use `CI=true npm run build`.
- State: `main` @ `90e4d30` (TASK_168 Bug A `3330dad` + Bug B `90e4d30`),
  pushed + deployed (run 37427332704 green on that SHA; site 200 on /login,
  unauth probes 401/403-shaped). TASK_167 live — don't touch it.

## 1. TASK_169 (FIRST) — short links are too long

Owner: "the redirect link we have gives too long link, it should actually
give a very short link, lets make it generate shorter links and dynamic as
usual." Screenshot proof: edge URL
`https://sw-0279…5.swdocs.workers.dev/k34iuXi76JoPT_2cAvFJY4Bp` (35-char
host + 24-char token) and fallback
`https://spaceworker.instaweb.top/r/ciLSBh6Wgwb_g7562FolUwT-` (24-char token).

Verified facts (reproduce, don't assume):

- Token: `newHostingToken()` (`lib/hosting/rules.ts:331-335`) = base64url
  of 18 random bytes = 24 chars. Created in `createHostedLink`
  (`lib/hosting/links.ts:213-239`); token collision retries once, slug
  collision 409s for the user to fix.
- Serve: `resolveLink` (`lib/hosting/links.ts:495-501`) checks slug first,
  then token. Comment at `:489-490`: tokens contain `-`/`_`+uppercase so a
  slug can never equal a token — keep that invariant whatever you change.
- Display: `components/hosting-panel.tsx:1416-1479` — edge `publicUrl`
  (`https://<customHost>/<key>`) is the hero; `/r/<key>` fallback under
  "Always works". Default edge host today is the workers.dev name
  (`workerNameForUser`, `lib/hosting/workers.ts:234-236` → `sw-`+32 hex).
- Worker map keys = same token/slug (`buildWorkerMapSource`,
  `lib/hosting/workers.ts:766-785`); both resolve, `/r` is the fallback
  (§19.12.2, `lib/hosting/links-engine.ts:40-42`).

## 2. TASK_169 fix contract

1. Auto tokens get SHORT (6–8 chars, base64url alphabet kept so the
   slug/token namespaces stay disjoint). Grow the create retry loop to match
   the shorter space (bounded attempts, still 409-free for tokens — only
   user slugs 409). Existing 24-char tokens keep resolving forever.
2. Default public URL gets short too: prefer the SHORTEST live address
   (user slug if set, else short token on the shortest available host —
   `go.<zone>` / app `/r/` before `<worker>.workers.dev`). Never show a
   dead address: hero URL only when `deployStatus === "live"`.
3. Dynamic as usual, unchanged: optional custom slug, re-target/re-slug via
   PATCH (`app/api/hosting/links/[id]/route.ts`), click counts, per-user cap,
   engine picker, `/r/<key>` fallback always valid.
4. Tests: short-token length + charset; collision retry; slug-first resolve
   still holds; old 24-char tokens still resolve; worker map carries short
   keys. Hosting suite (334) stays green.
5. Gates before commit: tsc + wallet/top-up/support/hosting suites + ESLint
   touched-only (worktree baseline, 0 new) + `CI=true` build. One commit,
   explicit `git add`, `-F` file, push (push ≠ deploy, leave deploy to
   the verifier).

## 3. TASK_170 (SECOND) — mobile responsiveness, esp. device remote control

Owner: "mobile responsiveness of the whole spaceworker is very bad …
especially the device remote control, it doesnt show the mesh console at
all, it just shows a blue modal covering the screen, lets make the view the
same with the desktop and adjust to just mobile responsiveness not blocking
mobile remote view."

Verified facts (reproduce at 390px width, don't assume):

- Console: `components/device-console.tsx` — session window `:1380-1520`
  (tab strip already `overflow-x-auto`, `:1442`); remote pane
  `RemoteControl` `:2839+`, iframe at `:3494` (`h-[420px]`, fullscreen
  `h-[calc(100vh-3rem)]` at `:3190`); CONNECT-first gate `:3102-3124`
  (no auto-session — keep it: sessions cost a one-shot login token,
  `:495-508`).
- Suspects for the "blue modal": launcher palette overlay
  `fixed inset-0 z-50` (`:3523`); toolbox backdrop `fixed inset-0 z-10`
  (`:2803`); confirm dialog `max-w-lg` (`:3530`); viewport already
  `device-width + viewportFit: cover` (`app/layout.tsx:30-34`).
- Summary cards already stack via `sm:` grids (`:1693`, `:2575`) — audit
  what does NOT (fixed widths like `w-72`/`w-40` in hosting-panel
  `:1295,1303` are the same class of bug; fix the pattern wherever the
  audit finds it).

Fix contract:

1. Remote tab on mobile = same flow as desktop: Connect → MeshCentral
   iframe visible and usable. No overlay may cover the iframe on load or on
   tab switch; the iframe sizes to the mobile viewport (`dvh`, no sideways
   overflow) and remote input still reaches it (touch-action correct).
2. Responsive, not a second UI: same tabs, same tools, stacked/scrolling —
   never a blocked or forked mobile view. Desktop layout pixel-unchanged.
3. Whole-app pass on the audit hits (tables, forms, fixed-width inputs);
   keep it to layout/CSS + minimal structural change, no behaviour change.
4. Tests: whatever the fix touches gets a regression test (e.g. overlay
   never renders over an active session; iframe container classes admit
   small viewports). Existing suites green.
5. Same gates as TASK_169. Separate commit after TASK_169, explicit
   `git add`, `-F`, push. Leave deploy to the verifier.

## 4. Wallet spend path (W5) waits

Wallet W5 sits in handoff §7 row 2b — it is next AFTER these two, not now.
Do not start it.

## 5. Report back

1. TASK_169: token length chosen + collision math; default-host rule;
   before/after URL examples; migration or no-migration (prefer none —
   additive-only if a column is truly needed); gate table, real output.
2. TASK_170: root cause of the covering modal (`file:line` + trigger);
   viewport/iframe CSS before/after; audit list + what changed; desktop
   unchanged proof; gate table.
3. Honest unverified list (anything not run on device-width or live).


