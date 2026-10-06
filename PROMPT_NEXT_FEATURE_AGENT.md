# PROMPT — NEXT FEATURE AGENT (TASK_175: desktop-only install-link gate, PREMIUM-ONLY — OWNER PRIORITY, BUILD FIRST)

## 0. Read first (binding)

- HOW_WE_MOVE_FAST.md + SENIOR_HANDOFF.md sections 4 + 5 traps.
- PROMPT_NEXT_VERIFICATION_AGENT.md section 1 — binding.
- Rules: explicit git add of paths only (TASK_133 is the owner's, never
  touch it); commit with -F file; never print secrets; never edit .env;
  never git stash.
- State: spaceworker main at 572726a (TASK_175 + TASK_174 scope commit).
  Scope doc: TASK_175_DESKTOP_ONLY_LINK_GATE.md (read it fully — it
  holds the verified WHY + SHAPE + §3 PREMIUM GATING).

## 1. THE TASK (owner-directed 2026-10-06/07, BUILD FIRST — before grant fix)

Agent-install links get opened on phones/tablets where the Windows
installer can't run. Build an OPTIONAL per-link "Desktop only" toggle:
when ON, a mobile/tablet opener sees a small white modal ("open this
on your PC") instead of the file; desktop openers pass straight
through. For the self-host agent-install flow. Scoped SMALL.

**PREMIUM-ONLY (owner 2026-10-07): the toggle is scoped to premium
links only — free users never see the option and cannot set it.**

Verdict (verified this session, NOT inferred): THE LINK, not the site.
GET /link/vantra/<token> (app/link/vantra/[token]/route.ts) is the
single choke point every opener passes through (resolveInstallToken →
302, else 410/502). The site/panel can't do it — the minter and the
opener are usually different people on different machines, so mint-time
UA tells nothing. Server UA sniffing alone is NOT enough (in-app
browsers lie, tablets spoof desktop) → server pre-check + client
confirm.

## 2. THE BUILD

Premium gate = the SAME `hasEntitlement(userId, "devices")` check the
private-tier path already uses (`lib/vantra-link.ts:179-181`
`isPrivateAllowed`). Premium tier 5 covers it; free/trial do not. No
new entitlement, no schema change — reuse the existing one.

1. `lib/vantra-link.ts`: `InstallerNames.desktopOnly?: boolean` +
   sanitize (keep ONLY when true; absent = today's behavior) — same
   pattern TASK_121 used for the three names, no schema change.
2. `app/api/assistant/vantra/install-link/route.ts` parseNames: accept
   + forward `desktopOnly` — BUT when the minter is NOT
   devices-entitled, DROP it silently (same posture as an invalid
   zipName — dropped, never a 400). A forged `{desktopOnly:true}`
   body from a free account mints a normal link. `mintInstallLink`
   persists the flag in installerNamesJson on BOTH the VantraLink row
   + the history row. Private PS path untouched (no link involved).
3. `app/link/vantra/[token]/route.ts`: after resolve, when the row's
   flag is on AND the request UA looks mobile/tablet → serve the
   interstitial HTML (white modal: installer runs on PC only +
   Continue-anyway `?desktop=1` that 302s). Desktop UA or flag off →
   today's 302 byte-identical. Expired/revoked still 410 — gate never
   masks those. Download counting unchanged. NO tier check here —
   the flag's presence on the row IS the authority (keeps the
   anonymous open path free of a user lookup).
4. Mint UI: one "Desktop only" checkbox on the public-link mint
   (components/device-list.tsx + components/vantra-connect.tsx) —
   renders ONLY when the view's `privateAllowed` is true (the SAME
   boolean that already gates the Private tab; no new fetch). Free
   users see today's mint UI byte-identical.
5. Tests: premium minter → flag persists; resolver HTML on mobile UA,
   302 on desktop UA, 302 with ?desktop=1; flag-off links 302 for
   both UAs; FREE minter sends `desktopOnly:true` → row has NO flag
   (302 both UAs); UI hides checkbox when `privateAllowed` false.

Do NOT touch: --silent line, PDF behaviour, wallet/grants, TASK_133.

## 3. VERIFY (before docs)

- npx tsc --noEmit clean; vantra-link-installer suite; wallet/topup
  suites (resolver touched — prove no regression); CI=true build.
  No migration (flag any as unexpected).
- Live proof with curl: mint a desktopOnly link AS PREMIUM, fetch
  with mobile UA (expect HTML modal, no redirect) + desktop UA
  (expect 302); mint as free with the flag (expect NO flag stored,
  302 both UAs).

## 4. DOCS + HANDOFF (spaceworker repo, one commit)

- SENIOR_HANDOFF.md: section 6 state, section 7 queue (strike 0e,
  promote grant fix 0c), section 12 log entry.
- New TASK_175_DESKTOP_ONLY_GATE_BUILD.md (flag, files, UA logic,
  premium gate, verification). The scope doc stays as-is.
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
4. Tier split TASK_174 (row 0d, LARGE) — parked until W6 lands.

## 6. Report back

1. File diffs, gate table, live curl proof (premium mobile HTML vs
   desktop 302; free mint drops flag).
2. Docs commit SHA + push proof; parked items queued with numbers.
3. Honest unverified list.
