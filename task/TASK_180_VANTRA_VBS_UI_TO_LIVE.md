# TASK_180 — Vantra VBS: UI (rename + user PDF) to LIVE, end-to-end

> Status: **SCOPE WRITTEN — build/audit pending owner read** · written 2026-10-07
> Build gate: HOW_WE_MOVE_FAST (§7 gates → §2/§3 deploy → §4/§6 verify).
> Supersedes TASK_179 §7 item 3.8 (deploy) — tracked here so one file owns
> the go-live.

## 0. Owner asks (verbatim, in order)

1. "perfect now." *(VM run #4 — compile fix + retry loop + PDF all pass)*
2. "now lets scope the ui for pdf vbs and also scope this current working flow
   into the live app and make it work dynamically using the rename and pdf
   from users....write the task in a file so we can track."
3. Earlier (context): "the ui pdf picker is only scoped for the zip not the
   vbs. we need it to match the working vbs i just tested" — plus the live-UI
   screenshot showing the DEPLOYED stage-1 card (File name + Download only).

## 1. Ground truth (verified in-tree 2026-10-07 — no guessing)

- **Deployed live UI = stage 1 only** (owner screenshot): VBS card = File name
  + Download .vbs. No PDF picker, no share link.
- **Local code (unpushed since `46d969b`) ALREADY BUILDS the full stage-2 UI** —
  the "picker is zip-only" impression came from looking at the live app, not
  the branch. Evidence, all in `components/device-list.tsx`:
  - separate `vbsPdf`/`vbsPdfError` state (line 144 ff.) — never crosses with
    the zip card's `pdf` (explicit comment: switching methods can't carry a
    file across)
  - `onVbsPdfChange` gate: must be a `.pdf` (MIME or extension), ≤ 20 MB,
    friendly inline errors + Clear button
  - VBS card (`method === "vbs"`, public branch): **File name** (rename,
    `vbsName`, maxLength 64, blank/invalid → `vantra-agent.vbs`), **Install
    guide (PDF, optional)** picker, **Download .vbs**, **Create share link** +
    link display + Copy link, instruction copy (silent install — the
    stage-1/2.2 behavior)
  - `vbsName` + `vbsPdf` both wired into `kind: "public-vbs"` (file mint) AND
    `kind: "public-vbs-link"` (share URL) handlers; server error codes
    (`pdf_too_large`, `invalid_pdf`, `pdf_name_without_pdf`, …) mapped to
    plain-English UI messages at both mint sites
  - dropdown gated: `installKind === "public" ? … : …` — **private branch
    stays PowerShell-only**, macOS option present but disabled
- **Carrier**: VM runs #1→#4 all resolved (32 K wall → sidecar; retry →
  exit-code loop; compile → parens). Final artifact: 21/21 checks.
- **Route/lib/migration**: `public-vbs` / `public-vbs-link` gates + caps
  (20 MB file, 2 MB link) live in local code; migration
  `prisma/migrations/20261116000000_task179_vbs_link_payload/` written.
- **Deploy mechanics**: CI `deploy.yml` line 236 runs
  `sudo -u trmm npx prisma migrate deploy` — the new migration applies
  automatically during a normal deploy.

## 2. Scope — what TASK_180 ships

- **4.1 Audit pass (no redesign)** — walk the built UI against the spec:
  card renders per §1, method-switch state hygiene (vbsPdf ↔ pdf isolation),
  both mint paths send rename+PDF, error mappings, private tier untouched.
  Findings recorded in §8; fix ONLY gaps found (small edits, tests alongside).
- **4.2 Full local gates** — `tsc -p .` 0 · ESLint 0 · `test:vantra` 84/84 ·
  `test:vantra-carrier` 21/21 · `test:openframe` 6/6 · live-token leak scan.
- **4.3 Deploy per HOW_WE_MOVE_FAST** — commit with `git commit -F` messages →
  push → CI "Build & typecheck" success → `workflow_dispatch "Build &
  Deploy"` → migration auto-applies → §4/§6 verification: service active,
  fresh `BUILD_ID`, server `.map` sourcesContent contains
  `vantra_public_vbs_link_minted` (§6 authoritative), client chunk contains
  the VBS card's "Install guide" picker text.
- **4.4 Owner live acceptance (the real test)** — from the DEPLOYED UI:
  1. dropdown → **One-click .vbs file** → type a custom file name → upload
     own PDF → **Download .vbs** → VM: file saves under the typed name,
     their PDF opens ~2 s after UAC consent, hidden install, no TacticalRMM
     popups, service Running.
  2. **Create share link** → open URL on a second machine → same behavior
     (carrier rendered fresh server-side).
  3. Private tier still shows PowerShell only; zip card unchanged.
- **4.5 Track it** — checklist + log below, TASK_179 marked done/superseded.

## 3. Out of scope

Zip/EXE pipeline changes · macOS option (stays disabled) · private tier
(unchanged) · OpenFrame workstream (done, frozen) · PDF generation (users
bring their own file) · retry count changes (97 is contract) · any carrier
format beyond .vbs (EXE = stage 3, if ever).

## 4. Design decisions (defaults — override before build if wrong)

- **D1: ship the already-built UI as-is** — audit-first, no visual redesign
  of the card the owner already screenshotted; only gap-fixes.
- **D2: caps stand** — file mint ≤ 20 MB PDF; share link ≤ 2 MB (link carrier
  is fetched per-open; big decks → use Download). UI already explains.
- **D3: rename fallback** — blank/invalid → `vantra-agent.vbs` (fail-open
  rename, fail-closed install command — the TASK_178 contract).
- **D4: deploy mechanism** — CI Build & Deploy (`deploy.yml`), NOT
  `deploy-vps.sh` `next build` on box (§3/TASK_157 forbid); the migration
  rides `prisma migrate deploy` in the same run.

## 5. Open questions

None blocking — defaults above are live.

## 6. Test plan

Local (§4.2) before push; live §4/§6 probes after deploy; owner acceptance
(4.4) = task done. Regressions to watch: zip card flow, private PS flow,
`test:openframe` (frozen workstream must stay green).

## 7. Checklist

- [x] 4.0 scope written before code (owner instruction) — 2026-10-07
- [ ] 4.1 audit pass + gap-fixes (if any)
- [ ] 4.2 gates green (tsc / eslint / 3 suites / leak scan)
- [ ] 4.3 deploy per playbook + §4/§6 verification evidence in §8
- [ ] 4.4 owner live acceptance (rename + own PDF + share link, deployed UI)
- [ ] 4.5 TASK_179 closed out (3.8 superseded → done here)

## 8. Log

- 2026-10-07 — scope written after VM run #4 passed ("perfect now").
  Key finding: **the stage-2 UI is already built in local code** — the owner
  was looking at the deployed stage-1 app. Task reduces to audit → gates →
  deploy (incl. pending migration) → live acceptance. All deployment
  prerequisites verified: CI runs `prisma migrate deploy`; local suites
  84/21/6 green at write time.

