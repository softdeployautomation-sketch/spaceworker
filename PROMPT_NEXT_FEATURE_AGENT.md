# PROMPT — NEXT FEATURE AGENT (TASK_173: nested launcher folder)

## 0. Read first (binding)

- HOW_WE_MOVE_FAST.md + SENIOR_HANDOFF.md sections 4 + 5 traps.
- PROMPT_NEXT_VERIFICATION_AGENT.md section 1 — binding.
- Rules: explicit git add of paths only (TASK_133 is the owner's, never
  touch it); commit with -F file; never print secrets; never edit .env;
  never BUILD on the VPS (generator runs via tsx — edit TS over ssh +
  service restart only); never git stash.
- State: spaceworker main at 7a576e4 (queue-scoping commit: P0 silent fix
  still live-unfixed unless the verifier says otherwise; W5 spend pushed,
  deploy run 37470986552 success; §7 rows 0b/0c scoped this session).
  The nested-folder work is NOT in spaceworker first: it is the generator
  service at /opt/vantra-installer on the VPS (164.68.105.96, key
  ~/.ssh/tacticalrmm_vps) + local parity repos (~/vantra-installer,
  ~/vantra) + thin forwarding in spaceworker.

## 1. THE TASK (owner-directed 2026-10-06, scoped — now BUILD it)

Owner wants the launcher in a SECOND folder nested inside the first.
Target zip layout:

  Update.lnk                        (zip root, unchanged)
  <inner>/<nested>/Launcher.exe
  <inner>/<nested>/agent.bin
  <inner>/<nested>/<guide>.pdf      (PDF follows the exe — sibling invariant kept)

and the PS-bridge Update.lnk runs
`Start-Process .\<inner>\<nested>\Launcher.exe -Verb RunAs`.

Why this shape is safe (verified this session, NOT inferred):
- The bridge already does `.\$LauncherSubFolder\$LauncherTarget`
  (New-AgentShortcut.ps1:5986) — passing the JOINED `inner\nested` relative
  path as `-LauncherSubFolder` needs NO .ps1 logic change.
- `launcher.c` reads agent.bin as a SIBLING of the exe
  (`read_external_payload`, dir-of-self) — exe + bin move together, so NO
  launcher.c change. `open_pdf` resolves from GetModuleFileName with a
  parent-folder fallback — PDF follows the exe, invariant holds.

## 2. THE BUILD

Generator (local ~/vantra-installer FIRST, then port live over ssh):
1. `generator/src/launcher-build.ts`: new optional `nestedFolder` via the
   same bare-name `clean()` as innerFolder (default e.g. `bin`); zip
   entries become `${inner}/${nested}/${launcherName|payloadName|pdfName}`;
   pass through to `validateLauncherBuild` names.
2. `generator/src/routes.ts` `names:` block: accept + trim `nestedFolder`
   (same shape as innerFolder).
3. `generator/src/launcher-validate.ts`: expect the nested entries.
4. `New-AgentShortcut.ps1`: NO logic change — call site passes the joined
   `inner\nested` value as `-LauncherSubFolder`.
5. Vantra parity: `lib/zip-generator.ts` + `lib/sw-installer-names.ts`
   accept/forward `nestedFolder` the same way.
6. Port to live /opt/vantra-installer over ssh (backup first, NOT a git
   repo) + `systemctl restart vantra-msi-generator`, assert active.

Spaceworker (thin forwarding, same session):
7. `lib/vantra-link.ts`: `InstallerNames.nestedFolder?` +
   `sanitizeInstallerNames` (same `safeInstallerName` drop rule) +
   `app/api/assistant/vantra/install-link/route.ts` `parseNames`.
8. Tests: zip entry list with/without nestedFolder; invalid nestedFolder
   dropped to default; bridge args carry the nested path.

Do NOT touch: install-command.ts --silent line, FIX 5 PDF behaviour, wallet
code, TASK_133.

## 3. VERIFY (before docs)

- Mint a REAL test zip through the Spaceworker public flow; assert entry
  list = nested layout; assert bridge args contain `.\<inner>\<nested>\`.
- VM install proves end-to-end — label SIMULATION unless owner confirms on
  hardware.
- Spaceworker gates: npx tsc --noEmit clean; vantra-link-installer tests;
  wallet/topup/support/hosting suites; CI=true build exit 0. No migration
  (no schema touched — flag any migration as unexpected).

## 4. DOCS + HANDOFF (spaceworker repo, one commit)

- SENIOR_HANDOFF.md: section 6 state, section 7 queue (strike 0b, promote
  grant fix + W6), section 12 log entry.
- New TASK_173_NESTED_LAUNCHER_FOLDER.md (layout, files, verification).
- PROMPT_NEXT_VERIFICATION_AGENT.md belongs to the verifier — leave it.
- Commit docs explicitly (git add paths, -F file), push to main. Deploy
  only if spaceworker code changed (it does — forwarding + tests).

## 5. PARKED (do NOT build — queue only)

1. Grant fix (row 0c, SMALL, root-caused §7): nullable-admin —
   `adminId: null` for the shared-passcode admin in
   `app/api/admin/wallet/grant/route.ts` + try/catch → JSON 500 +
   "grant with null adminId succeeds" test. No migration.
2. Wallet W6 EXE-from-wallet (after the above): dual-provenance
   issueExeLicense refactor. Big task — do not start.

## 6. Report back

1. File diffs (local + live), restart proof, minted-zip entry list.
2. Gate table (tsc, suites, build, generator active).
3. Docs commit SHA + push proof; parked items queued with numbers.
4. Honest unverified list (esp. VM install if no hardware run).
