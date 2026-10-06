# TASK_175 — Desktop-only gate for install links (SCOPED 2026-10-06, PREMIUM-ONLY per owner 2026-10-07)

Owner: agent-install links get opened on phones/tablets where the
Windows installer can't run. Want an OPTIONAL per-link toggle: when ON,
a mobile/tablet opener sees a small white modal ("open this on your
PC") instead of the file; desktop openers pass straight through.
For the self-host agent-install flow. Owner priority: BEFORE grant fix.

**PREMIUM-ONLY (owner 2026-10-07): the toggle is scoped to premium
links only — free users never see the option and cannot set it.**

## 1. WHY THE LINK (not the site) — verified 2026-10-06

- GET /link/vantra/<token> (app/link/vantra/[token]/route.ts) is the
  single choke point: resolveInstallToken() → 302 to the raw generator
  URL, else 410/502 JSON. EVERY opener passes through it — no other
  surface can gate per-link without touching shared pages.
- The site (pricing/store/devices panel) can't do it: the panel mints
  the link, but the OPENER is usually a different person on a different
  machine — mint-time UA tells nothing about open-time UA.
- Server UA sniffing alone is NOT enough (in-app browsers lie, tablets
  spoof desktop). Design = server pre-check + client confirm:
  server sees mobile UA → serve interstitial HTML (no redirect);
  page runs touch/maxTouchPoints/userAgentData.mobile check, shows the
  white modal with "Continue anyway" (desktop opener misread passes);
  desktop UA → 302 as today, zero behavior change.

## 2. SHAPE (small, additive, no migration)

- Flag lives in installerNamesJson next to zipName/innerFolder:
  `desktopOnly?: boolean` via InstallerNames + sanitize (drop when not
  true; absent = today's behavior). NO schema change — same pattern
  TASK_121 used for the three names.
- Mint UI: one checkbox "Desktop only" on the public-link mint
  (device-list panel + vantra-connect), plumbed through
  install-link/route.ts parseNames → mintInstallLink →
  installerNamesJson on BOTH VantraLink row + history row. Private PS
  path untouched (no link involved).
- Resolver: route reads flag from the SAME row resolveInstallToken
  already loads; desktopOnly + mobile UA → interstitial HTML (white
  modal: installer runs on PC only + Continue-anyway ?desktop=1 that
  302s). Desktop UA or flag off → today's 302 byte-identical.
- resolveInstallToken keeps returning the URL (download counting
  unchanged); the route decides HTML vs 302 AFTER resolving. Expired /
  revoked still 410 — gate never masks those.
- Tests: flag persists at mint; resolver HTML on mobile UA, 302 on
  desktop UA, 302 with ?desktop=1; flag-off links 302 both UAs.

## 3. PREMIUM GATING (owner 2026-10-07 — free users NEVER get this)

- Gate = the SAME `hasEntitlement(userId, "devices")` check the
  private-tier path already uses (`lib/vantra-link.ts:179-181`
  `isPrivateAllowed` → `private_not_granted` 403 shape). Premium tier
  5 covers it; free/trial do not. No new entitlement, no schema
  change — reuse the existing one.
- Server (`install-link/route.ts` POST): when the minter is NOT
  devices-entitled, DROP `desktopOnly` silently at parseNames time
  (same posture as an invalid zipName — dropped, never a 400) and
  the minted row persists WITHOUT the flag. A forged
  `{desktopOnly:true}` body from a free account mints a normal link.
- UI (device-list + vantra-connect public-link mint): the "Desktop
  only" checkbox renders ONLY when the view's `privateAllowed` is
  true (the SAME boolean that already gates the Private tab —
  `toViewWithHistory` already computes it per user, no new fetch).
  Free users see today's mint UI byte-identical.
- Resolver (`app/link/vantra/[token]/route.ts`): NO tier check at
  open time — the flag's presence on the row IS the authority (a
  premium-minter's link keeps gating even if their term later lapses;
  expiry/revocation still 410 as today). This also keeps the
  anonymous open path free of a user lookup.
- Tests (add): free minter sends `desktopOnly:true` → row has NO flag
  (302 both UAs); premium minter → flag persists; UI hides checkbox
  when `privateAllowed` false.
