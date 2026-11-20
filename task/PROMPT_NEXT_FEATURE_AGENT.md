# PROMPT — NEXT FEATURE AGENT (TASK_177: OpenFrame one-click — FEASIBILITY FIRST, dynamic-binding gate)

## 0. Read first (binding)

- HOW_WE_MOVE_FAST.md + SENIOR_HANDOFF.md sections 4 + 5 traps.
- `TASK_177_OPENFRAME_ONECLICK_FEASIBILITY.md` (read fully — the gate
  + ranked carriers + secret hygiene are binding).
- Rules: explicit git add of paths only (TASK_133 is the owner's, never
  touch it); commit with -F file; never print secrets; never edit .env;
  never git stash.
- State: spaceworker main at `f4f53b5` (TASK_176 shipped-live row +
  section 9 log). TASK_176 needs NO rebuild: installer-dev ==
  origin/installer-dev == `c7c3447`, live md5s match, service active,
  healthz ready True True True (2026-10-07).

## 1. THE TASK (owner-directed 2026-10-07, NOT the grant)

Owner tested OpenFrame RMM (free account, willing to pay). Per-device
PS one-liner, no EXE/MSI. Customer wants single-click agent
connection. Question: bind it as silent one-click EXE/MSI/VBS that can
later be code-signed; manual-script path to OUR platform until ours
is signed.

SECRET HYGIENE: live initialKey/orgId/userId/machine-id were pasted
in chat. NEVER put them in a doc, test, log, or commit. Work ONLY
with <SERVER>/<ORG>/<USER>/<KEY>/<MACHINE>. Tell the owner to ROTATE
the exposed key.

## 2. THE SPIKE (do FIRST — gate pass/fail before any build)

1. Classify values: mint two device scripts, diff. Per-device vs
   per-org vs per-user? Single-use?
2. Manual path to OUR platform: same carrier shape running OUR
   install command — yes/no + exact substitution.
3. Carrier pick (ranked): (a) VBS-to-EXE via build-exe.sh (VBS text
   per-mint dynamic, EXE shell static); (b) PS-bridge .lnk + zip;
   (c) MSI via build.sh/wixl.
4. Sign check: unsigned SmartScreen UX (click count, warning text);
   OV-vs-EV effort + lead time. Buy NOTHING.

GATE: dynamic per-customer mint proven (two renders, diff = values
only, both run right). Static bake = FAIL: stop, report, no build.

## 3. BUILD only if PASS (additive, generator-first, no migration)

- Per-mint OpenFrame params; never log/persist plaintext past job TTL.
- New template (openframe-install.vbs.template); launcher.c untouched.
- No SpaceWorker/Vantra UI in this task. No DB change.

## 4. VERIFY + DOCS

- tsc, TASK_176 entry + .lnk-byte proofs green, suites untouched.
- SENIOR_HANDOFF.md: section 6 state, section 7 queue (0f PASS/FAIL),
  section 12 log. Commit docs explicitly, push main.

## 5. PARKED (do NOT build)

1. Grant fix 0c (SMALL, root-caused) — BEHIND this per owner order.
2. W6 EXE-from-wallet. 3. Tier split 0d (LARGE).

## 6. Report back

Gate verdict PASS/FAIL with diffs + VM result; carrier pick + why;
sign UX + lead time; commit SHA; parked queue; unverified list.
