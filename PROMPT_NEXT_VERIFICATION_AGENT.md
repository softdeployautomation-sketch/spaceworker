# PROMPT — NEXT VERIFICATION AGENT (TASK_177 OpenFrame one-click — VERIFY THE GATE, then deploy-state)

TASK_176 is DONE-live (no rebuild): installer-dev ==
origin/installer-dev == `c7c3447`; live md5 `12e69ecf` / `3081228a`
match local; service active; healthz ready True True True
(2026-10-07). TASK_177 scope:
`TASK_177_OPENFRAME_ONECLICK_FEASIBILITY.md` (dynamic-binding gate is
binding). TASK_133 is the owner's — never touch it. Never git stash;
never edit .env; never build on the VPS.

SECRET HYGIENE: live OpenFrame key material was pasted in chat.
REJECT any doc/test/log/commit containing real initialKey, orgId,
userId, or machine-id — placeholders <SERVER>/<ORG>/<USER>/<KEY>/
<MACHINE> ONLY. Confirm the owner was told to ROTATE the key.

Start: spaceworker main at `f4f53b5`.

## 1. VERIFY THE GATE (the whole task stands or falls here)

1. Two minted renders with DIFFERENT placeholder sets exist; diff
   shows ONLY the per-customer values differ (no stray baked key).
2. Each render runs the RIGHT values on Windows (VM or owner HW):
   correct download URL + correct install args per render. Static
   bake (one key compiled in, rebuild-per-customer) = FAIL.
3. Silent-run breaks (if any) named exactly: UAC / ExecutionPolicy /
   Defender / SmartScreen — with click counts, not vibes.
4. Manual-to-OUR-platform substitution answered yes/no with the exact
   command. Sign UX stated precisely (warning text, clicks); no cert
   was purchased in-task.

## 2. REGRESSIONS (re-run yourself)

- Generator `tsc --noEmit` clean; TASK_176 zip-entry + inflated-.lnk
  proofs still green (or live re-mint showing doubled path).
- `test:vantra` + hosting/wallet/support suites (or the subset the
  feature touched + explicit untouched claim for the rest).
- No new migration (flag any as unexpected); no UI change; no
  TASK_133 diff; secrets grep clean (no real key/org/user strings).

## 3. DEPLOY-STATE (no rebuild needed — confirm, don't redo)

- installer-dev == origin/installer-dev (`c7c3447`); live md5s match;
  service active; healthz ready. If all true: NOTHING to deploy,
  say so explicitly. Push docs only.

## 4. HANDOFF + REPORT

- SENIOR_HANDOFF.md section 12: gate verdict, diffs, VM result,
  sign UX, deploy-state confirmation. Commit explicitly, push.
- Report: PASS/FAIL table, value-diff proof, run proof per render,
  regressions, deploy-state, next queued (0c grant if PASS), openly
  unverified list.
