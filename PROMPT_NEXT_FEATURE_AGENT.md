# PROMPT — NEXT FEATURE AGENT (P0: silent-install regression)

## 0. Read first (binding)

- HOW_WE_MOVE_FAST.md + SENIOR_HANDOFF.md sections 4 + 5 traps.
- PROMPT_NEXT_VERIFICATION_AGENT.md section 1 — binding.
- Rules: explicit git add of paths only (TASK_133 is the owner's, never
  touch it); commit with -F file; never print secrets; never edit .env;
  never BUILD on the VPS (edit ONE live TS file over ssh + service restart
  only — generator runs via tsx, no build step); never git stash.
- State: spaceworker main at b3e2540 (W5 spend, pushed; deploy run
  37470986552 success). The work is NOT in spaceworker: it is the generator
  service at /opt/vantra-installer on the VPS (164.68.105.96, key
  ~/.ssh/tacticalrmm_vps), plus doc updates in spaceworker.

## 1. THE BUG (owner-confirmed 2026-10-06)

Owner tested the Spaceworker zip: the TacticalRMM GUI dialog pops up during
install/enroll — a regression of Vantra FIX 4 (commit e148ff5), fixed in the
vantra-installer repo but never ported to the live generator.

Root cause (verified over ssh this session, NOT inferred):

- Reference fix appends `--silent` as the LAST argv in
  buildEnrollmentCommand() (generator/src/install-command.ts:59). It kills
  all agent-install GUI: confirmations, error popups, broker notification.
  Requires admin — holds via launcher UAC elevation / PS-bridge RunAs.
- Live file /opt/vantra-installer/generator/src/install-command.ts (VPS, NOT
  a git repo — deployed by copy) ends its argv at the features map with NO
  --silent line. grep silent hits comments only.
- Local installer-dev HAS the fix; origin/main now carries all three fix
  commits (e148ff5, ccb129a, 8fb69d8) since the repo went public. The live
  box was copied from an older tree and never re-synced.

NOT broken, do not touch: FIX 5 guide-PDF auto-open IS live (routes.ts has
the full pdf path, ~36 pdf hits). Vantra web side (zip-generator.ts,
sw-installer-names.ts) is at parity. toPowerShellInstallCommand() inherits
the fix automatically (calls buildEnrollmentCommand internally).

## 2. THE FIX (one line + restart — ssh, not a repo commit)

1. Over ssh (key ~/.ssh/tacticalrmm_vps, root@164.68.105.96): back up, then
   edit exactly ONE file:
   /opt/vantra-installer/generator/src/install-command.ts,
   buildEnrollmentCommand() return array — append `--silent`, AFTER the
   features-map line (byte-identical to local
   ~/vantra-installer/generator/src/install-command.ts:51-60).
2. Keep/update the FIX 4 comment block so the live file matches local.
3. Restart ONLY the generator: systemctl restart vantra-msi-generator
   (runs tsx src/server.ts — no build step). Assert is-active = active.
4. DO NOT touch /opt/spaceworker, /opt/vantra, any other generator file,
   or any other unit. DO NOT git on the VPS (not a repo).
5. Rollback: restore the backup + restart.

## 3. VERIFY (before touching spaceworker docs)

- grep -n silent on the live file shows the --silent argv line.
- systemctl is-active = active; journalctl clean start, no crash loop.
- Mint a REAL test zip through the Spaceworker public flow; confirm the
  embedded enrollment command ends in --silent. GUI-silence is provable
  only on a Windows VM — label SIMULATION unless owner confirms on hardware.
- Spaceworker gates (doc-only diff): npx tsc --noEmit clean; CI=true build
  exit 0. No migration (no schema touched).

## 4. DOCS + HANDOFF (spaceworker repo, one commit)

- SENIOR_HANDOFF.md: section 6 state, section 7 queue (strike this, promote
  nested-folder + grant-bug + W6), section 12 log entry.
- New TASK_172_SILENT_INSTALL_REGRESSION.md (root cause, fix, verification,
  nested-folder parked as follow-up).
- PROMPT_NEXT_VERIFICATION_AGENT.md belongs to the verifier — leave it.
- Commit docs explicitly (git add paths, -F file), push to main. No deploy
  needed (no spaceworker code changed).

## 5. PARKED (do NOT build — queue only)

1. Nested launcher folder (owner 2026-10-06): launcher ships flat
   (Update.lnk + Launcher.exe + payload + PDF in one innerFolder). Owner
   wants the launcher in a SECOND folder nested inside the first, .lnk
   targeting the right path. Needs scoping (launcher.c, lnk target,
   generator contract, Vantra parity). Park as TASK_173 candidate.
2. Grant bug (owner 2026-10-06): admin Give-a-customer-funds (50 USD,
   skiddy4real@gmail.com, founders funding) returns Grant failed. Route +
   service exist; root cause NOT isolated. Queue for triage.
3. Wallet W6 EXE-from-wallet (after the above): dual-provenance
   issueExeLicense refactor. Big task — do not start.

## 6. Report back

1. Live file diff (before/after), restart proof, --silent presence, zip mint.
2. Gate table (tsc, build, generator active, journal clean).
3. Docs commit SHA + push proof; parked items queued with numbers.
4. Honest unverified list (esp. Windows-GUI silence if no VM run).
