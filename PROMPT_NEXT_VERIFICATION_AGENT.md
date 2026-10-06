# PROMPT — NEXT VERIFICATION AGENT (TASK_176 nested launcher — VERIFY + LIVE-CONFIRM)

TASK_175 desktop-only gate is BUILT + PUSHED (`f27fa8b`) and DEPLOYED via
run `37502808339` — live-confirm it per §1, then verify the TASK_176
nested-launcher build below. TASK_176 scope doc:
`TASK_176_NESTED_LAUNCHER_SINGLE_RENAME.md` (owner's single-rename rule
is binding). TASK_133 is the owner's — never touch it. Never git stash;
baselines via throwaway worktree. Never edit .env; never build on the VPS.

Start: spaceworker main at `d6cff6a` (TASK_175 deployed + TASK_176 scoped).

## 1. LIVE-CONFIRM TASK_175 FIRST (quick, do not redo local gates)

Local gates were green (`f27fa8b` session): tsc clean, hosting 338/338,
gate 12/12, vantra 68/68, wallet 47/47, topup 22/22, support 50/50,
idlechip 15/15, prisma validate ok, CI build ok. One ESLint error in
hosting-panel is PRE-EXISTING on HEAD (untouched effect line).

1. Deploy run `37502808339` (manual dispatch): build+deploy both
   success on SHA `f27fa8b`. VPS: BUILD_ID mtime inside the run window;
   service restart after; unauth probes 401/403-shaped.
2. Curl proof AGAINST PROD (premium mobile HTML + desktop 302 +
   free-mint drop) — report raw output.
3. Migration `20261115000000_task175_desktop_only_link_gate` applied
   (ledger +1, `desktopOnly` column present, pre-flag rows NULL).

Post-deploy oneshot failures right after a restart are the known
transient (trap 15) — re-check after the next tick before calling it red.

## 2. VERIFY TASK_176 (the nested launcher — this is the main job)

Owner rule (binding 2026-10-06): **keep all three UI fields, no UI
changes — just use the same folder name for the nested folder as well.**
`acme` → zip holds `acme/acme/Launcher.exe`. Launcher lives in the
INNER folder.

### 2a. Shape (exact — assert every line)

Mint with `innerFolder: "acme"` → unzip -l MUST show exactly:

```
Update.lnk                        (root, alone — nothing else at root)
acme/acme/Launcher.exe            (inner folder, doubled same name)
acme/acme/agent.bin               (sibling of exe — invariant kept)
acme/acme/<pdf>                   (only when attached — follows the exe)
```

Defaults: blank `innerFolder` → `launcher/launcher/Launcher.exe`
(proves the doubling, not a passthrough bug). Bad name (`../evil`,
65 chars) → dropped per side → `launcher/launcher/` (never a 400).

### 2b. THE .LNK REGRESSION CHECK (we were burned here before — do NOT skip)

The PS-bridge `Update.lnk` MUST launch the launcher at the NESTED path.
Verify at THREE levels and report each:

1. **Bridge args**: the generator's `runPwsh` call passes
   `-LauncherSubFolder "acme\acme"` (the JOINED path — backslash-joined,
   not the single folder). Source:
   `generator/src/launcher-build.ts:254-265`. A single `acme` here is
   the old bug — FAIL it.
2. **.lnk bytes**: inflate `Update.lnk` from the zip, strip NUL padding
   (UTF-16LE), and assert the command text contains ALL THREE:
   `powershell.exe` + `acme\acme\Launcher.exe` (double-backslash in the
   inflated bytes) + `RunAs`. This is the `validateLauncherBuild`
   "Update.lnk bridge shape" check
   (`generator/src/launcher-validate.ts:206-220`) — re-run it yourself
   with `-Validate -LnkPath <path> -LauncherExePath <path>` and paste
   the PASS row. Also assert NO `-Enc` / `IEX` / `EncodedCommand`
   trigram hits (same report card).
3. **Live double-click (owner hardware or VM)**: extract the zip on
   Windows, double-click `Update.lnk` → UAC prompt appears → launcher
   runs from `acme\acme\` (confirm via Task Manager path or the
   install log) → device checks in, NO TacticalRMM GUI dialog (P0
   `--silent` still intact). If no Windows box is available, say so
   explicitly — do NOT mark this verified on simulation alone.

### 2c. UI UNCHANGED (assert byte-identical minus nothing)

`components/device-list.tsx` MUST still render all THREE rename inputs:
`zipName` (:812), `linkName` (:825), `folderName` (:839) — same labels,
same placeholders, same order. `git diff` on the file must show NO
hunks touching those inputs or their state (`:131-133`). The single
`innerFolder` value (`folderName` → `innerFolder` at :908-910, :924-926,
:981-983) flows through `lib/vantra-link.ts` + `install-link/route.ts`
`parseNames` UNCHANGED — the doubling happens ONLY inside the
generator. Any new `nestedFolder` param, any hidden/removed input, any
plumbing change in Vantra (`zip-generator.ts`, `sw-installer-names.ts`)
= scope violation — FAIL it and report.

### 2d. Regression gates (re-run every one yourself)

`test:vantra` (installer), hosting suite, wallet, top-up, support,
idlechip suites, `npx tsc --noEmit`, `CI=true npm run build`, prisma
validate (expect NO new migration — TASK_176 needs none; flag any as
unexpected). ESLint on touched files with worktree baseline (prove 0 new).

## 3. DEPLOY (push only if green; deploy = gh workflow + VPS proof)

If anything red: stop, report, do NOT push. If green: push per-repo
commits (generator + vantra deploy via their own pipelines; spaceworker
push only if its code changed — expected: none), trigger deploys, wait
for build+deploy success on those SHAs (a green run with SKIPPED deploy
is not deployed). Then VPS/generator-host: fresh mint AFTER deploy →
unzip -l shows the doubled path → `.lnk` bytes carry the joined path →
VM/owner install checks in. Post-deploy oneshot failures right after a
restart are the known transient (trap 15) — re-check after the next
tick.

## 4. WRITE THE HANDOFF, commit, report

Update SENIOR_HANDOFF.md: section 6 state (TASK_176 live), section 7
queue (strike 0b, grant fix 0c next), section 9 log entry, section 12
evidence (paste: unzip -l output, `-Validate` PASS rows, .lnk inflated
command text, live install result). Commit the docs explicitly (git add
paths, -F file, git log -1 to confirm), push. Report: gate table, .lnk
proof at all three levels, UI-unchanged proof (diff), live install
proof, next task queued, unverified list.
