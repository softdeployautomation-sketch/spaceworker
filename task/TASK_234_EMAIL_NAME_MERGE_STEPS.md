# TASK_234 — EMAIL-DERIVED NAME MERGE + BODY TOKEN MENU — STEPS

Scope: campaign merge personalization that does NOT depend on extractor/CSV names —
the recipient's name is derived from the EMAIL ADDRESS itself at send time — plus a
visible token menu above the campaign Bodies editor so users know exactly what to type.
Coding task, TASK AGENT lane: no deploy, branches only.

## Owner decisions (verbatim, binding)

1. *"make research how we can determine users username by the encode we send. like
   ((name)). i have one sender i used then that could do such without knowing the
   emails name, just by encoding it that way, it interpretes to the recipent to use
   the users name. so lets make research and know how it can work with ours, then we
   plan, and then make users know how to add it to the body."*
2. *"i dont want it to depend on the name generated from the extractor, thats why i
   said just the emails....there is a way it works that way"*
3. *"i just want it in a way its a placeholder so it doesnt show nakedly by mistake.
   so we need to let user know the placeholder to replace with to get the actual
   result, we can just add it ontop of the body, one thin like showing the namee and
   other titles like that users can use to make the name dynamic per email"*

Reading: (a) name resolution must work from the bare email alone (no CSV column, no
lead contactName); (b) the token must NEVER leak literally into a sent email; (c) the
UI must show the available placeholders ON TOP OF the body editor as clickable tokens.

## BEFORE — session state (recorded 2026-10-20)

### spaceworker (primary)
- Branch: `agent/task-234-email-name-merge` @ `ea0f92a` (= local `main` = `origin/main`).
- Base reasoning: `git diff --stat main HEAD` from the prior branch
  (`agent/task-212-d4a-screenfix`) differed ONLY in PROMPT docs, and the seven target
  files were byte-identical between `main` and that branch (`git diff main <branch> --
  <files>` → empty). Branched straight from local `main` per §2.
- Dirty files NOT mine (carried over, never staged): dozens of untracked `TASK_*`,
  `HANDOFF_*`, `scripts/*` docs from earlier tasks. NO tracked modifications
  (`git status` shows only `??` entries).

### Clobber rule (§3.1) — shared-file diffs run BEFORE edit
Target files: `lib/render-merge.ts`, `lib/deliverability.ts`, `lib/test-merge-vars.ts`,
`app/api/internal/mail-queue-drain/route.ts`, `app/dashboard/campaigns/page.tsx`,
`app/dashboard/campaigns/[id]/page.tsx`, `tests/render-merge.test.ts`.
- Swept EVERY local branch (`git for-each-ref refs/heads`) + `origin/mailer-exe`:
  all diffs are the same old-branch-behind-main shape (branches diverged from an older
  base, e.g. `render-merge.ts | 81 +-` repeated identically across dozens of stale
  branches) — NO in-flight branch carries a different NEWER copy of these files.
- `origin/mailer-exe`: zero diff vs main on `render-merge.ts` / `deliverability.ts` /
  `render-merge.test.ts`. `sw-lab`: ref not present locally.
- Conclusion: safe to edit; no file ownership conflict.

### Test floor (OWN RUN — recorded)
- Baseline executed 2026-10-20 on `ea0f92a` BEFORE any edit:
  `npx tsx --test tests/*.test.ts` → **tests 1683 / pass 1682 / fail 0 / skipped 1**
  (the expected single DB-gated skip; log `/tmp/t234-baseline-suite.txt`).
  `npx tsc --noEmit` → **0 errors** (empty output; `/tmp/t234-baseline-tsc.txt`).
- Gates required before commit: `npx tsc --noEmit` = 0 · `npx eslint <changed>` = 0 ·
  full suite all pass · new tests for new behaviour.


## Recon findings (file-grounded)

### How the reference sender (GMass) does it — research DONE
- GMass feature "Detect a person's first name from just an email address"
  (gmass.co/blog/new-feature-detect-a-persons-first-name-from-just-an-email-address):
  parse the local part of the address → use as first name in the merge; purely a
  send-time transform, NOTHING stored per recipient, no spreadsheet column needed.
- Their merge syntax supports a default inside the token (`{auto-first|Company Name}`
  per a user comment on their personalization guide) → if detection fails, the default
  renders instead of a blank/naked token.
- Heuristics to adopt: split local part on `.` `_` `-`, strip digits, title-case the
  first usable segment, skip role addresses (`info`, `support`, `sales`, `admin`,
  `hello`, `contact`, `office`, `noreply`…), otherwise fall back to default/empty.

### Our current system (spaceworker)
- `lib/render-merge.ts` — pure `renderMerge(template, variables)`:
  - Syntax: `{{key}}` ONLY (regex line 73: `/\{\{\s*([A-Za-z0-9_\- ]+?)\s*\}\}/g`).
    `<name>` intentionally passes through (pinned by test).
  - Resolution order: exact key → normalized (case/separator-insensitive) key →
    ALIASES `{ name: [contactName, firstName, businessName] }` → `""`.
  - Unknown keys render `""` — never a raw token, never another recipient's value.
  - **GAP 1: no email-derived fallback** — `{{name}}` renders "" for a bare-email
    recipient (variables `{}`), which is exactly the owner's complaint.
  - **GAP 2: `((name))` is NOT a placeholder today** → it would be sent LITERALLY
    ("naked") — the exact failure mode the owner forbids.
- Call sites (all must pass the recipient email after the change):
  - `app/api/internal/mail-queue-drain/route.ts:218-241` — real sends; `variables` from
    `item.variables`, `item.toEmail` available (`toEmail` used at 264/276/318 ⇒ on item).
  - `lib/deliverability.ts:115-117` — test/probe sends; `toAddress` known.
  - `app/dashboard/campaigns/[id]/page.tsx:2529,2543` — per-recipient preview modal;
    `previewItem.toEmail` exists (line 22 `toEmail: string`).
  - `app/dashboard/campaigns/page.tsx:1296-1298` — create-page preview;
    `sampleRecipientVars()` (line 661) returns lead vars or `{}` — no email today.
  - `lib/test-merge-vars.ts` — sample vars for test sends when no recipient queued
    (SAMPLE_VARS lines 38-44).
- UI surfaces to change:
  - Create page Bodies block: `app/dashboard/campaigns/page.tsx:1153-1176` (hint line
    1154 currently documents `{{name}}`/`{{firstName}}`/`{{company}}`/`{{contactName}}`).
  - Subject lines block: lines 1055-1079 (tokens work in subjects too — same renderer).
  - Detail-page manual edit (Subject input / Body HTML textarea): ~lines 1632-1670 of
    `app/dashboard/campaigns/[id]/page.tsx`.
- Spintax: NO spintax/`{a|b}` engine exists in the campaign send path (grep: only
  unrelated "spinner"/"never spins" hits) → introducing `{{key|default}}` default
  syntax collides with nothing. `((…))` likewise unused in bodies today.
- Prisma: `EmailQueueItem.toEmail String` (schema line 961) — no schema change needed.

## Plan (build order) — ALL PHASES DONE (see AFTER)

- [x] P0 — own baseline runs recorded here (suite + tsc) BEFORE any edit.
- [x] P1 — `lib/render-merge.ts`:
      `renderMerge(template, variables, opts?: { email?: string })`.
      1. Token regex extended to `{{…}}` AND `((…))` (both = placeholder, never raw).
      2. Optional default: `{{name|there}}` / `((name|there))` — renders when the key
         resolves to nothing.
      3. Email-derived name fallback for name-keys (`name`, `firstname`, `first name`,
         `fullname`, …) when the variables provide none: local-part heuristics above.
         Order stays: exact → normalized → alias chain → email-derived → default → "".
         Extractor/CSV names still WIN when present (owner wants email as the source
         that doesn't *depend* on them, not as a replacement).
      4. `email` key also resolvable from opts (so `{{email}}` works bare).
- [x] P2 — pass `email` at every call site (drain, deliverability test send, both
      previews, test-merge sample).
- [x] P3 — UI: token menu row ON TOP of the Bodies editor (and subjects + detail-page
      editor): clickable chips `{{name}}` `((name))` `{{firstName}}` `{{contactName}}`
      `{{company}}` `{{email}}` `{{name|there}}` → click inserts the token at cursor;
      hint line 1154 rewritten to say the name comes from the recipient's email when
      no name column exists.
- [x] P4 — tests (`tests/render-merge.test.ts` extension): email-derived name
      (`jane.smith@x.com` → Jane; `info@` → no name → default/""), `((name))` never
      raw, default syntax, variables-win-over-email, exact-key-wins, existing pins
      (`<name>` pass-through, unknown→"", `{{}}` untouched) still green.
- [x] Gates: tsc 0 · eslint 0 on changed files · full suite. Then ONE commit on this
      branch; AFTER section + handoff record below.

## Risks / flags for handoff
- Behaviour change: bodies that LITERALLY contained `((text))` would now be treated as
  a token and render "" (unknown key). Mitigation (default unless owner says
  otherwise): only a KNOWN set of `((…))` name keys (`name`, `firstname`, `first
  name`, `fullname`, `email`) acts as a token — every other `((…))` passes through
  untouched, so existing body text is never eaten. `{{unknown}}` keeps its pinned ""
  behaviour.
- No schema/migration, no deploy by me (§1).

## AFTER (recorded 2026-10-20)

### Owner decisions honoured
- Name resolves from the **bare email** at send time (no extractor/CSV name needed).
- `((name))`/`{{name}}` **never** reach the recipient as a raw token (unknown → "" or
  the `|default`).
- Token menu ("Personalize" chip row) sits **on top of the Bodies editor** (create
  page) and the Body HTML editor (detail page); click inserts at caret.

### Implementation (files changed)
- `lib/render-merge.ts` — `((key))` alias in the single-pass scanner; `opts.email`
  arg; `nameFromEmail` (local-part heuristics: dot/hyphen/underscore/space → first
  token, `+tag`/trailing digits stripped, capitalized); role-address list (info,
  sales, hello, admin, …) derives ""; `email` key resolvable from opts.
  `name`-family keys fall back to email ONLY when no variable matched.
- `app/api/internal/mail-queue-drain/route.ts` — passes `opts.email: item.toEmail`
  to `renderMerge` (subject + body).
- `lib/deliverability.ts` — test send passes `opts.email: to`.
- `app/dashboard/campaigns/page.tsx` — sample preview vars include a sample email;
  `MergeTokenBar` above Bodies; `data-merge-field`/`data-merge-index` attrs on body/
  subject inputs; hint line rewritten. (Also: 2 pre-existing
  `react-hooks/set-state-in-effect` errors — lines 311/322 — annotated per §3.4, see
  below.)
- `app/dashboard/campaigns/[id]/page.tsx` — preview passes
  `opts.email: previewItem.toEmail`; `MergeTokenBar` above Body HTML + caret-aware
  insert handler; `data-merge-field` attrs on edit fields. (Also: 1 pre-existing
  `set-state-in-effect` error at line 368 annotated, see below.)
- `components/merge-token-bar.tsx` — NEW: chip-row component + `insertTokenAtCursor`.
- `tests/render-merge.test.ts` — 7 new tests (file: 18/18).

### Gates (verbatim)
- `npx tsc --noEmit` → `TSC_EXIT=0` (0 errors; baseline tsc was also 0).
- `npx eslint <7 changed files>` → `ESLINT_EXIT=0` (0 errors/0 warnings AFTER the 3
  annotations; see next bullet).
- Full suite `npx tsx --test tests/*.test.ts` → `# tests 1690 / # pass 1689 / # fail 0
  / # skipped 1` (the 1 skip = pre-existing mail-queue skip; baseline was
  1663/1662/0/1 — +7 tests are the new render-merge cases, all green).

### Pre-existing errors treated (§3.4 — evidence they pre-date TASK_234)
`npx eslint` on the two campaign pages flagged 3 `react-hooks/set-state-in-effect`
errors at `campaigns/page.tsx:311` (`load()`), `:322` (`setLeadCountError("")`),
`[id]/page.tsx:368` (`void load()`). Proven pre-existing: `git diff HEAD` hunks for
both files are at lines 10/610/681/1092/1182/1191/1328 and
12/1619/1656/1682/2547/2563 — none overlap those lines; the flagged code
(`setLoading(true)`/`setError("")` at the top of both `load()`s; the one-shot
`?fromSearchJob` adoption effect) is byte-identical to `main` (ea0f92a). Treated
with the repo's established pattern — targeted `eslint-disable-next-line` with an
honest justification (15+ precedents: `components/admin/platform-accounts-panel.tsx`,
`components/support-widget.tsx:242` "one-shot adoption of the query param on mount",
`app/dashboard/billing/page.tsx:88`, …). No runtime behaviour changed by the
annotations.

## HANDOFF → VERIFICATION AGENT
- Branch: `agent/task-234-email-name-merge` (1 commit ahead of main ea0f92a).
  NO push / NO deploy by me (§1) — owner/verifier merges + deploys.
- Verify live: send a campaign to a CSV whose rows have ONLY an email (no name
  column), body `Hi ((name)), quick one…` → recipient sees "Hi Jane, quick one…"
  (from jane@…), never the literal token; with a name column present the column wins;
  `info@…` renders the `|default` or nothing (never "Info").
- UI: open Create → Bodies section shows the "Personalize" chip row above the first
  body textarea; clicking `{{name}}` inserts at caret. Detail page Body HTML editor
  has the same row.
- Known limitation (deliberate, flag to owner): `nameFromEmail` uses local-part
  heuristics only — a mailbox like `initials@corp.com` derives "Initials". GMass
  documents the same limitation; a name column or `{{name|Preferred}}` is the
  mitigation.
