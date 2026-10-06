# PROMPT — NEXT FEATURE AGENT (TASK_175: desktop-only install-link gate — OWNER PRIORITY, BUILD FIRST)

## 0. Read first (binding)

- HOW_WE_MOVE_FAST.md + SENIOR_HANDOFF.md sections 4 + 5 traps.
- PROMPT_NEXT_VERIFICATION_AGENT.md section 1 — binding.
- Rules: explicit git add of paths only (TASK_133 is the owner's, never
  touch it); commit with -F file; never print secrets; never edit .env;
  never git stash.
- State: spaceworker main at 498d2e7 (TASK_172 verify docs commit).
  Scope doc: TASK_175_DESKTOP_ONLY_LINK_GATE.md (read it fully — it
  holds the verified WHY + SHAPE).

## 1. THE TASK (owner-directed 2026-10-06, BUILD FIRST — before grant fix)

Agent-install links get opened on phones/tablets where the Windows
installer can't run. Build an OPTIONAL per-link "Desktop only" toggle:
when ON, a mobile/tablet opener sees a small white modal ("open this
on your PC") instead of the file; desktop openers pass straight
through. For the self-host agent-install flow. Scoped SMALL.

Verdict (verified this session, NOT inferred): THE LINK, not the site.
GET /link/vantra/<token> (app/link/vantra/[token]/route.ts) is the
single choke point every opener passes through (resolveInstallToken →
302, else 410/502). The site/panel can't do it — the minter and the
opener are usually different people on different machines, so mint-time
UA tells nothing. Server UA sniffing alone is NOT enough (in-app
browsers lie, tablets spoof desktop) → server pre-check + client
confirm.

## 2. THE BUILD

1. `lib/vantra-link.ts`: `InstallerNames.desktopOnly?: boolean` +
   sanitize (keep ONLY when true; absent = today's behavior) — same
   pattern TASK_121 used for the three names, no schema change.
2. `app/api/assistant/vantra/install-link/route.ts` parseNames: accept
   + forward `desktopOnly`; `mintInstallLink` persists it in
   installerNamesJson on BOTH the VantraLink row + the history row.
   Private PS path untouched (no link involved).
3. `app/link/vantra/[token]/route.ts`: after resolve, when the row's
   flag is on AND the request UA looks mobile/tablet → serve the
   interstitial HTML (white modal: installer runs on PC only +
   Continue-anyway `?desktop=1` that 302s). Desktop UA or flag off →
   today's 302 byte-identical. Expired/revoked still 410 — gate never
   masks those. Download counting unchanged.
4. Mint UI: one "Desktop only" checkbox on the public-link mint
   (components/device-list.tsx + components/vantra-connect.tsx).
5. Tests: flag persists at mint; resolver HTML on mobile UA, 302 on
   desktop UA, 302 with ?desktop=1; flag-off links 302 for both UAs.

Do NOT touch: --silent line, PDF behaviour, wallet/grants, TASK_133.

## 3. VERIFY (before docs)

- npx tsc --noEmit clean; vantra-link-installer suite; wallet/topup
  suites (resolver touched — prove no regression); CI=true build.
  No migration (flag any as unexpected).
- Live proof with curl: mint a desktopOnly link, fetch with mobile UA
  (expect HTML modal, no redirect) + desktop UA (expect 302).

## 4. DOCS + HANDOFF (spaceworker repo, one commit)

- SENIOR_HANDOFF.md: section 6 state, section 7 queue (strike 0e,
  promote grant fix 0c), section 12 log entry.
- New TASK_175_DESKTOP_ONLY_GATE_BUILD.md (flag, files, UA logic,
  verification). The scope doc stays as-is.
- PROMPT_NEXT_VERIFICATION_AGENT.md belongs to the verifier — leave it.
- Commit docs + code explicitly (git add paths, -F file), push main.
  Deploy only if spaceworker code changed (it does — route + UI).

## 5. PARKED (do NOT build — queue only)

1. Grant fix (row 0c, SMALL, root-caused §7): nullable-admin —
   `adminId: null` for the shared-passcode admin in
   `app/api/admin/wallet/grant/route.ts` + try/catch → JSON 500 +
   "grant with null adminId succeeds" test. No migration.
2. Nested folder TASK_173 (row 0b, MEDIUM) — after grant fix.
3. Wallet W6 EXE-from-wallet (after the above). Big — do not start.

## 6. Report back

1. File diffs, gate table, live curl proof (mobile HTML vs desktop 302).
2. Docs commit SHA + push proof; parked items queued with numbers.
3. Honest unverified list.
