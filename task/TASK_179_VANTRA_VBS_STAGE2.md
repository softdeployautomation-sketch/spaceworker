# TASK_179 — VBS Stage 2: guide PDF in the carrier + 97× UAC retry + shareable VBS link

Owner 2026-10-07, after Stage 1 (TASK_178) passed its live VM test. This file is
the scope of record — everything Stage 2 ships is listed here BEFORE any code is
written, per the owner: *"first lets scope it in a file we can track … scope all
before you begin."*

## 0. Owner asks (verbatim, in order they arrived)

1. *"lets begin the stage 2 … before you deploy. we mint a file with the pdf,
   you can use any pdf for the test, i have some in downloads … and give me the
   file to test on the vm first to be sure it works fine so we dont break the
   current working flow"*
2. *"the second stage will be adding the 90 plus retries we have on that zip
   flow … the retries are for agent mistakes on the button, some automation to
   click those prompts fail sometimes"* (the UAC re-arm loop brief)
3. *"we need the vbs hosted as a link, so users can just share that link for
   download, and we maintain the same link we use for the public zip
   downloads"* (Stage 2 addition)
4. From Stage 1: *"the pdf is enough guide to show the vantra installation"* —
   and the `--silent` fix stays a **Stage 1** property (already shipped).

## 1. Ground truth (verified in-tree, 2026-10-07 — no guessing)

| Fact | Source |
|---|---|
| **The "90+ retries" = the zip's `.lnk` UAC re-arm loop**: `$n=97;while($n){try{Start-Process … -Verb RunAs -ErrorAction Stop;break}catch{$n-=1;Start-Sleep -Seconds 1}}` — dismissed UAC re-arms every 1 s, 97 attempts, instead of silently killing the deploy | `vantra-installer/README.md:32,137` (FIX 5 "Retry-loop bridge") |
| **Zip PDF**: `<guide>.pdf` sits in the launcher subfolder; the moment the user approves UAC the launcher opens it in the default browser (`ShellExecuteW "open"`, fallback `explorer.exe`) | `vantra-installer/README.md:28–36` |
| **Zip PDF validation**: `%PDF` magic, ≤ **20 MB** decoded, `pdfName` ≤ 64 / `*.pdf` / no path chars, `pdfDelaySec` 0–120 — spaceworker already mirrors it | `lib/vantra-link.ts:396 validateInstallerPdf` (TASK_125) |
| **The public zip link surface**: `mintInstallLink` → token (`vantraInstallLink` history row, `installerKind: "zip"|"exe"`) → `GET /link/vantra/<token>` → `resolveInstallToken` → 302; 72 h expiry; `PUBLIC_LINK_BASE_URL` host; click count; revoke; history list | `lib/vantra-link.ts:547–650, 790–830`; `app/link/vantra/[token]/route.ts` |
| **Stage 1 carrier**: `renderCarrierVbs` (hidden PS, `ShellExecute "runas"` one-shot UAC, 1023-char chunks), `ensureSilentEnroll` (`--silent`), `mintPublicVbsFile` (inline, never stored), `safeVbsFileName` | `lib/vantra-carrier.ts`, `lib/vantra-link.ts` |

## 2. Scope — what Stage 2 ships

**S1 — 97× UAC retry on the VBS (zip parity, always on).**
The elevation step becomes a re-arm loop: attempt `ShellExecute … "runas"` →
dismiss (non-zero `Err`) → `WScript.Sleep 1000` → retry, up to **97**
attempts; acceptance (`Err = 0`, process launched) breaks immediately;
exhaustion exits silently — behavioural parity with the zip bridge. Applies to
**every** VBS mint (file and link). The install command itself is untouched
(`--silent` stays as shipped in Stage 1).

**S2 — guide PDF embedded in the VBS.**
The VBS card gains the **same PDF picker** the ZIP card already has (same
`validateInstallerPdf` gates — 20 MB, `%PDF` magic, name rules). At mint, the
PDF is base64-embedded in the carrier (chunked like everything else). At run
time, the elevated PowerShell: decode → write `%TEMP%\<name>.pdf` → honour
`pdfDelaySec` (default 0) → open with the default viewer → then run the
install — so the user reads the guide while the agent installs (zip parity:
PDF opens the moment UAC is approved). Mint remains **inline, never stored**
(same posture as `public-powershell`; PDF bytes never land in a DB row — the
TASK_121/125 rule kept).

**S3 — shareable VBS link on the same public-link surface.**
A "share link" action on the VBS card mints a token exactly like the public
zip link: same `/link/vantra/<token>` URL shape and host
(`PUBLIC_LINK_BASE_URL`), same 72 h expiry, same revoke, same history list
(`vantraInstallLink` row with a new `installerKind: "vbs"`), same audit
discipline (new action `vantra_public_vbs_link_minted`; URL/token never in
audit detail). Difference at resolve: instead of a 302, `resolveInstallToken`
returns the **`.vbs` bytes** with `Content-Disposition: attachment;
filename=<requested name>` + `application/octet-stream`. The install command
is **regenerated at resolve** via `mintPublicPsCommand` (fresh per-org auth —
a link minted at 13:00 still enrolls correctly at 23:00); stored per-row is
only `{vbsFileName, pdf?, pdfName?, pdfDelaySec?}`. Private tier: **no link,
no VBS** — unchanged PowerShell-only (Stage 1 rule kept).

**S4 — delivery protocol (owner's hard gate: no deploy before the VM test).**
1. Build + unit tests + lint locally (`tsc -p .`, ESLint — no deploy, no push).
2. Mint a **test artifact on this Mac**: the owner's existing
   `~/Desktop/vantra-agent-install.ps1` as the command + a real PDF from
   `~/Downloads` → hand the `.vbs` path to the owner.
3. Owner runs it on the VM: dismiss UAC once → prompt re-arms in ~1 s; accept →
   PDF opens, install runs silently (no TacticalRMM notification), device
   enrolls.
4. **Only after that passes** → commit → push → CI deploy per
   `HOW_WE_MOVE_FAST.md`, verify per §4/§6, then owner exercises the full UI
   (file mint + share link) live.

## 3. Out of scope (Stage 3+ / untouched)

- macOS options in the dropdown (placeholder stays disabled).
- `vantra/lib/trmm.ts` root-cause `--silent` (own task — noted in TASK_178 §3).
- EXE/MSI carrier, code signing.
- **Stage 1 behaviour that must keep working unchanged**: the plain
  "Download .vbs file" path, `safeVbsFileName` typo rule, private tier,
  zip/exe/powershell methods, all Stage 1 tests (updated only where the retry
  loop legitimately changes expected bytes — kept as separate assertions).

## 4. Design decisions (defaults chosen — override before build if wrong)

- **D1** Retry = exact zip constants: 97 attempts, 1 s gap, UAC step only,
  silent exhaustion (zip parity; no popup added).
- **D2** PDF opens **before** the install command runs (closest to the zip's
  "the moment the user clicks Yes"; the install is ~30–60 s of quiet time to
  read).
- **D3** PDF in the **link**: stored in the history row's JSON payload — that
  makes row bloat possible, so **link-attached PDFs are capped at 2 MB**
  (guide PDFs are ~0.2–0.5 MB; file mints keep the full 20 MB validator).
  Flagged to owner: Q1.
- **D4** Link PDF is optional — a link minted without a PDF serves the plain
  silent carrier.
- **D5** Resolve-time command regeneration (fresh org auth) over storing the
  PS command; a failed regeneration ⇒ 5xx, never a stale-credential
  deliverable.
- **D6** The VBS link appears in the same link-history card as zip/exe links
  with a `vbs` kind chip; `resolveInstallToken` returns a discriminated union
  (`{kind:"redirect"}` | `{kind:"vbs"}`) so the zip/exe path stays
  byte-identical (regression-tested).
- **D7** Audit actions: `vantra_public_vbs_link_minted` (link) alongside the
  existing `vantra_public_vbs_minted` (file).

## 5. Open questions (defaults are live unless the owner says otherwise)

- **Q1** — link PDF cap 2 MB (D3). Bigger ⇒ needs its own storage, not a row.
- **Q2** — link multi-use until 72 h expiry (zip semantics), not single-use.
- **Q3** — should exhausting all 97 UAC attempts show a final message?
  Default: no (zip parity).

## 6. Test plan (all local before any deploy)

- **Carrier**: retry loop rendered with exact 97/1 s, breaks on first
  acceptance, exits silently at 0; PDF decode→open-before-install order;
  `pdfDelaySec` honoured; **no-PDF mint still renders the Stage-1 shape plus
  the retry loop only**; chunk budget holds with a 2 MB PDF; idempotence of
  `ensureSilentEnroll` unaffected.
- **Link**: `mintPublicVbsLink` row shape + `installerKind: "vbs"`; resolve
  serves bytes with correct filename disposition; redirect branch still
  byte-identical for zip/exe (existing tests unchanged); expiry → 410;
  revoke; 2 MB cap; 401 on route; `vantra_deploy_outdated` → 503; audit row.
- **Route/UI**: `kind: "public-vbs-link"` (implementation may pick the least
  invasive variant — `public-vbs` + `as: "link"` — recorded here when chosen).
- **Regression**: full `test:vantra`, `test:vantra-carrier`, `test:openframe`.

## 7. Checklist

- [x] 3.1 carrier: UAC 97× re-arm loop (+ tests) — 2026-10-07, `test:vantra-carrier` 18/18
- [x] 3.2 carrier: embedded PDF (decode/open/delay) (+ tests) — 2026-10-07, same run
- [x] 3.3 link lib: `mintPublicVbsLink` + resolve branch + 2 MB link cap (+ tests)
      — 2026-10-07, 9 new tests in `test:vantra` (83/83): row shape, fresh-command
      resolve, PDF-in-payload, 413 cap, guards, corrupt-payload degradation
- [x] 3.4 route: `kind: "public-vbs-link"` + vbsName + PDF gate + audit
      `vantra_public_vbs_link_minted` (+ tests) — 2026-10-07, same run
- [x] 3.5 UI: VBS-card PDF picker + mint → link display + "Copy link"
      (error-mapped 413/invalid_pdf) + history chip — 2026-10-07; stage-1
      regression: full suite 83/83
- [x] 3.6 gates: `tsc -p .` 0 · ESLint 0 · `test:vantra` 83/83 ·
      `test:vantra-carrier` 18/18 · `test:openframe` 6/6 · leak scan clean
      (no live auth/org keys in tracked files) — 2026-10-07
- [x] 3.7 **mint test file with a real `~/Downloads` PDF → hand to owner → VM
      test (S4.3) — NO DEPLOY before this passes** — 2026-10-07: minted
      `~/Desktop/vantra-agent-stage2-test.vbs` (68.7 KB, silent=applied,
      48 KB PDF, delay 2 s) via the extended CLI (`--pdf/--pdf-name/
      --pdf-delay` + `ensureSilentEnroll` now in the mint path). **VM run #1
      FAILED** ("The parameter is incorrect", PowerShell never launched — see
      stage 2.1 below); fixed, re-minted, 14/14 content checks incl. launch
      line ≤ 30 K. **VM run #2: PDF pass, retries FAIL** (ShellExecute cancel
      detection) → stage 2.2 rewrite; **VM run #3: VBS compile error line 102**
      (assigned `shell.Run` missing parens) → stage 2.2b fix; re-minted
      10:04, 21/21 checks incl. static parse-error lint. **VM run #4 PASSED —
      owner: "perfect now"** (PDF + retry loop + silent install all good).
      3.7 DONE.
- [ ] 3.8 deploy per HOW_WE_MOVE_FAST + live verify + owner UI test
      (blocked on 3.7 VM pass)

## 8. Log

- 2026-10-07 — scope written before any code (owner instruction). Ground truth
  for the "90+ retries" located: `vantra-installer/README.md` FIX 5 — 97×1 s
  UAC re-arm bridge; zip PDF open semantics and the public-link surface
  verified in `lib/vantra-link.ts`.
- 2026-10-07 — build complete (3.1–3.5) + full local gates green (3.6).
  Stage-2 unit/integration coverage: 9 tests added to
  `tests/vantra-link-installer.test.ts` (1 451 → 1 686 lines), exercising the
  real `lib/vantra-link.ts` through the harness route + the real link GET
  route; carrier suite grew to 18 (97× loop + PDF statement).
- 2026-10-07 — 3.7: pre-deploy test artifact minted for the owner's VM run:
  `~/Desktop/vantra-agent-stage2-test.vbs`, from the owner's own dashboard
  script + `~/Downloads/Agent Assignment Test Results .pdf`, via
  `scripts/mint-vantra-carrier.ts` extended with `--pdf/--pdf-name/
  --pdf-delay` and the `ensureSilentEnroll` fix (no TacticalRMM GUI — the
  stage-1 silent behavior the owner called out). **Deploy deliberately NOT run
  — gate 3.8 waits on the owner's VM test.**
- 2026-10-07 — **VM run #1 failed.** Owner's screenshot: PowerShell.exe
  dialog, *"The parameter is incorrect"* (ERROR_INVALID_PARAMETER). Root
  cause (stage 2.1): the guide's base64 was inlined into `-Command` — 66,845
  chars of `ps` (PDF = 65,644 of it) → the full launch line ≈ 66,980 chars,
  past Windows' 32,767-char CreateProcess ceiling, so ShellExecute never
  starts PowerShell; the 97× loop then re-armed the same dialog every second.
  Stage 1 worked because its command was ~1.2 K. Fix (all fail-closed):
  1. **Sidecar** — the base64 rides in `%TEMP%\sw-agent-guide.b64`, written
     by FSO text writes (not a process command line → exempt from the wall),
     chunked under the 1023-char VBS line budget like `ps`.
  2. **Marker** — the command carries only `@B64@` inside the PS literal;
     one VBS line substitutes the REAL path at run time (`Replace(ps,
     "@B64@", Replace(b64Path, "'", "''"))` — dropper TEMP, not the elevated
     profile's; quotes doubled). A literal `@B64@` in the install command
     throws `marker_collision` at mint.
  3. **Guards** — `MAX_CMDLINE_CHARS = 30_000`: renderer throws
     `command_too_long` at MINT (route → 400, UI plain-English, CLI explains);
     the sidecar is removed best-effort after open (second `try/catch`, so a
     bad PDF still never aborts the install).
  Re-minted same inputs → **14/14 checks** (incl. sidecar md5 == source PDF,
  launch line 1,398 ≤ 30,000, guide-before-install, one `--silent`). Gates:
  `tsc` 0 · ESLint 0 · carrier 20/20 · vantra 84/84 (+ new route→carrier
  1 MB regression) · openframe 6/6 · leak scan clean. **Still not deployed —
  awaiting owner VM run #2.**
- 2026-10-07 — **VM run #2:** PDF opens correctly, **but the retry loop fails**
  — owner: "user says cancel, it should retry for the times we put there."
  Root cause (stage 2.2): the loop called `ShellExecute("runas")` and tried to
  infer a dismissed UAC from `Err` — **Windows sets no `Err` on a cancel**, so
  a dismissed consent fell through silently. Fix: the install moved into a
  staged self-elevating `sw-agent-run.ps1` that reports the outcome by **exit
  code** — `0` done / `1` consent dismissed / `2` install failed — and the VBS
  loop retries **only on 1**, 97×1 s (zip FIX 5 parity); `ShellExecute`
  removed entirely. PDF flow untouched.
- 2026-10-07 — **VM run #3 failed: VBS compilation error**, *Line 102 Char 18,
  Expected end of statement* (owner screenshot). Root cause (stage 2.2b):
  line 102 read `rc = shell.Run "…" , 0, True` — **VBScript requires
  parentheses when a method call's return value is assigned** (`rc =
  shell.Run("…", 0, True)`); without them the parser dies on the opening
  quote. Introduced by the 2.2 rewrite (the old ShellExecute loop never
  captured a return value); the content verifier checked loop *semantics* but
  not this syntax class. Fix: parenthesized call + **regression guards** —
  negative assertions in 3 test files (`!includes('rc = shell.Run "')`) and
  two new verifier checks (parens rule + a static lint for the whole
  `x = obj.method "…"` parse-error class). Re-minted same inputs → **21/21
  checks**, line 102 = `rc = shell.Run("…", 0, True)`, whole-file lint CLEAN.
  Gates: `tsc` 0 · ESLint 0 · carrier 21/21 · vantra 84/84 · openframe 6/6 ·
  leak scan clean. **Re-minted `~/Desktop/vantra-agent-stage2-test.vbs`
  10:04 (70,066 B) — awaiting owner VM run #4 (retry test). Still not
  deployed.**


